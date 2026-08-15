import * as THREE from 'three/webgpu';
import { normalWorld, positionWorld } from 'three/tsl';
import { excludeFromGI } from 'speedball-gi';

export function createProbeHelpers(scene, gi, params) {
  let mesh = null;
  let signature = '';
  const size = new THREE.Vector3();
  const matrix = new THREE.Matrix4();

  function makeMaterial(lit) {
    if (!lit) {
      return new THREE.MeshBasicMaterial({
        color: 0x808080,
        depthWrite: false,
        opacity: 0.85,
        toneMapped: false,
        transparent: true,
      });
    }

    const node = gi.node;
    const samplePosition = positionWorld.add(normalWorld.mul(node.normalBiasNode[0]));
    const material = new THREE.MeshBasicNodeMaterial({
      depthWrite: false,
      opacity: 0.95,
      transparent: true,
    });
    material.colorNode = node.sampleIrradiance(samplePosition, normalWorld, normalWorld).max(0);
    return material;
  }

  return function updateProbeHelpers() {
    if (!params.showProbes) {
      if (mesh) mesh.visible = false;
      return;
    }
    if (!gi.hasData()) {
      if (mesh) mesh.visible = false;
      return;
    }

    const resolution = gi.getResolution();
    const bounds = gi.getBounds();

    const rx = Math.max(1, Math.round(resolution.x));
    const ry = Math.max(1, Math.round(resolution.y));
    const rz = Math.max(1, Math.round(resolution.z));
    const total = rx * ry * rz;
    const min = bounds.min;
    size.subVectors(bounds.max, bounds.min);
    const lit = gi.node.active === true;
    const nextSignature = [
      `${rx},${ry},${rz}`,
      `${min.x.toFixed(2)},${min.y.toFixed(2)},${min.z.toFixed(2)}`,
      `${size.x.toFixed(2)},${size.y.toFixed(2)},${size.z.toFixed(2)}`,
      lit ? '1' : '0',
    ].join('|');

    if (nextSignature === signature && mesh) {
      mesh.visible = true;
      return;
    }
    signature = nextSignature;

    if (!mesh || mesh.count !== total || mesh.userData.lit !== lit) {
      if (mesh) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
      }

      const cell = Math.max(
        size.x / Math.max(1, rx - 1),
        size.y / Math.max(1, ry - 1),
        size.z / Math.max(1, rz - 1),
      );
      mesh = new THREE.InstancedMesh(
        new THREE.SphereGeometry(cell * 0.08 + 1e-3, 8, 6),
        makeMaterial(lit),
        total,
      );
      mesh.userData.lit = lit;
      mesh.frustumCulled = false;
      mesh.renderOrder = 9999;
      excludeFromGI(mesh);
      scene.add(mesh);
    }

    let index = 0;
    for (let z = 0; z < rz; z++) {
      for (let y = 0; y < ry; y++) {
        for (let x = 0; x < rx; x++) {
          const fx = rx > 1 ? x / (rx - 1) : 0;
          const fy = ry > 1 ? y / (ry - 1) : 0;
          const fz = rz > 1 ? z / (rz - 1) : 0;
          matrix.makeTranslation(
            min.x + fx * size.x,
            min.y + fy * size.y,
            min.z + fz * size.z,
          );
          mesh.setMatrixAt(index++, matrix);
        }
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.visible = true;
  };
}
