import { POUR_STYLE } from '@repo/dice-simulation/contract';
import { parseCreateRoomRequest, parseJoinRoomRequest } from '@repo/game-protocol/http';
import { parseResolvedRollArtifact } from '@repo/game-protocol/socket';
import { createCompatibilityContract } from '@repo/game-protocol/version';

import type { RollCommandExecutor } from '@/roll/roll-command-executor';
import { executeCreateRoom } from '@/rooms/application/admission/create-room';
import { CreateRoomRateLimiter } from '@/rooms/application/admission/create-room-rate-limiter';
import { executeJoinRoom } from '@/rooms/application/admission/join-room';
import type {
  ExecuteGameCommandDependencies,
  ExecuteGameCommandResult,
} from '@/rooms/application/commands/execute-game-command';
import { PendingActionRegistry } from '@/rooms/application/commands/pending-action-registry';
import { InMemoryRoomRepository } from '@/rooms/application/room-repository';
import {
  RoomStateCommitter,
  type RoomStatePublication,
} from '@/rooms/application/room-state-committer';
import { InMemoryRoomTaskQueue } from '@/rooms/application/scheduling/room-task-queue';
import { roomId } from '@/rooms/domain/room-model';
import { isPlayingRoomState } from '@/rooms/domain/room-state';

export const ROOM_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c39843e';
export const CREATOR_SEAT_INDEX = 0 as const;
export const JOINER_SEAT_INDEX = 1 as const;
export const TURN_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c398441';
export const NEXT_TURN_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c398442';
export const ACTION_ID = 'a635fe2c-c4c8-4382-80d7-c35c5d5d455d';
const ROLL_ID = '8184fc0a-4e59-455d-a7c1-579a9ee96403';

export const unavailableRollCommandExecutor: RollCommandExecutor = {
  execute: () => Promise.resolve({ ok: false, reason: 'unavailable' }),
};

export async function fixture(queue: InMemoryRoomTaskQueue = new InMemoryRoomTaskQueue()) {
  const repository = new InMemoryRoomRepository();
  const baseIdentity = {
    createRequestId: () => '018f47f2-c2d8-7f4a-8bf4-3f559c398444',
    createRoomCodeCandidate: () => '001204',
    createRoomId: () => ROOM_ID,
    createSeatToken: () => 'd9428888-122b-4d34-8f6f-1f0f4f7f6b91',
    createTurnId: () => TURN_ID,
  };
  const created = executeCreateRoom(
    {
      request: parseCreateRoomRequest({
        clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c39843d',
        operationId: '4ba1e7d4-c077-4b80-b198-9b1f04c182c8',
        profile: { characterId: 'navy-bob', variant: false },
      }),
      ipAddress: '192.0.2.1',
    },
    {
      clock: { now: () => 1_000 },
      identity: baseIdentity,
      rateLimiter: new CreateRoomRateLimiter(),
      commits: new RoomStateCommitter({
        repository: repository,
        clock: { now: () => 1_000 },
        publishRoomState: () => undefined,
      }),
    },
  );
  if (!created.ok) throw new Error('create fixture failed');
  const joined = await executeJoinRoom(
    parseJoinRoomRequest({
      clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c398445',
      operationId: '888d7ad9-0311-42e8-a245-8e57c3046606',
      roomCode: '001204',
      profile: { characterId: 'blonde-buns', variant: false },
    }),
    {
      clock: { now: () => 2_000 },
      identity: {
        ...baseIdentity,
        createSeatToken: () => '9207e571-a39a-49d5-a75f-a08d5e52cce8',
      },
      queue,
      repository,
      commits: new RoomStateCommitter({
        repository: repository,
        clock: { now: () => 2_000 },
        publishRoomState: () => undefined,
      }),
    },
  );
  if (!joined.ok) throw new Error('join fixture failed');

  let now = 3_000;
  const published: Extract<RoomStatePublication, { kind: 'game' }>[] = [];
  const dependencies: ExecuteGameCommandDependencies = {
    clock: { now: () => now },
    identity: { createTurnId: () => NEXT_TURN_ID },
    pending: new PendingActionRegistry<ExecuteGameCommandResult>(),
    queue,
    repository,
    rolls: unavailableRollCommandExecutor,
    commits: new RoomStateCommitter({
      repository: repository,
      clock: { now: () => now },
      publishRoomState: (publication) => {
        if (publication.kind === 'game') published.push(publication);
      },
    }),
  };
  return { dependencies, published, repository, setNow: (value: number) => (now = value) };
}

export function playingRecord(repository: InMemoryRoomRepository) {
  const record = repository.getById(roomId(ROOM_ID));
  if (record === undefined || !isPlayingRoomState(record)) {
    throw new Error('playing record missing');
  }
  return record;
}

export function installRolledRecord(repository: InMemoryRoomRepository): void {
  const current = playingRecord(repository);
  repository.replace(roomId(ROOM_ID), {
    ...current,
    match: {
      ...current.match,
      currentTurn: {
        ...current.match.currentTurn,
        diceState: {
          rollCount: 1,
          dice: [{ value: 1 }, { value: 2 }, { value: 3 }, { value: 4 }, { value: 5 }],
        },
      },
    },
  });
}

export function resolvedRollArtifact() {
  return parseResolvedRollArtifact({
    type: 'roll:resolved',
    replay: {
      mode: 'seeded-physics',
      rollId: ROLL_ID,
      seed: 'ab'.repeat(32),
      pourStyle: POUR_STYLE.CLASSIC,
      rolledSlots: [0, 1, 2, 3, 4],
      contract: createCompatibilityContract('test-release'),
    },
    outcome: {
      authoritativeValuesBySlot: [
        { slot: 0, value: 1 },
        { slot: 1, value: 2 },
        { slot: 2, value: 3 },
        { slot: 3, value: 4 },
        { slot: 4, value: 5 },
      ],
    },
  });
}
