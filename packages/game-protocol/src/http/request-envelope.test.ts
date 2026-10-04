import { describe, expect, test } from 'bun:test';

import { createCompatibilityContract } from '../version';
import { parseCancelRoomBody } from './cancel-room';
import { parseCreateRoomRequest } from './create-room';
import { parseJoinRoomBody } from './join-room';
import { parseRoomHttpEnvelope } from './request-envelope';
import { parseResumeRoomBody } from './resume-room';

const contract = createCompatibilityContract('test-release');
const createBody = {
  clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c39843d',
  operationId: '4ba1e7d4-c077-4b80-b198-9b1f04c182c8',
  profile: { characterId: 'navy-bob', variant: false },
};
const authorityBody = { seatToken: '550e8400-e29b-41d4-a716-446655440000' };

describe('room HTTP envelope', () => {
  test('requires an exact contract and rejects unknown envelope fields', () => {
    expect(parseRoomHttpEnvelope({ contract, body: createBody })).toEqual({
      contract,
      body: createBody,
    });
    expect(() => parseRoomHttpEnvelope(createBody)).toThrow();
    expect(() => parseRoomHttpEnvelope({ contract, body: createBody, extra: true })).toThrow();
    expect(() =>
      parseRoomHttpEnvelope({
        contract: { ...contract, gameProtocolVersion: 'game-protocol-v13' },
        body: createBody,
      }),
    ).toThrow();
  });

  test.each([
    { name: 'create', parse: parseCreateRoomRequest, body: createBody },
    { name: 'join', parse: parseJoinRoomBody, body: createBody },
    { name: 'resume', parse: parseResumeRoomBody, body: authorityBody },
    { name: 'cancel', parse: parseCancelRoomBody, body: authorityBody },
  ])('new envelopes cannot pass the legacy strict $name body parser', ({ parse, body }) => {
    expect(() => parse(body)).not.toThrow();
    expect(() => parse({ contract, body })).toThrow();
  });
});
