import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import { GAME_COMMAND_TYPE, parseGameCommand } from '@repo/game-protocol/socket';
import { describe, expect, test } from 'bun:test';

import {
  type ActionLedgerEntry,
  compactActionLedger,
  completeAction,
  findAction,
  fingerprintGameCommand,
  MAX_ACTION_LEDGER_ENTRIES,
  reserveRetryableAction,
} from '@/rooms/commands/action-ledger';

const SEAT_INDEX = 0 as const;
const ACTION_ID = 'a635fe2c-c4c8-4382-80d7-c35c5d5d455d';
const TURN_ID = 'c847f81e-8ee0-43ef-b09a-f8ef14612246';

describe('action ledger', () => {
  test.each([0, 1] as const)(
    'protects the other seat when seat %d reaches its retained bound',
    (seatIndex) => {
      const entries: readonly ActionLedgerEntry[] = Array.from({ length: 1_024 }, (_, index) => ({
        status: 'retryable',
        seatIndex,
        actionId: `retained-${index}`,
        fingerprint: 'f'.repeat(64),
      }));
      const overflow = { seatIndex, actionId: 'overflow', fingerprint: 'a'.repeat(64) };
      expect(reserveRetryableAction(entries, overflow)).toBeNull();
      expect(
        completeAction(entries, {
          ...overflow,
          completedAt: 1_000,
          result: { ok: true, stateVersion: 2 },
        }),
      ).toBeNull();
      const otherSeatIndex = seatIndex === 0 ? 1 : 0;
      const peer = {
        seatIndex: otherSeatIndex,
        actionId: 'peer',
        fingerprint: 'b'.repeat(64),
      } as const;
      expect(reserveRetryableAction(entries, peer)).toHaveLength(1_025);
      expect(
        completeAction(entries, {
          ...peer,
          completedAt: 1_000,
          result: { ok: false, error: { code: PUBLIC_ERROR_CODE.NOT_YOUR_TURN, params: {} } },
        }),
      ).toHaveLength(1_025);
      expect(
        completeAction(entries, {
          seatIndex,
          actionId: 'retained-0',
          fingerprint: 'f'.repeat(64),
          completedAt: 1_000,
          result: { ok: true, stateVersion: 2 },
        }),
      ).toHaveLength(1_024);
    },
  );

  test.each(['completed', 'tombstone'] as const)(
    'counts %s identities against their seat budget',
    (status) => {
      const entries: readonly ActionLedgerEntry[] = Array.from({ length: 1_024 }, (_, index) => {
        const identity = {
          seatIndex: SEAT_INDEX,
          actionId: `retained-${index}`,
          fingerprint: 'f'.repeat(64),
        };
        return status === 'completed'
          ? { ...identity, status, expiresAt: 301_000, result: { ok: true, stateVersion: 2 } }
          : { ...identity, status };
      });
      expect(
        reserveRetryableAction(entries, {
          seatIndex: SEAT_INDEX,
          actionId: 'overflow',
          fingerprint: 'a'.repeat(64),
        }),
      ).toBeNull();
    },
  );

  test('fingerprints canonical command meaning instead of object key order', () => {
    const first = parseGameCommand({
      type: GAME_COMMAND_TYPE.SET_DIE_HELD,
      actionId: ACTION_ID,
      turnId: TURN_ID,
      slot: 2,
      isHeld: true,
    });
    const reordered = parseGameCommand({
      isHeld: true,
      slot: 2,
      turnId: TURN_ID,
      actionId: ACTION_ID,
      type: GAME_COMMAND_TYPE.SET_DIE_HELD,
    });
    expect(fingerprintGameCommand(first)).toBe(fingerprintGameCommand(reordered));
  });

  test('retains a completed result then compacts it to a non-executable tombstone', () => {
    const entries = completeAction([], {
      seatIndex: SEAT_INDEX,
      actionId: ACTION_ID,
      fingerprint: 'f'.repeat(64),
      completedAt: 1_000,
      result: { ok: true, stateVersion: 4 },
    });
    if (entries === null) throw new Error('expected ledger capacity');
    expect(findAction(entries, SEAT_INDEX, ACTION_ID)?.status).toBe('completed');
    expect(compactActionLedger(entries, 300_999)[0]?.status).toBe('completed');
    expect(compactActionLedger(entries, 301_000)[0]).toEqual({
      status: 'tombstone',
      seatIndex: SEAT_INDEX,
      actionId: ACTION_ID,
      fingerprint: 'f'.repeat(64),
    });
  });

  test('reserves retryable identity and replaces it in place on completion', () => {
    const reserved = reserveRetryableAction([], {
      seatIndex: SEAT_INDEX,
      actionId: ACTION_ID,
      fingerprint: 'f'.repeat(64),
    });
    if (reserved === null) throw new Error('expected retryable reservation');
    expect(
      reserveRetryableAction(reserved, {
        seatIndex: SEAT_INDEX,
        actionId: ACTION_ID,
        fingerprint: 'f'.repeat(64),
      }),
    ).toBe(reserved);
    expect(
      reserveRetryableAction(reserved, {
        seatIndex: SEAT_INDEX,
        actionId: ACTION_ID,
        fingerprint: 'a'.repeat(64),
      }),
    ).toBeNull();

    const completed = completeAction(reserved, {
      seatIndex: SEAT_INDEX,
      actionId: ACTION_ID,
      fingerprint: 'f'.repeat(64),
      completedAt: 1_000,
      result: { ok: true, stateVersion: 2 },
    });
    expect(completed).toHaveLength(1);
    expect(completed?.[0]).toMatchObject({
      status: 'completed',
      fingerprint: 'f'.repeat(64),
      result: { ok: true, stateVersion: 2 },
    });
  });

  test('fails closed at the retained action bound', () => {
    const fullLedger = Array.from({ length: MAX_ACTION_LEDGER_ENTRIES }, (_, index) => ({
      status: 'retryable' as const,
      seatIndex: index < 1_024 ? SEAT_INDEX : (1 as const),
      actionId: `action-${index}`,
      fingerprint: String(index).padStart(64, '0'),
    }));
    expect(
      reserveRetryableAction(fullLedger, {
        seatIndex: SEAT_INDEX,
        actionId: 'overflow',
        fingerprint: 'f'.repeat(64),
      }),
    ).toBeNull();
  });
});
