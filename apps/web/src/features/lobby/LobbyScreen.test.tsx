// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- this suite also verifies explicitly mounted root teardown. */
import type {
  GameClient,
  GameSession,
  GameSessionSnapshot,
  RoomAuthority,
} from '@repo/game-client-sdk';
import {
  CLIENT_ERROR_CODE,
  createProtocolError,
  createTransportError,
} from '@repo/game-client-sdk/errors';
import { createRoomHttpClient } from '@repo/game-client-sdk/http';
import { createCompatibilityContract } from '@repo/game-protocol/version';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';

import LobbyScreen from '@/features/lobby/LobbyScreen';
import { LOCALE, type Locale, translate } from '@/i18n';
import type { BrowserAudioRuntime } from '@/runtime/audio/browser-audio-runtime';
import { AUDIO_CUE } from '@/runtime/audio/cue-runtime';
import type { ServerReadiness } from '@/runtime/network/server-readiness';
import {
  createPreferencesStore,
  type PreferencesStore,
} from '@/runtime/preferences/preferences-store';
import { createProfileSelectionStore } from '@/runtime/profile/profile-selection-store';
import { createRoomAccess } from '@/runtime/room-access/room-access';
import type {
  StoredRoomReentry,
  StoredRoomReentrySnapshot,
} from '@/runtime/room-access/stored-room-reentry';
import type {
  GameSessionHolder,
  GameSessionHolderSnapshot,
} from '@/runtime/session/game-session-holder';
import {
  createSessionCredentialStore,
  type RecentRoomResult,
  type SessionCredentialStore,
} from '@/runtime/session/session-credential-store';
import type { SessionRecovery, SessionRecoverySnapshot } from '@/runtime/session/session-recovery';
import { createTelemetry, inactiveTelemetry, type Telemetry } from '@/runtime/telemetry/telemetry';
import { TelemetryContext } from '@/runtime/telemetry/TelemetryContext';

const navigate = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => navigate,
}));

const AUTHORITY = {
  roomId: '019cebf0-79b8-7a22-8000-000000000001',
  seatToken: '019cebf0-79b8-7a22-8000-000000000002',
  seatIndex: 0,
} as RoomAuthority;

const WAITING_ROOM = {
  roomId: AUTHORITY.roomId,
  roomCode: '001234',
  status: 'waiting',
  createdAt: 1_000,
  expiresAt: 61_000,
  seats: [{ profile: { characterId: 'navy-bob', variant: false } }],
} as const;

const WAITING_VIEW = {
  room: WAITING_ROOM,
  game: null,
  presence: {
    roomId: AUTHORITY.roomId,
    presenceVersion: 0,
    seats: [{ status: 'disconnected', reconnectDeadlineAt: null }],
  },
} as const;

