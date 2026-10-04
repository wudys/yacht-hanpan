import { describe, expect, test } from 'bun:test';

import { ConnectionRegistry } from '@/rooms/application/connections/connection-registry';
import { roomId } from '@/rooms/domain/room-model';

describe('connection registry', () => {
  test('replaces a seat connection and ignores stale disconnect cleanup', () => {
    const registry = new ConnectionRegistry();
    const room = roomId('018f47f2-c2d8-7f4a-8bf4-3f559c39843e');
    const seat = 0 as const;
    const first = { connectionId: 'socket-a', executionId: 'execution-a' };
    const second = { connectionId: 'socket-b', executionId: 'execution-b' };

    expect(registry.bind(room, seat, first)).toBeUndefined();
    expect(registry.counts()).toEqual({ rooms: 1, connections: 1 });
    expect(registry.get(room, seat)).toBe(first);
    expect(registry.bind(room, seat, second)).toBe(first);
    expect(registry.unbind(room, seat, 'socket-a')).toBeFalse();
    expect(registry.get(room, seat)).toBe(second);
    expect(registry.unbind(room, seat, 'socket-b')).toBeTrue();
    expect(registry.get(room, seat)).toBeUndefined();
    expect(registry.counts()).toEqual({ rooms: 0, connections: 0 });
  });

  test('clears every connection owned by a removed room', () => {
    const registry = new ConnectionRegistry();
    const room = roomId('018f47f2-c2d8-7f4a-8bf4-3f559c39843e');
    registry.bind(room, 0, { connectionId: 'socket-a', executionId: 'execution-a' });
    registry.bind(room, 1, { connectionId: 'socket-b', executionId: 'execution-b' });

    registry.clearRoom(room);

    expect(registry.counts()).toEqual({ rooms: 0, connections: 0 });
  });
});
