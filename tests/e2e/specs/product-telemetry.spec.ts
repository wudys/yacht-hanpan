import { expect, type Page } from '@playwright/test';

import { joinProductGame, PRODUCT_GAME_ORIGIN } from '../helpers/product-game';
import { test } from '../helpers/test';

const canary = 'PRIVATE_BROWSER_CANARY';
const faultsPath = '/assets/telemetry-faults.js';
const fakeDsn = 'https://public@o1.ingest.sentry.io/1';

type Diagnostic = Readonly<{
  exception?: Readonly<{
    values?: readonly Readonly<{
      type?: string;
      mechanism?: Readonly<{ handled?: boolean }>;
      stacktrace?: Readonly<{ frames?: readonly Readonly<{ filename?: string }>[] }>;
    }>[];
  }>;
}>;

async function interceptTelemetry(
  page: Page,
  failTransport: boolean = false,
): Promise<{
  events: Diagnostic[];
  raw: string[];
}> {
  const events: Diagnostic[] = [];
  const raw: string[] = [];
  await page.route('https://www.googletagmanager.com/gtag/js?*', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  await page.route('https://*.sentry.io/**', async (route) => {
    const body = route.request().postData();
    if (body) {
      raw.push(body);
      const lines = body.split('\n');
      for (let i = 1; i + 1 < lines.length; i += 2) {
        const header: unknown = JSON.parse(lines[i]!);
        if (header && typeof header === 'object' && Reflect.get(header, 'type') === 'event') {
          events.push(JSON.parse(lines[i + 1]!) as Diagnostic);
        }
      }
    }
    if (failTransport) {
      await route.abort('failed');
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: '{}',
    });
  });
  await page.route(`**${faultsPath}?*`, (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `
        function failTimer() {
          throw new TypeError('${canary}', { cause: new RangeError('${canary}') });
        }
        setTimeout(failTimer, 0);
        setTimeout(failTimer, 20);
        setTimeout(() => Promise.reject(new RangeError('${canary}')), 40);
      `,
    }),
  );
  return { events, raw };
}

async function enableTestCollector(page: Page, measurementId: string | null = null): Promise<void> {
  // Intercept only the test document's config module; product environment gates stay intact.
  await page.route('**/src/runtime/telemetry/telemetry-config.ts*', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `
        export function readTelemetryConfig() {
          return { enabled: true, origin: location.origin, measurementId: ${JSON.stringify(measurementId)}, sentryDsn: '${fakeDsn}' };
        }
      `,
    }),
  );
}

test('collects real global failures and independent repeats without private data', async ({
  page,
}) => {
  const { events, raw } = await interceptTelemetry(page);
  await enableTestCollector(page);
  await page.goto(`${PRODUCT_GAME_ORIGIN}/?${canary}`);
  await expect(page.getByRole('button', { name: '게임 시작', exact: true })).toBeVisible();
  await page.addScriptTag({ url: `${PRODUCT_GAME_ORIGIN}${faultsPath}?${canary}` });
  await expect.poll(() => events.length).toBe(3);
  const values = events.flatMap((event) => event.exception?.values ?? []);
  expect(values.filter((value) => value.type === 'TypeError')).toHaveLength(2);
  expect(values.filter((value) => value.type === 'RangeError')).toHaveLength(3);
  expect(values.filter((value) => value.type === 'TypeError')).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ mechanism: expect.objectContaining({ handled: false }) }),
    ]),
  );
  expect(
    values
      .flatMap((value) => value.stacktrace?.frames ?? [])
      .some((frame) => frame.filename?.includes(faultsPath)),
  ).toBe(true);
  expect(raw.join('\n')).not.toContain(canary);
  await expect(page.getByRole('button', { name: '게임 시작', exact: true })).toBeEnabled();
});

test('keeps default dev collection off for actual global failures', async ({ page }) => {
  const { events } = await interceptTelemetry(page);
  await page.goto(PRODUCT_GAME_ORIGIN);
  await expect(page.getByRole('button', { name: '게임 시작', exact: true })).toBeVisible();
  await page.addScriptTag({ url: `${PRODUCT_GAME_ORIGIN}${faultsPath}?${canary}` });
  await expect(page.getByRole('button', { name: '게임 시작', exact: true })).toBeEnabled();
  await page.waitForTimeout(100);
  expect(events).toEqual([]);
});

