import type { GameSession, GameSessionSnapshot } from '@repo/game-client-sdk';
import type { ResolvedRollArtifact } from '@repo/game-protocol/socket';
import {
  type Dice,
  type DieFace,
  type DieSlot,
  findSpecialCombinations,
  SPECIAL_COMBINATION,
  type SpecialCombination,
} from '@repo/yacht-rules';

import { PRODUCT_CUE, type ProductCue } from '@/runtime/audio/product-cues';
import { selectFeaturedCombination } from '@/runtime/dice/achievement-selection';
import type { PlaybackFallbackReason, RollPlayback } from '@/runtime/dice/replay';
import type { ProceduralDiceResources } from '@/runtime/dice/resources';
import type { GameSessionHolder } from '@/runtime/session/session-holder';
import {
  ACHIEVEMENT_SEQUENCE_DURATION_MS,
  type AchievementKind,
} from '@/ui/presentation/achievement-sequence-contract';

export type PresentedDie = Readonly<{
  slot: DieSlot;
  value: DieFace;
}>;

export const DICE_REVEAL_DURATION_MS = 360;

type PresentationBase = Readonly<{
  resources: ProceduralDiceResources | null;
}>;

export type DicePresentationSnapshot =
  | (PresentationBase & Readonly<{ phase: 'hidden' }>)
  | (PresentationBase & Readonly<{ phase: 'settled'; dice: readonly PresentedDie[] }>)
  | (PresentationBase &
      Readonly<{ phase: 'resolving'; rollId: string; dice: readonly PresentedDie[] }>)
  | (PresentationBase &
      Readonly<{
        phase: 'revealing';
        rollId: string;
        dice: readonly PresentedDie[];
        playback: Extract<RollPlayback, { status: 'verified' }>;
      }>)
  | (PresentationBase &
      Readonly<{
        phase: 'rolling';
        rollId: string;
        playback: RollPlayback;
        dice: readonly PresentedDie[];
      }>)
  | (PresentationBase &
      Readonly<{
        phase: 'achievement';
        rollId: string;
        dice: readonly PresentedDie[];
        achievement: Readonly<{ kind: AchievementKind; categoryId: SpecialCombination }>;
      }>);

type PlaybackResolver = (artifact: ResolvedRollArtifact) => Promise<RollPlayback>;
type TimerHandle = ReturnType<typeof globalThis.setTimeout> | number;

interface ActiveRoll {
  readonly artifact: ResolvedRollArtifact;
  playbackComplete: boolean;
  revealComplete: boolean;
  timer: TimerHandle | null;
}

export type DicePresentationOptions = Readonly<{
  sessions: GameSessionHolder;
  requestSynchronization: () => void;
  requireRefreshAfterSynchronization: (reason: PlaybackFallbackReason, cause?: unknown) => void;
  onUnexpected?: (error: unknown) => void;
  playCue: (cue: ProductCue) => void;
  loadResolver?: () => Promise<PlaybackResolver>;
  setTimeout?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout?: (handle: TimerHandle) => void;
}>;

export interface DicePresentation {
  getSnapshot(): DicePresentationSnapshot;
  subscribe(listener: () => void): () => void;
  prepare(): Promise<void>;
  start(): void;
  setResources(resources: ProceduralDiceResources): void;
  completePlayback(rollId: string): void;
  dispose(): void;
}

const defaultLoadResolver = async (): Promise<PlaybackResolver> => {
  const { resolveRollPlayback } = await import('@/runtime/dice/replay');
  return resolveRollPlayback;
};

