import { POUR_STYLES, type SimulationResult } from '@repo/dice-simulation/contract';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { createProductVisualResources } from '@/bootstrap/product-visual-resources';
import {
  type PhysicsDiagnosticInput,
  runPhysicsDiagnostic,
} from '@/dev/physics-diagnostic-simulation';
import DiceCanvasHost from '@/runtime/dice/canvas/DiceCanvasHost';
import { createRendererReadiness } from '@/runtime/dice/canvas/renderer-readiness';
import type { DicePresentationView } from '@/runtime/dice/dice-presentation';
import type { ProceduralDiceResources } from '@/runtime/dice/resources';
import { GameFrame } from '@/ui/layout';

export function PhysicsDiagnostic() {
  const [draft, setDraft] = useState({
    seed: 'gesture-explore-20260921-14',
    pourStyle: 'classic',
    count: '5',
  });
  const [run, setRun] = useState<Readonly<{
    identity: number;
    input: PhysicsDiagnosticInput;
  }> | null>(null);
  const controls = (
    <form
      className='physics-diagnostic__form'
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setRun((previous) => ({
          identity: (previous?.identity ?? 0) + 1,
          input: { seed: draft.seed, pourStyle: draft.pourStyle, count: Number(draft.count) },
        }));
      }}
    >
      <label>
        Seed
        <input
          value={draft.seed}
          onChange={(event) => setDraft({ ...draft, seed: event.target.value })}
        />
      </label>
      <label>
        Pour style
        <select
          value={draft.pourStyle}
          onChange={(event) => setDraft({ ...draft, pourStyle: event.target.value })}
        >
          {POUR_STYLES.map((style) => (
            <option key={style} value={style}>
              {style}
            </option>
          ))}
        </select>
      </label>
      <label>
        Dice count
        <input
          type='number'
          min={1}
          max={5}
          step={1}
          value={draft.count}
          onChange={(event) => setDraft({ ...draft, count: event.target.value })}
        />
      </label>
      <button type='submit'>Run</button>
    </form>
  );
  return <DiagnosticRun key={run?.identity ?? 0} input={run?.input ?? null} controls={controls} />;
}

function DiagnosticRun({
  input,
  controls,
}: Readonly<{ input: PhysicsDiagnosticInput | null; controls: ReactNode }>) {
  const [ready, setReady] = useState<Readonly<{
    result: SimulationResult;
    resources: ProceduralDiceResources;
  }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (input === null) return;
    const runtime = createProductVisualResources();
    const activity = new AbortController();
    void (async () => {
      try {
        const resources = await runtime.preload(undefined, activity.signal);
        activity.signal.throwIfAborted();
        const result = await runPhysicsDiagnostic(input, activity.signal);
        if (!activity.signal.aborted) setReady({ result, resources });
      } catch (cause) {
        if (!activity.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      activity.abort();
      void runtime.dispose();
    };
  }, [input]);

  return (
    <main className='physics-diagnostic'>
      <section className='physics-diagnostic__stage' aria-label='Physical dice board'>
        <GameFrame orientationMessage='Use portrait orientation to inspect the dice board.'>
          <div className='physics-diagnostic__playfield' aria-hidden='true' />
          {ready ? (
            <DiagnosticCanvas
              key={generation}
              {...ready}
              onComplete={setComplete}
              onError={setError}
            />
          ) : null}
        </GameFrame>
      </section>
      <aside className='physics-diagnostic__controls'>
        <h1>Physics diagnostic</h1>
        <p>
          Run simulates the submitted input. Replay repeats the current result. Final dice keep
          their raw pose.
        </p>
        {controls}
        <h2>Current run</h2>
        {input ? (
          <dl className='physics-diagnostic__result'>
            <dt>Seed</dt>
            <dd data-testid='physics-current-seed'>{input.seed}</dd>
            <dt>Pour style</dt>
            <dd data-testid='physics-current-style'>{input.pourStyle}</dd>
            <dt>Dice count</dt>
            <dd data-testid='physics-current-count'>{input.count}</dd>
          </dl>
        ) : (
          <p>No diagnostic run.</p>
        )}
        {error ? <p role='alert'>{error}</p> : null}
        <button
          type='button'
          disabled={!ready}
          data-physics-complete={complete}
          onClick={() => {
            setError(null);
            setComplete(false);
            setGeneration((value) => value + 1);
          }}
        >
          Replay
        </button>
        <p role='status'>
          {error
            ? 'Failed'
            : ready
              ? complete
                ? 'Complete — raw final pose retained.'
                : 'Playing'
              : input
                ? 'Preparing'
                : 'Idle'}
        </p>
        {ready ? (
          <>
            <h2>Ordered eyes</h2>
            <ol className='physics-diagnostic__eyes'>
              {ready.result.authoritativeValuesBySlot.map((die) => (
                <li key={die.slot}>
                  Slot {die.slot}: <strong data-physics-die-slot={die.slot}>{die.value}</strong>
                </li>
              ))}
            </ol>
            <h2>Replay digest</h2>
            <code data-testid='physics-result-digest'>{ready.result.replayDigest}</code>
          </>
        ) : null}
        <p>
          <a href='/'>Open product</a>
        </p>
      </aside>
    </main>
  );
}

function DiagnosticCanvas({
  result,
  resources,
  onComplete,
  onError,
}: Readonly<{
  result: SimulationResult;
  resources: ProceduralDiceResources;
  onComplete: (complete: boolean) => void;
  onError: (error: string) => void;
}>) {
  const active = useRef(true);
  const reportFailure = useCallback(
    (cause: unknown) => {
      if (!active.current) return;
      onComplete(false);
      onError(cause instanceof Error ? cause.message : String(cause));
    },
    [onComplete, onError],
  );
  const renderer = useMemo(() => createRendererReadiness(reportFailure), [reportFailure]);
  const rendererState = useSyncExternalStore(renderer.subscribe, renderer.getSnapshot);
  const presentation = useMemo<DicePresentationView>(() => {
    const hidden = { phase: 'hidden' as const, resources };
    const snapshot = {
      phase: 'rolling' as const,
      rollId: result.input.rollId,
      playback: {
        status: 'verified' as const,
        rollId: result.input.rollId,
        timeline: result.timeline,
      },
      dice: result.authoritativeValuesBySlot,
      resources,
    };
    return {
      getSnapshot: () => (rendererState.status === 'ready' ? snapshot : hidden),
      subscribe: () => () => {},
      completePlayback: () => {
        if (active.current && renderer.getSnapshot().status === 'ready') onComplete(true);
      },
    };
  }, [result, resources, onComplete, renderer, rendererState.status]);
  useEffect(() => {
    void renderer.prepare().catch(reportFailure);
    return () => {
      active.current = false;
      renderer.dispose();
    };
  }, [renderer, reportFailure]);
  return <DiceCanvasHost renderer={renderer} presentation={presentation} />;
}
