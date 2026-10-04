import type { SimulationInput, SimulationOutcome, SimulationResult } from './types';
import { isSimulationInput, parseSimulationInput } from './validation';

/** Checks compact shape and ordered outcome slots; request identity remains with the caller. */
export function isSimulationOutcome(value: unknown): value is SimulationOutcome {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['authoritativeValuesBySlot', 'input']) &&
    isSimulationInput(value.input) &&
    Array.isArray(value.authoritativeValuesBySlot) &&
    isRolledFaces(value.authoritativeValuesBySlot, value.input.rolledSlots)
  );
}

/** Checks result shape only; request identity and digest verification remain with the caller. */
export function isSimulationResult(value: unknown): value is SimulationResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['authoritativeValuesBySlot', 'input', 'replayDigest', 'timeline']) ||
    !isRecord(value.input) ||
    !isRecord(value.timeline) ||
    !Array.isArray(value.authoritativeValuesBySlot) ||
    typeof value.replayDigest !== 'string'
  ) {
    return false;
  }

  try {
    const input = parseSimulationInput(value.input);
    return (
      isRollTimeline(value.timeline, input) &&
      isRolledFaces(value.authoritativeValuesBySlot, input.rolledSlots)
    );
  } catch {
    return false;
  }
}

function isRollTimeline(value: Record<string, unknown>, input: SimulationInput): boolean {
  return (
    hasExactKeys(value, ['cup', 'dice', 'durationMs', 'rollArea', 'rollId', 'seed']) &&
    value.rollId === input.rollId &&
    value.seed === input.seed &&
    isFiniteNumber(value.durationMs) &&
    isCupMotion(value.cup, input.pourStyle) &&
    isRollArea(value.rollArea) &&
    Array.isArray(value.dice) &&
    value.dice.length === input.rolledSlots.length &&
    Array.from(value.dice).every((die, index) => isDieTimeline(die, input.rolledSlots[index]))
  );
}

function isCupMotion(value: unknown, pourStyle: SimulationInput['pourStyle']): boolean {
  if (!isRecord(value)) return false;
  const requiredNumbers = [
    'exitAtMs',
    'innerDepth',
    'innerHeight',
    'innerWidth',
    'pourAtMs',
    'releaseAtMs',
    'shakeAmplitude',
    'shakeFrequency',
  ] as const;
  return (
    value.style === pourStyle &&
    requiredNumbers.every((key) => isFiniteNumber(value[key])) &&
    (value.stageX === undefined || isFiniteNumber(value.stageX)) &&
    Array.isArray(value.frames) &&
    Array.from(value.frames).every(isCupFrame)
  );
}

function isCupFrame(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['mode', 'p', 'q', 't', 'visible']) &&
    isFiniteNumber(value.t) &&
    isNumberTuple(value.p, 3) &&
    isNumberTuple(value.q, 4) &&
    typeof value.visible === 'boolean' &&
    (value.mode === 'shake' || value.mode === 'pour' || value.mode === 'exit')
  );
}

function isRollArea(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const allowedKeys = new Set(['aspectRatio', 'bottomZ', 'centerZ', 'depth', 'topZ', 'width']);
  return (
    Object.keys(value).every((key) => allowedKeys.has(key)) &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.depth) &&
    isFiniteNumber(value.aspectRatio) &&
    (value.bottomZ === undefined || isFiniteNumber(value.bottomZ)) &&
    (value.centerZ === undefined || isFiniteNumber(value.centerZ)) &&
    (value.topZ === undefined || isFiniteNumber(value.topZ))
  );
}

function isDieTimeline(value: unknown, expectedSlot: number | undefined): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['frames', 'slot', 'value']) &&
    value.slot === expectedSlot &&
    isDieFace(value.value) &&
    Array.isArray(value.frames) &&
    Array.from(value.frames).every(isDieFrame)
  );
}

function isDieFrame(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['p', 'q', 't']) &&
    isFiniteNumber(value.t) &&
    isNumberTuple(value.p, 3) &&
    isNumberTuple(value.q, 4)
  );
}

function isRolledFaces(value: unknown[], expectedSlots: readonly number[]): boolean {
  return (
    value.length === expectedSlots.length &&
    Array.from(value).every(
      (face, index) =>
        isRecord(face) &&
        hasExactKeys(face, ['slot', 'value']) &&
        face.slot === expectedSlots[index] &&
        isDieFace(face.value),
    )
  );
}

function isNumberTuple(value: unknown, length: number): boolean {
  return Array.isArray(value) && value.length === length && Array.from(value).every(isFiniteNumber);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isDieFace(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 6;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
