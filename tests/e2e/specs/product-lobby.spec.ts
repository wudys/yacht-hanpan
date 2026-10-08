import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { parseRoomHttpEnvelope } from '@repo/game-protocol/http';
import { GAME_PROTOCOL_VERSION } from '@repo/game-protocol/version';

import { PRODUCT_GAME_ORIGIN } from '../helpers/product-game';
import { test } from '../helpers/test';

// Scaled child and layout slot rectangles use different subpixel rounding.
const RECT_ROUNDING = 0.1;

type RoomFault =
  | Readonly<{
      status: 404;
      error: Readonly<{ code: 'ROOM_NOT_FOUND'; params: Readonly<Record<string, never>> }>;
    }>
  | Readonly<{
      status: 429;
      error: Readonly<{ code: 'RATE_LIMITED'; params: Readonly<{ retryAfterMs: number }> }>;
    }>
  | Readonly<{
      status: 500;
      error: Readonly<{ code: 'INTERNAL_ERROR'; params: Readonly<Record<string, never>> }>;
    }>;

async function fulfillRoomFault(route: Route, fault: RoomFault): Promise<void> {
  await route.fulfill({
    status: fault.status,
    contentType: 'application/json',
    json: {
      ok: false,
      error: fault.error,
      meta: {
        requestId: globalThis.crypto.randomUUID(),
        gameProtocolVersion: GAME_PROTOCOL_VERSION,
      },
    },
  });
}

async function enterLobby(page: Page, locale: 'ko' | 'en' = 'ko'): Promise<void> {
  await page.addInitScript((value) => localStorage.setItem('locale', value), locale);
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page
    .getByRole('button', { name: locale === 'ko' ? '게임 시작' : 'Start Game', exact: true })
    .click();
  await expect(page.locator('[data-screen="lobby"]')).toBeVisible();
}

async function brandBounds(page: Page) {
  return page.locator('.lobby-view__brand img').evaluateAll((images) =>
    images.map((image) => {
      const { x, y, width, height } = image.getBoundingClientRect();
      return { x, y, width, height };
    }),
  );
}

test('Lobby stops unavailable server preparation within 20 seconds and can retry', async ({
  page,
}) => {
  test.setTimeout(45_000);
  let createRequests = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/rooms') {
      createRequests += 1;
    }
  });
  await page.route('**/health/ready', (route) => route.abort('connectionrefused'));
  await enterLobby(page);
  await page.getByRole('button', { name: '게임 만들기', exact: true }).click();
  await expect(page.getByRole('button', { name: '서버 응답을 기다리는 중' })).toBeVisible();

  const close = page.getByRole('button', { name: '닫기', exact: true });
  await expect(close).toBeVisible({ timeout: 22_000 });
  await expect(page.getByText('네트워크 연결을 확인해 주세요.', { exact: true })).toBeVisible();
  expect(createRequests).toBe(0);
  await page.screenshot({
    path: `/tmp/hanpan-lobby-ready-timeout-${test.info().project.name}.png`,
  });

  await page.unroute('**/health/ready');
  await close.click();
  await page.getByRole('button', { name: '게임 만들기', exact: true }).click();
  await expect(page.locator('.web-lobby-room-code')).toHaveText(/^\d{6}$/u);
  expect(createRequests).toBe(1);
  await page.getByRole('button', { name: '대기 취소', exact: true }).click();
  await expect(page.locator('.web-lobby-room-code')).toHaveCount(0);
});

for (const locale of ['ko', 'en'] as const) {
  test(`creation failure closes before a new lobby creation in ${locale}`, async ({ page }) => {
    const requests: { operationId: string }[] = [];
    await page.route('**/rooms', async (route) => {
      requests.push(route.request().postDataJSON().body);
      await route.abort('connectionfailed');
    });
    await page.setViewportSize({ width: 320, height: 568 });
    await enterLobby(page, locale);
    const homeBrand = await brandBounds(page);
    await page
      .getByRole('button', { name: locale === 'ko' ? '게임 만들기' : 'Create Game', exact: true })
      .click();
    const notice = page.getByRole('alertdialog');
    const close = notice.getByRole('button', {
      name: locale === 'ko' ? '닫기' : 'Close',
      exact: true,
    });
    await expect(notice.getByRole('button')).toHaveCount(1);
    await expect(close).toBeVisible();
    expect(await brandBounds(page)).toEqual(homeBrand);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    await page.screenshot({ path: test.info().outputPath(`create-failed-${locale}.png`) });
    await close.click();
    await expect(notice).not.toBeVisible();
    expect(requests).toHaveLength(2);
    await page
      .getByRole('button', { name: locale === 'ko' ? '게임 만들기' : 'Create Game', exact: true })
      .click();
    await expect(close).toBeVisible();
    await expect.poll(() => requests.length).toBe(4);
    expect(requests[2]).toEqual(requests[3]);
    expect(requests[0]?.operationId).not.toBe(requests[2]?.operationId);
  });
}

