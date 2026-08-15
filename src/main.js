import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import GUI from 'lil-gui';
import Stats from 'stats-gl';
import { texture, vec4, materialReference } from 'three/tsl';
import { installSpeedballGI, excludeFromGI } from 'speedball-gi';
import { applyGiSettings, addGiPanel } from './gi_settings.js';
import { addPostPipeline } from './post_settings.js';
import { createProbeHelpers } from './probe_helpers.js';

const statusEl = document.getElementById('status');
const setStatus = (msg, err = false) => { statusEl.textContent = msg; statusEl.classList.toggle('err', err); statusEl.classList.remove('hide'); };
const hideStatus = () => statusEl.classList.add('hide');
window.addEventListener('error', (e) => setStatus('Error:\n' + (e.error?.stack || e.message), true));
window.addEventListener('unhandledrejection', (e) => setStatus('Error:\n' + (e.reason?.stack || e.reason), true));

// ── Renderer ────────────────────────────────────────────────────────────────
const canvas = document.getElementById('c');
const nativeDpr = window.devicePixelRatio || 1;
const defaultDpr = Math.min(nativeDpr, 1.5);
// TRAA jitters the camera and forbids MSAA (see TRAANode). Canvas MSAA stays off.
const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
renderer.setPixelRatio(defaultDpr);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
await renderer.init();
if (renderer.backend?.isWebGPUBackend !== true) {
  setStatus('WebGPU not available.\nThis demo needs a WebGPU-capable browser\n(Chrome/Edge 121+, or Firefox Nightly).', true);
  throw new Error('WebGPU unavailable');
}

const stats = new Stats({ trackGPU: false, trackCPT: false });
await stats.init(renderer);
stats.dom.classList.add('stats-gl');
document.body.appendChild(stats.dom);

// SPEEDBALL GI is installed in one call further down (installSpeedballGI), which
// wires the lights factory, the material-dirty pass, and idle-gated solving.

// ── Scene & camera ────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.05, 4000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

// ── Sky (Preetham, WebGPU) + sun ──────────────────────────────────────────────
const sky = new SkyMesh();
sky.scale.setScalar(1500); // within the camera far plane (no z-precision hit)
excludeFromGI(sky); // keep the sky OUT of the GI BVH / auto-fit
scene.add(sky);

