import * as THREE from 'three/webgpu';
import { excludeFromGI } from 'speedball-gi';

function standard(parameters) {
  return new THREE.MeshStandardMaterial({ metalness: 0, ...parameters });
}

function box(width, height, depth, material, x, y, z) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function addColonnade(root, material) {
  const columnZ = [-2.5, -1.25, 0, 1.25, 2.5];
  for (const z of columnZ) {
    root.add(box(0.34, 3.45, 0.34, material, -4.02, 1.72, z));
    root.add(box(0.34, 3.45, 0.34, material, 4.02, 1.72, z));
  }
  root.add(box(0.34, 0.32, 6.4, material, -4.02, 3.52, 0));
  root.add(box(0.34, 0.32, 6.4, material, 4.02, 3.52, 0));
}

function addRoofBeams(root, material) {
  for (const z of [-2.5, -1.25, 0, 1.25, 2.5]) {
    root.add(box(8.35, 0.18, 0.24, material, 0, 4.18, z));
  }
}

function addSculptures(root, materials) {
  const centerPedestal = box(1.15, 0.72, 1.15, materials.plaster, 0, 0.36, -0.1);
  root.add(centerPedestal);

  const bounceSphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 48, 32),
    materials.ceramic,
  );
  bounceSphere.name = 'Diffuse Bounce Sphere';
  bounceSphere.position.set(0, 1.22, -0.1);
  bounceSphere.castShadow = true;
  bounceSphere.receiveShadow = true;
  root.add(bounceSphere);

  root.add(box(0.8, 0.48, 0.8, materials.plaster, -2.15, 0.24, 0.9));
  const torus = new THREE.Mesh(
    new THREE.TorusGeometry(0.29, 0.11, 24, 56),
    materials.cobalt,
  );
  torus.position.set(-2.15, 0.9, 0.9);
  torus.rotation.set(0.75, 0.2, 0.15);
  torus.castShadow = true;
  torus.receiveShadow = true;
  root.add(torus);

  root.add(box(0.8, 0.48, 0.8, materials.plaster, 2.1, 0.24, -0.9));
  const metalBall = new THREE.Mesh(
    new THREE.SphereGeometry(0.32, 48, 32),
    new THREE.MeshPhysicalMaterial({
      clearcoat: 0.5,
      color: 0xc8d2d8,
      metalness: 1,
      roughness: 0.08,
    }),
  );
  metalBall.name = 'Local Reflection Sphere';
  metalBall.position.set(2.1, 0.92, -0.9);
  metalBall.castShadow = true;
  metalBall.receiveShadow = true;
  excludeFromGI(metalBall);
  root.add(metalBall);
}

export function createSimpleScene() {
  const root = new THREE.Group();
  root.name = 'Afterimage Court';

  const materials = {
    plaster: standard({ color: 0xded3c4, roughness: 0.92 }),
    oxide: standard({ color: 0xb83c23, roughness: 0.82 }),
    viridian: standard({ color: 0x08725f, roughness: 0.82 }),
    floor: new THREE.MeshPhysicalMaterial({
      clearcoat: 0.22,
      clearcoatRoughness: 0.55,
      color: 0x28231f,
      metalness: 0.04,
      roughness: 0.34,
    }),
    path: standard({ color: 0x5b5148, roughness: 0.78 }),
    ceramic: standard({ color: 0xf2ece2, roughness: 0.28 }),
    cobalt: standard({ color: 0x294aa1, roughness: 0.42 }),
    dark: standard({ color: 0x181513, roughness: 0.88 }),
  };

  root.add(box(9, 0.2, 7, materials.floor, 0, -0.1, 0));
  root.add(box(3, 0.035, 6.4, materials.path, 0, 0.018, 0));
  root.add(box(0.2, 4.5, 7, materials.oxide, -4.4, 2.25, 0));
  root.add(box(0.2, 4.5, 7, materials.viridian, 4.4, 2.25, 0));
  root.add(box(8.6, 4.5, 0.2, materials.plaster, 0, 2.25, -3.4));

  const niche = box(2.3, 2.85, 0.08, materials.dark, 0, 1.62, -3.28);
  niche.castShadow = false;
  root.add(niche);

  addColonnade(root, materials.plaster);
  addRoofBeams(root, materials.dark);
  addSculptures(root, materials);

  const sun = new THREE.DirectionalLight(0xffefd2, 7.2);
  sun.position.set(-4.8, 8.2, 6.4);
  sun.target.position.set(0, 0.7, -1.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.000001;
  sun.shadow.normalBias = 0.08;
  const shadowCamera = sun.shadow.camera;
  shadowCamera.left = -6;
  shadowCamera.right = 6;
  shadowCamera.top = 6;
  shadowCamera.bottom = -5;
  shadowCamera.near = 0.5;
  shadowCamera.far = 24;
  shadowCamera.updateProjectionMatrix();
  root.add(sun, sun.target);

  root.add(new THREE.HemisphereLight(0x9fc6ff, 0x3a3029, 0.035));

  return { root, sun };
}