export function createDicePresentation(options: DicePresentationOptions): DicePresentation {
  const listeners = new Set<() => void>();
  const schedule = options.setTimeout ?? globalThis.setTimeout;
  const cancelScheduled = options.clearTimeout ?? globalThis.clearTimeout;
  let snapshot: DicePresentationSnapshot = { phase: 'hidden', resources: null };
  let resolverLoading: Promise<PlaybackResolver> | null = null;
  let unsubscribe: (() => void) | null = null;
  let disposed = false;
  let roomId: string | null = null;
  let session: GameSession | null = null;
  let turnId: string | null = null;
  let consumedRollId: string | null = null;
  // Each record is also the generation token for its resolver and timers.
  let activeRoll: ActiveRoll | null = null;

  const publish = (next: DicePresentationSnapshot): void => {
    const previous = snapshot;
    if (previous.resources === next.resources) {
      if (previous.phase === 'hidden' && next.phase === 'hidden') return;
      if (
        previous.phase === 'settled' &&
        next.phase === 'settled' &&
        previous.dice.length === next.dice.length &&
        previous.dice.every(
          (die, index) =>
            die.slot === next.dice[index].slot && die.value === next.dice[index].value,
        )
      ) {
        return;
      }
    }
    snapshot = next;
    listeners.forEach((listener) => listener());
  };

  const withResources = <Value extends Omit<DicePresentationSnapshot, 'resources'>>(
    value: Value,
  ): Value & PresentationBase => ({ ...value, resources: snapshot.resources });

  const cancelActive = (): void => {
    const roll = activeRoll;
    activeRoll = null;
    if (roll !== null && roll.timer !== null) {
      cancelScheduled(roll.timer);
      roll.timer = null;
    }
  };

  const presentedDice = (game: GameSessionSnapshot['game']): readonly PresentedDie[] => {
    if (game?.match.status !== 'playing' || game.match.currentTurn.dice === null) return [];
    const { dice, heldSlots } = game.match.currentTurn;
    return dice.flatMap((die, slot) =>
      heldSlots.includes(slot as DieSlot) ? [] : [{ slot: slot as DieSlot, value: die.value }],
    );
  };

  const publishCurrentSettled = (): void => {
    const current = options.sessions.getSnapshot();
    const game = current.sessionSnapshot?.game;
    publish(
      game?.match.status === 'playing' && game.match.currentTurn.dice !== null
        ? withResources({ phase: 'settled' as const, dice: presentedDice(game) })
        : withResources({ phase: 'hidden' as const }),
    );
  };

  const finishPlayback = (): void => {
    const roll = activeRoll;
    if (roll === null || !roll.playbackComplete) return;
    const current = options.sessions.getSnapshot();
    if (current.session !== session || current.sessionSnapshot === null) return;
    const { game } = current.sessionSnapshot;
    if (game?.match.status !== 'playing' || game.match.currentTurn.dice === null) return;
    const { artifact } = roll;
    const dice = presentedDice(game);
    if (!roll.revealComplete) {
      if (snapshot.phase !== 'revealing') {
        if (snapshot.phase !== 'rolling' || snapshot.playback.status !== 'verified') return;
        publish(
          withResources({
            phase: 'revealing' as const,
            rollId: artifact.replay.rollId,
            dice,
            playback: snapshot.playback,
          }),
        );
        roll.timer = schedule(() => {
          if (disposed || activeRoll !== roll) return;
          roll.timer = null;
          roll.revealComplete = true;
          finishPlayback();
        }, DICE_REVEAL_DURATION_MS);
      }
      return;
    }
    const values = game.match.currentTurn.dice.map((die) => die.value) as unknown as Dice;
    const combination = selectFeaturedCombination(findSpecialCombinations(values));
    roll.playbackComplete = false;
    if (combination === null) {
      activeRoll = null;
      publishCurrentSettled();
      return;
    }

    const kind: AchievementKind = combination === SPECIAL_COMBINATION.YACHT ? 'yacht' : 'other';
    publish(
      withResources({
        phase: 'achievement' as const,
        rollId: artifact.replay.rollId,
        dice,
        achievement: { kind, categoryId: combination },
      }),
    );
    if (
      current.sessionSnapshot.connection === 'connected' &&
      current.sessionSnapshot.syncStatus === 'idle'
    ) {
      options.playCue(
        kind === 'yacht' ? PRODUCT_CUE.ACHIEVEMENT_YACHT : PRODUCT_CUE.ACHIEVEMENT_OTHER,
      );
    }
    roll.timer = schedule(() => {
      if (disposed || activeRoll !== roll) return;
      roll.timer = null;
      activeRoll = null;
      publishCurrentSettled();
    }, ACHIEVEMENT_SEQUENCE_DURATION_MS[kind]);
  };

  const prepareResolver = (): Promise<PlaybackResolver> => {
    if (resolverLoading !== null) return resolverLoading;
    resolverLoading = (options.loadResolver ?? defaultLoadResolver)().catch((error: unknown) => {
      resolverLoading = null;
      throw error;
    });
    return resolverLoading;
  };

  const resolveActiveRoll = async (
    roll: ActiveRoll,
    dice: readonly PresentedDie[],
  ): Promise<void> => {
    let playback: RollPlayback;
    try {
      const resolve = await prepareResolver();
      if (activeRoll !== roll) return;
      playback = await resolve(roll.artifact);
    } catch (error) {
      if (activeRoll !== roll) return;
      options.onUnexpected?.(error);
      cancelActive();
      options.requestSynchronization();
      publishCurrentSettled();
      return;
    }
    if (activeRoll !== roll) return;
    publish(
      withResources({
        phase: 'rolling' as const,
        rollId: roll.artifact.replay.rollId,
        playback,
        dice,
      }),
    );
    if (playback.status === 'static-fallback') {
      console.warn('dice_replay_static_fallback', playback.reason);
      if (playback.reason === 'SIMULATION_FAILED')
        options.requireRefreshAfterSynchronization(playback.reason, playback.cause);
      else options.requireRefreshAfterSynchronization(playback.reason);
    }
  };

  const beginRoll = (artifact: ResolvedRollArtifact, dice: readonly PresentedDie[]): void => {
    cancelActive();
    const roll: ActiveRoll = {
      artifact,
      playbackComplete: false,
      revealComplete: false,
      timer: null,
    };
    activeRoll = roll;
    publish(
      withResources({
        phase: 'resolving' as const,
        rollId: artifact.replay.rollId,
        dice: 'dice' in snapshot ? snapshot.dice : [],
      }),
    );
    void resolveActiveRoll(roll, dice);
  };

  const observe = (): void => {
    if (disposed) return;
    const current = options.sessions.getSnapshot();
    if (current.authority === null) {
      cancelActive();
      roomId = null;
      session = null;
      turnId = null;
      consumedRollId = null;
      publish(withResources({ phase: 'hidden' as const }));
      return;
    }

    const { game, presentation } = current.sessionSnapshot;
    const currentTurnId = game?.match.status === 'playing' ? game.match.currentTurn.turnId : null;
    const roll = presentation?.kind === 'roll' ? presentation.roll : null;
    const rollId = roll?.replay.rollId ?? null;
    if (roomId !== current.authority.roomId || session !== current.session) {
      cancelActive();
      roomId = current.authority.roomId;
      session = current.session;
      turnId = currentTurnId;
      consumedRollId = rollId;
      publishCurrentSettled();
      return;
    }
    if (game?.match.status !== 'playing') {
      cancelActive();
      turnId = null;
      publish(withResources({ phase: 'hidden' as const }));
      return;
    }

    const turnAdvanced = turnId !== currentTurnId;
    if (turnAdvanced) {
      cancelActive();
      turnId = currentTurnId;
    }
    if (roll === null) {
      cancelActive();
      publishCurrentSettled();
      return;
    }
    if (turnAdvanced) {
      publishCurrentSettled();
    }
    if (rollId !== consumedRollId) {
      consumedRollId = rollId;
      beginRoll(roll, presentedDice(game));
      return;
    }
    if (activeRoll !== null) {
      finishPlayback();
      return;
    }
    if (turnAdvanced) return;
    publishCurrentSettled();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prepare() {
      await prepareResolver();
    },
    start() {
      if (disposed || unsubscribe !== null) return;
      unsubscribe = options.sessions.subscribe(observe);
      observe();
    },
    setResources(resources: ProceduralDiceResources) {
      if (disposed || snapshot.resources === resources) return;
      publish({ ...snapshot, resources });
    },
    completePlayback(rollId: string) {
      if (
        disposed ||
        snapshot.phase !== 'rolling' ||
        snapshot.rollId !== rollId ||
        activeRoll?.artifact.replay.rollId !== rollId
      ) {
        return;
      }
      if (snapshot.playback.status === 'static-fallback') return;
      activeRoll.playbackComplete = true;
      finishPlayback();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
      cancelActive();
      listeners.clear();
      snapshot = { phase: 'hidden', resources: snapshot.resources };
    },
  };
}
