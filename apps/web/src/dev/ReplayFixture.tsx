import { parseSimulationInput, type SimulationResult } from '@repo/dice-simulation/contract';
import { simulateRoll } from '@repo/dice-simulation/simulate';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { createProductVisualResources } from '@/bootstrap/product-visual-resources';
import { VisualFixture, type VisualFixtureProps } from '@/dev/VisualFixture';
import DiceCanvasHost from '@/runtime/dice/canvas/DiceCanvasHost';
import { createRendererReadiness } from '@/runtime/dice/canvas/renderer-readiness';
import {
  DICE_REVEAL_DURATION_MS,
  type DicePresentationSnapshot,
  type DicePresentationView,
} from '@/runtime/dice/dice-presentation';
import type { ProceduralDiceResources } from '@/runtime/dice/resources';

// A repeatable render fixture, not a server or product-state substitute.
// Default: keep the raw final pose. arrange=1 also exercises the shared Canvas
// transition, not authoritative session, scoring, or achievement behavior.
export function ReplayFixture({
  anchor,
  mode,
  locale,
  seed,
  pourStyle,
  count,
  arrange,
}: Omit<VisualFixtureProps, 'replay'> &
  Readonly<{ seed: string; pourStyle: string; count: number; arrange: boolean }>) {
  const [ready, setReady] = useState<{
    result: SimulationResult;
    resources: ProceduralDiceResources;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [complete, setComplete] = useState(false);

  useEffect(() => {
    const runtime = createProductVisualResources();
    let disposed = false;
    void (async () => {
      try {
        const input = parseSimulationInput({
          rollId: 'quality-visual-fixture',
          seed,
          pourStyle,
          rolledSlots: [0, 1, 2, 3, 4].slice(0, count),
        });
        const resources = await runtime.preload();
        const result = await simulateRoll(input);
        if (!disposed) setReady({ result, resources });
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      disposed = true;
      void runtime.dispose();
    };
  }, [seed, pourStyle, count]);

  return (
    <>
      <VisualFixture
        anchor={anchor}
        mode={mode}
        locale={locale}
        replay={
          ready ? (
            <FixtureCanvas key={generation} {...ready} arrange={arrange} onComplete={setComplete} />
          ) : null
        }
      />
      <button
        className='anchor-replay-control'
        disabled={!ready}
        data-replay-complete={complete}
        data-replay-digest={ready?.result.replayDigest}
        data-authoritative-values={ready?.result.authoritativeValuesBySlot
          .map((die) => die.value)
          .join(',')}
        onClick={() => {
          setComplete(false);
          setGeneration((value) => value + 1);
        }}
      >
        {error ?? (ready ? 'Replay fixture' : 'Loading fixture')}
      </button>
    </>
  );
}

function FixtureCanvas({
  result,
  resources,
  arrange,
  onComplete,
}: Readonly<{
  result: SimulationResult;
  resources: ProceduralDiceResources;
  arrange: boolean;
  onComplete: (complete: boolean) => void;
}>) {
  const renderer = useMemo(createRendererReadiness, []);
  const [phase, setPhase] = useState<'rolling' | 'revealing' | 'settled'>('rolling');
  useEffect(() => {
    if (phase !== 'revealing') return;
    const timer = setTimeout(() => {
      setPhase('settled');
      onComplete(true);
    }, DICE_REVEAL_DURATION_MS);
    return () => clearTimeout(timer);
  }, [phase, onComplete]);
  const rendererState = useSyncExternalStore(renderer.subscribe, renderer.getSnapshot);
  const presentation = useMemo<DicePresentationView>(() => {
    const hidden = { phase: 'hidden' as const, resources };
    const snapshot: DicePresentationSnapshot = {
      phase,
      rollId: result.input.rollId,
      playback: {
        status: 'verified' as const,
        rollId: result.input.rollId,
        timeline: result.timeline,
      },
      dice: result.authoritativeValuesBySlot,
      resources,
    };
    // Only the rendering boundary is exercised here. The real session owns transitions.
    return {
      getSnapshot: () => (rendererState.status === 'ready' ? snapshot : hidden),
      subscribe: () => () => {},
      completePlayback: () => (arrange ? setPhase('revealing') : onComplete(true)),
    };
  }, [result, resources, onComplete, rendererState.status, phase, arrange]);
  useEffect(() => {
    void renderer.prepare();
    return () => renderer.dispose();
  }, [renderer]);
  return <DiceCanvasHost presentation={presentation} renderer={renderer} />;
}
