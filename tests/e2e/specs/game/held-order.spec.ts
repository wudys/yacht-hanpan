import { expect, type Page } from '@playwright/test';

import { test } from '../../helpers/test';
import { PRODUCT_GAME_ORIGIN } from '../../helpers/test-origins';
import { createTwoPlayerGame } from '../../helpers/two-player-game';

test.use({ video: 'on' });

async function heldOrder(page: Page): Promise<number[]> {
  return page
    .locator('[data-held="true"]')
    .evaluateAll((dice) => dice.map((die) => Number(die.getAttribute('data-held-slot'))));
}

test('preserves held order for both players and reentry, and scores all five held dice', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  const guestContext = await createTwoPlayerGame(page, browser, {
    viewport: { width: 320, height: 568 },
  });
  try {
    const guest = guestContext.pages()[0]!;
    const expectOrder = async (slots: number[]) => {
      await expect.poll(() => heldOrder(page)).toEqual(slots);
      await expect.poll(() => heldOrder(guest)).toEqual(slots);
      for (const viewer of [page, guest]) {
        for (const slot of slots) {
          const value = await viewer
            .locator(`[data-held-slot="${slot}"] [data-die-face]`)
            .getAttribute('data-die-face');
          await expect(
            viewer.getByRole('button', {
              name: `주사위 조작 ${slot + 1}: ${value}`,
              exact: true,
              pressed: true,
            }),
          ).toHaveCount(1);
        }
      }
    };
    await page.getByRole('button', { name: '굴리기', exact: true }).click();
    await expect(page.locator('[data-dice-presentation-phase]')).toHaveAttribute(
      'data-dice-presentation-phase',
      'settled',
    );
    await page.locator('[data-settled-slot="3"]').click();
    await expectOrder([3]);
    await page.locator('[data-settled-slot="0"]').click();
    await expectOrder([3, 0]);
    await page.locator('[data-held-slot="3"]').click();
    await expectOrder([0]);
    await expect(page.locator('[data-settled-slot]')).toHaveCount(4);
    expect(
      await page
        .locator('[data-settled-slot]')
        .evaluateAll((dice) => dice.map((die) => die.getAttribute('data-settled-slot'))),
    ).toEqual(['1', '2', '3', '4']);
    await page.locator('[data-settled-slot="3"]').click();
    await expectOrder([0, 3]);

    const heldValues = await page
      .locator('[data-held="true"] [data-die-face]')
      .evaluateAll((dice) => dice.map((die) => die.getAttribute('data-die-face')));
    await page.getByRole('button', { name: '다시 굴리기', exact: true }).click();
    await expect(page.locator('[data-dice-presentation-phase]')).toHaveAttribute(
      'data-dice-presentation-phase',
      'rolling',
    );
    await expect(page.locator('[data-value-state="preview"]')).toHaveCount(0);
    await expectOrder([0, 3]);
    await expect(page.locator('[data-dice-presentation-phase]')).toHaveAttribute(
      'data-dice-presentation-phase',
      'settled',
    );
    expect(
      await page
        .locator('[data-held="true"] [data-die-face]')
        .evaluateAll((dice) => dice.map((die) => die.getAttribute('data-die-face'))),
    ).toEqual(heldValues);

    for (const [index, slot] of [4, 1, 2].entries()) {
      await page.locator(`[data-settled-slot="${slot}"]`).click();
      await expectOrder([0, 3, ...[4, 1, 2].slice(0, index + 1)]);
    }
    await expect(page.locator('[data-settled-slot]')).toHaveCount(0);
    await expect(page.locator('[data-dice-presentation-phase]')).toHaveAttribute(
      'data-dice-presentation-phase',
      'settled',
    );
    await expect(page.getByRole('button', { name: '다시 굴리기', exact: true })).toBeDisabled();
    await page.locator('[data-score-tab="lower"]').click();
    await expect(page.locator('[data-score-category="choice"]')).toBeEnabled();
    await guest.locator('[data-score-tab="lower"]').click();
    await expect(guest.locator('[data-score-category="choice"]')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await page.screenshot({ path: testInfo.outputPath('all-held-scoring.png') });

    // A full page reload must recover order from the server, not local click history.
    await page.reload();
    await page.getByRole('button', { name: '게임 시작', exact: true }).click();
    await expect(page.locator('[data-product-view="game"]')).toBeVisible();
    await expectOrder([0, 3, 4, 1, 2]);
    await expect(page.locator('[data-dice-presentation-phase]')).toHaveAttribute(
      'data-dice-presentation-phase',
      'settled',
    );
    await page.locator('[data-held-slot="1"]').click();
    await expectOrder([0, 3, 4, 2]);
    await page.locator('[data-settled-slot="1"]').click();
    await expectOrder([0, 3, 4, 2, 1]);
    await page.locator('[data-score-tab="lower"]').click();
    const choice = page.locator('[data-score-category="choice"]');
    await expect(choice).toHaveAttribute('data-value-state', 'preview');
    await expect(choice).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('restored-all-held-scoring.png') });
    await guest.screenshot({ path: testInfo.outputPath('opponent-held-order.png') });
    await choice.click();
    await expect(page.locator('[data-product-view="game"]')).toHaveAttribute(
      'data-viewer-turn',
      'false',
    );
    await expect(guest.locator('[data-product-view="game"]')).toHaveAttribute(
      'data-viewer-turn',
      'true',
    );
    await expectOrder([]);
    await expect(guest.locator('[data-value-state="preview"]')).toHaveCount(0);
  } finally {
    await guestContext.close();
  }
});
