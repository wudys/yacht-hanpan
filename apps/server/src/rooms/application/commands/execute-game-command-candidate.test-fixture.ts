import { randomUUID } from 'node:crypto';

import type { RollCandidateEvaluation, SimulationInput } from '@repo/dice-simulation/contract';
import { createCompatibilityContract } from '@repo/game-protocol/version';

import { createAuthoritativeRollCommandExecutor } from '@/roll/authoritative-roll-command-executor';
import {
  installRolledRecord,
  playingRecord,
  ROOM_ID,
} from '@/rooms/application/commands/execute-game-command.test-fixture';
import type { InMemoryRoomRepository } from '@/rooms/application/room-repository';
import { roomId } from '@/rooms/domain/room-model';

export function candidateRollExecutor(
  evaluate: (input: SimulationInput) => Promise<RollCandidateEvaluation>,
) {
  let seedSequence = 0;
  return createAuthoritativeRollCommandExecutor({
    contract: createCompatibilityContract('test-release'),
    executionBudgetMs: 10_000,
    monotonicNow: () => 0,
    logger: { error: () => undefined },
    recipeSource: {
      createRollId: randomUUID,
      createRollSeed: () => (++seedSequence).toString(16).padStart(32, '0'),
      createPourStyle: () => 'burst',
    },
    simulation: { execute: evaluate },
  });
}

export function installSparseRollRecord(repository: InMemoryRoomRepository): void {
  installRolledRecord(repository);
  const current = playingRecord(repository);
  repository.replace(roomId(ROOM_ID), {
    ...current,
    match: {
      ...current.match,
      currentTurn: { ...current.match.currentTurn, heldSlots: [3, 0, 2] },
    },
  });
}
