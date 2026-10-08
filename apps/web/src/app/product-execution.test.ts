// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from 'vitest';

import { createProductExecution } from '@/app/product-execution';
import type { DicePresentationOptions } from '@/runtime/dice/dice-presentation';
import { createPreferencesStore } from '@/runtime/preferences/preferences-store';
import { inactiveTelemetry, type Telemetry } from '@/runtime/telemetry/telemetry';

const fixture = vi.hoisted(() => ({
  order: [] as string[],
  activity: undefined as AbortSignal | undefined,
  accessDispose: vi.fn(),
  restoreDispose: vi.fn(),
  feedbackDispose: vi.fn(),
  recoveryDispose: vi.fn(),
  presentationDispose: vi.fn(),
  sessionsDispose: vi.fn(),
  audioDispose: vi.fn(),
  audioExposure: vi.fn(),
  feedbackExposure: vi.fn(),
  presentationStart: vi.fn(),
  presentationOptions: undefined as DicePresentationOptions | undefined,
  requireRefresh: vi.fn(),
}));

vi.mock('@repo/game-client-sdk', () => ({ createGameClient: () => ({ clock: {} }) }));
vi.mock('@/runtime/audio/browser-audio-runtime', () => ({
  createBrowserAudioRuntime: () => ({
    playCue: vi.fn(),
    dispose: fixture.audioDispose,
    setSurfaceExposed: fixture.audioExposure,
  }),
}));
vi.mock('@/runtime/audio/game-audio-feedback', () => ({
  startGameAudioFeedback: () => ({
    dispose: fixture.feedbackDispose,
    setSurfaceExposed: fixture.feedbackExposure,
  }),
}));
vi.mock('@/runtime/dice/dice-presentation', () => ({
  createDicePresentation: (options: DicePresentationOptions) => {
    fixture.presentationOptions = options;
    return { start: fixture.presentationStart, dispose: fixture.presentationDispose };
  },
}));
vi.mock('@/runtime/network/server-readiness', () => ({ createServerReadiness: () => ({}) }));
vi.mock('@/runtime/room-access/room-access', () => ({
  createRoomAccess: () => ({ dispose: fixture.accessDispose }),
}));
vi.mock('@/runtime/room-access/stored-room-reentry', () => ({
  createStoredRoomReentry: () => ({ dispose: fixture.restoreDispose }),
}));
vi.mock('@/runtime/session/session-credential-store', () => ({
  createSessionCredentialStore: ({ signal }: { signal: AbortSignal }) => {
    fixture.activity = signal;
    return {};
  },
}));
vi.mock('@/runtime/session/game-session-holder', () => ({
  createGameSessionHolder: () => ({ dispose: fixture.sessionsDispose }),
}));
vi.mock('@/runtime/session/session-recovery', () => ({
  createSessionRecovery: () => ({
    start: vi.fn(),
    dispose: fixture.recoveryDispose,
    requireRefreshAfterSynchronization: fixture.requireRefresh,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.order.length = 0;
  fixture.activity = undefined;
  fixture.presentationOptions = undefined;
  fixture.accessDispose.mockImplementation(() => fixture.order.push('access'));
  fixture.restoreDispose.mockImplementation(() => fixture.order.push('restore'));
  fixture.feedbackDispose.mockImplementation(() => fixture.order.push('feedback'));
  fixture.recoveryDispose.mockImplementation(() => fixture.order.push('recovery'));
  fixture.presentationDispose.mockImplementation(() => fixture.order.push('presentation'));
  fixture.sessionsDispose.mockImplementation(() => fixture.order.push('sessions'));
  fixture.audioDispose.mockImplementation(async () => {
    fixture.order.push('audio');
  });
  fixture.presentationStart.mockImplementation(() => undefined);
});

function createExecution(telemetry: Telemetry = inactiveTelemetry) {
  return createProductExecution({
    serverUrl: 'https://game.example.com',
    releaseId: 'release',
    preferences: createPreferencesStore({ getItem: () => null, setItem: () => undefined }),
    telemetry,
  });
}

test('starts covered and synchronously forwards exposure until execution stops', () => {
  const execution = createExecution();
  expect(fixture.audioExposure).toHaveBeenCalledExactlyOnceWith(false);
  expect(fixture.feedbackExposure).toHaveBeenCalledExactlyOnceWith(false);
  execution.setSurfaceExposed(true);
  expect(fixture.audioExposure).toHaveBeenLastCalledWith(true);
  expect(fixture.feedbackExposure).toHaveBeenLastCalledWith(true);
  execution.setSurfaceExposed(false);
  expect(fixture.audioExposure).toHaveBeenLastCalledWith(false);
  expect(fixture.feedbackExposure).toHaveBeenLastCalledWith(false);
  execution.stop();
  vi.clearAllMocks();
  execution.setSurfaceExposed(true);
  expect(fixture.audioExposure).not.toHaveBeenCalled();
  expect(fixture.feedbackExposure).not.toHaveBeenCalled();
});

test('aborts activity before stopping owned work once, including reentrant stop', () => {
  const execution = createExecution();
  execution.activity.addEventListener('abort', () => {
    fixture.order.push('abort');
    execution.stop();
  });

  execution.stop();
  execution.stop();

  expect(execution.activity.aborted).toBe(true);
  expect(fixture.order).toEqual([
    'abort',
    'access',
    'restore',
    'feedback',
    'recovery',
    'presentation',
    'sessions',
    'audio',
  ]);
});

test('releases acquired owners when starting presentation fails and preserves the error', () => {
  const failure = new Error('presentation start failed');
  fixture.presentationStart.mockImplementationOnce(() => {
    throw failure;
  });

  expect(createExecution).toThrow(failure);

  expect(fixture.activity?.aborted).toBe(true);
  expect(fixture.order).toEqual(['feedback', 'recovery', 'presentation', 'sessions', 'audio']);
  expect(fixture.restoreDispose).not.toHaveBeenCalled();
  expect(fixture.accessDispose).not.toHaveBeenCalled();
});

test.each([
  ['access', fixture.accessDispose],
  ['restore', fixture.restoreDispose],
  ['feedback', fixture.feedbackDispose],
  ['recovery', fixture.recoveryDispose],
  ['presentation', fixture.presentationDispose],
  ['sessions', fixture.sessionsDispose],
] as const)(
  'continues stopping all owners when %s cleanup throws and telemetry fails',
  (owner, dispose) => {
    const failure = new Error(`${owner} cleanup failed`);
    const reportUnexpected = vi.fn(() => {
      throw new Error('telemetry failed');
    });
    dispose.mockImplementationOnce(() => {
      fixture.order.push(owner);
      throw failure;
    });
    const execution = createExecution({ ...inactiveTelemetry, reportUnexpected });
    execution.activity.addEventListener('abort', execution.stop);

    expect(execution.stop).not.toThrow();
    execution.stop();

    expect(execution.activity.aborted).toBe(true);
    expect(fixture.order).toEqual([
      'access',
      'restore',
      'feedback',
      'recovery',
      'presentation',
      'sessions',
      'audio',
    ]);
    expect(reportUnexpected).toHaveBeenCalledExactlyOnceWith(failure);
  },
);

test.each(['throw', 'reject'] as const)(
  'accepts audio dispose %s after synchronous stop and reports its cause once',
  async (kind) => {
    const failure = new Error('native close failed');
    if (kind === 'throw')
      fixture.audioDispose.mockImplementationOnce(() => {
        throw failure;
      });
    else fixture.audioDispose.mockRejectedValueOnce(failure);
    const reportUnexpected = vi.fn(() => {
      throw new Error('telemetry failed');
    });
    const execution = createExecution({ ...inactiveTelemetry, reportUnexpected });

    expect(execution.stop()).toBeUndefined();
    expect(execution.activity.aborted).toBe(true);
    execution.stop();
    await vi.waitFor(() =>
      expect(reportUnexpected).toHaveBeenCalledExactlyOnceWith(failure, { stage: 'audio' }),
    );
    expect(fixture.audioDispose).toHaveBeenCalledOnce();
  },
);

test('preserves startup error identity when acquired-owner cleanup also fails', () => {
  const startupFailure = new Error('presentation start failed');
  const cleanupFailure = new Error('feedback cleanup failed');
  fixture.presentationStart.mockImplementationOnce(() => {
    throw startupFailure;
  });
  fixture.feedbackDispose.mockImplementationOnce(() => {
    throw cleanupFailure;
  });
  const reportUnexpected = vi.fn();
  let caught: unknown;

  try {
    createExecution({ ...inactiveTelemetry, reportUnexpected });
  } catch (error) {
    caught = error;
  }

  expect(caught).toBe(startupFailure);
  expect(fixture.activity?.aborted).toBe(true);
  expect(fixture.recoveryDispose).toHaveBeenCalledOnce();
  expect(fixture.presentationDispose).toHaveBeenCalledOnce();
  expect(fixture.sessionsDispose).toHaveBeenCalledOnce();
  expect(fixture.audioDispose).toHaveBeenCalledOnce();
  expect(reportUnexpected).toHaveBeenCalledExactlyOnceWith(cleanupFailure);
});

test.each([new Error('simulation failed'), 'simulation failed', undefined])(
  'reports simulation fallback cause %s once and requests refresh without raw fields',
  (cause) => {
    const reportUnexpected = vi.fn();
    const execution = createExecution({ ...inactiveTelemetry, reportUnexpected });
    const failure = {
      status: 'static-fallback',
      rollId: 'private-roll',
      dice: [{ slot: 0, value: 6 }],
      reason: 'SIMULATION_FAILED',
      cause,
    } as const;
    fixture.presentationOptions?.requireRefreshAfterSynchronization(failure);

    expect(reportUnexpected).toHaveBeenCalledExactlyOnceWith(cause, {
      stage: 'replay',
      replay_reason: 'SIMULATION_FAILED',
    });
    expect(fixture.requireRefresh).toHaveBeenCalledExactlyOnceWith();
    execution.stop();
  },
);

test('reports an outcome mismatch once with its reason and requests refresh', () => {
  const reportUnexpected = vi.fn();
  const execution = createExecution({ ...inactiveTelemetry, reportUnexpected });
  fixture.presentationOptions?.requireRefreshAfterSynchronization({ reason: 'OUTCOME_MISMATCH' });

  expect(reportUnexpected).toHaveBeenCalledExactlyOnceWith(new Error('OUTCOME_MISMATCH'), {
    stage: 'replay',
    replay_reason: 'OUTCOME_MISMATCH',
  });
  expect(fixture.requireRefresh).toHaveBeenCalledExactlyOnceWith();
  execution.stop();
});