for (const locale of ['ko', 'en'] as const) {
  test(`real Lobby and room code layer fit 320px with ${locale} assets and browser input`, async ({
    browserName,
    context,
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.addInitScript((value) => localStorage.setItem('locale', value), locale);
    await page.goto(PRODUCT_GAME_ORIGIN);
    await page
      .getByRole('button', { name: locale === 'ko' ? '게임 시작' : 'Start Game', exact: true })
      .click();
    const lobby = page.locator('[data-screen="lobby"]');
    await expect(lobby).toBeVisible();
    const frame = await page.locator('[data-game-frame-slot]').boundingBox();
    const lobbyView = await page.locator('[data-product-view="lobby"]').boundingBox();
    expect(frame).not.toBeNull();
    expect(lobbyView).not.toBeNull();
    expect(lobbyView!.x).toBeGreaterThanOrEqual(frame!.x);
    expect(lobbyView!.y).toBeGreaterThanOrEqual(frame!.y);
    expect(lobbyView!.x + lobbyView!.width).toBeLessThanOrEqual(
      frame!.x + frame!.width + RECT_ROUNDING,
    );
    expect(lobbyView!.y + lobbyView!.height).toBeLessThanOrEqual(
      frame!.y + frame!.height + RECT_ROUNDING,
    );
    await page.screenshot({
      path: `/tmp/hanpan-lobby-${locale}-320-${test.info().project.name}.png`,
    });
    const background = page.locator('[data-product-view="lobby"]');
    await page.locator('[data-room-action="join"] button').click();
    await expect(background).toHaveAttribute('inert', '');
    const backgroundSettings = background.getByRole('button', {
      name: locale === 'ko' ? '설정' : 'Settings',
      exact: true,
      includeHidden: true,
    });
    await backgroundSettings.evaluate((button: HTMLButtonElement) => button.focus());
    expect(await backgroundSettings.evaluate((button) => document.activeElement === button)).toBe(
      false,
    );
    const code = page.getByRole('textbox');
    const surface = page.locator('.scrollable-panel');
    const submit = surface.getByRole('button', {
      name: locale === 'ko' ? '참가하기' : 'Join',
      exact: true,
    });
    await expect(code).toHaveValue('');
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(surface.getByRole('alert')).toBeVisible();
    await code.click();
    await expect(code).toBeFocused();
    await expect(surface.getByRole('alert')).toHaveCount(0);
    const cells = surface.locator('.web-lobby-code-cells span');
    const cellBounds = await cells.evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().toJSON()),
    );
    await code.focus();
    for (const digit of '000123') {
      await code.press(digit);
      expect(
        await cells.evaluateAll((nodes) =>
          nodes.map((node) => node.getBoundingClientRect().toJSON()),
        ),
      ).toEqual(cellBounds);
    }
    for (let index = 0; index < 6; index++) {
      await code.press('Backspace');
      expect(
        await cells.evaluateAll((nodes) =>
          nodes.map((node) => node.getBoundingClientRect().toJSON()),
        ),
      ).toEqual(cellBounds);
    }
    await code.focus();
    if (locale === 'en' && browserName === 'chromium') {
      await test.step('system clipboard paste normalizes to six digits', async () => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
          origin: PRODUCT_GAME_ORIGIN,
        });
        await page.evaluate(() => navigator.clipboard.writeText('room: 000123 9'));
        await page.keyboard.press('ControlOrMeta+V');
      });
    } else await page.keyboard.type('000123');
    await expect(code).toHaveValue('000123');
    let previousOffset = 6;
    for (const offset of [2, 5, 6]) {
      for (let step = 0; step < Math.abs(offset - previousOffset); step++) {
        await code.press(offset < previousOffset ? 'ArrowLeft' : 'ArrowRight');
      }
      previousOffset = offset;
      await expect
        .poll(() => code.evaluate((node) => (node as HTMLInputElement).selectionStart))
        .toBe(offset);
      const activeCell = page.locator('.web-lobby-code-cells [data-active-cell="true"]');
      await expect(activeCell).toHaveCount(1);
      await expect
        .poll(() =>
          activeCell.evaluate((node, end) => {
            const marker = getComputedStyle(node, '::after');
            return end ? marker.right : marker.left;
          }, offset === 6),
        )
        .toBe('5px');
    }
    const dimensions = await surface.evaluate((node) => ({
      width: node.clientWidth,
      scrollWidth: node.scrollWidth,
      height: node.clientHeight,
      scrollHeight: node.scrollHeight,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width);
    expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.height);
    const panel = await surface.boundingBox();
    const submitBounds = await submit.boundingBox();
    expect(frame).not.toBeNull();
    expect(panel).not.toBeNull();
    expect(submitBounds).not.toBeNull();
    expect(panel!.x).toBeGreaterThanOrEqual(frame!.x);
    expect(panel!.y).toBeGreaterThanOrEqual(frame!.y);
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(frame!.x + frame!.width + RECT_ROUNDING);
    expect(panel!.y + panel!.height).toBeLessThanOrEqual(frame!.y + frame!.height + RECT_ROUNDING);
    expect(submitBounds!.y + submitBounds!.height).toBeLessThanOrEqual(
      frame!.y + frame!.height + RECT_ROUNDING,
    );
    expect(
      panel!.y + panel!.height - submitBounds!.y - submitBounds!.height,
    ).toBeGreaterThanOrEqual(10);
    expect(submitBounds!.x - panel!.x).toBeGreaterThanOrEqual(14);
    expect(submitBounds!.height / (frame!.width / 360)).toBeGreaterThanOrEqual(43.9);
    await page.screenshot({
      path: `/tmp/hanpan-join-${locale}-320-${test.info().project.name}.png`,
    });
    await page.setViewportSize({ width: 1440, height: 950 });
    await page.screenshot({
      path: `/tmp/hanpan-join-${locale}-desktop-${test.info().project.name}.png`,
    });
    await surface
      .getByRole('button', { name: locale === 'ko' ? '닫기' : 'Close', exact: true })
      .click();
    await expect(surface).toHaveCount(0);
    await expect(background).not.toHaveAttribute('inert', '');
    await backgroundSettings.click();
    await expect(
      page.getByRole('switch', { name: locale === 'ko' ? '배경음' : 'Music', exact: true }),
    ).toBeVisible();
  });
}

