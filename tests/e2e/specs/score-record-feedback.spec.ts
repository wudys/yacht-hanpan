import { expect } from '@playwright/test';

import { test } from '../helpers/test';

for (const [scenario, score, locale] of [
  ['yacht-zero', 0, 'ko'],
  ['yacht', 50, 'en'],
] as const) {
  test(`Yacht ${score} selects the matching record effect without granting input`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    await page.goto(
      `/dev/anchors.html?anchor=game&feedback=${scenario}&elapsed=250&recorder=opponent&locale=${locale}`,
    );
    const cell = page.locator('button[data-score-category="yacht"]');
    await expect(cell).toHaveAttribute('data-score-confirmed', 'true');
    await expect(cell.locator('[data-score-value-kind="recorded"]')).toHaveText(String(score));
    await expect(cell).toHaveAttribute('data-input-available', 'false');
    await expect(cell.locator('.score-feedback__sweep')).toBeAttached();
    if (score === 0) {
      expect(await cell.locator('.score-feedback__particle').count()).toBeGreaterThan(0);
      await expect(cell.locator('[data-yacht-ring]')).toHaveCount(0);
    } else {
      await expect(cell.locator('[data-yacht-ring="recorded"]')).toBeAttached();
      await expect(cell.locator('.score-feedback__particle')).toHaveCount(0);
    }
    await page.evaluate(() => document.fonts.ready);
    await cell.evaluate((element) => {
      for (const animation of element.getAnimations({ subtree: true })) {
        animation.pause();
        animation.currentTime = 0;
      }
    });
    await page.screenshot({ path: test.info().outputPath(`yacht-${score}-${locale}-320.png`) });
  });
}
