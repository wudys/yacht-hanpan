import { readdir } from 'node:fs/promises';

import { expect } from '@playwright/test';

import { test } from '../../helpers/test';
import { BUILT_WEB_ORIGIN } from '../../helpers/test-origins';

for (const failure of ['script', 'style', 'both'] as const) {
  for (const locale of ['ko', 'en'] as const) {
    test(`${failure} product chunk failure provides readable click recovery in ${locale}`, async ({
      page,
    }, testInfo) => {
      const files = await readdir(new URL('../../../../apps/web/dist/assets/', import.meta.url));
      const productFiles = files.filter((file) => /^start-web-app-.*\.(?:js|css)$/u.test(file));
      expect(productFiles.some((file) => file.endsWith('.js'))).toBe(true);
      expect(productFiles.some((file) => file.endsWith('.css'))).toBe(true);
      const failedFiles = productFiles.filter(
        (file) => failure === 'both' || file.endsWith(failure === 'script' ? '.js' : '.css'),
      );
      let fail = true;
      let blocked = 0;
      await page.route(`${BUILT_WEB_ORIGIN}/assets/*`, async (route) => {
        const filename = new URL(route.request().url()).pathname.split('/').at(-1);
        if (fail && filename && failedFiles.includes(filename)) {
          blocked += 1;
          await route.abort();
        } else {
          await route.continue();
        }
      });
      await page.setViewportSize({ width: 320, height: 568 });
      await page.addInitScript((value) => localStorage.setItem('locale', value), locale);
      await page.goto(BUILT_WEB_ORIGIN);
      const title = locale === 'ko' ? '불러오기 실패' : 'Loading failed';
      const refresh = page.getByRole('button', {
        name: locale === 'ko' ? '새로고침' : 'Refresh',
        exact: true,
      });
      await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
      await expect(refresh).toBeInViewport();
      expect(blocked).toBeGreaterThan(0);
      const fits = await page
        .locator('[data-startup-failure]')
        .evaluate(
          (element) =>
            element.scrollWidth <= element.clientWidth &&
            element.scrollHeight <= element.clientHeight,
        );
      expect(fits).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`startup-${failure}-${locale}-320.png`),
      });
      fail = false;
      await refresh.click();
      await expect(
        page.getByRole('button', {
          name: locale === 'ko' ? '게임 시작' : 'Start Game',
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.locator('[data-startup-failure]')).toHaveCount(0);
    });
  }
}
