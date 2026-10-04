import { describe, expect, it, vi } from 'vitest';

import { createTelemetry } from '@/runtime/telemetry/telemetry';

describe('telemetry lifecycle', () => {
  it('deduplicates screens and stops manual events on disposal', async () => {
    const send = vi.fn();
    const telemetry = createTelemetry({ analytics: { send } });
    telemetry.trackEvent({ name: 'bootstrap_result', outcome: 'success', duration_ms: 100 });
    expect(send).not.toHaveBeenCalled();
    await telemetry.start();
    await telemetry.start();
    telemetry.trackScreen('entry');
    telemetry.trackScreen('entry');
    telemetry.trackScreen('lobby');
    expect(send.mock.calls.map(([event]) => event)).toEqual([
      { name: 'page_view', screen: 'entry' },
      { name: 'page_view', screen: 'lobby' },
    ]);
    telemetry.dispose();
    telemetry.trackScreen('game');
    telemetry.trackEvent({ name: 'bootstrap_result', outcome: 'success', duration_ms: 100 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('supports a runtime without either provider', async () => {
    const telemetry = createTelemetry({});
    await expect(telemetry.start()).resolves.toBeUndefined();
    expect(() => {
      telemetry.trackScreen('entry');
      telemetry.reportUnexpected(new Error('render failed'));
      telemetry.dispose();
    }).not.toThrow();
  });

  it('reports directly to the prepared collector without a pending queue or page cap', async () => {
    const reportUnexpected = vi.fn();
    const telemetry = createTelemetry({ errors: { reportUnexpected, dispose() {} } });
    const failures = Array.from({ length: 35 }, (_, index) => new Error(`failure-${index}`));
    for (const failure of failures) telemetry.reportUnexpected(failure);
    expect(reportUnexpected).toHaveBeenCalledTimes(35);
    expect(reportUnexpected).toHaveBeenLastCalledWith(failures[34], undefined);
    await telemetry.start();
    expect(reportUnexpected).toHaveBeenCalledTimes(35);
  });

  it('isolates vendor reporting and disposal failures while retaining usage tracking', async () => {
    const send = vi.fn();
    const dispose = vi.fn(() => {
      throw new Error('collector close failed');
    });
    const telemetry = createTelemetry({
      analytics: { send },
      errors: {
        reportUnexpected() {
          throw new Error('collector failed');
        },
        dispose,
      },
    });
    await telemetry.start();
    expect(() => telemetry.reportUnexpected(new Error('product failed'))).not.toThrow();
    telemetry.trackScreen('game');
    expect(send).toHaveBeenCalledExactlyOnceWith({ name: 'page_view', screen: 'game' });
    expect(() => {
      telemetry.dispose();
      telemetry.dispose();
    }).not.toThrow();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('isolates an analytics failure from error reporting', async () => {
    const reportUnexpected = vi.fn();
    const telemetry = createTelemetry({
      analytics: {
        send() {
          throw new Error('analytics failed');
        },
      },
      errors: { reportUnexpected, dispose() {} },
    });
    await telemetry.start();
    expect(() => telemetry.trackScreen('entry')).not.toThrow();
    const error = new Error('local failure');
    telemetry.reportUnexpected(error);
    expect(reportUnexpected).toHaveBeenCalledExactlyOnceWith(error, undefined);
  });
});

it('forwards the original error and context then releases the collector on disposal', async () => {
  const report = vi.fn();
  const dispose = vi.fn();
  const telemetry = createTelemetry({ errors: { reportUnexpected: report, dispose } });
  const failure = new Error('local only');
  telemetry.reportUnexpected(failure, { operation: 'roll' });
  telemetry.reportUnexpected(failure, { operation: 'score' });
  await telemetry.start();
  expect(report).toHaveBeenNthCalledWith(1, failure, { operation: 'roll' });
  expect(report).toHaveBeenNthCalledWith(2, failure, { operation: 'score' });
  telemetry.dispose();
  await telemetry.start();
  telemetry.reportUnexpected(new Error('after disposal'));
  expect(report).toHaveBeenCalledTimes(2);
  expect(dispose).toHaveBeenCalledOnce();
});
