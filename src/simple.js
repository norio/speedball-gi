import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { installSpeedballGI } from 'speedball-gi';
import { addGiPanel, applyGiSettings, GI_DEFAULTS } from './gi_settings.js';
import { addPostPipeline, POST_DEFAULTS } from './post_settings.js';
import { createProbeHelpers } from './probe_helpers.js';
import { createSimpleScene } from './simple_scene.js';

const canvas = document.getElementById('c');
const statusEl = document.getElementById('status');
const giStateEl = document.getElementById('gi-state');
const giDetailEl = document.getElementById('gi-detail');

function setStatus(message, error = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('err', error);
  statusEl.classList.remove('hide');
}

function hideStatus() {
  statusEl.classList.add('hide');
}

window.addEventListener('error', (event) => {
  setStatus(`Error:\n${event.error?.stack || event.message}`, true);
});
window.addEventListener('unhandledrejection', (event) => {
  setStatus(`Error:\n${event.reason?.stack || event.reason}`, true);
});

const nativeDpr = window.devicePixelRatio || 1;
const defaultDpr = Math.min(nativeDpr, 1.5);
const court = createSimpleScene();
const params = {
  ...GI_DEFAULTS,
  ...POST_DEFAULTS,
  giIntensity: 14,
  giDivisions: 4,
  giRays: 64,
  giHysteresis: 0.72,
  giSky: 0.85,
  bloomThreshold: 1.5,
  bloomStrength: 0.1,
  bloomSmoothWidth: 0.25,
  exposure: 1.05,
  sunIntensity: court.sun.intensity,
};

// TRAA jitters the camera, so the canvas itself must not use MSAA.
const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
renderer.setPixelRatio(defaultDpr);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = params.exposure;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
await renderer.init();

if (renderer.backend?.isWebGPUBackend !== true) {
  setStatus(
    'WebGPU not available.\nThis demo needs a WebGPU-capable browser\n(Chrome/Edge 121+, or Firefox Nightly).',
    true,
  );
  throw new Error('WebGPU unavailable');
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x171411);
scene.add(court.root);

const camera = new THREE.PerspectiveCamera(
  50,
  window.innerWidth / window.innerHeight,
  0.08,
  70,
);
camera.position.set(6.35, 2.75, 7.2);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 1.35, -0.45);
controls.minDistance = 2.4;
controls.maxDistance = 15;
controls.maxPolarAngle = Math.PI * 0.49;

const gi = installSpeedballGI({
  renderer,
  scene,
  camera,
  enabled: params.giEnabled,
  intensity: params.giIntensity,
  divisions: params.giDivisions,
  hysteresis: params.giHysteresis,
  roughReflections: true,
  reflectionIntensity: params.giReflectionIntensity,
  reflectionSkyFallback: true,
});

if (!gi.isSupported()) {
  setStatus('SPEEDBALL GI needs WebGPU storage features.', true);
  throw new Error('SPEEDBALL GI unsupported');
}

gi.setSky({
  zenith: new THREE.Color(0x79a9e8),
  horizon: new THREE.Color(0xf4c09a),
  ground: new THREE.Color(0x332a24),
});
gi.setSmoothness(1);
gi.setFilterStrength(1);
applyGiSettings(gi, params);

const updateProbeHelpers = createProbeHelpers(scene, gi, params);
const gui = new GUI();
addGiPanel(gui, gi, params, {
  onInteract: () => gi.markInteraction(),
  onStructure: updateProbeHelpers,
});

function refreshLighting() {
  court.sun.shadow.needsUpdate = true;
  gi.forceLightingRefresh();
  gi.markInteraction();
}

const sceneFolder = gui.addFolder('Court');
sceneFolder.add(params, 'sunIntensity', 0, 18, 0.1).name('sun intensity').onChange((value) => {
  court.sun.intensity = value;
  refreshLighting();
});
sceneFolder.add(params, 'exposure', 0.2, 2.5, 0.01).name('exposure').onChange((value) => {
  renderer.toneMappingExposure = value;
});

const { renderPipeline, aoPass, traaPass } = addPostPipeline(
  gui,
  renderer,
  scene,
  camera,
  params,
);

const compactControls = window.matchMedia('(max-width: 700px), (max-height: 560px)');
if (compactControls.matches) gui.close();

let lastGiState = '';
let lastGiDetail = '';
function syncGiReadout() {
  const ready = gi.hasData();
  const state = !params.giEnabled ? 'OFF' : ready ? 'LIVE' : 'BUILDING';
  const detail = params.giEnabled
    ? `intensity ${params.giIntensity.toFixed(1)} · G to compare`
    : 'direct light only · G to restore';
  if (state !== lastGiState) {
    lastGiState = state;
    giStateEl.textContent = state;
    giStateEl.classList.toggle('live', state === 'LIVE');
    giStateEl.classList.toggle('off', state === 'OFF');
  }
  if (detail !== lastGiDetail) {
    lastGiDetail = detail;
    giDetailEl.textContent = detail;
  }
}

window.addEventListener('keydown', (event) => {
  const target = event.target;
  if (event.repeat || target instanceof HTMLInputElement || target instanceof HTMLSelectElement) return;
  if (event.code !== 'KeyG') return;
  params.giEnabled = !params.giEnabled;
  gi.setEnabled(params.giEnabled);
  gi.markInteraction();
  syncGiReadout();
  for (const controller of gui.controllersRecursive()) controller.updateDisplay();
});

controls.addEventListener('change', () => gi.markInteraction());
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  gi.markInteraction();
});

window.gi = gi;
window.gui = gui;
window.gtao = aoPass;
window.traa = traaPass;
window.renderPipeline = renderPipeline;
window.scene = scene;
window.camera = camera;
window.renderer = renderer;

gi.requestRebuild();
syncGiReadout();
hideStatus();

renderer.setAnimationLoop(() => {
  controls.update();
  gi.update({ playing: false });
  updateProbeHelpers();
  syncGiReadout();
  renderPipeline.render();
});
