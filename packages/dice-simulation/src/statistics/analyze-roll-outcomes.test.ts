import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { type AuthoritativeRollCorpus, inputManifestHash } from './authoritative-roll-corpus';
import { corpusFixture } from './corpus-fixture.test-support';

const cli = new URL('./analyze-roll-outcomes.ts', import.meta.url).pathname;
async function run(input: string, output: string) {
  const child = Bun.spawn([process.execPath, cli, '--input', input, '--output', output], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { exit, stderr };
}

test('CLI writes complete/invalid/incomplete/execution/insufficient reports with truthful exits and exclusive output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'roll-analysis-'));
  try {
    const base = corpusFixture();
    const commands = [1, 3, 2, 4].map((face, ordinal) => {
      const input = {
        ...base.commands[0].attempts[0].input,
        rollId: `roll-${ordinal}`,
        seed: `seed-${ordinal}-0`,
        rolledSlots: [4] as const,
      };
      const outcome = {
        input,
        authoritativeValuesBySlot: [{ slot: 4 as const, value: face as 1 }],
      };
      return {
        ...base.commands[0],
        commandOrdinal: ordinal,
        rollId: input.rollId,
        seedBank: [input.seed, `seed-${ordinal}-1`, `seed-${ordinal}-2`],
        attempts: [
          {
            attemptOrdinal: 0,
            input,
            elapsedMs: 1,
            observation: { status: 'accepted' as const, outcome },
          },
        ],
        final: { ...base.commands[0].final, ...outcome },
      };
    });
    const complete: AuthoritativeRollCorpus = {
      ...base,
      groups: [{ pourStyle: 'burst', rolledSlots: [4], plannedCommands: 4 }],
      commands,
    };
    const validatedComplete = {
      ...complete,
      provenance: { ...complete.provenance, inputManifestSha256: inputManifestHash(complete) },
    };
    const failure = {
      ...base,
      commands: [{ ...base.commands[0], final: { status: 'failed', reason: 'unavailable' } }],
    };
    const fixtures = [
      { body: JSON.stringify(validatedComplete), status: 'complete', exit: 0 },
      { body: '{malformed', status: 'invalid-input', exit: 1 },
      { body: JSON.stringify({ ...base, completed: false }), status: 'invalid-input', exit: 1 },
      { body: JSON.stringify(failure), status: 'execution-failure', exit: 1 },
      { body: JSON.stringify(base), status: 'insufficient-data', exit: 1 },
    ];
    for (const [index, fixture] of fixtures.entries()) {
      const input = join(directory, `input-${index}.json`);
      const output = join(directory, `output-${index}.json`);
      await writeFile(input, fixture.body);
      expect((await run(input, output)).exit).toBe(fixture.exit);
      expect(JSON.parse(await readFile(output, 'utf8')).status).toBe(fixture.status);
      const previous = await readFile(output, 'utf8');
      expect((await run(input, output)).exit).not.toBe(0);
      expect(await readFile(output, 'utf8')).toBe(previous);
    }
    const missing = join(directory, 'missing.json');
    const output = join(directory, 'missing-report.json');
    expect((await run(missing, output)).exit).not.toBe(0);
    expect(JSON.parse(await readFile(output, 'utf8')).status).toBe('execution-failure');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
