import {
  type CommandAck,
  type CommittedRoomUpdate,
  type GameCommand,
  parseCommandAck,
  parseCommittedRoomUpdate,
  parseGameCommand,
  parseSyncAck,
  SOCKET_EVENT,
  type SyncAck,
} from '@repo/game-protocol/socket';

type SocketPacket =
  | Readonly<{ kind: 'event'; ackId: string | null; name: string; args: readonly unknown[] }>
  | Readonly<{ kind: 'ack'; ackId: string; args: readonly unknown[] }>;

/** Only default-namespace text events and ACKs; other frames pass through untouched. */
export function decodeSocketPacket(message: unknown): SocketPacket | null {
  if (typeof message !== 'string') return null;
  const frame = /^(42\d*|43\d+)(\[.*)$/su.exec(message);
  if (frame === null) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(frame[2]!);
  } catch {
    throw new Error('Invalid default Socket.IO packet');
  }
  if (!Array.isArray(payload)) throw new Error('Invalid default Socket.IO packet');
  const header = frame[1]!;
  if (header.startsWith('43')) return { kind: 'ack', ackId: header.slice(2), args: payload };
  const [name, ...args] = payload;
  if (typeof name !== 'string') throw new Error('Invalid default Socket.IO event');
  return { kind: 'event', ackId: header.slice(2) || null, name, args };
}

export type SocketRequest =
  | Readonly<{ kind: 'sync'; ackId: string }>
  | Readonly<{ kind: 'command'; ackId: string; command: GameCommand }>;

type SocketAcknowledgement =
  | Readonly<{ kind: 'sync'; ackId: string; ack: SyncAck }>
  | Readonly<{ kind: 'command'; ackId: string; command: GameCommand; ack: CommandAck }>;

/** One observer per connection. Observation does not forward, hold or transform frames. */
export function createSocketPacketObserver() {
  const pending = new Map<string, SocketRequest>();
  let disposed = false;
  return {
    observeClient(message: unknown): SocketRequest | null {
      if (disposed || typeof message !== 'string' || !message.startsWith('42')) return null;
      const packet = decodeSocketPacket(message);
      if (packet?.kind !== 'event') return null;
      if (packet.name !== SOCKET_EVENT.GAME_SYNC && packet.name !== SOCKET_EVENT.GAME_COMMAND)
        return null;
      if (packet.ackId === null) throw new Error('Missing game socket ACK ID');
      let request: SocketRequest;
      if (packet.name === SOCKET_EVENT.GAME_SYNC) {
        if (packet.args.length !== 0) throw new Error('Invalid game sync request');
        request = { kind: 'sync', ackId: packet.ackId };
      } else {
        if (packet.args.length !== 1) throw new Error('Invalid game command request');
        request = {
          kind: 'command',
          ackId: packet.ackId,
          command: parseGameCommand(packet.args[0]),
        };
      }
      pending.set(request.ackId, request);
      return request;
    },
    observeServer(message: unknown): SocketAcknowledgement | null {
      if (disposed || typeof message !== 'string') return null;
      const header = /^43(\d+)\[/u.exec(message);
      if (header === null) return null;
      const request = pending.get(header[1]!);
      // Ignore unknown and duplicate ACKs, including their untrusted payloads.
      if (request === undefined) return null;
      pending.delete(request.ackId);
      const packet = decodeSocketPacket(message);
      if (packet?.kind !== 'ack' || packet.args.length !== 1)
        throw new Error('Invalid game socket ACK');
      return request.kind === 'sync'
        ? { kind: 'sync', ackId: request.ackId, ack: parseSyncAck(packet.args[0]) }
        : {
            kind: 'command',
            ackId: request.ackId,
            command: request.command,
            ack: parseCommandAck(packet.args[0]),
          };
    },
    dispose(): void {
      disposed = true;
      pending.clear();
    },
  };
}

export function readRoomStatePacket(message: unknown): CommittedRoomUpdate | null {
  if (typeof message !== 'string' || !message.startsWith('42')) return null;
  const packet = decodeSocketPacket(message);
  if (packet?.kind !== 'event' || packet.name !== SOCKET_EVENT.ROOM_STATE) return null;
  if (packet.args.length !== 1) throw new Error('Invalid room state event');
  return parseCommittedRoomUpdate(packet.args[0]);
}
