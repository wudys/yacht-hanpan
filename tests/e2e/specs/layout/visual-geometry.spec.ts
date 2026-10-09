import { expect } from '@playwright/test';

import { test } from '../../helpers/test';
import { visibleTextIssues } from '../../helpers/visual-geometry';

for (const width of [200, 5]) {
  test(`retains opaque text geometry at ${width}px after a transient title disappears`, async ({
    page,
  }) => {
    await page.setContent(`
    <div id="effect" style="opacity: 0">
      <div id="title" style="width: 5px; overflow: hidden; white-space: nowrap">Full House</div>
    </div>
  `);
    const observation = visibleTextIssues(page.locator('#title'), '', { minimumOpacity: 0.8 });
    void observation.catch(() => {});
    await page.evaluate(async (width) => {
      // Ignore entry geometry; inspect the readable or clipped opaque frame instead.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const effect = document.querySelector<HTMLElement>('#effect')!;
      document.querySelector<HTMLElement>('#title')!.style.width = `${width}px`;
      effect.style.opacity = '1';
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      effect.remove();
    }, width);
    await expect(page.locator('#title')).toHaveCount(0);
    const issues = await observation;
    if (width === 200) expect(issues).toEqual([]);
    else expect(issues).toContain('scroll width exceeds text box');
  });
}

test('rejects text that disappears before reaching readable opacity', async ({ page }) => {
  await page.setContent('<div id="title" style="opacity: 0">Full House</div>');
  const observation = visibleTextIssues(page.locator('#title'), '', { minimumOpacity: 0.8 });
  // Attach the rejection assertion before removing the observed node.
  const rejected = expect(observation).rejects.toThrow(
    'Text disappeared before reaching minimum opacity',
  );
  await page.locator('#title').evaluate((element) => element.remove());
  await rejected;
});
