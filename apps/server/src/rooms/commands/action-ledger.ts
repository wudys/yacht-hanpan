import { createHash } from 'node:crypto';

import type { PublicError } from '@repo/game-protocol/errors';
import {
  GAME_COMMAND_TYPE,
  type GameCommand,
  type ResolvedRollArtifact,
} from '@repo/game-protocol/socket';
import type { SeatIndex } from '@repo/yacht-rules';

const COMPLETED_ACTION_TTL_MS = 5 * 60_000;
export const MAX_ACTION_LEDGER_ENTRIES = 2_048;
export const MAX_ACTION_LEDGER_ENTRIES_PER_SEAT = MAX_ACTION_LEDGER_ENTRIES / 2;

export interface SuccessfulLogicalActionResult {
  readonly ok: true;
  readonly stateVersion: number;
  readonly roll?: ResolvedRollArtifact;
}

export interface FailedLogicalActionResult {
  readonly ok: false;
  readonly error: PublicError;
}

export type LogicalActionResult = SuccessfulLogicalActionResult | FailedLogicalActionResult;

export type LogicalActionDecision =
  Omit<SuccessfulLogicalActionResult, 'stateVersion'> | FailedLogicalActionResult;

export interface ActionIdentity {
  readonly seatIndex: SeatIndex;
  readonly actionId: string;
  readonly fingerprint: string;
}

export type CompletedActionLedgerEntry = ActionIdentity & {
  readonly status: 'completed';
  readonly expiresAt: number;
  readonly result: LogicalActionResult;
};

export type ActionTombstone = ActionIdentity & {
  readonly status: 'tombstone';
};

export type RetryableActionLedgerEntry = ActionIdentity & {
  readonly status: 'retryable';
};

export type ActionLedgerEntry =
  CompletedActionLedgerEntry | ActionTombstone | RetryableActionLedgerEntry;

export function fingerprintGameCommand(command: GameCommand): string {
  let canonical: string;
  switch (command.type) {
    case GAME_COMMAND_TYPE.ROLL_DICE:
      canonical = `${command.type}|${command.actionId}|${command.turnId}`;
      break;
    case GAME_COMMAND_TYPE.SET_DIE_HELD:
      canonical = `${command.type}|${command.actionId}|${command.turnId}|${command.slot}|${command.isHeld ? 1 : 0}`;
      break;
    case GAME_COMMAND_TYPE.SELECT_SCORE_CATEGORY:
      canonical = `${command.type}|${command.actionId}|${command.turnId}|${command.categoryId}`;
      break;
    case GAME_COMMAND_TYPE.FORFEIT_MATCH:
      canonical = `${command.type}|${command.actionId}`;
      break;
  }
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function hasExpiredActionResults(
  entries: readonly ActionLedgerEntry[],
  checkedAt: number,
): boolean {
  return entries.some((entry) => isExpiredActionResult(entry, checkedAt));
}

export function compactActionLedger(
  entries: readonly ActionLedgerEntry[],
  checkedAt: number,
): readonly ActionLedgerEntry[] {
  let compacted: ActionLedgerEntry[] | undefined;
  entries.forEach((entry, index) => {
    if (isExpiredActionResult(entry, checkedAt)) {
      compacted ??= [...entries];
      compacted[index] = {
        status: 'tombstone',
        seatIndex: entry.seatIndex,
        actionId: entry.actionId,
        fingerprint: entry.fingerprint,
      };
    }
  });
  return compacted ?? entries;
}

export function completeAction(
  entries: readonly ActionLedgerEntry[],
  input: ActionIdentity & { readonly completedAt: number; readonly result: LogicalActionResult },
): readonly ActionLedgerEntry[] | null {
  const existingIndex = entries.findIndex(
    (entry) => entry.seatIndex === input.seatIndex && entry.actionId === input.actionId,
  );
  const completed: CompletedActionLedgerEntry = {
    status: 'completed',
    seatIndex: input.seatIndex,
    actionId: input.actionId,
    fingerprint: input.fingerprint,
    result: input.result,
    expiresAt: input.completedAt + COMPLETED_ACTION_TTL_MS,
  };
  if (existingIndex !== -1) {
    if (entries[existingIndex]?.status !== 'retryable') return null;
    return entries.map((entry, index) => (index === existingIndex ? completed : entry));
  }
  if (!hasActionCapacity(entries, input.seatIndex)) return null;
  return [...entries, completed];
}

export function reserveRetryableAction(
  entries: readonly ActionLedgerEntry[],
  input: ActionIdentity,
): readonly ActionLedgerEntry[] | null {
  const existing = findAction(entries, input.seatIndex, input.actionId);
  if (existing !== undefined) return existing.fingerprint === input.fingerprint ? entries : null;
  if (!hasActionCapacity(entries, input.seatIndex)) return null;
  return [...entries, { status: 'retryable', ...input }];
}

export function findAction(
  entries: readonly ActionLedgerEntry[],
  seatIndex: SeatIndex,
  actionId: string,
): ActionLedgerEntry | undefined {
  return entries.find((entry) => entry.seatIndex === seatIndex && entry.actionId === actionId);
}

function isExpiredActionResult(entry: ActionLedgerEntry, checkedAt: number): boolean {
  return entry.status === 'completed' && checkedAt >= entry.expiresAt;
}

function hasActionCapacity(entries: readonly ActionLedgerEntry[], seatIndex: SeatIndex): boolean {
  return (
    entries.length < MAX_ACTION_LEDGER_ENTRIES &&
    entries.filter((entry) => entry.seatIndex === seatIndex).length <
      MAX_ACTION_LEDGER_ENTRIES_PER_SEAT
  );
}
