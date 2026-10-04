import type { ServerClock } from '@repo/game-client-sdk';
import { useNavigate } from '@tanstack/react-router';
import { useMachine } from '@xstate/react';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { APP_SCREEN_PATH } from '@/app/screen-paths';
import {
  createLobbyMachine,
  type LobbyEvent,
  type LobbyServices,
  selectLobbyView,
} from '@/features/lobby/lobby-machine';
import { useTelemetry } from '@/runtime/telemetry/TelemetryContext';

export function useLobbyAdmission({
  clock,
  onIntent,
  ...services
}: LobbyServices & { clock: Pick<ServerClock, 'now'>; onIntent: () => void }) {
  const { access } = services;
  const telemetry = useTelemetry();
  const navigate = useNavigate({ from: APP_SCREEN_PATH.LOBBY });
  // These service identities stay stable for one route actor instance.
  const [machine] = useState(() =>
    createLobbyMachine(services, telemetry, () => {
      void navigate({ to: APP_SCREEN_PATH.GAME, replace: true });
    }),
  );
  const [state, send, actor] = useMachine(machine);
  const [showDelayedProgress, setShowDelayedProgress] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const view = selectLobbyView(state);
  const { waitingRoom, error, joinRetryAfterMs } = state.context;
  const accessState = useSyncExternalStore(access.subscribe, access.getSnapshot);
  const readinessOperation = accessState.status === 'preparing' ? accessState.operation : null;
  useEffect(() => {
    const pending = view === 'creating' || view === 'joining';
    setShowDelayedProgress(false);
    if (!pending) return;
    const timer = setTimeout(() => setShowDelayedProgress(true), 250);
    return () => clearTimeout(timer);
  }, [view]);

  useEffect(() => {
    if (view !== 'waiting' || !waitingRoom) return;
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
  }, [clock, send, view, waitingRoom]);

  useEffect(() => {
    if (joinRetryAfterMs === 0) return;
    const release = setTimeout(() => send({ type: 'RATE_LIMIT_CLEARED' }), joinRetryAfterMs);
    return () => clearTimeout(release);
  }, [joinRetryAfterMs, send]);

  const intent = (event: LobbyEvent, sound = true): void => {
    if (isRestoreBlocking(access.getSnapshot()) || !actor.getSnapshot().can(event)) return;
    send(event);
    if (sound) onIntent();
  };
  return {
    view,
    waitingRoom,
    error,
    joinCode: state.context.joinCode,
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
    cancelWaiting: () =>
      intent({
        type: actor.getSnapshot().matches({ admitted: 'cancelFailed' })
          ? 'RETRY_CANCEL'
          : 'CANCEL_REQUESTED',
      }),
    readinessOperation,
    showDelayedProgress,
    remainingSeconds,
    restoreView: restoreDisplay(accessState),
    recoveryPhase: accessState.status === 'waiting' ? accessState.recovery : 'idle',
    confirmAuthorityFailure: access.confirmAuthorityFailure,
  };
}

function isRestoreBlocking(state: ReturnType<LobbyServices['access']['getSnapshot']>) {
  return (
    state.status === 'restoring' ||
    ((state.status === 'handoff' ||
      state.status === 'authorityFailure' ||
      state.status === 'refreshRequired') &&
      state.origin === 'restore')
  );
}
function restoreDisplay(state: ReturnType<LobbyServices['access']['getSnapshot']>) {
  if (state.status === 'restoring') return { status: state.phase };
  if (state.status === 'handoff' && state.origin === 'restore')
    return { status: state.target === 'game' ? ('playing' as const) : ('waiting' as const) };
  if (state.status === 'authorityFailure' && state.origin === 'restore')
    return { status: 'permanentFailure' as const, error: state.error };
  if (state.status === 'refreshRequired' && state.origin === 'restore')
    return { status: 'refreshRequired' as const, reason: state.reason };
  return { status: 'idle' as const };
}
