import { setTimeout as delay } from 'node:timers/promises';

import { act as actR3f, createRoot, extend } from '@react-three/fiber';
import {
  DEFAULT_CUP_GEOMETRY,
  ROLL_AREA,
  type RollTimeline,
  TRAY_FLOOR_TOP_Y,
  TRAY_GEOMETRY,
} from '@repo/dice-simulation/contract';
import { StrictMode } from 'react';
import * as THREE from 'three';
import { expect, test, vi } from 'vitest';

import { DICE_CANVAS_VIEWPORT_SIZE, layoutSettledDice } from '@/runtime/dice/game-dice-layout';
import { DiceRollPlayback } from '@/runtime/dice/renderer/DiceRollPlayback';
import { DiceRollWarmupScene } from '@/runtime/dice/renderer/DiceRollWarmupScene';
import { DiceSettledScene } from '@/runtime/dice/renderer/DiceSettledScene';
import { DiceCupShell } from '@/runtime/dice/renderer/parts/DiceCupModel';
import { RollStage } from '@/runtime/dice/renderer/parts/RollStage';
import type { RollPlayback } from '@/runtime/dice/replay/resolve-playback';
import { createCupResources } from '@/runtime/dice/resources/cup-resources';
import type { ProceduralDiceResources } from '@/runtime/dice/resources/procedural-resources';

extend({
  AmbientLight: THREE.AmbientLight,
  DirectionalLight: THREE.DirectionalLight,
  Group: THREE.Group,
  HemisphereLight: THREE.HemisphereLight,
  Mesh: THREE.Mesh,
  MeshStandardMaterial: THREE.MeshStandardMaterial,
  Object3D: THREE.Object3D,
  ShadowMaterial: THREE.ShadowMaterial,
});

const FIRST_PLAYBACK: RollPlayback = {
  status: 'static-fallback',
  rollId: 'roll-fallback-a',
  reason: 'DIGEST_MISMATCH',
  dice: [
    { slot: 1, value: 2 },
    { slot: 4, value: 6 },
  ],
};

test('keeps the full tray-to-ceiling shadow volume inside the light camera', async () => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const canvas = createCanvas();
  const root = createTestRoot(canvas);
  const scene = new THREE.Scene();
  await root.configure({
    gl: createRenderer(canvas),
    scene,
    frameloop: 'never',
    size: { width: 340, height: 204, top: 0, left: 0 },
  });
  try {
    await actR3f(async () =>
      root.render(
        <RollStage
          rollArea={ROLL_AREA}
          layout={{
            layerPadding: { extraX: 4, extraTop: 72, extraBottom: 4 },
            visualInset: { x: 0, y: 0 },
          }}
        >
          {null}
        </RollStage>,
      ),
    );
    const light = scene.children.find(
      (o): o is THREE.DirectionalLight => o instanceof THREE.DirectionalLight,
    )!;
    const floor = scene.children.find((o): o is THREE.Mesh => o instanceof THREE.Mesh)!;
    scene.updateMatrixWorld(true);
    light.shadow.camera.updateProjectionMatrix();
    light.shadow.updateMatrices(light);
    const receiver = new THREE.Box3().setFromObject(floor);
    for (const x of [receiver.min.x, receiver.max.x]) {
      for (const y of [
        TRAY_FLOOR_TOP_Y - 0.004,
        TRAY_GEOMETRY.ceilingY - TRAY_GEOMETRY.ceilingHalfHeight,
      ]) {
        for (const z of [receiver.min.z, receiver.max.z]) {
          const point = new THREE.Vector3(x, y, z).project(light.shadow.camera);
          expect(
            Math.max(Math.abs(point.x), Math.abs(point.y), Math.abs(point.z)),
          ).toBeLessThanOrEqual(1);
        }
      }
    }
  } finally {
    await actR3f(async () => root.unmount());
    await delay(550);
    if (previous === undefined) delete environment.IS_REACT_ACT_ENVIRONMENT;
    else environment.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});

