import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  type AuthoritativeRollCorpus,
  parseAuthoritativeRollCorpus,
} from './authoritative-roll-corpus';
import {
  type AnalysisIssue,
  type AnalysisStatus,
  analyzeFinalRolls,
} from './final-roll-statistics';

function failureReport(status: AnalysisStatus, location: string, reason: string) {
  const issues: AnalysisIssue[] = [
    { status: status as Exclude<AnalysisStatus, 'complete'>, location, reason },
  ];
  return {
    kind: 'authoritative-roll-analysis',
    schemaVersion: 1,
    sourceInputHash: null,
    status,
    denominators: null,
    groups: [],
    pooled: null,
    issues,
  };
}

export async function analyzeRollOutcomesCli(args: readonly string[]): Promise<number> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      (key !== '--input' && key !== '--output') ||
      options.has(key) ||
      !value?.trim() ||
      value.startsWith('--')
    ) {
      console.error('Usage: analyze:roll-outcomes --input <path> --output <new path>');
      return 1;
    }
    options.set(key, value);
  }
  if (options.size !== 2) {
    console.error('Usage: analyze:roll-outcomes --input <path> --output <new path>');
    return 1;
  }
  const inputPath = resolve(options.get('--input')!);
  const outputPath = resolve(options.get('--output')!);
  if (inputPath === outputPath) {
    console.error('Output must be a new path distinct from input');
    return 1;
  }
  let report: ReturnType<typeof analyzeFinalRolls> | ReturnType<typeof failureReport>;
  let contents: string;
  try {
    contents = await readFile(inputPath, 'utf8');
  } catch {
    report = failureReport('execution-failure', 'input', 'unable to read input file');
    return writeReport(outputPath, report);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch {
    report = failureReport('invalid-input', 'input', 'malformed JSON');
    return writeReport(outputPath, report);
  }
  let corpus: AuthoritativeRollCorpus;
  try {
    corpus = parseAuthoritativeRollCorpus(raw);
  } catch (error) {
    report = failureReport(
      'invalid-input',
      'input',
      error instanceof Error ? error.message : 'invalid corpus',
    );
    return writeReport(outputPath, report);
  }
  try {
    report = analyzeFinalRolls(corpus);
  } catch {
    report = failureReport('execution-failure', 'analysis', 'unable to aggregate validated corpus');
  }
  return writeReport(outputPath, report);
}

async function writeReport(
  path: string,
  report: ReturnType<typeof analyzeFinalRolls> | ReturnType<typeof failureReport>,
): Promise<number> {
  try {
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  } catch {
    console.error('Unable to create a new output file; existing output is never overwritten');
    return 1;
  }
  console.log(
    `Analysis status: ${report.status}. Completion indicates validated aggregation, not fairness certification.`,
  );
  return report.status === 'complete' ? 0 : 1;
}

if (import.meta.main) process.exitCode = await analyzeRollOutcomesCli(process.argv.slice(2));
