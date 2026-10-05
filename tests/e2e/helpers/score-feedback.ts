import { type JSHandle, type Page } from '@playwright/test';
import { parseCommittedRoomUpdate } from '@repo/game-protocol/socket';

export interface ScoreFeedbackObservation {
  readonly at: number;
  readonly phase: string | null;
  readonly owner: string | null;
  readonly category: string | null;
  readonly score: string | null;
  readonly total: string | null;
  readonly turnCue: boolean;
}

interface ScoreFeedbackAudit {
  readonly observations: ScoreFeedbackObservation[];
  readonly grid: Element | null;
  readonly summary: Element | null;
  readonly canvas: Element | null;
  readonly observer: MutationObserver;
}

/** Records the real rendered handoff, including short phases that polling can miss. */
export async function observeScoreFeedback(page: Page): Promise<JSHandle<ScoreFeedbackAudit>> {
  return page.evaluateHandle(() => {
    const observations: ScoreFeedbackObservation[] = [];
    const grid = document.querySelector('[data-score-grid]');
    const summary = document.querySelector('[data-player-summary]');
    const canvas = document.querySelector('.web-dice-canvas-host canvas');
    let previous = '';
    const record = () => {
      const currentSummary = document.querySelector('[data-player-summary]');
      const confirmed = document.querySelector('[data-score-confirmed="true"]');
      const observation = {
        at: performance.now(),
        phase:
          currentSummary
            ?.querySelector('[data-score-transition]')
            ?.getAttribute('data-score-transition') ?? null,
        owner: currentSummary?.getAttribute('data-player-summary') ?? null,
        category: confirmed?.getAttribute('data-score-category') ?? null,
        score: confirmed?.querySelector('[data-score-value-kind]')?.textContent ?? null,
        total: currentSummary?.querySelector('.player-summary__score')?.textContent ?? null,
        turnCue: document.querySelector('[data-turn-cue]') !== null,
      };
      const identity = JSON.stringify({ ...observation, at: 0 });
      if (identity !== previous) observations.push(observation);
      previous = identity;
    };
    record();
    const observer = new MutationObserver(record);
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      childList: true,
      characterData: true,
    });
    return { observations, grid, summary, canvas, observer };
  });
}

export async function readScoreFeedback(audit: JSHandle<ScoreFeedbackAudit>) {
  return audit.evaluate(({ observations }) => observations);
}

export async function disposeScoreFeedback(audit: JSHandle<ScoreFeedbackAudit>): Promise<void> {
  await audit.evaluate(({ observer }) => observer.disconnect());
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
      const packet = typeof message === 'string' ? /^42(\[.*\])$/u.exec(message) : null;
      if (packet && category !== null) {
        const [name, body] = JSON.parse(packet[1]!) as [string, unknown];
        if (name === 'room:state') {
          const update = parseCommittedRoomUpdate(body);
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
