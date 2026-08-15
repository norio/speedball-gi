// post_settings.js — DEMO helper: TRAA → GTAO-modulated beauty is actually
// GTAO (modulate) → TRAA → Bloom, all before tone mapping. Not part of the library.

import * as THREE from 'three/webgpu';
import { pass, mrt, output, velocity, uniform, normalView, vec3, vec4, mix, float } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { traa } from './TRAANode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';

export const POST_DEFAULTS = {
  bloomEnabled: true, bloomThreshold: 1, bloomStrength: 0.35, bloomRadius: 0.4,
  bloomSmoothWidth: 0.01, bloomResolution: 0.5,
  traaEnabled: true, traaDepthThreshold: 0.0005, traaEdgeDepthDiff: 0.001,
  traaMaxVelocityLength: 128, traaSubpixelCorrection: true,
  gtaoEnabled: true, gtaoRadius: 0.4, gtaoThickness: 1, gtaoScale: 1,
  gtaoSamples: 16, gtaoDistanceExponent: 1, gtaoDistanceFallOff: 1,
  gtaoResolution: 0.5, gtaoTemporal: true,
};

const POST_KEYS = Object.keys(POST_DEFAULTS);

export function addPostPipeline(gui, renderer, scene, camera, params) {
  for (const k of POST_KEYS) if (!(k in params)) params[k] = POST_DEFAULTS[k];

  const renderPipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera, { samples: 0 });
  scenePass.setMRT(mrt({ output, velocity, normal: normalView }));
  const scenePassColor = scenePass.getTextureNode('output');
  const scenePassDepth = scenePass.getTextureNode('depth');
  const scenePassVelocity = scenePass.getTextureNode('velocity');
  const scenePassNormal = scenePass.getTextureNode('normal');

  const aoPass = ao(scenePassDepth, scenePassNormal, camera);
  aoPass.radius.value = params.gtaoRadius;
  aoPass.thickness.value = params.gtaoThickness;
  aoPass.scale.value = params.gtaoScale;
  aoPass.samples.value = params.gtaoSamples;
  aoPass.distanceExponent.value = params.gtaoDistanceExponent;
  aoPass.distanceFallOff.value = params.gtaoDistanceFallOff;
  aoPass.resolutionScale = params.gtaoResolution;
  aoPass.useTemporalFiltering = params.gtaoTemporal;

  // Keep GTAO in Three.js's build-time update list, but skip its GPU pass while disabled.
  const updateGtao = aoPass.updateBefore.bind(aoPass);
  aoPass.updateBefore = (frame) => {
    if (params.gtaoEnabled) updateGtao(frame);
  };

  const gtaoBlend = uniform(params.gtaoEnabled ? 1 : 0);
  const aoFactor = mix(float(1), aoPass.getTextureNode().r, gtaoBlend);
  const shadedColor = scenePassColor.mul(vec4(vec3(aoFactor), 1));

  const traaPass = traa(shadedColor, scenePassDepth, scenePassVelocity, camera);
  const traaDepthThreshold = uniform(params.traaDepthThreshold);
  const traaEdgeDepthDiff = uniform(params.traaEdgeDepthDiff);
  const traaMaxVelocityLength = uniform(params.traaMaxVelocityLength);
  traaPass.depthThreshold = traaDepthThreshold;
  traaPass.edgeDepthDiff = traaEdgeDepthDiff;
  traaPass.maxVelocityLength = traaMaxVelocityLength;
  traaPass.useSubpixelCorrection = params.traaSubpixelCorrection;

  let bloomPass = null;
  let bloomInput = null;
  function createBloomPass(inputNode) {
    if (bloomPass) bloomPass.dispose();
    bloomPass = bloom(inputNode, params.bloomStrength, params.bloomRadius, params.bloomThreshold);
    bloomPass.smoothWidth.value = params.bloomSmoothWidth;
    bloomPass.setResolutionScale(params.bloomResolution);
    bloomInput = inputNode;
    window.bloom = bloomPass;
  }

  function applyPostOutput() {
    gtaoBlend.value = params.gtaoEnabled ? 1 : 0;
    const color = params.traaEnabled ? traaPass : shadedColor;
    if (bloomInput !== color) createBloomPass(color);
    renderPipeline.outputNode = params.bloomEnabled ? color.add(bloomPass) : color;
    renderPipeline.needsUpdate = true;
  }
  applyPostOutput();

  const fPost = gui.addFolder('Post');

  const fGtao = fPost.addFolder('GTAO');
  fGtao.add(params, 'gtaoEnabled').name('enabled').onChange(applyPostOutput);
  fGtao.add(params, 'gtaoRadius', 0.05, 2, 0.01).name('radius').onChange((v) => { aoPass.radius.value = v; });
  fGtao.add(params, 'gtaoThickness', 0.01, 10, 0.01).name('thickness').onChange((v) => { aoPass.thickness.value = v; });
  fGtao.add(params, 'gtaoScale', 0, 2, 0.01).name('scale').onChange((v) => { aoPass.scale.value = v; });
  fGtao.add(params, 'gtaoSamples', 2, 32, 1).name('samples').onChange((v) => { aoPass.samples.value = v; });
  fGtao.add(params, 'gtaoDistanceExponent', 1, 4, 0.01).name('distance exponent').onChange((v) => { aoPass.distanceExponent.value = v; });
  fGtao.add(params, 'gtaoDistanceFallOff', 0, 1, 0.01).name('distance falloff').onChange((v) => { aoPass.distanceFallOff.value = v; });
  fGtao.add(params, 'gtaoResolution', 0.25, 1, 0.25).name('resolution').onChange((v) => { aoPass.resolutionScale = v; });
  fGtao.add(params, 'gtaoTemporal').name('temporal filtering').onChange((v) => { aoPass.useTemporalFiltering = v; });
  fGtao.close();

  const fTraa = fPost.addFolder('TRAA');
  fTraa.add(params, 'traaEnabled').name('enabled').onChange(applyPostOutput);
  fTraa.add(params, 'traaDepthThreshold', 0, 0.01, 0.0001).name('depth threshold').onChange((v) => { traaDepthThreshold.value = v; });
  fTraa.add(params, 'traaEdgeDepthDiff', 0, 0.02, 0.0001).name('edge depth').onChange((v) => { traaEdgeDepthDiff.value = v; });
  fTraa.add(params, 'traaMaxVelocityLength', 8, 512, 1).name('max velocity').onChange((v) => { traaMaxVelocityLength.value = v; });
  fTraa.add(params, 'traaSubpixelCorrection').name('subpixel correction').onChange((v) => {
    traaPass.useSubpixelCorrection = v;
    renderPipeline.needsUpdate = true;
  });
  fTraa.close();

  const fBloom = fPost.addFolder('Bloom');
  fBloom.add(params, 'bloomEnabled').name('enabled').onChange(applyPostOutput);
  fBloom.add(params, 'bloomThreshold').min(0).step(0.05).name('threshold').onChange((v) => { bloomPass.threshold.value = v; }); // HDR, uncapped
  fBloom.add(params, 'bloomStrength').min(0).step(0.05).name('strength').onChange((v) => { bloomPass.strength.value = v; }); // uncapped
  fBloom.add(params, 'bloomRadius', 0, 1, 0.01).name('radius').onChange((v) => { bloomPass.radius.value = v; });
  fBloom.add(params, 'bloomSmoothWidth', 0, 1, 0.01).name('smooth width').onChange((v) => { bloomPass.smoothWidth.value = v; });
  fBloom.add(params, 'bloomResolution', 0.25, 1, 0.25).name('resolution').onChange((v) => { bloomPass.setResolutionScale(v); });
  fBloom.close();

  return { renderPipeline, aoPass, traaPass, applyPostOutput };
}
