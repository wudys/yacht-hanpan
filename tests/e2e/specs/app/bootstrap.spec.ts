import { expect, type Route } from '@playwright/test';

import { test } from '../../helpers/test';
import {
  BUILT_WEB_ORIGIN,
  PRODUCT_GAME_ORIGIN,
  PRODUCT_SERVER_ORIGIN,
} from '../../helpers/test-origins';
import { createTwoPlayerGame } from '../../helpers/two-player-game';

const origin = BUILT_WEB_ORIGIN;

test('reports image failure while another decode is pending and retries both resources', async ({
  page,
}) => {
  let firstFailure!: (route: Route) => void;
  const failedImage = new Promise<Route>((resolve) => {
    firstFailure = resolve;
  });
  let retry = false;
  let pendingImageRoute!: Route;
  let pendingRequests = 0;
  await page.addInitScript(() => {
    localStorage.setItem('locale', 'en');
    const { decode } = HTMLImageElement.prototype;
    HTMLImageElement.prototype.decode = function (this: HTMLImageElement) {
      if (!this.src.includes('/character/blonde-buns/original/')) return decode.call(this);
      Reflect.set(window, '__pendingResourceImage', this);
      return decode.call(this);
    };
  });
  await page.route('**/character/black-hime/original/*.png', async (route) => {
    if (retry) await route.continue();
    else firstFailure(route);
  });
  await page.route('**/character/blonde-buns/original/*.png', async (route) => {
    pendingRequests += 1;
    if (retry) {
      await route.continue();
      return;
    }
    pendingImageRoute = route;
    await (await failedImage).abort();
  });
  await page.goto(origin);
  await page.getByRole('button', { name: 'Start Game', exact: true }).click();
  await expect(page.locator('[data-resource-failure]')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            Reflect.get(window, '__pendingResourceImage') as HTMLImageElement | undefined
          )?.getAttribute('src') === null,
      ),
    )
    .toBe(true);
  // A routed request can outlive native image cancellation and must be released for retry.
  await pendingImageRoute.abort();
  retry = true;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Lobby', exact: true })).toBeVisible();
  expect(pendingRequests).toBe(2);
});

for (const resource of ['WASM', 'Lobby BGM'] as const) {
  test(`times out stalled required ${resource} and reaches Lobby with a fresh request`, async ({
    page,
  }) => {
    const pattern = resource === 'WASM' ? '**/runtime/*.wasm' : '**/audio/bgm/lobby/*.mp3';
    let attempts = 0;
    let canceled = false;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.clock.install();
    await page.addInitScript(() => localStorage.setItem('locale', 'en'));
    await page.route(pattern, async (route) => {
      if (route.request().resourceType() !== 'fetch') {
        await route.continue();
        return;
      }
      attempts += 1;
      if (attempts === 1) {
        const pending = route.request();
        page.on('requestfailed', (request) => {
          if (request === pending) canceled = true;
        });
        return;
      }
      await route.continue();
    });
    await page.goto(origin);
    await page.getByRole('button', { name: 'Start Game', exact: true }).click();
    await expect.poll(() => attempts).toBe(1);
    await expect(page.locator('[data-screen="loading"]')).toBeVisible();
    await page.clock.fastForward(60_000);
    await expect(page.locator('[data-resource-failure]')).toBeVisible();
    await expect.poll(() => canceled).toBe(true);
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Lobby', exact: true })).toBeVisible();
    expect(attempts).toBe(2);
    expect(errors).toEqual([]);
  });
}

