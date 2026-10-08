import { expect, type Page } from '@playwright/test';

import { test } from '../../helpers/test';
import { PRODUCT_GAME_ORIGIN } from '../../helpers/test-origins';
import { createTwoPlayerGame } from '../../helpers/two-player-game';

async function assertProductGeometry(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.locator('[data-game-logical-canvas] img').evaluateAll((images) =>
    Promise.all(
      images.map((image) => {
        if (!(image instanceof HTMLImageElement)) throw new Error('Expected product image');
        return image.decode();
      }),
    ),
  );
  const geometry = await page.locator('[data-game-logical-canvas]').evaluate((canvas) => {
    const frame = canvas.getBoundingClientRect();
    const scale = frame.width / 360;
    const buttons = [...canvas.querySelectorAll('button')]
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          getComputedStyle(node).visibility === 'visible' &&
          !node.closest('[inert], [aria-hidden="true"]')
        );
      })
      .map((node) => {
        const rect = node.getBoundingClientRect();
        const center = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return {
          label: node.getAttribute('aria-label') ?? node.textContent,
          compactScoreTab: node.matches('.score-group-tab'),
          summaryScoreboard: node.matches('.player-summary > .ui-icon-button'),
          reachable: center === node || (center !== null && node.contains(center)),
          rect: rect.toJSON() as {
            x: number;
            y: number;
            width: number;
            height: number;
            right: number;
            bottom: number;
          },
        };
      });
    const collisions: string[] = [];
    for (let a = 0; a < buttons.length; a++) {
      for (let b = a + 1; b < buttons.length; b++) {
        const one = buttons[a]!,
          two = buttons[b]!;
        if (
          Math.min(one.rect.right, two.rect.right) - Math.max(one.rect.x, two.rect.x) > 0.5 &&
          Math.min(one.rect.bottom, two.rect.bottom) - Math.max(one.rect.y, two.rect.y) > 0.5
        ) {
          collisions.push(`${one.label} / ${two.label}`);
        }
      }
    }
    return {
      count: buttons.length,
      collisions,
      small: buttons.filter(
        ({ compactScoreTab, summaryScoreboard, rect }) =>
          // Tabs have a 33px hit plus 1px divider; summary scoreboard uses icon width and the full row height.
          (!summaryScoreboard && rect.width / scale < 43.9) ||
          rect.height / scale < (compactScoreTab ? 32.9 : 43.9),
      ),
      outside: buttons.filter(
        ({ rect }) =>
          rect.x < frame.x - 0.5 ||
          rect.right > frame.right + 0.5 ||
          rect.y < frame.y - 0.5 ||
          rect.bottom > frame.bottom + 0.5,
      ),
      unreachable: buttons.filter(({ reachable }) => !reachable),
      frame: { width: frame.width, height: frame.height },
      documentOverflow: document.documentElement.scrollWidth > innerWidth,
      missingImages: [...canvas.querySelectorAll('img')]
        .filter((node) => !node.complete || node.naturalWidth === 0)
        .map((node) => node.src),
    };
  });
  expect(geometry.count).toBeGreaterThan(0);
  expect(geometry.collisions).toEqual([]);
  expect(geometry.small).toEqual([]);
  expect(geometry.outside).toEqual([]);
  expect(geometry.unreachable).toEqual([]);
  expect(geometry.documentOverflow).toBe(false);
  expect(geometry.missingImages).toEqual([]);
  expect(geometry.frame.width).toBeCloseTo(320, 0);
  expect(geometry.frame.height).toBeCloseTo(444.44, 0);
}

for (const locale of ['ko', 'en'] as const) {
  for (const scene of ['lobby', 'game', 'scoreboard'] as const) {
    test(`product ${scene} ${locale} fits the smallest supported frame with distinct hit targets`, async ({
      page,
      browser,
    }, testInfo) => {
      await page.setViewportSize({ width: 320, height: 568 });
      await page.addInitScript((language) => localStorage.setItem('locale', language), locale);
      const english = locale === 'en';
      await page.goto(PRODUCT_GAME_ORIGIN);
      await page
        .getByRole('button', { name: english ? 'Start Game' : '게임 시작', exact: true })
        .click();
      await expect(page.locator('[data-product-view="lobby"]')).toBeVisible();
      if (scene === 'lobby') {
        await expect(page.locator('[data-product-view="lobby"] button')).toHaveCount(4);
        await assertProductGeometry(page);
        for (const action of [
          english ? 'Settings' : '설정',
          english ? 'Profile Settings' : '프로필 설정',
          english ? 'Join Game' : '게임 참가',
        ]) {
          await page.getByRole('button', { name: action, exact: true }).click();
          await expect(page.locator('.scrollable-panel')).toBeVisible();
          await page.getByRole('button', { name: english ? 'Close' : '닫기', exact: true }).click();
          await expect(page.locator('.scrollable-panel')).toHaveCount(0);
        }
        await page.locator('[data-room-action="create"] button').click();
        await expect(page.locator('[data-room-code]')).toBeVisible();
        await page
          .getByRole('button', { name: english ? 'Cancel' : '대기 취소', exact: true })
          .click();
        await expect(page.locator('.scrollable-panel')).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath(`${scene}-${locale}-320.png`) });
        return;
      }
      const guest = await createTwoPlayerGame(page, browser, {
        locale,
        viewport: { width: 320, height: 568 },
      });
      try {
        await page.getByRole('button', { name: english ? 'Roll' : '굴리기', exact: true }).click();
        await expect(page.locator('[data-dice-presentation-phase]')).toHaveAttribute(
          'data-dice-presentation-phase',
          'settled',
        );
        if (scene === 'game') {
          await page.locator('[data-settled-slot="0"]').click();
          await expect(page.locator('[data-held-slot="0"]')).toHaveAttribute(
            'aria-pressed',
            'true',
          );
          await expect(
            page.locator('[data-score-cell][data-input-available="true"]').first(),
          ).toBeEnabled();
        } else {
          await page
            .getByRole('button', { name: english ? 'Scoreboard' : '점수판', exact: true })
            .click();
          await expect(page.locator('[data-game-layer="scoreboard"]')).toBeVisible();
        }
        await assertProductGeometry(page);
        await page.screenshot({ path: testInfo.outputPath(`${scene}-${locale}-320.png`) });
        if (scene === 'scoreboard') {
          await page
            .locator('[data-layer-footer]')
            .getByRole('button', { name: english ? 'Close' : '닫기', exact: true })
            .click();
          await expect(page.locator('[data-game-layer="scoreboard"]')).toHaveCount(0);
        }
      } finally {
        await guest.close();
      }
    });
  }
}
