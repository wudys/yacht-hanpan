import type { FMSynth } from 'tone/build/esm/instrument/FMSynth';

interface SourceEvent {
  at: number;
  note: string;
  velocity: number;
  patch: NonNullable<ConstructorParameters<typeof FMSynth>[0]> & {
    envelope: { attack: number; decay: number };
  };
}
interface LevelledEvent {
  at: number;
  frequency: number;
  gate: number;
}
export interface LevelledOptions {
  amp?: number;
  attack?: number;
  decay?: number;
  sustain?: number;
  release?: number;
}
interface OscillatorEvent extends LevelledEvent {
  options: LevelledOptions & {
    waveform?: 'sine' | 'triangle';
    modulationIndex?: never;
  };
}
interface FmLevelledEvent extends LevelledEvent {
  options: LevelledOptions & {
    modulationIndex: number;
    waveform?: never;
  };
}
// Profiles select synthesis and mastering behavior; cue keys describe their product role.
export type CueRecipe =
  | {
      profile: 'fm-patch';
      duration: number;
      events: SourceEvent[];
      trimDb: number;
      finalGain: number;
    }
  | {
      profile: 'oscillator-levelled';
      duration: number;
      events: OscillatorEvent[];
      highpass: number;
      baselineRms80: number;
      minSeconds: number;
      finalGain: number;
    }
  | {
      profile: 'fm-levelled';
      duration: number;
      events: FmLevelledEvent[];
      targetRms: number;
    };

