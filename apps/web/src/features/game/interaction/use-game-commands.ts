import type { GameSession } from '@repo/game-client-sdk';
import type { ClientError } from '@repo/game-client-sdk/errors';
import type { CommandResult, CommandRetry } from '@repo/game-client-sdk/session';
import { PUBLIC_ERROR_CODE } from '@repo/game-protocol';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { BrowserAudioRuntime } from '@/runtime/audio/browser-audio-runtime';
import { PRODUCT_CUE, type ProductCue } from '@/runtime/audio/cue-runtime';
import type { GameAudioFeedback } from '@/runtime/audio/game-audio-feedback';
import type {
  GameSessionHolder,
  GameSessionHolderSnapshot,
} from '@/runtime/session/game-session-holder';
import type { SessionRecovery, SessionRecoverySnapshot } from '@/runtime/session/session-recovery';
import { reportClientFailure } from '@/runtime/telemetry/error-policy';
import { useTelemetry } from '@/runtime/telemetry/TelemetryContext';

export type PendingCommandKind = 'forfeit' | 'hold' | 'roll' | 'score';
type RateLimitNotice = Readonly<{
  session: GameSession;
}>;
type CommandRetryNotice = Readonly<{
  error: ClientError;
  kind: PendingCommandKind;
  retry: CommandRetry;
  cue?: ProductCue;
  session: GameSession;
}>;
export function useGameCommands(
  sessions: GameSessionHolder,
  recovery: SessionRecovery,
  audio: BrowserAudioRuntime,
  feedback: Pick<GameAudioFeedback, 'observeCommand'>,
) {
  const telemetry = useTelemetry();
  const holderSnapshot = useSyncExternalStore(sessions.subscribe, sessions.getSnapshot);
  const recoverySnapshot = useSyncExternalStore(recovery.subscribe, recovery.getSnapshot);
  const [pendingCommandKind, setPendingCommandKind] = useState<PendingCommandKind | null>(null);
  const [rateLimitNotice, setRateLimitNotice] = useState<RateLimitNotice | null>(null);
  const [commandRetryNotice, setCommandRetryNotice] = useState<CommandRetryNotice | null>(null);
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);
  const visibleRateLimitNotice =
    rateLimitNotice !== null &&
    isCommandNoticeCurrent(rateLimitNotice.session, holderSnapshot, recoverySnapshot.status)
      ? rateLimitNotice
      : null;
  const retryAvailable = commandRetryNotice?.retry.isAvailable() ?? false;
  const visibleCommandRetryNotice =
    commandRetryNotice !== null &&
    retryAvailable &&
    isCommandNoticeCurrent(commandRetryNotice.session, holderSnapshot, recoverySnapshot.status)
      ? commandRetryNotice
      : null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (rateLimitNotice !== null && visibleRateLimitNotice === null) {
      setRateLimitNotice(null);
    }
  }, [rateLimitNotice, visibleRateLimitNotice]);

  useEffect(() => {
    if (commandRetryNotice !== null && visibleCommandRetryNotice === null) {
      setCommandRetryNotice(null);
    }
  }, [commandRetryNotice, visibleCommandRetryNotice]);

  const runCommand = useCallback(
    (
      kind: PendingCommandKind,
      command: (session: GameSession) => Promise<CommandResult> | null,
      cue?: ProductCue,
    ): boolean => {
      const finishCommand = (): void => {
        pendingRef.current = false;
        if (mountedRef.current) setPendingCommandKind(null);
      };
      const submitted = sessions.getSnapshot();
      const { session } = submitted;
      if (session === null || pendingRef.current) return false;
      const submittedSyncRevision = submitted.sessionSnapshot?.syncRevision;
      pendingRef.current = true;
      setPendingCommandKind(kind);
      let operation: Promise<CommandResult> | null;
      try {
        operation = command(session);
      } catch (error) {
        telemetry.reportUnexpected(error, { operation: kind, stage: 'invoke' });
        finishCommand();
        return false;
      }
      if (operation === null) {
        finishCommand();
        return false;
      }
      if (cue)
        feedback.observeCommand({
          session,
          result: operation,
          cue,
          syncRevision: submittedSyncRevision,
        });
      void operation.then(
        (result) => {
          if (!result.ok) {
            const current = sessions.getSnapshot();
            if (mountedRef.current && current.session === session) {
              // synchronize publishes its failure before resolving; the snapshot observer
              // owns that error. Command-only acknowledgement failures are reported here.
              if (result.error !== current.sessionSnapshot?.error)
                reportClientFailure(telemetry, result.error, {
                  operation: kind,
                  stage: 'response',
                });
              if (
                result.error.kind === 'server' &&
                result.error.error.code === PUBLIC_ERROR_CODE.RATE_LIMITED
              ) {
                if (isCommandNoticeCurrent(session, current, recovery.getSnapshot().status)) {
                  setRateLimitNotice({
                    session,
                  });
                }
              } else {
                const retry = result.retry ?? null;
                if (
                  retry !== null &&
                  retry.isAvailable() &&
                  isCommandNoticeCurrent(session, current, recovery.getSnapshot().status)
                ) {
                  setCommandRetryNotice({ error: result.error, kind, retry, session, cue });
                } else if (retry === null) {
                  recovery.reportCommandError(result.error);
                }
              }
            }
            finishCommand();
            return;
          }
          finishCommand();
        },
        (error: unknown) => {
          if (mountedRef.current && sessions.getSnapshot().session === session)
            telemetry.reportUnexpected(error, { operation: kind, stage: 'promise' });
          finishCommand();
        },
      );
      return true;
    },
    [feedback, recovery, sessions, telemetry],
  );

  function retryCommand(): void {
    const notice = visibleCommandRetryNotice;
    if (notice === null) return;
    const current = sessions.getSnapshot();
    if (!isCommandNoticeCurrent(notice.session, current, recovery.getSnapshot().status)) {
      setCommandRetryNotice(null);
      return;
    }
    setCommandRetryNotice(null);
    if (
      runCommand(notice.kind, () => notice.retry.run(), notice.cue) &&
      (notice.kind === 'roll' || notice.kind === 'forfeit')
    )
      audio.playCue(PRODUCT_CUE.CLICK);
  }

  function roll(): void {
    if (runCommand('roll', (session) => session.rollDice())) audio.playCue(PRODUCT_CUE.ROLL_CLICK);
  }

  const setDieHeld = useCallback(
    (slot: Parameters<GameSession['setDieHeld']>[0], isHeld: boolean): void => {
      runCommand(
        'hold',
        (session) => session.setDieHeld(slot, isHeld),
        isHeld ? PRODUCT_CUE.HOLD : PRODUCT_CUE.RELEASE,
      );
    },
    [runCommand],
  );

  const selectScore = useCallback(
    (categoryId: Parameters<GameSession['selectScoreCategory']>[0]): void => {
      runCommand('score', (session) => session.selectScoreCategory(categoryId));
    },
    [runCommand],
  );

  function forfeit(): void {
    if (runCommand('forfeit', (session) => session.forfeitMatch()))
      audio.playCue(PRODUCT_CUE.CLICK);
  }

  return {
    holderSnapshot,
    recoverySnapshot,
    pendingCommandKind,
    rateLimited: visibleRateLimitNotice !== null,
    commandRetryError: visibleCommandRetryNotice?.error ?? null,
    dismissRateLimit: () => setRateLimitNotice(null),
    roll,
    setDieHeld,
    selectScore,
    forfeit,
    retryCommand,
  };
}

function isCommandNoticeCurrent(
  session: GameSession,
  current: GameSessionHolderSnapshot,
  recoveryStatus: SessionRecoverySnapshot['status'],
): boolean {
  return (
    current.session === session &&
    current.sessionSnapshot?.game?.match.status === 'playing' &&
    recoveryStatus === 'idle'
  );
}
