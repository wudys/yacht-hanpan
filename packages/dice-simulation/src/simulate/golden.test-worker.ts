import type { SimulationInput } from '../contract';
import { initializeDeterministicRapierForBun } from '../rapier/bun/initialize-rapier';
import { simulateRollWithDigest } from './simulate-roll';

declare const self: Worker;

self.onmessage = async (event: MessageEvent<SimulationInput>): Promise<void> => {
  try {
    await initializeDeterministicRapierForBun();
    self.postMessage({ ok: true, result: await simulateRollWithDigest(event.data) });
  } catch (error) {
    self.postMessage({
      ok: false,
      error: error instanceof Error ? error.name : 'UnknownError',
    });
  }
};
