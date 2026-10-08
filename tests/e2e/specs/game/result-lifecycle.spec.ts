import { expect, type Page, type WebSocket } from '@playwright/test';

import { test } from '../../helpers/test';
import { PRODUCT_GAME_ORIGIN } from '../../helpers/test-origins';
import { createTwoPlayerGame } from '../../helpers/two-player-game';
import { frameFit, visibleTextIssues } from '../../helpers/visual-geometry';

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
    const creatorSockets: WebSocket[] = [];
    const guestSockets: WebSocket[] = [];
    // Exclude Vite's development HMR socket; only gameplay transports belong to Result.
    page.on('websocket', (socket) => {
      if (new URL(socket.url()).pathname.startsWith('/game-socket')) creatorSockets.push(socket);
    });
    await page.goto(PRODUCT_GAME_ORIGIN);
    await page.getByRole('button', { name: '게임 시작', exact: true }).click();
    const guestContext = await createTwoPlayerGame(page, browser, {
      onGuestPage(guest: Page) {
        guest.on('websocket', (socket) => {
          if (new URL(socket.url()).pathname.startsWith('/game-socket')) guestSockets.push(socket);
        });
      },
    });
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

      for (const sockets of [creatorSockets, guestSockets]) {
        expect(sockets.length).toBeGreaterThan(0);
        await expect.poll(() => sockets.every((socket) => socket.isClosed())).toBe(true);
      }
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

test('explicit forfeit renders both authoritative Result perspectives at 320px', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  const guestContext = await createTwoPlayerGame(page, browser, {
    locale: 'en',
    viewport: { width: 320, height: 568 },
  });
  try {
    const guest = guestContext.pages()[0]!;
    await page.getByRole('button', { name: '설정', exact: true }).click();
    await page.getByRole('button', { name: '기권하기', exact: true }).click();

    const forfeiterResult = page.locator('[data-product-view="result"]');
    const winnerResult = guest.locator('[data-product-view="result"]');
    await expect(forfeiterResult).toBeVisible();
    await expect(winnerResult).toBeVisible();
    await expect(forfeiterResult).toHaveAttribute('data-result-outcome', 'opponent-win');
    await expect(winnerResult).toHaveAttribute('data-result-outcome', 'viewer-win');
    await expect(forfeiterResult.locator('[data-result-reason]')).toHaveAttribute(
      'data-result-reason',
      'forfeit',
    );
    await expect(winnerResult.locator('[data-result-reason]')).toHaveAttribute(
      'data-result-reason',
      'forfeit',
    );
    await expect(forfeiterResult.locator('[data-score-row]')).toHaveCount(12);
    await expect(winnerResult.locator('[data-score-row]')).toHaveCount(12);
    await expect(
      forfeiterResult.locator('[data-score-player="opponent"] [data-result-crown="true"]'),
    ).toHaveCount(1);
    await expect(
      winnerResult.locator('[data-score-player="viewer"] [data-result-crown="true"]'),
    ).toHaveCount(1);
    await page.evaluate(() => document.fonts.ready);
    await guest.evaluate(() => document.fonts.ready);
    for (const result of [forfeiterResult, winnerResult]) {
      await result.evaluate((node) =>
        Promise.all(node.getAnimations({ subtree: true }).map((animation) => animation.finished)),
      );
    }
    for (const resultPage of [page, guest]) await expectResultLayout(resultPage);

    // The text observation must reject horizontal and vertical clipping, then recover.
    const heading = forfeiterResult.getByRole('heading');
    const originalStyle = await heading.getAttribute('style');
    for (const dimension of ['width', 'height'] as const) {
      try {
        await heading.evaluate((node: HTMLElement, axis) => {
          node.style[axis] = '1px';
          node.style.overflow = 'hidden';
          node.style.whiteSpace = 'nowrap';
        }, dimension);
        const issues = await visibleTextIssues(heading);
        if (dimension === 'width') expect(issues).toContain('scroll width exceeds text box');
        else
          expect(issues).toEqual(
            expect.arrayContaining([expect.stringMatching(/^text clipped by /u)]),
          );
      } finally {
        await heading.evaluate((node, style) => {
          if (style === null) node.removeAttribute('style');
          else node.setAttribute('style', style);
        }, originalStyle);
      }
      expect(await visibleTextIssues(heading)).toEqual([]);
    }
    await page.screenshot({
      path: `/tmp/hanpan-forfeit-result-loser-ko-320-${test.info().project.name}.png`,
    });
    await guest.screenshot({
      path: `/tmp/hanpan-forfeit-result-winner-en-320-${test.info().project.name}.png`,
    });
    for (const [resultPage, locale] of [
      [page, 'ko'],
      [guest, 'en'],
    ] as const) {
      await resultPage.setViewportSize({ width: 1440, height: 950 });
      await expect
        .poll(() =>
          resultPage
            .locator('[data-game-frame-slot]')
            .evaluate((node) => node.getBoundingClientRect().width),
        )
        .toBeCloseTo(640, 1);
      await expectResultLayout(resultPage);
      await resultPage.screenshot({
        path: `/tmp/hanpan-fidelity-result-${locale}-desktop-${test.info().project.name}.png`,
      });
    }
  } finally {
    await guestContext.close();
  }
});

