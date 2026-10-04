import { createGameClient } from '@repo/game-client-sdk';
import { parseResumeRoomRequest } from '@repo/game-protocol/http';
import { expect, it, vi } from 'vitest';

import { reportClientFailure } from '@/runtime/telemetry/error-policy';

it('excludes typed server, unavailable-state and transport failures from diagnostics', () => {
  const report = vi.fn();
  const reporter = { reportUnexpected: report };
  reportClientFailure(reporter, {
    kind: 'server',
    error: { code: 'INVALID_AUTHORITY', params: {} },
  });
  reportClientFailure(reporter, {
    kind: 'server',
    error: { code: 'ROOM_CODE_EXHAUSTED', params: {} },
  });
  expect(report).not.toHaveBeenCalled();
  reportClientFailure(reporter, {
    kind: 'server',
    error: { code: 'INTERNAL_ERROR', params: {} },
  });
  reportClientFailure(reporter, { kind: 'protocol', code: 'STATE_UNAVAILABLE' });
  reportClientFailure(reporter, { kind: 'transport', code: 'NETWORK_UNAVAILABLE' });
  reportClientFailure(reporter, { kind: 'transport', code: 'ACK_TIMEOUT' });
  expect(report).not.toHaveBeenCalled();
});

it('reports malformed SDK responses without identifiers and keeps compatibility failures silent', async () => {
  const report = vi.fn();
  const reporter = { reportUnexpected: report };
  reportClientFailure(reporter, { kind: 'protocol', code: 'PROTOCOL_MISMATCH' });
  reportClientFailure(reporter, {
    kind: 'server',
    error: { code: 'PROTOCOL_MISMATCH', params: {} },
  });
  expect(report).not.toHaveBeenCalled();
  const client = createGameClient({
    serverUrl: 'https://game.example.test',
    releaseId: 'test-release',
    fetch: async () => Response.json({ private: 'PRIVATE_RESPONSE' }),
  });
  const result = await client.resumeRoom(
    parseResumeRoomRequest({
      roomId: '01890f47-e89b-7cc3-98c5-4c5da03f78ab',
      seatToken: '550e8400-e29b-41d4-a716-446655440000',
    }),
  );
  if (result.ok) throw new Error('expected invalid response');
  reportClientFailure(reporter, result.error, { operation: 'synchronize', stage: 'response' });
  expect(report.mock.calls).toEqual([
    [
      expect.objectContaining({ message: 'INVALID_RESPONSE' }),
      {
        operation: 'synchronize',
        stage: 'response',
        error_code: 'INVALID_RESPONSE',
      },
    ],
  ]);
});
