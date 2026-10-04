import { Camera, Scene, type WebGLRenderer } from 'three';
import { expect, test } from 'vitest';

import { warmupRenderer } from '@/runtime/dice/canvas/warmup-renderer';

test.each(['async', 'sync'])(
  'warms %s shaders without leaving the preparation image on screen',
  async (mode) => {
    let compiled = false;
    let rendered = false;
    let colorBuffer: string | null = null;
    const compile = () => {
      compiled = true;
    };
    const renderer = {
      compile,
      compileAsync:
        mode === 'async'
          ? async () => {
              await Promise.resolve();
              compile();
            }
          : undefined,
      render: () => {
        expect(compiled).toBe(true);
        rendered = true;
        colorBuffer = 'preparation cup and dice';
      },
      clear: () => {
        colorBuffer = null;
      },
    } as unknown as WebGLRenderer;

    await warmupRenderer(renderer, new Scene(), new Camera());

    expect(rendered).toBe(true);
    expect(colorBuffer).toBeNull();
  },
);
