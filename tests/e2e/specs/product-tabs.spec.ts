import { expect, type Page, type WebSocketRoute } from '@playwright/test';

import { joinProductGame, PRODUCT_GAME_ORIGIN } from '../helpers/product-game';
import { test } from '../helpers/test';

const copy = {
  ko: {
    start: '게임 시작',
    title: '연결 종료',
    message: '다른 곳에서 이 게임에 접속했어요.',
    restart: '시작 화면으로',
  },
  en: {
    start: 'Start Game',
    title: 'Disconnected',
    message: 'This game is open in another tab or device.',
    restart: 'Back to Start',
  },
} as const;

async function start(page: Page, locale: 'ko' | 'en' = 'ko'): Promise<void> {
  await page.getByRole('button', { name: copy[locale].start, exact: true }).click();
  await expect(page.locator('[data-screen="lobby"]')).toBeVisible();
}

for (const locale of ['ko', 'en'] as const) {
  test(`same-seat connection replacement uses a standalone ${locale} notice and explicit restart`, async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(120_000);
    await context.addInitScript((value) => localStorage.setItem('locale', value), locale);
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(PRODUCT_GAME_ORIGIN);
    await start(page, locale);
    await page.locator('[data-room-action="create"] button').click();
    const originalCode = page.locator('[data-room-code]');
    await expect(originalCode).toBeVisible();
    const waitingCode = await originalCode.getAttribute('data-room-code');
    const next = await context.newPage();
    await next.setViewportSize({ width: 320, height: 568 });
    await next.goto(PRODUCT_GAME_ORIGIN);
    await expect(next.getByRole('button', { name: copy[locale].start, exact: true })).toBeVisible();
    await expect(originalCode).toHaveAttribute('data-room-code', waitingCode!);
    await expect(page.locator('[data-global-failure="replaced"]')).toHaveCount(0);

    await start(next, locale);
    await expect(next.locator('[data-room-code]')).toHaveAttribute('data-room-code', waitingCode!);
    const notice = page.getByRole('alertdialog', { name: copy[locale].title, exact: true });
    await expect(notice).toBeVisible();
    await expect(notice.getByText(copy[locale].message, { exact: true })).toBeVisible();
    await expect(page.locator('[data-screen="lobby"]')).toHaveCount(0);
    await expect(page.getByTestId('global-interaction-surface')).toHaveAttribute('inert', '');
    await page.keyboard.press('Escape');
    await page.mouse.click(2, 2);
    await expect(notice).toBeVisible();
    await expect(page.getByRole('button')).toHaveCount(1);
    await page.screenshot({
      path: `/tmp/hanpan-tab-replaced-${locale}-320-${testInfo.project.name}.png`,
    });
    const bounds = await notice.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(-1);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(321);

    await notice.getByRole('button', { name: copy[locale].restart, exact: true }).click();
    await expect(page.getByRole('button', { name: copy[locale].start, exact: true })).toBeVisible();
    await expect(next.locator('[data-room-code]')).toHaveAttribute('data-room-code', waitingCode!);
    await expect(next.locator('[data-global-failure="replaced"]')).toHaveCount(0);

    await start(page, locale);
    await expect(page.locator('[data-room-code]')).toHaveAttribute('data-room-code', waitingCode!);
    await expect(next.locator('[data-global-failure="replaced"]')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('recentRoom') !== null)).toBe(true);
  });
}

for (const intent of ['create', 'join'] as const) {
  test(`an older empty lobby restores a newly saved waiting seat before ${intent}`, async ({
    page,
    context,
  }) => {
    await page.goto(PRODUCT_GAME_ORIGIN);
    await start(page);
    const next = await context.newPage();
    await next.goto(PRODUCT_GAME_ORIGIN);
    await start(next);
    await page.locator('[data-room-action="create"] button').click();
    const code = page.locator('[data-room-code]');
    await expect(code).toBeVisible();
    const waitingCode = await code.getAttribute('data-room-code');
    const mutations: string[] = [];
    next.on('request', (request) => {
      if (request.method() === 'POST' && !new URL(request.url()).pathname.endsWith('/resume'))
        mutations.push(new URL(request.url()).pathname);
    });
    if (intent === 'join') {
      await next.getByRole('button', { name: '게임 참가', exact: true }).click();
      await next.getByRole('textbox').fill('000000');
      await next.getByRole('button', { name: '참가하기', exact: true }).click();
    } else {
      await next.getByRole('button', { name: '프로필 설정', exact: true }).click();
      await next.getByRole('button', { name: '닫기', exact: true }).click();
      await next.getByRole('button', { name: '설정', exact: true }).click();
      await next.getByRole('button', { name: '닫기', exact: true }).click();
      await expect(page.locator('[data-global-failure="replaced"]')).toHaveCount(0);
      await next.locator('[data-room-action="create"] button').click();
    }
    await expect(next.locator('[data-room-code]')).toHaveAttribute('data-room-code', waitingCode!);
    await expect(page.locator('[data-global-failure="replaced"]')).toBeVisible();
    expect(mutations).toEqual([]);
  });
}

