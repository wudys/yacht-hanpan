// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- external subscriptions must stop between hook tests. */
import type { GameClient } from '@repo/game-client-sdk';
import { parseCreateRoomResponse } from '@repo/game-protocol/http';
import { GAME_PROTOCOL_VERSION } from '@repo/game-protocol/version';
import { act, cleanup, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import { useLobbyAdmission } from '@/features/lobby/use-lobby-admission';
import { createProfileSelectionStore } from '@/runtime/profile/profile-selection-store';
import { createRoomAccess } from '@/runtime/room-access/room-access';
import type { StoredRoomReentry } from '@/runtime/room-access/stored-room-reentry';
import { createGameSessionHolder } from '@/runtime/session/game-session-holder';
import {
  createSessionCredentialStore,
  type SessionCredentialStore,
} from '@/runtime/session/session-credential-store';
import type { SessionRecovery } from '@/runtime/session/session-recovery';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
afterEach(cleanup);

function setup(
  overrides: Partial<GameClient> = {},
  sessionCredentialStore: SessionCredentialStore = createSessionCredentialStore(),
) {
  const idle = { status: 'idle' } as const;
  const createRoom = vi.fn(() =>
    Promise.resolve({
      ok: false as const,
      error: { kind: 'transport' as const, code: 'NETWORK_UNAVAILABLE' as const },
    }),
  );
  const client = { createRoom, clock: { now: () => 0 }, ...overrides } as unknown as GameClient;
  const clock = { now: client.clock.now };
  const reentry = {
    getSnapshot: () => idle,
    subscribe: () => () => {},
    check: vi.fn(),
  } as unknown as StoredRoomReentry;
  const recovery = {
    getSnapshot: () => idle,
    subscribe: () => () => {},
  } as unknown as SessionRecovery;
  const onIntent = vi.fn();
  const sessions = createGameSessionHolder(client);
  const profile = createProfileSelectionStore({ getItem: () => null, setItem: () => {} }, () => 0);
  profile.initialize();
  const activity = new AbortController().signal;
  const readiness = { wait: () => Promise.resolve({ ok: true as const }) };
  const access = createRoomAccess({
    activity,
    client,
    sessions,
    sessionCredentialStore,
    readiness,
    reentry,
    recovery,
  });
  const { result, unmount } = renderHook(
    () =>
      useLobbyAdmission({
        activity,
        access,
        clock,
        profile,
        onIntent,
      }),
    { wrapper: StrictMode },
  );
  return { result, unmount, createRoom, onIntent, profile };
}

test('uses the owned actor to reject stale layer and duplicate create intents', async () => {
  const { result, createRoom, onIntent, profile } = setup();
  const { createRoom: create, openProfile } = result.current;
  profile.setSelection({ characterId: 'blonde-buns', variant: true });
  await act(async () => {
    void create();
    profile.setSelection({ characterId: 'navy-bob', variant: false });
    void create();
    openProfile();
  });
  expect(createRoom).toHaveBeenCalledOnce();
  expect(createRoom).toHaveBeenCalledWith(
    expect.objectContaining({ profile: { characterId: 'blonde-buns', variant: true } }),
    expect.anything(),
  );
  expect(onIntent).toHaveBeenCalledOnce();
  expect(result.current.screenState).toBe('createFailed');
  await act(async () => create());
  expect(createRoom).toHaveBeenCalledOnce();
  expect(onIntent).toHaveBeenCalledOnce();
  act(() => result.current.dismissNotice());
  expect(result.current.screenState).toBe('home');
  await act(async () => create());
  expect(createRoom).toHaveBeenCalledTimes(2);
});

test('keeps admission unavailable from profile and reads current normalized join code', async () => {
  const { result, createRoom } = setup();
  act(() => result.current.openProfile());
  await act(async () => result.current.createRoom());
  expect(createRoom).not.toHaveBeenCalled();
  expect(result.current.screenState).toBe('profile');
  act(() => {
    result.current.closeProfile();
    result.current.openJoinRoom();
    result.current.changeJoinCode('00x1234');
  });
  expect(result.current.joinCode).toBe('001234');
  act(() => result.current.closeJoinRoom());
  expect(result.current.joinCode).toBe('');
});

test('does not replace a newer recovery tuple when aborted admission succeeds after unmount', async () => {
  const response = parseCreateRoomResponse({
    ok: true,
    data: {
      authority: {
        roomId: '019cebf0-79b8-7a22-8000-000000000001',
        seatToken: '550e8400-e29b-41d4-a716-446655440000',
        seatIndex: 0,
      },
      view: {
        room: {
          roomId: '019cebf0-79b8-7a22-8000-000000000001',
          roomCode: '001234',
          status: 'waiting',
          createdAt: 1_000,
          expiresAt: 301_000,
          seats: [{ profile: { characterId: 'navy-bob', variant: false } }],
        },
        game: null,
        presence: {
          roomId: '019cebf0-79b8-7a22-8000-000000000001',
          presenceVersion: 0,
          seats: [{ status: 'disconnected', reconnectDeadlineAt: null }],
        },
      },
    },
    meta: {
      requestId: '9d6ffbb8-10a4-4d43-8c46-cd035b9e87f0',
      serverTime: 1_000,
      gameProtocolVersion: GAME_PROTOCOL_VERSION,
    },
  });
  if (!response.ok) throw new Error('expected creation fixture');
  let completeAdmission!: (value: Awaited<ReturnType<GameClient['createRoom']>>) => void;
  const pending = new Promise<Awaited<ReturnType<GameClient['createRoom']>>>((resolve) => {
    completeAdmission = resolve;
  });
  const createRoom = vi.fn<GameClient['createRoom']>(() => pending);
  const createSession = vi.fn<GameClient['createSession']>();
  const values = new Map<string, string>();
  const options = {
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
  };
  const sessionCredentialStore = createSessionCredentialStore(options);
  const { result, unmount } = setup({ createRoom, createSession }, sessionCredentialStore);
  await act(async () => {
    result.current.createRoom();
  });
  expect(createRoom).toHaveBeenCalledOnce();
  const signal = createRoom.mock.calls[0]?.[1]?.signal;
  expect(signal?.aborted).toBe(false);
  unmount();
  expect(signal?.aborted).toBe(true);

  const newerAuthority = {
    ...response.data.authority,
    roomId: '019cebf0-79b8-7a22-8000-000000000002' as typeof response.data.authority.roomId,
  };
  sessionCredentialStore.recordRoom(newerAuthority);
  const currentRoom = sessionCredentialStore.initialize().recentRoom;
  await act(async () => {
    completeAdmission(response);
    await pending;
  });
  expect(sessionCredentialStore.initialize().recentRoom).toEqual(currentRoom);
  expect(createSessionCredentialStore(options).initialize().recentRoom).toEqual(currentRoom);
  expect(createSession).not.toHaveBeenCalled();
});
