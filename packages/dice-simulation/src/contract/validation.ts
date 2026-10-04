import {
  MAX_DICE_COUNT,
  MAX_DIE_SLOT,
  MIN_DICE_COUNT,
  MIN_DIE_SLOT,
  POUR_STYLES,
} from './constants';
import type { DieSlot, PourStyle, SimulationInput } from './types';

export const SIMULATION_INPUT_ERROR_CODE = {
  INVALID_INPUT: 'INVALID_INPUT',
} as const;

export class SimulationInputError extends Error {
  public readonly code: typeof SIMULATION_INPUT_ERROR_CODE.INVALID_INPUT =
    SIMULATION_INPUT_ERROR_CODE.INVALID_INPUT;

  public constructor() {
    super('Invalid simulation input');
    this.name = 'SimulationInputError';
  }
}

const INPUT_KEYS = ['pourStyle', 'rollId', 'rolledSlots', 'seed'] as const;

export function parseSimulationInput(value: unknown): SimulationInput {
  if (!isSimulationInput(value)) throw new SimulationInputError();

  return Object.freeze({
    rollId: value.rollId,
    seed: value.seed,
    rolledSlots: Object.freeze([...value.rolledSlots]),
    pourStyle: value.pourStyle,
  });
}

/** Validates an existing input without allocating a parsed copy. */
export function isSimulationInput(value: unknown): value is SimulationInput {
  return (
    isExactInputObject(value) &&
    isBoundedIdentifier(value.rollId) &&
    isBoundedIdentifier(value.seed) &&
    isPourStyle(value.pourStyle) &&
    isRolledSlots(value.rolledSlots)
  );
}

function isExactInputObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === INPUT_KEYS.length && keys.every((key, index) => key === INPUT_KEYS[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length >= 1 && value.length <= 128 && value.trim() === value
  );
}

function isPourStyle(value: unknown): value is PourStyle {
  return typeof value === 'string' && (POUR_STYLES as readonly string[]).includes(value);
}

function isRolledSlots(value: unknown): value is readonly DieSlot[] {
  if (!Array.isArray(value) || value.length < MIN_DICE_COUNT || value.length > MAX_DICE_COUNT) {
    return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    const slot = value[index];
    if (!Number.isInteger(slot) || slot < MIN_DIE_SLOT || slot > MAX_DIE_SLOT) return false;
    if (index > 0 && value[index - 1] >= slot) return false;
  }
  return true;
}
