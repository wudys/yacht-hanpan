import {
  createProceduralDiceResources,
  type ProceduralDiceResources,
} from '@/runtime/dice/resources/procedural-resources';
import { SharedResourceRegistry } from '@/runtime/dice/resources/shared-registry';

export interface ProceduralResourceRegistry {
  preload(): Promise<ProceduralDiceResources>;
  dispose(): Promise<void>;
}

/** Lazily creates one procedural Three resource set shared within its visual owner. */
export function createProceduralResourceRegistry(): ProceduralResourceRegistry {
  return new SharedResourceRegistry(createProceduralDiceResources);
}
