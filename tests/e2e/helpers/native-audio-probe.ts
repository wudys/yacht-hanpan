import type { Page } from '@playwright/test';

interface NativeCueObservation {
  readonly kind: 'start' | 'stop';
  readonly source: number;
  readonly at: number;
  readonly contextState: AudioContextState;
  readonly covered: boolean;
  readonly recordPhase: string | null;
}

interface NativeCueProbe {
  readonly events: NativeCueObservation[];
  readonly contexts: AudioContext[];
  readonly media: HTMLMediaElement[];
}

/** Observes the native SFX outlet; every intercepted call still plays/stops its original source. */
export async function observeNativeCues(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe: NativeCueProbe = { events: [], contexts: [], media: [] };
    Reflect.set(window, '__playAreaNativeCues', probe);
    const nativeMediaSource = AudioContext.prototype.createMediaElementSource;
    AudioContext.prototype.createMediaElementSource = function (media: HTMLMediaElement) {
      const result = nativeMediaSource.call(this, media);
      if (!probe.media.includes(media)) probe.media.push(media);
      return result;
    };
    const sources = new WeakMap<AudioBufferSourceNode, number>();
    let nextSource = 0;
    const record = (source: AudioBufferSourceNode, kind: 'start' | 'stop') => {
      // Exclude the browser's one-sample unlock buffer, not a particular product cue duration.
      if (!(source.context instanceof AudioContext) || !source.buffer || source.buffer.length <= 1)
        return;
      if (!probe.contexts.includes(source.context)) probe.contexts.push(source.context);
      let identity = sources.get(source);
      if (identity === undefined) {
        identity = nextSource++;
        sources.set(source, identity);
      }
      probe.events.push({
        kind,
        source: identity,
        at: performance.now(),
        contextState: source.context.state,
        covered: document.querySelector('[data-play-area-blocker]') !== null,
        recordPhase:
          document
            .querySelector('[data-score-transition]')
            ?.getAttribute('data-score-transition') ?? null,
      });
    };
    const nativeStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (
      ...args: Parameters<AudioBufferSourceNode['start']>
    ) {
      nativeStart.apply(this, args);
      record(this, 'start');
    };
    const nativeStop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.stop = function (
      ...args: Parameters<AudioBufferSourceNode['stop']>
    ) {
      nativeStop.apply(this, args);
      record(this, 'stop');
    };
  });
}

export async function clearNativeCues(page: Page): Promise<void> {
  await page.evaluate(() => {
    (Reflect.get(window, '__playAreaNativeCues') as NativeCueProbe).events.length = 0;
  });
}

export async function readNativeCues(page: Page): Promise<NativeCueObservation[]> {
  return page.evaluate(
    () => (Reflect.get(window, '__playAreaNativeCues') as NativeCueProbe).events,
  );
}

/** Retains actual playback objects so resize can be checked without replacing audio APIs. */
export async function retainNativeAudio(page: Page) {
  return page.evaluateHandle(() => ({
    context: (Reflect.get(window, '__playAreaNativeCues') as NativeCueProbe).contexts[0],
    media: (Reflect.get(window, '__playAreaNativeCues') as NativeCueProbe).media.find(
      (media) => !media.paused,
    ),
  }));
}
