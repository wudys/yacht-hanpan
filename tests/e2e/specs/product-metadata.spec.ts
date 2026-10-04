import { expect, test } from '@playwright/test';

import { PRODUCT_GAME_ORIGIN, PRODUCTION_GAME_ORIGIN } from '../helpers/test-origins';

test('built HTML exposes metadata and loadable branded assets before app JavaScript runs', async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto(PRODUCTION_GAME_ORIGIN);
    await expect(page.locator('head title')).toHaveCount(1);
    expect(await page.title()).toMatch(/\S/u);
    await expect(page.locator('head meta[name="description"]')).toHaveAttribute('content', /\S/u);
    await expect(page.locator('head meta[property="og:title"]')).toHaveAttribute(
      'content',
      await page.title(),
    );
    await expect(page.locator('head meta[name="twitter:title"]')).toHaveAttribute(
      'content',
      await page.title(),
    );
    const imagePath = await page.locator('head meta[property="og:image"]').getAttribute('content');
    const iconPath = await page.locator('head link[rel="icon"]').getAttribute('href');
    expect(imagePath).toBeTruthy();
    expect(iconPath).toBeTruthy();
    const image = await context.request.get(new URL(imagePath!, PRODUCTION_GAME_ORIGIN).href);
    expect(image.ok()).toBe(true);
    expect(image.headers()['content-type']).toContain('image/png');
    const bytes = await image.body();
    expect(bytes.subarray(1, 4).toString()).toBe('PNG');
    await expect(page.locator('head meta[property="og:image:width"]')).toHaveAttribute(
      'content',
      String(bytes.readUInt32BE(16)),
    );
    await expect(page.locator('head meta[property="og:image:height"]')).toHaveAttribute(
      'content',
      String(bytes.readUInt32BE(20)),
    );
    const icon = await context.request.get(new URL(iconPath!, PRODUCTION_GAME_ORIGIN).href);
    expect(icon.ok()).toBe(true);
    expect(icon.headers()['content-type']).toContain('image/svg+xml');
    expect(await icon.text()).toContain('<svg');
  } finally {
    await context.close();
  }
});

test('unavailable sharing assets do not become required game-loading resources', async ({
  page,
}) => {
  await page.route('**/assets/game/brand/social-card/**', (route) => route.abort());
  await page.route('**/assets/game/brand/favicon/**', (route) => route.abort());
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  await expect(page.getByRole('button', { name: '게임 만들기', exact: true })).toBeEnabled();
});
