import { randomUUID } from 'node:crypto';

import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import { GAME_COMMAND_TYPE, parseCommandAck, parseGameCommand } from '@repo/game-protocol/socket';
import { GAME_PROTOCOL_VERSION } from '@repo/game-protocol/version';
import type { SeatIndex } from '@repo/yacht-rules';
import { describe, expect, spyOn, test } from 'bun:test';

import {
  fingerprintGameCommand,
  MAX_ACTION_LEDGER_ENTRIES,
} from '@/rooms/application/commands/action-ledger';
import {
  executeGameCommand,
  type ExecuteGameCommandDependencies,
} from '@/rooms/application/commands/execute-game-command';
import {
  ACTION_ID,
  CREATOR_SEAT_INDEX,
  fixture,
  installRolledRecord,
  JOINER_SEAT_INDEX,
  NEXT_TURN_ID,
  playingRecord,
  resolvedRollArtifact,
  ROOM_ID,
  TURN_ID,
  unavailableRollCommandExecutor,
} from '@/rooms/application/commands/execute-game-command.test-fixture';
import { InMemoryRoomRepository } from '@/rooms/application/room-repository';
import { RoomStateCommitter } from '@/rooms/application/room-state-committer';
import { RoomDeadlineScheduler } from '@/rooms/application/scheduling/deadline-scheduler';
import { InMemoryRoomTaskQueue } from '@/rooms/application/scheduling/room-task-queue';
import { executeSyncRoom } from '@/rooms/application/sync-room';
import type { PlayingMatch } from '@/rooms/domain/match';
import { disconnectSeat, resumeSeat } from '@/rooms/domain/presence';
import { roomId } from '@/rooms/domain/room-model';
import { epochMilliseconds } from '@/rooms/domain/time';

async function capturedFixture() {
  let now = 3_000;
  const wakes = new Map<string, { runAt: number; task: () => void | Promise<void> }>();
  const queue = new InMemoryRoomTaskQueue({
    clock: { now: () => now },
    tasks: {
      schedule: (key, runAt, task) => {
        wakes.set(key, { runAt, task });
      },
      cancel: (key) => {
        wakes.delete(key);
      },
    },
  });
  const state = await fixture(queue);
  return {
    ...state,
    queue,
    advance: async (value: number) => {
      now = value;
      state.setNow(value);
      for (const [key, wake] of [...wakes]) {
        if (wake.runAt <= now) {
          wakes.delete(key);
          await wake.task();
        }
      }
    },
  };
}

