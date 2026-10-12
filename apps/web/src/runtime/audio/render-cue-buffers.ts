import {
  type CueRecipe,
  type CueRecipeId,
  cueRecipes,
  type LevelledOptions,
} from '@/runtime/audio/cue-recipes';

export type { CueRecipeId } from '@/runtime/audio/cue-recipes';

const CUE_SAMPLE_RATE_HZ = 44_100;

// Explicit offline contexts avoid Tone.Offline's global context swap and unused 3D Listener.
export async function renderCueBuffers(
  audioContext: AudioContext,
): Promise<Map<CueRecipeId, AudioBuffer>> {
  await import('tone/build/esm/core/context/Destination');
  const [{ OfflineContext }, { Gain }, { Filter }, { FMSynth }, { Synth }] = await Promise.all([
    import('tone/build/esm/core/context/OfflineContext'),
    import('tone/build/esm/core/context/Gain'),
    import('tone/build/esm/component/filter/Filter'),
    import('tone/build/esm/instrument/FMSynth'),
    import('tone/build/esm/instrument/Synth'),
  ]);
  const buffers = new Map<CueRecipeId, AudioBuffer>();
  for (const key of Object.keys(cueRecipes) as CueRecipeId[]) {
    const recipe: CueRecipe = cueRecipes[key];
    const context = new OfflineContext(1, recipe.duration, CUE_SAMPLE_RATE_HZ);
    const nodes: { dispose(): unknown }[] = [];
    const own = <T extends { dispose(): unknown }>(node: T): T => {
      nodes.push(node);
      return node;
    };
    try {
      const bus =
        recipe.profile === 'oscillator-levelled' && recipe.highpass
          ? own(
              new Filter({ context, frequency: recipe.highpass, type: 'highpass', rolloff: -12 }),
            ).toDestination()
          : own(
              new Gain({
                context,
                gain: 10 ** ((recipe.profile === 'fm-patch' ? recipe.trimDb : 0) / 20),
              }),
            ).toDestination();
      const playVoice = (
        voice: InstanceType<typeof Synth> | InstanceType<typeof FMSynth>,
        event: CueRecipe['events'][number],
        gate: number,
      ) => {
        voice.connect(bus);
        voice.triggerAttackRelease(
          'note' in event ? event.note : event.frequency,
          gate,
          event.at + 0.004,
          'velocity' in event ? event.velocity : 0.8,
        );
      };
      if (recipe.profile === 'fm-patch') {
        for (const event of recipe.events) {
          playVoice(
            own(new FMSynth({ ...event.patch, context })),
            event,
            event.patch.envelope.attack + event.patch.envelope.decay + 0.005,
          );
        }
      } else if (recipe.profile === 'fm-levelled') {
        for (const event of recipe.events) {
          const voiceOptions = event.options;
          playVoice(
            own(
              new FMSynth({
                context,
                volume: 20 * Math.log10(voiceOptions.amp ?? 0.5),
                harmonicity: 2,
                modulationIndex: voiceOptions.modulationIndex,
                oscillator: { type: 'sine' },
                modulation: { type: 'sine' },
                envelope: levelledEnvelope(voiceOptions),
                modulationEnvelope: {
                  attack: 0.001,
                  decay: 0.018,
                  sustain: 0,
                  release: 0.008,
                },
              }),
            ),
            event,
            event.gate,
          );
        }
      } else {
        for (const event of recipe.events) {
          const voiceOptions = event.options;
          playVoice(
            own(
              new Synth({
                context,
                volume: 20 * Math.log10(voiceOptions.amp ?? 0.5),
                oscillator: { type: voiceOptions.waveform ?? 'sine' },
                envelope: levelledEnvelope(voiceOptions),
              }),
            ),
            event,
            event.gate,
          );
        }
      }
      const rendered = (await context.render()).get()!;
      buffers.set(key, masterBuffer(audioContext, rendered.getChannelData(0), recipe));
    } finally {
      nodes.reverse().forEach((node) => node.dispose());
      context.dispose();
    }
  }
  return buffers;
}

function levelledEnvelope(options: LevelledOptions) {
  return {
    attack: options.attack ?? 0.002,
    decay: options.decay ?? 0.08,
    sustain: options.sustain ?? 0.08,
    release: options.release ?? 0.09,
  };
}

function masterBuffer(context: AudioContext, raw: Float32Array, recipe: CueRecipe): AudioBuffer {
  const sampleRateHz = CUE_SAMPLE_RATE_HZ,
    rmsWindowSamples = Math.round(sampleRateHz * 0.08);
  let peak = 0,
    windowEnergy = 0,
    maxWindowEnergy = 0;
  for (let i = 0; i < raw.length; i++) {
    const sample = raw[i]!;
    peak = Math.max(peak, Math.abs(sample));
    windowEnergy += sample * sample;
    if (i >= rmsWindowSamples) windowEnergy -= raw[i - rmsWindowSamples]! ** 2;
    maxWindowEnergy = Math.max(maxWindowEnergy, windowEnergy);
  }
  if (peak === 0) throw new Error('Selected cue rendered silence');
  const isFmLevelled = recipe.profile === 'fm-levelled',
    isOscillatorLevelled = recipe.profile === 'oscillator-levelled';
  const scale =
    isFmLevelled || isOscillatorLevelled
      ? Math.min(
          (isFmLevelled ? recipe.targetRms : recipe.baselineRms80) /
            Math.sqrt(maxWindowEnergy / rmsWindowSamples),
          (isFmLevelled ? 0.72 : 0.76) / peak,
        )
      : 1;
  let last = raw.length - 1;
  while (
    last > 0 &&
    Math.abs(raw[last]!) < peak * (isFmLevelled ? 0.001 : isOscillatorLevelled ? 0.0015 : 0.00001)
  )
    last--;
  const length = Math.min(
    raw.length,
    Math.max(
      Math.round(sampleRateHz * (recipe.profile === 'oscillator-levelled' ? recipe.minSeconds : 0)),
      last + Math.round(sampleRateHz * (isOscillatorLevelled ? 0.035 : 0.025)),
    ),
  );
  const buffer = context.createBuffer(1, length, sampleRateHz),
    output = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    const fade =
      isFmLevelled || isOscillatorLevelled
        ? Math.min(
            1,
            i / (sampleRateHz * 0.0007),
            (length - 1 - i) / (sampleRateHz * (isFmLevelled ? 0.008 : 0.012)),
          )
        : 1;
    const shaped = raw[i]! * scale * fade;
    output[i] = isFmLevelled
      ? shaped
      : Math.round(
          Math.round((isOscillatorLevelled ? Math.fround(shaped) : shaped) * 32767) *
            recipe.finalGain,
        ) / 32768;
  }
  return buffer;
}
