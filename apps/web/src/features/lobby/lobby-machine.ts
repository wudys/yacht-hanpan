import type { ClientError } from '@repo/game-client-sdk/errors';
import { PUBLIC_ERROR_CODE } from '@repo/game-protocol';
import { assign, fromCallback, fromPromise, setup, type SnapshotFrom } from 'xstate';

import {
  connectionFailureError,
  createFailureDisposition,
  isInlineJoinError,
  isServerError,
  type LobbyError,
  lobbyError,
  readinessError,
} from '@/features/lobby/lobby-errors';
import { isCompleteRoomCode, normalizeRoomCode } from '@/features/lobby/room-code';
import type { ProductProfile } from '@/runtime/profile/product-profile';
import type {
  AdmissionResult,
  Cancellation,
  ExpiryCheck,
  RoomAccess,
  WaitingRoomSummary,
} from '@/runtime/room-access/room-access';
import { isPermanentAuthorityFailure } from '@/runtime/session/authority-failure';
import { reportClientFailure } from '@/runtime/telemetry/error-policy';
import { clientFailureFields, type Telemetry } from '@/runtime/telemetry/telemetry';

type Operation = 'create' | 'join' | 'cancel';
type Profile = ReturnType<ProductProfile['getSnapshot']>['selection'];
interface LobbyContext {
  admissionOperation: 'create' | 'join';
  joinCode: string;
  joinRetryAfterMs: number;
  error: LobbyError | null;
  waitingRoom: WaitingRoomSummary | null;
  requestProfile: Profile;
  requestStarted: number;
  waitingStarted: number | null;
}
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
        | 'RETRY_CANCEL'
        | 'WAIT_EXPIRED'
        | 'DISMISS_NOTICE'
        | 'SOURCES_CHANGED'
        | 'SESSION_REPLACED';
    }
  | { type: 'JOIN_CODE_CHANGED'; code: string };
export type LobbyServices = Readonly<{
  activity: AbortSignal;
  access: RoomAccess;
  profile: ProductProfile;
}>;
interface AdmissionDone {
  event: { output: AdmissionResult };
}
interface ExpiryDone {
  event: { output: ExpiryCheck };
}
interface CancelDone {
  event: { output: Cancellation };
}
function admissionError(result: AdmissionResult): ClientError | null {
  if (result.status !== 'failure') return null;
  return result.stage === 'response' ? result.error : readinessError(result.readiness);
}

