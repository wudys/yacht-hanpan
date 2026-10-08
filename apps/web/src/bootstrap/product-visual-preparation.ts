import type { ReadinessReporter } from '@/bootstrap/bootstrap-progress';
import type { ProductVisualResources } from '@/bootstrap/product-visual-resources';
import {
  createRendererReadiness,
  type RendererReadiness,
} from '@/runtime/dice/canvas/renderer-readiness';
import type { DicePresentationController } from '@/runtime/dice/dice-presentation-controller';

export interface ProductVisualPreparation {
  readonly renderer: RendererReadiness;
  prepare(report: ReadinessReporter, signal: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}

export function createProductVisualPreparation({
  activity,
  presentation,
  onRuntimeFailure,
}: Readonly<{
  activity: AbortSignal;
  presentation: Pick<DicePresentationController, 'prepare' | 'setResources'>;
  onRuntimeFailure: (error: unknown) => void;
}>): ProductVisualPreparation {
  const renderer = createRendererReadiness(onRuntimeFailure);
  let pendingResources: Promise<ProductVisualResources> | undefined;
  let resources: ProductVisualResources | undefined;
  let disposed = false;
  let disposal: Promise<void> | undefined;

  function checkActive(signal: AbortSignal) {
    activity.throwIfAborted();
    signal.throwIfAborted();
    if (disposed) throw new Error('Product visual preparation is disposed');
  }

  function getResources() {
    pendingResources ??= import('@/bootstrap/product-visual-resources')
      .then(({ createProductVisualResources }) => {
        resources = createProductVisualResources();
        return resources;
      })
      .catch((error: unknown) => {
        pendingResources = undefined;
        throw error;
      });
    return pendingResources;
  }

  return {
    renderer,
    async prepare(report: ReadinessReporter, signal: AbortSignal) {
      checkActive(signal);
      const [loadedResources] = await Promise.all([
        getResources().then((runtime) => {
          checkActive(signal);
          return runtime.preload(report, signal);
        }),
        presentation.prepare(),
        import('@/runtime/dice/canvas/DiceCanvasHost'),
      ]);
      checkActive(signal);
      presentation.setResources(loadedResources);
      await renderer.prepare(signal);
      checkActive(signal);
      report('gpu', 1);
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      renderer.dispose();
      disposal = resources
        ? resources.dispose()
        : (pendingResources?.then(
            (runtime) => runtime.dispose(),
            () => undefined,
          ) ?? Promise.resolve());
      return disposal;
    },
  };
}