test('join not-found stays inline with the submitted code and Lobby route', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 740 });
  let releaseJoin!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseJoin = resolve;
  });
  await page.route(/\/rooms\/000123\/join$/u, async (route) => {
    await gate;
    await fulfillRoomFault(route, {
      status: 404,
      error: { code: 'ROOM_NOT_FOUND', params: {} },
    });
  });

  await enterLobby(page);
  const homeBrand = await brandBounds(page);
  await page.locator('[data-room-action="join"] button').click();
  const input = page.getByRole('textbox');
  await input.fill('000123');
  const initialPanel = await page.locator('.scrollable-panel').boundingBox();
  const initialSubmit = await page
    .getByRole('button', { name: '참가하기', exact: true })
    .boundingBox();
  await page.getByRole('button', { name: '참가하기', exact: true }).click();
  try {
    await expect(page.locator('[data-lobby-view="joining"]')).toBeVisible();
    expect(await brandBounds(page)).toEqual(homeBrand);
  } finally {
    releaseJoin();
  }

  await expect(page.locator('[data-lobby-view="joinRoom"]')).toBeVisible();
  await expect(page.getByRole('alert')).not.toBeEmpty();
  await expect(input).toHaveValue('000123');
  expect(await page.locator('.scrollable-panel').boundingBox()).toEqual(initialPanel);
  expect(await page.getByRole('button', { name: '참가하기', exact: true }).boundingBox()).toEqual(
    initialSubmit,
  );
  await expect(page.locator('[data-screen="lobby"]')).toBeVisible();
  await expect(page.locator('[data-screen="game"]')).toHaveCount(0);
  const previousError = await page.getByRole('alert').textContent();
  let releaseRetry!: () => void;
  const retryGate = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  await page.route(/\/rooms\/000123\/join$/u, async (route) => {
    await retryGate;
    await fulfillRoomFault(route, { status: 404, error: { code: 'ROOM_NOT_FOUND', params: {} } });
  });
  await page.getByRole('button', { name: '참가하기', exact: true }).click();
  try {
    await expect(page.locator('[data-lobby-view="joining"]')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveText(previousError!);
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(input).toHaveJSProperty('readOnly', true);
    await expect(input).toBeEnabled();
    expect(await page.locator('.scrollable-panel').boundingBox()).toEqual(initialPanel);
  } finally {
    releaseRetry();
  }
  await expect(page.locator('[data-lobby-view="joinRoom"]')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText(previousError!);
  await page.screenshot({
    path: `/tmp/hanpan-lobby-join-not-found-ko-${testInfo.project.name}.png`,
  });
});