test('a tipped open cup blocks light through its opaque outer wall', async () => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const canvas = createCanvas();
  const root = createTestRoot(canvas);
  const scene = new THREE.Scene();
  const { resources } = createResources();
  await root.configure({
    gl: createRenderer(canvas),
    scene,
    frameloop: 'never',
    size: { width: 340, height: 204, top: 0, left: 0 },
  });
  try {
    await actR3f(async () => root.render(<DiceCupShell resources={resources.cup} />));
    scene.updateMatrixWorld(true);
    const wall = scene.children[0]!.children.find(
      (o) =>
        o instanceof THREE.Mesh &&
        o.geometry instanceof THREE.CylinderGeometry &&
        o.geometry.parameters.openEnded &&
        o.castShadow,
    ) as THREE.Mesh;
    const material = wall.material as THREE.MeshStandardMaterial;
    // A ray entering the outside and leaving through the open mouth is occluded
    // by an opaque cup. It does not necessarily hit a back face or the base.
    const ray = new THREE.Raycaster(
      new THREE.Vector3(2, 0, 0),
      new THREE.Vector3(-1, 1, 0).normalize(),
    );
    const renderSide = material.side;
    material.side =
      material.shadowSide ?? (renderSide === THREE.FrontSide ? THREE.BackSide : THREE.FrontSide);
    const blocked = ray.intersectObject(wall).length > 0;
    material.side = renderSide;
    expect(blocked).toBe(true);
  } finally {
    await actR3f(async () => root.unmount());
    resources.dispose();
    await delay(550);
    if (previous === undefined) delete environment.IS_REACT_ACT_ENVIRONMENT;
    else environment.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});

test('projects the physics floor below the protected rack with side staging space', async () => {
  const canvas = createCanvas();
  const root = createTestRoot(canvas);
  const camera = new THREE.OrthographicCamera(-175, 175, 91, -91, 0.1, 20);
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await root.configure({
      gl: createRenderer(canvas),
      camera,
      frameloop: 'never',
      size: { width: 350, height: 182, top: 0, left: 0 },
    });
    await actR3f(async () =>
      root.render(
        <RollStage
          rollArea={ROLL_AREA}
          layout={{
            layerPadding: { extraX: 16, extraTop: 52, extraBottom: 8 },
            visualInset: { x: 0, y: 0 },
          }}
        >
          {null}
        </RollStage>,
      ),
    );
    camera.updateMatrixWorld();
    const top = new THREE.Vector3(-2.72, -0.76, 0).project(camera);
    const bottom = new THREE.Vector3(2.72, -0.76, 2.9781).project(camera);
    expect((1 - top.y) * 91).toBeGreaterThanOrEqual(51.99);
    expect((1 - bottom.y) * 91).toBeLessThanOrEqual(174.01);
    expect((top.x + 1) * 175).toBeGreaterThan(50);
    expect((bottom.x + 1) * 175).toBeLessThan(300);
  } finally {
    await actR3f(async () => root.unmount());
    await delay(550);
    if (previous === undefined) delete environment.IS_REACT_ACT_ENVIRONMENT;
    else environment.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});