export function createLobbyMachine(
  { activity, access, profile }: LobbyServices,
  telemetry: Telemetry,
  navigateToGame: () => void,
) {
  const recordResult = (
    context: Pick<LobbyContext, 'requestStarted'>,
    operation: Operation,
    phase: 'success' | 'failure',
    error?: ClientError,
  ) => {
    telemetry.trackEvent({
      name: 'room_request',
      operation,
      phase,
      duration_ms: Math.max(0, Math.round(performance.now() - context.requestStarted)),
      ...(phase === 'failure' ? clientFailureFields(error) : {}),
    });
    if (error) reportClientFailure(telemetry, error, { operation, stage: 'response' });
  };
  const waitingResult = (context: LobbyContext, outcome: 'matched' | 'cancelled' | 'expired') => {
    if (context.waitingStarted !== null)
      telemetry.trackEvent({
        name: 'waiting_result',
        outcome,
        duration_ms: Math.round(performance.now() - context.waitingStarted),
      });
  };
  return setup({
    types: { context: {} as LobbyContext, events: {} as LobbyEvent },
    guards: {
      hasCompleteJoinCode: ({ context }) =>
        context.joinRetryAfterMs === 0 && isCompleteRoomCode(context.joinCode),
      activeAdmission: () => !activity.aborted && access.getSnapshot().status !== 'idle',
    },
    actors: {
      sources: fromCallback(({ sendBack }) => {
        const stop = access.subscribe(() => sendBack({ type: 'SOURCES_CHANGED' }));
        const replaced = () => sendBack({ type: 'SESSION_REPLACED' });
        activity.addEventListener('abort', replaced, { once: true });
        if (activity.aborted) replaced();
        else access.checkStoredRoom();
        sendBack({ type: 'SOURCES_CHANGED' });
        return () => {
          activity.removeEventListener('abort', replaced);
          stop();
        };
      }),
      create: fromPromise(({ input, signal }: { input: Profile; signal: AbortSignal }) =>
        access.create(input, signal),
      ),
      join: fromPromise(
        ({
          input,
          signal,
        }: {
          input: { profile: Profile; roomCode: string };
          signal: AbortSignal;
        }) => access.join(input, signal),
      ),
      checkExpiry: fromPromise<ExpiryCheck>(({ signal }) => access.checkWaitingExpiry(signal)),
      cancel: fromPromise<Cancellation, number>(({ input, signal }) =>
        access.cancelWaiting(signal, (error) =>
          recordResult({ requestStarted: input }, 'cancel', error ? 'failure' : 'success', error),
        ),
      ),
    },
    actions: {
      unexpectedFailure: assign(
        (
          { context },
          { cause, operation }: { cause: unknown; operation: Operation | 'synchronize' },
        ) => {
          telemetry.reportUnexpected(cause, { operation, stage: 'promise' });
          // Cancellation records only its HTTP response, before any follow-up sync.
          if (operation === 'create' || operation === 'join')
            recordResult(context, operation, 'failure');
          return { error: { kind: 'request' as const, key: 'lobby.reentryRefresh' as const } };
        },
      ),
      beginCreate: assign(() => {
        telemetry.trackEvent({ name: 'room_request', operation: 'create', phase: 'start' });
        return {
          error: null,
          requestProfile: profile.getSnapshot().selection,
          requestStarted: performance.now(),
        };
      }),
      beginJoin: assign(({ context }) => {
        telemetry.trackEvent({ name: 'room_request', operation: 'join', phase: 'start' });
        return {
          error: context.error?.kind === 'rate-limited' ? null : context.error,
          requestProfile: profile.getSnapshot().selection,
          requestStarted: performance.now(),
        };
      }),
      beginCancel: assign(() => {
        telemetry.trackEvent({ name: 'room_request', operation: 'cancel', phase: 'start' });
        return { requestStarted: performance.now() };
      }),
      createFailure: assign(({ context }, { error }: { error: ClientError | null }) => {
        if (error === null) return {};
        recordResult(context, 'create', 'failure', error);
        return { error: lobbyError(error) };
      }),
      joinFailure: assign(({ context }, { error }: { error: ClientError | null }) => {
        if (error === null) return {};
        recordResult(context, 'join', 'failure', error);
        const failure = lobbyError(error);
        return {
          error: failure,
          joinRetryAfterMs: failure.kind === 'rate-limited' ? failure.retryAfterMs : 0,
        };
      }),
      dismissAuthority: () => access.confirmAuthorityFailure(),
    },
  }).createMachine({
    id: 'lobby',
    context: {
      admissionOperation: 'create',
      joinCode: '',
      joinRetryAfterMs: 0,
      error: null,
      waitingRoom: null,
      requestProfile: profile.getSnapshot().selection,
      requestStarted: 0,
      waitingStarted: null,
    },
    initial: 'home',
    invoke: { src: 'sources' },
    on: {
      RATE_LIMIT_CLEARED: { actions: assign({ joinRetryAfterMs: 0 }) },
      SESSION_REPLACED: '.replaced',
      SOURCES_CHANGED: [
        {
          guard: () => {
            const state = access.getSnapshot();
            return state.status === 'handoff' && state.target === 'game';
          },
          target: '.handoff',
        },
        {
          guard: () => {
            const state = access.getSnapshot();
            return state.status === 'handoff' && state.target === 'waiting';
          },
          target: '.admitted.waiting',
          actions: assign(() => {
            const state = access.getSnapshot();
            return state.status === 'handoff' && state.target === 'waiting'
              ? { waitingRoom: state.room, error: null }
              : {};
          }),
        },
        {
          guard: () => {
            const state = access.getSnapshot();
            return state.status === 'authorityFailure' && state.origin === 'session';
          },
          target: '.notice',
          actions: assign(() => {
            const state = access.getSnapshot();
            return state.status === 'authorityFailure'
              ? { error: lobbyError(state.error), waitingRoom: null, waitingStarted: null }
              : {};
          }),
        },
        {
          guard: () => {
            const state = access.getSnapshot();
            return state.status === 'refreshRequired' && state.origin === 'session';
          },
          target: '.connectionFailed',
          actions: assign(() => {
            const state = access.getSnapshot();
            return state.status === 'refreshRequired'
              ? {
                  error:
                    state.error && state.error.kind !== 'transport'
                      ? lobbyError(state.error)
                      : { kind: 'request' as const, key: 'lobby.reentryRefresh' as const },
                }
              : {};
          }),
        },
        {
          guard: () => access.getSnapshot().status === 'connectionFailure',
          target: '.connectionFailed',
          actions: assign(() => {
            const failed = access.getSnapshot();
            if (failed.status !== 'connectionFailure') return {};
            if ('cause' in failed)
              telemetry.reportUnexpected(failed.cause, {
                operation: 'synchronize',
                stage: 'promise',
              });
            return {
              error: connectionFailureError(failed.error),
            };
          }),
        },
      ],
    },
    states: {
      replaced: { type: 'final' },
      home: {
        on: {
          OPEN_PROFILE: 'profile',
          OPEN_SETTINGS: 'settings',
          OPEN_JOIN_ROOM: { target: 'joinRoom', actions: assign({ error: null }) },
          CREATE_REQUESTED: {
            target: 'checkingAdmission',
            actions: assign({ admissionOperation: 'create' }),
          },
        },
      },
      profile: { on: { CLOSE_PROFILE: 'home' } },
      settings: { on: { CLOSE_SETTINGS: 'home' } },
      checkingAdmission: {
        entry: () => access.checkStoredRoom(),
        always: [
          {
            guard: () =>
              ['restoring', 'authorityFailure', 'refreshRequired'].includes(
                access.getSnapshot().status,
              ),
            target: 'home',
          },
          {
            guard: ({ context }: { context: LobbyContext }): boolean =>
              context.admissionOperation === 'join',
            target: 'joining',
            actions: 'beginJoin',
          },
          { target: 'creating', actions: 'beginCreate' },
        ],
      },
      creating: {
        invoke: {
          src: 'create',
          input: ({ context }) => context.requestProfile,
          onError: {
            target: 'connectionFailed',
            actions: {
              type: 'unexpectedFailure',
              params: ({ event }) => ({ cause: event.error, operation: 'create' }),
            },
          },
          onDone: [
            {
              guard: ({ event }: AdmissionDone) => event.output.status === 'installed',
              target: 'admitted.waiting',
              actions: assign(({ context, event }) => {
                if (event.output.status !== 'installed') return {};
                recordResult(context, 'create', 'success');
                return {
                  waitingRoom: event.output.waitingRoom,
                };
              }),
            },
            {
              guard: ({ event }: AdmissionDone) =>
                event.output.status === 'blocked' || event.output.status === 'stale',
              target: 'home',
            },
            {
              guard: ({ event }: AdmissionDone) =>
                event.output.status === 'failure' &&
                event.output.stage === 'readiness' &&
                event.output.readiness.reason !== 'incompatible' &&
                event.output.readiness.reason !== 'invalid-response',
              target: 'createFailed',
              actions: {
                type: 'createFailure',
                params: ({ event }) => ({ error: admissionError(event.output) }),
              },
            },
            {
              guard: ({ event }: AdmissionDone) =>
                event.output.status === 'failure' &&
                event.output.stage === 'response' &&
                createFailureDisposition(event.output.error) === 'retry',
              target: 'createFailed',
              actions: {
                type: 'createFailure',
                params: ({ event }) => ({ error: admissionError(event.output) }),
              },
            },
            {
              guard: ({ event }: AdmissionDone) =>
                event.output.status === 'failure' &&
                event.output.stage === 'response' &&
                createFailureDisposition(event.output.error) === 'notice',
              target: 'createNotice',
              actions: {
                type: 'createFailure',
                params: ({ event }) => ({ error: admissionError(event.output) }),
              },
            },
            {
              target: 'connectionFailed',
              actions: {
                type: 'createFailure',
                params: ({ event }) => ({ error: admissionError(event.output) }),
              },
            },
          ],
        },
      },
      joinRoom: {
        on: {
          JOIN_CODE_CHANGED: {
            actions: assign({
              joinCode: ({ event }) => normalizeRoomCode(event.code),
              error: null,
            }),
          },
          JOIN_CODE_FOCUSED: {
            guard: ({ context }) => context.error?.kind === 'incomplete-code',
            actions: assign({ error: null }),
          },
          JOIN_REQUESTED: [
            {
              guard: 'hasCompleteJoinCode',
              target: 'checkingAdmission',
              actions: assign({ admissionOperation: 'join' }),
            },
            {
              guard: ({ context }) => context.joinRetryAfterMs === 0,
              actions: assign({ error: { kind: 'incomplete-code' } }),
            },
          ],
          CLOSE_JOIN_ROOM: { target: 'home', actions: assign({ joinCode: '', error: null }) },
        },
      },
      joining: {
        invoke: {
          src: 'join',
          input: ({ context }) => ({ profile: context.requestProfile, roomCode: context.joinCode }),
          onError: {
            target: 'connectionFailed',
            actions: {
              type: 'unexpectedFailure',
              params: ({ event }) => ({ cause: event.error, operation: 'join' }),
            },
          },
          onDone: [
            {
              guard: ({ event }: AdmissionDone) => event.output.status === 'installed',
              target: 'admitted.matching',
              actions: assign(({ context }) => {
                recordResult(context, 'join', 'success');
                return {};
              }),
            },
            {
              guard: ({ event }: AdmissionDone) =>
                event.output.status === 'blocked' || event.output.status === 'stale',
              target: 'home',
            },
            {
              guard: ({ event }: AdmissionDone) =>
                event.output.status === 'failure' &&
                ((event.output.stage === 'response' && isInlineJoinError(event.output.error)) ||
                  (event.output.stage === 'readiness' &&
                    event.output.readiness.reason !== 'incompatible' &&
                    event.output.readiness.reason !== 'invalid-response')),
              target: 'joinRoom',
              actions: {
                type: 'joinFailure',
                params: ({ event }) => ({ error: admissionError(event.output) }),
              },
            },
            {
              target: 'connectionFailed',
              actions: {
                type: 'joinFailure',
                params: ({ event }) => ({ error: admissionError(event.output) }),
              },
            },
          ],
        },
      },
      admitted: {
        initial: 'waiting',
        states: {
          waiting: {
            entry: [
              assign({
                waitingStarted: ({ context }) => context.waitingStarted ?? performance.now(),
              }),
              () => access.completeHandoff(),
            ],
            on: {
              CANCEL_REQUESTED: {
                target: 'cancelling',
                // Cancellation now owns the outcome; a late connect failure cannot interrupt cleanup.
                actions: 'beginCancel',
              },
              WAIT_EXPIRED: {
                guard: () => {
                  const state = access.getSnapshot();
                  return !(state.status === 'handoff' && state.target === 'game');
                },
                target: '#lobby.expired',
                actions: assign({ error: { kind: 'request', key: 'lobby.waitExpired' } }),
              },
            },
          },
          cancelling: {
            on: {
              SOURCES_CHANGED: [
                {
                  guard: () => {
                    const state = access.getSnapshot();
                    return state.status === 'handoff' && state.target === 'game';
                  },
                  target: '#lobby.handoff',
                },
                {},
              ],
            },
            invoke: {
              src: 'cancel',
              onError: [
                {
                  guard: 'activeAdmission',
                  target: '#lobby.connectionFailed',
                  actions: {
                    type: 'unexpectedFailure',
                    params: ({ event }) => ({ cause: event.error, operation: 'cancel' }),
                  },
                },
                {},
              ],
              input: ({ context }) => context.requestStarted,
              onDone: [
                {
                  guard: ({ event }: CancelDone): boolean => event.output.status === 'cancelled',
                  target: '#lobby.home',
                  actions: assign(({ context }) => {
                    waitingResult(context, 'cancelled');
                    return { waitingRoom: null, error: null, waitingStarted: null };
                  }),
                },
                {
                  guard: ({ event }: CancelDone): boolean => event.output.status === 'matched',
                  target: 'matching',
                },
                {
                  guard: ({ event }: CancelDone): boolean => event.output.status === 'syncFailed',
                  target: '#lobby.connectionFailed',
                  actions: assign(({ event }) => {
                    if (event.output.status !== 'syncFailed') return {};
                    return { error: lobbyError(event.output.error) };
                  }),
                },
                {
                  guard: ({ event }: CancelDone): boolean =>
                    event.output.status === 'failure' &&
                    isPermanentAuthorityFailure(event.output.error),
                  target: '#lobby.notice',
                  actions: assign(({ event }) => {
                    if (event.output.status !== 'failure') return {};
                    return {
                      error: lobbyError(event.output.error),
                      waitingRoom: null,
                      waitingStarted: null,
                    };
                  }),
                },
                {
                  guard: ({ event }: CancelDone): boolean =>
                    event.output.status === 'failure' &&
                    (event.output.error.kind === 'protocol' ||
                      isServerError(event.output.error, PUBLIC_ERROR_CODE.PROTOCOL_MISMATCH)),
                  target: '#lobby.connectionFailed',
                  actions: assign(({ event }) =>
                    event.output.status === 'failure'
                      ? { error: lobbyError(event.output.error) }
                      : {},
                  ),
                },
                {
                  guard: ({ event }: CancelDone): boolean => event.output.status === 'failure',
                  target: 'cancelFailed',
                },
              ],
            },
          },
          cancelFailed: {
            on: {
              SOURCES_CHANGED: [
                {
                  guard: () => {
                    const state = access.getSnapshot();
                    return state.status === 'handoff' && state.target === 'game';
                  },
                  target: '#lobby.handoff',
                },
                {},
              ],
              RETRY_CANCEL: { target: 'cancelling', actions: 'beginCancel' },
            },
          },
          matching: {},
        },
      },
      expired: { on: { DISMISS_NOTICE: 'checkingExpiry' } },
      checkingExpiry: {
        invoke: {
          src: 'checkExpiry',
          onDone: [
            {
              guard: ({ event }: ExpiryDone): boolean => event.output.status === 'gone',
              target: 'home',
              actions: assign(({ context }) => {
                waitingResult(context, 'expired');
                return { waitingRoom: null, error: null, waitingStarted: null };
              }),
            },
            {
              guard: ({ event }: ExpiryDone): boolean => event.output.status === 'waiting',
              target: 'admitted.waiting',
              actions: assign(({ event }) =>
                event.output.status === 'waiting'
                  ? { waitingRoom: event.output.room, error: null }
                  : {},
              ),
            },
            {
              guard: ({ event }: ExpiryDone): boolean => event.output.status === 'matched',
              target: 'admitted.matching',
            },
            {
              guard: ({ event }: ExpiryDone): boolean => event.output.status === 'failure',
              target: 'connectionFailed',
              actions: assign(({ event }) => {
                if (event.output.status !== 'failure') return {};
                reportClientFailure(telemetry, event.output.error, {
                  operation: 'synchronize',
                  stage: 'response',
                });
                return { error: lobbyError(event.output.error) };
              }),
            },
          ],
          onError: [
            {
              guard: 'activeAdmission',
              target: 'connectionFailed',
              actions: {
                type: 'unexpectedFailure',
                params: ({ event }) => ({ cause: event.error, operation: 'synchronize' }),
              },
            },
            {},
          ],
        },
      },
      notice: {
        on: {
          DISMISS_NOTICE: {
            target: 'home',
            actions: [
              'dismissAuthority',
              assign({ waitingRoom: null, error: null, waitingStarted: null }),
            ],
          },
        },
      },
      createFailed: {
        on: {
          DISMISS_NOTICE: { target: 'home', actions: assign({ error: null }) },
        },
      },
      createNotice: {
        on: { DISMISS_NOTICE: { target: 'home', actions: assign({ error: null }) } },
      },
      connectionFailed: {},
      handoff: {
        type: 'final',
        entry: ({ context }) => {
          waitingResult(context, 'matched');
          access.completeHandoff();
          navigateToGame();
        },
      },
    },
  });
}
export type LobbySnapshot = SnapshotFrom<ReturnType<typeof createLobbyMachine>>;
export type LobbyView =
  | 'replaced'
  | 'home'
  | 'profile'
  | 'settings'
  | 'checkingAdmission'
  | 'creating'
  | 'joining'
  | 'joinRoom'
  | 'waiting'
  | 'cancelling'
  | 'cancelFailed'
  | 'matching'
  | 'expired'
  | 'checkingExpiry'
  | 'notice'
  | 'createFailed'
  | 'createNotice'
  | 'connectionFailed';

export function selectLobbyView({ value }: Pick<LobbySnapshot, 'value'>): LobbyView {
  if (typeof value === 'string') return value === 'handoff' ? 'matching' : value;
  if ('admitted' in value) return value.admitted;
  const unhandled: never = value;
  return unhandled;
}
