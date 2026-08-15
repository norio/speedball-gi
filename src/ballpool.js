import * as THREE from 'three/webgpu';
import GUI from 'lil-gui';
import Stats from 'stats-gl';
import { installSpeedballGI } from 'speedball-gi';
import { addGiPanel, applyGiSettings, GI_DEFAULTS } from './gi_settings.js';
import { addPostPipeline, POST_DEFAULTS } from './post_settings.js';
import { createProbeHelpers } from './probe_helpers.js';
import {
  BOX_DEPTH,
  BOX_HEIGHT,
  CAM_FOV,
  createBallPoolScene,
} from './ballpool_scene.js';

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
const params = {
  ...GI_DEFAULTS,
  ...POST_DEFAULTS,
  giIntensity: 10,
  giDivisions: 8,
  giRays: 64,
  giHysteresis: 0.72,
  giSky: 0,
  bloomThreshold: 1.5,
  bloomStrength: 0.1,
  bloomSmoothWidth: 0.25,
  exposure: 0.5,
  lightIntensity: 80,
};

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

const stats = new Stats({ trackGPU: false, trackCPT: false });
await stats.init(renderer);
stats.dom.classList.add('stats-gl');
document.body.appendChild(stats.dom);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x090909);

const camera = new THREE.PerspectiveCamera(
  CAM_FOV,
  window.innerWidth / window.innerHeight,
  0.1,
  100,
);

function fitCameraToBox() {
  const verticalFov = THREE.MathUtils.degToRad(CAM_FOV / 2);
  const distance = BOX_HEIGHT / 2 / Math.tan(verticalFov);
  camera.position.set(0, BOX_HEIGHT / 2, distance + BOX_DEPTH / 2);
  camera.lookAt(0, BOX_HEIGHT / 2, 0);
  camera.updateProjectionMatrix();
}

fitCameraToBox();

const ballPool = createBallPoolScene(scene);
ballPool.rebuild(camera.aspect);

const mouseLight = new THREE.PointLight(0xffffff, params.lightIntensity);
mouseLight.position.set(0, BOX_HEIGHT / 2, BOX_DEPTH / 2);
mouseLight.castShadow = true;
mouseLight.shadow.mapSize.set(1024, 1024);
mouseLight.shadow.radius = 20;
scene.add(mouseLight);

// SPEEDBALL GI must be installed before the first render or animation loop.
const gi = installSpeedballGI({
  renderer,
  scene,
  camera,
  enabled: params.giEnabled,
  intensity: params.giIntensity,
  divisions: params.giDivisions,
  hysteresis: params.giHysteresis,
});

if (!gi.isSupported()) {
  setStatus('SPEEDBALL GI needs WebGPU storage features.', true);
  throw new Error('SPEEDBALL GI unsupported');
}

gi.setSky({
  zenith: new THREE.Color(0x000000),
  horizon: new THREE.Color(0x000000),
  ground: new THREE.Color(0x000000),
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

const poolFolder = gui.addFolder('Ball Pool');
poolFolder
  .add(params, 'lightIntensity', 0, 160, 1)
  .name('light intensity')
  .onChange((value) => {
    mouseLight.intensity = value;
    gi.forceLightingRefresh();
  });
poolFolder.add({ drop: () => ballPool.respawnBalls(20) }, 'drop').name('drop 20 balls');
poolFolder
  .add(params, 'exposure', 0.2, 2.5, 0.01)
  .name('exposure')
  .onChange((value) => {
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
    ? `${ballPool.getBallCount()} balls · G to compare`
    : `${ballPool.getBallCount()} balls · direct light only · G to restore`;

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
  syncGiReadout();
  for (const controller of gui.controllersRecursive()) controller.updateDisplay();
});

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const frontPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -BOX_DEPTH / 2);
const pointerHit = new THREE.Vector3();
const mouseLightTarget = new THREE.Vector3(0, BOX_HEIGHT / 2, BOX_DEPTH / 2);
const mouseRayOrigin = new THREE.Vector3();
const mouseRayDirection = new THREE.Vector3();
const mouseRayOriginTarget = new THREE.Vector3();
const mouseRayDirectionTarget = new THREE.Vector3();
const activePointers = new Set();
let mouseMoving = false;
let mouseStopTimer = 0;
let pointerDown = false;

function updatePointerRay(event) {
  const bounds = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
  pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  mouseRayOriginTarget.copy(raycaster.ray.origin);
  mouseRayDirectionTarget.copy(raycaster.ray.direction);
  if (raycaster.ray.intersectPlane(frontPlane, pointerHit)) mouseLightTarget.copy(pointerHit);

  mouseMoving = true;
  clearTimeout(mouseStopTimer);
  mouseStopTimer = setTimeout(() => {
    mouseMoving = false;
  }, 50);
}

function onPointerDown(event) {
  activePointers.add(event.pointerId);
  canvas.setPointerCapture(event.pointerId);
  pointerDown = event.pointerType === 'touch' ? activePointers.size >= 2 : true;
  updatePointerRay(event);
}

function onPointerUp(event) {
  activePointers.delete(event.pointerId);
  pointerDown = event.pointerType === 'touch' ? activePointers.size >= 2 : false;
}

canvas.addEventListener('pointerdown', onPointerDown);
canvas.addEventListener('pointermove', updatePointerRay);
canvas.addEventListener('pointerup', onPointerUp);
canvas.addEventListener('pointercancel', onPointerUp);
canvas.addEventListener('lostpointercapture', onPointerUp);
window.addEventListener('blur', () => {
  activePointers.clear();
  pointerDown = false;
});

let resizeTimer = 0;
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  fitCameraToBox();
  renderer.setSize(window.innerWidth, window.innerHeight);
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    ballPool.rebuild(camera.aspect);
    gi.requestRebuild();
    syncGiReadout();
  }, 120);
});

window.gi = gi;
window.gui = gui;
window.gtao = aoPass;
window.traa = traaPass;
window.renderPipeline = renderPipeline;
window.scene = scene;
window.camera = camera;
window.renderer = renderer;
window.ballPool = ballPool;

const timer = new THREE.Timer();
gi.requestRebuild();
syncGiReadout();
hideStatus();

renderer.setAnimationLoop(() => {
  timer.update();
  const deltaSeconds = Math.min(timer.getDelta(), 1 / 30);
  const easeFactor = 1 - Math.exp(-8 * deltaSeconds);
  mouseRayOrigin.lerp(mouseRayOriginTarget, easeFactor);
  mouseRayDirection.lerp(mouseRayDirectionTarget, easeFactor);
  mouseLight.position.lerp(mouseLightTarget, easeFactor);

  if (pointerDown) ballPool.respawnBalls();
  if (mouseMoving) ballPool.pushAlongRay(mouseRayOrigin, mouseRayDirection);
  ballPool.step(deltaSeconds);
  ballPool.syncMeshes();

  gi.update({ playing: false });
  updateProbeHelpers();
  syncGiReadout();
  renderPipeline.render();
  stats.update();
});