const sun = new THREE.DirectionalLight(0xffffff, 3.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.00001;
sun.shadow.normalBias = 0.08;
scene.add(sun);
scene.add(sun.target);

// Tiny pre-convergence safety fill; SPEEDBALL probes carry the real sky ambient.
const hemi = new THREE.HemisphereLight(0x9fc6ff, 0x4a4036, 0.05);
scene.add(hemi);

renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

// ── Parameters & controls ─────────────────────────────────────────────────────
const params = {
  azimuth: 119, elevation: 62.5, turbidity: 3, rayleigh: 0.6,
  sunIntensity: 20, exposure: 1, toneMapping: THREE.ACESFilmicToneMapping,
  giEnabled: true, giIntensity: 20, giDivisions: 16, giCascades: 1, giContinuous: true, showProbes: false,
  // quality knobs (defaults mirror gi_probes.js). smoothness is pinned to 1 (no slider).
  giRays: 64, giHysteresis: 0.6, giHysteresisNormalize: true, giNormalBias: 1.75,
  giRadianceClamp: 8, giDepthSharpness: 0, giLeak: 0.8, giSolid: 0, giSky: 2, giNormalDetail: 1, giReflectionIntensity: 1,
  giChangeThreshold: 2.5, giSnapAmount: 0.30, giFireflyClamp: 6.0, // adaptive temporal blend
  showTextures: true,
  dpr: defaultDpr, fps: 0,
  bloomEnabled: true, bloomThreshold: 1, bloomStrength: 0.35, bloomRadius: 0.4,
  bloomSmoothWidth: 0.01, bloomResolution: 0.5,
  traaEnabled: true, traaDepthThreshold: 0.0005, traaEdgeDepthDiff: 0.001,
  traaMaxVelocityLength: 128, traaSubpixelCorrection: true,
  gtaoEnabled: true, gtaoRadius: 0.4, gtaoThickness: 1, gtaoScale: 1,
  gtaoSamples: 16, gtaoDistanceExponent: 1, gtaoDistanceFallOff: 1,
  gtaoResolution: 0.5, gtaoTemporal: true,
  // Start from the Sponza atrium center, looking along the long corridor.
  camX: 5, camY: 4.5833, camZ: -0.3095,
  targetX: -8.4842, targetY: 4.5, targetZ: -0.3095,
};
// Hosted Sponza always starts from these canonical values. Do not restore or persist
// GUI tweaks here; a public demo should recover to the intended look on every reload.

function applyCamera() {
  camera.position.set(params.camX, params.camY, params.camZ);
  controls.target.set(params.targetX, params.targetY, params.targetZ);
}
applyCamera();
let metalBall = null;
let metalBallBaseY = 0;
window.camera = camera;
window.controls = controls;
window.dumpCamera = () => ({
  camX: +camera.position.x.toFixed(4),
  camY: +camera.position.y.toFixed(4),
  camZ: +camera.position.z.toFixed(4),
  targetX: +controls.target.x.toFixed(4),
  targetY: +controls.target.y.toFixed(4),
  targetZ: +controls.target.z.toFixed(4),
});

const sunVec = new THREE.Vector3();
let gi = null;
const _giSkyZenith = new THREE.Color();
const _giSkyHorizon = new THREE.Color();
const _giSkyGround = new THREE.Color();

function updateGiSky() {
  if (!gi?.setSky) return;
  // Compute-safe sky injection: approximate the sun-free SkyMesh dome as low-frequency
  // SH-9 on the CPU, then the probe kernel reads only 9 vec3 uniforms. No texture
  // sampling, no derivatives, no probe memory. The directional sun remains direct-only.
  const elev = THREE.MathUtils.clamp(params.elevation, 0, 88);
  const sunUp = THREE.MathUtils.clamp(Math.sin(THREE.MathUtils.degToRad(elev)), 0, 1);
  const daylight = Math.sqrt(sunUp);
  const ray = THREE.MathUtils.clamp(params.rayleigh / 8, 0, 1);
  const turb = THREE.MathUtils.clamp(params.turbidity / 20, 0, 1);
  const haze = THREE.MathUtils.clamp((1 - daylight) * 0.65 + turb * 0.35, 0, 1);
  _giSkyZenith.setRGB(0.10 + 0.12 * ray, 0.20 + 0.20 * ray, 0.42 + 0.34 * ray).multiplyScalar(0.18 + 0.62 * daylight);
  _giSkyHorizon.setRGB(0.34 + 0.34 * haze, 0.39 + 0.18 * daylight, 0.48 + 0.24 * daylight).multiplyScalar(0.16 + 0.50 * daylight);
  _giSkyGround.setRGB(0.10, 0.085, 0.065).multiplyScalar(0.06 + 0.16 * daylight);
  gi.setSky({ zenith: _giSkyZenith, horizon: _giSkyHorizon, ground: _giSkyGround });
}

function updateSun() {
  const phi = THREE.MathUtils.degToRad(90 - params.elevation); // 0 = zenith
  const theta = THREE.MathUtils.degToRad(params.azimuth);
  sunVec.setFromSphericalCoords(1, phi, theta);
  sky.sunPosition.value.copy(sunVec);
  sky.turbidity.value = params.turbidity;
  sky.rayleigh.value = params.rayleigh;
  // place the directional light far along the sun vector, aimed at the scene
  sun.position.copy(sunVec).multiplyScalar(60);
  sun.target.position.set(0, 0, 0);
  sun.intensity = params.sunIntensity;
  // warm the sun as it nears the horizon
  const warm = THREE.MathUtils.clamp(params.elevation / 18, 0, 1);
  sun.color.setRGB(1.0, 0.6 + 0.4 * warm, 0.35 + 0.65 * warm);
  refreshSunConsumers();
  updateGiSky();
  markGiInteraction();
}

let lastInteractionMs = 0;
let guiInteractionActive = false;
let guiRestUntilMs = 0;
let sunGiDirty = false;
const GUI_REST_MS = 450;
function markInteraction() { lastInteractionMs = performance.now(); }
function markGiInteraction() { markInteraction(); gi?.markInteraction?.(); }
function markGuiInteraction() {
  const now = performance.now();
  lastInteractionMs = now;
  guiRestUntilMs = now + GUI_REST_MS;
}
function guiIsInteracting() {
  return guiInteractionActive || performance.now() < guiRestUntilMs;
}
function flushSunGiRefresh() {
  if (gi?.forceLightingRefresh) {
    gi.forceLightingRefresh();
    sunGiDirty = false;
  } else {
    sunGiDirty = true;
  }
}
function refreshSunConsumers() {
  sun.updateMatrixWorld(true);
  sun.target.updateMatrixWorld(true);
  sun.shadow.needsUpdate = true;
  flushSunGiRefresh();
}
controls.addEventListener('change', markInteraction);
function applyDpr(dpr = params.dpr) {
  renderer.setPixelRatio(dpr);
  markInteraction();
}
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  markInteraction();
});