afterEach(() => {
  cleanup();
  navigate.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function deferred<T>() {
  let resolveDeferred!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

function createAudio(): BrowserAudioRuntime {
  return {
    supported: true,
    activate: vi.fn(() => Promise.resolve()),
    prepareCues: vi.fn(() => Promise.resolve()),
    playCue: vi.fn(),
    setSfxEnabled: vi.fn(),
    setSurfaceExposed: vi.fn(),
    stopCue: vi.fn(),
    prefetchScenes: vi.fn(() => Promise.resolve()),
    setBgmEnabled: vi.fn(() => Promise.resolve()),
    setScene: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(() => Promise.resolve()),
  };
}

function createSession(): GameSession {
  const snapshot: GameSessionSnapshot = {
    connection: 'idle',
    syncStatus: 'idle',
    syncRevision: 0,
    room: null,
    game: null,
    presence: null,
    presentation: null,
    error: null,
  };
  const unavailable = () =>
    Promise.resolve({
      ok: false as const,
      error: createTransportError(CLIENT_ERROR_CODE.NETWORK_UNAVAILABLE),
    });
  return {
    connect: vi.fn(() => Promise.resolve({ ok: true as const })),
    disconnect: vi.fn(),
    dispose: vi.fn(),
    synchronize: vi.fn(() => Promise.resolve({ ok: true as const })),
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    rollDice: vi.fn(unavailable),
    setDieHeld: vi.fn(unavailable),
    selectScoreCategory: vi.fn(unavailable),
    forfeitMatch: vi.fn(unavailable),
  };
}

function createRecovery() {
  let snapshot: SessionRecoverySnapshot = { status: 'idle' };
  const listeners = new Set<() => void>();
  const value: SessionRecovery = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeAttempt: () => () => {},
    start: vi.fn(),
    dispose: vi.fn(),
    requestSynchronization: vi.fn(),
    requireRefreshAfterSynchronization: vi.fn(),
    reportCommandError: vi.fn(),
  };
  return {
    value,
    publish(next: SessionRecoverySnapshot) {
      snapshot = next;
      listeners.forEach((listener) => listener());
    },
  };
}

function createHolder(session: GameSession): GameSessionHolder {
  let snapshot: GameSessionHolderSnapshot = {
    authority: null,
    room: null,
    session: null,
    sessionSnapshot: null,
  };
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach((listener) => listener());
  return {
    installAuthority(
      authority: RoomAuthority,
      initialRoom: Parameters<GameSessionHolder['installAuthority']>[1],
    ) {
      const sessionSnapshot = session.getSnapshot();
      snapshot = {
        authority,
        room:
          sessionSnapshot.room ?? (initialRoom?.roomId === authority.roomId ? initialRoom : null),
        session,
        sessionSnapshot,
      };
      publish();
      return session;
    },
    setProvisionalRoom(room: Parameters<GameSessionHolder['setProvisionalRoom']>[0]) {
      if (
        !snapshot.authority ||
        snapshot.sessionSnapshot.room !== null ||
        room.roomId !== snapshot.authority.roomId ||
        snapshot.room === room ||
        (room.status === 'waiting' && snapshot.room !== null && snapshot.room.status !== 'waiting')
      )
        return;
      snapshot = { ...snapshot, room };
      publish();
    },
    clear() {
      snapshot = { authority: null, room: null, session: null, sessionSnapshot: null };
      publish();
    },
    detachFinishedSession: vi.fn(() => false),
    dispose: vi.fn(),
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function createStore(): SessionCredentialStore {
  let recentRoom: RecentRoomResult = {
    status: 'ready',
    room: null,
  };
  return {
    getSnapshot: () => ({ persistence: 'saved' }),
    subscribe: () => () => {},
    removeRoom: vi.fn(() => {}),
    initialize: () => ({
      clientId: '019cebf0-79b8-7a22-8000-000000000003',
      recentRoom,
    }),
    getClientId: () => '019cebf0-79b8-7a22-8000-000000000003',
    refreshRecentRoom: () => recentRoom,
    recordRoom(authority: Parameters<SessionCredentialStore['recordRoom']>[0]) {
      recentRoom = {
        status: 'ready',
        room: {
          roomId: authority.roomId,
          seatToken: authority.seatToken,
        },
      };
    },
  };
}

function renderLobby(
  client: GameClient,
  {
    session = createSession(),
    preferences = createPreferencesStore({ getItem: () => null, setItem: vi.fn() }),
    readiness = createReadiness(),
    reentry = createReentry().value,
    recovery = createRecovery().value,
    telemetry = inactiveTelemetry,
    sessionCredentialStore = createStore(),
    locale = LOCALE.EN,
  }: {
    session?: GameSession;
    preferences?: PreferencesStore;
    readiness?: ServerReadiness;
    reentry?: StoredRoomReentry;
    recovery?: SessionRecovery;
    telemetry?: Telemetry;
    sessionCredentialStore?: SessionCredentialStore;
    locale?: Locale;
  } = {},
) {
  preferences.setLocale(locale);
  const sessions = createHolder(session);
  const profileStorage = {
    getItem: () => JSON.stringify({ characterId: 'navy-bob', variant: false }),
    setItem: vi.fn(),
  };
  const profile = createProfileSelectionStore(profileStorage);
  profile.initialize();
  const audio = createAudio();
  const activity = new AbortController().signal;
  const access = createRoomAccess({
    activity,
    client,
    sessions,
    sessionCredentialStore,
    readiness,
    reentry: reentry,
    recovery,
  });
  render(
    <TelemetryContext.Provider value={telemetry}>
      <LobbyScreen
        activity={activity}
        access={access}
        audio={audio}
        locale={locale}
        clock={client.clock}
        profile={profile}
        preferences={preferences}
      />
    </TelemetryContext.Provider>,
  );
  return {
    audio,
    profile,
    profileStorage,
    preferences,
    reentry,
    session,
    sessions,
    sessionCredentialStore,
  };
}

function createReadiness(): ServerReadiness {
  return { wait: vi.fn(() => Promise.resolve({ ok: true as const })) };
}

function createReentry(initial: StoredRoomReentrySnapshot = { status: 'idle' }) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const publish = (next: StoredRoomReentrySnapshot) => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  const value: StoredRoomReentry = {
    check: vi.fn(),
    completeHandoff: vi.fn(() => publish({ status: 'idle' })),
    confirmPermanentFailure: vi.fn(() => publish({ status: 'idle' })),
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeAttempt: () => () => {},
    dispose: vi.fn(),
  };
  return {
    value,
    publish,
  };
}

test('opens profile as a locked scene layer and applies a character immediately', () => {
  const client = { clock: { now: () => 1_000 } } as unknown as GameClient;
  const { profile, profileStorage } = renderLobby(client);

  expect(
    screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.profile') }).innerHTML,
  ).not.toContain('player-avatar__self');

  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.profile') }));

  expect(screen.getByTestId('lobby-screen').getAttribute('data-lobby-view')).toBe('profile');
  expect(screen.getByRole('group', { name: 'Choose your character' })).toBeTruthy();
  expect(
    screen
      .getByRole('button', { name: translate(LOCALE.EN, 'lobby.createRoom') })
      .getAttribute('aria-disabled'),
  ).toBe('true');

  fireEvent.click(screen.getByRole('button', { name: 'onyx-topknot' }));

  expect(profileStorage.setItem).toHaveBeenCalledWith(
    'profileSelection',
    JSON.stringify({ characterId: 'onyx-topknot', variant: false }),
  );
  expect(profile.getSnapshot().selection.characterId).toBe('onyx-topknot');
  expect(screen.getByRole('button', { name: 'onyx-topknot' }).getAttribute('aria-pressed')).toBe(
    'true',
  );

  const orderedIds = () =>
    within(screen.getByRole('group', { name: 'Choose your character' }))
      .getAllByRole('button')
      .map((element) => element.getAttribute('data-character-id'));
  const style1Order = orderedIds();
  fireEvent.click(screen.getByRole('tab', { name: 'Style 2' }));
  expect(orderedIds()).toEqual(style1Order);
  expect(style1Order).toHaveLength(12);
  expect(profileStorage.setItem).toHaveBeenCalledTimes(1);
  expect(
    within(screen.getByRole('group', { name: 'Choose your character' })).queryByRole('button', {
      pressed: true,
    }),
  ).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'onyx-topknot' }));
  expect(profileStorage.setItem).toHaveBeenLastCalledWith(
    'profileSelection',
    JSON.stringify({ characterId: 'onyx-topknot', variant: true }),
  );
  expect(profile.getSnapshot().selection.variant).toBe(true);

  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.getByTestId('lobby-screen').getAttribute('data-lobby-view')).toBe('home');
});

