import * as THREE from 'three/webgpu';
import { World } from '@perplexdotgg/bounce';

export const BALL_RADIUS = 0.4;
export const BOX_HEIGHT = 6;
export const BOX_DEPTH = 8;
export const CAM_FOV = 45;

const FILL_RATIO = 0.4;
const PACKING = 0.6;
const WALL_THICKNESS = 0.5;
const PUSH_RADIUS = 1.5;
const PUSH_STRENGTH = 15;
const MATRIX_POSITION_EPSILON_SQ = 1e-6;
const BALL_COLORS = [
  0xff4444,
  0x44ff44,
  0x4488ff,
  0xffaa00,
  0xff44ff,
  0x44ffff,
  0xffff44,
  0xff8844,
  0x8844ff,
  0x44ff88,
];

function makeWallMaterial(color) {
  return new THREE.MeshPhysicalMaterial({
    color,
    metalness: 0,
    roughness: 0.7,
  });
}

function makeBallMaterial(color) {
  return new THREE.MeshPhysicalMaterial({
    color,
    metalness: 0.1,
    roughness: 0.3,
  });
}

export function getBallPoolWidth(aspect) {
  return Math.max(BALL_RADIUS * 3, BOX_HEIGHT * aspect);
}

export function getBallCount(boxWidth) {
  const roomVolume = boxWidth * BOX_HEIGHT * BOX_DEPTH;
  const ballVolume = (4 / 3) * Math.PI * BALL_RADIUS ** 3;
  return Math.floor((roomVolume * FILL_RATIO * PACKING) / ballVolume);
}

