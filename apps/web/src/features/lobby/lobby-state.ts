import { PUBLIC_ERROR_CODE } from '@repo/game-protocol';

import {
  classifyCreateRoomFailure,
  connectionFailureError,
  isInlineJoinError,
  isServerError,
  type LobbyError,
  lobbyError,
  readinessError,
  readinessFailureDisposition,
} from '@/features/lobby/lobby-errors';
import { isCompleteRoomCode, normalizeRoomCode } from '@/features/lobby/room-code';
import type {
  AdmissionResult,
  Cancellation,
  ExpiryCheck,
  RoomAccessSnapshot,
  WaitingRoomSummary,
} from '@/runtime/room-access/room-access';
import { isPermanentAuthorityFailure } from '@/runtime/session/authority-failure';

export type LobbyPhase =
  | 'home'
  | 'profile'
  | 'settings'
  | 'joinRoom'
  | 'checkingAdmission'
  | 'creating'
  | 'joining'
  | 'waiting'
  | 'cancelling'
  | 'cancelFailed'
  | 'matching'
  | 'expired'
  | 'checkingExpiry'
  | 'notice'
  | 'createFailed'
  | 'createNotice'
  | 'connectionFailed'
  | 'handoff'
  | 'replaced';
export interface LobbyState {
  readonly phase: LobbyPhase;
  readonly joinCode: string;
  readonly joinRetryAfterMs: number;
  readonly error: LobbyError | null;
  readonly waitingRoom: WaitingRoomSummary | null;
}
export const INITIAL_LOBBY_STATE: LobbyState = {
  phase: 'home',
  joinCode: '',
  joinRetryAfterMs: 0,
  error: null,
  waitingRoom: null,
};
export type LobbyEvent =
  | {
      type:
        | 'OPEN_PROFILE'
        | 'CLOSE_PROFILE'
        | 'OPEN_SETTINGS'
        | 'CLOSE_SETTINGS'
        | 'OPEN_JOIN_ROOM'
        | 'CLOSE_JOIN_ROOM'
        | 'CREATE_REQUESTED'
        | 'JOIN_REQUESTED'
        | 'JOIN_CODE_FOCUSED'
        | 'RATE_LIMIT_CLEARED'
        | 'CANCEL_REQUESTED'
        | 'WAIT_EXPIRED'
        | 'DISMISS_NOTICE';
    }
  | { type: 'JOIN_CODE_CHANGED'; code: string };
export type LobbyAction =
  | LobbyEvent
  | { type: 'REPLACED' }
  | { type: 'ACCESS_CHANGED'; access: RoomAccessSnapshot }
  | { type: 'ADMISSION_STARTED'; operation: 'create' | 'join' }
  | { type: 'ADMISSION_BLOCKED' }
  | { type: 'ADMISSION_COMPLETED'; operation: 'create' | 'join'; result: AdmissionResult }
  | { type: 'CANCELLATION_COMPLETED'; result: Cancellation }
  | { type: 'EXPIRY_CHECKED'; result: ExpiryCheck }
  | { type: 'OPERATION_FAILED' };

/** The reducer decides local display/input state; RoomAccess remains the authority owner. */
export function reduceLobby(state: LobbyState, event: LobbyAction): LobbyState {
  if (state.phase === 'replaced' || state.phase === 'handoff') return state;
  switch (event.type) {
    case 'REPLACED':
      return { ...state, phase: 'replaced' };
    case 'ACCESS_CHANGED':
      return observeAccess(state, event.access);
    case 'RATE_LIMIT_CLEARED':
      return { ...state, joinRetryAfterMs: 0 };
    case 'ADMISSION_BLOCKED':
      return { ...state, phase: 'home' };
    case 'ADMISSION_STARTED':
      return {
        ...state,
        phase: event.operation === 'create' ? 'creating' : 'joining',
        error:
          event.operation === 'create' || state.error?.kind === 'rate-limited' ? null : state.error,
      };
    case 'ADMISSION_COMPLETED':
      return completeAdmission(state, event.operation, event.result);
    case 'CANCELLATION_COMPLETED':
      return completeCancellation(state, event.result);
    case 'EXPIRY_CHECKED':
      return completeExpiry(state, event.result);
    case 'OPERATION_FAILED':
      return {
        ...state,
        phase: 'connectionFailed',
        error: { kind: 'request', key: 'lobby.reentryRefresh' },
      };
    case 'OPEN_PROFILE':
      return state.phase === 'home' ? { ...state, phase: 'profile' } : state;
    case 'OPEN_SETTINGS':
      return state.phase === 'home' ? { ...state, phase: 'settings' } : state;
    case 'CLOSE_PROFILE':
      return state.phase === 'profile' ? { ...state, phase: 'home' } : state;
    case 'CLOSE_SETTINGS':
      return state.phase === 'settings' ? { ...state, phase: 'home' } : state;
    case 'OPEN_JOIN_ROOM':
      return state.phase === 'home' ? { ...state, phase: 'joinRoom', error: null } : state;
    case 'CLOSE_JOIN_ROOM':
      return state.phase === 'joinRoom'
        ? { ...state, phase: 'home', joinCode: '', error: null }
        : state;
    case 'JOIN_CODE_CHANGED':
      return state.phase === 'joinRoom'
        ? { ...state, joinCode: normalizeRoomCode(event.code), error: null }
        : state;
    case 'JOIN_CODE_FOCUSED':
      return state.phase === 'joinRoom' && state.error?.kind === 'incomplete-code'
        ? { ...state, error: null }
        : state;
    case 'CREATE_REQUESTED':
      return state.phase === 'home' ? { ...state, phase: 'checkingAdmission' } : state;
    case 'JOIN_REQUESTED':
      if (state.phase !== 'joinRoom' || state.joinRetryAfterMs !== 0) return state;
      return isCompleteRoomCode(state.joinCode)
        ? { ...state, phase: 'checkingAdmission' }
        : { ...state, error: { kind: 'incomplete-code' } };
    case 'CANCEL_REQUESTED':
      return state.phase === 'waiting' || state.phase === 'cancelFailed'
        ? { ...state, phase: 'cancelling' }
        : state;
    case 'WAIT_EXPIRED':
      return state.phase === 'waiting'
        ? { ...state, phase: 'expired', error: { kind: 'request', key: 'lobby.waitExpired' } }
        : state;
    case 'DISMISS_NOTICE':
      if (state.phase === 'expired') return { ...state, phase: 'checkingExpiry' };
      if (state.phase === 'notice')
        return { ...state, phase: 'home', error: null, waitingRoom: null };
      if (state.phase === 'createFailed' || state.phase === 'createNotice')
        return { ...state, phase: 'home', error: null };
      return state;
  }
}