test('lost replacement packets end the old execution on authentication retry', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const oldSockets: WebSocketRoute[] = [];
  let socketAttempts = 0;
  let droppedReplacement = 0;
  let droppedDisconnect = 0;
  await page.routeWebSocket('**/game-socket/**', async (socket) => {
    socketAttempts += 1;
    if (socketAttempts === 1) oldSockets.push(socket);
    const server = socket.connectToServer();
    // Keep the server half alive after a simulated client-side transport loss, so
    // the new tab really replaces this stale server connection.
    if (socketAttempts === 1) {
      socket.onClose(() => {});
      server.onClose(() => {});
    }
    server.onMessage((message) => {
      if (typeof message === 'string' && message.startsWith('42["session:replaced"')) {
        droppedReplacement += 1;
        return;
      }
      if (message === '41') {
        droppedDisconnect += 1;
        return;
      }
      socket.send(message);
    });
  });
  await page.goto(PRODUCT_GAME_ORIGIN);
  await start(page);
  await page.locator('[data-room-action="create"] button').click();
  await expect(page.locator('[data-room-code]')).toBeVisible();
  const code = await page.locator('[data-room-code]').getAttribute('data-room-code');
  const next = await context.newPage();
  await next.goto(PRODUCT_GAME_ORIGIN);
  await expect(next.getByRole('button', { name: '게임 시작', exact: true })).toBeVisible();
  expect(oldSockets).toHaveLength(1);
  await start(next);
  await expect(next.locator('[data-room-code]')).toHaveAttribute('data-room-code', code!);
  await oldSockets[0]!.close({ code: 1011, reason: 'probe transport loss' });
  await expect(page.locator('[data-global-failure="replaced"]')).toBeVisible();
  expect(socketAttempts).toBeGreaterThan(1);
  expect(droppedReplacement).toBe(1);
  expect(droppedDisconnect).toBe(1);
  const attemptsAtReplacement = socketAttempts;
  // Observe real transport attempts beyond Socket.IO's maximum retry backoff.
  // No browser clock mocking: same-context pages must keep bootstrapping normally.
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  expect(socketAttempts).toBe(attemptsAtReplacement);
  await expect(next.locator('[data-global-failure="replaced"]')).toHaveCount(0);
  await expect(next.locator('[data-room-code]')).toHaveAttribute('data-room-code', code!);
});

test('simultaneous explicit starts keep both empty lobbies usable without tab coordination APIs', async ({
  page,
  context,
}) => {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
    Object.defineProperty(globalThis, 'BroadcastChannel', { value: undefined, configurable: true });
  });
  await page.goto(PRODUCT_GAME_ORIGIN);
  const next = await context.newPage();
  await next.goto(PRODUCT_GAME_ORIGIN);
  await Promise.all([start(page), start(next)]);
  await expect(page.locator('[data-room-action="create"] button')).toBeEnabled();
  await expect(next.locator('[data-room-action="create"] button')).toBeEnabled();
  await expect(page.locator('[data-global-failure="replaced"]')).toHaveCount(0);
  await expect(next.locator('[data-global-failure="replaced"]')).toHaveCount(0);
});

test('a normal reconnect replaces its own lingering server transport without ending the tab', async ({
  page,
}) => {
  let firstSocket: WebSocketRoute | undefined;
  let attempts = 0;
  let oldServerClosed = false;
  let initialSyncComplete = false;
  await page.routeWebSocket('**/game-socket/**', (socket) => {
    attempts += 1;
    const server = socket.connectToServer();
    if (attempts === 1) {
      firstSocket = socket;
      server.onMessage((message) => {
        if (
          typeof message === 'string' &&
          message.startsWith('43') &&
          message.includes('serverTime')
        )
          initialSyncComplete = true;
        socket.send(message);
      });
      socket.onClose(() => {});
      server.onClose(() => {
        oldServerClosed = true;
      });
    }
  });
  await page.goto(PRODUCT_GAME_ORIGIN);
  await start(page);
  await page.locator('[data-room-action="create"] button').click();
  const code = page.locator('[data-room-code]');
  await expect(code).toBeVisible();
  const waitingCode = await code.getAttribute('data-room-code');
  await expect.poll(() => attempts).toBe(1);
  // A route exists before authentication and the initial full sync complete.
  await expect.poll(() => initialSyncComplete).toBe(true);
  await firstSocket!.close({ code: 1011, reason: 'temporary transport loss' });
  await expect.poll(() => attempts).toBe(2);
  await expect.poll(() => oldServerClosed).toBe(true);
  await expect(page.locator('[data-screen="lobby"]')).toBeVisible();
  await expect(code).toHaveAttribute('data-room-code', waitingCode!);
  await expect(page.locator('[data-global-failure="replaced"]')).toHaveCount(0);
});