for (const locale of ['ko', 'en'] as const) {
  test(`waiting room preserves the flat loader and code hierarchy in ${locale}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await enterLobby(page, locale);
    await page.locator('[data-room-action="create"] button').click();
    const layer = page.locator('[data-lobby-layer="waiting"]');
    await expect(layer.locator('[data-room-code]')).toBeVisible();
    await expect(layer.locator('.web-lobby-countdown')).toHaveText(/^\d{2}:\d{2}$/u);
    await expect(layer.locator('.dice-loader__die').first()).toBeVisible();
    for (const die of await layer.locator('.dice-loader__die').all()) {
      await expect(die).toHaveCSS('box-shadow', 'none');
    }
    const label = await layer.locator('.web-lobby-room-code-label').boundingBox();
    const countdown = await layer.locator('.web-lobby-countdown').boundingBox();
    const codeBox = await layer.locator('.web-lobby-room-code').boundingBox();
    expect(label!.y + label!.height).toBeLessThan(codeBox!.y);
    expect(
      Math.abs(label!.y + label!.height / 2 - (countdown!.y + countdown!.height / 2)),
    ).toBeLessThan(1);
    await expect(layer.locator('.web-lobby-countdown')).toHaveCSS('border-top-width', '0px');
    const body = layer.locator('.scrollable-panel__body');
    expect(await body.evaluate((node) => node.scrollHeight <= node.clientHeight)).toBe(true);
    await page.screenshot({
      path: `/tmp/hanpan-waiting-${locale}-320-${test.info().project.name}.png`,
    });
    await page.setViewportSize({ width: 1440, height: 950 });
    await page.screenshot({
      path: `/tmp/hanpan-waiting-${locale}-desktop-${test.info().project.name}.png`,
    });
    await page
      .getByRole('button', {
        name: locale === 'ko' ? '대기 취소' : 'Cancel',
        exact: true,
      })
      .click();
  });
}

for (const locale of ['ko', 'en'] as const) {
  test(`create rate limit offers only acknowledgement without seconds in ${locale}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.route(/\/rooms$/u, async (route) => {
      await fulfillRoomFault(route, {
        status: 429,
        error: { code: 'RATE_LIMITED', params: { retryAfterMs: 56_000 } },
      });
    });
    await enterLobby(page, locale);
    await page.locator('[data-room-action="create"] button').click();
    const notice = page.getByRole('alertdialog', { name: locale === 'ko' ? '안내' : 'Notice' });
    await expect(notice).toBeVisible();
    await expect(notice.locator('p')).not.toContainText(/[0-9]/u);
    await expect(notice.getByRole('button')).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath(`create-limit-${locale}-320.png`) });
    await notice.getByRole('button', { name: locale === 'ko' ? '확인' : 'OK' }).click();
    await expect(page.locator('[data-lobby-view="home"]')).toBeVisible();
  });

  test(`join rate limit keeps its inline notice and code at 320px in ${locale}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.route(/\/rooms\/000123\/join$/u, async (route) => {
      await fulfillRoomFault(route, {
        status: 429,
        error: { code: 'RATE_LIMITED', params: { retryAfterMs: 1_000 } },
      });
    });

    await enterLobby(page, locale);
    await page.locator('[data-room-action="join"] button').click();
    const input = page.getByRole('textbox');
    const submit = page.getByRole('button', {
      name: locale === 'ko' ? '참가하기' : 'Join',
      exact: true,
    });
    await page.clock.install();
    await input.fill('000123');
    await submit.click();

    await expect(page.locator('[data-lobby-view="joinRoom"]')).toBeVisible();
    await expect(page.getByRole('alert')).not.toBeEmpty();
    await expect(page.getByRole('alert')).not.toContainText(/[0-9]/u);
    await expect(input).toHaveValue('000123');
    await expect(input).toBeEditable();
    await expect(input).not.toHaveAttribute('aria-invalid', 'true');
    await expect(submit).toHaveAttribute('aria-disabled', 'true');
    expect(await submit.evaluate((node: HTMLButtonElement) => node.disabled)).toBe(false);
    await expect(page.locator('[data-screen="lobby"]')).toBeVisible();
    await expect(page.locator('[data-screen="game"]')).toHaveCount(0);
    const surface = page.locator('.scrollable-panel');
    const dimensions = await surface.evaluate((node) => ({
      width: node.clientWidth,
      scrollWidth: node.scrollWidth,
      height: node.clientHeight,
      scrollHeight: node.scrollHeight,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width);
    expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.height);
    await page.screenshot({
      path: `/tmp/hanpan-lobby-join-rate-limited-${locale}-320-${testInfo.project.name}.png`,
    });
    await page.clock.fastForward(1_000);
    await expect(submit).toHaveAttribute('aria-disabled', 'false');
    await expect(page.getByRole('alert')).toHaveText(
      locale === 'ko' ? '잠시 후 다시 시도해 주세요.' : 'Please try again shortly.',
    );
    await input.fill('000124');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}

for (const locale of ['ko', 'en'] as const) {
  test(`cancel failure uses ${locale} title and retry completes cancellation`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 568 });
    let releaseCancel!: () => void;
    let markCancelReached!: () => void;
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    const cancelReached = new Promise<void>((resolve) => {
      markCancelReached = resolve;
    });
    await page.route(/\/rooms\/[^/]+\/cancel$/u, async (route) => {
      markCancelReached();
      await cancelGate;
      await fulfillRoomFault(route, {
        status: 500,
        error: { code: 'INTERNAL_ERROR', params: {} },
      });
    });

    await enterLobby(page, locale);
    await page.locator('[data-room-action="create"] button').click();
    const roomCode = page.locator('[data-room-code]');
    await expect(roomCode).toBeVisible();
    await page
      .getByRole('button', { name: locale === 'ko' ? '대기 취소' : 'Cancel', exact: true })
      .click();
    await cancelReached;
    try {
      await expect(roomCode).toHaveCount(0);
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      await expect(page.locator('[data-room-action="create"] button')).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    } finally {
      releaseCancel();
    }

    const error = page.getByRole('alertdialog', {
      name: locale === 'ko' ? '취소 실패' : 'Couldn’t cancel',
    });
    await expect(error).toBeVisible();
    await expect(page.locator('[data-lobby-view="cancelFailed"]')).toBeVisible();
    await expect(error.locator('p')).not.toBeEmpty();
    await expect(
      error.getByRole('button', { name: locale === 'ko' ? '다시 시도' : 'Try again', exact: true }),
    ).toBeVisible();
    await expect(roomCode).toHaveCount(0);
    await expect(page.locator('[data-screen="lobby"]')).toBeVisible();
    await expect(page.locator('[data-screen="game"]')).toHaveCount(0);
    await page.screenshot({
      path: `/tmp/hanpan-lobby-cancel-failed-${locale}-${testInfo.project.name}.png`,
    });
    await page.unroute(/\/rooms\/[^/]+\/cancel$/u);
    await error
      .getByRole('button', { name: locale === 'ko' ? '다시 시도' : 'Try again', exact: true })
      .click();
    await expect(error).toHaveCount(0);
    await expect(page.locator('[data-lobby-view="home"]')).toBeVisible();
    await expect(page.locator('[data-room-action="create"] button')).toHaveAttribute(
      'aria-disabled',
      'false',
    );
    expect(await page.evaluate(() => localStorage.getItem('recentRoom'))).toBeNull();
  });

  test(`connection failure uses ${locale} title and refresh action`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.route('**/rooms/001234/join', (route) => route.abort('connectionfailed'));
    await enterLobby(page, locale);
    await page
      .getByRole('button', { name: locale === 'ko' ? '게임 참가' : 'Join Game', exact: true })
      .click();
    await page.getByRole('textbox').fill('001234');
    await page
      .getByRole('button', { name: locale === 'ko' ? '참가하기' : 'Join', exact: true })
      .click();
    const error = page.getByRole('alertdialog', {
      name: locale === 'ko' ? '연결 실패' : 'Connection failed',
    });
    await expect(error).toBeVisible();
    await expect(page.locator('[data-lobby-view="connectionFailed"]')).toBeVisible();
    await expect(error.locator('p')).not.toBeEmpty();
    await expect(error.getByRole('button')).toHaveCount(1);
    await expect(
      error.getByRole('button', { name: locale === 'ko' ? '새로고침' : 'Refresh', exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: `/tmp/hanpan-lobby-connection-failed-${locale}-${testInfo.project.name}.png`,
    });
    await error.getByRole('button').click();
    await expect(
      page.getByRole('button', { name: locale === 'ko' ? '게임 시작' : 'Start Game', exact: true }),
    ).toBeVisible();
  });
}

test('client expired-room projection rechecks the server and preserves a valid waiting room', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.route('**/rooms', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const body = (await response.json()) as {
      readonly ok: true;
      readonly data: {
        readonly view: {
          readonly room: Readonly<Record<string, unknown>> & { readonly expiresAt: number };
        } & Readonly<Record<string, unknown>>;
      } & Readonly<Record<string, unknown>>;
      readonly meta: { readonly serverTime: number } & Readonly<Record<string, unknown>>;
    };
    expect(body.ok).toBe(true);
    expect(body.meta.serverTime).toEqual(expect.any(Number));
    await route.fulfill({
      response,
      json: {
        ...body,
        data: {
          ...body.data,
          view: {
            ...body.data.view,
            room: {
              ...body.data.view.room,
              expiresAt: body.meta.serverTime + 2_000,
            },
          },
        },
      },
    });
  });

  await enterLobby(page);
  const resumed = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith('/resume'),
  );
  await page.locator('[data-room-action="create"] button').click();
  const roomCode = page.locator('[data-room-code]');
  await expect(roomCode).toBeVisible();

  await expect(page.locator('[data-lobby-view="expired"]')).toBeVisible();
  await page.getByRole('button', { name: '확인', exact: true }).click();
  const resume = await resumed;
  expect(resume.ok()).toBe(true);
  await expect(roomCode).toBeVisible();
  await expect(page.locator('[data-lobby-view="expired"]')).toHaveCount(0);
  await expect(page.locator('[data-screen="game"]')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('recentRoom') !== null)).toBe(true);
  await page.screenshot({
    path: `/tmp/hanpan-lobby-wait-rechecked-ko-${testInfo.project.name}.png`,
  });
});

for (const locale of ['ko', 'en'] as const) {
  test(`real create pending, waiting, and copy failure remain stable at 320px in ${locale}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.addInitScript((value) => localStorage.setItem('locale', value), locale);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: () => Promise.reject(new DOMException('Clipboard denied', 'NotAllowedError')),
        },
      });
    });

    let releaseCreate!: () => void;
    let markCreateReached!: () => void;
    let createRequestCount = 0;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const createReached = new Promise<void>((resolve) => {
      markCreateReached = resolve;
    });
    await page.route('**/rooms', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      createRequestCount += 1;
      markCreateReached();
      await createGate;
      await route.fallback();
    });

    await page.goto(PRODUCT_GAME_ORIGIN);
    await page
      .getByRole('button', { name: locale === 'ko' ? '게임 시작' : 'Start Game', exact: true })
      .click();
    const create = page.locator('[data-room-action="create"] button');
    const join = page.locator('[data-room-action="join"] button');
    await expect(create).toBeVisible();
    const idleBounds = await create.boundingBox();
    const homeBrand = await brandBounds(page);
    expect(idleBounds).not.toBeNull();

    try {
      await create.click();
      await createReached;
      await expect(create.locator('[data-lobby-pending="true"]')).toBeVisible();
      expect(await brandBounds(page)).toEqual(homeBrand);
      await expect(create).toHaveAttribute('aria-disabled', 'true');
      await expect(join).toHaveAttribute('aria-disabled', 'true');
      const pendingBounds = await create.boundingBox();
      expect(pendingBounds).not.toBeNull();
      expect(pendingBounds!.x).toBeCloseTo(idleBounds!.x, 1);
      expect(pendingBounds!.y).toBeCloseTo(idleBounds!.y, 1);
      expect(pendingBounds!.width).toBeCloseTo(idleBounds!.width, 1);
      expect(pendingBounds!.height).toBeCloseTo(idleBounds!.height, 1);
      await page.mouse.click(
        pendingBounds!.x + pendingBounds!.width / 2,
        pendingBounds!.y + pendingBounds!.height / 2,
      );
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      expect(createRequestCount).toBe(1);
      await page.screenshot({
        path: `/tmp/hanpan-lobby-create-pending-${locale}-320-${testInfo.project.name}.png`,
      });
    } finally {
      releaseCreate();
    }

    const code = page.locator('[data-room-code]');
    await expect(code).toBeVisible();
    const roomCode = await code.textContent();
    expect(roomCode).toMatch(/^[0-9]{6}$/u);
    await page.screenshot({
      path: `/tmp/hanpan-lobby-waiting-${locale}-320-${testInfo.project.name}.png`,
    });

    const copy = page.locator('.web-lobby-copy-button');
    await copy.click();
    await expect(copy).toHaveAttribute('data-copy-status', 'failed');
    const feedback = await page.locator('.web-lobby-copy-feedback').boundingBox();
    const countdown = await page.locator('.web-lobby-countdown').boundingBox();
    expect(countdown!.y + countdown!.height).toBeLessThanOrEqual(feedback!.y + RECT_ROUNDING);
    const codeBounds = await code.boundingBox();
    expect(codeBounds).not.toBeNull();
    await page.mouse.move(codeBounds!.x + 1, codeBounds!.y + codeBounds!.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      codeBounds!.x + codeBounds!.width - 1,
      codeBounds!.y + codeBounds!.height / 2,
      { steps: 10 },
    );
    await page.mouse.up();
    const selectedCode = await page.evaluate(() => getSelection()?.toString() ?? '');
    // WebKit includes block-ending newlines in a native drag selection.
    expect(selectedCode.trim()).toBe(roomCode);
    await page.screenshot({
      path: `/tmp/hanpan-lobby-copy-failure-${locale}-320-${testInfo.project.name}.png`,
    });
  });
}