const gui = new GUI();
function installGuiIdleGate(gui) {
  const el = gui?.domElement;
  if (!el) return;
  const begin = () => { guiInteractionActive = true; markGuiInteraction(); };
  const touch = () => { markGuiInteraction(); };
  const end = () => { if (!guiInteractionActive) return; guiInteractionActive = false; markGuiInteraction(); };
  for (const type of ['pointerdown', 'mousedown', 'touchstart']) el.addEventListener(type, begin, true);
  for (const type of ['pointermove', 'mousemove', 'touchmove', 'wheel', 'input', 'change', 'keydown']) el.addEventListener(type, touch, true);
  for (const type of ['pointerup', 'mouseup', 'touchend', 'touchcancel', 'blur']) window.addEventListener(type, end, true);
}
installGuiIdleGate(gui);
const compactControls = window.matchMedia('(max-width: 700px), (max-height: 560px)');
const fSky = gui.addFolder('Sky / Sun');
fSky.add(params, 'azimuth', 0, 360, 1).name('azimuth°').onChange(updateSun);
fSky.add(params, 'elevation', -3, 88, 0.5).name('elevation°').onChange(updateSun);
fSky.add(params, 'turbidity', 0, 20, 0.1).onChange(updateSun);
fSky.add(params, 'rayleigh', 0, 8, 0.1).onChange(updateSun);
fSky.add(params, 'sunIntensity').min(0).step(0.05).name('sun intensity').onChange(updateSun); // uncapped
// GI / Post / Display folders are added after those systems are installed.

updateSun();

// The post-rebuild material-recompile pass (the "GI silently missing" footgun) is now
// handled inside installSpeedballGI — no per-app boilerplate needed.

function prepareSponzaMaterialForGi(material) {
  if (!material || material.userData?.powerlightGiPrepared) return;
  material.userData = material.userData || {};
  material.userData.powerlightGiPrepared = true;

  // This Sponza glTF imports with scalar metalness = 1 on stone/fabric surfaces.
  // SPEEDBALL GI intentionally kills diffuse bounce for metals, so normalize the demo
  // asset to dielectric before the spectral scene is packed.
  if (Number.isFinite(material.metalness) && material.metalness > 0.5) {
    material.metalness = 0;
    material.needsUpdate = true;
  }
  if (Number.isFinite(material.roughness) && material.roughness < 0.85) {
    material.roughness = 0.85;
    material.needsUpdate = true;
  }
}

