import type { RoomAuthority } from '@repo/game-client-sdk';
import { describe, expect, test, vi } from 'vitest';

import {
  type BrowserStorage,
  createSessionCredentialStore,
} from '@/runtime/session/session-credential-store';

const CLIENT_ID = '019cc3cb-b67c-7000-8000-000000000010';
const SECOND_CLIENT_ID = '019cc3cb-b67c-7000-8000-000000000011';
// This lifecycle unit test supplies an already-validated SDK authority.
const ROOM_ID = '019cc3cb-b67c-7000-8000-000000000012' as RoomAuthority['roomId'];
const SEAT_TOKEN = '019cc3cb-b67c-4000-8000-000000000013' as RoomAuthority['seatToken'];
const authority: RoomAuthority = { roomId: ROOM_ID, seatIndex: 0, seatToken: SEAT_TOKEN };

class MemoryStorage implements BrowserStorage {
  readonly #values: Map<string, string> = new Map<string, string>();

  public getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  public setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }

  public removeItem(key: string): void {
    this.#values.delete(key);
  }

  public corruptAll(value: string): void {
    for (const key of this.#values.keys()) this.#values.set(key, value);
  }
}

describe('createSessionCredentialStore', () => {
  test('refreshes another execution’s credential without regenerating this client identity', () => {
    const storage = new MemoryStorage();
    const first = createSessionCredentialStore({ storage });
    const createClientId = vi.fn(() => CLIENT_ID);
    const second = createSessionCredentialStore({ storage, createClientId });
    expect(second.initialize().recentRoom).toEqual({ status: 'ready', room: null });
    first.recordRoom(authority);
    expect(second.initialize().recentRoom).toEqual({ status: 'ready', room: null });
    expect(second.refreshRecentRoom()).toEqual({
      status: 'ready',
      room: { roomId: ROOM_ID, seatToken: SEAT_TOKEN },
    });
    expect(second.getClientId()).toBe(CLIENT_ID);
    expect(createClientId).toHaveBeenCalledOnce();
  });

  test('refresh distinguishes a new read failure from the cached empty candidate', () => {
    const storage = new MemoryStorage();
    const store = createSessionCredentialStore({ storage });
    store.initialize();
    const read = vi.spyOn(storage, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(store.refreshRecentRoom()).toEqual({ status: 'unavailable' });
    read.mockRestore();
    expect(store.refreshRecentRoom()).toEqual({ status: 'ready', room: null });
  });

  test('refresh preserves an unsaved in-memory credential and its warning', () => {
    const storage = new MemoryStorage();
    const store = createSessionCredentialStore({ storage });
    store.initialize();
    const write = vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    store.recordRoom(authority);
    write.mockRestore();
    const read = vi.spyOn(storage, 'getItem');
    expect(store.refreshRecentRoom()).toEqual({
      status: 'ready',
      room: { roomId: ROOM_ID, seatToken: SEAT_TOKEN },
    });
    expect(store.getSnapshot().persistence).toBe('memoryOnly');
    expect(read).not.toHaveBeenCalled();
  });

  test('keeps a retired candidate empty when browser storage access fails and later recovers', () => {
    const storage = new MemoryStorage();
    let accessible = true;
    vi.stubGlobal('localStorage', storage);
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        if (!accessible) throw new DOMException('Storage access denied', 'SecurityError');
        return storage;
      },
    });
    try {
      const store = createSessionCredentialStore({ createClientId: () => CLIENT_ID });
      store.recordRoom(authority);
      accessible = false;
      store.removeRoom(ROOM_ID);
      expect(store.refreshRecentRoom()).toEqual({ status: 'ready', room: null });

      accessible = true;
      expect(storage.getItem('recentRoom')).not.toBeNull();
      expect(store.refreshRecentRoom()).toEqual({ status: 'ready', room: null });

      const nextAuthority = {
        ...authority,
        roomId: '019cc3cb-b67c-7000-8000-000000000099' as RoomAuthority['roomId'],
      };
      store.recordRoom(nextAuthority);
      expect(store.getSnapshot().persistence).toBe('saved');
      expect(createSessionCredentialStore({ storage }).initialize().recentRoom).toEqual({
        status: 'ready',
        room: { roomId: nextAuthority.roomId, seatToken: nextAuthority.seatToken },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('ignores late credential writes and cleanup after this execution is replaced', () => {
    const storage = new MemoryStorage();
    const activity = new AbortController();
    const store = createSessionCredentialStore({ storage, signal: activity.signal });
    store.recordRoom(authority);
    const before = store.initialize().recentRoom;
    const persisted = storage.getItem('recentRoom');
    const listener = vi.fn();
    store.subscribe(listener);
    activity.abort();
    store.removeRoom(ROOM_ID);
    store.recordRoom({
      ...authority,
      roomId: '019cc3cb-b67c-7000-8000-000000000099' as RoomAuthority['roomId'],
    });
    expect(store.initialize().recentRoom).toBe(before);
    expect(storage.getItem('recentRoom')).toBe(persisted);
    expect(listener).not.toHaveBeenCalled();
  });

  test('does not write defaults or clean malformed storage when initialized after replacement', () => {
    const storage = new MemoryStorage();
    storage.setItem('recentRoom', 'malformed');
    const activity = new AbortController();
    activity.abort();
    const store = createSessionCredentialStore({
      storage,
      signal: activity.signal,
      createClientId: () => CLIENT_ID,
    });
    expect(store.initialize().clientId).toBe(CLIENT_ID);
    expect(storage.getItem('clientId')).toBeNull();
    expect(storage.getItem('recentRoom')).toBe('malformed');
  });

  test('distinguishes unavailable recovery from no candidate and retries the next read', () => {
    const storage = new MemoryStorage();
    storage.setItem('recentRoom', JSON.stringify({ roomId: ROOM_ID, seatToken: SEAT_TOKEN }));
    const read = vi.spyOn(storage, 'getItem');
    read.mockImplementationOnce(() => {
      throw new Error('denied');
    });
    read.mockImplementationOnce(() => {
      throw new Error('denied');
    });
    const createClientId = vi.fn(() => CLIENT_ID);
    const store = createSessionCredentialStore({ storage, createClientId });
    expect(store.initialize().recentRoom).toEqual({ status: 'unavailable' });
    expect(store.initialize().recentRoom).toEqual({
      status: 'ready',
      room: { roomId: ROOM_ID, seatToken: SEAT_TOKEN },
    });
    expect(createClientId).toHaveBeenCalledTimes(1);
  });

  test('reports memory-only credentials without discarding them and publishes stable storage state', () => {
    const storage = new MemoryStorage();
    const store = createSessionCredentialStore({ storage });
    const listener = vi.fn();
    store.subscribe(listener);
    const initial = store.getSnapshot();
    expect(store.getSnapshot()).toBe(initial);
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    store.recordRoom(authority);
    expect(store.initialize().recentRoom).toEqual({
      status: 'ready',
      room: { roomId: ROOM_ID, seatToken: SEAT_TOKEN },
    });
    expect(store.getSnapshot()).toEqual({ persistence: 'memoryOnly' });
    expect(listener).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
    store.recordRoom(authority);
    expect(store.getSnapshot()).toEqual({ persistence: 'saved' });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test('creates defaults once and reuses their persisted values', () => {
    const storage = new MemoryStorage();
    const createClientId = vi.fn(() => CLIENT_ID);
    const store = createSessionCredentialStore({ storage, createClientId });

    expect(store.initialize()).toEqual({
      clientId: CLIENT_ID,
      recentRoom: { status: 'ready', room: null },
    });
    expect(store.initialize()).toEqual(store.initialize());
    expect(store.getClientId()).toBe(CLIENT_ID);
    expect(createClientId).toHaveBeenCalledTimes(1);

    const reloaded = createSessionCredentialStore({
      storage,
      createClientId: vi.fn(() => SECOND_CLIENT_ID),
    });
    expect(reloaded.initialize()).toEqual({
      clientId: CLIENT_ID,
      recentRoom: { status: 'ready', room: null },
    });
  });

  test('persists only the recovery credential and removes the matching tuple', () => {
    const storage = new MemoryStorage();
    const options = {
      storage,
      createClientId: () => CLIENT_ID,
    };
    const store = createSessionCredentialStore(options);
    store.initialize();

    expect(createSessionCredentialStore(options).initialize().recentRoom).toEqual({
      status: 'ready',
      room: null,
    });

    store.recordRoom(authority);
    const recentRoom = { roomId: ROOM_ID, seatToken: SEAT_TOKEN };
    expect(store.initialize().recentRoom).toEqual({ status: 'ready', room: recentRoom });
    expect(createSessionCredentialStore(options).initialize().recentRoom).toEqual({
      status: 'ready',
      room: recentRoom,
    });

    store.removeRoom('different-room');
    expect(store.initialize().recentRoom).toEqual({ status: 'ready', room: recentRoom });

    store.removeRoom(ROOM_ID);
    expect(store.initialize().recentRoom).toEqual({ status: 'ready', room: null });
    expect(createSessionCredentialStore(options).initialize().recentRoom).toEqual({
      status: 'ready',
      room: null,
    });
  });

  test('an older room cleanup cannot erase a newer recovery candidate', () => {
    const store = createSessionCredentialStore({ storage: new MemoryStorage() });
    store.recordRoom(authority);
    const nextAuthority = {
      ...authority,
      roomId: '018f47f2-c2d8-7f4a-8bf4-3f559c398444' as typeof authority.roomId,
    };
    store.recordRoom(nextAuthority);
    store.removeRoom(ROOM_ID);
    expect(store.initialize().recentRoom).toEqual({
      status: 'ready',
      room: {
        roomId: nextAuthority.roomId,
        seatToken: nextAuthority.seatToken,
      },
    });
  });

  test('keeps legacy recovery candidates despite clock skew and ignores their timestamp', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'recentRoom',
      JSON.stringify({ roomId: ROOM_ID, seatToken: SEAT_TOKEN, roomCreatedAt: 0 }),
    );
    const store = createSessionCredentialStore({ storage });
    expect(store.initialize().recentRoom).toEqual({
      status: 'ready',
      room: { roomId: ROOM_ID, seatToken: SEAT_TOKEN },
    });
    expect(storage.getItem('recentRoom')).not.toBeNull();
  });

  test('replaces malformed defaults and discards malformed recovery', () => {
    const storage = new MemoryStorage();
    const first = createSessionCredentialStore({
      storage,
      createClientId: () => CLIENT_ID,
    });
    first.initialize();
    first.recordRoom(authority);
    storage.corruptAll('malformed');

    const replacementClientId = vi.fn(() => SECOND_CLIENT_ID);
    const recovered = createSessionCredentialStore({
      storage,
      createClientId: replacementClientId,
    });

    expect(recovered.initialize()).toEqual({
      clientId: SECOND_CLIENT_ID,
      recentRoom: { status: 'ready', room: null },
    });
    expect(replacementClientId).toHaveBeenCalledTimes(1);
  });

  test('preserves current in-memory values when browser storage operations fail', () => {
    const storage: BrowserStorage = {
      getItem() {
        throw new Error('read denied');
      },
      setItem() {
        throw new Error('write denied');
      },
      removeItem() {
        throw new Error('remove denied');
      },
    };
    const store = createSessionCredentialStore({
      storage,
      createClientId: () => CLIENT_ID,
    });

    expect(store.initialize()).toEqual({
      clientId: CLIENT_ID,
      recentRoom: { status: 'unavailable' },
    });

    store.recordRoom(authority);
    expect(store.initialize().recentRoom).toEqual({
      status: 'ready',
      room: {
        roomId: ROOM_ID,
        seatToken: SEAT_TOKEN,
      },
    });

    store.removeRoom(ROOM_ID);
    expect(store.initialize().recentRoom).toEqual({ status: 'ready', room: null });
    expect(store.refreshRecentRoom()).toEqual({ status: 'ready', room: null });
  });
});
