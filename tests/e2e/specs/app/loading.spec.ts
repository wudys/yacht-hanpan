import { expect } from '@playwright/test';

import { test } from '../../helpers/test';
import { BUILT_WEB_ORIGIN } from '../../helpers/test-origins';

for (const { locale, width, height, barrier } of [
  { locale: 'ko', width: 320, height: 568, barrier: 'wasm' },
  { locale: 'en', width: 320, height: 568, barrier: 'wasm' },
  { locale: 'ko', width: 1440, height: 950, barrier: 'wasm' },
  { locale: 'ko', width: 320, height: 568, barrier: 'lobby-audio' },
  { locale: 'en', width: 320, height: 568, barrier: 'lobby-audio' },
]) {
  test(`real Loading ${locale} ${width}px advances while required ${barrier} is pending`, async ({
    page,
  }, testInfo) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.setViewportSize({ width, height });
    await page.addInitScript((language) => localStorage.setItem('locale', language), locale);
    const resource = barrier === 'wasm' ? '**/runtime/*.wasm' : '**/audio/bgm/lobby/*.mp3';
    let resourceRequested = false;
    await page.route(resource, async (route) => {
      resourceRequested = true;
      await gate;
      await route.continue();
    });
    try {
      await page.goto(BUILT_WEB_ORIGIN);
      await page
        .getByRole('button', { name: locale === 'ko' ? '게임 시작' : 'Start Game' })
        .click();
      const view = page.locator('.loading-view');
      await expect(view).toBeVisible();
      await expect.poll(() => resourceRequested).toBe(true);
      if (barrier === 'lobby-audio') {
        await expect(page.locator('.web-dice-canvas-host')).toHaveAttribute(
          'data-dice-canvas-state',
          'ready',
        );
        await expect(view).toBeVisible();
      }
      const progressBounds = await view.locator('progress').boundingBox();
      expect(progressBounds).not.toBeNull();
      expect(progressBounds!.width).toBeGreaterThan(100);
      expect(progressBounds!.height).toBeGreaterThan(2);
      await expect
        .poll(() =>
          view.locator('progress').evaluate((node) => (node as HTMLProgressElement).value),
        )
        .toBeGreaterThan(0);
      expect(
        await view.locator('progress').evaluate((node) => (node as HTMLProgressElement).value),
      ).toBeLessThan(1);
      await expect(view.locator('.brand-lockup__logo')).toBeVisible();
      await expect(view.locator('.dice-loader')).toBeVisible();
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(Array.from(document.images, (image) => image.decode()));
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      });
      const clipped = await view.evaluate(
        (node) => node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight,
      );
      expect(clipped).toBe(false);
      await page.screenshot({
        path: `/tmp/hanpan-loading-${barrier}-${locale}-${width}-${testInfo.project.name}.png`,
      });
    } finally {
      release();
    }
    await expect(
      page.getByRole('heading', { name: locale === 'ko' ? '로비' : 'Lobby', exact: true }),
    ).toBeVisible();
  });
}
