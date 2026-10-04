import { describe, expect, test } from 'bun:test';

import { SocketConnectionLimit } from '@/transport/socket/socket-connection-limit';

describe('socket connection limit', () => {
  test('caps active connection IDs per direct address and releases exactly once', () => {
    const limit = new SocketConnectionLimit(2);

    expect(limit.acquire('127.0.0.1', 'socket-a')).toBeTrue();
    expect(limit.acquire('127.0.0.1', 'socket-a')).toBeTrue();
    expect(limit.acquire('127.0.0.1', 'socket-b')).toBeTrue();
    expect(limit.acquire('127.0.0.1', 'socket-c')).toBeFalse();
    expect(limit.acquire('127.0.0.2', 'socket-c')).toBeTrue();
    expect(limit.count('127.0.0.1')).toBe(2);

    expect(limit.release('127.0.0.1', 'socket-a')).toBeTrue();
    expect(limit.release('127.0.0.1', 'socket-a')).toBeFalse();
    expect(limit.acquire('127.0.0.1', 'socket-c')).toBeTrue();
  });
});
