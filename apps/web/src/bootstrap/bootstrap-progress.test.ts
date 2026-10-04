import { expect, test } from 'vitest';

import { type BootstrapProgress, createBootstrapProgress } from '@/bootstrap/bootstrap-progress';

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
