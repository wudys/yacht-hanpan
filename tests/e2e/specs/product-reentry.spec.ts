import { expect, type Locator, type Page } from '@playwright/test';
import { PUBLIC_ERROR_CODE } from '@repo/game-protocol';
import { parseSyncAck } from '@repo/game-protocol/socket';

import { joinProductGame, PRODUCT_GAME_ORIGIN } from '../helpers/product-game';
import { createTestContext, test } from '../helpers/test';

async function installScreenTrace(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: string[] = [];
    const record = () => {
      for (const node of document.querySelectorAll<HTMLElement>('[data-screen]')) {
        const { screen } = node.dataset;
        if (screen && !seen.includes(screen)) seen.push(screen);
      }
    };
    record();
    new MutationObserver(record).observe(document.body, { childList: true, subtree: true });
    Reflect.set(window, '__hanpanSeenScreens', seen);
  });
}

async function expectReloadThroughLoading(
  page: Page,
  destination: Locator,
  locale: 'ko' | 'en' = 'ko',
): Promise<void> {
  await page.reload();
  const entry = page.getByRole('button', {
    name: locale === 'ko' ? '게임 시작' : 'Start Game',
    exact: true,
  });
  await expect(entry).toBeVisible();
  await installScreenTrace(page);
  await entry.click();
  await expect(destination).toBeVisible();
  const seen = await page.evaluate(
    () => Reflect.get(window, '__hanpanSeenScreens') as readonly string[],
  );
  expect(seen).toContain('loading');
}

async function recordScore(page: Page, group: 'lower' | 'upper', category: string) {
  await page.getByRole('button', { name: '굴리기', exact: true }).click();
  await page.locator(`[data-score-tab="${group}"]`).click();
  const choice = page.locator(`button[data-score-category="${category}"]`);
  await expect(choice).toHaveAttribute('data-value-state', 'preview');
  const score = await choice.locator('[data-score-value-kind]').textContent();
  expect(score).not.toBeNull();
  await choice.click();
  return score!;
}

async function openScoreboard(page: Page): Promise<void> {
  await page.getByRole('button', { name: '점수판', exact: true }).click();
  await expect(page.locator('[data-score-table]')).toBeVisible();
}

async function closeScoreboard(page: Page): Promise<void> {
  await page.getByRole('button', { name: '닫기', exact: true }).click();
}

test('a lost room credential allows a new waiting room without replacing clientId', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  await page.locator('[data-room-action="create"] button').click();
  const code = page.locator('[data-room-code]');
  await expect(code).toBeVisible();
  const firstCode = await code.getAttribute('data-room-code');
  expect(firstCode).toMatch(/^[0-9]{6}$/u);
  const clientId = await page.evaluate(() => localStorage.getItem('clientId'));
  expect(clientId).not.toBeNull();

  // Preserve storage identity while simulating loss of the room's authority.
  // Reload closes the old transport; it does not cancel the server-side room.
  await page.evaluate(() => localStorage.removeItem('recentRoom'));
  await page.reload();
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  await page.locator('[data-room-action="create"] button').click();
  await expect(code).toBeVisible();
  await expect(code).not.toHaveAttribute('data-room-code', firstCode!);
  expect(await page.evaluate(() => localStorage.getItem('clientId'))).toBe(clientId);
});

test('unreadable recovery storage blocks new admission instead of treating it as empty', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    const { getItem } = Storage.prototype;
    Storage.prototype.getItem = function (key: string) {
      if (key === 'recentRoom') throw new DOMException('Read denied', 'SecurityError');
      return getItem.call(this, key);
    };
  });
  const mutations: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') mutations.push(new URL(request.url()).pathname);
  });
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  await expect(page.getByText('세션 정보를 읽지 못했어요.', { exact: true })).toBeVisible();
  await expect(page.locator('[data-room-action="create"] button')).toBeDisabled();
  expect(mutations).toEqual([]);
});

test('an open empty lobby rechecks storage availability before creating a room', async ({
  page,
}) => {
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  const create = page.locator('[data-room-action="create"] button');
  await expect(create).toBeEnabled();
  await page.evaluate(() => {
    const { getItem } = Storage.prototype;
    Storage.prototype.getItem = function (key: string) {
      if (key === 'recentRoom') throw new DOMException('Read denied', 'SecurityError');
      return getItem.call(this, key);
    };
  });
  const mutations: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') mutations.push(new URL(request.url()).pathname);
  });
  await create.click();
  await expect(page.getByText('세션 정보를 읽지 못했어요.', { exact: true })).toBeVisible();
  await expect(create).toBeDisabled();
  expect(mutations).toEqual([]);
});