test('desktop Entry, settings, profile, and copy controls show feedback before activation', async ({
  page,
}) => {
  await page.goto(PRODUCT_GAME_ORIGIN);
  const start = page.locator('.entry-view__start');
  await page.mouse.move(0, 0);
  const startIdle = await brightness(start);
  await start.hover();
  await expect.poll(() => brightness(start)).toBeGreaterThan(startIdle);
  await start.click();
  await expect(page.locator('[data-screen="lobby"]')).toBeVisible();
  await page.locator('.lobby-view__utility > .ui-icon-button').click();
  for (const selector of ['.settings-view__switch', '.settings-view__locale-options button']) {
    const control = page.locator(selector).first();
    await page.mouse.move(0, 0);
    const idle = await brightness(control);
    await control.hover();
    await expect.poll(() => brightness(control)).toBeGreaterThan(idle);
    await page.mouse.down();
    await expect.poll(() => brightness(control)).toBeLessThan(idle);
    await page.mouse.up();
    await page.mouse.move(0, 0);
    await expect.poll(() => brightness(control)).toBe(idle);
    await expect(control).toHaveCSS('outline-style', 'none');
  }
  await page.locator('.settings-view .ui-icon-button').click();
  await page.locator('.lobby-view__profile button').click();
  const character = page.locator('.character-choice-grid__choice').first();
  await page.mouse.move(0, 0);
  const characterIdle = await brightness(character);
  await character.hover();
  await expect.poll(() => brightness(character)).toBeGreaterThan(characterIdle);
  await character.click();
  await page.locator('.scrollable-panel .ui-icon-button').click();
  await page.locator('[data-room-action="create"] button').click();
  const copy = page.locator('.web-lobby-copy-button');
  await page.mouse.move(0, 0);
  const copyIdle = await brightness(copy);
  await copy.hover();
  await expect.poll(() => brightness(copy)).toBeGreaterThan(copyIdle);
});

