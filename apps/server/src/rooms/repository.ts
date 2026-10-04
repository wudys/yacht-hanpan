import { hasExpiredActionResults } from '@/rooms/commands/action-ledger';
import { evaluateCleanup } from '@/rooms/domain/cleanup-policy';
import { assertRoomInvariant } from '@/rooms/domain/room-invariants';
import { type RoomCode, type RoomId } from '@/rooms/domain/room-model';
import type { RoomRecord } from '@/rooms/record';

export type CreateRecordResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'roomIdConflict' | 'codeConflict' | 'capacity';
    };

export interface RoomRepository {
  readonly createExclusive: (record: RoomRecord) => CreateRecordResult;
  readonly getById: (roomId: RoomId) => RoomRecord | undefined;
  readonly findRoomIdByCode: (code: RoomCode) => RoomId | undefined;
  readonly listMaintenanceCandidateRoomIds: (checkedAt: number) => readonly RoomId[];
  readonly replace: (roomId: RoomId, next: RoomRecord) => boolean;
  readonly remove: (roomId: RoomId) => RoomRecord | undefined;
}

export type RoomRepositoryReader = Pick<
  RoomRepository,
  'getById' | 'findRoomIdByCode' | 'listMaintenanceCandidateRoomIds'
>;

export class InMemoryRoomRepository implements RoomRepository {
  readonly #roomsById: Map<RoomId, RoomRecord> = new Map<RoomId, RoomRecord>();
  readonly #roomIdByCode: Map<RoomCode, RoomId> = new Map<RoomCode, RoomId>();
  readonly #maxRooms: number;

  public constructor(maxRooms: number = 128) {
    this.#maxRooms = maxRooms;
  }

  public createExclusive(record: RoomRecord): CreateRecordResult {
    if (this.#roomsById.size >= this.#maxRooms) return { ok: false, reason: 'capacity' };
    const roomId = record.room.id;
    if (this.#roomIdByCode.has(record.room.code)) {
      return { ok: false, reason: 'codeConflict' };
    }
    if (this.#roomsById.has(roomId)) {
      return { ok: false, reason: 'roomIdConflict' };
    }

    assertRoomInvariant(record.room);
    this.#roomsById.set(roomId, record);
    this.#roomIdByCode.set(record.room.code, roomId);
    return { ok: true };
  }

  public getById(roomId: RoomId): RoomRecord | undefined {
    return this.#roomsById.get(roomId);
  }

  public findRoomIdByCode(code: RoomCode): RoomId | undefined {
    return this.#roomIdByCode.get(code);
  }

  public listMaintenanceCandidateRoomIds(checkedAt: number): readonly RoomId[] {
    const candidates: RoomId[] = [];
    for (const [roomId, record] of this.#roomsById) {
      const cleanup = evaluateCleanup(record.room, { checkedAt });
      if (
        (cleanup.ok && cleanup.reason !== null) ||
        hasExpiredActionResults(record.actionLedger, checkedAt)
      ) {
        candidates.push(roomId);
      }
    }
    return candidates;
  }

  public replace(roomId: RoomId, next: RoomRecord): boolean {
    const current = this.#roomsById.get(roomId);
    if (current === undefined) return false;
    if (next.room.id !== roomId || next.room.code !== current.room.code) {
      throw new Error('Room identity and code are immutable');
    }

    assertRoomInvariant(next.room);

    this.#roomsById.set(roomId, next);
    return true;
  }

  public remove(roomId: RoomId): RoomRecord | undefined {
    const record = this.#roomsById.get(roomId);
    if (record === undefined) return undefined;

    this.#roomsById.delete(roomId);
    if (this.#roomIdByCode.get(record.room.code) === roomId) {
      this.#roomIdByCode.delete(record.room.code);
    }
    return record;
  }

  public counts(): {
    readonly rooms: number;
    readonly codes: number;
  } {
    return {
      rooms: this.#roomsById.size,
      codes: this.#roomIdByCode.size,
    };
  }

  public telemetryCounts(): {
    readonly rooms: number;
    readonly codes: number;
    readonly actionLedgerEntries: number;
  } {
    let actionLedgerEntries = 0;
    for (const record of this.#roomsById.values()) {
      actionLedgerEntries += record.actionLedger.length;
    }
    return { ...this.counts(), actionLedgerEntries };
  }
}