test('opens the shared lobby settings layer and closes back to home', () => {
  const client = { clock: { now: () => 1_000 } } as unknown as GameClient;
  const { preferences } = renderLobby(client);

  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

  expect(screen.getByTestId('lobby-screen').getAttribute('data-lobby-view')).toBe('settings');
  expect(screen.getByRole('switch', { name: 'Music' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Forfeit' })).toBeNull();

  fireEvent.click(screen.getByRole('switch', { name: 'Music' }));
  expect(preferences.getSnapshot().bgmEnabled).toBe(false);

  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.getByTestId('lobby-screen').getAttribute('data-lobby-view')).toBe('home');
});

test.each([
  { open: 'Profile Settings', control: 'onyx-topknot' },
  { open: 'Settings', control: 'Close' },
  { open: 'Join Game', control: 'Join' },
])('makes the home background inert while $open remains usable', ({ open, control }) => {
  renderLobby({ clock: { now: () => 1_000 } } as unknown as GameClient);
  const background = screen.getByRole('main');
  expect(background.hasAttribute('inert')).toBe(false);

  fireEvent.click(screen.getByRole('button', { name: open }));

  expect(background.hasAttribute('inert')).toBe(true);
  const activeControl = screen.getByRole('button', { name: control });
  // eslint-disable-next-line testing-library/no-node-access -- the active control must be outside the inert background.
  expect(activeControl.closest('[inert]')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(background.hasAttribute('inert')).toBe(false);
});

test('waits for server readiness before sending one create mutation', async () => {
  vi.useFakeTimers();
  const ready = deferred<Awaited<ReturnType<ServerReadiness['wait']>>>();
  const readiness: ServerReadiness = { wait: vi.fn(() => ready.promise) };
  const mutation = deferred<Awaited<ReturnType<GameClient['createRoom']>>>();
  const createRoom = vi.fn(() => mutation.promise);
  const client = { clock: { now: () => 1_000 }, createRoom } as unknown as GameClient;
  renderLobby(client, { session: createSession(), readiness });

  const createButton = screen.getByRole('button', {
    name: translate(LOCALE.EN, 'lobby.createRoom'),
  });
  fireEvent.click(createButton);
  fireEvent.click(createButton);

  expect(readiness.wait).toHaveBeenCalledOnce();
  expect(createRoom).not.toHaveBeenCalled();

  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(screen.getByText(translate(LOCALE.EN, 'lobby.serverPreparing'))).toBeTruthy();

  await act(async () => {
    ready.resolve({ ok: true });
    await ready.promise;
  });

  expect(createRoom).toHaveBeenCalledOnce();
});

test.each(['create', 'join'] as const)(
  'does not submit %s after unmounting during server readiness',
  async (operation) => {
    const ready = deferred<Awaited<ReturnType<ServerReadiness['wait']>>>();
    const wait = vi.fn<ServerReadiness['wait']>(() => ready.promise);
    const createRoom = vi.fn();
    const joinRoom = vi.fn();
    const client = { clock: { now: () => 1_000 }, createRoom, joinRoom } as unknown as GameClient;
    renderLobby(client, { session: createSession(), readiness: { wait } });

    if (operation === 'create') {
      fireEvent.click(
        screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.createRoom') }),
      );
    } else {
      fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.joinRoom') }));
      fireEvent.paste(screen.getByRole('textbox', { name: 'Room code' }), {
        clipboardData: { getData: () => '001234' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    }

    expect(wait).toHaveBeenCalledOnce();
    const signal = wait.mock.calls[0]![0];
    expect(signal?.aborted).toBe(false);
    cleanup();
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      ready.resolve({ ok: true });
      await ready.promise;
    });
    expect(createRoom).not.toHaveBeenCalled();
    expect(joinRoom).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  },
);

test('activates recent-room reentry before the first Lobby frame can expose admission', () => {
  const reentry = createReentry();
  vi.mocked(reentry.value.check).mockImplementation(() => reentry.publish({ status: 'checking' }));
  const activity = new AbortController().signal;
  const client = { clock: { now: () => 1_000 } } as unknown as GameClient;
  const sessions = createHolder(createSession());
  const sessionCredentialStore = createStore();
  const readiness = createReadiness();
  const access = createRoomAccess({
    activity,
    client,
    sessions,
    sessionCredentialStore,
    readiness,
    reentry: reentry.value,
    recovery: createRecovery().value,
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const profile = createProfileSelectionStore({ getItem: () => null, setItem: vi.fn() }, () => 0);
  profile.initialize();

  flushSync(() => {
    root.render(
      <LobbyScreen
        activity={activity}
        access={access}
        audio={createAudio()}
        locale={LOCALE.EN}
        clock={client.clock}
        profile={profile}
        preferences={createPreferencesStore({ getItem: () => null, setItem: vi.fn() })}
      />,
    );
  });

  const committed = within(host);
  expect(committed.getByTestId('lobby-screen').getAttribute('data-reentry-state')).toBe('checking');
  expect(
    committed
      .getByRole('button', { name: translate(LOCALE.EN, 'lobby.createRoom') })
      .getAttribute('aria-disabled'),
  ).toBe('true');

  flushSync(() => root.unmount());
  host.remove();
});

test('offers dismissal when server readiness is unavailable', async () => {
  const readiness: ServerReadiness = {
    wait: vi.fn(() => Promise.resolve({ ok: false as const, reason: 'unavailable' as const })),
  };
  const createRoom = vi.fn();
  const client = { clock: { now: () => 1_000 }, createRoom } as unknown as GameClient;
  renderLobby(client, { session: createSession(), readiness });

  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.createRoom') }));

  expect(await screen.findByRole('alertdialog')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  expect(createRoom).not.toHaveBeenCalled();
});

test('keeps an unavailable join readiness failure inline without mutating', async () => {
  const readiness: ServerReadiness = {
    wait: vi.fn(() => Promise.resolve({ ok: false as const, reason: 'unavailable' as const })),
  };
  const joinRoom = vi.fn();
  const client = { clock: { now: () => 1_000 }, joinRoom } as unknown as GameClient;
  renderLobby(client, { session: createSession(), readiness });
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.joinRoom') }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '001234' } });

  fireEvent.click(screen.getByRole('button', { name: 'Join' }));

  expect((await screen.findByRole('alert')).textContent).toBe(
    translate(LOCALE.EN, 'error.networkUnavailable'),
  );
  expect(joinRoom).not.toHaveBeenCalled();
});

test('routes incompatible server readiness to refresh without mutating', async () => {
  const readiness: ServerReadiness = {
    wait: vi.fn(() => Promise.resolve({ ok: false as const, reason: 'incompatible' as const })),
  };
  const createRoom = vi.fn();
  const client = { clock: { now: () => 1_000 }, createRoom } as unknown as GameClient;
  renderLobby(client, { session: createSession(), readiness });

  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.createRoom') }));

  expect(await screen.findByRole('button', { name: 'Refresh' })).toBeTruthy();
  expect(createRoom).not.toHaveBeenCalled();
});

test('adopts a resumed waiting room with the create title and waiting status in the body', async () => {
  const reentry = createReentry({
    status: 'waiting',
    roomCode: WAITING_ROOM.roomCode,
    expiresAt: WAITING_ROOM.expiresAt,
  });
  const client = { clock: { now: () => 1_000 } } as unknown as GameClient;

  renderLobby(client, { session: createSession(), reentry: reentry.value });

  expect(await screen.findByText(WAITING_ROOM.roomCode)).toBeTruthy();
  expect(
    screen.getByRole('heading', { name: translate(LOCALE.EN, 'lobby.createRoom') }),
  ).toBeTruthy();
  expect(screen.getByRole('status').textContent).toContain(
    translate(LOCALE.EN, 'lobby.waitingForOpponent'),
  );
  expect(screen.getByRole('main').hasAttribute('inert')).toBe(true);
  expect(reentry.value.completeHandoff).toHaveBeenCalledOnce();
  expect(reentry.value.check).toHaveBeenCalledOnce();
});

test('shows copy failure inline for 1.2 seconds', async () => {
  const writeText = vi.fn(() => Promise.reject(new Error('clipboard unavailable')));
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const client = {
    clock: { now: () => 1_000 },
    createRoom: vi.fn(() =>
      Promise.resolve({
        ok: true,
        data: { authority: AUTHORITY, view: WAITING_VIEW },
        meta: {},
      }),
    ),
  } as unknown as GameClient;
  renderLobby(client);
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.createRoom') }));
  await screen.findByText(WAITING_ROOM.roomCode);
  vi.useFakeTimers();

  const copyButton = screen.getByRole('button', {
    name: translate(LOCALE.EN, 'lobby.copy'),
  });
  fireEvent.click(copyButton);
  await act(async () => {
    await Promise.resolve();
  });

  expect(screen.getByRole('alert').textContent?.length).toBeGreaterThan(0);
  expect(copyButton.getAttribute('data-copy-status')).toBe('failed');

  await act(async () => vi.advanceTimersByTime(1_199));
  expect(screen.getByRole('alert')).toBeTruthy();
  await act(async () => vi.advanceTimersByTime(1));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(copyButton.getAttribute('data-copy-status')).toBe('idle');
});

test('ignores delayed clipboard completion after cancellation and room replacement', async () => {
  const clipboard = deferred<void>();
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(() => clipboard.promise) } });
  const nextAuthority = {
    ...AUTHORITY,
    roomId: '019cebf0-79b8-7a22-8000-000000000004',
    seatToken: '019cebf0-79b8-7a22-8000-000000000005',
  } as RoomAuthority;
  const nextRoom = {
    ...WAITING_ROOM,
    roomId: nextAuthority.roomId,
    roomCode: '005678',
  } as const;
  const createRoom = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      data: { authority: AUTHORITY, view: WAITING_VIEW },
      meta: {},
    })
    .mockResolvedValueOnce({
      ok: true,
      data: {
        authority: nextAuthority,
        view: {
          ...WAITING_VIEW,
          room: nextRoom,
          presence: { ...WAITING_VIEW.presence, roomId: nextAuthority.roomId },
        },
      },
      meta: {},
    });
  const client = {
    clock: { now: () => 1_000 },
    createRoom,
    cancelRoom: vi.fn(() => Promise.resolve({ ok: true, data: {}, meta: {} })),
  } as unknown as GameClient;
  renderLobby(client);

  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.createRoom') }));
  await screen.findByText(WAITING_ROOM.roomCode);
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.copy') }));
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.cancelWait') }));
  await screen.findByRole('button', { name: translate(LOCALE.EN, 'lobby.createRoom') });
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.createRoom') }));
  await screen.findByText(nextRoom.roomCode);

  await act(async () => {
    clipboard.resolve();
    await clipboard.promise;
  });

  expect(
    screen
      .getByRole('button', { name: translate(LOCALE.EN, 'lobby.copy') })
      .getAttribute('data-copy-status'),
  ).toBe('idle');
  expect(screen.queryByRole('alert')).toBeNull();
});

test('navigates a resumed match only after the coordinator publishes gameReady', async () => {
  const reentry = createReentry({ status: 'synchronizing' });
  const client = { clock: { now: () => 1_000 } } as unknown as GameClient;
  renderLobby(client, { session: createSession(), reentry: reentry.value });

  expect(navigate).not.toHaveBeenCalled();

  await act(async () => reentry.publish({ status: 'gameReady' }));

  expect(navigate).toHaveBeenCalledOnce();
  expect(reentry.value.completeHandoff).toHaveBeenCalledOnce();
});

test.each([LOCALE.KO, LOCALE.EN])(
  'keeps synchronizing progress and admission blocked through a restored Game handoff (%s)',
  async (locale) => {
    const reentry = createReentry({ status: 'synchronizing' });
    vi.mocked(reentry.value.completeHandoff).mockImplementation(() => {});
    const createRoom = vi.fn<GameClient['createRoom']>();
    const client = { clock: { now: () => 1_000 }, createRoom } as unknown as GameClient;
    const { audio } = renderLobby(client, { reentry: reentry.value, locale });
    const create = screen.getByRole('button', { name: translate(locale, 'lobby.createRoom') });

    expect(screen.getByRole('status').textContent).toBe(
      translate(locale, 'lobby.reentrySynchronizing'),
    );
    expect(create.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(create);
    expect(createRoom).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(reentry.value.completeHandoff).not.toHaveBeenCalled();

    await act(async () => reentry.publish({ status: 'gameReady' }));

    expect(screen.getByRole('status').textContent).toBe(
      translate(locale, 'lobby.reentrySynchronizing'),
    );
    expect(create.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(create);
    expect(createRoom).not.toHaveBeenCalled();
    expect(audio.playCue).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith({ to: '/game', replace: true });
    expect(reentry.value.completeHandoff).toHaveBeenCalledOnce();
  },
);

test('confirms a permanent reentry failure through the coordinator', () => {
  const error = {
    kind: 'server' as const,
    error: { code: 'ROOM_NOT_FOUND' as const, params: {} },
  };
  const reentry = createReentry({ status: 'permanentFailure', error });
  const client = { clock: { now: () => 1_000 } } as unknown as GameClient;
  renderLobby(client, { session: createSession(), reentry: reentry.value });

  expect(screen.getByRole('main').hasAttribute('inert')).toBe(true);
  expect(screen.getByText(translate(LOCALE.EN, 'error.gameNotFound'))).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'common.confirm') }));

  expect(reentry.value.confirmPermanentFailure).toHaveBeenCalledOnce();
});

