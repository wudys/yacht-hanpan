// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  order: [] as string[],
  enabled: true,
  createErrors: vi.fn(),
  report: vi.fn(),
  dispose: vi.fn(),
  stopWebApp: vi.fn(),
  startWebApp: vi.fn(),
  loadDiagnosticsModule: vi.fn(),
  loadProductModule: vi.fn(),
}));
vi.mock('@/runtime/telemetry/telemetry-config', () => ({
  readTelemetryConfig: () => ({
    enabled: fixture.enabled,
    origin: 'https://yacht.example.com',
    measurementId: null,
    sentryDsn: 'https://public@o1.ingest.sentry.io/1',
  }),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.order.length = 0;
  fixture.enabled = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.localStorage.clear();
  fixture.dispose.mockImplementation(() => fixture.order.push('close diagnostics'));
  fixture.stopWebApp.mockImplementation(() => fixture.order.push('stop product'));
  fixture.createErrors.mockImplementation(() => {
    fixture.order.push('initialize diagnostics');
    return { reportUnexpected: fixture.report, dispose: fixture.dispose };
  });
  fixture.startWebApp.mockImplementation(() => {
    fixture.order.push('start product');
    return fixture.stopWebApp;
  });
  fixture.loadDiagnosticsModule.mockImplementation(() => {
    fixture.order.push('sentry module');
    return { createSentryErrors: fixture.createErrors };
  });
  vi.doMock('@/runtime/telemetry/sentry', () => fixture.loadDiagnosticsModule());
  fixture.loadProductModule.mockImplementation(() => {
    fixture.order.push('product module');
    return { startWebApp: fixture.startWebApp };
  });
  vi.doMock('@/app/start-web-app', () => fixture.loadProductModule());
});
afterEach(() => {
  window.dispatchEvent(new PageTransitionEvent('pagehide'));
  vi.useRealTimers();
});

it('initializes diagnostics before evaluating the product module', async () => {
  await import('@/main');
  await vi.waitFor(() => expect(fixture.startWebApp).toHaveBeenCalledOnce());
  expect(fixture.order).toEqual([
    'sentry module',
    'initialize diagnostics',
    'product module',
    'start product',
  ]);
});

it('keeps disabled collection outside the SDK initialization path', async () => {
  fixture.enabled = false;
  await import('@/main');
  await vi.waitFor(() => expect(fixture.startWebApp).toHaveBeenCalledOnce());
  expect(fixture.createErrors).not.toHaveBeenCalled();
  expect(fixture.order).toEqual(['product module', 'start product']);
});

it('starts the product when diagnostic initialization throws', async () => {
  fixture.createErrors.mockImplementation(() => {
    throw new Error('diagnostic initialization failed');
  });
  await import('@/main');
  await vi.waitFor(() => expect(fixture.startWebApp).toHaveBeenCalledOnce());
  expect(fixture.report).not.toHaveBeenCalled();
});

it('reports the original product startup exception without making a new rejection', async () => {
  const error = new TypeError('startup failure');
  fixture.startWebApp.mockImplementation(() => {
    throw error;
  });
  await import('@/main');
  await vi.waitFor(() =>
    expect(fixture.report).toHaveBeenCalledExactlyOnceWith(error, { stage: 'modules' }),
  );
  expect(document.querySelector('h1')?.textContent).toBe('불러오기 실패');
});

it('retains BFCache runtimes and stops product observers before closing diagnostics once', async () => {
  await import('@/main');
  await vi.waitFor(() => expect(fixture.startWebApp).toHaveBeenCalledOnce());
  fixture.order.length = 0;
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  expect(fixture.stopWebApp).not.toHaveBeenCalled();
  expect(fixture.dispose).not.toHaveBeenCalled();
  window.dispatchEvent(new PageTransitionEvent('pagehide'));
  window.dispatchEvent(new PageTransitionEvent('pagehide'));
  expect(fixture.order).toEqual(['stop product', 'close diagnostics']);
});

it('closes a collector completed after page exit without starting product execution', async () => {
  const sink = { reportUnexpected: fixture.report, dispose: fixture.dispose };
  fixture.createErrors.mockImplementation(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    return sink;
  });
  await import('@/main');
  await vi.waitFor(() => expect(fixture.dispose).toHaveBeenCalledOnce());
  expect(fixture.startWebApp).not.toHaveBeenCalled();
});

it('ignores a product module rejection after page exit', async () => {
  fixture.loadProductModule.mockImplementation(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    throw new TypeError('late module failure');
  });
  await import('@/main');
  await vi.waitFor(() => expect(fixture.dispose).toHaveBeenCalledOnce());
  expect(fixture.startWebApp).not.toHaveBeenCalled();
  expect(fixture.report).not.toHaveBeenCalled();
  expect(document.querySelector('[data-startup-failure]')).toBeNull();
});

it.each(['resolve', 'reject'] as const)(
  'starts after stalled diagnostics and ignores their late %s',
  async (completion) => {
    vi.useFakeTimers();
    let completeDiagnostics!: (value: { createSentryErrors: typeof fixture.createErrors }) => void;
    let failDiagnostics!: (error: Error) => void;
    fixture.loadDiagnosticsModule.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          completeDiagnostics = resolve;
          failDiagnostics = reject;
        }),
    );
    await import('@/main');
    await vi.waitFor(() => expect(fixture.startWebApp).toHaveBeenCalledOnce(), { timeout: 1500 });
    expect(fixture.createErrors).not.toHaveBeenCalled();
    if (completion === 'resolve') completeDiagnostics({ createSentryErrors: fixture.createErrors });
    else failDiagnostics(new Error('late diagnostic failure'));
    await vi.dynamicImportSettled();
    expect(fixture.startWebApp).toHaveBeenCalledOnce();
    expect(fixture.createErrors).not.toHaveBeenCalled();
    expect(fixture.report).not.toHaveBeenCalled();
  },
);

it('cancels diagnostic waiting on page exit without installing a late collector', async () => {
  vi.useFakeTimers();
  let completeDiagnostics!: (value: { createSentryErrors: typeof fixture.createErrors }) => void;
  fixture.loadDiagnosticsModule.mockImplementation(
    () =>
      new Promise((resolve) => {
        completeDiagnostics = resolve;
      }),
  );
  await import('@/main');
  await vi.waitFor(() => expect(completeDiagnostics).toBeTypeOf('function'));
  window.dispatchEvent(new PageTransitionEvent('pagehide'));
  expect(vi.getTimerCount()).toBe(0);
  completeDiagnostics({ createSentryErrors: fixture.createErrors });
  await vi.dynamicImportSettled();
  expect(fixture.createErrors).not.toHaveBeenCalled();
  expect(fixture.startWebApp).not.toHaveBeenCalled();
  expect(document.querySelector('[data-startup-failure]')).toBeNull();
});

it.each([
  ['ko', '불러오기 실패', '새로고침'],
  ['en', 'Loading failed', 'Refresh'],
] as const)(
  'shows a localized recovery action after product import failure in %s',
  async (locale, title, action) => {
    window.localStorage.setItem('locale', locale);
    const error = new TypeError('private module details');
    fixture.loadProductModule.mockRejectedValue(error);
    await import('@/main');
    await vi.waitFor(() => expect(document.querySelector('h1')?.textContent).toBe(title));
    const button = document.querySelector('button');
    expect(button?.textContent).toBe(action);
    expect(document.body.textContent).not.toContain(error.message);
    expect(fixture.report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ cause: error }),
      { stage: 'modules' },
    );
    expect(fixture.startWebApp).not.toHaveBeenCalled();
  },
);