test('missing fetch still reaches the unsupported notice instead of failing during client construction', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.addInitScript(() => localStorage.setItem('locale', 'en'));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'fetch', { value: undefined });
  });
  await page.goto(PRODUCT_GAME_ORIGIN);
  const unsupported = page.locator('[data-capability-failure="FETCH_UNAVAILABLE"]');
  await expect(unsupported).toBeVisible();
  await expect(page.getByRole('button', { name: /Start Game|게임 시작/u })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Privacy|개인정보처리방침/u })).toBeVisible();
  expect(errors).toEqual([]);
  const frame = await page.locator('.game-logical-canvas').boundingBox();
  const notice = await unsupported.boundingBox();
  expect(frame).not.toBeNull();
  expect(notice).not.toBeNull();
  expect(notice!.y + notice!.height).toBeLessThanOrEqual(frame!.y + frame!.height + 0.1);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await page.screenshot({
    path: `/tmp/hanpan-bootstrap-unsupported-en-320-${testInfo.project.name}.png`,
  });
});

test('missing WebGL2 replaces Entry before activation or heavy resource loading', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'WebGL2RenderingContext', { value: undefined });
  });
  const heavyRequests: string[] = [];
  page.on('request', (request) => {
    if (
      /\.wasm(?:\?|$)/u.test(request.url()) ||
      new URL(request.url()).origin === PRODUCT_SERVER_ORIGIN
    )
      heavyRequests.push(request.method());
  });
  await page.goto(PRODUCT_GAME_ORIGIN);
  await expect(page.locator('[data-capability-failure="WEBGL_UNAVAILABLE"]')).toBeVisible();
  await expect(page.getByRole('button', { name: /Start Game|게임 시작/u })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Privacy|개인정보처리방침/u })).toBeVisible();
  await expect(page.locator('.web-dice-canvas-host canvas')).toHaveCount(0);
  expect(heavyRequests).toEqual([]);
  const frame = await page.locator('.game-logical-canvas').boundingBox();
  const notice = await page.locator('[data-capability-failure="WEBGL_UNAVAILABLE"]').boundingBox();
  expect(frame).not.toBeNull();
  expect(notice).not.toBeNull();
  expect(notice!.y + notice!.height).toBeLessThanOrEqual(frame!.y + frame!.height + 0.1);
  await page.screenshot({
    path: `/tmp/hanpan-bootstrap-unsupported-ko-320-${testInfo.project.name}.png`,
  });
});

