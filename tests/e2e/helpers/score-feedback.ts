import { type JSHandle, type Page } from '@playwright/test';

import { readRoomStatePacket } from './socket-packets';

export interface ScoreFeedbackObservation {
  readonly at: number;
  readonly phase: string | null;
  readonly owner: string | null;
  readonly group: string | null;
  readonly category: string | null;
  readonly score: string | null;
  readonly total: string | null;
  readonly turnCue: boolean;
  readonly previewCount: number;
  readonly hasGroupPreview: boolean;
}

interface ScoreFeedbackAudit {
  readonly observations: ScoreFeedbackObservation[];
  readonly sweep: { playState: string | null; advanced: boolean };
  readonly effects: ScoreFeedbackEffectObservation[];
  readonly grid: Element | null;
  readonly summary: Element | null;
  readonly canvas: Element | null;
  readonly dispose: () => void;
}

interface ScoreFeedbackEffectObservation {
  readonly kind: 'sweep' | 'particle';
  status:
    'pending' | 'finished' | 'unanimated' | 'cancelled' | 'detached' | 'disposed' | 'restarted';
  confirmationConnected: boolean;
  opacity: string | null;
}

/** Records the real rendered handoff, including short phases that polling can miss. */
export async function observeScoreFeedback(page: Page): Promise<JSHandle<ScoreFeedbackAudit>> {
  return page.evaluateHandle(() => {
    const observations: ScoreFeedbackObservation[] = [];
    const sweep: ScoreFeedbackAudit['sweep'] = { playState: null, advanced: false };
    const effects: ScoreFeedbackEffectObservation[] = [];
    const observedEffects = new WeakMap<
      Element,
      { animations: Animation[]; observation: ScoreFeedbackEffectObservation }
    >();
    const grid = document.querySelector('[data-score-grid]');
    const summary = document.querySelector('[data-player-summary]');
    const canvas = document.querySelector('.web-dice-canvas-host canvas');
    let previous = '';
    let frame = 0;
    let disposed = false;
    const record = () => {
      if (disposed) return;
      const currentSummary = document.querySelector('[data-player-summary]');
      const confirmed = document.querySelector('[data-score-confirmed="true"]');
      const observation = {
        at: performance.now(),
        phase:
          currentSummary
            ?.querySelector('[data-score-transition]')
            ?.getAttribute('data-score-transition') ?? null,
        owner: currentSummary?.getAttribute('data-player-summary') ?? null,
        group:
          document
            .querySelector('[data-score-tab][aria-selected="true"]')
            ?.getAttribute('data-score-tab') ?? null,
        category: confirmed?.getAttribute('data-score-category') ?? null,
        score: confirmed?.querySelector('[data-score-value-kind]')?.textContent ?? null,
        total: currentSummary?.querySelector('.player-summary__score')?.textContent ?? null,
        turnCue: document.querySelector('[data-turn-cue]') !== null,
        previewCount: document.querySelectorAll('[data-score-cell][data-value-state="preview"]')
          .length,
        hasGroupPreview: document.querySelector('[data-score-tab] span') !== null,
      };
      const identity = JSON.stringify({ ...observation, at: 0 });
      if (identity !== previous) observations.push(observation);
      previous = identity;
      const sweepElement = confirmed?.querySelector('.score-feedback__sweep');
      const animation = sweepElement?.getAnimations()[0];
      if (sweep.playState === null && sweepElement && animation) {
        sweep.playState = getComputedStyle(sweepElement).animationPlayState;
        void animation.ready.then(
          () => {
            if (disposed) return;
            frame = requestAnimationFrame(() => {
              if (disposed) return;
              const initialTime = animation.currentTime;
              frame = requestAnimationFrame(() => {
                if (disposed) return;
                sweep.advanced =
                  typeof initialTime === 'number' &&
                  typeof animation.currentTime === 'number' &&
                  animation.currentTime > initialTime;
                frame = 0;
              });
            });
          },
          () => {
            // A cancelled animation cannot establish running progress.
          },
        );
      }
      for (const effect of confirmed?.querySelectorAll(
        '.score-feedback__sweep, .score-feedback__particle',
      ) ?? []) {
        const animations = effect.getAnimations();
        const tracked = observedEffects.get(effect);
        if (tracked) {
          if (
            animations.some((animation) => !tracked.animations.includes(animation)) ||
            (tracked.observation.status === 'finished' &&
              animations.some((animation) => animation.playState !== 'finished'))
          )
            tracked.observation.status = 'restarted';
          continue;
        }
        const observation: ScoreFeedbackEffectObservation = {
          kind: effect.matches('.score-feedback__sweep') ? 'sweep' : 'particle',
          status: animations.length > 0 ? 'pending' : 'unanimated',
          confirmationConnected: false,
          opacity: null,
        };
        observedEffects.set(effect, { animations, observation });
        effects.push(observation);
        if (animations.length === 0) continue;
        void Promise.all(animations.map((animation) => animation.finished)).then(
          () => {
            if (disposed || observation.status !== 'pending') return;
            observation.confirmationConnected =
              confirmed!.isConnected &&
              confirmed!.matches('[data-score-confirmed="true"]') &&
              effect.isConnected &&
              effect.closest('[data-score-confirmed="true"]') === confirmed;
            observation.opacity = getComputedStyle(effect).opacity;
            observation.status = !observation.confirmationConnected
              ? 'detached'
              : animations.every((animation) => animation.playState === 'finished')
                ? 'finished'
                : 'restarted';
          },
          () => {
            // Rejection is cancellation, never proof that the visual finished.
            if (!disposed && observation.status === 'pending') observation.status = 'cancelled';
          },
        );
      }
    };
    record();
    const observer = new MutationObserver(record);
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      childList: true,
      characterData: true,
    });
    return {
      observations,
      sweep,
      effects,
      grid,
      summary,
      canvas,
      dispose() {
        disposed = true;
        for (const effect of effects) {
          if (effect.status === 'pending') effect.status = 'disposed';
        }
        observer.disconnect();
        cancelAnimationFrame(frame);
      },
    };
  });
}