export const cueRecipes = {
  click: {
    profile: 'fm-patch',
    duration: 0.5,
    trimDb: 2.9,
    events: [
      {
        at: 0,
        note: 'A5',
        patch: {
          envelope: {
            attack: 0.002,
            decay: 0.04,
            release: 0.006,
            sustain: 0,
          },
          harmonicity: 2,
          modulation: {
            type: 'sine',
          },
          modulationEnvelope: {
            attack: 0.001,
            decay: 0.009,
            release: 0.003,
            sustain: 0,
          },
          modulationIndex: 0.4,
          oscillator: {
            type: 'sine',
          },
          volume: 0,
        },
        velocity: 0.72,
      },
    ],
    finalGain: 1.3706646811019683,
  },
  hold: {
    profile: 'fm-patch',
    duration: 0.5,
    trimDb: -2.1,
    events: [
      {
        at: 0,
        note: 'A5',
        patch: {
          envelope: {
            attack: 0.0015,
            decay: 0.027,
            release: 0.005,
            sustain: 0,
          },
          harmonicity: 3,
          modulation: {
            type: 'sine',
          },
          modulationEnvelope: {
            attack: 0.001,
            decay: 0.007,
            release: 0.003,
            sustain: 0,
          },
          modulationIndex: 0.9,
          oscillator: {
            type: 'sine',
          },
          volume: 0,
        },
        velocity: 0.8,
      },
    ],
    finalGain: 2.8691616889464067,
  },
  release: {
    profile: 'fm-patch',
    duration: 0.5,
    trimDb: -1.4,
    events: [
      {
        at: 0,
        note: 'E5',
        patch: {
          envelope: {
            attack: 0.0015,
            decay: 0.027,
            release: 0.005,
            sustain: 0,
          },
          harmonicity: 3,
          modulation: {
            type: 'sine',
          },
          modulationEnvelope: {
            attack: 0.001,
            decay: 0.007,
            release: 0.003,
            sustain: 0,
          },
          modulationIndex: 0.9,
          oscillator: {
            type: 'sine',
          },
          volume: 0,
        },
        velocity: 0.6,
      },
    ],
    finalGain: 2.811366447948034,
  },
  score: {
    profile: 'fm-patch',
    duration: 0.5,
    trimDb: 1.6,
    events: [
      {
        at: 0,
        note: 'G5',
        patch: {
          envelope: {
            attack: 0.002,
            decay: 0.046,
            release: 0.006,
            sustain: 0,
          },
          harmonicity: 2,
          modulation: {
            type: 'sine',
          },
          modulationEnvelope: {
            attack: 0.001,
            decay: 0.009,
            release: 0.003,
            sustain: 0,
          },
          modulationIndex: 0.65,
          oscillator: {
            type: 'sine',
          },
          volume: 0,
        },
        velocity: 0.65,
      },
      {
        at: 0.058,
        note: 'D6',
        patch: {
          envelope: {
            attack: 0.002,
            decay: 0.046,
            release: 0.006,
            sustain: 0,
          },
          harmonicity: 2,
          modulation: {
            type: 'sine',
          },
          modulationEnvelope: {
            attack: 0.001,
            decay: 0.009,
            release: 0.003,
            sustain: 0,
          },
          modulationIndex: 0.65,
          oscillator: {
            type: 'sine',
          },
          volume: 0,
        },
        velocity: 0.8,
      },
    ],
    finalGain: 1.4839607268035506,
  },
  success: {
    profile: 'fm-patch',
    duration: 0.5,
    trimDb: -1.9,
    events: [
      {
        at: 0,
        note: 'C6',
        patch: {
          envelope: {
            attack: 0.002,
            decay: 0.046,
            release: 0.006,
            sustain: 0,
          },
          harmonicity: 2,
          modulation: {
            type: 'sine',
          },
          modulationEnvelope: {
            attack: 0.001,
            decay: 0.009,
            release: 0.003,
            sustain: 0,
          },
          modulationIndex: 0.65,
          oscillator: {
            type: 'sine',
          },
          volume: 0,
        },
        velocity: 0.76,
      },
    ],
    finalGain: 2.107806869169215,
  },
  warning: {
    events: [
      {
        frequency: 739.9888454232688,
        at: 0,
        gate: 0.067,
        options: {
          waveform: 'triangle',
          amp: 0.42,
          attack: 0.007,
          decay: 0.055,
          sustain: 0.25,
          release: 0.065,
        },
      },
      {
        frequency: 369.9944227116344,
        at: 0,
        gate: 0.06,
        options: {
          amp: 0.05,
          attack: 0.006,
          release: 0.055,
        },
      },
    ],
    duration: 0.7,
    baselineRms80: 0.17,
    profile: 'oscillator-levelled',
    minSeconds: 0.09,
    highpass: 35,
    finalGain: 0.676664937349934,
  },
  combo: {
    profile: 'fm-levelled',
    duration: 1,
    targetRms: 0.15,
    events: [
      {
        frequency: 440,
        at: 0.008,
        gate: 0.025,
        options: {
          modulationIndex: 0.8,
          amp: 0.13,
          attack: 0.001,
          decay: 0.025,
          sustain: 0.3,
          release: 0.018,
        },
      },
      {
        frequency: 554.3652619537442,
        at: 0.037000000000000005,
        gate: 0.025,
        options: {
          modulationIndex: 0.8,
          amp: 0.139,
          attack: 0.001,
          decay: 0.025,
          sustain: 0.3,
          release: 0.018,
        },
      },
      {
        frequency: 659.2551138257398,
        at: 0.066,
        gate: 0.025,
        options: {
          modulationIndex: 0.8,
          amp: 0.148,
          attack: 0.001,
          decay: 0.025,
          sustain: 0.3,
          release: 0.018,
        },
      },
      {
        frequency: 880,
        at: 0.095,
        gate: 0.025,
        options: {
          modulationIndex: 0.8,
          amp: 0.157,
          attack: 0.001,
          decay: 0.025,
          sustain: 0.3,
          release: 0.018,
        },
      },
      {
        frequency: 1108.7305239074883,
        at: 0.124,
        gate: 0.025,
        options: {
          modulationIndex: 0.8,
          amp: 0.166,
          attack: 0.001,
          decay: 0.025,
          sustain: 0.3,
          release: 0.018,
        },
      },
      {
        frequency: 1318.5102276514797,
        at: 0.155,
        gate: 0.18,
        options: {
          modulationIndex: 0.8,
          amp: 0.15,
          attack: 0.002,
          decay: 0.11,
          sustain: 0.24,
          release: 0.16,
        },
      },
      {
        frequency: 880,
        at: 0.155,
        gate: 0.18,
        options: {
          modulationIndex: 0.22,
          amp: 0.19,
          decay: 0.11,
          sustain: 0.23,
          release: 0.18,
        },
      },
    ],
  },
  yacht: {
    profile: 'fm-levelled',
    duration: 1.7,
    targetRms: 0.16,
    events: [
      {
        frequency: 440,
        at: 0.008,
        gate: 0.029,
        options: {
          modulationIndex: 0.8,
          amp: 0.12,
          attack: 0.001,
          decay: 0.025,
          sustain: 0.3,
          release: 0.018,
        },
      },
      {
        frequency: 659.2551138257398,
        at: 0.041,
        gate: 0.029,
        options: {
          modulationIndex: 0.8,
          amp: 0.128,
          attack: 0.001,
          decay: 0.025,
          sustain: 0.3,
          release: 0.018,
        },
      },
      {
        frequency: 880,
        at: 0.07400000000000001,
        gate: 0.029,
        options: {
          modulationIndex: 0.8,
          amp: 0.136,
          attack: 0.001,
          decay: 0.025,
          sustain: 0.3,
          release: 0.018,
        },
      },
      {
        frequency: 1108.7305239074883,
        at: 0.10700000000000001,
        gate: 0.029,
        options: {
          modulationIndex: 0.8,
          amp: 0.144,
          attack: 0.001,
          decay: 0.025,
          sustain: 0.3,
          release: 0.018,
        },
      },
      {
        frequency: 1318.5102276514797,
        at: 0.14,
        gate: 0.029,
        options: {
          modulationIndex: 0.8,
          amp: 0.152,
          attack: 0.001,
          decay: 0.025,
          sustain: 0.3,
          release: 0.018,
        },
      },
      {
        frequency: 1318.5102276514797,
        at: 0.18,
        gate: 0.1,
        options: {
          modulationIndex: 0.8,
          amp: 0.15,
          attack: 0.001,
          decay: 0.08,
          sustain: 0.24,
          release: 0.055,
        },
      },
      {
        frequency: 880,
        at: 0.18,
        gate: 0.1,
        options: {
          modulationIndex: 0.22,
          amp: 0.19,
          decay: 0.11,
          sustain: 0.23,
          release: 0.07,
        },
      },
      {
        frequency: 1108.7305239074883,
        at: 0.325,
        gate: 0.052,
        options: {
          modulationIndex: 0.8,
          amp: 0.12,
          attack: 0.001,
          decay: 0.025,
          sustain: 0.3,
          release: 0.027,
        },
      },
      {
        frequency: 1318.5102276514797,
        at: 0.399,
        gate: 0.052,
        options: {
          modulationIndex: 0.8,
          amp: 0.14,
          attack: 0.001,
          decay: 0.025,
          sustain: 0.3,
          release: 0.027,
        },
      },
      {
        frequency: 1760,
        at: 0.483,
        gate: 0.31,
        options: {
          modulationIndex: 0.8,
          amp: 0.15,
          attack: 0.002,
          decay: 0.13,
          sustain: 0.25,
          release: 0.31,
        },
      },
      {
        frequency: 1108.7305239074883,
        at: 0.483,
        gate: 0.31,
        options: {
          modulationIndex: 0.22,
          amp: 0.14,
          decay: 0.11,
          sustain: 0.26,
          release: 0.34,
        },
      },
      {
        frequency: 880,
        at: 0.483,
        gate: 0.31,
        options: {
          modulationIndex: 0.22,
          amp: 0.1,
          decay: 0.11,
          sustain: 0.23,
          release: 0.34,
        },
      },
    ],
  },
} satisfies Record<string, CueRecipe>;

export type CueRecipeId = keyof typeof cueRecipes;