async function expectResultLayout(page: Page) {
  const result = page.locator('[data-product-view="result"]');
  const body = result.locator('[data-scroll-body]');
  await body.evaluate((node) => node.scrollTo({ top: 0 }));
  const neighbors =
    '.score-table-player__avatar, [data-result-crown], .scrollable-panel__footer button';
  const text = result.locator(
    'h1, .score-table-player__heading, .score-table-player__total, .score-table-player__summary, thead th, .scrollable-panel__footer button',
  );
  const reason = result.locator('[data-result-reason]');
  const items = [...(await text.all()), reason];
  const textRegions = [];
  for (const item of items) {
    const name = await item.evaluate((node) => node.getAttribute('class') ?? node.tagName);
    expect(
      await visibleTextIssues(item, neighbors, { allowWrapping: item === reason }),
      name,
    ).toEqual([]);
    expect((await frameFit(page, item)).inside, name).toBe(true);
    const bounds = await item.boundingBox();
    expect(bounds, name).not.toBeNull();
    textRegions.push({ name, bounds: bounds! });
  }
  // DOM Range font metrics can extend beyond a tight line-height without visible ink
  // overlap. Compare text layout regions separately from text/decorative collisions.
  for (const [index, region] of textRegions.entries()) {
    for (const other of textRegions.slice(index + 1)) {
      const a = region.bounds;
      const b = other.bounds;
      const overlaps =
        a.x < b.x + b.width - 0.5 &&
        b.x < a.x + a.width - 0.5 &&
        a.y < b.y + b.height - 0.5 &&
        b.y < a.y + a.height - 0.5;
      expect(overlaps, JSON.stringify({ region, other })).toBe(false);
    }
  }
  const footerAction = result.locator('.scrollable-panel__footer button');
  const fit = await frameFit(page, footerAction);
  expect(fit.logicalHeight).toBeGreaterThanOrEqual(43.9);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(
    await footerAction.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return hit === element || element.contains(hit);
    }),
  ).toBe(true);
  const lastRow = result.locator('[data-score-row]').last();
  await lastRow.evaluate((node) => node.scrollIntoView({ block: 'end' }));
  const [lastBox, bodyBox, footerBox] = await Promise.all([
    lastRow.boundingBox(),
    body.boundingBox(),
    footerAction.boundingBox(),
  ]);
  expect(lastBox).not.toBeNull();
  expect(bodyBox).not.toBeNull();
  expect(footerBox).not.toBeNull();
  expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(bodyBox!.y + bodyBox!.height + 0.5);
  expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(footerBox!.y + 0.5);
  for (const value of await lastRow.locator('td').all()) {
    expect(await visibleTextIssues(value, '.scrollable-panel__footer button')).toEqual([]);
    expect((await frameFit(page, value)).inside).toBe(true);
  }
  await body.evaluate((node) => node.scrollTo({ top: 0 }));
}
