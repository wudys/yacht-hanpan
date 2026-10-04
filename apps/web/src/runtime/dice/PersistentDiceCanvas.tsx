import { lazy, Suspense, useSyncExternalStore } from 'react';

import { CanvasFailureBoundary } from '@/runtime/dice/canvas/CanvasFailureBoundary';
import type { RendererReadiness } from '@/runtime/dice/canvas/renderer-readiness';
import type { DicePresentation } from '@/runtime/dice/dice-presentation';

const DiceCanvasHost = lazy(() => import('@/runtime/dice/canvas/DiceCanvasHost'));

export function PersistentDiceCanvas({
  presentation,
  renderer,
}: Readonly<{ presentation: DicePresentation; renderer: RendererReadiness }>) {
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
