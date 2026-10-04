import { expect, test, vi } from 'vitest';

import { cueRecipes as recipes } from '@/runtime/audio/cue-recipes';
import { renderCueBuffers } from '@/runtime/audio/render-cue-buffers';

const { Filter, Voice } = vi.hoisted(() => {
  class Voice {
    public connect() {
      return this;
    }
    public toDestination() {
      return this;
    }
    public triggerAttackRelease() {}
    public dispose() {}
  }
  return {
    Voice,
    Filter: vi.fn(function () {
      return new Voice();
    }),
  };
});
vi.mock('tone/build/esm/core/context/Destination', () => ({}));
vi.mock('tone/build/esm/core/context/Gain', () => ({ Gain: Voice }));
vi.mock('tone/build/esm/component/filter/Filter', () => ({ Filter }));
vi.mock('tone/build/esm/instrument/FMSynth', () => ({ FMSynth: Voice }));
vi.mock('tone/build/esm/instrument/Synth', () => ({ Synth: Voice }));
vi.mock('tone/build/esm/core/context/OfflineContext', () => ({
  OfflineContext: class {
    public async render() {
      return { get: () => ({ getChannelData: () => new Float32Array(4410).fill(0.1) }) };
    }
    public dispose() {}
  },
}));

test('a recipe highpass cutoff reaches the audio filter instead of a fixed frequency', async () => {
  const original = recipes.warning.highpass;
  recipes.warning.highpass = 3500;
  const context = {
    createBuffer: (_channels: number, length: number) => {
      const samples = new Float32Array(length);
      return { getChannelData: () => samples };
    },
  } as unknown as AudioContext;
  try {
    await renderCueBuffers(context);
    expect(Filter).toHaveBeenCalledWith(
      expect.objectContaining({ frequency: 3500, type: 'highpass' }),
    );
  } finally {
    Object.assign(recipes.warning, { highpass: original });
  }
});