for (const failure of ['resume', 'authentication'] as const) {
  test(`a second tab's failed ${failure} leaves the active seat connected`, async ({
    page,
    context,
  }) => {
    let closed = 0;
    page.on('websocket', (socket) =>
      socket.on('close', () => {
        closed += 1;
      }),
    );
    await page.goto(PRODUCT_GAME_ORIGIN);
    await start(page);
    await page.locator('[data-room-action="create"] button').click();
    const code = page.locator('[data-room-code]');
    await expect(code).toBeVisible();
    const waitingCode = await code.getAttribute('data-room-code');
    const next = await context.newPage();
    if (failure === 'resume') {
      await next.route('**/rooms/*/resume', (route) => route.abort());
    } else {
      await next.routeWebSocket('**/game-socket/**', (socket) => {
        const server = socket.connectToServer();
        socket.onMessage((message) => {
          if (typeof message === 'string' && message.startsWith('40')) {
            const auth = JSON.parse(message.slice(2)) as Record<string, unknown>;
            server.send(`40${JSON.stringify({ ...auth, seatToken: crypto.randomUUID() })}`);
          } else server.send(message);
        });
      });
    }
    await next.goto(PRODUCT_GAME_ORIGIN);
    await start(next);
    await expect(next.locator('[data-screen="lobby"]')).toHaveAttribute(
      'data-reentry-state',
      failure === 'resume' ? 'refreshRequired' : 'permanentFailure',
    );
    await expect(page.locator('[data-global-failure="replaced"]')).toHaveCount(0);
    await expect(code).toHaveAttribute('data-room-code', waitingCode!);
    expect(closed).toBe(0);
  });
}

test('a playing seat moves to the new tab with its current turn and score', async ({
  page,
  context,
  browser,
}) => {
  test.setTimeout(90_000);
  await page.goto(PRODUCT_GAME_ORIGIN);
  await start(page);
  const guestContext = await joinProductGame(page, browser);
  try {
    const guest = guestContext.pages()[0]!;
    await page.getByRole('button', { name: '굴리기', exact: true }).click();
    await page.locator('[data-score-tab="lower"]').click();
    const originalChoice = page.locator('button[data-score-category="choice"]');
    await expect(originalChoice).toHaveAttribute('data-value-state', 'preview');
    await originalChoice.click();
    await expect(guest.locator('[data-product-view="game"]')).toHaveAttribute(
      'data-viewer-turn',
      'true',
    );
    await page.getByRole('button', { name: '점수판', exact: true }).click();
    const scoresBefore = await page
      .locator('[data-score-table] tr[data-score-category="choice"] td')
      .allTextContents();
    await page.getByRole('button', { name: '닫기', exact: true }).click();
    const before = await page.locator('.game-board__timer').textContent();
    const next = await context.newPage();
    await next.goto(PRODUCT_GAME_ORIGIN);
    await next.getByRole('button', { name: '게임 시작', exact: true }).click();
    await expect(next.locator('[data-screen="game"]')).toBeVisible();
    await expect(page.locator('[data-global-failure="replaced"]')).toBeVisible();
    await expect(next.locator('[data-product-view="game"]')).toHaveAttribute(
      'data-viewer-turn',
      'false',
    );
    const after = await next.locator('.game-board__timer').textContent();
    expect(Number(after?.replace(/[^0-9]/gu, ''))).toBeLessThanOrEqual(
      Number(before?.replace(/[^0-9]/gu, '')),
    );
    await expect(guest.locator('[data-screen="game"]')).toBeVisible();
    await next.getByRole('button', { name: '점수판', exact: true }).click();
    expect(
      await next
        .locator('[data-score-table] tr[data-score-category="choice"] td')
        .allTextContents(),
    ).toEqual(scoresBefore);
    await next.getByRole('button', { name: '닫기', exact: true }).click();
    await guest.getByRole('button', { name: '굴리기', exact: true }).click();
    await guest.locator('[data-score-tab="lower"]').click();
    const choice = guest.locator('button[data-score-category="choice"]');
    await expect(choice).toHaveAttribute('data-value-state', 'preview');
    await choice.click();
    await expect(next.locator('[data-product-view="game"]')).toHaveAttribute(
      'data-viewer-turn',
      'true',
    );
    await expect(next.getByRole('button', { name: '굴리기', exact: true })).toBeEnabled();
  } finally {
    await guestContext.close();
  }
});