test('deduplicates create intent and waits for an authoritative game before navigation', async () => {
  const request = deferred<Awaited<ReturnType<GameClient['createRoom']>>>();
  const createRoom = vi.fn(() => request.promise);
  const client = {
    clock: { now: () => 1_000 },
    createRoom,
  } as unknown as GameClient;
  const { session, sessions, sessionCredentialStore } = renderLobby(client);

  const createButton = screen.getByRole('button', {
    name: translate(LOCALE.EN, 'lobby.createRoom'),
  });
  fireEvent.click(createButton);
  fireEvent.click(createButton);
  await act(() => Promise.resolve());
  expect(createRoom).toHaveBeenCalledOnce();

  await act(async () => {
    request.resolve({
      ok: true,
      data: { authority: AUTHORITY, view: WAITING_VIEW },
      meta: {},
    } as Awaited<ReturnType<GameClient['createRoom']>>);
    await request.promise;
  });

  expect(screen.getByRole('main').hasAttribute('inert')).toBe(true);
  expect(screen.getByText('001234').getAttribute('data-room-code')).toBe('001234');
  expect(sessionCredentialStore.initialize().recentRoom).toEqual({
    status: 'ready',
    room: {
      roomId: AUTHORITY.roomId,
      seatToken: AUTHORITY.seatToken,
    },
  });
  expect(sessions.getSnapshot().room).toBe(WAITING_ROOM);
  expect(session.connect).toHaveBeenCalledOnce();
  expect(navigate).not.toHaveBeenCalled();
});

