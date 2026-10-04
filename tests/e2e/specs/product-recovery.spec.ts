import { expect, type WebSocketRoute } from '@playwright/test';

import { joinProductGame, PRODUCT_GAME_ORIGIN } from '../helpers/product-game';
import { createTestContext, test } from '../helpers/test';

for (const locale of ['ko', 'en'] as const) {
  test(`the opponent’s first socket connection has no disconnect or reconnect notice in ${locale}`, async ({
    page,
    browser,
  }, testInfo) => {
    const english = locale === 'en';
    await page.addInitScript((value) => localStorage.setItem('locale', value), locale);
    await page.goto(PRODUCT_GAME_ORIGIN);
    await page
      .getByRole('button', { name: english ? 'Start Game' : '게임 시작', exact: true })
      .click();
    await page.locator('[data-room-action="create"] button').click();
    const codeView = page.locator('[data-room-code]');
    await expect(codeView).toBeVisible();
    const code = await codeView.getAttribute('data-room-code');

    const guestContext = await createTestContext(browser);
    try {
      const guest = await guestContext.newPage();
      let connectGuest: (() => void) | undefined;
      // HTTP admission starts the host's Game before the guest opens its first socket.
      await guest.routeWebSocket(/\/game-socket\//u, (socket) => {
        connectGuest = () => {
          socket.connectToServer();
        };
      });
      await guest.goto(PRODUCT_GAME_ORIGIN);
      await guest.getByRole('button', { name: '게임 시작', exact: true }).click();
      await guest.getByRole('button', { name: '게임 참가', exact: true }).click();
      await guest.getByRole('textbox').fill(code!);
      await guest.getByRole('button', { name: '참가하기', exact: true }).click();

      await expect(page.locator('[data-screen="game"]')).toBeVisible();
      await expect.poll(() => connectGuest !== undefined).toBe(true);
      const notice = page.locator('.game-board__presence');
      expect(await notice.textContent()).toBe('');
      connectGuest!();
      await expect(guest.locator('[data-screen="game"]')).toBeVisible();
      expect(await notice.textContent()).toBe('');
      await page.screenshot({ path: testInfo.outputPath(`first-connection-${locale}.png`) });
    } finally {
      await guestContext.close();
    }
  });

  test(`Game reconnect keeps the open layer and timer while synchronizing in ${locale}`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(60_000);
    let activeSocket: WebSocketRoute | undefined;
    let holdSync = false;
    let releaseSync: (() => void) | undefined;
    await page.routeWebSocket(/\/game-socket\//u, (socket) => {
      activeSocket = socket;
      const server = socket.connectToServer();
      server.onMessage((message) => {
        // Delay a real full-sync ack, not a fabricated game snapshot or connection.
        if (
          holdSync &&
          typeof message === 'string' &&
          message.startsWith('43') &&
          message.includes('serverTime')
        ) {
          releaseSync = () => socket.send(message);
          return;
        }
        socket.send(message);
      });
    });
    await page.setViewportSize({ width: 320, height: 740 });
    await page.goto(PRODUCT_GAME_ORIGIN);
    await page.getByRole('button', { name: '게임 시작', exact: true }).click();
    const guestContext = await joinProductGame(page, browser);
    try {
      const guest = guestContext.pages()[0]!;
      await page.getByRole('button', { name: '굴리기', exact: true }).click();
      await expect(page.locator('.web-dice-canvas-host')).toHaveAttribute(
        'data-dice-presentation-phase',
        'settled',
      );
      await page.getByRole('button', { name: '설정', exact: true }).click();
      if (locale === 'en') await page.getByRole('button', { name: 'English', exact: true }).click();
      const settings = page.locator('.web-settings-overlay');
      const settingsHandle = await settings.elementHandle();
      const settingsBounds = await page.locator('.settings-view').boundingBox();
      expect(settingsBounds).not.toBeNull();
      expect(settingsBounds!.x + settingsBounds!.width).toBeLessThanOrEqual(320);
      expect(settingsBounds!.y + settingsBounds!.height).toBeLessThanOrEqual(500 * (320 / 360));
      for (const control of await settings.locator('button').all()) {
        const bounds = await control.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
          settingsBounds!.x + settingsBounds!.width,
        );
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
          settingsBounds!.y + settingsBounds!.height,
        );
      }
      await page.screenshot({
        path: `/tmp/hanpan-recovery-before-${locale}-320-${test.info().project.name}.png`,
      });
      const timer = page.locator('.game-board__timer');
      const beforeTimer = await timer.textContent();
      const canvasHandle = await page.locator('.web-dice-canvas-host canvas').elementHandle();
      expect(canvasHandle).not.toBeNull();
      holdSync = true;
      expect(activeSocket).toBeDefined();
      await activeSocket!.close({ code: 1012, reason: 'recovery regression test' });
      const surface = page.locator('[data-game-interaction-surface]');
      await expect(surface).toHaveAttribute('inert', '');
      await expect(page.locator('[data-game-recovery-overlay]')).toBeVisible();
      await expect(page.locator('[data-game-recovery-overlay]')).toHaveAttribute(
        'data-game-recovery-overlay',
        'synchronizing',
      );
      await expect.poll(() => releaseSync !== undefined).toBe(true);
      await expect(guest.locator('[data-game-interaction-surface]')).not.toHaveAttribute('inert');
      await expect(timer).not.toHaveText(beforeTimer!);
      await page.screenshot({
        path: `/tmp/hanpan-recovery-${locale}-320-${test.info().project.name}.png`,
      });
      holdSync = false;
      releaseSync!();
      await expect(page.locator('[data-game-recovery-overlay]')).toHaveCount(0);
      await expect(surface).not.toHaveAttribute('inert');
      expect(await settingsHandle!.evaluate((element) => element.isConnected)).toBe(true);
      expect(await canvasHandle!.evaluate((element) => element.isConnected)).toBe(true);
      await page
        .getByRole('button', { name: locale === 'en' ? 'Close' : '닫기', exact: true })
        .click();
      await page
        .getByRole('button', { name: locale === 'en' ? 'Roll again' : '다시 굴리기', exact: true })
        .click();
      await expect(page.locator('button[data-score-category="ones"]')).toHaveAttribute(
        'data-value-state',
        'preview',
      );
    } finally {
      await guestContext.close();
    }
  });
}