for (const boundary of ['module', 'react'] as const) {
  test(`collects an early ${boundary} error after initialization without duplicating it`, async ({
    page,
  }) => {
    const { events, raw } = await interceptTelemetry(page);
    await enableTestCollector(page);
    const asset = `/assets/telemetry-${boundary}-failure.js`;
    await page.route(`**${asset}`, (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body:
          boundary === 'module'
            ? `throw new TypeError('${canary}', { cause: new RangeError('${canary}') });`
            : `export function AppShell() { throw new TypeError('${canary}', { cause: new RangeError('${canary}') }); }`,
      }),
    );
    await page.route(
      boundary === 'module' ? '**/src/app/start-web-app.tsx*' : '**/src/app/AppShell.tsx*',
      (route) =>
        route.fulfill({
          contentType: 'application/javascript',
          body:
            boundary === 'module' ? `import '${asset}';` : `export { AppShell } from '${asset}';`,
        }),
    );
    await page.goto(`${PRODUCT_GAME_ORIGIN}/?${canary}`);
    await expect.poll(() => events.length).toBe(1);
    const values = events.flatMap((event) => event.exception?.values ?? []);
    expect(values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'TypeError' }),
        expect.objectContaining({ type: 'RangeError' }),
      ]),
    );
    expect(
      values
        .flatMap((value) => value.stacktrace?.frames ?? [])
        .some((frame) => frame.filename?.endsWith(asset)),
    ).toBe(true);
    expect(raw.join('\n')).not.toContain(canary);
  });
}

test('keeps entry and resource preparation usable when diagnostic transport fails', async ({
  page,
}) => {
  const { events } = await interceptTelemetry(page, true);
  await enableTestCollector(page);
  await page.goto(PRODUCT_GAME_ORIGIN);
  await expect(page.getByRole('button', { name: '게임 시작', exact: true })).toBeVisible();
  await page.addScriptTag({ url: `${PRODUCT_GAME_ORIGIN}${faultsPath}?${canary}` });
  await expect.poll(() => events.length).toBe(3);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  await expect(page.getByRole('heading', { name: '로비', exact: true })).toBeVisible();
});

type TagCall = readonly [string, string, Readonly<Record<string, unknown>>];

async function readTagCalls(page: Page): Promise<readonly TagCall[]> {
  return page.evaluate(() => Reflect.get(window, '__hanpanTestTagCalls') as readonly TagCall[]);
}

function tagEvents(
  calls: readonly TagCall[],
  name: string,
): readonly Readonly<Record<string, unknown>>[] {
  return calls
    .filter(([command, event]) => command === 'event' && event === name)
    .map((call) => call[2]);
}

for (const entry of ['new', 'resumed'] as const) {
  test(`records ${entry} participation and one recovery outcome through the actual product`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(60_000);
    const { events, raw } = await interceptTelemetry(page);
    await enableTestCollector(page, 'G-TEST123');
    await page.addInitScript(() => {
      const calls: unknown[][] = [];
      Reflect.set(window, '__hanpanTestTagCalls', calls);
      Reflect.set(window, 'hanpanGtag', (...args: unknown[]) => calls.push(args));
    });
    await page.goto(`${PRODUCT_GAME_ORIGIN}/?${canary}`);
    await page.getByRole('button', { name: '게임 시작', exact: true }).click();
    const guestContext = await joinProductGame(page, browser);
    try {
      const operation = entry === 'new' ? 'connection' : 'reentry';
      if (entry === 'resumed') {
        await page.reload();
        await page.getByRole('button', { name: '게임 시작', exact: true }).click();
        await expect(page.locator('[data-screen="game"]')).toBeVisible();
      } else {
        await page.context().setOffline(true);
        await expect(page.locator('[data-game-interaction-surface]')).toHaveAttribute('inert', '');
        await expect
          .poll(async () => tagEvents(await readTagCalls(page), 'recovery_started').length)
          .toBe(1);
        await page.context().setOffline(false);
      }
      await expect
        .poll(async () =>
          tagEvents(await readTagCalls(page), 'recovery_result').map((event) => [
            event.operation,
            event.outcome,
          ]),
        )
        .toEqual([[operation, 'success']]);
      await expect(page.locator('[data-game-interaction-surface]')).not.toHaveAttribute(
        'inert',
        '',
      );
      await page.getByRole('button', { name: '설정', exact: true }).click();
      await page.getByRole('button', { name: '기권하기', exact: true }).click();
      await expect(page.locator('[data-product-view="result"]')).toBeVisible();
      const calls = await readTagCalls(page);
      expect(tagEvents(calls, 'play_started')).toEqual([expect.objectContaining({ entry })]);
      expect(tagEvents(calls, 'play_finished')).toEqual([
        expect.objectContaining({ entry, reason: 'forfeit', outcome: 'loss' }),
      ]);
      expect(tagEvents(calls, 'recovery_started')).toEqual([
        expect.objectContaining({ operation }),
      ]);
      const views = tagEvents(calls, 'page_view');
      expect(views.map((event) => event.screen)).toEqual([
        'entry',
        'loading',
        'lobby',
        'game',
        'result',
      ]);
      views.forEach((view, index) => {
        expect(view.page_location).toBe(`${PRODUCT_GAME_ORIGIN}/${String(view.screen)}`);
        expect(view.page_referrer).toBe(index === 0 ? '' : views[index - 1]?.page_location);
      });
      expect(calls.filter(([command]) => command === 'config')).toHaveLength(views.length);
      expect(JSON.stringify(calls) + raw.join('\n')).not.toContain(canary);
      expect(events).toEqual([]);
    } finally {
      await page.context().setOffline(false);
      await guestContext.close();
    }
  });
}
