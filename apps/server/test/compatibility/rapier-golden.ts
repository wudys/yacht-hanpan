import { fileURLToPath } from 'node:url';

import RAPIER from '@dimforge/rapier3d-deterministic';
import * as rapierGlue from '@dimforge/rapier3d-deterministic/rapier_wasm3d_bg';

import type { GoldenDropResult } from './protocol';

const STEP_SECONDS = 1 / 60;
const STEP_COUNT = 120;
const QUANTIZATION = 1_000_000;

let initialization: Promise<string> | undefined;

export function initializeDeterministicRapier(): Promise<string> {
  initialization ??= initializeWasm();
  return initialization;
}

export async function runGoldenDrop(seed: string, input: Float32Array): Promise<GoldenDropResult> {
  await initializeDeterministicRapier();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = STEP_SECONDS;

  try {
    const floor = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(4, 0.1, 4)
        .setTranslation(0, -0.1, 0)
        .setFriction(0.72)
        .setRestitution(0.18),
      floor,
    );

    const seedHash = hashSeed(seed);
    const inputSum = [...input].reduce((sum, value) => sum + value, 0);
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(
          signedUnit(seedHash) * 0.35,
          2.2 + unit(rotate(seedHash, 7)) * 0.6,
          signedUnit(rotate(seedHash, 13)) * 0.35,
        )
        .setRotation({
          x: signedUnit(rotate(seedHash, 3)) * 0.35,
          y: signedUnit(rotate(seedHash, 9)) * 0.35,
          z: signedUnit(rotate(seedHash, 17)) * 0.35,
          w: 1,
        }),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setFriction(0.66).setRestitution(0.24),
      body,
    );
    body.applyImpulse(
      {
        x: signedUnit(rotate(seedHash, 5)) * 1.4 + inputSum * 0.01,
        y: 0.8 + unit(rotate(seedHash, 11)) * 0.7,
        z: signedUnit(rotate(seedHash, 19)) * 1.4 - inputSum * 0.01,
      },
      true,
    );
    body.applyTorqueImpulse(
      {
        x: signedUnit(rotate(seedHash, 2)) * 1.8,
        y: signedUnit(rotate(seedHash, 15)) * 1.8,
        z: signedUnit(rotate(seedHash, 23)) * 1.8,
      },
      true,
    );

    for (let step = 0; step < STEP_COUNT; step += 1) world.step();

    const position = body.translation();
    const rotation = body.rotation();
    const samples = new Float32Array([
      quantize(position.x),
      quantize(position.y),
      quantize(position.z),
      quantize(rotation.x),
      quantize(rotation.y),
      quantize(rotation.z),
      quantize(rotation.w),
    ]);
    return {
      signature: [...samples].join(':'),
      samples,
    };
  } finally {
    world.free();
  }
}

function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (const character of seed) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function rotate(value: number, bits: number): number {
  // eslint-disable-next-line no-bitwise -- Rotate-left is defined in 32-bit space.
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function unit(value: number): number {
  return value / 0xffffffff;
}

function signedUnit(value: number): number {
  return unit(value) * 2 - 1;
}

function quantize(value: number): number {
  return Math.round(value * QUANTIZATION) / QUANTIZATION;
}

async function initializeWasm(): Promise<string> {
  const wasmPath = fileURLToPath(
    import.meta.resolve('@dimforge/rapier3d-deterministic/rapier_wasm3d_bg.wasm'),
  );
  const wasmModule = await WebAssembly.compile(await Bun.file(wasmPath).arrayBuffer());
  const wasmInstance = await WebAssembly.instantiate(wasmModule, {
    './rapier_wasm3d_bg.js': rapierGlue,
  });
  rapierGlue.__wbg_set_wasm(wasmInstance.exports);
  return RAPIER.version();
}
