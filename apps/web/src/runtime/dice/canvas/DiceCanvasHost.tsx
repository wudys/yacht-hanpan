import { createRoot, extend, flushSync, useThree } from '@react-three/fiber';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import * as THREE from 'three';

import { CanvasFailureBoundary } from '@/runtime/dice/canvas/CanvasFailureBoundary';
import { DicePresentationScene } from '@/runtime/dice/canvas/DicePresentationScene';
import type { RendererReadiness } from '@/runtime/dice/canvas/renderer-readiness';
import { warmupRenderer } from '@/runtime/dice/canvas/warmup-renderer';
import type { DicePresentation } from '@/runtime/dice/dice-presentation';
import { DICE_CANVAS_VIEWPORT_SIZE } from '@/runtime/dice/game-dice-layout';
import { DiceRollWarmupScene } from '@/runtime/dice/renderer';

function WarmupScene({
  renderer,
  presentation,
}: Readonly<{ renderer: RendererReadiness; presentation: DicePresentation }>) {
  const { gl, scene, camera } = useThree();
  const snapshot = useSyncExternalStore(renderer.subscribe, renderer.getSnapshot);
  const { resources } = useSyncExternalStore(presentation.subscribe, presentation.getSnapshot);
  useEffect(() => {
    if (resources === null) return;
    void renderer.run(snapshot.attempt, () => warmupRenderer(gl, scene, camera));
  }, [renderer, snapshot.attempt, gl, scene, camera, resources]);
  return resources === null ? null : (
    <DiceRollWarmupScene resources={resources} visible={snapshot.status === 'warming'} />
  );
}

export default function DiceCanvasHost({
  presentation,
  renderer,
}: Readonly<{ presentation: DicePresentation; renderer: RendererReadiness }>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<ReturnType<typeof createRoot> | null>(null);
  const snapshot = useSyncExternalStore(renderer.subscribe, renderer.getSnapshot);
  const presentationSnapshot = useSyncExternalStore(
    presentation.subscribe,
    presentation.getSnapshot,
  );

  useEffect(() => {
    let disposed = false;
    const canvas = canvasRef.current;
    const onContextLost = (error: Event): void => {
      if (!disposed) renderer.fail(snapshot.attempt, error);
    };
    canvas?.addEventListener('webglcontextlost', onContextLost);
    // Skip Strict Mode's discarded setup before creating the app-owned renderer.
    void Promise.resolve().then(async () => {
      if (disposed || !canvas) return;
      try {
        extend({
          AmbientLight: THREE.AmbientLight,
          DirectionalLight: THREE.DirectionalLight,
          Group: THREE.Group,
          HemisphereLight: THREE.HemisphereLight,
          Mesh: THREE.Mesh,
          MeshStandardMaterial: THREE.MeshStandardMaterial,
          Object3D: THREE.Object3D,
          ShadowMaterial: THREE.ShadowMaterial,
        });
        const root = rootRef.current ?? createRoot(canvas);
        rootRef.current = root;
        await root.configure({
          camera: {
            position: [0, 7.48, 1.23],
            rotation: [-Math.PI / 2, 0, 0],
            near: 0.1,
            far: 20,
            zoom: 100,
          },
          size: { ...DICE_CANVAS_VIEWPORT_SIZE, top: 0, left: 0 },
          orthographic: true,
          // The logical Canvas can be CSS-scaled up to 16/9 on desktop.
          // A bounded 2x buffer stays sharp without resizing the camera or context.
          dpr: 2,
          frameloop: 'never',
          shadows: 'percentage',
          onCreated: ({ gl }) => {
            gl.localClippingEnabled = true;
          },
        });
        if (disposed) return;
        root.render(
          <CanvasFailureBoundary renderer={renderer} attempt={snapshot.attempt}>
            <WarmupScene renderer={renderer} presentation={presentation} />
            <DicePresentationScene presentation={presentation} />
          </CanvasFailureBoundary>,
        );
      } catch (error) {
        if (!disposed) renderer.fail(snapshot.attempt, error);
      }
    });
    return () => {
      disposed = true;
      canvas?.removeEventListener('webglcontextlost', onContextLost);
    };
  }, [presentation, renderer, snapshot.attempt]);

  useEffect(
    () => () => {
      // Finish the separate R3F consumer tree before the app releases shared resources.
      flushSync(() => rootRef.current?.unmount());
      rootRef.current = null;
    },
    [],
  );

  return (
    <div
      className='web-dice-canvas-host'
      data-dice-canvas-state={snapshot.status}
      data-dice-presentation-phase={presentationSnapshot.phase}
      aria-hidden='true'
    >
      <canvas ref={canvasRef} data-testid='dice-canvas' />
    </div>
  );
}
