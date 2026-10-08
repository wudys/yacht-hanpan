import { lazy, Suspense, useSyncExternalStore } from 'react';

import { CanvasFailureBoundary } from '@/runtime/dice/canvas/CanvasFailureBoundary';
import type { RendererReadiness } from '@/runtime/dice/canvas/renderer-readiness';
import type { DicePresentationRenderPort } from '@/runtime/dice/dice-presentation-controller';

const DiceCanvasHost = lazy(() => import('@/runtime/dice/canvas/DiceCanvasHost'));

export function PersistentDiceCanvas({
  presentation,
  renderer,
}: Readonly<{ presentation: DicePresentationRenderPort; renderer: RendererReadiness }>) {
  const snapshot = useSyncExternalStore(renderer.subscribe, renderer.getSnapshot);
  if (
    snapshot.status === 'idle' ||
    snapshot.status === 'runtimeFailed' ||
    snapshot.status === 'disposed'
  )
    return null;
  return (
    <CanvasFailureBoundary renderer={renderer} attempt={snapshot.attempt}>
      <Suspense fallback={null}>
        <DiceCanvasHost presentation={presentation} renderer={renderer} />
      </Suspense>
    </CanvasFailureBoundary>
  );
}
