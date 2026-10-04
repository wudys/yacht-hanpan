// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { CanvasFailureBoundary } from '@/runtime/dice/canvas/CanvasFailureBoundary';
import { createRendererReadiness as createReadinessGate } from '@/runtime/dice/canvas/renderer-readiness';

it('forwards a separate-root render error once through readiness without a telemetry provider', async () => {
  const report = vi.fn();
  const renderer = createReadinessGate(report);
  const ready = renderer.prepare();
  const { attempt } = renderer.getSnapshot();
  await renderer.run(attempt, async () => undefined);
  await ready;
  const error = new Error('canvas render failed');
  const BrokenScene = (): never => {
    throw error;
  };
  const view = render(
    <CanvasFailureBoundary renderer={renderer} attempt={attempt}>
      <BrokenScene />
    </CanvasFailureBoundary>,
    { onCaughtError() {} },
  );
  expect(report).toHaveBeenCalledExactlyOnceWith(error);
  expect(renderer.getSnapshot().status).toBe('runtimeFailed');
  view.unmount();
  renderer.dispose();
});
