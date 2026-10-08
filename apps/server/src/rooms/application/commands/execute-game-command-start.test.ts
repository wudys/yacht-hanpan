import { randomUUID } from 'node:crypto';

import { GAME_COMMAND_TYPE, parseGameCommand } from '@repo/game-protocol/socket';
import { describe, expect, test } from 'bun:test';

import { executeGameCommand } from '@/rooms/application/commands/execute-game-command';
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
} from '@/rooms/application/commands/execute-game-command.test-fixture';
import { roomId } from '@/rooms/domain/room-model';

describe('score handoff command boundaries', () => {
  test.each([10_999, 11_000, 100_999, 101_000])(
    'opens the score-created next turn for a roll received at %d',
    async (receivedAt) => {
      const state = await fixture();
      installRolledRecord(state.repository);
      state.setNow(10_000);
      const score = await executeGameCommand(
        {
          roomId: roomId(ROOM_ID),
          seatIndex: CREATOR_SEAT_INDEX,
          receivedAt: 3_000,
          command: parseGameCommand({
            type: GAME_COMMAND_TYPE.SELECT_SCORE_CATEGORY,
            actionId: ACTION_ID,
            turnId: TURN_ID,
            categoryId: 'ones',
          }),
        },
        state.dependencies,
      );
      expect(score.result).toMatchObject({
        ok: true,
        data: {
          view: {
            game: {
              match: {
                currentTurn: {
                  startedAt: 11_000,
                  deadlineAt: 101_000,
                  seatIndex: JOINER_SEAT_INDEX,
                },
              },
            },
          },
        },
      });
      expect(state.published).toHaveLength(1);
      let executorCalls = 0;
      state.setNow(receivedAt);
      const result = await executeGameCommand(
        {
          roomId: roomId(ROOM_ID),
          seatIndex: JOINER_SEAT_INDEX,
          receivedAt,
          command: parseGameCommand({
            type: GAME_COMMAND_TYPE.ROLL_DICE,
            actionId: randomUUID(),
            turnId: NEXT_TURN_ID,
          }),
        },
        {
          ...state.dependencies,
          rolls: {
            execute: async () => {
              executorCalls += 1;
              return { ok: true, artifact: resolvedRollArtifact() };
            },
          },
        },
      );
      if (receivedAt === 10_999) {
        expect(result.result).toMatchObject({
          ok: false,
          error: { code: 'TURN_NOT_STARTED', params: {} },
        });
        expect(result.committedStateVersion).toBeNull();
        expect(state.published).toHaveLength(1);
        expect(executorCalls).toBe(0);
        expect(playingRecord(state.repository).stateVersion).toBe(2);
      } else if (receivedAt === 101_000) {
        expect(result.result.ok).toBeFalse();
        expect(executorCalls).toBe(0);
        expect(playingRecord(state.repository).match.players[JOINER_SEAT_INDEX].timeoutCount).toBe(
          1,
        );
        expect(Number(playingRecord(state.repository).match.currentTurn.startedAt)).toBe(101_000);
      } else {
        expect(result.result.ok).toBeTrue();
        expect(executorCalls).toBe(1);
        expect(state.published).toHaveLength(2);
      }
    },
  );

  test('keeps early receipt rejection through queue delay and duplicates while score duplicates succeed', async () => {
    const state = await fixture();
    installRolledRecord(state.repository);
    const scoreInput = {
      roomId: roomId(ROOM_ID),
      seatIndex: CREATOR_SEAT_INDEX,
      receivedAt: 3_000,
      command: parseGameCommand({
        type: GAME_COMMAND_TYPE.SELECT_SCORE_CATEGORY,
        actionId: ACTION_ID,
        turnId: TURN_ID,
        categoryId: 'ones',
      }),
    };
    const score = await executeGameCommand(scoreInput, state.dependencies);
    expect(score.result.ok).toBeTrue();
    const replay = await executeGameCommand(scoreInput, state.dependencies);
    expect(replay.result).toEqual(score.result);
    expect(replay.committedStateVersion).toBeNull();
    const gate = Promise.withResolvers<void>();
    const blocker = state.dependencies.queue.runInternal(roomId(ROOM_ID), () => gate.promise);
    await Promise.resolve();
    const input = {
      roomId: roomId(ROOM_ID),
      seatIndex: JOINER_SEAT_INDEX,
      receivedAt: 3_999,
      command: parseGameCommand({
        type: GAME_COMMAND_TYPE.ROLL_DICE,
        actionId: randomUUID(),
        turnId: NEXT_TURN_ID,
      }),
    };
    let executorCalls = 0;
    const dependencies = {
      ...state.dependencies,
      rolls: {
        execute: async () => {
          executorCalls += 1;
          return { ok: true as const, artifact: resolvedRollArtifact() };
        },
      },
    };
    const waiting = executeGameCommand(input, dependencies);
    state.setNow(5_000);
    gate.resolve();
    await blocker;
    const result = await waiting;
    expect(result.result).toMatchObject({
      ok: false,
      error: { code: 'TURN_NOT_STARTED', params: {} },
    });
    const duplicate = await executeGameCommand({ ...input, receivedAt: 5_000 }, dependencies);
    expect(duplicate.result).toEqual(result.result);
    expect(executorCalls).toBe(0);
    expect(state.published).toHaveLength(1);
    const fresh = await executeGameCommand(
      {
        ...input,
        receivedAt: 5_000,
        command: parseGameCommand({ ...input.command, actionId: randomUUID() }),
      },
      dependencies,
    );
    expect(fresh.result.ok).toBeTrue();
    expect(executorCalls).toBe(1);
  });

  test.each([CREATOR_SEAT_INDEX, JOINER_SEAT_INDEX])(
    'accepts seat %d forfeit during score handoff without waiting for turn start',
    async (seatIndex) => {
      const state = await fixture();
      installRolledRecord(state.repository);
      await executeGameCommand(
        {
          roomId: roomId(ROOM_ID),
          seatIndex: CREATOR_SEAT_INDEX,
          receivedAt: 3_000,
          command: parseGameCommand({
            type: GAME_COMMAND_TYPE.SELECT_SCORE_CATEGORY,
            actionId: ACTION_ID,
            turnId: TURN_ID,
            categoryId: 'ones',
          }),
        },
        state.dependencies,
      );
      const result = await executeGameCommand(
        {
          roomId: roomId(ROOM_ID),
          seatIndex,
          receivedAt: 3_001,
          command: parseGameCommand({
            type: GAME_COMMAND_TYPE.FORFEIT_MATCH,
            actionId: randomUUID(),
          }),
        },
        state.dependencies,
      );
      expect(result.result.ok).toBeTrue();
      expect(state.repository.getById(roomId(ROOM_ID))?.match).toMatchObject({
        status: 'finished',
        result: { reason: 'explicitForfeit' },
      });
    },
  );
});
