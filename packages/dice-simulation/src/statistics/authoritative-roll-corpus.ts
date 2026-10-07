import { createHash } from 'node:crypto';

import {
  AUTOMATIC_POUR_STYLES,
  type DieSlot,
  isRollCandidateEvaluation,
  isSimulationInput,
  isSimulationOutcome,
  type PourStyle,
  type RollCandidateEvaluation,
  type RolledFace,
  type SimulationInput,
} from '../contract';

export type CorpusGroup = Readonly<{
  pourStyle: PourStyle;
  rolledSlots: readonly DieSlot[];
  plannedCommands: number;
}>;
export type CandidateObservation =
  | RollCandidateEvaluation
  | Readonly<{ status: 'executor-error'; code: string }>
  | Readonly<{ status: 'invalid-result'; reason: string }>;
export type CorpusAttempt = Readonly<{
  attemptOrdinal: number;
  input: SimulationInput;
  elapsedMs: number;
  observation: CandidateObservation;
}>;
export type CorpusCommand = Readonly<{
  commandOrdinal: number;
  groupOrdinal: number;
  rollId: string;
  seedBank: readonly string[];
  attempts: readonly CorpusAttempt[];
  elapsedMs: number;
  remainingBudgetMs: number | null;
  final:
    | Readonly<{
        status: 'accepted';
        input: SimulationInput;
        authoritativeValuesBySlot: readonly RolledFace[];
        contract: Readonly<{
          releaseId: string;
          gameProtocolVersion: string;
          simulationVersion: string;
          timelineSchemaVersion: string;
        }>;
      }>
    | Readonly<{ status: 'failed'; reason: 'capacity' | 'unavailable' }>;
}>;
export type AuthoritativeRollCorpus = Readonly<{
  kind: 'authoritative-roll-corpus';
  schemaVersion: 1;
  completed: boolean;
  provenance: Readonly<{
    revision: string;
    dirty: boolean;
    bunVersion: string;
    rapierVersion: string;
    simulationVersion: string;
    timelineSchemaVersion: string;
    prefix: string;
    startedAt: string;
    finishedAt: string;
    budgets: Readonly<{ commandMs: number; queueMs: number; jobMs: number }>;
    pool: Readonly<{ workerCount: number; maxQueueSize: number }>;
    inputManifestSha256: string;
    runner: string;
    sourceSha256: string;
  }>;
  groups: readonly CorpusGroup[];
  commands: readonly CorpusCommand[];
}>;

/** Hash the planned input bank, never the returned candidate or final selection. */
export function inputManifestHash(
  corpus: Pick<AuthoritativeRollCorpus, 'groups' | 'commands'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        corpus.commands.map((command) => {
          const group = corpus.groups[command.groupOrdinal];
          return {
            commandOrdinal: command.commandOrdinal,
            groupOrdinal: command.groupOrdinal,
            rollId: command.rollId,
            pourStyle: group.pourStyle,
            rolledSlots: group.rolledSlots,
            seedBank: command.seedBank,
          };
        }),
      ),
    )
    .digest('hex');
}