test('validates an incomplete join code on submit and clears that error on focus or editing', () => {
  const joinRoom = vi.fn();
  renderLobby({ clock: { now: () => 1_000 }, joinRoom } as unknown as GameClient);
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.joinRoom') }));
  const input = screen.getByRole('textbox', { name: 'Room code' });
  const submit = screen.getByRole('button', { name: 'Join' });

  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.click(submit);
  expect(screen.getByRole('alert')).not.toBeNull();
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(joinRoom).not.toHaveBeenCalled();

  fireEvent.focus(input);
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.change(input, { target: { value: '00123' } });
  fireEvent.click(submit);
  expect(screen.getByRole('alert')).not.toBeNull();
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(joinRoom).not.toHaveBeenCalled();

  fireEvent.change(input, { target: { value: '0012' } });
  expect(screen.queryByRole('alert')).toBeNull();
});

test('keeps leading zeroes, strips pasted non-digits, and renders join errors inline', async () => {
  const joinRoom = vi.fn(() =>
    Promise.resolve({
      ok: false,
      error: { kind: 'server', error: { code: 'ROOM_NOT_FOUND', params: {} } },
    }),
  );
  const client = { clock: { now: () => 1_000 }, joinRoom } as unknown as GameClient;
  renderLobby(client);

  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.joinRoom') }));
  const input = screen.getByRole('textbox', { name: 'Room code' });
  fireEvent.paste(input, { clipboardData: { getData: () => '0a0123456' } });
  expect((input as HTMLInputElement).value).toBe('001234');
  fireEvent.click(screen.getByRole('button', { name: 'Join' }));

  expect((await screen.findByRole('alert')).textContent?.length).toBeGreaterThan(0);
  expect((input as HTMLInputElement).value).toBe('001234');
  expect(joinRoom).toHaveBeenCalledOnce();
});

test('places the caret and active cell after the normalized pasted code', async () => {
  const client = { clock: { now: () => 1_000 } } as unknown as GameClient;
  renderLobby(client);
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.joinRoom') }));
  const input = screen.getByRole('textbox', { name: 'Room code' });

  fireEvent.paste(input, { clipboardData: { getData: () => '0a0123456' } });

  expect((input as HTMLInputElement).selectionStart).toBe(6);
  expect(screen.getByText('4').getAttribute('data-active-cell')).toBe('true');
});

test('closes waiting before cancel settles and synchronizes a matched cancel race', async () => {
  const cancellation = deferred<Awaited<ReturnType<GameClient['cancelRoom']>>>();
  const cancelRoom = vi.fn(() => cancellation.promise);
  const client = {
    clock: { now: () => 1_000 },
    createRoom: vi.fn(() =>
      Promise.resolve({
        ok: true,
        data: { authority: AUTHORITY, view: WAITING_VIEW },
        meta: {},
      }),
    ),
    cancelRoom,
  } as unknown as GameClient;
  const { session, sessions } = renderLobby(client);

  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.createRoom') }));
  await screen.findByText('001234');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

  expect(screen.queryByText('001234')).toBeNull();
  expect(
    screen
      .getByRole('button', { name: translate(LOCALE.EN, 'lobby.createRoom') })
      .getAttribute('aria-disabled'),
  ).toBe('true');
  expect(cancelRoom).toHaveBeenCalledWith(
    {
      roomId: AUTHORITY.roomId,
      seatToken: AUTHORITY.seatToken,
    },
    { signal: expect.any(AbortSignal) },
  );

  await act(async () => {
    cancellation.resolve({
      ok: false,
      error: {
        kind: 'server',
        error: { code: 'ROOM_ALREADY_MATCHED', params: {} },
      },
    });
    await cancellation.promise;
  });

  expect(session.synchronize).toHaveBeenCalledOnce();
  expect(sessions.getSnapshot().authority).toBe(AUTHORITY);
});

test('shows a create rate limit as a notice without a new-creation action or seconds', async () => {
  const createRoom = vi.fn(async () => ({
    ok: false,
    error: {
      kind: 'server',
      error: { code: 'RATE_LIMITED', params: { retryAfterMs: 56_000 } },
    },
  }));
  renderLobby({ clock: { now: () => 1_000 }, createRoom } as unknown as GameClient);
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.createRoom') }));
  const notice = await screen.findByRole('alertdialog', { name: 'Notice' });
  expect(notice.textContent).not.toMatch(/56|Loading failed|Create new game/u);
  expect(screen.queryByRole('button', { name: 'Create new game' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'OK' }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(createRoom).toHaveBeenCalledOnce();
});

test('keeps rate-limit feedback after expiry without styling the code as invalid', async () => {
  vi.useFakeTimers();
  const joinRoom = vi.fn<GameClient['joinRoom']>(async () => ({
    ok: false,
    error: { kind: 'server', error: { code: 'RATE_LIMITED', params: { retryAfterMs: 1_000 } } },
  }));
  renderLobby({ clock: { now: () => 1_000 }, joinRoom } as unknown as GameClient);
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.joinRoom') }));
  const input = screen.getByRole('textbox', { name: 'Room code' }) as HTMLInputElement;
  const join = screen.getByRole('button', { name: 'Join' }) as HTMLButtonElement;
  fireEvent.change(input, { target: { value: '001234' } });
  fireEvent.click(join);
  await act(() => Promise.resolve());

  expect(screen.getByRole('alert').textContent).toBe('Please try again shortly.');
  expect(input.disabled).toBe(false);
  expect(input.hasAttribute('aria-invalid')).toBe(false);
  expect(join.disabled).toBe(false);
  expect(join.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(join);
  expect(joinRoom).toHaveBeenCalledOnce();

  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  expect(join.getAttribute('aria-disabled')).toBe('false');
  expect(screen.getByRole('alert').textContent).toBe('Please try again shortly.');
  expect(joinRoom).toHaveBeenCalledOnce();
  fireEvent.change(input, { target: { value: '001235' } });
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.click(join);
  await act(() => Promise.resolve());
  expect(joinRoom).toHaveBeenCalledTimes(2);
});

test('editing and reopening the join form cannot bypass its retry interval', async () => {
  vi.useFakeTimers();
  const joinRoom = vi.fn<GameClient['joinRoom']>(async () => ({
    ok: false,
    error: { kind: 'server', error: { code: 'RATE_LIMITED', params: { retryAfterMs: 1_000 } } },
  }));
  renderLobby({ clock: { now: () => 1_000 }, joinRoom } as unknown as GameClient);
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.joinRoom') }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '001234' } });
  fireEvent.click(screen.getByRole('button', { name: 'Join' }));
  await act(() => Promise.resolve());
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '001235' } });
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Join' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.joinRoom') }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '001236' } });
  fireEvent.click(screen.getByRole('button', { name: 'Join' }));
  await act(() => Promise.resolve());
  expect(joinRoom).toHaveBeenCalledOnce();
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  fireEvent.click(screen.getByRole('button', { name: 'Join' }));
  await act(() => Promise.resolve());
  expect(joinRoom).toHaveBeenCalledTimes(2);
});

