import { expect } from '@playwright/test';

import { test } from '../../helpers/test';
import { BUILT_WEB_ORIGIN, PRODUCT_GAME_ORIGIN } from '../../helpers/test-origins';

for (const origin of [PRODUCT_GAME_ORIGIN, BUILT_WEB_ORIGIN]) {
  for (const locale of ['ko', 'en'] as const) {
    test(`privacy notice in ${locale} at ${origin}`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 568 });
      await page.addInitScript((value) => localStorage.setItem('locale', value), locale);
      // Keep the script request local; collection guards must work before the vendor runs.
      await page.route('https://www.googletagmanager.com/gtag/js?*', (route) =>
        route.fulfill({ contentType: 'application/javascript', body: '' }),
      );
      const telemetryRequests: string[] = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.hostname === 'www.googletagmanager.com' && url.pathname === '/gtag/js') return;
        if (/google-analytics|googletagmanager|sentry\.io/u.test(request.url()))
          telemetryRequests.push(request.url());
      });
      await page.goto(origin);
      expect(
        await page.evaluate(() => {
          const tag = document.querySelector<HTMLScriptElement>('script[data-hanpan-analytics]')!;
          const id = new URL(tag.src).searchParams.get('id');
          return {
            disabled: Reflect.get(window, `ga-disable-${id}`),
            initialized: 'hanpanGtag' in window,
          };
        }),
      ).toEqual({ disabled: true, initialized: false });
      const link = page.getByRole('button', {
        name: locale === 'ko' ? '개인정보처리방침' : 'Privacy Policy',
        exact: true,
      });
      await link.click();
      const notice = page.getByRole('dialog');
      await expect(notice).toBeVisible();
      await expect(page.locator('.web-dice-canvas-host canvas')).toHaveCount(0);
      const close = notice.getByRole('button', {
        name: locale === 'ko' ? '닫기' : 'Close',
        exact: true,
      });
      const frame = await page.locator('.game-logical-canvas').boundingBox();
      const surface = await page.locator('.web-privacy-surface').boundingBox();
      expect(surface!.x).toBeGreaterThan(frame!.x);
      expect(surface!.y + surface!.height).toBeLessThan(frame!.y + frame!.height);
      await page.screenshot({
        path: test.info().outputPath(`privacy-${locale}.png`),
      });
      await close.click();
      await expect(notice).toHaveCount(0);
      await link.click();
      await page.context().setOffline(true);
      const offline = page.getByRole('alertdialog');
      await expect(offline).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByTestId('global-interaction-surface')).toHaveAttribute('inert', '');
      const refresh = offline.getByRole('button', {
        name: locale === 'ko' ? '새로고침' : 'Refresh',
        exact: true,
      });
      await refresh.focus();
      await expect(refresh).toBeFocused();
      expect(
        await page
          .locator('.web-privacy-overlay')
          .evaluate((element) => element.contains(document.activeElement)),
      ).toBe(false);
      await page.screenshot({
        path: test.info().outputPath(`privacy-offline-${locale}.png`),
      });
      await page.context().setOffline(false);
      await expect(offline).toHaveCount(0);
      await expect(notice).toBeVisible();
      await notice
        .getByRole('button', { name: locale === 'ko' ? '확인' : 'OK', exact: true })
        .click();
      await expect(notice).toHaveCount(0);
      await link.click();
      await page.context().setOffline(true);
      await expect(page.getByRole('alertdialog')).toBeVisible();
      await expect(page.getByTestId('global-interaction-surface')).toHaveAttribute('inert', '');
      await refresh.focus();
      // End a retained local layer under the higher guard to observe native inert cleanup.
      await page
        .locator('.web-privacy-overlay')
        .getByRole('button', {
          name: locale === 'ko' ? '닫기' : 'Close',
          exact: true,
          includeHidden: true,
        })
        .evaluate((button: HTMLButtonElement) => button.click());
      await expect(page.locator('.web-privacy-overlay')).toHaveCount(0);
      await expect(page.getByTestId('global-interaction-surface')).toHaveAttribute('inert', '');
      await expect(refresh).toBeFocused();
      await page.context().setOffline(false);
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      expect(telemetryRequests).toEqual([]);
    });
  }
}