describe('executeGameCommand', () => {
  test('recovers a completed roll receipt after its publisher throws without repeating effects', async () => {
    const state = await fixture();
    const artifact = resolvedRollArtifact();
    let executorCalls = 0;
    let publications = 0;
    const dependencies: ExecuteGameCommandDependencies = {
      ...state.dependencies,
      rolls: {
        execute: async () => {
          executorCalls += 1;
          return { ok: true, artifact };
        },
      },
      commits: new RoomStateCommitter({
        repository: state.repository,
        clock: state.dependencies.clock,
        publishRoomState: () => {
          publications += 1;
          throw new Error('publication failed');
        },
      }),
    };
    const input = {
      roomId: roomId(ROOM_ID),
      seatIndex: CREATOR_SEAT_INDEX,
      receivedAt: 3_000,
      command: parseGameCommand({
        type: GAME_COMMAND_TYPE.ROLL_DICE,
        actionId: ACTION_ID,
        turnId: TURN_ID,
      }),
    };
    const replace = spyOn(state.repository, 'replace');

    await expect(executeGameCommand(input, dependencies)).rejects.toThrow('publication failed');
    const committed = playingRecord(state.repository);
    expect(committed.match.currentTurn.diceState.rollCount).toBe(1);
    expect(committed.actionLedger).toMatchObject([{ status: 'completed', actionId: ACTION_ID }]);
    expect(dependencies.pending.totalCount()).toBe(0);

    const retried = await executeGameCommand(input, dependencies);

    expect(retried).toMatchObject({
      result: { ok: true, data: { receipt: { stateVersion: 2, roll: artifact } } },
      committedStateVersion: null,
    });
    expect(state.repository.getById(roomId(ROOM_ID))).toBe(committed);
    expect(executorCalls).toBe(1);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(publications).toBe(1);
    expect(dependencies.pending.totalCount()).toBe(0);
  });

  test.each([
    ['completed', 70_000],
    ['tombstone', 303_000],
  ] as const)(
    'recovers a %s before reconciling a newly received overdue command',
    async (status, receivedAt) => {
      const state = await fixture();
      const artifact = resolvedRollArtifact();
      let executorCalls = 0;
      let turnIdentities = 0;
      const dependencies: ExecuteGameCommandDependencies = {
        ...state.dependencies,
        identity: {
          createTurnId: () => {
            turnIdentities += 1;
            return NEXT_TURN_ID;
          },
        },
        rolls: {
          execute: async () => {
            executorCalls += 1;
            return { ok: true, artifact };
          },
        },
      };
      const input = {
        roomId: roomId(ROOM_ID),
        seatIndex: CREATOR_SEAT_INDEX,
        receivedAt: 3_000,
        command: parseGameCommand({
          type: GAME_COMMAND_TYPE.ROLL_DICE,
          actionId: ACTION_ID,
          turnId: TURN_ID,
        }),
      };
      const first = await executeGameCommand(input, dependencies);
      if (!first.result.ok) throw new Error('fixture roll failed');
      const before = playingRecord(state.repository);
      const replace = spyOn(state.repository, 'replace');
      state.setNow(receivedAt);

      const duplicate = await executeGameCommand({ ...input, receivedAt }, dependencies);

      if (status === 'completed') {
        expect(duplicate.result).toMatchObject({
          ok: true,
          data: { receipt: first.result.data.receipt },
        });
        expect(state.repository.getById(roomId(ROOM_ID))).toBe(before);
      } else {
        expect(duplicate.result).toMatchObject({
          ok: false,
          error: { code: PUBLIC_ERROR_CODE.ACTION_RESULT_EXPIRED, params: {} },
          recovery: { game: { stateVersion: 2, match: { status: 'playing' } } },
        });
      }
      const after = playingRecord(state.repository);
      expect(after.match).toBe(before.match);
      expect(after.room).toBe(before.room);
      expect(after.stateVersion).toBe(before.stateVersion);
      expect(after.presenceVersion).toBe(before.presenceVersion);
      expect(after.actionLedger).toMatchObject([{ status, actionId: ACTION_ID }]);
      expect(duplicate.committedStateVersion).toBeNull();
      expect(replace).toHaveBeenCalledTimes(status === 'completed' ? 0 : 1);
      expect(turnIdentities).toBe(0);
      expect(executorCalls).toBe(1);
      expect(state.published).toHaveLength(1);
      expect(dependencies.pending.totalCount()).toBe(0);
    },
  );

  test('rejects an unusable successful roll result without storing state or a receipt', async () => {
    const state = await fixture();
    const before = state.repository.getById(roomId(ROOM_ID));
    const artifact = resolvedRollArtifact();
    const result = await executeGameCommand(
      {
        roomId: roomId(ROOM_ID),
        seatIndex: CREATOR_SEAT_INDEX,
        receivedAt: 3_000,
        command: parseGameCommand({
          type: GAME_COMMAND_TYPE.ROLL_DICE,
          actionId: ACTION_ID,
          turnId: TURN_ID,
        }),
      },
      {
        ...state.dependencies,
        rolls: {
          execute: () =>
            Promise.resolve({
              ok: true,
              artifact: {
                ...artifact,
                outcome: {
                  authoritativeValuesBySlot: artifact.outcome.authoritativeValuesBySlot.slice(1),
                },
              },
            }),
        },
      },
    );

    expect(result).toEqual({
      result: { ok: false, error: { code: PUBLIC_ERROR_CODE.INTERNAL_ERROR, params: {} } },
      committedStateVersion: null,
    });
    expect(state.repository.getById(roomId(ROOM_ID))).toBe(before);
    expect(state.published).toEqual([]);
    expect(state.dependencies.pending.totalCount()).toBe(0);
  });

  test('keeps failed room finalization as INTERNAL_ERROR without committing the forfeit', async () => {
    const state = await fixture();
    const before = state.repository.getById(roomId(ROOM_ID));
    state.setNow(1_999);

    const result = await executeGameCommand(
      {
        roomId: roomId(ROOM_ID),
        seatIndex: CREATOR_SEAT_INDEX,
        receivedAt: 3_000,
        command: parseGameCommand({ type: GAME_COMMAND_TYPE.FORFEIT_MATCH, actionId: ACTION_ID }),
      },
      state.dependencies,
    );

    expect(result).toEqual({
      result: { ok: false, error: { code: PUBLIC_ERROR_CODE.INTERNAL_ERROR, params: {} } },
      committedStateVersion: null,
    });
    expect(state.repository.getById(roomId(ROOM_ID))).toBe(before);
    expect(state.published).toEqual([]);
  });

  test.each(['rejected', 'nonterminal-score'] as const)(
    'keeps reconnect expiry open for a same-time forfeit after %s gameplay',
    async (path) => {
      const state = await capturedFixture();
      installRolledRecord(state.repository);
      const current = playingRecord(state.repository);
      state.repository.replace(roomId(ROOM_ID), {
        ...current,
        match: {
          ...current.match,
          currentTurn: { ...current.match.currentTurn, deadlineAt: epochMilliseconds(200_000) },
        },
      });
      installDisconnectedRecord(state.repository, JOINER_SEAT_INDEX, 10_000);
      await state.advance(100_000);
      const gameplay = await executeGameCommand(
        {
          roomId: roomId(ROOM_ID),
          seatIndex: path === 'rejected' ? JOINER_SEAT_INDEX : CREATOR_SEAT_INDEX,
          receivedAt: 100_000,
          command: parseGameCommand(
            path === 'rejected'
              ? {
                  type: GAME_COMMAND_TYPE.SET_DIE_HELD,
                  actionId: randomUUID(),
                  turnId: TURN_ID,
                  slot: 0,
                  isHeld: true,
                }
              : {
                  type: GAME_COMMAND_TYPE.SELECT_SCORE_CATEGORY,
                  actionId: randomUUID(),
                  turnId: TURN_ID,
                  categoryId: 'ones',
                },
          ),
        },
        state.dependencies,
      );
      expect(gameplay.result).toMatchObject(
        path === 'rejected'
          ? { ok: false, error: { code: PUBLIC_ERROR_CODE.NOT_YOUR_TURN } }
          : { ok: true, data: { receipt: { stateVersion: 2 } } },
      );
      expect(state.repository.getById(roomId(ROOM_ID))?.match?.status).toBe('playing');
      const forfeit = executeGameCommand(
        {
          roomId: roomId(ROOM_ID),
          seatIndex: CREATOR_SEAT_INDEX,
          receivedAt: 100_000,
          command: parseGameCommand({ type: GAME_COMMAND_TYPE.FORFEIT_MATCH, actionId: ACTION_ID }),
        },
        state.dependencies,
      );
      await state.advance(100_001);
      expect((await forfeit).result).toMatchObject({
        ok: true,
        data: { receipt: { stateVersion: path === 'rejected' ? 2 : 3 } },
      });
      expect(state.repository.getById(roomId(ROOM_ID))?.match).toMatchObject({
        status: 'finished',
        result: { reason: 'explicitForfeit', winnerSeatIndex: JOINER_SEAT_INDEX },
      });
    },
  );

  test('keeps an earlier forfeit ahead of a later final score behind a busy queue', async () => {
    const state = await capturedFixture();
    installFinalScoreRecord(state.repository);
    const gate = Promise.withResolvers<void>();
    const blocker = state.queue.run(roomId(ROOM_ID), () => gate.promise);
    const forfeit = executeGameCommand(
      {
        roomId: roomId(ROOM_ID),
        seatIndex: JOINER_SEAT_INDEX,
        receivedAt: 3_000,
        command: parseGameCommand({ type: GAME_COMMAND_TYPE.FORFEIT_MATCH, actionId: ACTION_ID }),
      },
      state.dependencies,
    );
    await state.advance(3_001);
    const score = executeGameCommand(
      {
        roomId: roomId(ROOM_ID),
        seatIndex: CREATOR_SEAT_INDEX,
        receivedAt: 3_001,
        command: parseGameCommand({
          type: GAME_COMMAND_TYPE.SELECT_SCORE_CATEGORY,
          actionId: randomUUID(),
          turnId: TURN_ID,
          categoryId: 'ones',
        }),
      },
      state.dependencies,
    );
    gate.resolve();
    await blocker;
    expect((await forfeit).result).toMatchObject({
      ok: true,
      data: { receipt: { stateVersion: 2 } },
    });
    expect((await score).result).toMatchObject({
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.MATCH_FINISHED },
    });
    expect(state.repository.getById(roomId(ROOM_ID))?.match).toMatchObject({
      status: 'finished',
      result: { reason: 'explicitForfeit', winnerSeatIndex: CREATOR_SEAT_INDEX },
    });
  });

  test('does not let a rejected same-time score suppress forfeit', async () => {
    const state = await capturedFixture();
    installFinalScoreRecord(state.repository);
    const forfeit = executeGameCommand(
      {
        roomId: roomId(ROOM_ID),
        seatIndex: JOINER_SEAT_INDEX,
        receivedAt: 3_000,
        command: parseGameCommand({ type: GAME_COMMAND_TYPE.FORFEIT_MATCH, actionId: ACTION_ID }),
      },
      state.dependencies,
    );
    const score = executeGameCommand(
      {
        roomId: roomId(ROOM_ID),
        seatIndex: CREATOR_SEAT_INDEX,
        receivedAt: 3_000,
        command: parseGameCommand({
          type: GAME_COMMAND_TYPE.SELECT_SCORE_CATEGORY,
          actionId: randomUUID(),
          turnId: NEXT_TURN_ID,
          categoryId: 'ones',
        }),
      },
      state.dependencies,
    );
    expect((await score).result).toMatchObject({
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.STALE_TURN },
    });
    await state.advance(3_001);
    expect((await forfeit).result).toMatchObject({
      ok: true,
      data: { receipt: { stateVersion: 2 } },
    });
    expect(state.repository.getById(roomId(ROOM_ID))?.match).toMatchObject({
      status: 'finished',
      result: { reason: 'explicitForfeit' },
    });
  });

  test('holds forfeit ACK, coalesces duplicates, and syncs after its single commit', async () => {
    const state = await capturedFixture();
    const input = {
      roomId: roomId(ROOM_ID),
      seatIndex: JOINER_SEAT_INDEX,
      receivedAt: 3_000,
      command: parseGameCommand({ type: GAME_COMMAND_TYPE.FORFEIT_MATCH, actionId: ACTION_ID }),
    };
    let acknowledged = false;
    const first = executeGameCommand(input, state.dependencies).then((result) => {
      acknowledged = true;
      return result;
    });
    const duplicate = executeGameCommand(input, state.dependencies);
    const sync = executeSyncRoom(
      { roomId: input.roomId, seatIndex: input.seatIndex },
      state.dependencies,
    );
    await state.queue.run(roomId('other-room'), () => undefined);
    expect(acknowledged).toBeFalse();
    expect(playingRecord(state.repository).stateVersion).toBe(1);
    expect(state.queue.pendingRequestCount).toBe(2);
    await state.advance(3_001);
    const owner = await first;
    const replayed = await duplicate;
    expect(owner.result).toMatchObject({ ok: true, data: { receipt: { stateVersion: 2 } } });
    expect(replayed.result).toEqual(owner.result);
    expect(replayed.committedStateVersion).toBeNull();
    expect(await sync).toMatchObject({
      ok: true,
      data: { game: { stateVersion: 2, match: { status: 'finished' } } },
    });
    expect(state.repository.getById(input.roomId)?.actionLedger).toHaveLength(1);
    expect(state.queue.pendingRequestCount).toBe(0);
    expect(state.dependencies.pending.totalCount()).toBe(0);
  });

  test.each([
    ['forfeit-first', false],
    ['score-first', false],
    ['forfeit-first', true],
    ['score-first', true],
  ] as const)(
    'resolves a final score and forfeit captured in one millisecond: %s, blocked %s',
    async (order, blocked) => {
      const state = await capturedFixture();
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const blocker = blocked
        ? state.queue.run(roomId(ROOM_ID), async () => {
            entered.resolve();
            await gate.promise;
          })
        : Promise.resolve();
      if (blocked) await entered.promise;
      installFinalScoreRecord(state.repository);
      const current = playingRecord(state.repository);
      state.repository.replace(roomId(ROOM_ID), {
        ...current,
        match: {
          ...current.match,
          players: [
            current.match.players[0],
            {
              ...current.match.players[1],
              scorecard: { ...current.match.players[1].scorecard, ones: 5 },
            },
          ],
        },
      });
      const forfeit = () =>
        executeGameCommand(
          {
            roomId: roomId(ROOM_ID),
            seatIndex: JOINER_SEAT_INDEX,
            receivedAt: 3_000,
            command: parseGameCommand({
              type: GAME_COMMAND_TYPE.FORFEIT_MATCH,
              actionId: ACTION_ID,
            }),
          },
          state.dependencies,
        );
      const score = () =>
        executeGameCommand(
          {
            roomId: roomId(ROOM_ID),
            seatIndex: CREATOR_SEAT_INDEX,
            receivedAt: 3_000,
            command: parseGameCommand({
              type: GAME_COMMAND_TYPE.SELECT_SCORE_CATEGORY,
              actionId: randomUUID(),
              turnId: TURN_ID,
              categoryId: 'ones',
            }),
          },
          state.dependencies,
        );
      const first = order === 'forfeit-first' ? forfeit() : score();
      const second = order === 'forfeit-first' ? score() : forfeit();
      await Promise.resolve();
      await state.advance(blocked ? 250_000 : 3_001);
      gate.resolve();
      await blocker;
      const [firstResult, secondResult] = await Promise.all([first, second]);
      const scored = order === 'forfeit-first' ? secondResult : firstResult;
      const forfeited = order === 'forfeit-first' ? firstResult : secondResult;
      expect(scored.result).toMatchObject({ ok: true, data: { receipt: { stateVersion: 2 } } });
      expect(forfeited.result).toMatchObject({
        ok: false,
        error: { code: PUBLIC_ERROR_CODE.MATCH_FINISHED },
      });
      expect(forfeited.committedStateVersion).toBeNull();
      expect(scored.committedStateVersion).toBe(2);
      expect(state.published).toHaveLength(1);
      expect(state.published[0]).toMatchObject({
        update: { view: { game: { stateVersion: 2, match: { status: 'finished' } } } },
      });
      expect(state.repository.getById(roomId(ROOM_ID))?.match).toMatchObject({
        status: 'finished',
        result: { reason: 'scoresCompleted', winnerSeatIndex: JOINER_SEAT_INDEX },
      });
      expect(state.queue.pendingRequestCount).toBe(0);
      expect(state.dependencies.pending.totalCount()).toBe(0);
    },
  );

  test.each([
    [CREATOR_SEAT_INDEX, GAME_COMMAND_TYPE.SELECT_SCORE_CATEGORY],
    [CREATOR_SEAT_INDEX, GAME_COMMAND_TYPE.FORFEIT_MATCH],
    [JOINER_SEAT_INDEX, GAME_COMMAND_TYPE.SELECT_SCORE_CATEGORY],
    [JOINER_SEAT_INDEX, GAME_COMMAND_TYPE.FORFEIT_MATCH],
  ] as const)(
    'preserves seat %d command %s after its opponent floods rejected actions',
    async (seatIndex, type) => {
      const state = await fixture();
      installRolledRecord(state.repository);
      const current = playingRecord(state.repository);
      state.repository.replace(roomId(ROOM_ID), {
        ...current,
        match: { ...current.match, currentTurn: { ...current.match.currentTurn, seatIndex } },
      });
      const opponent = seatIndex === CREATOR_SEAT_INDEX ? JOINER_SEAT_INDEX : CREATOR_SEAT_INDEX;
      for (let index = 0; index < 2_048; index += 1) {
        const denied = await executeGameCommand(
          {
            roomId: roomId(ROOM_ID),
            seatIndex: opponent,
            receivedAt: 3_000,
            command: parseGameCommand({
              type: GAME_COMMAND_TYPE.ROLL_DICE,
              actionId: randomUUID(),
              turnId: TURN_ID,
            }),
          },
          state.dependencies,
        );
        expect(denied.result.ok).toBe(false);
        expect(denied.committedStateVersion).toBeNull();
      }
      const command = parseGameCommand({
        type,
        actionId: randomUUID(),
        ...(type === GAME_COMMAND_TYPE.SELECT_SCORE_CATEGORY
          ? { turnId: TURN_ID, categoryId: 'ones' }
          : {}),
      });
      const result = await executeGameCommand(
        { roomId: roomId(ROOM_ID), seatIndex, receivedAt: 3_000, command },
        state.dependencies,
      );
      expect(result.result).toMatchObject({ ok: true, data: { receipt: { stateVersion: 2 } } });
      expect(result.committedStateVersion).toBe(2);
      expect(state.published).toHaveLength(1);
      expect(state.published[0]).toMatchObject({ update: { view: { game: { stateVersion: 2 } } } });
      const stored = state.repository.getById(roomId(ROOM_ID));
      if (type === GAME_COMMAND_TYPE.SELECT_SCORE_CATEGORY) {
        expect(stored?.match?.players[seatIndex].scorecard).toMatchObject({ ones: 1 });
      } else {
        expect(stored?.match).toMatchObject({
          status: 'finished',
          result: { reason: 'explicitForfeit', winnerSeatIndex: opponent },
        });
      }
      expect(state.repository.getById(roomId(ROOM_ID))?.actionLedger).toHaveLength(1_025);
    },
  );

  test.each(['completed', 'retryable', 'automatic', 'tombstone'] as const)(
    'does not publish or acknowledge a result when %s storage fails',
    async (path) => {
      const state = await fixture();
      const command = parseGameCommand({
        type:
          path === 'completed' || path === 'retryable'
            ? GAME_COMMAND_TYPE.ROLL_DICE
            : GAME_COMMAND_TYPE.FORFEIT_MATCH,
        actionId: ACTION_ID,
        ...(path === 'completed' || path === 'retryable' ? { turnId: TURN_ID } : {}),
      });
      const input = {
        roomId: roomId(ROOM_ID),
        seatIndex: CREATOR_SEAT_INDEX,
        command,
        receivedAt: 3_000,
      };
      if (path === 'automatic') {
        const current = playingRecord(state.repository);
        state.repository.replace(input.roomId, {
          ...current,
          match: {
            ...current.match,
            players: [{ ...current.match.players[0], timeoutCount: 1 }, current.match.players[1]],
            currentTurn: { ...current.match.currentTurn, deadlineAt: epochMilliseconds(3_000) },
          },
        });
      }
      if (path === 'tombstone') {
        await executeGameCommand(input, state.dependencies);
        state.setNow(303_000);
      }
      const before = state.repository.getById(input.roomId);
      const beforeValue = structuredClone(before);
      const publishedBefore = state.published.length;
      const replace = spyOn(state.repository, 'replace').mockReturnValue(false);
      const artifact = resolvedRollArtifact();
      const result = await executeGameCommand(input, {
        ...state.dependencies,
        rolls:
          path === 'completed'
            ? {
                execute: async () => ({
                  ok: true,
                  artifact,
                }),
              }
            : unavailableRollCommandExecutor,
      });
      expect(replace).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        result: { ok: false, error: { code: PUBLIC_ERROR_CODE.INTERNAL_ERROR, params: {} } },
        committedStateVersion: null,
      });
      expect(state.repository.getById(input.roomId)).toBe(before);
      expect(state.repository.getById(input.roomId)).toEqual(beforeValue);
      expect(state.dependencies.pending.count(ROOM_ID)).toBe(0);
      expect(state.published).toHaveLength(publishedBefore);
    },
  );

  test('commits forfeit once and replays only the stable completed result', async () => {
    const state = await fixture();
    const command = parseGameCommand({
      type: GAME_COMMAND_TYPE.FORFEIT_MATCH,
      actionId: ACTION_ID,
    });
    const input = {
      roomId: roomId(ROOM_ID),
      seatIndex: JOINER_SEAT_INDEX,
      command,
      receivedAt: 3_000,
    };

    const first = await executeGameCommand(input, state.dependencies);
    expect(first.result).toMatchObject({ ok: true, data: { receipt: { stateVersion: 2 } } });
    expect(first.committedStateVersion).toBe(2);
    expect(state.published[0]).toMatchObject({
      kind: 'game',
      update: { view: { game: { stateVersion: 2 } } },
    });
    expect(state.repository.getById(roomId(ROOM_ID))?.match).toMatchObject({
      status: 'finished',
      result: { reason: 'explicitForfeit', winnerSeatIndex: CREATOR_SEAT_INDEX },
    });

    const duplicate = await executeGameCommand(input, state.dependencies);
    expect(duplicate.result).toEqual(first.result);
    expect(duplicate.committedStateVersion).toBeNull();
    expect(state.repository.getById(roomId(ROOM_ID))?.stateVersion).toBe(2);
    expect(state.published).toHaveLength(1);
  });

  test('keeps an original roll receipt while completed duplicates carry the current finished view', async () => {
    const state = await fixture();
    const artifact = resolvedRollArtifact();
    const dependencies: ExecuteGameCommandDependencies = {
      ...state.dependencies,
      rolls: { execute: async () => ({ ok: true, artifact }) },
    };
    const input = {
      roomId: roomId(ROOM_ID),
      seatIndex: CREATOR_SEAT_INDEX,
      receivedAt: 3_000,
      command: parseGameCommand({
        type: GAME_COMMAND_TYPE.ROLL_DICE,
        actionId: ACTION_ID,
        turnId: TURN_ID,
      }),
    };
    const first = await executeGameCommand(input, dependencies);
    await executeGameCommand(
      {
        ...input,
        command: parseGameCommand({
          type: GAME_COMMAND_TYPE.FORFEIT_MATCH,
          actionId: randomUUID(),
        }),
      },
      dependencies,
    );
    const before = state.repository.getById(input.roomId);
    const duplicate = await executeGameCommand(input, dependencies);
    if (!first.result.ok || !duplicate.result.ok) throw new Error('expected successful receipts');
    expect(first.result.data.view).toMatchObject({
      room: { status: 'playing' },
      game: { stateVersion: 2, match: { status: 'playing' } },
    });
    expect(duplicate.result.data.receipt).toEqual(first.result.data.receipt);
    expect(duplicate.result.data.view).toMatchObject({
      room: { status: 'finished' },
      game: { stateVersion: 3, match: { status: 'finished' } },
    });
    expect(
      parseCommandAck({
        ...duplicate.result,
        meta: {
          requestId: '018f47f2-c2d8-7f4a-8bf4-3f559c398444',
          gameProtocolVersion: GAME_PROTOCOL_VERSION,
          actionId: ACTION_ID,
        },
      }).ok,
    ).toBeTrue();
    expect(duplicate.committedStateVersion).toBeNull();
    expect(state.repository.getById(input.roomId)).toBe(before);
    expect(state.published).toHaveLength(2);
    expect(before?.actionLedger[0]).toMatchObject({
      status: 'completed',
      result: { ok: true, stateVersion: 2, roll: artifact },
    });
    expect(before?.actionLedger[0]).not.toHaveProperty('view');
    expect(before?.actionLedger[0]).not.toHaveProperty('result.view');
  });

  test('shares the captured roll view with pending duplicates even when the next queued command advances', async () => {
    const state = await fixture();
    const artifact = resolvedRollArtifact();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let executions = 0;
    const dependencies: ExecuteGameCommandDependencies = {
      ...state.dependencies,
      rolls: {
        execute: async () => {
          executions += 1;
          entered.resolve();
          await release.promise;
          return { ok: true, artifact };
        },
      },
    };
    const input = {
      roomId: roomId(ROOM_ID),
      seatIndex: CREATOR_SEAT_INDEX,
      receivedAt: 3_000,
      command: parseGameCommand({
        type: GAME_COMMAND_TYPE.ROLL_DICE,
        actionId: ACTION_ID,
        turnId: TURN_ID,
      }),
    };
    const first = executeGameCommand(input, dependencies);
    await entered.promise;
    const duplicate = executeGameCommand(input, dependencies);
    const next = executeGameCommand(
      {
        ...input,
        command: parseGameCommand({
          type: GAME_COMMAND_TYPE.SET_DIE_HELD,
          actionId: randomUUID(),
          turnId: TURN_ID,
          slot: 0,
          isHeld: true,
        }),
      },
      dependencies,
    );
    release.resolve();
    const [owner, replayed, held] = await Promise.all([first, duplicate, next]);
    if (!owner.result.ok || !replayed.result.ok || !held.result.ok)
      throw new Error('expected successful commands');
    expect(replayed.result).toEqual(owner.result);
    expect(Number(replayed.result.data.view.game?.stateVersion)).toBe(2);
    expect(Number(held.result.data.view.game?.stateVersion)).toBe(3);
    expect(owner.result.data.view.game?.match).toMatchObject({ currentTurn: { heldSlots: [] } });
    expect(held.result.data.view.game?.match).toMatchObject({ currentTurn: { heldSlots: [0] } });
    expect(replayed.committedStateVersion).toBeNull();
    expect(executions).toBe(1);
    expect(state.published).toHaveLength(2);
    expect(dependencies.pending.totalCount()).toBe(0);
  });

  test('rejects conflicting action reuse before applying another command', async () => {
    const state = await fixture();
    const forfeit = parseGameCommand({
      type: GAME_COMMAND_TYPE.FORFEIT_MATCH,
      actionId: ACTION_ID,
    });
    await executeGameCommand(
      {
        roomId: roomId(ROOM_ID),
        seatIndex: JOINER_SEAT_INDEX,
        command: forfeit,
        receivedAt: 3_000,
      },
      state.dependencies,
    );
    const conflict = await executeGameCommand(
      {
        roomId: roomId(ROOM_ID),
        seatIndex: JOINER_SEAT_INDEX,
        command: parseGameCommand({
          type: GAME_COMMAND_TYPE.SET_DIE_HELD,
          actionId: ACTION_ID,
          turnId: TURN_ID,
          slot: 0,
          isHeld: true,
        }),
        receivedAt: 3_000,
      },
      state.dependencies,
    );
    expect(conflict.result).toEqual({
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.ACTION_ID_REUSED, params: {} },
    });
  });

  test('returns a full recovery snapshot after the stored action result expires', async () => {
    const state = await fixture();
    const input = {
      roomId: roomId(ROOM_ID),
      seatIndex: JOINER_SEAT_INDEX,
      command: parseGameCommand({ type: GAME_COMMAND_TYPE.FORFEIT_MATCH, actionId: ACTION_ID }),
      receivedAt: 3_000,
    };
    await executeGameCommand(input, state.dependencies);
    state.setNow(303_000);

    const expired = await executeGameCommand(input, state.dependencies);

    expect(expired.result).toMatchObject({
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.ACTION_RESULT_EXPIRED, params: {} },
      recovery: {
        room: { status: 'finished', roomId: ROOM_ID },
        game: { stateVersion: 2, match: { status: 'finished' } },
        presence: {
          roomId: ROOM_ID,
          presenceVersion: 1,
          seats: [{ status: 'disconnected' }, { status: 'disconnected' }],
        },
      },
    });
    expect(expired.committedStateVersion).toBeNull();
    expect(state.repository.getById(roomId(ROOM_ID))?.actionLedger).toMatchObject([
      { status: 'tombstone', actionId: ACTION_ID },
    ]);
  });

  test.each([
    ['unavailable', PUBLIC_ERROR_CODE.ROLL_UNAVAILABLE, false],
    ['capacity', PUBLIC_ERROR_CODE.RATE_LIMITED, false],
    ['unavailable', PUBLIC_ERROR_CODE.ROLL_UNAVAILABLE, true],
    ['capacity', PUBLIC_ERROR_CODE.RATE_LIMITED, true],
  ] as const)(
    'reserves %s (%s) with overdue turn %p without consuming a roll',
    async (reason, code, overdue) => {
      const state = await fixture();
      if (overdue) state.setNow(93_000);
      let executorCalls = 0;
      const dependencies: ExecuteGameCommandDependencies = {
        ...state.dependencies,
        rolls: {
          execute: (rollInput) => {
            executorCalls += 1;
            expect(rollInput).toEqual({ rolledSlots: [0, 1, 2, 3, 4] });
            return Promise.resolve({ ok: false, reason });
          },
        },
      };
      const input = {
        roomId: roomId(ROOM_ID),
        seatIndex: overdue ? JOINER_SEAT_INDEX : CREATOR_SEAT_INDEX,
        command: parseGameCommand({
          type: GAME_COMMAND_TYPE.ROLL_DICE,
          actionId: ACTION_ID,
          turnId: overdue ? NEXT_TURN_ID : TURN_ID,
        }),
        receivedAt: overdue ? 93_000 : 3_000,
      };
      const first = await executeGameCommand(input, dependencies);
      const second = await executeGameCommand(input, dependencies);
      expect(first.result).toEqual({
        ok: false,
        error:
          code === PUBLIC_ERROR_CODE.RATE_LIMITED
            ? { code, params: { retryAfterMs: 1_000 } }
            : { code, params: {} },
      });
      expect(second.result).toEqual(first.result);
      expect(state.repository.getById(roomId(ROOM_ID))?.actionLedger).toEqual([
        expect.objectContaining({ status: 'retryable', actionId: ACTION_ID }),
      ]);
      const after = playingRecord(state.repository);
      expect(after.stateVersion).toBe(overdue ? 2 : 1);
      expect(after.match.players[0].timeoutCount).toBe(overdue ? 1 : 0);
      expect(after.match.currentTurn.diceState.rollCount).toBe(0);
      expect(state.published).toHaveLength(overdue ? 1 : 0);
      expect(first.committedStateVersion).toBe(overdue ? 2 : null);
      expect(second.committedStateVersion).toBeNull();
      expect(executorCalls).toBe(2);

      const conflict = await executeGameCommand(
        {
          ...input,
          command: parseGameCommand({
            type: GAME_COMMAND_TYPE.ROLL_DICE,
            actionId: ACTION_ID,
            turnId: overdue ? TURN_ID : NEXT_TURN_ID,
          }),
        },
        dependencies,
      );
      expect(conflict.result).toEqual({
        ok: false,
        error: { code: PUBLIC_ERROR_CODE.ACTION_ID_REUSED, params: {} },
      });
      expect(executorCalls).toBe(2);
    },
  );

  test.each([false, true])(
    'admits a full-ledger roll only for an existing retryable identity: %s',
    async (retryable) => {
      const state = await fixture();
      const command = parseGameCommand({
        type: GAME_COMMAND_TYPE.ROLL_DICE,
        actionId: ACTION_ID,
        turnId: TURN_ID,
      });
      const current = playingRecord(state.repository);
      const actionLedger = Array.from({ length: MAX_ACTION_LEDGER_ENTRIES }, (_, index) => ({
        status: 'retryable' as const,
        seatIndex: index < MAX_ACTION_LEDGER_ENTRIES / 2 ? CREATOR_SEAT_INDEX : JOINER_SEAT_INDEX,
        actionId: retryable && index === 0 ? ACTION_ID : `retained-${index}`,
        fingerprint: retryable && index === 0 ? fingerprintGameCommand(command) : 'retained',
      }));
      state.repository.replace(roomId(ROOM_ID), { ...current, actionLedger });
      const before = state.repository.getById(roomId(ROOM_ID));
      const artifact = resolvedRollArtifact();
      let calls = 0;
      const result = await executeGameCommand(
        { roomId: roomId(ROOM_ID), seatIndex: CREATOR_SEAT_INDEX, command, receivedAt: 3_000 },
        {
          ...state.dependencies,
          rolls: {
            execute: async () => {
              calls += 1;
              return {
                ok: true,
                artifact,
              };
            },
          },
        },
      );
      expect(calls).toBe(retryable ? 1 : 0);
      if (retryable) {
        expect(result.result).toMatchObject({
          ok: true,
          data: { receipt: { stateVersion: 2, roll: artifact } },
        });
        expect(state.repository.getById(roomId(ROOM_ID))?.actionLedger).toHaveLength(
          MAX_ACTION_LEDGER_ENTRIES,
        );
        expect(state.repository.getById(roomId(ROOM_ID))?.actionLedger[0]?.status).toBe(
          'completed',
        );
      } else {
        expect(result.result).toMatchObject({
          ok: false,
          error: { code: PUBLIC_ERROR_CODE.RATE_LIMITED },
        });
        expect(result.committedStateVersion).toBeNull();
        expect(state.repository.getById(roomId(ROOM_ID))).toBe(before);
      }
    },
  );

  test.each([
    [GAME_COMMAND_TYPE.SET_DIE_HELD, 3_000],
    [GAME_COMMAND_TYPE.FORFEIT_MATCH, 3_000],
    [GAME_COMMAND_TYPE.ROLL_DICE, 3_000],
    [GAME_COMMAND_TYPE.SET_DIE_HELD, 92_000],
    [GAME_COMMAND_TYPE.FORFEIT_MATCH, 92_000],
    [GAME_COMMAND_TYPE.ROLL_DICE, 92_000],
  ] as const)(
    'commits only due deadlines when a full ledger refuses %s received at %d',
    async (type, receivedAt) => {
      const state = await capturedFixture();
      installFullActionLedger(state.repository);
      const before = playingRecord(state.repository);
      await state.advance(receivedAt + 1);
      const overdue = receivedAt === 92_000;
      const command = parseGameCommand({
        type,
        actionId: ACTION_ID,
        ...(type === GAME_COMMAND_TYPE.FORFEIT_MATCH
          ? {}
          : { turnId: type === GAME_COMMAND_TYPE.ROLL_DICE && overdue ? NEXT_TURN_ID : TURN_ID }),
        ...(type === GAME_COMMAND_TYPE.SET_DIE_HELD ? { slot: 0, isHeld: true } : {}),
      });
      const input = {
        roomId: roomId(ROOM_ID),
        seatIndex:
          type === GAME_COMMAND_TYPE.ROLL_DICE && overdue ? JOINER_SEAT_INDEX : CREATOR_SEAT_INDEX,
        command,
        receivedAt,
      };
      let rollCalls = 0;
      const dependencies: ExecuteGameCommandDependencies = {
        ...state.dependencies,
        rolls: {
          execute: async () => {
            rollCalls += 1;
            return { ok: false, reason: 'unavailable' };
          },
        },
      };
      const first = await executeGameCommand(input, dependencies);

      expect(first).toEqual({
        result: {
          ok: false,
          error: { code: PUBLIC_ERROR_CODE.RATE_LIMITED, params: { retryAfterMs: 1_000 } },
        },
        committedStateVersion: overdue ? 2 : null,
      });
      const after = playingRecord(state.repository);
      expect(after.actionLedger).toEqual(before.actionLedger);
      expect(after.match.players[0].timeoutCount).toBe(overdue ? 1 : 0);
      expect(String(after.match.currentTurn.id)).toBe(overdue ? NEXT_TURN_ID : TURN_ID);
      expect(after.match.currentTurn.seatIndex).toBe(
        overdue ? JOINER_SEAT_INDEX : CREATOR_SEAT_INDEX,
      );
      expect(after.match.currentTurn.heldSlots).toEqual([]);
      expect(after.stateVersion).toBe(overdue ? 2 : 1);
      expect(state.published).toHaveLength(overdue ? 1 : 0);
      if (overdue) {
        expect(state.published[0]).toMatchObject({
          update: { view: { game: { stateVersion: 2, match: { status: 'playing' } } } },
        });
      } else {
        expect(after).toBe(before);
      }
      const duplicate = await executeGameCommand(input, dependencies);
      expect(duplicate).toEqual({ ...first, committedStateVersion: null });
      expect(state.repository.getById(input.roomId)).toBe(after);
      expect(state.published).toHaveLength(overdue ? 1 : 0);
      expect(rollCalls).toBe(0);
      expect(state.dependencies.pending.count(ROOM_ID)).toBe(0);
    },
  );

  test.each([GAME_COMMAND_TYPE.SET_DIE_HELD, GAME_COMMAND_TYPE.ROLL_DICE] as const)(
    'returns INTERNAL_ERROR without publication when %s capacity refusal cannot store its deadline',
    async (type) => {
      const state = await capturedFixture();
      installFullActionLedger(state.repository);
      await state.advance(62_001);
      const before = playingRecord(state.repository);
      const beforeValue = structuredClone(before);
      const replace = spyOn(state.repository, 'replace').mockReturnValue(false);
      const result = await executeGameCommand(
        {
          roomId: roomId(ROOM_ID),
          seatIndex: type === GAME_COMMAND_TYPE.ROLL_DICE ? JOINER_SEAT_INDEX : CREATOR_SEAT_INDEX,
          receivedAt: 92_000,
          command: parseGameCommand({
            type,
            actionId: ACTION_ID,
            turnId: type === GAME_COMMAND_TYPE.ROLL_DICE ? NEXT_TURN_ID : TURN_ID,
            ...(type === GAME_COMMAND_TYPE.SET_DIE_HELD ? { slot: 0, isHeld: true } : {}),
          }),
        },
        state.dependencies,
      );

      expect(result).toEqual({
        result: { ok: false, error: { code: PUBLIC_ERROR_CODE.INTERNAL_ERROR, params: {} } },
        committedStateVersion: null,
      });
      expect(replace).toHaveBeenCalledTimes(1);
      expect(state.repository.getById(roomId(ROOM_ID))).toBe(before);
      expect(state.repository.getById(roomId(ROOM_ID))).toEqual(beforeValue);
      expect(state.published).toHaveLength(0);
      expect(state.dependencies.pending.count(ROOM_ID)).toBe(0);
    },
  );

  test('does not retry a failed storage commit for a reserved roll at full capacity', async () => {
    const state = await capturedFixture();
    installFullActionLedger(state.repository);
    const command = parseGameCommand({
      type: GAME_COMMAND_TYPE.ROLL_DICE,
      actionId: ACTION_ID,
      turnId: NEXT_TURN_ID,
    });
    const current = playingRecord(state.repository);
    state.repository.replace(roomId(ROOM_ID), {
      ...current,
      actionLedger: current.actionLedger.map((entry, index) =>
        index === MAX_ACTION_LEDGER_ENTRIES / 2
          ? {
              status: 'retryable',
              seatIndex: JOINER_SEAT_INDEX,
              actionId: ACTION_ID,
              fingerprint: fingerprintGameCommand(command),
            }
          : entry,
      ),
    });
    await state.advance(62_001);
    const before = playingRecord(state.repository);
    const beforeValue = structuredClone(before);
    const replace = spyOn(state.repository, 'replace').mockReturnValue(false);
    let rollCalls = 0;
    const result = await executeGameCommand(
      { roomId: roomId(ROOM_ID), seatIndex: JOINER_SEAT_INDEX, receivedAt: 92_000, command },
      {
        ...state.dependencies,
        rolls: {
          execute: async () => {
            rollCalls += 1;
            return { ok: true, artifact: resolvedRollArtifact() };
          },
        },
      },
    );

    expect(result).toEqual({
      result: { ok: false, error: { code: PUBLIC_ERROR_CODE.INTERNAL_ERROR, params: {} } },
      committedStateVersion: null,
    });
    expect(rollCalls).toBe(1);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(state.repository.getById(roomId(ROOM_ID))).toBe(before);
    expect(state.repository.getById(roomId(ROOM_ID))).toEqual(beforeValue);
    expect(state.published).toHaveLength(0);
    expect(state.dependencies.pending.count(ROOM_ID)).toBe(0);
  });

  test('does not recommit a capacity deadline when its publisher throws', async () => {
    const state = await capturedFixture();
    installFullActionLedger(state.repository);
    await state.advance(62_001);
    const before = playingRecord(state.repository);
    const replace = spyOn(state.repository, 'replace');
    const publisherError = new Error('publisher failed');
    let publications = 0;
    await expect(
      executeGameCommand(
        {
          roomId: roomId(ROOM_ID),
          seatIndex: CREATOR_SEAT_INDEX,
          receivedAt: 92_000,
          command: parseGameCommand({
            type: GAME_COMMAND_TYPE.SET_DIE_HELD,
            actionId: ACTION_ID,
            turnId: TURN_ID,
            slot: 0,
            isHeld: true,
          }),
        },
        {
          ...state.dependencies,
          commits: new RoomStateCommitter({
            repository: state.repository,
            clock: state.dependencies.clock,
            publishRoomState: () => {
              publications += 1;
              throw publisherError;
            },
          }),
        },
      ),
    ).rejects.toBe(publisherError);

    const after = playingRecord(state.repository);
    expect(after.stateVersion).toBe(2);
    expect(after.match.players[0].timeoutCount).toBe(1);
    expect(after.actionLedger).toEqual(before.actionLedger);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(publications).toBe(1);
    expect(state.dependencies.pending.count(ROOM_ID)).toBe(0);
  });

  test.each([0, 8_000])(
    'retains an authoritative roll for five minutes after completing %d ms of physics work',
    async (duration) => {
      const state = await fixture();
      const artifact = resolvedRollArtifact();
      let executorCalls = 0;
      const dependencies: ExecuteGameCommandDependencies = {
        ...state.dependencies,
        rolls: {
          execute: () => {
            executorCalls += 1;
            state.setNow(3_000 + duration);
            return Promise.resolve({
              ok: true,
              artifact,
            });
          },
        },
      };
      const input = {
        roomId: roomId(ROOM_ID),
        seatIndex: CREATOR_SEAT_INDEX,
        command: parseGameCommand({
          type: GAME_COMMAND_TYPE.ROLL_DICE,
          actionId: ACTION_ID,
          turnId: TURN_ID,
        }),
        receivedAt: 3_000,
      };

      const first = await executeGameCommand(input, dependencies);
      const duplicate = await executeGameCommand(input, dependencies);

      expect(first.result).toMatchObject({
        ok: true,
        data: { receipt: { stateVersion: 2, roll: artifact } },
      });
      expect(first.committedStateVersion).toBe(2);
      expect(state.published[0]).toMatchObject({
        kind: 'game',
        update: { view: { game: { stateVersion: 2 } }, roll: artifact },
      });
      expect(duplicate).toEqual({ result: first.result, committedStateVersion: null });
      expect(executorCalls).toBe(1);
      expect(state.repository.getById(roomId(ROOM_ID))).toMatchObject({
        stateVersion: 2,
        match: {
          currentTurn: {
            diceState: {
              rollCount: 1,
              dice: [{ value: 1 }, { value: 2 }, { value: 3 }, { value: 4 }, { value: 5 }],
            },
          },
        },
      });

      state.setNow(3_000 + duration + 299_999);
      expect(await executeGameCommand(input, dependencies)).toEqual({
        result: first.result,
        committedStateVersion: null,
      });

      state.setNow(3_000 + duration + 300_000);
      const expired = await executeGameCommand(input, dependencies);
      expect(expired.result).toMatchObject({
        ok: false,
        error: { code: PUBLIC_ERROR_CODE.ACTION_RESULT_EXPIRED },
      });
      expect(state.repository.getById(roomId(ROOM_ID))?.actionLedger).toMatchObject([
        { status: 'tombstone', actionId: ACTION_ID },
      ]);
      expect(executorCalls).toBe(1);
      expect(state.published).toHaveLength(1);
    },
  );

  test('coalesces an in-flight duplicate onto one physics execution', async () => {
    const state = await fixture();
    const artifact = resolvedRollArtifact();
    const barrier = Promise.withResolvers<void>();
    let executorCalls = 0;
    const dependencies: ExecuteGameCommandDependencies = {
      ...state.dependencies,
      rolls: {
        execute: async () => {
          executorCalls += 1;
          await barrier.promise;
          return {
            ok: true,
            artifact,
          };
        },
      },
    };
    const input = {
      roomId: roomId(ROOM_ID),
      seatIndex: CREATOR_SEAT_INDEX,
      command: parseGameCommand({
        type: GAME_COMMAND_TYPE.ROLL_DICE,
        actionId: ACTION_ID,
        turnId: TURN_ID,
      }),
      receivedAt: 3_000,
    };

    const first = executeGameCommand(input, dependencies);
    const duplicate = executeGameCommand(input, dependencies);
    await Bun.sleep(0);
    expect(executorCalls).toBe(1);
    barrier.resolve();

    const [ownerResult, duplicateResult] = await Promise.all([first, duplicate]);
    expect(duplicateResult).toEqual({ result: ownerResult.result, committedStateVersion: null });
    expect(ownerResult.committedStateVersion).toBe(2);
    expect(executorCalls).toBe(1);
    expect(state.published).toHaveLength(1);
    expect(state.published[0]).toMatchObject({
      kind: 'game',
      update: { view: { game: { stateVersion: 2 } }, roll: artifact },
    });
  });

  test('releases pending duplicates and later room work after a retryable roll failure', async () => {
    const state = await fixture();
    const before = playingRecord(state.repository);
    const entered = Promise.withResolvers<void>();
    const barrier = Promise.withResolvers<void>();
    let executorCalls = 0;
    const dependencies: ExecuteGameCommandDependencies = {
      ...state.dependencies,
      rolls: {
        execute: async () => {
          executorCalls += 1;
          entered.resolve();
          await barrier.promise;
          return { ok: false, reason: 'unavailable' };
        },
      },
    };
    const input = {
      roomId: roomId(ROOM_ID),
      seatIndex: CREATOR_SEAT_INDEX,
      command: parseGameCommand({
        type: GAME_COMMAND_TYPE.ROLL_DICE,
        actionId: ACTION_ID,
        turnId: TURN_ID,
      }),
      receivedAt: 3_000,
    };

    const first = executeGameCommand(input, dependencies);
    const duplicate = executeGameCommand(input, dependencies);
    await entered.promise;
    let laterWorkRan = false;
    const laterWork = dependencies.queue.run(input.roomId, () => {
      laterWorkRan = true;
      return playingRecord(state.repository);
    });
    expect(executorCalls).toBe(1);
    expect(dependencies.pending.count(ROOM_ID)).toBe(1);
    expect(laterWorkRan).toBe(false);

    barrier.resolve();
    const [ownerResult, duplicateResult, after] = await Promise.all([first, duplicate, laterWork]);
    expect(ownerResult).toEqual({
      result: { ok: false, error: { code: PUBLIC_ERROR_CODE.ROLL_UNAVAILABLE, params: {} } },
      committedStateVersion: null,
    });
    expect(duplicateResult).toEqual(ownerResult);
    expect(executorCalls).toBe(1);
    expect(laterWorkRan).toBe(true);
    expect(after.match).toEqual(before.match);
    expect(after.stateVersion).toBe(before.stateVersion);
    expect(after.actionLedger).toEqual([
      expect.objectContaining({ status: 'retryable', actionId: ACTION_ID }),
    ]);
    expect(dependencies.pending.count(ROOM_ID)).toBe(0);

    expect(await executeGameCommand(input, dependencies)).toEqual(ownerResult);
    expect(executorCalls).toBe(2);
    expect(dependencies.pending.count(ROOM_ID)).toBe(0);
  });

  test('adjudicates a slow physics job by command receivedAt instead of completion time', async () => {
    const state = await fixture();
    const artifact = resolvedRollArtifact();
    const deadline = Number(playingRecord(state.repository).match.currentTurn.deadlineAt);
    const barrier = Promise.withResolvers<void>();
    let executorCalls = 0;
    const dependencies: ExecuteGameCommandDependencies = {
      ...state.dependencies,
      rolls: {
        execute: async () => {
          executorCalls += 1;
          await barrier.promise;
          return {
            ok: true,
            artifact,
          };
        },
      },
    };
    const command = parseGameCommand({
      type: GAME_COMMAND_TYPE.ROLL_DICE,
      actionId: ACTION_ID,
      turnId: TURN_ID,
    });

    const execution = executeGameCommand(
      {
        roomId: roomId(ROOM_ID),
        seatIndex: CREATOR_SEAT_INDEX,
        command,
        receivedAt: deadline - 1,
      },
      dependencies,
    );
    await Bun.sleep(0);
    state.setNow(deadline + 5_000);
    barrier.resolve();

    expect((await execution).result).toMatchObject({
      ok: true,
      data: { receipt: { stateVersion: 2 } },
    });
    expect(executorCalls).toBe(1);
  });

  test('does not allocate physics for a command received at the exact deadline', async () => {
    const state = await fixture();
    const deadline = Number(playingRecord(state.repository).match.currentTurn.deadlineAt);
    let executorCalls = 0;
    const result = await executeGameCommand(
      {
        roomId: roomId(ROOM_ID),
        seatIndex: CREATOR_SEAT_INDEX,
        command: parseGameCommand({
          type: GAME_COMMAND_TYPE.ROLL_DICE,
          actionId: ACTION_ID,
          turnId: TURN_ID,
        }),
        receivedAt: deadline,
      },
      {
        ...state.dependencies,
        rolls: {
          execute: () => {
            executorCalls += 1;
            return Promise.resolve({ ok: false, reason: 'unavailable' });
          },
        },
      },
    );

    expect(result.result).toMatchObject({
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.NOT_YOUR_TURN },
    });
    expect(executorCalls).toBe(0);
  });

  test('commits authoritative hold and score transitions against rolled dice', async () => {
    const state = await fixture();
    installRolledRecord(state.repository);

    const hold = await executeGameCommand(
      {
        roomId: roomId(ROOM_ID),
        seatIndex: CREATOR_SEAT_INDEX,
        command: parseGameCommand({
          type: GAME_COMMAND_TYPE.SET_DIE_HELD,
          actionId: ACTION_ID,
          turnId: TURN_ID,
          slot: 0,
          isHeld: true,
        }),
        receivedAt: 3_000,
      },
      state.dependencies,
    );
    expect(hold.result).toMatchObject({ ok: true, data: { receipt: { stateVersion: 2 } } });
    expect(hold.committedStateVersion).toBe(2);

    const noOpHold = await executeGameCommand(
      {
        roomId: roomId(ROOM_ID),
        seatIndex: CREATOR_SEAT_INDEX,
        command: parseGameCommand({
          type: GAME_COMMAND_TYPE.SET_DIE_HELD,
          actionId: 'c635fe2c-c4c8-4382-80d7-c35c5d5d455d',
          turnId: TURN_ID,
          slot: 0,
          isHeld: true,
        }),
        receivedAt: 3_001,
      },
      state.dependencies,
    );
    expect(noOpHold).toMatchObject({
      result: { ok: true, data: { receipt: { stateVersion: 2 } } },
      committedStateVersion: null,
    });
    expect(state.published).toHaveLength(1);
    expect(state.published[0]).toMatchObject({
      kind: 'game',
      update: {
        view: {
          game: {
            stateVersion: 2,
            match: { currentTurn: { heldSlots: [0] } },
          },
        },
      },
    });

    expect(state.repository.getById(roomId(ROOM_ID))?.actionLedger).toMatchObject([
      { status: 'completed', actionId: ACTION_ID },
      { status: 'completed', actionId: 'c635fe2c-c4c8-4382-80d7-c35c5d5d455d' },
    ]);

    const score = await executeGameCommand(
      {
        roomId: roomId(ROOM_ID),
        seatIndex: CREATOR_SEAT_INDEX,
        command: parseGameCommand({
          type: GAME_COMMAND_TYPE.SELECT_SCORE_CATEGORY,
          actionId: 'b635fe2c-c4c8-4382-80d7-c35c5d5d455d',
          turnId: TURN_ID,
          categoryId: 'ones',
        }),
        receivedAt: 3_002,
      },
      state.dependencies,
    );
    expect(score.result).toMatchObject({ ok: true, data: { receipt: { stateVersion: 3 } } });
    expect(score.committedStateVersion).toBe(3);
    expect(state.published.map((update) => Number(update.update.view.game!.stateVersion))).toEqual([
      2, 3,
    ]);
    expect(state.repository.getById(roomId(ROOM_ID))?.match).toMatchObject({
      status: 'playing',
      players: [{ scorecard: { ones: 1 } }, { scorecard: {} }],
      currentTurn: { seatIndex: JOINER_SEAT_INDEX, id: NEXT_TURN_ID },
    });
  });

  test('lets a second timeout win against an explicit forfeit at the exact deadline', async () => {
    const state = await fixture();
    const current = playingRecord(state.repository);
    const players: PlayingMatch['players'] = [
      { ...current.match.players[0], timeoutCount: 1 },
      current.match.players[1],
    ];
    state.repository.replace(roomId(ROOM_ID), {
      ...current,
      match: {
        ...current.match,
        players,
        currentTurn: { ...current.match.currentTurn, deadlineAt: epochMilliseconds(3_000) },
      },
    });

    const result = await executeGameCommand(
      {
        roomId: roomId(ROOM_ID),
        seatIndex: CREATOR_SEAT_INDEX,
        command: parseGameCommand({ type: GAME_COMMAND_TYPE.FORFEIT_MATCH, actionId: ACTION_ID }),
        receivedAt: 3_000,
      },
      state.dependencies,
    );

    expect(result.result).toEqual({
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.MATCH_FINISHED, params: {} },
    });
    expect(state.repository.getById(roomId(ROOM_ID))?.match).toMatchObject({
      status: 'finished',
      result: { reason: 'timeoutLimit', winnerSeatIndex: JOINER_SEAT_INDEX },
    });
  });

  test('times out a score captured at the exact turn deadline before validating it', async () => {
    const state = await fixture();
    installRolledRecord(state.repository);
    const current = playingRecord(state.repository);
    state.repository.replace(roomId(ROOM_ID), {
      ...current,
      match: {
        ...current.match,
        currentTurn: { ...current.match.currentTurn, deadlineAt: epochMilliseconds(3_000) },
      },
    });

    const result = await executeGameCommand(
      {
        roomId: roomId(ROOM_ID),
        seatIndex: CREATOR_SEAT_INDEX,
        command: parseGameCommand({
          type: GAME_COMMAND_TYPE.SELECT_SCORE_CATEGORY,
          actionId: ACTION_ID,
          turnId: TURN_ID,
          categoryId: 'ones',
        }),
        receivedAt: 3_000,
      },
      state.dependencies,
    );

    expect(result.result.ok).toBeFalse();
    expect(result.committedStateVersion).toBe(2);
    expect(state.published).toHaveLength(1);
    expect(state.published[0]).toMatchObject({ update: { view: { game: { stateVersion: 2 } } } });
    expect(state.repository.getById(roomId(ROOM_ID))?.match).toMatchObject({
      status: 'playing',
      players: [
        { timeoutCount: 1, scorecard: {} },
        { timeoutCount: 0, scorecard: {} },
      ],
      currentTurn: { seatIndex: JOINER_SEAT_INDEX, id: NEXT_TURN_ID },
    });
  });

  test('lets explicit forfeit win an exact tie with reconnect expiry', async () => {
    const state = await fixture();
    installDisconnectedRecord(state.repository, JOINER_SEAT_INDEX, 3_000);
    state.setNow(93_000);

    const result = await executeGameCommand(
      {
        roomId: roomId(ROOM_ID),
        seatIndex: JOINER_SEAT_INDEX,
        command: parseGameCommand({ type: GAME_COMMAND_TYPE.FORFEIT_MATCH, actionId: ACTION_ID }),
        receivedAt: 93_000,
      },
      state.dependencies,
    );

    expect(result.result).toMatchObject({ ok: true, data: { receipt: { stateVersion: 2 } } });
    expect(result.committedStateVersion).toBe(2);
    expect(state.published).toHaveLength(1);
    expect(state.published[0]).toMatchObject({ update: { view: { game: { stateVersion: 2 } } } });
    expect(state.repository.getById(roomId(ROOM_ID))?.match).toMatchObject({
      status: 'finished',
      result: { reason: 'explicitForfeit', winnerSeatIndex: CREATOR_SEAT_INDEX },
    });
  });

  test('lets a final score captured before turn expiry win an exact reconnect tie', async () => {
    const state = await fixture();
    installDisconnectedRecord(state.repository, CREATOR_SEAT_INDEX, 3_000);
    installFinalScoreRecord(state.repository);
    state.setNow(200_000);

    const result = await executeGameCommand(
      {
        roomId: roomId(ROOM_ID),
        seatIndex: CREATOR_SEAT_INDEX,
        command: parseGameCommand({
          type: GAME_COMMAND_TYPE.SELECT_SCORE_CATEGORY,
          actionId: ACTION_ID,
          turnId: TURN_ID,
          categoryId: 'ones',
        }),
        receivedAt: 93_000,
      },
      state.dependencies,
    );

    expect(result.result).toMatchObject({ ok: true, data: { receipt: { stateVersion: 2 } } });
    expect(state.repository.getById(roomId(ROOM_ID))?.room).toMatchObject({
      status: 'finished',
      finishedAt: 200_000,
    });
    expect(state.repository.getById(roomId(ROOM_ID))?.match).toMatchObject({
      status: 'finished',
      result: { reason: 'scoresCompleted' },
    });
  });

  test('applies connection end after the rejected command receipt millisecond closes', async () => {
    const state = await fixture();
    installDisconnectedRecord(state.repository, JOINER_SEAT_INDEX, 3_000);
    state.setNow(93_000);

    const result = await executeGameCommand(
      {
        roomId: roomId(ROOM_ID),
        seatIndex: JOINER_SEAT_INDEX,
        command: parseGameCommand({
          type: GAME_COMMAND_TYPE.SET_DIE_HELD,
          actionId: ACTION_ID,
          turnId: TURN_ID,
          slot: 0,
          isHeld: true,
        }),
        receivedAt: 93_000,
      },
      state.dependencies,
    );

    expect(result.result.ok).toBeFalse();
    expect(result.committedStateVersion).toBe(2);
    expect(state.published).toHaveLength(1);
    expect(state.published[0]).toMatchObject({
      update: { view: { game: { stateVersion: 2, match: { status: 'playing' } } } },
    });
    let scheduled: (() => void | Promise<void>) | undefined;
    const updates: unknown[] = [];
    const scheduler = new RoomDeadlineScheduler({
      clock: state.dependencies.clock,
      identity: state.dependencies.identity,
      queue: state.dependencies.queue,
      repository: state.repository,
      tasks: {
        schedule: (_key, _at, task) => {
          scheduled = task;
        },
        cancel: () => {
          scheduled = undefined;
        },
      },
      commits: new RoomStateCommitter({
        repository: state.repository,
        clock: state.dependencies.clock,
        publishRoomState: (publication) => {
          if (publication.kind === 'game') updates.push(publication);
        },
      }),
    });
    scheduler.reconcile(roomId(ROOM_ID));
    state.setNow(93_001);
    await scheduled?.();
    expect(updates).toEqual([
      expect.objectContaining({
        update: expect.objectContaining({
          view: expect.objectContaining({ game: expect.objectContaining({ stateVersion: 3 }) }),
        }),
      }),
    ]);
    expect(state.repository.getById(roomId(ROOM_ID))?.match).toMatchObject({
      status: 'finished',
      result: { reason: 'connectionEnded', winnerSeatIndex: CREATOR_SEAT_INDEX },
    });
  });
});