test('keeps code rejection visible during retry and clears it when the code changes', async () => {
  const retry = deferred<Awaited<ReturnType<GameClient['joinRoom']>>>();
  const rejection = {
    ok: false as const,
    error: { kind: 'server' as const, error: { code: 'ROOM_NOT_FOUND' as const, params: {} } },
  };
  const joinRoom = vi
    .fn<GameClient['joinRoom']>()
    .mockResolvedValueOnce(rejection)
    .mockReturnValueOnce(retry.promise);
  renderLobby({ clock: { now: () => 1_000 }, joinRoom } as unknown as GameClient);
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.joinRoom') }));
  const input = screen.getByRole('textbox') as HTMLInputElement;
  fireEvent.change(input, { target: { value: '001234' } });
  fireEvent.click(screen.getByRole('button', { name: 'Join' }));
  const message = await screen.findByRole('alert');
  const originalMessage = message.textContent;
  fireEvent.click(screen.getByRole('button', { name: 'Join' }));
  await act(() => Promise.resolve());
  expect(screen.getByRole('alert')).toBe(message);
  expect(message.textContent).toBe(originalMessage);
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(input.disabled).toBe(false);
  expect(input.readOnly).toBe(true);
  fireEvent.paste(input, { clipboardData: { getData: () => '999999' } });
  expect(input.value).toBe('001234');
  await act(async () => retry.resolve(rejection));
  expect(input.readOnly).toBe(false);
  expect(message.textContent).toBe(originalMessage);
  fireEvent.change(input, { target: { value: '001235' } });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(input.hasAttribute('aria-invalid')).toBe(false);
});

test('promotes a non-continuable join failure to the refresh modal', async () => {
  const client = {
    clock: { now: () => 1_000 },
    joinRoom: vi.fn(() =>
      Promise.resolve({
        ok: false,
        error: createTransportError(CLIENT_ERROR_CODE.NETWORK_UNAVAILABLE),
      }),
    ),
  } as unknown as GameClient;
  renderLobby(client);
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.joinRoom') }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '001234' } });
  fireEvent.click(screen.getByRole('button', { name: 'Join' }));

  expect(
    await screen.findByRole('alertdialog', {
      name: translate(LOCALE.EN, 'lobby.connectionFailedTitle'),
    }),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
});

test('closes creation failure before a new lobby creation uses a separate operation', async () => {
  const requests: string[] = [];
  const http = createRoomHttpClient({
    contract: createCompatibilityContract('test-release'),
    baseUrl: 'https://game.example.test',
    fetch: async (_url, init) => {
      requests.push(String(init?.body));
      throw new TypeError('response lost');
    },
  });
  const trackEvent = vi.fn();
  const telemetry: Telemetry = { ...inactiveTelemetry, trackEvent };
  const client = { ...http, clock: { now: () => 1_000 } } as unknown as GameClient;
  renderLobby(client, { telemetry });
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.createRoom') }));
  const notice = await screen.findByRole('alertdialog');
  expect(within(notice).getAllByRole('button')).toHaveLength(1);
  const close = within(notice).getByRole('button', { name: 'Close' });
  expect(requests).toHaveLength(2);
  expect(requests[0]).toBe(requests[1]);
  fireEvent.click(close);
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(requests).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.createRoom') }));
  expect(await screen.findByRole('alertdialog')).toBeTruthy();
  expect(requests).toHaveLength(4);
  expect(requests[2]).toBe(requests[3]);
  expect(JSON.parse(requests[0]!).body.operationId).not.toBe(
    JSON.parse(requests[2]!).body.operationId,
  );
  expect(trackEvent.mock.calls.filter(([event]) => event.phase === 'start')).toEqual([
    [{ name: 'room_request', operation: 'create', phase: 'start' }],
    [{ name: 'room_request', operation: 'create', phase: 'start' }],
  ]);
});

test('routes a create protocol mismatch to refresh instead of retry', async () => {
  const client = {
    clock: { now: () => 1_000 },
    createRoom: vi.fn(() =>
      Promise.resolve({
        ok: false,
        error: createProtocolError(CLIENT_ERROR_CODE.PROTOCOL_MISMATCH),
      }),
    ),
  } as unknown as GameClient;
  renderLobby(client);
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.createRoom') }));

  expect(
    await screen.findByRole('alertdialog', {
      name: translate(LOCALE.EN, 'lobby.connectionFailedTitle'),
    }),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
});

test('shows waiting-room recovery and preserves authority on exhausted recovery', async () => {
  const recovery = createRecovery();
  const client = {
    clock: { now: () => 1_000 },
    createRoom: vi.fn(() =>
      Promise.resolve({ ok: true, data: { authority: AUTHORITY, view: WAITING_VIEW }, meta: {} }),
    ),
  } as unknown as GameClient;
  const { sessionCredentialStore, sessions } = renderLobby(client, { recovery: recovery.value });
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.createRoom') }));
  await screen.findByText(WAITING_ROOM.roomCode);
  await act(async () => recovery.publish({ status: 'reconnecting' }));
  expect(screen.queryByText(translate(LOCALE.EN, 'lobby.waitingForOpponent'))).toBeNull();
  expect(screen.getByText('Reconnecting')).toBeTruthy();
  expect(screen.getByRole('main').hasAttribute('inert')).toBe(true);
  await act(async () => recovery.publish({ status: 'synchronizing' }));
  expect(screen.getByText(translate(LOCALE.EN, 'lobby.reentrySynchronizing'))).toBeTruthy();
  await act(async () => recovery.publish({ status: 'idle' }));
  expect(screen.getByText(translate(LOCALE.EN, 'lobby.waitingForOpponent'))).toBeTruthy();
  await act(async () => recovery.publish({ status: 'refreshRequired', error: null }));
  expect(screen.getByRole('main').hasAttribute('inert')).toBe(true);
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
  expect(screen.queryByText(WAITING_ROOM.roomCode)).toBeNull();
  expect(sessions.getSnapshot().authority).toBe(AUTHORITY);
  expect(sessionCredentialStore.removeRoom).not.toHaveBeenCalled();
});

test('clears an invalid waiting-room authority only after confirming recovery failure', async () => {
  const recovery = createRecovery();
  const client = {
    clock: { now: () => 1_000 },
    createRoom: vi.fn(() =>
      Promise.resolve({ ok: true, data: { authority: AUTHORITY, view: WAITING_VIEW }, meta: {} }),
    ),
  } as unknown as GameClient;
  const { sessionCredentialStore, sessions } = renderLobby(client, { recovery: recovery.value });
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.createRoom') }));
  await screen.findByText(WAITING_ROOM.roomCode);
  await act(async () =>
    recovery.publish({
      status: 'permanentFailure',
      error: { kind: 'server', error: { code: 'ROOM_NOT_FOUND', params: {} } },
    }),
  );
  expect(sessionCredentialStore.removeRoom).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'OK' }));
  expect(sessionCredentialStore.removeRoom).toHaveBeenCalledWith(AUTHORITY.roomId);
  expect(sessions.getSnapshot().authority).toBeNull();
});

