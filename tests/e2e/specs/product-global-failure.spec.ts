import { expect } from '@playwright/test';

import { PRODUCT_GAME_ORIGIN } from '../helpers/product-game';
import { createTestContext, test } from '../helpers/test';

test('landscape guard blocks the retained global failure action', async ({ browser }) => {
  const context = await createTestContext(browser, {
    hasTouch: true,
    viewport: { width: 320, height: 740 },
  });
  try {
    const page = await context.newPage();
    await page.goto(PRODUCT_GAME_ORIGIN);
    await page.getByRole('button', { name: '게임 시작', exact: true }).click();
    await expect(page.getByRole('heading', { name: '로비', exact: true })).toBeVisible();
    await context.setOffline(true);
    const notice = page.locator('[data-global-failure="offline"]');
    await expect(notice).toBeVisible();
    await page.setViewportSize({ width: 740, height: 320 });
    await expect(page.locator('[data-orientation-blocker]')).toBeVisible();
    await expect(page.locator('[data-game-frame-slot]')).toHaveAttribute('inert', '');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(
      await notice.locator('button').evaluate((button) => {
        button.focus();
        return document.activeElement === button;
      }),
    ).toBe(false);
    await page.setViewportSize({ width: 320, height: 740 });
    await expect(page.locator('[data-game-frame-slot]')).not.toHaveAttribute('inert');
    await expect(page.getByRole('alertdialog')).toBeVisible();
  } finally {
    await context.close();
  }
});

for (const locale of ['ko', 'en'] as const) {
  test(`Lobby offline notice retains its screen and clears on reconnect in ${locale}`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    await page.goto(PRODUCT_GAME_ORIGIN);
    await page.getByRole('button', { name: '게임 시작', exact: true }).click();
    await page.getByRole('button', { name: '설정', exact: true }).click();
    if (locale === 'en') await page.getByRole('button', { name: 'English', exact: true }).click();
    const settings = await page
      .getByRole('region', { name: locale === 'ko' ? '설정' : 'Settings', exact: true })
      .elementHandle();
    const canvas = await page.locator('.web-dice-canvas-host canvas').elementHandle();
    try {
      await context.setOffline(true);
      const notice = page.locator('[data-global-failure="offline"]');
      await expect(notice).toBeVisible();
      await expect(notice.getByRole('button')).toHaveCount(1);
      await expect(
        notice.getByRole('button', {
          name: locale === 'ko' ? '새로고침' : 'Refresh',
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.getByTestId('global-interaction-surface')).toHaveAttribute('inert', '');
      const frame = await page.locator('[data-game-frame-slot]').boundingBox();
      const panel = await notice.locator('.scrollable-panel').boundingBox();
      expect(frame).not.toBeNull();
      expect(panel).not.toBeNull();
      expect(panel!.x).toBeGreaterThanOrEqual(frame!.x);
      expect(panel!.y).toBeGreaterThanOrEqual(frame!.y);
      expect(panel!.x + panel!.width).toBeLessThanOrEqual(frame!.x + frame!.width + 0.1);
      expect(panel!.y + panel!.height).toBeLessThanOrEqual(frame!.y + frame!.height + 0.1);
      await page.screenshot({
        path: `/tmp/hanpan-offline-${locale}-320-${test.info().project.name}.png`,
      });
      await context.setOffline(false);
      await expect(notice).toHaveCount(0);
      await expect(page.getByTestId('global-interaction-surface')).not.toHaveAttribute('inert');
      expect(await settings!.evaluate((element) => element.isConnected)).toBe(true);
      expect(await canvas!.evaluate((element) => element.isConnected)).toBe(true);
      await page
        .getByRole('button', { name: locale === 'ko' ? '닫기' : 'Close', exact: true })
        .click();
      await expect(page.locator('[data-room-action="create"] button')).toBeEnabled();
    } finally {
      await context.setOffline(false);
    }
  });
}
