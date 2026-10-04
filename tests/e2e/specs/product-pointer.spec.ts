import { expect, type Locator } from '@playwright/test';

import { PRODUCT_GAME_ORIGIN } from '../helpers/product-game';
import { createTestContext, test } from '../helpers/test';

const origin = `${PRODUCT_GAME_ORIGIN}/dev/anchors.html`;

for (const selector of [
  '.ui-button',
  '.ui-icon-button',
  '.score-category-cell:not([aria-disabled="true"])',
  '.held-dice-rack__slot:not(:disabled)',
  '.player-summary__bonus-action',
  '.score-group-tab',
]) {
  test(`desktop pointer feedback follows hover and press: ${selector}`, async ({ page }) => {
    await page.goto(`${origin}?anchor=game`);
    const control = page.locator(selector).first();
    await expect(control).toBeVisible();
    await expect(control).toHaveCSS('cursor', 'pointer');
    const scoreCell = selector.startsWith('.score-category-cell');
    const surface = scoreCell ? control.locator('.score-category-cell__value') : control;
    const feedbackProperty = scoreCell ? 'background-color' : 'filter';
    const idle = await visualFeedback(surface, feedbackProperty);
    const controlIdle = await visualFeedback(control, 'background-color');
    const controlFilter = await visualFeedback(control, 'filter');
    const frame = page.locator('[data-game-logical-canvas]');
    const frameIdle = await visualFeedback(frame, 'background-color');
    await control.hover();
    await expect.poll(() => visualFeedback(surface, feedbackProperty)).not.toEqual(idle);
    const hover = await visualFeedback(surface, feedbackProperty);
    if (scoreCell) {
      expect(await visualFeedback(control, 'background-color')).toBe(controlIdle);
      expect(await visualFeedback(control, 'filter')).toBe(controlFilter);
    }
    expect(await visualFeedback(frame, 'background-color')).toEqual(frameIdle);
    await page.mouse.down();
    await expect.poll(() => visualFeedback(surface, feedbackProperty)).not.toEqual(hover);
    expect(await visualFeedback(surface, feedbackProperty)).not.toEqual(idle);
    if (scoreCell) {
      expect(await visualFeedback(control, 'background-color')).toBe(controlIdle);
      expect(await visualFeedback(control, 'filter')).toBe(controlFilter);
    }
    expect(await visualFeedback(frame, 'background-color')).toEqual(frameIdle);
    await page.mouse.up();
    await expect.poll(() => visualFeedback(surface, feedbackProperty)).toEqual(hover);
    await page.mouse.move(0, 0);
    await expect.poll(() => visualFeedback(surface, feedbackProperty)).toEqual(idle);
    await expect(control).toHaveCSS('outline-style', 'none');
  });
}

test('readonly roll status has no hover feedback and pending does not flash a wait cursor', async ({
  page,
}) => {
  await page.goto(`${origin}?anchor=game&mode=opponent`);
  const status = page.locator('.roll-status');
  await status.hover();
  await expect(status).toHaveCSS('cursor', 'default');
  await expect(status).toHaveCSS('filter', 'none');

  await page.goto(`${origin}?anchor=game&mode=pending`);
  const pending = page.locator('.ui-button');
  await expect(pending).toHaveAttribute('aria-disabled', 'true');
  await expect(pending).toHaveCSS('cursor', 'pointer');
  await expect(pending).toHaveCSS('filter', 'none');
  for (const control of await page.locator('[data-interaction-locked="true"]').all()) {
    await expect(control).toHaveCSS('cursor', 'pointer');
    await control.hover();
    await expect(control).toHaveCSS('filter', 'none');
  }
  await expect(page.locator('.score-category-cell[data-value-state="recorded"]')).toHaveCSS(
    'cursor',
    'default',
  );
});

for (const locale of ['ko', 'en'] as const) {
  test(`profile style tabs select by pointer in ${locale}`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('locale', value), locale);
    await page.goto(PRODUCT_GAME_ORIGIN);
    await page
      .getByRole('button', { name: locale === 'ko' ? '게임 시작' : 'Start Game', exact: true })
      .click();
    await page
      .getByRole('button', {
        name: locale === 'ko' ? '프로필 설정' : 'Profile Settings',
        exact: true,
      })
      .click();
    const tabs = page.getByRole('tab');
    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'false');
    await tabs.first().click();
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'false');
  });
}

test('touch activation does not leave desktop hover feedback behind', async ({ browser }) => {
  const context = await createTestContext(browser, {
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await page.goto(`${origin}?anchor=game`);
  expect(await page.evaluate(() => matchMedia('(hover: hover)').matches)).toBe(false);
  const control = page.locator('.player-summary__bonus-action');
  await control.tap();
  await expect(page.locator('[data-anchor]')).toHaveAttribute('data-last-intent', 'bonus');
  await expect(control).toHaveCSS('filter', 'none');
  await expect(control).toHaveCSS('outline-style', 'none');
  await context.close();
});

/** Wait for the control's own transitions before comparing its visible surface. */
async function visualFeedback(locator: Locator, property: string): Promise<string> {
  return locator.evaluate(async (node, cssProperty) => {
    await Promise.all(node.getAnimations().map((animation) => animation.finished.catch(() => {})));
    return getComputedStyle(node).getPropertyValue(cssProperty);
  }, property);
}