test('surfaces a connection failure with a bounded refresh action', async () => {
  const session = createSession();
  vi.mocked(session.connect).mockResolvedValue({
    ok: false,
    error: createTransportError(CLIENT_ERROR_CODE.NETWORK_UNAVAILABLE),
  });
  const client = {
    clock: { now: () => 1_000 },
    createRoom: vi.fn(() =>
      Promise.resolve({
        ok: true,
        data: { authority: AUTHORITY, view: WAITING_VIEW },
        meta: {},
      }),
    ),
  } as unknown as GameClient;
  renderLobby(client, { session });
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.createRoom') }));

  expect(
    await screen.findByRole('alertdialog', {
      name: translate(LOCALE.EN, 'lobby.connectionFailedTitle'),
    }),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
  expect(screen.getByText(translate(LOCALE.EN, 'lobby.reentryRefresh'))).toBeTruthy();
  expect(session.disconnect).toHaveBeenCalledOnce();
});

test('keeps transient cancellation failure modal retry-only', async () => {
  const client = {
    clock: { now: () => 1_000 },
    createRoom: vi.fn(() =>
      Promise.resolve({
        ok: true,
        data: { authority: AUTHORITY, view: WAITING_VIEW },
        meta: {},
      }),
    ),
    cancelRoom: vi.fn(() =>
      Promise.resolve({
        ok: false,
        error: createTransportError(CLIENT_ERROR_CODE.NETWORK_UNAVAILABLE),
      }),
    ),
  } as unknown as GameClient;
  renderLobby(client);
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.createRoom') }));
  await screen.findByText('001234');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

  expect(
    await screen.findByRole('alertdialog', {
      name: translate(LOCALE.EN, 'lobby.cancelFailedTitle'),
    }),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
});

test.each([
  createProtocolError(CLIENT_ERROR_CODE.PROTOCOL_MISMATCH),
  { kind: 'server', error: { code: 'PROTOCOL_MISMATCH', params: {} } } as const,
])('requires refresh after cancellation compatibility failure %j', async (error) => {
  const client = {
    clock: { now: () => 1_000 },
    createRoom: vi.fn(() =>
      Promise.resolve({
        ok: true,
        data: { authority: AUTHORITY, view: WAITING_VIEW },
        meta: {},
      }),
    ),
    cancelRoom: vi.fn(() => Promise.resolve({ ok: false, error })),
  } as unknown as GameClient;
  const { sessionCredentialStore } = renderLobby(client);
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.createRoom') }));
  await screen.findByText('001234');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(
    await screen.findByRole('alertdialog', {
      name: translate(LOCALE.EN, 'lobby.connectionFailedTitle'),
    }),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  expect(sessionCredentialStore.removeRoom).not.toHaveBeenCalled();
});

test('cleans permanent cancel failures only after confirmation', async () => {
  const client = {
    clock: { now: () => 1_000 },
    createRoom: vi.fn(() =>
      Promise.resolve({
        ok: true,
        data: { authority: AUTHORITY, view: WAITING_VIEW },
        meta: {},
      }),
    ),
    cancelRoom: vi.fn(() =>
      Promise.resolve({
        ok: false,
        error: { kind: 'server', error: { code: 'ROOM_NOT_FOUND', params: {} } },
      }),
    ),
  } as unknown as GameClient;
  const event = vi.fn();
  const { sessions, sessionCredentialStore } = renderLobby(client, {
    telemetry: { ...inactiveTelemetry, trackEvent: event },
  });
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.createRoom') }));
  await screen.findByText('001234');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

  expect(
    await screen.findByRole('alertdialog', {
      name: translate(LOCALE.EN, 'common.noticeTitle'),
    }),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  expect(sessions.getSnapshot().authority).toBe(AUTHORITY);

  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'common.confirm') }));
  expect(sessions.getSnapshot().authority).toBeNull();
  expect(sessionCredentialStore.removeRoom).toHaveBeenCalledWith(AUTHORITY.roomId);
  expect(
    event.mock.calls.map(([value]) => value).filter((value) => value.name === 'waiting_result'),
  ).toEqual([]);
});

