import { type CueRecipeId, renderCueBuffers } from '@/runtime/audio/render-cue-buffers';

export const PRODUCT_CUE = {
  CLICK: 'ui.click',
  SELECT: 'ui.select',
  HOLD: 'dice.hold',
  RELEASE: 'dice.release',
  SCORE: 'score.confirmed',
  SUCCESS: 'ui.success',
  ROLL_CLICK: 'roll.click',
  TIMER_WARNING: 'timer.warning',
  ACHIEVEMENT_OTHER: 'achievement.other',
  ACHIEVEMENT_YACHT: 'achievement.yacht',
} as const;
export type ProductCue = (typeof PRODUCT_CUE)[keyof typeof PRODUCT_CUE];
const keys: Record<ProductCue, CueRecipeId> = {
  'ui.click': 'click',
  'roll.click': 'click',
  'ui.select': 'click',
  'dice.hold': 'hold',
  'dice.release': 'release',
  'score.confirmed': 'score',
  'ui.success': 'success',
  'timer.warning': 'warning',
  'achievement.other': 'combo',
  'achievement.yacht': 'yacht',
};

export function createProductCueRuntime(
  options: {
    enabled?: boolean;
    render?: typeof renderCueBuffers;
    loadToneGlobal?: () => Promise<{
      setContext(context: AudioContext): void;
      getContext(): { dispose(): unknown };
    }>;
  } = {},
) {
  let toneContext: { dispose(): unknown } | null = null;
  let enabled = options.enabled ?? true,
    disposed = false;
  let context: AudioContext | null = null,
    output: GainNode | null = null;
  let setup: Promise<void> | null = null;
  let preparation: Promise<void> | null = null;
  let buffers = new Map<CueRecipeId, AudioBuffer>();
  const active = new Map<AudioBufferSourceNode, CueRecipeId>();
  function stop(cue?: ProductCue) {
    for (const [source, key] of active) {
      if (cue && keys[cue] !== key) continue;
      source.stop();
      source.disconnect();
      active.delete(source);
    }
  }
  return {
    prepare(next: AudioContext): Promise<void> {
      if (disposed) return Promise.reject(new Error('Product cues are disposed'));
      if (context && context !== next)
        return Promise.reject(new Error('Product cues already use another AudioContext'));
      context = next;
      preparation ??= (async () => {
        setup ??= (options.loadToneGlobal ?? (() => import('tone/build/esm/core/Global')))()
          .then((global) => {
            if (disposed) return;
            global.setContext(next);
            toneContext = global.getContext();
          })
          .catch((error: unknown) => {
            setup = null;
            throw error;
          });
        await setup;
        if (disposed) return;
        const result = await (options.render ?? renderCueBuffers)(next);
        if (disposed) return;
        buffers = result;
        output = next.createGain();
        output.gain.value = 0.68;
        output.connect(next.destination);
      })().catch((error: unknown) => {
        preparation = null;
        throw error;
      });
      return preparation;
    },
    play(cue: ProductCue) {
      const buffer = buffers.get(keys[cue]);
      if (!enabled || disposed || !context || !output || !buffer || globalThis.document?.hidden)
        return;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(output);
      active.set(source, keys[cue]);
      source.onended = () => {
        source.disconnect();
        active.delete(source);
      };
      source.start(context.currentTime + 0.012);
    },
    stop,
    setEnabled(value: boolean): boolean {
      const changed = enabled !== value;
      enabled = value;
      if (!enabled) stop();
      return changed;
    },
    async dispose() {
      disposed = true;
      stop();
      await preparation?.catch(() => undefined);
      buffers.clear();
      output?.disconnect();
      output = null;
    },
    // Offline wrappers are disposed during preparation; native context belongs to bootstrap.
    disposeContext() {
      toneContext?.dispose();
      toneContext = null;
    },
  };
}
