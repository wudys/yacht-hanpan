import type { ClientError } from '@repo/game-client-sdk/errors';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import {
  admissionError,
  INITIAL_LOBBY_STATE,
  type LobbyAction,
  type LobbyEvent,
  reduceLobby,
} from '@/features/lobby/lobby-state';
import type { ProfileSelectionStore } from '@/runtime/profile/profile-selection-store';
import type { AdmissionResult, RoomAccess } from '@/runtime/room-access/room-access';
import { reportClientFailure } from '@/runtime/telemetry/error-policy';
import { clientFailureFields, type Telemetry } from '@/runtime/telemetry/telemetry';

export interface LobbyDependencies {
  readonly activity: AbortSignal;
  readonly access: RoomAccess;
  readonly profile: ProfileSelectionStore;
}
type Operation = 'create' | 'join' | 'cancel' | 'expiry';
interface PendingOperation {
  readonly controller: AbortController;
  readonly startedAt: number;
}

export function useLobbyController(
  initialDependencies: LobbyDependencies,
  telemetry: Telemetry,
  navigateToGame: () => void,
) {
  // A route owns one set of dependencies, including the navigation destination.
  const [dependencies] = useState(() => ({ ...initialDependencies, telemetry, navigateToGame }));
  const [state, dispatch] = useReducer(reduceLobby, INITIAL_LOBBY_STATE);
  const currentState = useRef(INITIAL_LOBBY_STATE);
  const mounted = useRef(false);
  const pending = useRef<PendingOperation | null>(null);
  const waitingStarted = useRef<number | null>(null);

  const applyTransition = useCallback(
    (event: LobbyAction) => {
      if (!mounted.current) return false;
      const before = currentState.current;
      const next = reduceLobby(before, event);
      if (next === before) return false;
      // Keep accepted transitions visible to same-turn/stale handlers before React's batched render.
      currentState.current = next;
      dispatch(event);
      if (next.phase !== before.phase && pending.current) {
        const interrupted = pending.current;
        pending.current = null;
        interrupted.controller.abort();
      }
      let outcome: 'matched' | 'cancelled' | 'expired' | undefined;
      if (next.phase === 'handoff') outcome = 'matched';
      else if (event.type === 'CANCELLATION_COMPLETED' && event.result.status === 'cancelled')
        outcome = 'cancelled';
      else if (event.type === 'EXPIRY_CHECKED' && event.result.status === 'gone')
        outcome = 'expired';
      if (outcome && waitingStarted.current !== null) {
        dependencies.telemetry.trackEvent({
          name: 'waiting_result',
          outcome,
          duration_ms: Math.round(performance.now() - waitingStarted.current),
        });
        waitingStarted.current = null;
      }
      if (next.phase === 'notice') waitingStarted.current = null;
      if (next.phase === 'waiting') {
        waitingStarted.current ??= performance.now();
        dependencies.access.completeHandoff();
      }
      if (next.phase === 'handoff') {
        dependencies.access.completeHandoff();
        dependencies.navigateToGame();
      }
      if (
        event.type === 'ACCESS_CHANGED' &&
        next.phase === 'connectionFailed' &&
        event.access.status === 'connectionFailure' &&
        'cause' in event.access
      ) {
        dependencies.telemetry.reportUnexpected(event.access.cause, {
          operation: 'synchronize',
          stage: 'promise',
        });
      }
      return true;
    },
    [dependencies],
  );

  const runOperation = useCallback(
    (kind: Operation) => {
      const task: PendingOperation = {
        controller: new AbortController(),
        startedAt: performance.now(),
      };
      pending.current = task;
      const { signal } = task.controller;
      if (kind !== 'expiry')
        dependencies.telemetry.trackEvent({
          name: 'room_request',
          operation: kind,
          phase: 'start',
        });
      const profile = dependencies.profile.getSnapshot().selection;
      const roomCode = currentState.current.joinCode;

      function isCurrentOperation() {
        return (
          mounted.current &&
          !dependencies.activity.aborted &&
          pending.current === task &&
          !signal.aborted
        );
      }

      function recordRequestResult(operation: 'create' | 'join' | 'cancel', error?: ClientError) {
        dependencies.telemetry.trackEvent({
          name: 'room_request',
          operation,
          phase: error ? 'failure' : 'success',
          duration_ms: Math.max(0, Math.round(performance.now() - task.startedAt)),
          ...(error ? clientFailureFields(error) : {}),
        });
        if (error)
          reportClientFailure(dependencies.telemetry, error, { operation, stage: 'response' });
      }

      function requestAdmission(operation: 'create' | 'join') {
        if (operation === 'create') return dependencies.access.create(profile, signal);
        return dependencies.access.join({ profile, roomCode }, signal);
      }

      function recordAdmissionResult(operation: 'create' | 'join', result: AdmissionResult) {
        if (result.status === 'installed') recordRequestResult(operation);
        if (result.status === 'failure') recordRequestResult(operation, admissionError(result));
      }

      function completeOperation(completion: LobbyAction) {
        if (!isCurrentOperation()) return;
        pending.current = null;
        applyTransition(completion);
      }

      function handleUnexpectedFailure(cause: unknown) {
        if (!isCurrentOperation()) return;
        pending.current = null;
        if (
          (kind === 'cancel' || kind === 'expiry') &&
          dependencies.access.getSnapshot().status === 'idle'
        )
          return;
        dependencies.telemetry.reportUnexpected(cause, {
          operation: kind === 'expiry' ? 'synchronize' : kind,
          stage: 'promise',
        });
        if (kind === 'create' || kind === 'join') {
          dependencies.telemetry.trackEvent({
            name: 'room_request',
            operation: kind,
            phase: 'failure',
            duration_ms: Math.max(0, Math.round(performance.now() - task.startedAt)),
          });
        }
        applyTransition({ type: 'OPERATION_FAILED' });
      }

      async function execute() {
        try {
          switch (kind) {
            case 'create':
            case 'join': {
              const result = await requestAdmission(kind);
              if (!isCurrentOperation()) return;
              recordAdmissionResult(kind, result);
              completeOperation({ type: 'ADMISSION_COMPLETED', operation: kind, result });
              return;
            }
            case 'cancel': {
              const result = await dependencies.access.cancelWaiting(signal, (error) => {
                if (isCurrentOperation()) recordRequestResult('cancel', error);
              });
              completeOperation({ type: 'CANCELLATION_COMPLETED', result });
              return;
            }
            case 'expiry': {
              const result = await dependencies.access.checkWaitingExpiry(signal);
              if (!isCurrentOperation()) return;
              if (result.status === 'failure')
                reportClientFailure(dependencies.telemetry, result.error, {
                  operation: 'synchronize',
                  stage: 'response',
                });
              completeOperation({ type: 'EXPIRY_CHECKED', result });
              return;
            }
          }
        } catch (cause) {
          handleUnexpectedFailure(cause);
        }
      }

      void execute();
    },
    [dependencies, applyTransition],
  );

  const startAdmission = useCallback(
    (operation: 'create' | 'join') => {
      if (currentState.current.phase !== 'checkingAdmission') return;
      dependencies.access.checkStoredRoom();
      // Restoring a stored room can synchronously move the lobby to another phase.
      if (currentState.current.phase !== 'checkingAdmission') return;
      const access = dependencies.access.getSnapshot();
      if (
        access.status === 'restoring' ||
        access.status === 'authorityFailure' ||
        access.status === 'refreshRequired'
      ) {
        applyTransition({ type: 'ADMISSION_BLOCKED' });
        return;
      }
      applyTransition({ type: 'ADMISSION_STARTED', operation });
      runOperation(operation);
    },
    [dependencies, applyTransition, runOperation],
  );

  const send = useCallback(
    (event: LobbyEvent): boolean => {
      if (!mounted.current || dependencies.activity.aborted) return false;
      const before = currentState.current;
      if (event.type === 'WAIT_EXPIRED') {
        const access = dependencies.access.getSnapshot();
        if (access.status === 'handoff' && access.target === 'game') {
          applyTransition({ type: 'ACCESS_CHANGED', access });
          return false;
        }
      }
      if (!applyTransition(event)) return false;
      switch (event.type) {
        case 'CREATE_REQUESTED':
          startAdmission('create');
          break;
        case 'JOIN_REQUESTED':
          startAdmission('join');
          break;
        case 'CANCEL_REQUESTED':
          runOperation('cancel');
          break;
        case 'DISMISS_NOTICE':
          if (before.phase === 'expired') runOperation('expiry');
          if (before.phase === 'notice') dependencies.access.confirmAuthorityFailure();
          break;
      }
      return true;
    },
    [dependencies, applyTransition, runOperation, startAdmission],
  );

  useEffect(() => {
    mounted.current = true;
    const replaced = () => {
      applyTransition({ type: 'REPLACED' });
    };
    const changed = () => {
      applyTransition({ type: 'ACCESS_CHANGED', access: dependencies.access.getSnapshot() });
    };
    const unsubscribe = dependencies.access.subscribe(changed);
    dependencies.activity.addEventListener('abort', replaced, { once: true });
    if (dependencies.activity.aborted) replaced();
    else dependencies.access.checkStoredRoom();
    changed();
    return () => {
      mounted.current = false;
      const task = pending.current;
      pending.current = null;
      task?.controller.abort();
      dependencies.activity.removeEventListener('abort', replaced);
      unsubscribe();
    };
  }, [dependencies, applyTransition]);

  return { state, send };
}
