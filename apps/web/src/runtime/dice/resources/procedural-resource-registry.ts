import {
  createProceduralDiceResources,
  type ProceduralDiceResources,
} from '@/runtime/dice/resources/procedural-resources';
import { SharedResourceRegistry } from '@/runtime/dice/resources/shared-registry';

export interface ProceduralResourceRegistry {
  preload(): Promise<ProceduralDiceResources>;
  dispose(): Promise<void>;
}

/** Lazily creates one shared procedural Three resource set per browser module instance. */
export const PROCEDURAL_RESOURCE_REGISTRY: ProceduralResourceRegistry = new SharedResourceRegistry(
  createProceduralDiceResources,
);
