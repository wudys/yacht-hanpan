import type { SeatIndex } from '@repo/yacht-rules';

import type { RoomId } from '@/rooms/domain/room-model';

export type ActiveSeatConnection = Readonly<{ connectionId: string; executionId: string }>;

export interface ActiveConnectionRegistry {
  readonly bind: (
    roomId: RoomId,
    seatIndex: SeatIndex,
    connection: ActiveSeatConnection,
  ) => ActiveSeatConnection | undefined;
  readonly get: (roomId: RoomId, seatIndex: SeatIndex) => ActiveSeatConnection | undefined;
  readonly unbind: (roomId: RoomId, seatIndex: SeatIndex, connectionId: string) => boolean;
}

export class ConnectionRegistry implements ActiveConnectionRegistry {
  readonly #connectionsByRoom: Map<RoomId, Map<SeatIndex, ActiveSeatConnection>> = new Map<
    RoomId,
    Map<SeatIndex, ActiveSeatConnection>
  >();

  public bind(
    roomId: RoomId,
    seatIndex: SeatIndex,
    connection: ActiveSeatConnection,
  ): ActiveSeatConnection | undefined {
    const connections =
      this.#connectionsByRoom.get(roomId) ?? new Map<SeatIndex, ActiveSeatConnection>();
    const previous = connections.get(seatIndex);
    connections.set(seatIndex, connection);
    this.#connectionsByRoom.set(roomId, connections);
    return previous;
  }

  public get(roomId: RoomId, seatIndex: SeatIndex): ActiveSeatConnection | undefined {
    return this.#connectionsByRoom.get(roomId)?.get(seatIndex);
  }

  public unbind(roomId: RoomId, seatIndex: SeatIndex, connectionId: string): boolean {
    const connections = this.#connectionsByRoom.get(roomId);
    if (connections?.get(seatIndex)?.connectionId !== connectionId) return false;
    connections.delete(seatIndex);
    if (connections.size === 0) this.#connectionsByRoom.delete(roomId);
    return true;
  }

  public clearRoom(roomId: RoomId): void {
    this.#connectionsByRoom.delete(roomId);
  }

  public counts(): { readonly rooms: number; readonly connections: number } {
    let connections = 0;
    for (const room of this.#connectionsByRoom.values()) connections += room.size;
    return { rooms: this.#connectionsByRoom.size, connections };
  }
}