test('Game recovery budget ends with refresh-only notice and preserves authority', async ({
  page,
  browser,
}) => {
  test.setTimeout(60_000);
  let activeSocket: WebSocketRoute | undefined;
  let disconnected = false;
  await page.routeWebSocket(/\/game-socket\//u, (socket) => {
    if (disconnected) {
      void socket.close({ code: 1012 });
      return;
    }
    activeSocket = socket;
    socket.connectToServer();
  });
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  const guestContext = await joinProductGame(page, browser);
  try {
    await page.evaluate(() => {
      // Keep the opaque authority in the browser; never print it in test output.
      Object.defineProperty(window, '__recoveryAuthority', {
        value: localStorage.getItem('recentRoom'),
      });
    });
    disconnected = true;
    await activeSocket!.close({ code: 1012 });
    await expect(page.locator('[data-game-recovery-overlay]')).toBeVisible();
    const terminal = page.locator('[data-game-recovery-terminal="refreshRequired"]');
    await expect(terminal).toBeVisible({ timeout: 35_000 });
    await expect(terminal).toHaveAccessibleName('안내');
    await expect(terminal.getByRole('button')).toHaveCount(1);
    await expect(terminal.getByRole('button')).toHaveText('새로고침');
    expect(
      await page.evaluate(
        () =>
          localStorage.getItem('recentRoom') !== null &&
          localStorage.getItem('recentRoom') === Reflect.get(window, '__recoveryAuthority'),
      ),
    ).toBe(true);
    await page.screenshot({
      path: `/tmp/hanpan-recovery-terminal-320-${test.info().project.name}.png`,
    });
    await terminal.getByRole('button').click();
    await expect(page.getByRole('button', { name: '게임 시작', exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('recentRoom') !== null)).toBe(true);
  } finally {
    await guestContext.close();
  }
});