function installFullActionLedger(repository: InMemoryRoomRepository): void {
  const current = playingRecord(repository);
  repository.replace(roomId(ROOM_ID), {
    ...current,
    actionLedger: Array.from({ length: MAX_ACTION_LEDGER_ENTRIES }, (_, index) => ({
      status: 'tombstone' as const,
      seatIndex: index < MAX_ACTION_LEDGER_ENTRIES / 2 ? CREATOR_SEAT_INDEX : JOINER_SEAT_INDEX,
      actionId: `retained-${index}`,
      fingerprint: 'retained',
    })),
  });
}

function installDisconnectedRecord(
  repository: InMemoryRoomRepository,
  targetSeatIndex: SeatIndex,
  detectedAt: number,
): void {
  const current = playingRecord(repository);
  const creatorConnected = resumeSeat(current.room, {
    seatIndex: CREATOR_SEAT_INDEX,
    resumedAt: 2_100,
  });
  if (!creatorConnected.ok) throw new Error('creator connect failed');
  const joinerConnected = resumeSeat(creatorConnected.room, {
    seatIndex: JOINER_SEAT_INDEX,
    resumedAt: 2_200,
  });
  if (!joinerConnected.ok) throw new Error('joiner connect failed');
  const disconnected = disconnectSeat(joinerConnected.room, {
    seatIndex: targetSeatIndex,
    detectedAt,
  });
  if (!disconnected.ok || !disconnected.changed || disconnected.room.status !== 'playing') {
    throw new Error('disconnect failed');
  }
  repository.replace(roomId(ROOM_ID), { ...current, room: disconnected.room });
}

function installFinalScoreRecord(repository: InMemoryRoomRepository): void {
  installRolledRecord(repository);
  const current = playingRecord(repository);
  const shared = {
    twos: 0,
    threes: 0,
    fours: 0,
    fives: 0,
    sixes: 0,
    choice: 0,
    'four-of-a-kind': 0,
    'full-house': 0,
    'small-straight': 0,
    'large-straight': 0,
    yacht: 0,
  } as const;
  repository.replace(roomId(ROOM_ID), {
    ...current,
    match: {
      ...current.match,
      players: [
        { ...current.match.players[0], scorecard: shared },
        { ...current.match.players[1], scorecard: { ...shared, ones: 0 } },
      ],
      currentTurn: {
        ...current.match.currentTurn,
        deadlineAt: epochMilliseconds(200_000),
      },
    },
  });
}