test('unsaved recovery keeps the current waiting room and allows a fresh room only after reload', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    const { setItem } = Storage.prototype;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === 'recentRoom') throw new DOMException('Write denied', 'QuotaExceededError');
      setItem.call(this, key, value);
    };
  });
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  await page.locator('[data-room-action="create"] button').click();
  const code = page.locator('[data-room-code]');
  await expect(code).toBeVisible();
  const firstCode = await code.getAttribute('data-room-code');
  await expect(page.getByText('세션 정보를 저장하지 못했어요.', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 568 });
  await page.screenshot({ path: test.info().outputPath('storage-memory-only-320.png') });
  await expect(page.locator('[data-room-action="create"] button')).toBeDisabled();
  expect(await page.evaluate(() => localStorage.getItem('recentRoom') === null)).toBe(true);
  await expectReloadThroughLoading(page, page.locator('[data-product-view="lobby"]'));
  await expect(page.locator('[data-room-action="create"] button')).toBeEnabled();
  await page.locator('[data-room-action="create"] button').click();
  await expect(code).toBeVisible();
  await expect(code).not.toHaveAttribute('data-room-code', firstCode!);
  const guestContext = await createTestContext(browser);
  try {
    const guest = await guestContext.newPage();
    await guest.goto(PRODUCT_GAME_ORIGIN);
    await guest.getByRole('button', { name: '게임 시작', exact: true }).click();
    await guest.getByRole('button', { name: '게임 참가', exact: true }).click();
    await guest.getByRole('textbox').fill((await code.getAttribute('data-room-code'))!);
    await guest.getByRole('button', { name: '참가하기', exact: true }).click();
    await expect(page.locator('[data-screen="game"]')).toBeVisible();
    await expect(page.getByText('세션 정보를 저장하지 못했어요.', { exact: true })).toBeVisible();
    const notice = page.getByText('세션 정보를 저장하지 못했어요.', { exact: true });
    const warningBounds = await notice.boundingBox();
    const timerBounds = await page.locator('.game-board__timer').boundingBox();
    expect(warningBounds).not.toBeNull();
    expect(timerBounds).not.toBeNull();
    expect(warningBounds!.x + warningBounds!.width).toBeLessThanOrEqual(timerBounds!.x);
    await page.screenshot({ path: test.info().outputPath('storage-memory-only-game-320.png') });
  } finally {
    await guestContext.close();
  }
});

test('creator reload reenters the same waiting room after Entry and Loading', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  await expect(page.locator('[data-product-view="lobby"]')).toBeVisible();
  const homeBrand = await page.locator('.lobby-view__brand').boundingBox();
  await page.locator('[data-room-action="create"] button').click();
  const originalCodeView = page.locator('[data-room-code]');
  await expect(originalCodeView).toBeVisible();
  const originalCode = await originalCodeView.getAttribute('data-room-code');
  expect(originalCode).toMatch(/^[0-9]{6}$/u);

  // A legacy timestamp far behind the browser clock cannot invalidate server-owned authority.
  await page.evaluate(() => {
    const candidate = JSON.parse(localStorage.getItem('recentRoom')!) as Record<string, unknown>;
    localStorage.setItem('recentRoom', JSON.stringify({ ...candidate, roomCreatedAt: 0 }));
  });

  let releaseReadiness!: () => void;
  const readinessGate = new Promise<void>((resolve) => {
    releaseReadiness = resolve;
  });
  await page.route('**/health/ready', async (route) => {
    await readinessGate;
    await route.fallback();
  });
  const checking = page.locator('[data-screen="lobby"][data-reentry-state="checking"]');
  await expectReloadThroughLoading(page, checking);
  await expect(page.locator('[data-room-action="create"] button')).toBeDisabled();
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations === 1)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  await page.screenshot({ path: `/tmp/hanpan-reentry-checking-320-${testInfo.project.name}.png` });
  const brand = await page.locator('.lobby-view__brand').boundingBox();
  const panel = await checking.locator('.scrollable-panel').boundingBox();
  expect(brand).not.toBeNull();
  expect(panel).not.toBeNull();
  expect(brand).toEqual(homeBrand);
  expect(panel!.x).toBeGreaterThanOrEqual(0);
  expect(panel!.x + panel!.width).toBeLessThanOrEqual(320);
  releaseReadiness();
  const restoredCodeView = page.locator('[data-room-code]');
  await expect(restoredCodeView).toBeVisible();
  await expect(restoredCodeView).toHaveAttribute('data-room-code', originalCode!);
  await expect(restoredCodeView).toHaveText(originalCode!);
});