test.each(['success', 'storage failure'] as const)(
  'clears a cancelled session and ignores late connection failure after cleanup %s',
  async (cleanupResult) => {
    const connection = deferred<Awaited<ReturnType<GameSession['connect']>>>();
    const session = createSession();
    vi.mocked(session.connect).mockReturnValue(connection.promise);
    const client = {
      clock: { now: () => 1_000 },
      createRoom: vi.fn(() =>
        Promise.resolve({
          ok: true,
          data: { authority: AUTHORITY, view: WAITING_VIEW },
          meta: {},
        }),
      ),
      cancelRoom: vi.fn(() => Promise.resolve({ ok: true, data: {}, meta: {} })),
    } as unknown as GameClient;
    const event = vi.fn();
    const sessionCredentialStore = createSessionCredentialStore({
      storage: {
        getItem: () => null,
        setItem() {},
        removeItem() {
          if (cleanupResult === 'storage failure') throw new Error('storage denied');
        },
      },
    });
    vi.spyOn(sessionCredentialStore, 'removeRoom');
    renderLobby(client, {
      session,
      telemetry: {
        ...inactiveTelemetry,
        trackEvent: event,
      },
      sessionCredentialStore,
    });
    fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.createRoom') }));
    await screen.findByText('001234');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByRole('button', { name: translate(LOCALE.EN, 'lobby.createRoom') });
    expect(sessionCredentialStore.removeRoom).toHaveBeenCalledWith(AUTHORITY.roomId);

    await act(async () => {
      connection.resolve({
        ok: false,
        error: createTransportError(CLIENT_ERROR_CODE.NETWORK_UNAVAILABLE),
      });
      await connection.promise;
    });

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(
      event.mock.calls.map(([value]) => value).filter((value) => value.name === 'waiting_result'),
    ).toEqual([{ name: 'waiting_result', outcome: 'cancelled', duration_ms: expect.any(Number) }]);
  },
);

test('finishes cancellation when the old connection fails before the HTTP reply', async () => {
  const cancellation = deferred<{ ok: true; data: {}; meta: {} }>();
  const connection = deferred<Awaited<ReturnType<GameSession['connect']>>>();
  const session = createSession();
  vi.mocked(session.connect).mockReturnValue(connection.promise);
  const client = {
    clock: { now: () => 1_000 },
    createRoom: vi.fn(() =>
      Promise.resolve({ ok: true, data: { authority: AUTHORITY, view: WAITING_VIEW }, meta: {} }),
    ),
    cancelRoom: vi.fn(() => cancellation.promise),
  } as unknown as GameClient;
  const { sessions } = renderLobby(client, { session });
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.createRoom') }));
  await screen.findByText('001234');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await act(() => Promise.resolve());
  await act(async () => {
    connection.resolve({
      ok: false,
      error: createTransportError(CLIENT_ERROR_CODE.NETWORK_UNAVAILABLE),
    });
    await connection.promise;
  });
  expect(screen.queryByRole('alertdialog')).toBeNull();
  await act(async () => {
    cancellation.resolve({ ok: true, data: {}, meta: {} });
    await cancellation.promise;
  });
  expect(sessions.getSnapshot().session).toBeNull();
  expect(
    screen
      .getByRole('button', { name: translate(LOCALE.EN, 'lobby.createRoom') })
      .getAttribute('aria-disabled'),
  ).toBe('false');
});

test('does not clear a replacement session when the cancellation HTTP reply arrives late', async () => {
  const cancellation = deferred<{ ok: true; data: {}; meta: {} }>();
  const client = {
    clock: { now: () => 1_000 },
    createRoom: vi.fn(() =>
      Promise.resolve({ ok: true, data: { authority: AUTHORITY, view: WAITING_VIEW }, meta: {} }),
    ),
    cancelRoom: vi.fn(() => cancellation.promise),
  } as unknown as GameClient;
  const { sessions, sessionCredentialStore } = renderLobby(client);
  const clear = vi.spyOn(sessions, 'clear');
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.createRoom') }));
  await screen.findByText('001234');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await act(() => Promise.resolve());
  const active = sessions.getSnapshot();
  if (!active.authority) throw new Error('expected admitted session');
  const replacement = { ...active, session: createSession() };
  vi.spyOn(sessions, 'getSnapshot').mockReturnValue(replacement);
  await act(async () => {
    cancellation.resolve({ ok: true, data: {}, meta: {} });
    await cancellation.promise;
  });
  expect(clear).not.toHaveBeenCalled();
  expect(sessionCredentialStore.removeRoom).not.toHaveBeenCalled();
});

test('keeps a failed profile selection applied and clears its inline warning after a later save', () => {
  const { audio, profile, profileStorage } = renderLobby({
    clock: { now: () => 1_000 },
  } as GameClient);
  profileStorage.setItem.mockImplementationOnce(() => {
    throw new Error('write denied');
  });
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.profile') }));
  vi.mocked(audio.playCue).mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'onyx-topknot' }));
  expect(audio.playCue).toHaveBeenCalledExactlyOnceWith(AUDIO_CUE.SELECT);
  expect(profile.getSnapshot().selection.characterId).toBe('onyx-topknot');
  expect(screen.getByRole('button', { name: 'onyx-topknot' }).getAttribute('aria-pressed')).toBe(
    'true',
  );
  expect(screen.getByRole('alert').textContent).toBe('Couldn’t save your profile.');
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.profile') }));
  expect(screen.getByRole('alert')).not.toBeNull();
  vi.mocked(audio.playCue).mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'onyx-topknot' }));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(profile.getSnapshot().selection.characterId).toBe('onyx-topknot');
  expect(audio.playCue).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'onyx-topknot' }));
  expect(profileStorage.setItem).toHaveBeenCalledTimes(2);
  expect(audio.playCue).not.toHaveBeenCalled();
});

test('records one logical admission attempt and typed result without client or room identifiers', async () => {
  const send = vi.fn();
  const telemetry = createTelemetry({
    analytics: { send },
  });
  await telemetry.start();
  const operation = deferred<{ ok: false; error: ReturnType<typeof createTransportError> }>();
  const client = {
    clock: { now: () => 1_000 },
    createRoom: vi.fn(() => operation.promise),
  } as unknown as GameClient;
  renderLobby(client, { telemetry });
  const button = screen.getByRole('button', { name: translate(LOCALE.EN, 'lobby.createRoom') });
  fireEvent.click(button);
  fireEvent.click(button);
  await act(async () => {
    operation.resolve({
      ok: false,
      error: createTransportError(CLIENT_ERROR_CODE.NETWORK_UNAVAILABLE),
    });
  });
  const requests = send.mock.calls
    .map(([event]) => event)
    .filter((event) => event.name === 'room_request');
  expect(requests).toEqual([
    { name: 'room_request', operation: 'create', phase: 'start' },
    {
      name: 'room_request',
      operation: 'create',
      phase: 'failure',
      duration_ms: expect.any(Number),
      failure_kind: 'transport',
      failure_code: 'NETWORK_UNAVAILABLE',
    },
  ]);
  expect(JSON.stringify(requests)).not.toContain('019cebf0');
  telemetry.dispose();
});