test('mounts authoritative fallback dice without reporting replay completion', async () => {
  const { resources, sharedDisposeCounts } = createResources();
  const canvas = createCanvas();
  const scene = new THREE.Scene();
  const root = createTestRoot(canvas);
  const firstComplete = vi.fn(() => undefined);
  const replacementComplete = vi.fn(() => undefined);
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  let ownerDisposed = false;
  let unmounted = false;

  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await root.configure({
      frameloop: 'never',
      gl: createRenderer(canvas),
      scene,
      size: { width: 320, height: 180, left: 0, top: 0 },
    });
    await actR3f(async () => {
      root.render(
        <StrictMode>
          <DiceRollPlayback
            playback={FIRST_PLAYBACK}
            resources={resources}
            onComplete={firstComplete}
          />
        </StrictMode>,
      );
    });
    expect(firstComplete).not.toHaveBeenCalled();
    const fallback = scene.getObjectByName('roll-fallback-roll-fallback-a');
    expect(fallback).toBeInstanceOf(THREE.Group);
    const settled = fallback?.getObjectByName('dice-settled-scene');
    const dice = settled?.children.filter(
      (child): child is THREE.Mesh =>
        child instanceof THREE.Mesh && Object.is(child.material, resources.dieMaterials),
    );
    expect(dice).toHaveLength(2);
    expect(dice?.map((die) => die.name)).toEqual(['settled-die-1', 'settled-die-4']);
    expect(new THREE.Vector3(0, 0, 1).applyQuaternion(dice![0]!.quaternion).y).toBeCloseTo(1);
    expect(new THREE.Vector3(0, -1, 0).applyQuaternion(dice![1]!.quaternion).y).toBeCloseTo(1);
    expect(dice?.every((die) => die.geometry === resources.dieGeometry)).toBe(true);
    expect(dice?.every((die) => Object.is(die.material, resources.dieMaterials))).toBe(true);
    expect(scene.getObjectByProperty('type', 'AmbientLight')).not.toBeUndefined();

    await actR3f(async () => {
      root.render(
        <StrictMode>
          <DiceRollPlayback
            playback={FIRST_PLAYBACK}
            resources={resources}
            onComplete={replacementComplete}
          />
        </StrictMode>,
      );
    });
    expect(firstComplete).not.toHaveBeenCalled();
    expect(replacementComplete).not.toHaveBeenCalled();

    const nextPlayback: RollPlayback = { ...FIRST_PLAYBACK, rollId: 'roll-fallback-b' };
    await actR3f(async () => {
      root.render(
        <StrictMode>
          <DiceRollPlayback
            playback={nextPlayback}
            resources={resources}
            onComplete={replacementComplete}
          />
        </StrictMode>,
      );
    });
    expect(replacementComplete).not.toHaveBeenCalled();

    await actR3f(async () => root.unmount());
    unmounted = true;
    await delay(550);
    expect(sharedDisposeCounts).toEqual(sharedDisposeCounts.map(() => 0));

    resources.dispose();
    ownerDisposed = true;
    expect(sharedDisposeCounts).toEqual(sharedDisposeCounts.map(() => 1));
  } finally {
    if (!unmounted) {
      await actR3f(async () => root.unmount());
      await delay(550);
    }
    if (!ownerDisposed) resources.dispose();
    if (previousActEnvironment === undefined) delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    else actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

test('aligns rendered settled meshes with DOM hit centers without owning shared resources', async () => {
  const { resources, sharedDisposeCounts } = createResources();
  const canvas = createCanvas();
  const scene = new THREE.Scene();
  const root = createTestRoot(canvas);
  const viewport = DICE_CANVAS_VIEWPORT_SIZE;
  const camera = new THREE.OrthographicCamera(
    -viewport.width / 2,
    viewport.width / 2,
    viewport.height / 2,
    -viewport.height / 2,
    0.1,
    20,
  );
  const authoritativeDice = [
    { slot: 0, value: 1 },
    { slot: 1, value: 2 },
    { slot: 2, value: 3 },
    { slot: 3, value: 6 },
    { slot: 4, value: 5 },
  ] as const;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  let ownerDisposed = false;
  let unmounted = false;

  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await root.configure({
      frameloop: 'never',
      gl: createRenderer(canvas),
      scene,
      camera,
      size: { ...viewport, left: 0, top: 0 },
    });
    await actR3f(async () => {
      root.render(
        <StrictMode>
          <DiceSettledScene dice={authoritativeDice} resources={resources} />
        </StrictMode>,
      );
    });

    const settled = scene.getObjectByName('dice-settled-scene');
    const expected = layoutSettledDice(authoritativeDice, viewport);
    const dice = expected.map(({ slot }) => {
      const mesh = settled?.getObjectByName(`settled-die-${slot}`);
      expect(mesh).toBeInstanceOf(THREE.Mesh);
      return mesh as THREE.Mesh;
    });
    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld();
    dice.forEach((die, index) => {
      const center = die.getWorldPosition(new THREE.Vector3()).project(camera);
      expect(((center.x + 1) * viewport.width) / 2).toBeCloseTo(expected[index]!.centerPx.x, 8);
      expect(((1 - center.y) * viewport.height) / 2).toBeCloseTo(expected[index]!.centerPx.y, 8);
      const bounds = new THREE.Box3().setFromObject(die);
      const left = new THREE.Vector3(bounds.min.x, 0, die.position.z).project(camera);
      const right = new THREE.Vector3(bounds.max.x, 0, die.position.z).project(camera);
      expect(((right.x - left.x) * viewport.width) / 2).toBeGreaterThanOrEqual(44);
    });
    expect(dice.every((die) => die?.geometry === resources.dieGeometry)).toBe(true);
    expect(dice.every((die) => Object.is(die?.material, resources.dieMaterials))).toBe(true);

    await actR3f(async () => root.unmount());
    unmounted = true;
    await delay(550);
    expect(sharedDisposeCounts).toEqual(sharedDisposeCounts.map(() => 0));

    resources.dispose();
    ownerDisposed = true;
    expect(sharedDisposeCounts).toEqual(sharedDisposeCounts.map(() => 1));
  } finally {
    if (!unmounted) {
      await actR3f(async () => root.unmount());
      await delay(550);
    }
    if (!ownerDisposed) resources.dispose();
    if (previousActEnvironment === undefined) delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    else actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

test.each([
  { face: 1, normal: [0, 1, 0] },
  { face: 2, normal: [0, 0, 1] },
  { face: 3, normal: [1, 0, 0] },
  { face: 4, normal: [-1, 0, 0] },
  { face: 5, normal: [0, 0, -1] },
  { face: 6, normal: [0, -1, 0] },
] as const)(
  'settles face $face to the same icon orientation after reveal, release and remount',
  async ({ face, normal }) => {
    const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previous = environment.IS_REACT_ACT_ENVIRONMENT;
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    const { resources } = createResources();
    const canvas = createCanvas();
    const root = createTestRoot(canvas);
    const scene = new THREE.Scene();
    const dice = [{ slot: 0, value: face }] as const;
    let advanceFrame: ((timestamp: number) => void) | undefined;
    let tick = 0;
    try {
      await root.configure({
        gl: createRenderer(canvas),
        scene,
        frameloop: 'never',
        onCreated: ({ advance }) => {
          advanceFrame = advance;
        },
        size: { width: 350, height: 182, top: 0, left: 0 },
      });
      for (const yaw of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
        const up = new THREE.Vector3(0, 1, 0);
        const physical = new THREE.Quaternion()
          .setFromAxisAngle(up, yaw)
          .multiply(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(...normal), up))
          .premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.18));
        const timeline: RollTimeline = {
          rollId: 'orientation-test',
          seed: 'orientation-test',
          durationMs: 100,
          rollArea: ROLL_AREA,
          cup: {
            style: 'classic',
            shakeAmplitude: 0,
            shakeFrequency: 0,
            pourAtMs: 0,
            releaseAtMs: 0,
            exitAtMs: 100,
            innerWidth: DEFAULT_CUP_GEOMETRY.innerRadius * 2,
            innerDepth: DEFAULT_CUP_GEOMETRY.innerRadius * 2,
            innerHeight: DEFAULT_CUP_GEOMETRY.innerHeight,
            frames: [],
          },
          dice: [
            { slot: 0, value: face, frames: [{ t: 100, p: [0, 0, 0], q: physical.toArray() }] },
          ],
        };
        await actR3f(async () =>
          root.render(
            <DiceSettledScene
              dice={dice}
              resources={resources}
              transition={{
                timeline,
                durationMs: 100,
                layout: {
                  layerPadding: { extraX: 4, extraTop: 72, extraBottom: 4 },
                  visualInset: { x: 0, y: 0 },
                },
              }}
            />,
          ),
        );
        const mesh = scene.getObjectByName('settled-die-0') as THREE.Mesh;
        expect(Math.abs(mesh.quaternion.dot(physical))).toBeCloseTo(1, 10);
        await actR3f(async () => {
          advanceFrame?.(++tick);
        });
        const revealed = mesh.quaternion.clone();
        expect(new THREE.Vector3(...normal).applyQuaternion(revealed).y).toBeCloseTo(1, 10);
        // Texture diagonals on +Z (2) and +X (3) must both run upper-left to lower-right.
        if (face === 2 || face === 3) {
          const diagonal = (
            face === 2 ? new THREE.Vector3(1, -1, 0) : new THREE.Vector3(0, -1, -1)
          ).applyQuaternion(revealed);
          expect(diagonal.x * diagonal.z).toBeGreaterThan(0);
        }
        if (face === 6) {
          expect(new THREE.Vector3(0, 0, 1).applyQuaternion(revealed).x).toBeCloseTo(0, 10);
        }
        await actR3f(async () =>
          root.render(<DiceSettledScene dice={dice} resources={resources} />),
        );
        expect(Math.abs(mesh.quaternion.dot(revealed))).toBeCloseTo(1, 10);
        await actR3f(async () => root.render(<DiceSettledScene dice={[]} resources={resources} />));
        await actR3f(async () =>
          root.render(<DiceSettledScene dice={dice} resources={resources} />),
        );
        const released = scene.getObjectByName('settled-die-0') as THREE.Mesh;
        expect(Math.abs(released.quaternion.dot(revealed))).toBeCloseTo(1, 10);
        await actR3f(async () => root.render(null));
        await actR3f(async () =>
          root.render(<DiceSettledScene dice={dice} resources={resources} />),
        );
        const restored = scene.getObjectByName('settled-die-0') as THREE.Mesh;
        expect(Math.abs(restored.quaternion.dot(revealed))).toBeCloseTo(1, 10);
        await actR3f(async () => root.render(null));
      }
    } finally {
      await actR3f(async () => root.unmount());
      await delay(550);
      resources.dispose();
      if (previous === undefined) delete environment.IS_REACT_ACT_ENVIRONMENT;
      else environment.IS_REACT_ACT_ENVIRONMENT = previous;
    }
  },
);

test('reuses prepared resources across verified replays without disposing sibling dice', async () => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const { resources, sharedDisposeCounts } = createResources();
  const canvas = createCanvas();
  const root = createTestRoot(canvas);
  const scene = new THREE.Scene();
  let now = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const complete = vi.fn((_rollId: string) => undefined);
  let advanceFrame: ((timestamp: number) => void) | undefined;
  const playback = (rollId: string, slots: readonly (0 | 4)[]): RollPlayback => ({
    status: 'verified',
    rollId,
    timeline: {
      rollId,
      seed: 'resource-test',
      durationMs: 100,
      rollArea: ROLL_AREA,
      cup: {
        style: 'classic',
        shakeAmplitude: 0,
        shakeFrequency: 0,
        pourAtMs: 0,
        releaseAtMs: 0,
        exitAtMs: 100,
        innerWidth: DEFAULT_CUP_GEOMETRY.innerRadius * 2,
        innerDepth: DEFAULT_CUP_GEOMETRY.innerRadius * 2,
        innerHeight: DEFAULT_CUP_GEOMETRY.innerHeight,
        frames: [],
      },
      dice: slots.map((slot) => ({
        slot,
        value: 1,
        frames: [{ t: 0, p: [slot, 0, 0], q: [0, 0, 0, 1] }],
      })),
    },
  });
  try {
    await root.configure({
      gl: createRenderer(canvas),
      scene,
      frameloop: 'never',
      onCreated: ({ advance }) => {
        advanceFrame = advance;
      },
      size: { width: 340, height: 204, top: 0, left: 0 },
    });
    await actR3f(async () =>
      root.render(
        <StrictMode>
          <DiceRollWarmupScene resources={resources} visible={false} />
        </StrictMode>,
      ),
    );
    const warmup = scene.getObjectByName('dice-roll-warmup')!;
    expect(warmup.visible).toBe(false);
    const warmedDice: THREE.Mesh[] = [];
    warmup.traverse((object) => {
      if (object instanceof THREE.Mesh && object.geometry === resources.dieGeometry)
        warmedDice.push(object);
    });
    expect(warmedDice).toHaveLength(2);
    expect(warmedDice.every((die) => Object.is(die.material, resources.dieMaterials))).toBe(true);
    const cupMeshes = () => {
      const meshes: THREE.Mesh[] = [];
      const geometry = Object.values(resources.cup.geometry);
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh && geometry.includes(object.geometry)) meshes.push(object);
      });
      expect(meshes).toHaveLength(geometry.length);
      const floor = meshes.find((mesh) => mesh.geometry === resources.cup.geometry.floor)!;
      expect((floor.material as THREE.MeshStandardMaterial).map).toBe(resources.cup.texture);
      return meshes;
    };
    cupMeshes();
    for (const [rollId, slots] of [
      ['first', [0, 4]],
      ['second', [4]],
    ] as const) {
      await actR3f(async () =>
        root.render(
          <StrictMode>
            <DiceRollPlayback
              playback={playback(rollId, slots)}
              resources={resources}
              onComplete={complete}
            />
          </StrictMode>,
        ),
      );
      const dice: THREE.Mesh[] = [];
      expect(cupMeshes().every((mesh) => (mesh.material as THREE.Material).opacity === 1)).toBe(
        true,
      );
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh && object.geometry === resources.dieGeometry)
          dice.push(object);
      });
      const completedBefore = complete.mock.calls.length;
      now += 50;
      advanceFrame?.(now / 1000);
      expect(complete).toHaveBeenCalledTimes(completedBefore);
      // A new roll starts a fresh clock; rerendering this roll must keep its elapsed time.
      await actR3f(async () =>
        root.render(
          <StrictMode>
            <DiceRollPlayback
              playback={playback(rollId, slots)}
              resources={resources}
              onComplete={complete}
            />
          </StrictMode>,
        ),
      );
      now += 51;
      advanceFrame?.(now / 1000);
      advanceFrame?.(now / 1000);
      expect(complete).toHaveBeenLastCalledWith(rollId);
      expect(dice).toHaveLength(slots.length);
      expect(new Set(dice).size).toBe(slots.length);
      expect(dice.every((die) => Object.is(die.material, resources.dieMaterials))).toBe(true);
      expect(sharedDisposeCounts).toEqual(sharedDisposeCounts.map(() => 0));
    }
    expect(complete).toHaveBeenCalledTimes(2);
    await actR3f(async () =>
      root.render(
        <DiceRollPlayback
          playback={playback('cancelled', [0])}
          resources={resources}
          onComplete={complete}
        />,
      ),
    );
    await actR3f(async () => root.render(null));
    now += 101;
    advanceFrame?.(now / 1000);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(sharedDisposeCounts).toEqual(sharedDisposeCounts.map(() => 0));
    resources.dispose();
    resources.dispose();
    expect(sharedDisposeCounts).toEqual(sharedDisposeCounts.map(() => 1));
  } finally {
    await actR3f(async () => root.unmount());
    await delay(550);
    resources.dispose();
    clock.mockRestore();
    if (previous === undefined) delete environment.IS_REACT_ACT_ENVIRONMENT;
    else environment.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});

