// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from 'vitest';

import { createProductExecution } from '@/app/product-execution';
import { createProductPreferences } from '@/runtime/preferences/product-preferences';
import { inactiveTelemetry } from '@/runtime/telemetry/telemetry';

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
  presentationStart: vi.fn(),
}));

vi.mock('@repo/game-client-sdk', () => ({ createGameClient: () => ({ clock: {} }) }));
vi.mock('@/runtime/audio/browser-audio-runtime', () => ({
  createBrowserAudioRuntime: () => ({ playCue: vi.fn(), dispose: fixture.audioDispose }),
}));
vi.mock('@/runtime/audio/game-audio-feedback', () => ({
  startGameAudioFeedback: () => ({ dispose: fixture.feedbackDispose }),
}));
vi.mock('@/runtime/dice/dice-presentation', () => ({
  createDicePresentation: () => ({
    start: fixture.presentationStart,
    dispose: fixture.presentationDispose,
  }),
}));
vi.mock('@/runtime/network/server-readiness', () => ({ createServerReadiness: () => ({}) }));
vi.mock('@/runtime/room-access/room-access', () => ({
  createRoomAccess: () => ({ dispose: fixture.accessDispose }),
}));
vi.mock('@/runtime/room-access/stored-room-restore', () => ({
  createStoredRoomRestore: () => ({ dispose: fixture.restoreDispose }),
}));
vi.mock('@/runtime/session/browser-session-store', () => ({
  createBrowserSessionStore: ({ signal }: { signal: AbortSignal }) => {
    fixture.activity = signal;
    return {};
  },
}));
vi.mock('@/runtime/session/session-holder', () => ({
  createGameSessionHolder: () => ({ dispose: fixture.sessionsDispose }),
}));
vi.mock('@/runtime/session/session-recovery', () => ({
  createSessionRecovery: () => ({ start: vi.fn(), dispose: fixture.recoveryDispose }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.order.length = 0;
  fixture.activity = undefined;
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

function createExecution() {
  return createProductExecution({
    serverUrl: 'https://game.example.com',
    releaseId: 'release',
    preferences: createProductPreferences({ getItem: () => null, setItem: () => undefined }),
    telemetry: inactiveTelemetry,
  });
}

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