test('displayed waiting expiry resumes a real match when its room update was lost', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  let blockedUpdates = 0;
  let resumeRequests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/resume')) resumeRequests += 1;
  });
  await page.routeWebSocket('**/game-socket/**', (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => {
      // Drop live RoomView pushes. Auth, heartbeats and full-sync acknowledgements pass.
      if (typeof message === 'string' && message.startsWith('42["room:state",')) {
        blockedUpdates += 1;
        return;
      }
      socket.send(message);
    });
  });
  await page.route('**/rooms', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as {
      ok: boolean;
      data: { view: { room: Record<string, unknown> } };
      meta: { serverTime: number };
    };
    expect(body.ok).toBe(true);
    await route.fulfill({
      response,
      json: {
        ...body,
        data: {
          ...body.data,
          view: {
            ...body.data.view,
            room: { ...body.data.view.room, expiresAt: body.meta.serverTime + 5_000 },
          },
        },
      },
    });
  });
  const guestContext = await createTestContext(browser);
  try {
    const guest = await guestContext.newPage();
    await guest.goto(PRODUCT_GAME_ORIGIN);
    await guest.getByRole('button', { name: '게임 시작', exact: true }).click();
    await guest.getByRole('button', { name: '게임 참가', exact: true }).click();
    await page.goto(PRODUCT_GAME_ORIGIN);
    await page.getByRole('button', { name: '게임 시작', exact: true }).click();
    await page.locator('[data-room-action="create"] button').click();
    const code = page.locator('[data-room-code]');
    await expect(code).toBeVisible();
    await guest.getByRole('textbox').fill((await code.getAttribute('data-room-code'))!);
    await guest.getByRole('button', { name: '참가하기', exact: true }).click();
    await expect(guest.locator('[data-screen="game"]')).toBeVisible();
    await expect.poll(() => blockedUpdates).toBeGreaterThan(0);
    await expect(page.locator('[data-lobby-view="expired"]')).toBeVisible();
    await page.getByRole('button', { name: '확인', exact: true }).click();
    await expect(page.locator('[data-screen="game"]')).toBeVisible({ timeout: 15_000 });
    expect(resumeRequests).toBeGreaterThan(0);
    expect(await page.evaluate(() => localStorage.getItem('recentRoom') !== null)).toBe(true);
    await expect(page.locator('[data-lobby-view="expired"]')).toHaveCount(0);
  } finally {
    await guestContext.close();
  }
});

test('guest reload restores the authoritative Game scores and can continue normally', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  const guestContext = await joinProductGame(page, browser);
  try {
    const guest = guestContext.pages()[0]!;
    const creatorScore = await recordScore(page, 'lower', 'choice');
    await expect(guest.locator('[data-product-view="game"]')).toHaveAttribute(
      'data-viewer-turn',
      'true',
    );

    await openScoreboard(guest);
    const choiceRow = guest.locator('[data-score-table] tr[data-score-category="choice"] td');
    const scoresBeforeReload = await choiceRow.allTextContents();
    const totalsBeforeReload = await guest
      .locator('[data-score-player] .score-table-player__total')
      .allTextContents();
    expect(scoresBeforeReload).toEqual(['—', creatorScore]);
    expect(totalsBeforeReload).toHaveLength(2);
    await closeScoreboard(guest);

    await expectReloadThroughLoading(guest, guest.locator('[data-product-view="game"]'));
    await expect(guest.locator('[data-product-view="game"]')).toHaveAttribute(
      'data-viewer-turn',
      'true',
    );
    await openScoreboard(guest);
    await expect(choiceRow).toHaveText(scoresBeforeReload);
    await expect(guest.locator('[data-score-player] .score-table-player__total')).toHaveText(
      totalsBeforeReload,
    );
    await closeScoreboard(guest);

    await recordScore(guest, 'upper', 'fours');
    await expect(guest.locator('[data-product-view="game"]')).toHaveAttribute(
      'data-viewer-turn',
      'false',
    );

    await guest.getByRole('button', { name: '설정', exact: true }).click();
    await guest.getByRole('button', { name: '기권하기', exact: true }).click();
    await expect(guest.locator('[data-product-view="result"]')).toBeVisible();
    await guest.getByRole('button', { name: '로비로 돌아가기', exact: true }).click();
    await expect(guest.locator('[data-product-view="lobby"]')).toBeVisible();
    await expect(guest.locator('[data-screen="game"]')).toHaveCount(0);
    expect(await guest.evaluate(() => localStorage.getItem('recentRoom'))).toBeNull();

    await guest.reload();
    await guest.getByRole('button', { name: '게임 시작', exact: true }).click();
    await expect(guest.locator('[data-product-view="lobby"]')).toBeVisible();
    await expect(guest.locator('[data-screen="game"]')).toHaveCount(0);
  } finally {
    await guestContext.close();
  }
});

