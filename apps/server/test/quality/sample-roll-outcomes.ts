import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DICE_SIMULATION_CONTRACT } from '@repo/dice-simulation/contract';
import { createCompatibilityContract } from '@repo/game-protocol/version';

import { RollSimulationWorkerPool } from '@/roll/worker/roll-simulation-worker-pool';

import {
  collectAuthoritativeRollCommand,
  type CollectedRollCommand,
  CORPUS_BUDGETS,
  CORPUS_POOL,
  createRollCorpusPlan,
} from './authoritative-roll-corpus';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const workerUrl = new URL('../../dist/roll-simulation.worker.js', import.meta.url);
const usage = 'sample:roll-outcomes --prefix <text> --per-group <positive-int> --output <new-path>';

function options(args: readonly string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!;
    const value = args[index + 1];
    if (!['--prefix', '--per-group', '--output'].includes(key) || values.has(key) || !value) {
      throw new Error(usage);
    }
    values.set(key, value);
  }
  const prefix = values.get('--prefix');
  const count = values.get('--per-group');
  const output = values.get('--output');
  if (
    prefix === undefined ||
    count === undefined ||
    output === undefined ||
    !/^[1-9]\d*$/u.test(count)
  ) {
    throw new Error(usage);
  }
  return { prefix, perGroup: Number(count), output: resolve(output) };
}

function sourceFingerprint(): string {
  const files = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    });
  const sources = [
    'apps/server/src',
    'packages/dice-simulation/src',
    'packages/game-protocol/src',
    'packages/yacht-rules/src',
  ]
    .flatMap((directory) => files(resolve(root, directory)))
    .filter((path) => path.endsWith('.ts') && !path.includes('.test.'));
  sources.push(
    fileURLToPath(import.meta.url),
    fileURLToPath(new URL('./authoritative-roll-corpus.ts', import.meta.url)),
    fileURLToPath(workerUrl),
  );
  const hash = createHash('sha256');
  for (const path of sources.sort()) {
    hash.update(relative(root, path)).update('\0').update(readFileSync(path)).update('\0');
  }
  return hash.digest('hex');
}

function readProvenance(prefix: string, inputManifestSha256: string) {
  const rapierPackage = JSON.parse(
    readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.resolve('@dimforge/rapier3d-deterministic'))),
        'package.json',
      ),
      'utf8',
    ),
  ) as { version: string };
  return {
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    dirty:
      execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).length > 0,
    bunVersion: Bun.version,
    rapierVersion: rapierPackage.version,
    simulationVersion: DICE_SIMULATION_CONTRACT.simulationVersion,
    timelineSchemaVersion: DICE_SIMULATION_CONTRACT.timelineSchemaVersion,
    prefix,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    budgets: CORPUS_BUDGETS,
    pool: CORPUS_POOL,
    inputManifestSha256,
    runner: relative(root, fileURLToPath(import.meta.url)),
    sourceSha256: sourceFingerprint(),
  };
}

async function closePool(pool: RollSimulationWorkerPool): Promise<void> {
  await pool.close();
  const stats = pool.stats();
  if (stats.readyWorkers !== 0 || stats.running !== 0 || stats.queued !== 0) {
    throw new Error('Native worker resources remain after corpus collection');
  }
}

async function main(): Promise<void> {
  const selected = options(Bun.argv.slice(2));
  const plan = createRollCorpusPlan(selected.prefix, selected.perGroup);
  // Reserve the path before starting native work; an existing result is never overwritten.
  const output = await open(selected.output, 'wx');
  let interrupted = false;
  const stop = () => {
    interrupted = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const commands: CollectedRollCommand[] = [];
  const pool = new RollSimulationWorkerPool({
    size: CORPUS_POOL.workerCount,
    maxQueued: CORPUS_POOL.maxQueueSize,
    queueTimeoutMs: CORPUS_BUDGETS.queueMs,
    jobTimeoutMs: CORPUS_BUDGETS.jobMs,
    workerUrl,
  });
  let provenance: ReturnType<typeof readProvenance> | null = null;
  let completed = false;
  let failure: string | null = 'initialization';
  try {
    provenance = readProvenance(selected.prefix, plan.inputManifestSha256);
    failure = 'collection';
    await pool.start();
    const contract = createCompatibilityContract('authoritative-roll-corpus-v1');
    for (const command of plan.commands) {
      if (interrupted) break;
      commands.push(await collectAuthoritativeRollCommand(command, { simulation: pool, contract }));
    }
    if (sourceFingerprint() !== provenance.sourceSha256) {
      failure = 'source-changed';
      throw new Error('Runtime sources changed while collecting the corpus');
    }
    completed = !interrupted && commands.length === plan.commands.length;
    failure = completed ? null : 'interrupted';
  } finally {
    try {
      await closePool(pool).catch((error: unknown) => {
        completed = false;
        failure = 'cleanup';
        throw error;
      });
    } finally {
      try {
        if (provenance !== null) provenance.finishedAt = new Date().toISOString();
        // Metadata may be unavailable on initialization failure; incomplete records are never analyzed.
        await output.writeFile(
          JSON.stringify(
            {
              kind: 'authoritative-roll-corpus',
              schemaVersion: 1,
              completed,
              provenance,
              groups: plan.groups,
              commands,
              ...(failure === null ? {} : { failure }),
            },
            null,
            2,
          ),
        );
      } finally {
        await output.close();
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
      }
    }
  }
  console.log(
    JSON.stringify({
      output: selected.output,
      completed,
      commands: commands.length,
      accepted: commands.filter(({ final }) => final.status === 'accepted').length,
      failed: commands.filter(({ final }) => final.status === 'failed').length,
      inputManifestSha256: plan.inputManifestSha256,
      worker: pool.stats(),
    }),
  );
  if (!completed) process.exitCode = 1;
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Corpus collection failed');
    process.exitCode = 1;
  });
}