const TEXTURE_KEYS = [
  'map', 'normalMap', 'roughnessMap', 'metalnessMap',
  'aoMap', 'emissiveMap', 'bumpMap', 'displacementMap', 'lightMap',
];
let texturedRoot = null;

function captureTextureDisplay(material) {
  if (material.userData.textureDisplay) return material.userData.textureDisplay;
  const maps = {};
  for (const key of TEXTURE_KEYS) maps[key] = material[key] ?? null;
  const saved = { maps, colorNode: material.colorNode ?? null };
  material.userData.textureDisplay = saved;
  return saved;
}

function applyTextureDisplay(enabled = params.showTextures, root = texturedRoot) {
  if (!root) return;
  const seen = new WeakSet();
  root.traverse((object) => {
    const list = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
    for (const material of list) {
      if (!material || seen.has(material)) continue;
      seen.add(material);
      const saved = captureTextureDisplay(material);
      if (enabled) {
        for (const key of TEXTURE_KEYS) material[key] = saved.maps[key];
        material.colorNode = saved.colorNode;
      } else {
        const albedo = saved.maps.map;
        const color = materialReference('color', 'color', material);
        material.colorNode = albedo ? vec4(color, texture(albedo).a) : color;
        for (const key of TEXTURE_KEYS) material[key] = null;
      }
      material.needsUpdate = true;
    }
  });
  markInteraction();
}

// ── SPEEDBALL GI — install at SETUP, before the first render ────────────────────
// The lights factory MUST be in place before any lit material compiles. Installing
// it after the render loop has started leaves a cached non-GI lights node, and GI
// never folds in (even a later recompile can't swap it). The probe field auto-fits
// and builds once Sponza is in the scene (idle-gated); requestRebuild() nudges it.
gi = installSpeedballGI({
  renderer, scene, camera,
  enabled: params.giEnabled,
  intensity: params.giIntensity,
  divisions: params.giDivisions,
  hysteresis: 0.95,
  roughReflections: true,
  reflectionIntensity: params.giReflectionIntensity,
  // This demo has a procedural SkyMesh but no PMREM environment. Let probe miss
  // rays provide its explicit distant-specular layer; SSR can still composite later.
  reflectionSkyFallback: true,
});
if (!gi.isSupported()) setStatus('SPEEDBALL GI needs WebGPU storage features.', true);
// Push the canonical settings so the GUI and the GI uniforms agree on first paint.
// Smoothness/denoise stay pinned (no slider).
gi.setSmoothness(1); // pinned (no slider)
gi.setFilterStrength(1); // denoise pinned on (no slider): redundant at these defaults, but harmless
applyGiSettings(gi, params);
updateGiSky();
refreshSunConsumers();
const updateProbeHelpers = createProbeHelpers(scene, gi, params);
// The GI panel is shared helper code, but Sponza itself is intentionally not persisted:
// visitors can experiment, then reload back to the release tuning.
addGiPanel(gui, gi, params, { onInteract: markGiInteraction, onStructure: () => updateProbeHelpers() });

const { renderPipeline, aoPass, traaPass } = addPostPipeline(gui, renderer, scene, camera, params);

const fDisplay = gui.addFolder('Display');
fDisplay.add(params, 'toneMapping', {
  None: THREE.NoToneMapping,
  Linear: THREE.LinearToneMapping,
  Reinhard: THREE.ReinhardToneMapping,
  Cineon: THREE.CineonToneMapping,
  'ACES Filmic': THREE.ACESFilmicToneMapping,
  AgX: THREE.AgXToneMapping,
  Neutral: THREE.NeutralToneMapping,
}).name('tone mapping').onChange((v) => { renderer.toneMapping = +v; });
fDisplay.add(params, 'exposure').min(0).step(0.01).name('exposure').onChange((v) => { renderer.toneMappingExposure = v; }); // uncapped
fDisplay.add(params, 'showTextures').name('show textures').onChange((v) => applyTextureDisplay(v));
fDisplay.add(params, 'dpr', 0.25, Math.max(2, nativeDpr), 0.05).name('dpr').onChange(applyDpr);
fDisplay.add(params, 'fps', { unlimited: 0, '30': 30, '60': 60, '90': 90, '120': 120, '144': 144 }).name('fps');

