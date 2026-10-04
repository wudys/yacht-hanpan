import type { RoomAuthority } from '@repo/game-client-sdk';
import { v7 as uuidV7 } from 'uuid';

const STORAGE_KEY = {
  CLIENT_ID: 'clientId',
  RECENT_ROOM: 'recentRoom',
} as const;

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface BrowserStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type RecentRoom = Readonly<{
  roomId: RoomAuthority['roomId'];
  seatToken: RoomAuthority['seatToken'];
}>;

export type RecentRoomResult =
  Readonly<{ status: 'ready'; room: RecentRoom | null }> | Readonly<{ status: 'unavailable' }>;
export type RoomPersistence = 'saved' | 'memoryOnly';
export type BrowserSessionSnapshot = Readonly<{ persistence: RoomPersistence }>;

export type BrowserSessionState = Readonly<{
  clientId: string;
  recentRoom: RecentRoomResult;
}>;

export type BrowserSessionStoreOptions = Readonly<{
  storage?: BrowserStorage;
  signal?: AbortSignal;
  createClientId?: () => string;
}>;

export interface BrowserSessionStore {
  /** Ends this execution's candidate use; shared storage removal is best-effort, without cross-tab coordination. */
  removeRoom(roomId: string): void;
  initialize(): BrowserSessionState;
  getClientId(): string;
  /** Reads one candidate at admission; it does not reserve a seat or lock other executions. */
  refreshRecentRoom(): RecentRoomResult;
  recordRoom(authority: RoomAuthority): void;
  getSnapshot(): BrowserSessionSnapshot;
  subscribe(listener: () => void): () => void;
}

export function createBrowserSessionStore(
  options: BrowserSessionStoreOptions = {},
): BrowserSessionStore {
  const createClientId = options.createClientId ?? uuidV7;
  let clientId: string | null = null;
  let recentRoom: RecentRoomResult = { status: 'unavailable' };
  let snapshot: BrowserSessionSnapshot = { persistence: 'saved' };
  const subscribers = new Set<() => void>();

  function storage(): BrowserStorage {
    const value = options.storage ?? globalThis.localStorage;
    if (!value) throw new Error('Storage unavailable');
    return value;
  }

  function write(key: string, value: string): boolean {
    if (options.signal?.aborted) return false;
    try {
      storage().setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  function remove(key: string): boolean {
    if (options.signal?.aborted) return false;
    try {
      storage().removeItem(key);
      return true;
    } catch {
      return false;
    }
  }

  function setPersistence(persistence: RoomPersistence): void {
    if (snapshot.persistence === persistence) return;
    snapshot = { persistence };
    for (const listener of subscribers) listener();
  }

  function parseRecentRoom(value: string | null): RecentRoom | null {
    if (!value) return null;
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
      const candidate = parsed as Record<string, unknown>;
      if (
        typeof candidate.roomId !== 'string' ||
        !UUID_V7_PATTERN.test(candidate.roomId) ||
        typeof candidate.seatToken !== 'string' ||
        !UUID_V4_PATTERN.test(candidate.seatToken)
      ) {
        return null;
      }
      return {
        roomId: candidate.roomId as RoomAuthority['roomId'],
        seatToken: candidate.seatToken as RoomAuthority['seatToken'],
      };
    } catch {
      return null;
    }
  }

  function readRecentRoom(): void {
    try {
      const stored = storage().getItem(STORAGE_KEY.RECENT_ROOM);
      const room = parseRecentRoom(stored);
      recentRoom = { status: 'ready', room };
      if (stored !== null && room === null) remove(STORAGE_KEY.RECENT_ROOM);
    } catch {
      recentRoom = { status: 'unavailable' };
    }
  }

  function initialize(): BrowserSessionState {
    if (clientId === null) {
      let storedClientId: string | null = null;
      try {
        storedClientId = storage().getItem(STORAGE_KEY.CLIENT_ID);
      } catch {
        // The generated ID remains stable for this page even if storage cannot be read.
      }
      clientId = storedClientId && UUID_V7_PATTERN.test(storedClientId) ? storedClientId : null;
      if (!clientId) {
        clientId = createClientId();
        write(STORAGE_KEY.CLIENT_ID, clientId);
      }
    }
    if (recentRoom.status === 'unavailable') readRecentRoom();
    return { clientId, recentRoom };
  }

  return {
    removeRoom(roomId: string) {
      if (options.signal?.aborted) return;
      initialize();
      if (recentRoom.status !== 'ready' || recentRoom.room?.roomId !== roomId) return;
      recentRoom = { status: 'ready', room: null };
      setPersistence(remove(STORAGE_KEY.RECENT_ROOM) ? 'saved' : 'memoryOnly');
    },
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    initialize,
    getClientId() {
      return initialize().clientId;
    },
    refreshRecentRoom() {
      if (options.signal?.aborted || snapshot.persistence === 'memoryOnly') return recentRoom;
      if (clientId === null) return initialize().recentRoom;
      readRecentRoom();
      return recentRoom;
    },
    recordRoom(authority: RoomAuthority) {
      if (options.signal?.aborted) return;
      initialize();
      const room = {
        roomId: authority.roomId,
        seatToken: authority.seatToken,
      };
      recentRoom = { status: 'ready', room };
      const persistence = write(STORAGE_KEY.RECENT_ROOM, JSON.stringify(room))
        ? 'saved'
        : 'memoryOnly';
      setPersistence(persistence);
    },
  };
}