function createResources(): {
  readonly resources: ProceduralDiceResources;
  readonly sharedDisposeCounts: number[];
} {
  const dieGeometry = new THREE.BoxGeometry(1, 1, 1);
  const dieMaterials = Array.from({ length: 6 }, () => new THREE.MeshStandardMaterial());
  const cup = createCupResources(
    (width, height) =>
      ({
        width,
        height,
        getContext: () => ({ fillStyle: '', fillRect() {} }),
      }) as unknown as HTMLCanvasElement,
  );
  const sharedResources = [
    dieGeometry,
    ...dieMaterials,
    ...Object.values(cup.geometry),
    cup.texture,
  ];
  const sharedDisposeCounts = sharedResources.map(() => 0);
  sharedResources.forEach((resource, index) => {
    resource.addEventListener('dispose', () => {
      sharedDisposeCounts[index] = sharedDisposeCounts[index]! + 1;
    });
  });
  let disposed = false;

  return {
    resources: {
      cup,
      dieGeometry,
      dieMaterials,
      dispose() {
        if (disposed) return;
        disposed = true;
        sharedResources.forEach((resource) => resource.dispose());
      },
    },
    sharedDisposeCounts,
  };
}

function createCanvas(): HTMLCanvasElement {
  return {
    addEventListener: () => undefined,
    clientHeight: 180,
    clientWidth: 320,
    getBoundingClientRect: () => ({
      bottom: 180,
      height: 180,
      left: 0,
      right: 320,
      top: 0,
      width: 320,
    }),
    height: 180,
    removeEventListener: () => undefined,
    style: {},
    width: 320,
  } as unknown as HTMLCanvasElement;
}

