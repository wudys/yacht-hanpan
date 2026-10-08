import { expect, test, vi } from 'vitest';

import { createCueRuntime, PRODUCT_CUE } from '@/runtime/audio/cue-runtime';
import type { CueRecipeId } from '@/runtime/audio/render-cue-buffers';
function harness() {
  const sources: {
    buffer: AudioBuffer | null;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
  }[] = [];
  const context = {
    currentTime: 4,
    destination: {},
    createGain: () => ({ gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() }),
    createBufferSource: () => {
      const s = {
        buffer: null,
        start: vi.fn(),
        stop: vi.fn(),
        disconnect: vi.fn(),
        connect: vi.fn(),
      };
      sources.push(s);
      return s;
    },
  } as unknown as AudioContext;
  const buffer = {} as AudioBuffer;
  const render = vi.fn(
    async () =>
      new Map<CueRecipeId, AudioBuffer>([
        ['click', buffer],
        ['yacht', buffer],
        ['warning', buffer],
      ]),
  );
  const wrapper = { dispose: vi.fn() },
    setContext = vi.fn();
  const loadToneGlobal = vi.fn(async () => ({ setContext, getContext: () => wrapper }));
  return { sources, context, buffer, render, wrapper, loadToneGlobal, setContext };
}
test('prepares once on the shared context, selection and roll alias click, one source per action', async () => {
  const h = harness(),
    runtime = createCueRuntime(h);
  await Promise.all([runtime.prepare(h.context), runtime.prepare(h.context)]);
  expect(h.render).toHaveBeenCalledTimes(1);
  expect(h.setContext).toHaveBeenCalledWith(h.context);
  runtime.play(PRODUCT_CUE.CLICK);
  runtime.play(PRODUCT_CUE.ROLL_CLICK);
  runtime.play(PRODUCT_CUE.SELECT);
  expect(h.sources).toHaveLength(3);
  expect(h.sources[0]?.buffer).toBe(h.sources[1]?.buffer);
  expect(h.sources[2]?.buffer).toBe(h.sources[0]?.buffer);
  for (const source of h.sources) expect(source.start).toHaveBeenCalledTimes(1);
  await runtime.dispose();
  expect(h.sources[0]?.stop).toHaveBeenCalledTimes(1);
  expect(h.wrapper.dispose).not.toHaveBeenCalled();
  runtime.disposeContext();
  expect(h.wrapper.dispose).toHaveBeenCalledTimes(1);
});
test('OFF cancels every pending voice immediately and ON never replays it', async () => {
  const h = harness(),
    runtime = createCueRuntime(h);
  await runtime.prepare(h.context);
  runtime.play(PRODUCT_CUE.ACHIEVEMENT_YACHT);
  runtime.setEnabled(false);
  expect(h.sources[0]?.stop).toHaveBeenCalledTimes(1);
  runtime.play(PRODUCT_CUE.CLICK);
  runtime.setEnabled(true);
  expect(h.sources).toHaveLength(1);
  runtime.play(PRODUCT_CUE.CLICK);
  expect(h.sources).toHaveLength(2);
});
test('warning cancellation leaves other cues alone', async () => {
  const h = harness(),
    runtime = createCueRuntime(h);
  await runtime.prepare(h.context);
  runtime.play(PRODUCT_CUE.ACHIEVEMENT_YACHT);
  runtime.play(PRODUCT_CUE.TIMER_WARNING);
  runtime.stop(PRODUCT_CUE.TIMER_WARNING);
  expect(h.sources[0]?.stop).not.toHaveBeenCalled();
  expect(h.sources[1]?.stop).toHaveBeenCalledTimes(1);
});
test('failed preparation retries without rewrapping context and rejects a different context', async () => {
  const h = harness();
  h.render.mockRejectedValueOnce(new Error('render failed'));
  const runtime = createCueRuntime(h);
  await expect(runtime.prepare(h.context)).rejects.toThrow('render failed');
  await runtime.prepare(h.context);
  expect(h.render).toHaveBeenCalledTimes(2);
  expect(h.setContext).toHaveBeenCalledTimes(1);
  await expect(runtime.prepare({} as AudioContext)).rejects.toThrow('another AudioContext');
  await runtime.dispose();
  runtime.play(PRODUCT_CUE.CLICK);
  expect(h.sources).toHaveLength(0);
});

test('dispose waits for in-flight rendering and never publishes its late buffers', async () => {
  const h = harness();
  let complete!: (value: Map<CueRecipeId, AudioBuffer>) => void;
  h.render.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const runtime = createCueRuntime(h),
    preparation = runtime.prepare(h.context);
  await vi.waitFor(() => expect(h.render).toHaveBeenCalledOnce());
  const disposing = runtime.dispose();
  complete(new Map([['click', h.buffer]]));
  await Promise.all([preparation, disposing]);
  runtime.play(PRODUCT_CUE.CLICK);
  expect(h.sources).toHaveLength(0);
});