async function brightness(control: Locator): Promise<number> {
  const filter = await control.evaluate(async (node) => {
    await Promise.all(node.getAnimations().map((animation) => animation.finished.catch(() => {})));
    return getComputedStyle(node).filter;
  });
  if (filter === 'none') return 1;
  const match = /^brightness\(([\d.]+)\)$/u.exec(filter);
  expect(match, `Expected a brightness filter, got ${filter}`).not.toBeNull();
  const value = Number(match![1]);
  expect(Number.isFinite(value)).toBe(true);
  return value;
}

for (const locale of ['ko', 'en'] as const) {
  test(`profile persistence failure keeps the selection and recovers inline (${locale})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await enterLobby(page, locale);
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key === 'profileSelection') {
          Storage.prototype.setItem = original;
          throw new DOMException('Storage denied', 'QuotaExceededError');
        }
        original.call(this, key, value);
      };
    });
    await page.locator('.lobby-view__profile button').click();
    const choices = page.locator('[data-character-id]');
    const selection = choices
      .filter({ hasNot: page.locator('.character-choice-grid__selection') })
      .first();
    const selectedId = await selection.getAttribute('data-character-id');
    const surface = page.locator('.scrollable-panel');
    const panelBefore = await surface.boundingBox();
    const gridBefore = await page.locator('.character-choice-grid').boundingBox();
    await selection.click();
    const warning = page.getByRole('alert');
    await expect(warning).toHaveText(
      locale === 'ko' ? '프로필을 저장하지 못했어요.' : 'Couldn’t save your profile.',
    );
    await expect(page.locator(`[data-character-id="${selectedId}"]`)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(warning).toBeVisible();
    const panelAfter = await surface.boundingBox();
    expect(panelAfter!.y).toBeCloseTo(panelBefore!.y, 1);
    expect(panelAfter!.height).toBeGreaterThan(panelBefore!.height);
    expect(await page.locator('.character-choice-grid').boundingBox()).toEqual(gridBefore);
    const warningBounds = await warning.boundingBox();
    expect(warningBounds).not.toBeNull();
    expect(warningBounds!.x).toBeGreaterThanOrEqual(0);
    expect(warningBounds!.x + warningBounds!.width).toBeLessThanOrEqual(320);
    await page.screenshot({
      path: `/tmp/hanpan-profile-storage-${locale}-${test.info().project.name}.png`,
    });
    await choices
      .filter({ hasNot: page.locator('.character-choice-grid__selection') })
      .first()
      .click();
    await expect(warning).toHaveCount(0);
    expect(await surface.boundingBox()).toEqual(panelBefore);
    const saved = await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('profileSelection') ?? 'null') as { characterId: string },
    );
    await expect(page.locator(`[data-character-id="${saved.characterId}"]`)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
}

for (const fault of ['compatibility mismatch', 'malformed response'] as const) {
  test(`cancel ${fault} preserves authority and requires refresh`, async ({ page }) => {
    await enterLobby(page, 'en');
    await page.getByRole('button', { name: 'Create Game', exact: true }).click();
    await expect(page.locator('[data-room-code]')).toBeVisible();
    const saved = await page.evaluate(() => localStorage.getItem('recentRoom'));
    expect(saved).not.toBeNull();
    await page.route(/\/rooms\/[^/]+\/cancel$/u, async (route) => {
      if (fault === 'malformed response') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          json: { unexpected: true },
        });
        return;
      }
      const request = parseRoomHttpEnvelope(route.request().postDataJSON());
      await route.fallback({
        postData: JSON.stringify({
          ...request,
          contract: { ...request.contract, releaseId: 'stale-release' },
        }),
      });
    });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    const notice = page.getByRole('alertdialog');
    await expect(notice).toBeVisible();
    await expect(notice.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible();
    await expect(notice.getByRole('button')).toHaveCount(1);
    expect(await page.evaluate(() => localStorage.getItem('recentRoom'))).toBe(saved);
  });
}