/** Parse offline data without importing a server-private producer or trusting its assertions. */
export function parseAuthoritativeRollCorpus(value: unknown): AuthoritativeRollCorpus {
  check(record(value), 'root', 'expected object');
  check(
    value.kind === 'authoritative-roll-corpus' && value.schemaVersion === 1,
    'root',
    'unsupported kind/version',
  );
  check(value.completed === true, 'completed', 'incomplete corpus');
  const { provenance } = value;
  check(record(provenance), 'provenance', 'expected object');
  for (const key of [
    'revision',
    'bunVersion',
    'rapierVersion',
    'simulationVersion',
    'timelineSchemaVersion',
    'prefix',
    'runner',
  ]) {
    check(text(provenance[key]), `provenance.${key}`, 'expected bounded nonempty text');
  }
  check(typeof provenance.dirty === 'boolean', 'provenance.dirty', 'expected boolean');
  for (const key of ['startedAt', 'finishedAt'])
    check(
      text(provenance[key]) && Number.isFinite(Date.parse(provenance[key] as string)),
      `provenance.${key}`,
      'expected date',
    );
  check(
    Date.parse(provenance.finishedAt as string) >= Date.parse(provenance.startedAt as string),
    'provenance.finishedAt',
    'precedes start',
  );
  for (const key of ['inputManifestSha256', 'sourceSha256'])
    check(
      typeof provenance[key] === 'string' && /^[a-f0-9]{64}$/.test(provenance[key] as string),
      `provenance.${key}`,
      'expected SHA-256',
    );
  check(record(provenance.budgets), 'provenance.budgets', 'expected object');
  for (const key of ['commandMs', 'queueMs', 'jobMs'])
    check(
      positiveInteger(provenance.budgets[key]),
      `provenance.budgets.${key}`,
      'expected positive integer',
    );
  check(record(provenance.pool), 'provenance.pool', 'expected object');
  check(
    positiveInteger(provenance.pool.workerCount) &&
      nonnegativeInteger(provenance.pool.maxQueueSize),
    'provenance.pool',
    'invalid pool settings',
  );
  check(
    Array.isArray(value.groups) && value.groups.length > 0,
    'groups',
    'expected nonempty array',
  );
  const groupKeys = new Set<string>();
  value.groups.forEach((group: unknown, index: number) => {
    check(record(group), `groups[${index}]`, 'expected object');
    check(
      AUTOMATIC_POUR_STYLES.some((style) => style === group.pourStyle) &&
        slots(group.rolledSlots) &&
        positiveInteger(group.plannedCommands),
      `groups[${index}]`,
      'invalid group',
    );
    const key = `${group.pourStyle}:${(group.rolledSlots as number[]).join(',')}`;
    check(!groupKeys.has(key), `groups[${index}]`, 'duplicate group');
    groupKeys.add(key);
  });
  check(Array.isArray(value.commands), 'commands', 'expected array');
  const groups = value.groups as CorpusGroup[];
  const counts = groups.map(() => 0);
  const rollIds = new Set<string>();
  value.commands.forEach((command: unknown, index: number) => {
    const path = `commands[${index}]`;
    check(record(command), path, 'expected object');
    check(
      command.commandOrdinal === index &&
        nonnegativeInteger(command.groupOrdinal) &&
        command.groupOrdinal < groups.length,
      path,
      'invalid command coordinates',
    );
    const group = groups[command.groupOrdinal as number];
    counts[command.groupOrdinal as number] += 1;
    check(
      text(command.rollId) && !rollIds.has(command.rollId),
      `${path}.rollId`,
      'invalid/duplicate rollId',
    );
    rollIds.add(command.rollId as string);
    check(
      Array.isArray(command.seedBank) &&
        command.seedBank.length === 3 &&
        command.seedBank.every(text) &&
        new Set(command.seedBank).size === 3,
      `${path}.seedBank`,
      'expected three distinct seeds',
    );
    check(finiteTime(command.elapsedMs), `${path}.elapsedMs`, 'invalid elapsed time');
    check(
      Array.isArray(command.attempts) && command.attempts.length <= 3,
      `${path}.attempts`,
      'expected at most three attempts',
    );
    check(
      command.attempts.length === 0
        ? command.remainingBudgetMs === null
        : typeof command.remainingBudgetMs === 'number' &&
            Number.isFinite(command.remainingBudgetMs),
      `${path}.remainingBudgetMs`,
      'expected finite remaining budget after attempts, null only for zero attempts',
    );
    command.attempts.forEach((attempt: unknown, ordinal: number) => {
      const attemptPath = `${path}.attempts[${ordinal}]`;
      check(
        record(attempt) && attempt.attemptOrdinal === ordinal,
        attemptPath,
        'invalid attempt ordinal',
      );
      check(isSimulationInput(attempt.input), `${attemptPath}.input`, 'invalid input');
      const expected = {
        rollId: command.rollId,
        seed: (command.seedBank as string[])[ordinal],
        pourStyle: group.pourStyle,
        rolledSlots: group.rolledSlots,
      };
      check(
        sameInput(attempt.input, expected as SimulationInput),
        `${attemptPath}.input`,
        'request is not the planned seed-only candidate',
      );
      check(
        finiteTime(attempt.elapsedMs) && attempt.elapsedMs <= (command.elapsedMs as number),
        `${attemptPath}.elapsedMs`,
        'invalid elapsed time',
      );
      const { observation } = attempt;
      check(record(observation), `${attemptPath}.observation`, 'expected object');
      if (observation.status === 'accepted' || observation.status === 'rejected') {
        check(
          isRollCandidateEvaluation(observation),
          `${attemptPath}.observation`,
          'invalid candidate shape',
        );
      } else {
        check(
          (observation.status === 'executor-error' && text(observation.code)) ||
            (observation.status === 'invalid-result' && text(observation.reason)),
          `${attemptPath}.observation`,
          'invalid error classification',
        );
      }
      if (ordinal < (command.attempts as unknown[]).length - 1)
        check(
          observation.status === 'rejected',
          attemptPath,
          'only rejected candidates can precede another attempt',
        );
    });
    check(record(command.final), `${path}.final`, 'expected object');
    if (command.final.status === 'accepted') {
      const { final } = command;
      check(
        isSimulationOutcome({
          input: final.input,
          authoritativeValuesBySlot: final.authoritativeValuesBySlot,
        }),
        `${path}.final`,
        'invalid outcome',
      );
      check(record(final.contract), `${path}.final.contract`, 'expected object');
      for (const key of [
        'releaseId',
        'gameProtocolVersion',
        'simulationVersion',
        'timelineSchemaVersion',
      ])
        check(text(final.contract[key]), `${path}.final.contract.${key}`, 'expected bounded text');
      check(
        final.contract.simulationVersion === provenance.simulationVersion &&
          final.contract.timelineSchemaVersion === provenance.timelineSchemaVersion,
        `${path}.final.contract`,
        'provenance version mismatch',
      );
      const last = (command.attempts as CorpusAttempt[]).at(-1);
      check(
        last?.observation.status === 'accepted' &&
          sameInput(last.input, final.input as SimulationInput) &&
          sameInput(last.observation.outcome.input, last.input) &&
          last.observation.outcome.authoritativeValuesBySlot.every(
            (face, index) =>
              face.slot === (final.authoritativeValuesBySlot as RolledFace[])[index]?.slot &&
              face.value === (final.authoritativeValuesBySlot as RolledFace[])[index]?.value,
          ),
        `${path}.final`,
        'does not match last accepted candidate',
      );
    } else {
      check(
        command.final.status === 'failed' &&
          (command.final.reason === 'capacity' || command.final.reason === 'unavailable') &&
          Object.keys(command.final).length === 2,
        `${path}.final`,
        'invalid failure or unexpected outcome',
      );
    }
  });
  check(
    counts.every((count, index) => count === groups[index].plannedCommands),
    'commands',
    'missing/extra planned commands',
  );
  const corpus = value as unknown as AuthoritativeRollCorpus;
  check(
    inputManifestHash(corpus) === provenance.inputManifestSha256,
    'provenance.inputManifestSha256',
    'manifest mismatch',
  );
  return corpus;
}

export function sameInput(left: SimulationInput, right: SimulationInput): boolean {
  return (
    left.rollId === right.rollId &&
    left.seed === right.seed &&
    left.pourStyle === right.pourStyle &&
    left.rolledSlots.length === right.rolledSlots.length &&
    left.rolledSlots.every((slot, index) => slot === right.rolledSlots[index])
  );
}
function slots(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 5 &&
    new Set(value).size === value.length &&
    value.every((slot) => nonnegativeInteger(slot) && slot <= 4)
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}
function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
function positiveInteger(value: unknown): value is number {
  return nonnegativeInteger(value) && value > 0;
}
function finiteTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function check(condition: unknown, path: string, reason: string): asserts condition {
  if (!condition) throw new Error(`${path}: ${reason}`);
}
