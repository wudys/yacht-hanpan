import { expect, type WebSocket } from '@playwright/test';

import { joinProductGame, PRODUCT_GAME_ORIGIN } from '../helpers/product-game';
import { test } from '../helpers/test';

for (const { returningSeat, storageUnavailable } of [
  { returningSeat: 0, storageUnavailable: false },
  { returningSeat: 1, storageUnavailable: false },
  { returningSeat: 0, storageUnavailable: true },
] as const) {
  const condition = storageUnavailable
    ? 'after storage access fails during Result cleanup'
    : 'while the opponent stays on the finished Result';
  test(`seat ${returningSeat} creates another room ${condition}`, async ({ page, browser }) => {
    test.setTimeout(60_000);
    const sockets: WebSocket[] = [];
    // Exclude Vite's development HMR socket; only gameplay transports belong to Result.
    page.on('websocket', (socket) => {
      if (new URL(socket.url()).pathname.startsWith('/game-socket')) sockets.push(socket);
    });
    await page.goto(PRODUCT_GAME_ORIGIN);
    await page.getByRole('button', { name: '게임 시작', exact: true }).click();
    const guestContext = await joinProductGame(page, browser);
    try {
      const guest = guestContext.pages()[0]!;
      const returning = returningSeat === 0 ? page : guest;
      const staying = returningSeat === 0 ? guest : page;
      expect(await page.evaluate(() => localStorage.getItem('clientId'))).not.toBe(
        await guest.evaluate(() => localStorage.getItem('clientId')),
      );
      // Inject access loss at the storage boundary; this is not a native policy-change test.
      const restoreStorage = storageUnavailable
        ? await returning.evaluateHandle(() => {
            const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
            Object.defineProperty(window, 'localStorage', {
              configurable: true,
              get() {
                throw new DOMException('Storage access denied', 'SecurityError');
              },
            });
            return () => {
              Object.defineProperty(window, 'localStorage', descriptor);
            };
          })
        : null;
      await page.getByRole('button', { name: '설정', exact: true }).click();
      await page.getByRole('button', { name: '기권하기', exact: true }).click();
      await expect(page.locator('[data-product-view="result"]')).toBeVisible();
      await expect(guest.locator('[data-product-view="result"]')).toBeVisible();

      await expect
        .poll(() => sockets.length > 0 && sockets.every((socket) => socket.isClosed()))
        .toBe(true);
      if (restoreStorage !== null) {
        await restoreStorage.evaluate((restore) => restore());
        await restoreStorage.dispose();
      }
      const retiredCandidate = await returning.evaluate(() => localStorage.getItem('recentRoom'));
      for (const player of [page, guest]) {
        if (storageUnavailable && player === returning) {
          expect(retiredCandidate).not.toBeNull();
        } else {
          await expect
            .poll(() => player.evaluate(() => localStorage.getItem('recentRoom')))
            .toBeNull();
        }
      }

      await staying.context().setOffline(true);
      await returning.getByRole('button', { name: '로비로 돌아가기', exact: true }).click();
      await returning.locator('[data-room-action="create"] button').click();
      await expect(returning.locator('[data-room-code]')).toBeVisible();
      await expect(returning.getByText('이미 상대를 기다리는 게임이 있습니다.')).toHaveCount(0);
      const newCandidate = await returning.evaluate(() => localStorage.getItem('recentRoom'));
      expect(newCandidate).not.toBeNull();
      expect(newCandidate).not.toBe(retiredCandidate);
      await expect(staying.locator('[data-product-view="result"]')).toBeVisible();
      await staying.screenshot({ path: test.info().outputPath('offline-result.png') });
      await returning.screenshot({ path: test.info().outputPath('next-room.png') });
      await staying.context().setOffline(false);
      await staying.reload();
      await staying.getByRole('button', { name: '게임 시작', exact: true }).click();
      await expect(staying.locator('[data-screen="lobby"]')).toBeVisible();
      await expect(staying.locator('[data-product-view="result"]')).toHaveCount(0);
    } finally {
      await guestContext.close();
    }
  });
}
