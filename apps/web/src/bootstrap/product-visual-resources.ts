import {
  DETERMINISTIC_RAPIER_WASM_FILE,
  initializeDeterministicRapierForBrowser,
} from '@repo/dice-simulation/rapier/browser';

import type { ReadinessReporter } from '@/bootstrap/bootstrap-progress';
import {
  type AssetDecoder,
  createAssetPreloader,
  VISUAL_ASSET_MANIFEST,
  type VisualAssetManifestEntry,
} from '@/bootstrap/preload-assets';
import {
  createProceduralResourceRegistry,
  type ProceduralDiceResources,
  type ProceduralResourceRegistry,
} from '@/runtime/dice/resources';

async function decodeImage(
  entry: VisualAssetManifestEntry,
  signal: AbortSignal,
): Promise<HTMLImageElement> {
  signal.throwIfAborted();
  const image = new Image();
  const cancel = () => image.removeAttribute('src');
  signal.addEventListener('abort', cancel, { once: true });
  image.src = entry.url;
  try {
    await image.decode();
    signal.throwIfAborted();
    return image;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

function disposedError(): Error {
  return new Error('Product visual resources are disposed');
}

export type ProductVisualResourcesOptions = Readonly<{
  decodeAsset?: AssetDecoder;
  initializeRuntime?: typeof initializeDeterministicRapierForBrowser;
  /** Transfers this registry's disposal ownership to this visual owner. */
  proceduralRegistry?: ProceduralResourceRegistry;
}>;

export interface ProductVisualResources {
  preload(report?: ReadinessReporter, signal?: AbortSignal): Promise<ProceduralDiceResources>;
  dispose(): Promise<void>;
}

export function createProductVisualResources(
  options: ProductVisualResourcesOptions = {},
): ProductVisualResources {
  const decoded = new Map<string, number>();
  const reporters = new Set<ReadinessReporter>();
  let proceduralReady = false;
  let assetsReady = false;
  const assetPreloader = createAssetPreloader(VISUAL_ASSET_MANIFEST, async (entry, signal) => {
    const value = await (options.decodeAsset ?? decodeImage)(entry, signal);
    if (!signal.aborted) {
      decoded.set(entry.id, entry.bytes);
      publish();
    }
    return value;
  });
  const initializeRuntime = options.initializeRuntime ?? initializeDeterministicRapierForBrowser;
  const proceduralRegistry = options.proceduralRegistry ?? createProceduralResourceRegistry();
  let resources: ProceduralDiceResources | null = null;
  let loading: Promise<ProceduralDiceResources> | null = null;
  let simulationReady = false;
  let preparation: AbortController | null = null;
  let disposed = false;
  let disposal: Promise<void> | null = null;

  function publish() {
    const bytes = [...decoded.values()].reduce((sum, value) => sum + value, 0);
    for (const report of reporters) {
      report('wasm', simulationReady ? 1 : 0);
      report('assets', bytes);
      report('decode', decoded.size + (proceduralReady ? 1 : 0));
    }
  }

  function load(signal?: AbortSignal): Promise<ProceduralDiceResources> {
    const controller = new AbortController();
    preparation = controller;
    const cancel = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        if (preparation === controller) {
          preparation = null;
          loading = null;
        }
        reject(controller.signal.reason);
      };
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const ready = Promise.all([
      simulationReady
        ? Promise.resolve()
        : initializeRuntime(`/runtime/${DETERMINISTIC_RAPIER_WASM_FILE}`, controller.signal).then(
            () => {
              controller.signal.throwIfAborted();
              simulationReady = true;
              publish();
            },
          ),
      assetPreloader
        .preload(controller.signal)
        .then(() => {
          if (controller.signal.aborted) return;
          assetsReady = true;
          for (const entry of VISUAL_ASSET_MANIFEST) decoded.set(entry.id, entry.bytes);
          publish();
        })
        .catch((error: unknown) => {
          if (preparation === controller) {
            decoded.clear();
            publish();
          }
          throw error;
        }),
      proceduralRegistry.preload().then((value) => {
        if (!controller.signal.aborted) {
          proceduralReady = true;
          publish();
        }
        return value;
      }),
    ]).then(([, , loadedResources]) => loadedResources);
    const request = Promise.race([ready, aborted])
      .then((loadedResources) => {
        controller.signal.throwIfAborted();
        resources = loadedResources;
        return loadedResources;
      })
      .catch((error: unknown) => {
        controller.abort(error);
        throw error;
      })
      .finally(() => {
        signal?.removeEventListener('abort', cancel);
        controller.signal.removeEventListener('abort', onAbort);
        if (preparation === controller) preparation = null;
        if (loading === request) loading = null;
      });
    return request;
  }

  return {
    preload(report?: ReadinessReporter, signal?: AbortSignal) {
      if (disposed) return Promise.reject(disposedError());
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (!loading && !assetsReady) decoded.clear();
      if (report) reporters.add(report);
      publish();
      const request = resources ? Promise.resolve(resources) : (loading ??= load(signal));
      return report ? request.finally(() => reporters.delete(report)) : request;
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      preparation?.abort(disposedError());
      reporters.clear();
      disposal = (async () => {
        await Promise.all([assetPreloader.dispose(), proceduralRegistry.dispose()]);
        resources = null;
      })();
      return disposal;
    },
  };
}
