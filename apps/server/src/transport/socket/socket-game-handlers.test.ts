import { createPublicError, PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import { type CommandAck, GAME_COMMAND_TYPE, type SyncAck } from '@repo/game-protocol/socket';
import { expect, test } from 'bun:test';

import { roomId } from '@/rooms/domain/room-model';
import type { RoomApplication } from '@/rooms/room-application';
import type { ErrorReporter } from '@/runtime/error-reporter';
import type { Logger } from '@/runtime/logger';
import { handleCommand, handleSync } from '@/transport/socket/socket-game-handlers';

const socket = {
  data: { roomId: roomId('018f47f2-c2d8-7f4a-8bf4-3f559c39843d'), seatIndex: 0 as const },
};
const command = {
  type: GAME_COMMAND_TYPE.FORFEIT_MATCH,
  actionId: 'a635fe2c-c4c8-4382-80d7-c35c5d5d455d',
};
const refusal = {
  ok: false,
  error: createPublicError(PUBLIC_ERROR_CODE.MATCH_FINISHED, {}),
} as const;

test('finishes a refused command and logs completion with the injected logger receiver', async () => {
  class CommandLogger implements Logger {
    public readonly events: string[] = [];
    public warn(event: string): void {
      this.events.push(event);
    }
    public debug(): void {}
    public info(): void {}
    public error(): void {}
  }
  const { dependencies, reports } = fixture('none', new Error('unused'));
  const logger = new CommandLogger();
  const acknowledgements: CommandAck[] = [];
  await expect(
    handleCommand(
      socket,
      command,
      (ack) => acknowledgements.push(ack),
      2_000,
      {
        ...dependencies,
        logger,
      },
      true,
    ),
  ).resolves.toBeUndefined();
  expect(acknowledgements).toHaveLength(1);
  expect(acknowledgements[0]).toMatchObject(refusal);
  expect(logger.events).toEqual(['socket.command.completed']);
  expect(reports).toEqual([]);
});

function fixture(fault: 'application' | 'output' | 'none', original: Error) {
  const reports: Array<Parameters<ErrorReporter>> = [];
  const dependencies = {
    clock: { now: () => 2_000 },
    identity: { createRequestId: () => '018f47f2-c2d8-7f4a-8bf4-3f559c398440' },
    isAcceptingRequests: () => true,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    reportUnexpected: (error: unknown, operation: Parameters<ErrorReporter>[1]) => {
      reports.push([error, operation]);
      throw new Error('reporter failure');
    },
    rooms: {
      syncRoom: async () => {
        if (fault === 'application') throw original;
        return (fault === 'output' ? { ok: true, data: null } : refusal) as Awaited<
          ReturnType<RoomApplication['syncRoom']>
        >;
      },
      executeGameCommand: async () => {
        if (fault === 'application') throw original;
        return {
          result: fault === 'output' ? { ok: true, data: null } : refusal,
          committedStateVersion: null,
        } as Awaited<ReturnType<RoomApplication['executeGameCommand']>>;
      },
    },
  };
  return { dependencies, reports };
}

for (const kind of ['sync', 'command'] as const) {
  test.each(['application', 'output'] as const)(
    `${kind} contains %s failure before acknowledging once`,
    async (fault) => {
      const original = new Error('private failure');
      const { dependencies, reports } = fixture(fault, original);
      const acknowledgements: Array<SyncAck | CommandAck> = [];
      const acknowledge = (response: SyncAck | CommandAck): void => {
        acknowledgements.push(response);
      };
      const work =
        kind === 'sync'
          ? handleSync(socket, acknowledge, dependencies)
          : handleCommand(socket, command, acknowledge, 2_000, dependencies, true);
      await expect(work).resolves.toBeUndefined();
      expect(acknowledgements).toHaveLength(1);
      expect(acknowledgements[0]).toMatchObject({
        ok: false,
        error: { code: PUBLIC_ERROR_CODE.INTERNAL_ERROR },
      });
      expect(reports).toHaveLength(1);
      expect(reports[0]?.[1]).toBe(`socket.${kind}`);
      expect(reports[0]?.[0]).toBeInstanceOf(Error);
      if (fault === 'application') expect(reports[0]?.[0]).toBe(original);
      expect(JSON.stringify(acknowledgements)).not.toMatch(/private|cause|stack/);
    },
  );

  test(`${kind} contains acknowledge failure without trying a second ACK`, async () => {
    const original = new Error('acknowledge failed');
    const { dependencies, reports } = fixture('none', original);
    let calls = 0;
    const acknowledge = (): void => {
      calls += 1;
      throw original;
    };
    const work =
      kind === 'sync'
        ? handleSync(socket, acknowledge, dependencies)
        : handleCommand(socket, command, acknowledge, 2_000, dependencies, true);
    await expect(work).resolves.toBeUndefined();
    expect(calls).toBe(1);
    expect(reports).toEqual([[original, `socket.${kind}`]]);
  });
}

test('malformed command acknowledge failure is contained while malformed input itself is unreported', async () => {
  const original = new Error('acknowledge failed');
  const { dependencies, reports } = fixture('none', original);
  let calls = 0;
  await expect(
    handleCommand(
      socket,
      {},
      () => {
        calls += 1;
        throw original;
      },
      2_000,
      dependencies,
      true,
    ),
  ).resolves.toBeUndefined();
  expect(calls).toBe(1);
  expect(reports).toEqual([[original, 'socket.command']]);
});

for (const kind of ['sync', 'command'] as const) {
  test(`${kind} overload refusal contains an ACK failure without application work or a domain issue`, async () => {
    const original = new Error('acknowledge failed');
    const { dependencies, reports } = fixture(
      'application',
      new Error('unexpected application call'),
    );
    const acknowledgements: Array<SyncAck | CommandAck> = [];
    const acknowledge = (response: SyncAck | CommandAck): void => {
      acknowledgements.push(response);
      throw original;
    };
    const work =
      kind === 'sync'
        ? handleSync(socket, acknowledge, dependencies, false)
        : handleCommand(socket, command, acknowledge, 2_000, dependencies, false);
    await expect(work).resolves.toBeUndefined();
    expect(acknowledgements).toHaveLength(1);
    expect(acknowledgements[0]).toMatchObject({
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.RATE_LIMITED },
    });
    expect(reports).toEqual([[original, `socket.${kind}`]]);
  });
}
