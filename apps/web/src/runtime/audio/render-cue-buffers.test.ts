import { expect, expectTypeOf, test, vi } from 'vitest';

import { type CueRecipe, cueRecipes as recipes } from '@/runtime/audio/cue-recipes';
import { renderCueBuffers } from '@/runtime/audio/render-cue-buffers';

const { Filter, FMSynth, Synth, Voice } = vi.hoisted(() => {
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
    FMSynth: vi.fn(function (_options: unknown) {
      return new Voice();
    }),
    Synth: vi.fn(function (_options: unknown) {
      return new Voice();
    }),
  };
});
vi.mock('tone/build/esm/core/context/Destination', () => ({}));
vi.mock('tone/build/esm/core/context/Gain', () => ({ Gain: Voice }));
vi.mock('tone/build/esm/component/filter/Filter', () => ({ Filter }));
vi.mock('tone/build/esm/instrument/FMSynth', () => ({ FMSynth }));
vi.mock('tone/build/esm/instrument/Synth', () => ({ Synth }));
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

test.each(['sine', 'triangle'] as const)(
  'levelled voices use oscillator waveform %s and explicit FM modulation independently',
  async (waveform) => {
    const oscillatorOptions = recipes.warning.events[0]!.options;
    const fmOptions = recipes.combo.events[0]!.options;
    const originalOscillatorOptions = { ...oscillatorOptions };
    const originalFmOptions = { ...fmOptions };
    Object.assign(oscillatorOptions, { waveform });
    Object.assign(fmOptions, { modulationIndex: 0.37 });
    Synth.mockClear();
    FMSynth.mockClear();
    const context = {
      createBuffer: (_channels: number, length: number) => {
        const samples = new Float32Array(length);
        return { getChannelData: () => samples };
      },
    } as unknown as AudioContext;
    try {
      await renderCueBuffers(context);
      expect(Synth.mock.calls.map(([options]) => options)).toEqual([
        expect.objectContaining({ oscillator: { type: waveform } }),
        expect.objectContaining({ oscillator: { type: 'sine' } }),
      ]);
      expect(FMSynth).toHaveBeenCalledWith(
        expect.objectContaining({
          modulationIndex: 0.37,
          harmonicity: 2,
          oscillator: { type: 'sine' },
          modulation: { type: 'sine' },
        }),
      );
      expect(FMSynth).toHaveBeenCalledWith(expect.objectContaining({ modulationIndex: 0.22 }));
      expect(FMSynth).toHaveBeenCalledWith(expect.objectContaining({ modulationIndex: 0.8 }));
    } finally {
      recipes.warning.events[0]!.options = originalOscillatorOptions;
      recipes.combo.events[0]!.options = originalFmOptions;
    }
  },
);

test('a levelled profile cannot accept the other synthesis options', () => {
  type OscillatorEvent = Extract<CueRecipe, { profile: 'oscillator-levelled' }>['events'][number];
  type FmEvent = Extract<CueRecipe, { profile: 'fm-levelled' }>['events'][number];
  expectTypeOf<FmEvent>().not.toExtend<OscillatorEvent>();
  expectTypeOf<OscillatorEvent>().not.toExtend<FmEvent>();
  expectTypeOf<{
    at: number;
    frequency: number;
    gate: number;
    options: { waveform: 'triangle'; modulationIndex: number };
  }>().not.toExtend<FmEvent>();
});