test('a failed renderer cancels pending lobby audio without completing bootstrap or replacing another tab', async ({
  page,
  context,
}) => {
  await page.goto(PRODUCT_GAME_ORIGIN);
  await start(page);
  await page.locator('[data-room-action="create"] button').click();
  await expect(page.locator('[data-room-code]')).toBeVisible();
  const next = await context.newPage();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let loaded!: () => void;
  const delivered = new Promise<void>((resolve) => {
    loaded = resolve;
  });
  await next.route('**/audio/bgm/lobby/*.mp3', async (route) => {
    await gate;
    await route.continue();
    loaded();
  });
  await next.addInitScript(() => {
    Reflect.set(window, '__recoveryReads', 0);
    Reflect.set(window, '__lobbyAudioRead', false);
    Reflect.set(window, '__lobbyAudioCanceled', false);
    const { fetch } = globalThis;
    Reflect.set(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).includes('/audio/bgm/lobby/')) {
        args[1]?.signal?.addEventListener(
          'abort',
          () => {
            Reflect.set(window, '__lobbyAudioCanceled', true);
          },
          { once: true },
        );
      }
      const response = await fetch(...args);
      if (response.url.includes('/audio/bgm/lobby/')) {
        const readBody = response.arrayBuffer.bind(response);
        response.arrayBuffer = async () => {
          const body = await readBody();
          Reflect.set(window, '__lobbyAudioRead', true);
          return body;
        };
      }
      return response;
    });
    const { getItem } = Storage.prototype;
    Storage.prototype.getItem = function (key: string) {
      if (key === 'recentRoom')
        Reflect.set(window, '__recoveryReads', Number(Reflect.get(window, '__recoveryReads')) + 1);
      return getItem.call(this, key);
    };
  });
  let sockets = 0;
  next.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname.includes('/game-socket/')) sockets += 1;
  });
  try {
    await next.goto(PRODUCT_GAME_ORIGIN);
    await next.getByRole('button', { name: '게임 시작', exact: true }).click();
    await expect(next.locator('[data-dice-canvas-state]')).toHaveAttribute(
      'data-dice-canvas-state',
      'ready',
    );
    await expect(next.locator('[data-screen="loading"]')).toBeVisible();
    await next.getByTestId('dice-canvas').dispatchEvent('webglcontextlost');
    await expect(next.locator('[data-global-failure="runtimeFailure"]')).toBeVisible();
    release();
    await delivered;
    await expect
      .poll(() => next.evaluate(() => Reflect.get(window, '__lobbyAudioCanceled')))
      .toBe(true);
    expect(await next.evaluate(() => Reflect.get(window, '__lobbyAudioRead'))).toBe(false);
    await next.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(await next.evaluate(() => Reflect.get(window, '__recoveryReads'))).toBe(0);
    expect(sockets).toBe(0);
    await expect(next.locator('[data-global-failure="runtimeFailure"]')).toBeVisible();
    await expect(page.locator('[data-global-failure="replaced"]')).toHaveCount(0);
    await expect(page.locator('[data-room-code]')).toBeVisible();
  } finally {
    release();
  }
});

test('a sync failure after successful authentication keeps the prior execution replaced', async ({
  page,
  context,
}) => {
  await page.goto(PRODUCT_GAME_ORIGIN);
  await start(page);
  await page.locator('[data-room-action="create"] button').click();
  await expect(page.locator('[data-room-code]')).toBeVisible();
  const next = await context.newPage();
  let corrupted = 0;
  await next.routeWebSocket('**/game-socket/**', (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => {
      if (typeof message === 'string' && message.startsWith('43')) {
        corrupted += 1;
        socket.send(`${message.slice(0, message.indexOf('['))}[null]`);
      } else socket.send(message);
    });
  });
  await next.goto(PRODUCT_GAME_ORIGIN);
  await start(next);
  await expect(next.locator('[data-screen="lobby"]')).toHaveAttribute(
    'data-reentry-state',
    'refreshRequired',
  );
  expect(corrupted).toBeGreaterThan(0);
  await expect(page.locator('[data-global-failure="replaced"]')).toBeVisible();
  expect(await next.evaluate(() => localStorage.getItem('recentRoom') !== null)).toBe(true);
});
