import type { ServerClock } from '@repo/game-client-sdk';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { APP_SCREEN_PATH } from '@/app/routing/screen-paths';
import type { LobbyEvent } from '@/features/lobby/lobby-state';
import { type LobbyDependencies, useLobbyController } from '@/features/lobby/use-lobby-controller';
import { useTelemetry } from '@/runtime/telemetry/TelemetryContext';

export function useLobbyFlow({
  clock,
  onIntent,
  ...dependencies
}: LobbyDependencies & { clock: Pick<ServerClock, 'now'>; onIntent: () => void }) {
  const { access } = dependencies;
  const telemetry = useTelemetry();
  const navigate = useNavigate({ from: APP_SCREEN_PATH.LOBBY });
  const { state, send } = useLobbyController(dependencies, telemetry, () => {
    void navigate({ to: APP_SCREEN_PATH.GAME, replace: true });
  });
  const [showDelayedProgress, setShowDelayedProgress] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const screenState = state.phase === 'handoff' ? 'matching' : state.phase;
  const { waitingRoom, error, joinRetryAfterMs } = state;
  const accessState = useSyncExternalStore(access.subscribe, access.getSnapshot);
  const readinessOperation = accessState.status === 'preparing' ? accessState.operation : null;
  useEffect(() => {
    const pending = screenState === 'creating' || screenState === 'joining';
    setShowDelayedProgress(false);
    if (!pending) return;
    const timer = setTimeout(() => setShowDelayedProgress(true), 250);
    return () => clearTimeout(timer);
  }, [screenState]);

  useEffect(() => {
    if (screenState !== 'waiting' || !waitingRoom) return;
    const update = () => {
      const serverNow = clock.now();
      if (serverNow === null) return;
      const remaining = Math.max(0, Math.ceil((waitingRoom.expiresAt - serverNow) / 1_000));
      setRemainingSeconds(remaining);
      if (remaining === 0) send({ type: 'WAIT_EXPIRED' });
    };
    update();
    const timer = setInterval(update, 1_000);
    return () => clearInterval(timer);
  }, [clock, send, screenState, waitingRoom]);

  useEffect(() => {
    if (joinRetryAfterMs === 0) return;
    const release = setTimeout(() => send({ type: 'RATE_LIMIT_CLEARED' }), joinRetryAfterMs);
    return () => clearTimeout(release);
  }, [joinRetryAfterMs, send]);

  const intent = (event: LobbyEvent, sound = true): void => {
    if (isReentryBlocking(access.getSnapshot()) || !send(event)) return;
    if (sound) onIntent();
  };
  return {
    screenState,
    waitingRoom,
    error,
    joinCode: state.joinCode,
    rateLimited: joinRetryAfterMs > 0,
    openProfile: () => intent({ type: 'OPEN_PROFILE' }),
    closeProfile: () => intent({ type: 'CLOSE_PROFILE' }),
    openSettings: () => intent({ type: 'OPEN_SETTINGS' }),
    closeSettings: () => intent({ type: 'CLOSE_SETTINGS' }),
    openJoinRoom: () => intent({ type: 'OPEN_JOIN_ROOM' }),
    closeJoinRoom: () => intent({ type: 'CLOSE_JOIN_ROOM' }),
    focusJoinCode: () => intent({ type: 'JOIN_CODE_FOCUSED' }, false),
    changeJoinCode: (code: string) => intent({ type: 'JOIN_CODE_CHANGED', code }, false),
    dismissNotice: () => intent({ type: 'DISMISS_NOTICE' }),
    createRoom: () => intent({ type: 'CREATE_REQUESTED' }),
    joinRoom: () => intent({ type: 'JOIN_REQUESTED' }),
    cancelWaiting: () => intent({ type: 'CANCEL_REQUESTED' }),
    readinessOperation,
    showDelayedProgress,
    remainingSeconds,
    reentryState: getReentryState(accessState),
    recoveryPhase: accessState.status === 'waiting' ? accessState.recovery : 'idle',
    confirmAuthorityFailure: access.confirmAuthorityFailure,
  };
}

function isReentryBlocking(state: ReturnType<LobbyDependencies['access']['getSnapshot']>) {
  return (
    state.status === 'restoring' ||
    ((state.status === 'handoff' ||
      state.status === 'authorityFailure' ||
      state.status === 'refreshRequired') &&
      state.origin === 'restore')
  );
}
function getReentryState(state: ReturnType<LobbyDependencies['access']['getSnapshot']>) {
  if (state.status === 'restoring') return { status: state.phase };
  if (state.status === 'handoff' && state.origin === 'restore')
    return { status: state.target === 'game' ? ('gameReady' as const) : ('waiting' as const) };
  if (state.status === 'authorityFailure' && state.origin === 'restore')
    return { status: 'permanentFailure' as const, error: state.error };
  if (state.status === 'refreshRequired' && state.origin === 'restore')
    return { status: 'refreshRequired' as const, reason: state.reason };
  return { status: 'idle' as const };
}

export type LobbyFlow = ReturnType<typeof useLobbyFlow>;