function createTestRoot(canvas: HTMLCanvasElement): ReturnType<typeof createRoot> {
  const originalWarn = console.warn;
  const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    if (
      args[0] !== 'THREE.Clock: This module has been deprecated. Please use THREE.Timer instead.'
    ) {
      originalWarn(...args);
    }
  });
  try {
    return createRoot(canvas);
  } finally {
    warn.mockRestore();
  }
}

function createRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  const listeners = new Map<string, Set<() => void>>();
  return {
    dispose: () => undefined,
    domElement: canvas,
    forceContextLoss: () => undefined,
    outputColorSpace: THREE.SRGBColorSpace,
    render: () => undefined,
    renderLists: { dispose: () => undefined },
    setPixelRatio: () => undefined,
    setSize: () => undefined,
    shadowMap: { enabled: false, type: THREE.PCFSoftShadowMap },
    toneMapping: THREE.NoToneMapping,
    xr: {
      addEventListener(type: string, listener: () => void) {
        const typeListeners = listeners.get(type) ?? new Set();
        typeListeners.add(listener);
        listeners.set(type, typeListeners);
      },
      enabled: false,
      getSession: () => null,
      isPresenting: false,
      removeEventListener(type: string, listener: () => void) {
        listeners.get(type)?.delete(listener);
      },
      setAnimationLoop: () => undefined,
    },
  } as unknown as THREE.WebGLRenderer;
}