export function createBallPoolScene(scene) {
  const wallMaterials = {
    white: makeWallMaterial(0xeeeeee),
    red: makeWallMaterial(0xff2222),
    green: makeWallMaterial(0x22ff22),
  };
  const ballMaterials = BALL_COLORS.map(makeBallMaterial);
  const boxSize = { w: BOX_HEIGHT, h: BOX_HEIGHT, d: BOX_DEPTH };
  const dummy = new THREE.Object3D();
  const ray = new THREE.Ray();
  const closest = new THREE.Vector3();
  const ballPosition = new THREE.Vector3();
  const pushDirection = new THREE.Vector3();
  const dirtyMeshes = new Set();

  let world = null;
  let sphereGeometry = null;
  let wallMeshes = [];
  let ballMeshes = [];
  let ballEntries = [];

  function clearMeshes() {
    for (const mesh of wallMeshes) {
      scene.remove(mesh);
      mesh.geometry.dispose();
    }
    wallMeshes = [];

    for (const mesh of ballMeshes) {
      scene.remove(mesh);
      mesh.dispose();
    }
    ballMeshes = [];
    ballEntries = [];
    sphereGeometry?.dispose();
    sphereGeometry = null;
  }

  function addWall(size, position, material, visible = true) {
    const shape = world.createBox({ width: size[0], height: size[1], depth: size[2] });
    world.createStaticBody({ shape, position });
    if (!visible) return;

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.position.set(...position);
    mesh.receiveShadow = true;
    scene.add(mesh);
    wallMeshes.push(mesh);
  }

  function createWalls() {
    const halfWidth = boxSize.w / 2;
    const halfHeight = boxSize.h / 2;
    const halfDepth = boxSize.d / 2;
    const thickness = WALL_THICKNESS;

    addWall(
      [boxSize.w, thickness, boxSize.d],
      [0, -thickness / 2, 0],
      wallMaterials.white,
    );
    addWall(
      [boxSize.w, thickness, boxSize.d],
      [0, boxSize.h + thickness / 2, 0],
      wallMaterials.white,
    );
    addWall(
      [boxSize.w, boxSize.h, thickness],
      [0, halfHeight, -halfDepth - thickness / 2],
      wallMaterials.white,
    );
    addWall(
      [boxSize.w, boxSize.h, thickness],
      [0, halfHeight, halfDepth + thickness / 2],
      wallMaterials.white,
      false,
    );
    addWall(
      [thickness, boxSize.h, boxSize.d],
      [-halfWidth - thickness / 2, halfHeight, 0],
      wallMaterials.red,
    );
    addWall(
      [thickness, boxSize.h, boxSize.d],
      [halfWidth + thickness / 2, halfHeight, 0],
      wallMaterials.green,
    );
  }

  function createBalls() {
    const ballCount = getBallCount(boxSize.w);
    const groupCounts = BALL_COLORS.map(() => 0);
    const nextIndices = BALL_COLORS.map(() => 0);
    for (let index = 0; index < ballCount; index++) groupCounts[index % groupCounts.length]++;

    sphereGeometry = new THREE.SphereGeometry(BALL_RADIUS, 32, 16);
    ballMeshes = groupCounts.map((count, groupIndex) => {
      const mesh = new THREE.InstancedMesh(
        sphereGeometry,
        ballMaterials[groupIndex],
        count,
      );
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      scene.add(mesh);
      return mesh;
    });

    const sphereShape = world.createSphere({ radius: BALL_RADIUS });
    const halfWidth = boxSize.w / 2 - BALL_RADIUS - 0.1;
    const halfDepth = boxSize.d / 2 - BALL_RADIUS - 0.1;

    for (let index = 0; index < ballCount; index++) {
      const groupIndex = index % BALL_COLORS.length;
      const body = world.createDynamicBody({
        shape: sphereShape,
        position: [
          (Math.random() - 0.5) * 2 * halfWidth,
          BALL_RADIUS + Math.random() * (boxSize.h - BALL_RADIUS * 2),
          (Math.random() - 0.5) * 2 * halfDepth,
        ],
        mass: 1,
        restitution: 0.5,
        friction: 0.4,
      });
      ballEntries.push({
        body,
        mesh: ballMeshes[groupIndex],
        instanceIndex: nextIndices[groupIndex]++,
        synced: false,
      });
    }
    syncMeshes();
  }

  function rebuild(aspect) {
    clearMeshes();
    boxSize.w = getBallPoolWidth(aspect);
    world = new World({
      gravity: [0, -9.81, 0],
      solveVelocityIterations: 6,
      solvePositionIterations: 2,
      linearDamping: 0.1,
      angularDamping: 0.1,
      restitution: 0.4,
      friction: 0.5,
    });
    createWalls();
    createBalls();
  }

  function step(deltaSeconds) {
    world?.advanceTime(1 / 60, deltaSeconds);
  }

  function syncMeshes() {
    dirtyMeshes.clear();
    for (const entry of ballEntries) {
      const { body, mesh, instanceIndex } = entry;
      const position = body.position;
      const dx = position.x - (entry.x ?? position.x);
      const dy = position.y - (entry.y ?? position.y);
      const dz = position.z - (entry.z ?? position.z);
      // These untextured spheres are rotationally invariant; only translation changes
      // their image or BVH bounds.
      if (
        entry.synced &&
        (body.isSleeping || dx * dx + dy * dy + dz * dz <= MATRIX_POSITION_EPSILON_SQ)
      ) {
        continue;
      }
      const orientation = body.orientation;
      dummy.position.set(position.x, position.y, position.z);
      dummy.quaternion.set(orientation.x, orientation.y, orientation.z, orientation.w);
      dummy.updateMatrix();
      mesh.setMatrixAt(instanceIndex, dummy.matrix);
      entry.x = position.x;
      entry.y = position.y;
      entry.z = position.z;
      entry.synced = true;
      dirtyMeshes.add(mesh);
    }
    for (const mesh of dirtyMeshes) mesh.instanceMatrix.needsUpdate = true;
  }

  function respawnBalls(count = 5) {
    if (ballEntries.length === 0) return;
    const halfWidth = boxSize.w / 2 - BALL_RADIUS - 0.1;
    const halfDepth = boxSize.d / 2 - BALL_RADIUS - 0.1;

    for (let index = 0; index < count; index++) {
      const { body } = ballEntries[Math.floor(Math.random() * ballEntries.length)];
      body.position.set([
        (Math.random() - 0.5) * 2 * halfWidth,
        boxSize.h - BALL_RADIUS - Math.random(),
        (Math.random() - 0.5) * 2 * halfDepth,
      ]);
      body.linearVelocity.set([0, 0, 0]);
      body.angularVelocity.set([0, 0, 0]);
      body.commitChanges();
      body.wakeUp();
    }
  }

  function pushAlongRay(origin, direction) {
    if (direction.lengthSq() < 1e-6) return;
    ray.origin.copy(origin);
    ray.direction.copy(direction).normalize();

    for (const { body } of ballEntries) {
      const position = body.position;
      ballPosition.set(position.x, position.y, position.z);
      ray.closestPointToPoint(ballPosition, closest);
      const distance = closest.distanceTo(ballPosition);
      if (distance >= PUSH_RADIUS) continue;

      pushDirection.subVectors(ballPosition, closest);
      if (pushDirection.lengthSq() < 0.001) pushDirection.set(0, 1, 0);
      pushDirection.normalize().multiplyScalar(PUSH_STRENGTH * (1 - distance / PUSH_RADIUS));
      body.applyLinearImpulse(pushDirection);
    }
  }

  function dispose() {
    clearMeshes();
    for (const material of Object.values(wallMaterials)) material.dispose();
    for (const material of ballMaterials) material.dispose();
    world = null;
  }

  return {
    rebuild,
    step,
    syncMeshes,
    respawnBalls,
    pushAlongRay,
    dispose,
    getBallCount: () => ballEntries.length,
    getBoxSize: () => ({ ...boxSize }),
  };
}
