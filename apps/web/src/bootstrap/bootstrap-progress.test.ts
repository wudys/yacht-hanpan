import { expect, test } from 'vitest';

import { type BootstrapProgress, createBootstrapProgress } from '@/bootstrap/bootstrap-progress';

test.each([
  ['wasm', 1],
  ['assets', 25],
  ['decode', 1],
] as const)('publishes %s progress only when the normalized count changes', (phase, count) => {
  const snapshots: BootstrapProgress[] = [];
  const report = createBootstrapProgress({
    visualBytes: 100,
    visualCount: 2,
    lobbyAudioBytes: 0,
    onProgress: (value) => snapshots.push(value),
  });
  expect(snapshots).toEqual([{ phase: 'modules', progress: 0 }]);

  report(phase, count);
  expect(snapshots).toHaveLength(2);
  const changed = snapshots.at(-1);
  report(phase, count);
  report(phase, count);
  report(phase, count);

  expect(snapshots).toHaveLength(2);
  expect(snapshots.at(-1)).toBe(changed);
});

test('compares clamped counts while preserving a count reset', () => {
  const snapshots: BootstrapProgress[] = [];
  const report = createBootstrapProgress({
    visualBytes: 100,
    visualCount: 2,
    lobbyAudioBytes: 0,
    onProgress: (value) => snapshots.push(value),
  });
  report('assets', 0);
  report('assets', -1);
  report('audio', 100);
  expect(snapshots).toHaveLength(1);

  report('assets', 100);
  report('assets', 101);
  expect(snapshots).toHaveLength(2);

  report('assets', -1);
  expect(snapshots).toHaveLength(3);
  expect(snapshots.at(-1)).toEqual({ phase: 'modules', progress: 0 });
});

test('keeps decode and GPU gates when required byte totals are zero', () => {
  const snapshots: BootstrapProgress[] = [];
  const report = createBootstrapProgress({
    visualBytes: 0,
    visualCount: 0,
    lobbyAudioBytes: 0,
    onProgress: (value) => snapshots.push(value),
  });
  report('assets', 100);
  report('audio', 100);
  expect(snapshots).toEqual([{ phase: 'modules', progress: 0.2 }]);

  report('modules', 1);
  report('wasm', 1);
  report('decode', 1);
  report('gpu', 1);
  report('gpu', 2);
  expect(snapshots).toEqual([
    { phase: 'modules', progress: 0.2 },
    { phase: 'wasm', progress: 0.4 },
    { phase: 'decode', progress: 0.6 },
    { phase: 'gpu', progress: 0.8 },
    { phase: 'gpu', progress: 1 },
  ]);
});

test('starts a retry with a fresh initial report and count state', () => {
  const snapshots: BootstrapProgress[] = [];
  const options = {
    visualBytes: 100,
    visualCount: 2,
    lobbyAudioBytes: 0,
    onProgress: (value: BootstrapProgress) => snapshots.push(value),
  };
  const first = createBootstrapProgress(options);
  first('wasm', 1);
  const retry = createBootstrapProgress(options);
  expect(snapshots.at(-1)).toEqual({ phase: 'modules', progress: 0 });
  retry('wasm', 1);
  expect(snapshots).toEqual([
    { phase: 'modules', progress: 0 },
    { phase: 'modules', progress: 0.2 },
    { phase: 'modules', progress: 0 },
    { phase: 'modules', progress: 0.2 },
  ]);
});

test('counts required bytes and real readiness gates without completing before GPU and audio', () => {
  const snapshots: BootstrapProgress[] = [];
  const report = createBootstrapProgress({
    visualBytes: 100,
    visualCount: 2,
    lobbyAudioBytes: 300,
    onProgress: (value) => snapshots.push(value),
  });
  expect(snapshots.at(-1)?.phase).toBe('modules');
  report('modules', 1);
  expect(snapshots.at(-1)?.phase).toBe('wasm');
  report('wasm', 1);
  expect(snapshots.at(-1)?.phase).toBe('assets');
  const beforeBytes = snapshots.at(-1)!.progress;
  report('assets', 25);
  expect(snapshots.at(-1)?.progress).toBeGreaterThan(beforeBytes);
  expect(snapshots.at(-1)?.phase).toBe('assets');
  report('assets', 100);
  expect(snapshots.at(-1)?.phase).toBe('decode');
  report('decode', 3);
  expect(snapshots.at(-1)?.progress).toBeLessThan(1);
  expect(snapshots.at(-1)?.phase).toBe('audio');
  report('gpu', 1);
  expect(snapshots.at(-1)?.progress).toBeLessThan(1);
  expect(snapshots.at(-1)?.phase).toBe('audio');
  const beforeAudioBytes = snapshots.at(-1)!.progress;
  report('audio', 150);
  expect(snapshots.at(-1)?.progress).toBeGreaterThan(beforeAudioBytes);
  expect(snapshots.at(-1)?.progress).toBeLessThan(1);
  expect(snapshots.at(-1)?.phase).toBe('audio');
  report('audio', 300);
  expect(snapshots.at(-1)?.progress).toBe(1);
  expect(snapshots.at(-1)?.phase).toBe('gpu');
  expect(snapshots.slice(0, -1).every(({ progress }) => progress < 1)).toBe(true);
  for (let index = 1; index < snapshots.length; index += 1) {
    expect(snapshots[index]!.progress).toBeGreaterThan(snapshots[index - 1]!.progress);
  }
});

test('excludes background audio bytes and keeps GPU compilation in the completion barrier', () => {
  const snapshots: BootstrapProgress[] = [];
  const report = createBootstrapProgress({
    visualBytes: 100,
    visualCount: 2,
    lobbyAudioBytes: 0,
    onProgress: (value) => snapshots.push(value),
  });
  report('modules', 1);
  report('wasm', 1);
  report('assets', 100);
  report('decode', 3);
  expect(snapshots.at(-1)?.phase).toBe('gpu');
  expect(snapshots.at(-1)?.progress).toBeLessThan(1);
  report('gpu', 1);
  expect(snapshots.at(-1)?.progress).toBe(1);
});