test('returning after missing room finish shows permanent reentry notice and confirmation clears recovery', async ({
  page: initialPage,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  await initialPage.setViewportSize({ width: 320, height: 568 });
  await initialPage.context().addInitScript(() => localStorage.setItem('locale', 'en'));
  await initialPage.goto(PRODUCT_GAME_ORIGIN);
  await initialPage.getByRole('button', { name: 'Start Game', exact: true }).click();
  const guestContext = await joinProductGame(initialPage, browser, {
    locale: 'en',
    viewport: { width: 320, height: 568 },
  });
  try {
    const returningContext = initialPage.context();
    await initialPage.close();
    const guest = guestContext.pages()[0]!;
    await guest.getByRole('button', { name: 'Settings', exact: true }).click();
    await guest.getByRole('button', { name: 'Forfeit', exact: true }).click();
    await expect(guest.locator('[data-product-view="result"]')).toBeVisible();

    const page = await returningContext.newPage();
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(PRODUCT_GAME_ORIGIN);
    expect(await page.evaluate(() => localStorage.getItem('recentRoom') !== null)).toBe(true);

    const permanentFailure = page.locator(
      '[data-screen="lobby"][data-reentry-state="permanentFailure"]',
    );
    await expectReloadThroughLoading(page, permanentFailure, 'en');
    await expect(page.locator('[data-product-view="result"]')).toHaveCount(0);
    const notice = page.getByRole('alertdialog');
    await expect(notice).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('recentRoom') !== null)).toBe(true);
    await page.screenshot({
      path: `/tmp/hanpan-reentry-failure-en-320-${testInfo.project.name}.png`,
    });
    await notice.getByRole('button', { name: 'OK', exact: true }).click();

    await expect(page.locator('[data-product-view="lobby"]')).toBeVisible();
    await expect(notice).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('recentRoom'))).toBeNull();
  } finally {
    await guestContext.close();
  }
});

test('pending saved Game confirms a permanent first sync failure without navigating to Game', async ({
  page,
  browser,
}) => {
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  const guestContext = await joinProductGame(page, browser);
  try {
    const guest = guestContext.pages()[0]!;
    let rejected = false;
    await guest.routeWebSocket(/\/game-socket\//u, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        if (!rejected && typeof message === 'string' && message.startsWith('43')) {
          const payloadStart = message.indexOf('[');
          const [response] = JSON.parse(message.slice(payloadStart)) as unknown[];
          const ack = parseSyncAck(response);
          if (ack.ok && ack.data.game !== null) {
            // Use the real server's current Game as a live update before first-sync confirmation fails.
            socket.send(
              `42${JSON.stringify(['room:state', { type: 'state:committed', view: ack.data }])}`,
            );
            socket.send(
              `${message.slice(0, payloadStart)}${JSON.stringify([
                {
                  ok: false,
                  error: { code: PUBLIC_ERROR_CODE.ROOM_NOT_FOUND, params: {} },
                  meta: {
                    requestId: ack.meta.requestId,
                    gameProtocolVersion: ack.meta.gameProtocolVersion,
                  },
                },
              ])}`,
            );
            rejected = true;
            return;
          }
        }
        socket.send(message);
      });
    });
    await guest.reload();
    await guest.getByRole('button', { name: '게임 시작', exact: true }).click();
    await expect(
      guest.locator('[data-screen="lobby"][data-reentry-state="permanentFailure"]'),
    ).toBeVisible();
    expect(rejected).toBe(true);
    await expect(guest.locator('[data-screen="game"]')).toHaveCount(0);
    expect(await guest.evaluate(() => localStorage.getItem('recentRoom'))).not.toBeNull();
    const notice = guest.getByRole('alertdialog');
    await notice.getByRole('button', { name: '확인', exact: true }).click();
    await expect(guest.locator('[data-product-view="lobby"]')).toBeVisible();
    await expect(notice).toHaveCount(0);
    expect(await guest.evaluate(() => localStorage.getItem('recentRoom'))).toBeNull();
  } finally {
    await guestContext.close();
  }
});
