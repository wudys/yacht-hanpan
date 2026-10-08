import { parseCreateRoomRequest, parseJoinRoomRequest } from '@repo/game-protocol/http';

import { executeCreateRoom } from '@/rooms/application/admission/create-room';
import { CreateRoomRateLimiter } from '@/rooms/application/admission/create-room-rate-limiter';
import { executeJoinRoom } from '@/rooms/application/admission/join-room';
import type { PlayingRoomRecord } from '@/rooms/application/room-record';
import { InMemoryRoomRepository } from '@/rooms/application/room-repository';
import { RoomStateCommitter } from '@/rooms/application/room-state-committer';
import { InMemoryRoomTaskQueue } from '@/rooms/application/scheduling/room-task-queue';
import { resumeSeat } from '@/rooms/domain/presence';
import { roomId } from '@/rooms/domain/room-model';
import { isPlayingRoomState } from '@/rooms/domain/room-state';
import type { TaskScheduler } from '@/runtime/task-scheduler';

export const ROOM_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c39843e';
export const CREATOR_SEAT_INDEX = 0 as const;
export const JOINER_SEAT_INDEX = 1 as const;
const TURN_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c398441';
export const NEXT_TURN_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c398442';

export class ManualTaskScheduler implements TaskScheduler {
  public readonly tasks: Map<string, { runAt: number; task: () => void | Promise<void> }> =
    new Map();

  public schedule(key: string, runAt: number, task: () => void | Promise<void>): void {
    this.tasks.set(key, { runAt, task });
  }

  public cancel(key: string): void {
    this.tasks.delete(key);
  }

  public close(): void {
    this.tasks.clear();
  }

  public async run(key: string): Promise<void> {
    const scheduled = this.tasks.get(key);
    if (scheduled === undefined) throw new Error('scheduled task missing');
    this.tasks.delete(key);
    await scheduled.task();
  }
}

export async function playingFixture(): Promise<PlayingRoomRecord> {
  const repository = new InMemoryRoomRepository();
  const queue = new InMemoryRoomTaskQueue();
  const identity = {
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
      identity,
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
        ...identity,
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
  const record = repository.getById(roomId(ROOM_ID));
  if (record === undefined || !isPlayingRoomState(record)) {
    throw new Error('playing fixture missing');
  }
  const creatorConnected = resumeSeat(record.room, {
    seatIndex: CREATOR_SEAT_INDEX,
    resumedAt: 2_100,
  });
  if (!creatorConnected.ok) throw new Error('creator connect fixture failed');
  const joinerConnected = resumeSeat(creatorConnected.room, {
    seatIndex: JOINER_SEAT_INDEX,
    resumedAt: 2_200,
  });
  if (!joinerConnected.ok || joinerConnected.room.status !== 'playing') {
    throw new Error('joiner connect fixture failed');
  }
  return { ...record, room: joinerConnected.room };
}