for (const locale of ['ko', 'en'] as const) {
  test(`Entry uses the product brand and fits the 320px frame in ${locale}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.addInitScript((value) => localStorage.setItem('locale', value), locale);
    const serverRequests: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).origin === PRODUCT_SERVER_ORIGIN)
        serverRequests.push(request.method());
    });
    await page.goto(PRODUCT_GAME_ORIGIN);
    const entry = page.locator('[data-product-view="entry"]');
    await expect(entry).toBeVisible();
    const start = entry.getByRole('button', {
      name: locale === 'ko' ? '게임 시작' : 'Start Game',
      exact: true,
    });
    await expect(start).toHaveCount(1);
    await start.focus();
    await page.keyboard.press('Enter');
    await expect(entry).toBeVisible();
    await expect(page.locator('.web-dice-canvas-host canvas')).toHaveCount(0);
    expect(serverRequests).toEqual([]);
    const images = entry.locator('img');
    await expect(images).toHaveCount(2);
    await expect
      .poll(() =>
        images.evaluateAll((nodes) =>
          nodes.every(
            (node) => node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0,
          ),
        ),
      )
      .toBe(true);
    await page.evaluate(() => document.fonts.ready);
    const frame = await page.locator('.game-logical-canvas').boundingBox();
    const view = await entry.boundingBox();
    const action = await start.boundingBox();
    expect(frame).not.toBeNull();
    expect(view).not.toBeNull();
    expect(action).not.toBeNull();
    expect(view!.height).toBeCloseTo(frame!.height, 0);
    expect(action!.x).toBeGreaterThanOrEqual(frame!.x);
    expect(action!.x + action!.width).toBeLessThanOrEqual(frame!.x + frame!.width + 0.1);
    expect(action!.y + action!.height).toBeLessThanOrEqual(frame!.y + frame!.height + 0.1);
    await start.blur();
    // Layout can be measurable before Chromium has committed the resized compositor frame.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    await page.screenshot({ path: `/tmp/hanpan-entry-${locale}-320-${testInfo.project.name}.png` });
  });

  test(`Entry retains activation failure and succeeds on a second trusted click in ${locale}`, async ({
    page,
  }, testInfo) => {
    const startLabel = locale === 'ko' ? '게임 시작' : 'Start Game';
    const serverRequests: string[] = [];
    const errors: string[] = [];
    await page.setViewportSize({ width: 320, height: 568 });
    await page.addInitScript((value) => localStorage.setItem('locale', value), locale);
    await page.addInitScript(() => {
      const { resume } = AudioContext.prototype;
      let failNext = true;
      AudioContext.prototype.resume = function (this: AudioContext) {
        if (failNext) {
          failNext = false;
          return Promise.reject(new DOMException('Activation rejected once', 'NotAllowedError'));
        }
        return Reflect.apply(resume, this, []);
      } as typeof resume;
    });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (new URL(request.url()).origin === PRODUCT_SERVER_ORIGIN)
        serverRequests.push(request.method());
    });

    await page.goto(PRODUCT_GAME_ORIGIN);
    const entry = page.locator('[data-product-view="entry"]');
    const start = entry.getByRole('button', { name: startLabel, exact: true });
    await start.click();

    await expect(entry).toBeVisible();
    await expect(entry.getByRole('alert')).toBeVisible();
    await expect(start).toBeVisible();
    await expect(start).toBeEnabled();
    await expect(page.locator('.web-dice-canvas-host canvas')).toHaveCount(0);
    expect(serverRequests).toEqual([]);
    const frame = await page.locator('.game-logical-canvas').boundingBox();
    const action = await start.boundingBox();
    expect(frame).not.toBeNull();
    expect(action).not.toBeNull();
    expect(action!.x).toBeGreaterThanOrEqual(frame!.x);
    expect(action!.x + action!.width).toBeLessThanOrEqual(frame!.x + frame!.width + 0.1);
    expect(action!.y + action!.height).toBeLessThanOrEqual(frame!.y + frame!.height + 0.1);
    await page.screenshot({
      path: `/tmp/hanpan-entry-activation-failure-${locale}-320-${testInfo.project.name}.png`,
    });

    await start.click();
    await expect(page.locator('[data-dice-canvas-state]')).toHaveAttribute(
      'data-dice-canvas-state',
      'ready',
    );
    await expect(page.locator('[data-product-view="lobby"]')).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('development Strict Mode retains a live renderer after effect replay cleanup', async ({
  page,
}) => {
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작' }).click();
  await expect(page.locator('[data-dice-canvas-state]')).toHaveAttribute(
    'data-dice-canvas-state',
    'ready',
  );
  const contextLost = await page.locator('.web-dice-canvas-host canvas').evaluate(async (node) => {
    const canvas = node as HTMLCanvasElement;
    // R3F disposal is delayed 500 ms; inspect after that actual cleanup boundary.
    await new Promise<void>((resolve) => setTimeout(resolve, 650));
    return canvas.getContext('webgl2')?.isContextLost() ?? true;
  });
  expect(contextLost).toBe(false);
});

test('reports renderer construction failure instead of leaving Loading pending', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const { getContext } = HTMLCanvasElement.prototype;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      contextId: string,
      ...options: unknown[]
    ) {
      if (contextId === 'webgl2') return null;
      return Reflect.apply(getContext, this, [contextId, ...options]);
    } as typeof getContext;
    window.addEventListener(
      'restore-webgl',
      () => {
        HTMLCanvasElement.prototype.getContext = getContext;
      },
      { once: true },
    );
  });
  await page.goto(origin);
  await page.getByRole('button', { name: '게임 시작' }).click();
  await expect(page.locator('[data-resource-failure]')).toBeVisible();
  await expect(page.getByRole('button', { name: '다시 시도', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '로비', exact: true })).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('restore-webgl')));
  await page.getByRole('button', { name: '다시 시도', exact: true }).click();
  await expect(page.locator('[data-dice-canvas-state]')).toHaveAttribute(
    'data-dice-canvas-state',
    'ready',
  );
  expect(errors).toEqual([]);
});

test('retains the prepared Canvas through real admission, game completion, and the next match', async ({
  page,
  browser,
}) => {
  test.setTimeout(60_000);
  await page.goto(PRODUCT_GAME_ORIGIN);
  await expect(page.getByRole('button', { name: '게임 시작' })).toBeVisible();
  await expect(page.locator('.web-dice-canvas-host canvas')).toHaveCount(0);
  await page.getByRole('button', { name: '게임 시작' }).click();
  await expect(page.locator('[data-dice-canvas-state]')).toHaveAttribute(
    'data-dice-canvas-state',
    'ready',
  );
  await expect(page.getByRole('heading', { name: '로비', exact: true })).toBeVisible();
  const canvas = await page.locator('.web-dice-canvas-host canvas').elementHandle();
  expect(canvas).not.toBeNull();
  const guestContext = await createTwoPlayerGame(page, browser);
  try {
    expect(await canvas!.evaluate((node) => node.isConnected)).toBe(true);
    await page.getByRole('button', { name: '설정', exact: true }).click();
    await page.getByRole('button', { name: '기권하기', exact: true }).click();
    await expect(page.locator('[data-game-view="result"]')).toBeVisible();
    await page.getByRole('button', { name: '로비로 돌아가기', exact: true }).click();
    await expect(page.getByRole('heading', { name: '로비', exact: true })).toBeVisible();
    await expect(page.locator('.web-dice-canvas-host canvas')).toHaveCount(1);
    expect(await canvas!.evaluate((node) => node.isConnected)).toBe(true);
    expect(new URL(page.url()).pathname).toBe('/');
  } finally {
    await guestContext.close();
  }

  const nextGuestContext = await createTwoPlayerGame(page, browser);
  try {
    await expect(page.locator('[data-screen="game"]')).toBeVisible();
    await expect(page.locator('.web-dice-canvas-host canvas')).toHaveCount(1);
    expect(await canvas!.evaluate((node) => node.isConnected)).toBe(true);
  } finally {
    await nextGuestContext.close();
  }
});

test('reaches Lobby when browser storage itself is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new DOMException('Storage unavailable', 'SecurityError');
      },
    });
  });
  await page.goto(origin);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  await expect(page.getByRole('heading', { name: '로비', exact: true })).toBeVisible();
});

test('retries failed required WASM preparation before warming the renderer', async ({
  page,
}, testInfo) => {
  let failNext = true;
  await page.setViewportSize({ width: 320, height: 568 });
  await page.addInitScript(() => localStorage.setItem('locale', 'en'));
  await page.route('**/runtime/*.wasm', async (route) => {
    if (failNext) {
      failNext = false;
      await route.abort();
    } else await route.continue();
  });
  await page.goto(origin);
  await page.getByRole('button', { name: 'Start Game', exact: true }).click();
  await expect(page.locator('[data-resource-failure]')).toBeVisible();
  await expect(page.locator('.web-dice-canvas-host canvas')).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toBeVisible();
  const images = page.locator('[data-game-logical-canvas] img');
  await expect(images).toHaveCount(2);
  await expect
    .poll(() =>
      images.evaluateAll((nodes) =>
        nodes.every(
          (node) => node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0,
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(() => document.fonts.ready);
  const frame = await page.locator('.game-logical-canvas').boundingBox();
  const failure = await page.getByRole('alertdialog').boundingBox();
  expect(frame).not.toBeNull();
  expect(failure).not.toBeNull();
  expect(failure!.y + failure!.height).toBeLessThanOrEqual(frame!.y + frame!.height + 0.1);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await page.screenshot({
    path: `/tmp/hanpan-bootstrap-loading-failure-en-320-${testInfo.project.name}.png`,
  });
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.locator('[data-dice-canvas-state]')).toHaveAttribute(
    'data-dice-canvas-state',
    'ready',
  );
  await expect(page.getByRole('heading', { name: 'Lobby', exact: true })).toBeVisible();
});