window.gi = gi; // console handle for poking
window.gui = gui;
window.gtao = aoPass;
window.traa = traaPass;
window.renderPipeline = renderPipeline;
window.scene = scene; window.renderer = renderer; window.markGiMaterialsDirty = gi.markMaterialsDirty; // diagnostics
if (compactControls.matches) gui.close();

// ── Load Sponza ────────────────────────────────────────────────────────────────
const sponzaUrl = `${import.meta.env.BASE_URL}Sponza/glTF/Sponza.gltf`;
setStatus('loading Sponza…');
new GLTFLoader().load(sponzaUrl, (gltf) => {
  const sponza = gltf.scene;
  sponza.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    if (Array.isArray(o.material)) o.material.forEach(prepareSponzaMaterialForGi);
    else prepareSponzaMaterialForGi(o.material);
  });
  scene.add(sponza);
  texturedRoot = sponza;
  if (!params.showTextures) applyTextureDisplay(false);

  // frame the camera to the model and size the shadow camera to its bounds
  const box = new THREE.Box3().setFromObject(sponza);
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5;
  applyCamera();

  // A receiver-only pure metal target makes local reflection fidelity inspectable
  // without letting the diagnostic sphere contaminate its own probe capture.
  metalBall = new THREE.Mesh(
    new THREE.SphereGeometry(0.4, 48, 32),
    new THREE.MeshStandardMaterial({ color: 0xc6d0d8, metalness: 1, roughness: 0 }),
  );
  metalBall.name = 'Rough Reflection Metal Ball';
  const ballDirection = controls.target.clone().sub(camera.position).normalize();
  metalBall.position.copy(camera.position)
    .addScaledVector(ballDirection, 2.2)
    .add(new THREE.Vector3(-5, -0.3, 0));
  metalBallBaseY = metalBall.position.y;
  metalBall.castShadow = true;
  metalBall.receiveShadow = true;
  excludeFromGI(metalBall);
  scene.add(metalBall);

  camera.near = radius * 0.01; camera.far = radius * 30; camera.updateProjectionMatrix();
  const sc = sun.shadow.camera;
  sc.left = -radius; sc.right = radius; sc.top = radius; sc.bottom = -radius;
  sc.near = 0.1; sc.far = radius * 8; sc.updateProjectionMatrix();
  sky.scale.setScalar(camera.far * 0.5);

  // model is in the scene now → build the probe field over it.
  gi.requestRebuild();
  hideStatus();
  markInteraction();
}, (xhr) => {
  if (xhr.total) setStatus('loading Sponza… ' + Math.min(100, Math.round(xhr.loaded / xhr.total * 100)) + '%');
}, (err) => {
  setStatus(`Failed to load ${sponzaUrl}\n` + (err?.message || err), true);
});

// ── Render loop ───────────────────────────────────────────────────────────────
let lastFrameTime = 0;
renderer.setAnimationLoop((time) => {
  if (params.fps > 0) {
    const interval = 1000 / params.fps;
    if (time - lastFrameTime < interval) return;
    lastFrameTime = time;
  }
  controls.update();
  if (metalBall) {
    metalBall.position.y = metalBallBaseY + Math.sin(time * 0.0018) * 4;
  }
  if (sunGiDirty) flushSunGiRefresh();
  // SPEEDBALL GI self-gates on idle: the BVH build + GPU solve are held while orbiting
  // or dragging a slider (world-space GI is lossless held static), then converge
  // once the view rests — so a frame hitch can never land mid-interaction.
  gi?.update({ playing: false }); // idle-gated solve (camera-rest detection is built in)
  updateProbeHelpers();
  renderPipeline.render();
  stats.update();
});
