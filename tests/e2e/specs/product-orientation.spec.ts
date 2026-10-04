import { expect } from '@playwright/test';

import { joinProductGame, PRODUCT_GAME_ORIGIN } from '../helpers/product-game';
import { createTestContext, test } from '../helpers/test';

for (const locale of ['ko', 'en'] as const) {
  test(`portrait return synchronizes before unlocking Game in ${locale}`, async ({
    browser,
  }, testInfo) => {
    const context = await createTestContext(browser, {
      hasTouch: true,
      viewport: { width: 320, height: 740 },
    });
    const page = await context.newPage();
    let holdSync = false;
    let heldSyncCount = 0;
    let releaseSync: (() => void) | undefined;
    await page.routeWebSocket(/\/game-socket\//u, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        if (
          holdSync &&
          typeof message === 'string' &&
          message.startsWith('43') &&
          message.includes('serverTime')
        ) {
          heldSyncCount += 1;
          releaseSync = () => socket.send(message);
          return;
        }
        socket.send(message);
      });
    });
    try {
      await page.goto(PRODUCT_GAME_ORIGIN);
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
      await page.getByRole('button', { name: '게임 시작', exact: true }).click();
      const guestContext = await joinProductGame(page, browser);
      try {
        await page.getByRole('button', { name: '설정', exact: true }).click();
        if (locale === 'en')
          await page.getByRole('button', { name: 'English', exact: true }).click();
        const settings = await page.locator('.web-settings-overlay').elementHandle();
        const canvas = await page.locator('.web-dice-canvas-host canvas').elementHandle();
        await page.setViewportSize({ width: 740, height: 320 });
        await expect(page.locator('[data-orientation-blocker]')).toBeVisible();
        holdSync = true;
        await page.evaluate(() => {
          const probe = { unlockedFrames: 0, frame: 0 };
          Reflect.set(window, '__portraitRecoveryProbe', probe);
          const sample = () => {
            const surface = document.querySelector('[data-game-interaction-surface]');
            if (
              innerHeight > innerWidth &&
              !document.querySelector('[data-orientation-blocker]') &&
              surface &&
              !surface.hasAttribute('inert')
            ) {
              probe.unlockedFrames += 1;
            }
            probe.frame = requestAnimationFrame(sample);
          };
          probe.frame = requestAnimationFrame(sample);
        });
        await page.setViewportSize({ width: 320, height: 740 });
        await expect.poll(() => releaseSync !== undefined).toBe(true);
        const surface = page.locator('[data-game-interaction-surface]');
        await expect(surface).toHaveAttribute('inert', '');
        await expect(page.locator('[data-game-recovery-overlay]')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`portrait-sync-${locale}-320.png`) });
        const unlockedFrames = await page.evaluate(() => {
          const probe = Reflect.get(window, '__portraitRecoveryProbe') as {
            unlockedFrames: number;
            frame: number;
          };
          cancelAnimationFrame(probe.frame);
          return probe.unlockedFrames;
        });
        expect(unlockedFrames).toBe(0);
        expect(heldSyncCount).toBe(1);
        holdSync = false;
        releaseSync!();
        await expect(page.locator('[data-game-recovery-overlay]')).toHaveCount(0);
        await expect(surface).not.toHaveAttribute('inert');
        expect(await settings!.evaluate((element) => element.isConnected)).toBe(true);
        expect(await canvas!.evaluate((element) => element.isConnected)).toBe(true);
        await page
          .getByRole('button', { name: locale === 'en' ? 'Close' : '닫기', exact: true })
          .click();
        await page
          .getByRole('button', { name: locale === 'en' ? 'Roll' : '굴리기', exact: true })
          .click();
        await expect(page.locator('button[data-score-category="ones"]')).toHaveAttribute(
          'data-value-state',
          'preview',
        );
      } finally {
        await guestContext.close();
      }
    } finally {
      await context.close();
    }
  });
}
