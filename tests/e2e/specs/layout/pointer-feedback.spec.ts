import { type BrowserContext, expect, type Locator } from '@playwright/test';

import { createSocketPacketObserver } from '../../helpers/socket-packets';
import { createTestContext, test } from '../../helpers/test';
import { PRODUCT_GAME_ORIGIN } from '../../helpers/test-origins';
import { createTwoPlayerGame } from '../../helpers/two-player-game';

for (const selector of [
  '.ui-button',
  '.ui-icon-button',
  '.score-category-cell:not([aria-disabled="true"])',
  '.held-dice-rack__slot:not(:disabled)',
  '.player-summary__bonus-action',
  '.score-group-tab',
]) {
  test(`desktop pointer feedback follows hover and press: ${selector}`, async ({
    page,
    browser,
  }) => {
    let commandCount = 0;
    page.on('websocket', (socket) => {
      const packets = createSocketPacketObserver();
      socket.on('framesent', ({ payload }) => {
        if (packets.observeClient(payload)?.kind === 'command') commandCount += 1;
      });
      socket.on('framereceived', ({ payload }) => packets.observeServer(payload));
      socket.once('close', () => packets.dispose());
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(PRODUCT_GAME_ORIGIN);
    await page.getByRole('button', { name: '게임 시작', exact: true }).click();
    const guestContext = await createTwoPlayerGame(page, browser);
    try {
      if (selector.startsWith('.score-category-cell') || selector.startsWith('.held-dice-rack')) {
        await page.getByRole('button', { name: '굴리기', exact: true }).click();
        await expect(page.locator('[data-dice-presentation-phase]')).toHaveAttribute(
          'data-dice-presentation-phase',
          'settled',
        );
        await page.locator('[data-score-tab="upper"]').click();
      }
      if (selector.startsWith('.held-dice-rack')) {
        await page.locator('[data-settled-slot="0"]').click();
        await expect(page.locator('[data-held-slot="0"]')).toHaveAttribute('aria-pressed', 'true');
      }
      const control = page
        .locator(
          selector === '.ui-button'
            ? '.roll-action-rail .ui-button'
            : selector === '.ui-icon-button'
              ? '.player-summary .ui-icon-button'
              : selector,
        )
        .first();
      await expect(control).toBeVisible();
      await expect(control).toBeEnabled();
      await expect(control).toHaveCSS('cursor', 'pointer');
      expect(
        await page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches),
      ).toBe(true);
      await page.mouse.move(0, 0);
      const commandsBeforePress = commandCount;
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
      // Release outside the target so the feedback check cannot roll, score, release a die or open a layer.
      await page.mouse.move(0, 0);
      await page.mouse.up();
      await control.hover();
      await expect.poll(() => visualFeedback(surface, feedbackProperty)).toEqual(hover);
      await page.mouse.move(0, 0);
      await expect.poll(() => visualFeedback(surface, feedbackProperty)).toEqual(idle);
      await expect(control).toHaveCSS('outline-style', 'none');
      expect(commandCount).toBe(commandsBeforePress);
      await expect(page.locator('[data-bonus-info]')).toHaveCount(0);
      await expect(page.locator('[data-score-table]')).toHaveCount(0);
    } finally {
      await page.mouse.up();
      await guestContext.close();
    }
  });
}

test('readonly roll status has no hover feedback in the actual opponent turn', async ({
  page,
  browser,
}) => {
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  const guestContext = await createTwoPlayerGame(page, browser);
  try {
    const guest = guestContext.pages()[0]!;
    await expect(guest.locator('[data-product-view="game"]')).toHaveAttribute(
      'data-viewer-turn',
      'false',
    );
    const status = guest.locator('.roll-status');
    const idle = await visualFeedback(status, 'background-color');
    await status.hover();
    await expect(status).toHaveCSS('cursor', 'default');
    await expect(status).toHaveCSS('filter', 'none');
    expect(await visualFeedback(status, 'background-color')).toBe(idle);
  } finally {
    await guestContext.close();
  }
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
  let guestContext: BrowserContext | undefined;
  try {
    await page.goto(PRODUCT_GAME_ORIGIN);
    await page.getByRole('button', { name: '게임 시작', exact: true }).tap();
    guestContext = await createTwoPlayerGame(page, browser);
    expect(await page.evaluate(() => matchMedia('(hover: hover)').matches)).toBe(false);
    const control = page.locator('.player-summary__bonus-action');
    await control.tap();
    await expect(page.locator('[data-bonus-info]')).toBeVisible();
    await expect(control).toHaveAttribute('aria-expanded', 'true');
    await expect(control).toHaveCSS('filter', 'none');
    await expect(control).toHaveCSS('outline-style', 'none');
    await page
      .locator('[data-bonus-info]')
      .getByRole('button', { name: '닫기', exact: true })
      .tap();
    await expect(page.locator('[data-bonus-info]')).toHaveCount(0);
  } finally {
    await guestContext?.close();
    await context.close();
  }
});

/** Wait for the control's own transitions before comparing its visible surface. */
async function visualFeedback(locator: Locator, property: string): Promise<string> {
  return locator.evaluate(async (node, cssProperty) => {
    await Promise.all(node.getAnimations().map((animation) => animation.finished.catch(() => {})));
    return getComputedStyle(node).getPropertyValue(cssProperty);
  }, property);
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