function observeAccess(state: LobbyState, access: RoomAccessSnapshot): LobbyState {
  if (access.status === 'handoff' && access.target === 'game')
    return { ...state, phase: 'handoff' };
  // The cancellation result owns cleanup. Only confirmed gameplay can supersede it.
  if (state.phase === 'cancelling' || state.phase === 'cancelFailed') return state;
  if (access.status === 'handoff' && access.target === 'waiting')
    return { ...state, phase: 'waiting', waitingRoom: access.room, error: null };
  if (access.status === 'authorityFailure' && access.origin === 'session')
    return { ...state, phase: 'notice', error: lobbyError(access.error), waitingRoom: null };
  if (access.status === 'refreshRequired' && access.origin === 'session')
    return {
      ...state,
      phase: 'connectionFailed',
      error:
        access.error && access.error.kind !== 'transport'
          ? lobbyError(access.error)
          : { kind: 'request', key: 'lobby.reentryRefresh' },
    };
  if (access.status === 'connectionFailure')
    return { ...state, phase: 'connectionFailed', error: connectionFailureError(access.error) };
  return state;
}

export function admissionError(result: Extract<AdmissionResult, { status: 'failure' }>) {
  if (result.stage === 'response') return result.error;
  return readinessError(result.readiness);
}

function completeAdmission(
  state: LobbyState,
  operation: 'create' | 'join',
  result: AdmissionResult,
): LobbyState {
  if (result.status === 'blocked' || result.status === 'stale') return { ...state, phase: 'home' };
  if (result.status === 'installed')
    return {
      ...state,
      phase: operation === 'create' ? 'waiting' : 'matching',
      waitingRoom: operation === 'create' ? result.waitingRoom : state.waitingRoom,
    };
  if (result.status !== 'failure') return state;
  const error = lobbyError(admissionError(result));
  const retryReadiness =
    result.stage === 'readiness' && readinessFailureDisposition(result.readiness) === 'retry';
  if (operation === 'join')
    return {
      ...state,
      phase:
        retryReadiness || (result.stage === 'response' && isInlineJoinError(result.error))
          ? 'joinRoom'
          : 'connectionFailed',
      error,
      joinRetryAfterMs: error.kind === 'rate-limited' ? error.retryAfterMs : 0,
    };
  const disposition = result.stage === 'response' ? classifyCreateRoomFailure(result.error) : null;
  return {
    ...state,
    phase:
      retryReadiness || disposition === 'dismiss'
        ? 'createFailed'
        : disposition === 'notice'
          ? 'createNotice'
          : 'connectionFailed',
    error,
  };
}
function completeCancellation(state: LobbyState, result: Cancellation): LobbyState {
  switch (result.status) {
    case 'stale':
      return state;
    case 'cancelled':
      return { ...state, phase: 'home', error: null, waitingRoom: null };
    case 'matched':
      return { ...state, phase: 'matching' };
    case 'syncFailed':
      return { ...state, phase: 'connectionFailed', error: lobbyError(result.error) };
    case 'failure':
      if (isPermanentAuthorityFailure(result.error))
        return { ...state, phase: 'notice', error: lobbyError(result.error), waitingRoom: null };
      if (
        result.error.kind === 'protocol' ||
        isServerError(result.error, PUBLIC_ERROR_CODE.PROTOCOL_MISMATCH)
      )
        return { ...state, phase: 'connectionFailed', error: lobbyError(result.error) };
      return { ...state, phase: 'cancelFailed' };
  }
}
function completeExpiry(state: LobbyState, result: ExpiryCheck): LobbyState {
  switch (result.status) {
    case 'stale':
      return state;
    case 'gone':
      return { ...state, phase: 'home', error: null, waitingRoom: null };
    case 'waiting':
      return { ...state, phase: 'waiting', waitingRoom: result.room, error: null };
    case 'matched':
      return { ...state, phase: 'matching' };
    case 'failure':
      return { ...state, phase: 'connectionFailed', error: lobbyError(result.error) };
  }
}
