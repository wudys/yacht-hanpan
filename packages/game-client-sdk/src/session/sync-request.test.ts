import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import {
  parseGameSnapshot,
  parsePresenceSnapshot,
  parsePublicRoom,
} from '@repo/game-protocol/socket';
import { GAME_PROTOCOL_VERSION } from '@repo/game-protocol/version';
import { describe, expect, test } from 'bun:test';

import { requestSync } from './sync-request';

const REQUEST_ID = '9d6ffbb8-10a4-4d43-8c46-cd035b9e87f0';
const ROOM_ID = '01890f47-e89b-7cc3-98c5-4c5da03f78ab';

function snapshot() {
  const room = parsePublicRoom({
    status: 'finished',
    roomId: ROOM_ID,
    roomCode: '001204',
    createdAt: 1_000,
    startedAt: 2_000,
    finishedAt: 3_000,
    seats: [
      { profile: { characterId: 'navy-bob', variant: false } },
      { profile: { characterId: 'blonde-buns', variant: false } },
    ],
  });
  const game = parseGameSnapshot({
    stateVersion: 4,
    match: {
      status: 'finished',
      players: [
        { scorecard: {}, timeoutCount: 0 },
        { scorecard: {}, timeoutCount: 0 },
      ],
      result: { reason: 'scoresCompleted', winnerSeatIndex: null },
    },
  });
  const presence = parsePresenceSnapshot({
    roomId: ROOM_ID,
    presenceVersion: 3,
    seats: [{ status: 'connected' }, { status: 'connected' }],
  });
  return { room, game, presence };
}

describe('sync request', () => {
  test('returns validated snapshots and response timing without applying state', async () => {
    const data = snapshot();
    const meta = {
      requestId: REQUEST_ID,
      serverTime: 1000,
      gameProtocolVersion: GAME_PROTOCOL_VERSION,
    };
    expect(
      await requestSync({
        timeoutMs: 50,
        signal: new AbortController().signal,
        emit: (acknowledge) => acknowledge({ ok: true, data, meta }),
      }),
    ).toMatchObject({ ok: true, data, meta });
  });

  test('normalizes strict server failure and malformed acknowledgement', async () => {
    const failures = [
      {
        ok: false,
        error: { code: PUBLIC_ERROR_CODE.RESUME_NOT_AVAILABLE, params: {} },
        meta: {
          requestId: REQUEST_ID,
          serverTime: 1000,
          gameProtocolVersion: GAME_PROTOCOL_VERSION,
        },
      },
      { ok: true, data: { private: true } },
    ];
    const options = {
      timeoutMs: 50,
      signal: new AbortController().signal,
      emit: (acknowledge: (value: unknown) => void) => acknowledge(failures.shift()),
    };
    expect(await requestSync(options)).toMatchObject({ ok: false, error: { kind: 'server' } });
    expect(await requestSync(options)).toMatchObject({
      ok: false,
      error: { kind: 'protocol', code: 'INVALID_RESPONSE' },
    });
  });

  test('settles an aborted request and ignores its late acknowledgement', async () => {
    const controller = new AbortController();
    let acknowledge: ((value: unknown) => void) | undefined;
    const pending = requestSync({
      timeoutMs: 5000,
      signal: controller.signal,
      emit: (next) => {
        acknowledge = next;
      },
    });
    controller.abort();
    acknowledge?.({
      ok: true,
      data: snapshot(),
      meta: { requestId: REQUEST_ID, serverTime: 1000, gameProtocolVersion: GAME_PROTOCOL_VERSION },
    });
    expect(await pending).toMatchObject({
      ok: false,
      error: { kind: 'protocol', code: 'SESSION_DISPOSED' },
    });
  });

  test('reports acknowledgement timeout', async () => {
    expect(
      await requestSync({
        timeoutMs: 1,
        signal: new AbortController().signal,
        emit: () => {},
      }),
    ).toMatchObject({ ok: false, error: { kind: 'transport', code: 'ACK_TIMEOUT' } });
  });
});
