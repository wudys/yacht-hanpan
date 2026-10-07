export const POUR_STYLE = {
  CLASSIC: 'classic',
  BURST: 'burst',
  OBLIQUE: 'oblique',
} as const;

export const POUR_STYLES = Object.values(POUR_STYLE);

/** Automatic rolls use the two adopted gestures; classic remains an explicit diagnostic input. */
export const AUTOMATIC_POUR_STYLES = [POUR_STYLE.BURST, POUR_STYLE.OBLIQUE] as const;

export const DICE_SIMULATION_CONTRACT = Object.freeze({
  simulationVersion: 'dice-simulation-v36',
  timelineSchemaVersion: 'dice-timeline-v4',
  replayDigestVersion: 'sha256-q4-v2',
  prngVersion: 'sha256-counter53-v1',
  physicsRuntime: '@dimforge/rapier3d-deterministic@0.19.3',
  fixedStepSeconds: 1 / 60,
} as const);

export const MIN_DICE_COUNT = 1;
export const MAX_DICE_COUNT = 5;
export const MIN_DIE_SLOT = 0;
export const MAX_DIE_SLOT = 4;

/** Keep the cup visible while its physical withdrawal completes, before exit fading. */
export const CUP_EXIT_HOLD_MS = 440;
