export const RAPIER_INITIALIZATION_ERROR_CODE = {
  NOT_READY: 'RAPIER_NOT_READY',
} as const;

export class RapierInitializationError extends Error {
  public readonly code: typeof RAPIER_INITIALIZATION_ERROR_CODE.NOT_READY =
    RAPIER_INITIALIZATION_ERROR_CODE.NOT_READY;

  public constructor() {
    super('Deterministic Rapier is not initialized');
    this.name = 'RapierInitializationError';
  }
}

let ready = false;

export function markRapierReady(): void {
  ready = true;
}

export function assertRapierReady(): void {
  if (!ready) throw new RapierInitializationError();
}
