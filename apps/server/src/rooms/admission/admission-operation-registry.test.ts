import { describe, expect, test } from 'bun:test';

import {
  ADMISSION_OPERATION_FAILURE,
  ADMISSION_OPERATION_KIND,
  AdmissionOperationRegistry,
} from '@/rooms/admission/admission-operation-registry';

const OPERATION_ID = 'a6f9fc18-01e4-469c-8382-301e7d85654d';

describe('room admission operation registry', () => {
  test('shares one pending execution and replays the completed authority result', async () => {
    let executions = 0;
    let release: ((value: { token: string }) => void) | undefined;
    const registry = new AdmissionOperationRegistry({
      clock: { now: () => 1_000 },
      maxEntries: 128,
      ttlMs: 300_000,
    });
    const execute = () => {
      executions += 1;
      return new Promise<{ token: string }>((resolve) => {
        release = resolve;
      });
    };

    const first = registry.run(
      ADMISSION_OPERATION_KIND.CREATE_ROOM,
      OPERATION_ID,
      'client-1:profile-1',
      execute,
    );
    const duplicate = registry.run(
      ADMISSION_OPERATION_KIND.CREATE_ROOM,
      OPERATION_ID,
      'client-1:profile-1',
      execute,
    );
    await Promise.resolve();
    release?.({ token: 'same-secret' });

    expect(await first).toEqual({ ok: true, value: { token: 'same-secret' } });
    expect(await duplicate).toEqual({ ok: true, value: { token: 'same-secret' } });
    expect(
      await registry.run(
        ADMISSION_OPERATION_KIND.CREATE_ROOM,
        OPERATION_ID,
        'client-1:profile-1',
        execute,
      ),
    ).toEqual({ ok: true, value: { token: 'same-secret' } });
    expect(executions).toBe(1);
  });

  test('rejects reuse with another payload instead of replaying credentials', async () => {
    const registry = new AdmissionOperationRegistry({
      clock: { now: () => 1_000 },
      maxEntries: 128,
      ttlMs: 300_000,
    });

    await registry.run(
      ADMISSION_OPERATION_KIND.JOIN_ROOM,
      OPERATION_ID,
      'room-1:profile-1',
      async () => 'joined',
    );

    expect(
      await registry.run(
        ADMISSION_OPERATION_KIND.JOIN_ROOM,
        OPERATION_ID,
        'room-2:profile-1',
        async () => 'wrong',
      ),
    ).toEqual({ ok: false, reason: ADMISSION_OPERATION_FAILURE.OPERATION_ID_REUSED });
  });

  test('forgets completed secrets after the bounded replay window', async () => {
    let now = 1_000;
    let executions = 0;
    const registry = new AdmissionOperationRegistry({
      clock: { now: () => now },
      maxEntries: 128,
      ttlMs: 300_000,
    });
    const execute = async () => {
      executions += 1;
      return executions;
    };

    expect(
      await registry.run(ADMISSION_OPERATION_KIND.CREATE_ROOM, OPERATION_ID, 'same', execute),
    ).toEqual({
      ok: true,
      value: 1,
    });
    now = 301_001;
    expect(
      await registry.run(ADMISSION_OPERATION_KIND.CREATE_ROOM, OPERATION_ID, 'same', execute),
    ).toEqual({
      ok: true,
      value: 2,
    });
  });
});