export async function readScoreFeedback(audit: JSHandle<ScoreFeedbackAudit>) {
  return audit.evaluate(({ observations }) => observations);
}

export async function readScoreFeedbackEffects(audit: JSHandle<ScoreFeedbackAudit>) {
  return audit.evaluate(({ effects }) => effects);
}

export async function disposeScoreFeedback(audit: JSHandle<ScoreFeedbackAudit>): Promise<void> {
  await audit.evaluate(({ dispose }) => dispose());
  await audit.dispose();
}

export async function scoreFeedbackNodesRetained(audit: JSHandle<ScoreFeedbackAudit>) {
  return audit.evaluate(({ grid, summary, canvas }) => ({
    grid: grid !== null && document.querySelector('[data-score-grid]') === grid,
    summary: summary !== null && document.querySelector('[data-player-summary]') === summary,
    canvas: canvas !== null && document.querySelector('.web-dice-canvas-host canvas') === canvas,
  }));
}

/** Delays a genuine opponent score publication while server deadlines keep advancing. */
export async function holdScorePublication(page: Page) {
  let category: string | null = null;
  let publication: {
    readonly receivedAt: number;
    readonly startedAt: number;
    readonly deadlineAt: number;
  } | null = null;
  const pending: Array<() => void> = [];
  await page.routeWebSocket(/\/game-socket\//u, (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => {
      const update = readRoomStatePacket(message);
      if (update !== null && category !== null) {
        const { game } = update.view;
        if (
          update.type === 'state:committed' &&
          game?.match.status === 'playing' &&
          Object.hasOwn(game.match.players[0].scorecard, category)
        ) {
          publication ??= {
            receivedAt: Date.now(),
            startedAt: game.match.currentTurn.startedAt,
            deadlineAt: game.match.currentTurn.deadlineAt,
          };
          pending.push(() => socket.send(message));
          return;
        }
      }
      socket.send(message);
    });
    socket.onMessage((message) => server.send(message));
  });
  return {
    hold(nextCategory: string) {
      category = nextCategory;
    },
    current() {
      return publication;
    },
    release() {
      category = null;
      for (const send of pending.splice(0)) send();
    },
  };
}
