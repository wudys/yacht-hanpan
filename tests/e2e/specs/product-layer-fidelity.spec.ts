import { expect, type Page } from '@playwright/test';

import { joinProductGame, PRODUCT_GAME_ORIGIN } from '../helpers/product-game';
import { test } from '../helpers/test';

const boundaryViewports = [
  { width: 320, height: 568 },
  { width: 430, height: 932 },
  { width: 1440, height: 950 },
];

for (const locale of ['ko', 'en'] as const) {
  test(`Lobby surface geometry survives frame scaling in ${locale}`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('locale', value), locale);
    await page.goto(PRODUCT_GAME_ORIGIN);
    await page
      .getByRole('button', { name: locale === 'ko' ? '게임 시작' : 'Start Game', exact: true })
      .click();
    for (const layer of ['profile', 'join', 'waiting'] as const) {
      const label =
        layer === 'profile'
          ? locale === 'ko'
            ? '프로필 설정'
            : 'Profile Settings'
          : layer === 'join'
            ? locale === 'ko'
              ? '게임 참가'
              : 'Join Game'
            : null;
      if (label) await page.getByRole('button', { name: label, exact: true }).click();
      else await page.locator('[data-room-action="create"] button').click();
      const surface = page.locator('.scrollable-panel');
      await expect(surface).toBeVisible();
      if (layer === 'waiting') await expect(page.locator('[data-room-code]')).toBeVisible();
      let initialGeometry: unknown;
      for (const viewport of boundaryViewports) {
        await page.setViewportSize(viewport);
        await expect
          .poll(() =>
            page
              .locator('[data-game-logical-canvas]')
              .evaluate((node) => node.getBoundingClientRect().width),
          )
          .toBeCloseTo(Math.min(viewport.width, 640), 1);
        const geometry = await surface.evaluate((node) => {
          const style = getComputedStyle(node);
          const body = node.querySelector('[data-scroll-body]')!;
          return {
            width: style.width,
            height: style.height,
            rows: style.gridTemplateRows,
            overflow: getComputedStyle(body).overflowY,
          };
        });
        if (initialGeometry === undefined) initialGeometry = geometry;
        expect(geometry).toEqual(initialGeometry);
        expect(geometry.overflow).toBe('auto');
        const frame = await page.locator('[data-game-logical-canvas]').boundingBox();
        const panel = await surface.boundingBox();
        expect(frame).not.toBeNull();
        expect(panel).not.toBeNull();
        expect(panel!.x).toBeGreaterThanOrEqual(frame!.x - 0.5);
        expect(panel!.y).toBeGreaterThanOrEqual(frame!.y - 0.5);
        expect(panel!.x + panel!.width).toBeLessThanOrEqual(frame!.x + frame!.width + 0.5);
        expect(panel!.y + panel!.height).toBeLessThanOrEqual(frame!.y + frame!.height + 0.5);
        const header = await surface.locator('.scrollable-panel__header').boundingBox();
        const body = await surface.locator('[data-scroll-body]').boundingBox();
        expect(header).not.toBeNull();
        expect(body).not.toBeNull();
        expect(header!.y + header!.height).toBeLessThanOrEqual(body!.y + 0.5);
        if (layer === 'join') {
          const footer = await surface.locator('[data-layer-footer]').boundingBox();
          expect(footer).not.toBeNull();
          expect(body!.y + body!.height).toBeLessThanOrEqual(footer!.y + 0.5);
        }
      }
      await surface
        .getByRole('button', {
          name:
            layer === 'waiting'
              ? locale === 'ko'
                ? '대기 취소'
                : 'Cancel'
              : locale === 'ko'
                ? '닫기'
                : 'Close',
          exact: true,
        })
        .click();
      await expect(surface).toHaveCount(0);
    }
  });
}

test('bonus popover stays anchored through resize, locale changes and reopening', async ({
  page,
  browser,
}, testInfo) => {
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  const guest = await joinProductGame(page, browser);
  try {
    for (const locale of ['ko', 'en'] as const) {
      if (locale === 'en') {
        await page.getByRole('button', { name: '설정', exact: true }).click();
        await page.locator('[data-settings-locale="en"]').click();
        await page.getByRole('button', { name: 'Close', exact: true }).click();
      }
      const action = page.locator('[data-bonus-info-action]');
      await action.click();
      for (const viewport of boundaryViewports) {
        await page.setViewportSize(viewport);
        await expect
          .poll(() =>
            page
              .locator('[data-game-logical-canvas]')
              .evaluate((node) => node.getBoundingClientRect().width),
          )
          .toBeCloseTo(Math.min(viewport.width, 640), 1);
        await expect
          .poll(() =>
            page.locator('.player-summary').evaluate((summary) => {
              const label = summary
                .querySelector('.player-summary__bonus')!
                .getBoundingClientRect();
              const popover = summary.querySelector<HTMLElement>('.player-summary__bonus-popover')!;
              const box = popover.getBoundingClientRect();
              const frame = summary.closest('[data-game-logical-canvas]')!.getBoundingClientRect();
              const scale = frame.width / 360;
              const pointer = Number.parseFloat(
                getComputedStyle(popover).getPropertyValue('--bonus-pointer-left'),
              );
              return (
                box.left >= frame.left - 1 &&
                box.right <= frame.right + 1 &&
                Math.abs((box.top - label.bottom) / scale - 8) < 1 &&
                Math.abs(box.left + pointer * scale - (label.left + label.width / 2)) < 1
              );
            }),
          )
          .toBe(true);
        const layout = await page.getByRole('dialog').evaluate((dialog) => {
          const details = dialog.querySelector('.bonus-info-popover__details')!;
          const detailsBox = details.getBoundingClientRect();
          const arrow = details
            .querySelector('.bonus-info-popover__arrow')!
            .getBoundingClientRect();
          const award = details
            .querySelector('.bonus-info-popover__award')!
            .getBoundingClientRect();
          const label = details
            .querySelector('.bonus-info-popover__subtotal-label')!
            .getBoundingClientRect();
          const value = details
            .querySelector('.bonus-info-popover__value')!
            .getBoundingClientRect();
          const close = dialog.querySelector('button')!.getBoundingClientRect();
          const title = dialog.querySelector('h2')!.getBoundingClientRect();
          const scale =
            dialog.closest('[data-game-logical-canvas]')!.getBoundingClientRect().width / 360;
          return {
            sameLine:
              Math.abs(label.top + label.height / 2 - value.top - value.height / 2) < 1 &&
              Math.abs(value.top + value.height / 2 - award.top - award.height / 2) < 1,
            compactGap: value.left - label.right <= 8 * scale,
            balancedPadding:
              Math.abs(label.left - detailsBox.left - (detailsBox.right - award.right)) < 1,
            rewardAfterProgress: value.right <= arrow.left && arrow.right <= award.left,
            fits: details.scrollWidth <= details.clientWidth,
            closeAfterTitle: close.left >= title.right,
          };
        });
        expect(layout).toEqual({
          sameLine: true,
          compactGap: true,
          balancedPadding: true,
          rewardAfterProgress: true,
          fits: true,
          closeAfterTitle: true,
        });
        if (viewport.width === 320) {
          await page.screenshot({ path: testInfo.outputPath(`bonus-${locale}-320.png`) });
        }
      }
      await page.getByRole('dialog').getByRole('button').click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await action.click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await action.click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
  } finally {
    await guest.close();
  }
});

test('settings, profile and admission share the same panel and header treatment', async ({
  page,
}) => {
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  const surfaces = [];
  for (const action of ['설정', '프로필 설정', '게임 참가']) {
    await page.getByRole('button', { name: action, exact: true }).click();
    const panel = page.locator('.scrollable-panel');
    await expect(panel).toBeVisible();
    surfaces.push(
      await panel.evaluate((surface) => {
        const style = getComputedStyle(surface);
        const header = surface.querySelector('.scrollable-panel__header')!;
        const title = header.querySelector('h1')!;
        const icon = header.querySelector('.ui-icon-button__surface')!;
        const scale = surface.getBoundingClientRect().width / (surface as HTMLElement).offsetWidth;
        return {
          background: style.backgroundColor,
          border: style.borderTopColor,
          radius: style.borderTopLeftRadius,
          titleSize: getComputedStyle(title).fontSize,
          closeInset: Math.round(
            (icon.getBoundingClientRect().left - surface.getBoundingClientRect().left) / scale,
          ),
        };
      }),
    );
    await page.getByRole('button', { name: '닫기', exact: true }).click();
  }
  expect(surfaces[1]).toEqual(surfaces[0]);
  expect(surfaces[2]).toEqual(surfaces[0]);
});

async function captureLargerViewports(page: Page, name: string): Promise<void> {
  for (const viewport of [
    { width: 390, height: 844, frameWidth: 390, label: 'mobile' },
    { width: 1440, height: 950, frameWidth: 640, label: 'desktop' },
  ]) {
    await page.setViewportSize(viewport);
    await expect
      .poll(() =>
        page
          .locator('[data-game-frame-slot]')
          .evaluate((node) => node.getBoundingClientRect().width),
      )
      .toBeCloseTo(viewport.frameWidth, 1);
    await page.screenshot({
      path: `/tmp/hanpan-fidelity-${name}-${viewport.label}-${test.info().project.name}.png`,
    });
  }
}

async function returnToMobile(page: Page): Promise<void> {
  await page.setViewportSize({ width: 320, height: 568 });
  await expect
    .poll(() =>
      page.locator('[data-game-frame-slot]').evaluate((node) => node.getBoundingClientRect().width),
    )
    .toBeCloseTo(320, 1);
}

for (const locale of ['ko', 'en'] as const) {
  test(`Loading completion and settings/profile fidelity at mobile and desktop in ${locale}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.addInitScript((language) => {
      localStorage.setItem('locale', language);
      const observeCompletionFrame = () => {
        if (
          document.querySelector('[data-screen="loading"] .loading-view__percentage')
            ?.textContent === '100%'
        ) {
          document.documentElement.dataset.loadingCompletedFrame = 'true';
          return;
        }
        requestAnimationFrame(observeCompletionFrame);
      };
      requestAnimationFrame(observeCompletionFrame);
    }, locale);
    const en = locale === 'en';
    await page.goto(PRODUCT_GAME_ORIGIN);
    await captureLargerViewports(page, `entry-${locale}`);
    await returnToMobile(page);
    await page.getByRole('button', { name: en ? 'Start Game' : '게임 시작', exact: true }).click();
    await expect(page.locator('[data-screen="lobby"]')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-loading-completed-frame', 'true');
    await page.getByRole('button', { name: en ? 'Settings' : '설정', exact: true }).click();
    const settings = page.locator('.settings-view');
    await expect(settings.locator('[data-settings-row]')).toHaveCount(3);
    await expect(settings.locator('.settings-view__asset-icon')).toHaveCount(3);
    await expect(settings.getByRole('switch')).toHaveCount(2);
    const close = settings.getByRole('button', { name: en ? 'Close' : '닫기', exact: true });
    const hit = await close.boundingBox();
    const visual = await close.locator('.ui-icon-button__surface').boundingBox();
    const frame = await page.locator('[data-game-logical-canvas]').boundingBox();
    const frameScale = frame!.width / 360;
    expect(hit!.width / frameScale).toBeGreaterThanOrEqual(43.9);
    expect(hit!.height / frameScale).toBeGreaterThanOrEqual(43.9);
    expect(visual!.width).toBeLessThan(hit!.width * 0.8);
    await page.screenshot({
      path: `/tmp/hanpan-fidelity-settings-${locale}-${test.info().project.name}.png`,
    });
    await captureLargerViewports(page, `settings-${locale}`);
    await returnToMobile(page);
    await close.click();
    await page.locator('.lobby-view__profile .player-avatar').click();
    const choices = page.locator('.character-choice-grid__choice');
    await expect(choices).toHaveCount(12);
    await choices.nth(6).click();
    await expect(choices.nth(6)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.character-choice-grid__selection')).toHaveCount(1);
    await expect(choices.nth(6).locator('.character-choice-grid__selection')).toBeVisible();
    await page.screenshot({
      path: `/tmp/hanpan-fidelity-profile-${locale}-${test.info().project.name}.png`,
    });
    await captureLargerViewports(page, `profile-${locale}`);
    await page.getByRole('button', { name: en ? 'Close' : '닫기', exact: true }).click();
    await page
      .getByRole('button', { name: en ? 'Profile Settings' : '프로필 설정', exact: true })
      .click();
    await expect(choices).toHaveCount(12);
    await page.getByRole('button', { name: en ? 'Close' : '닫기', exact: true }).click();
    await captureLargerViewports(page, `lobby-${locale}`);
  });
}

test('opaque scoreboard covers the persistent dice Canvas without remounting it', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  const guest = await joinProductGame(page, browser);
  try {
    await page.getByRole('button', { name: '굴리기', exact: true }).click();
    const host = page.locator('.web-dice-canvas-host');
    await expect(host).toHaveAttribute('data-dice-presentation-phase', 'settled');
    const canvas = await host.locator('canvas').elementHandle();
    await captureLargerViewports(page, 'game');
    expect(
      await canvas!.evaluate((node) => {
        if (!(node instanceof HTMLCanvasElement)) throw new Error('Expected dice canvas');
        return node.width / node.getBoundingClientRect().width;
      }),
    ).toBeGreaterThanOrEqual(1);
    await returnToMobile(page);
    await page.getByRole('button', { name: '점수판', exact: true }).click();
    const scoreboard = page.locator('[data-game-layer="scoreboard"]');
    await expect(scoreboard).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expect(scoreboard.locator('.player-avatar img')).toHaveCount(2);
    await scoreboard.locator('img').evaluateAll((images) =>
      Promise.all(
        images.map((image) => {
          if (!(image instanceof HTMLImageElement)) throw new Error('Expected scoreboard image');
          return image.decode();
        }),
      ),
    );
    // decode resolves before the browser necessarily paints the decoded image.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const area = await host.boundingBox();
    expect(area).not.toBeNull();
    const withCanvas = await page.screenshot({
      clip: area!,
      path: `/tmp/hanpan-scoreboard-with-canvas-${test.info().project.name}.png`,
    });
    await host.evaluate((element) => {
      element.style.visibility = 'hidden';
    });
    try {
      const withoutCanvas = await page.screenshot({
        clip: area!,
        path: `/tmp/hanpan-scoreboard-without-canvas-${test.info().project.name}.png`,
      });
      // A fully opaque foreground panel must look identical with or without
      // the retained Canvas beneath it; hit testing alone misses paint leaks.
      expect(withCanvas.equals(withoutCanvas)).toBe(true);
    } finally {
      await host.evaluate((element) => element.style.removeProperty('visibility'));
    }
    expect(await canvas!.evaluate((element) => element.isConnected)).toBe(true);
    await page.screenshot({
      path: `/tmp/hanpan-fidelity-scoreboard-${test.info().project.name}.png`,
    });
    await captureLargerViewports(page, 'scoreboard');
  } finally {
    await guest.close();
  }
});

for (const locale of ['ko', 'en'] as const) {
  test(`scoreboard skips the current achievement but preserves the next roll in ${locale}`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000);
    // Force only the display category to make this browser layer regression deterministic.
    // Admission, command execution, physical playback and the root deadline remain real.
    await page.route('**/src/runtime/dice/achievement-selection.ts', async (route) => {
      await route.fulfill({
        contentType: 'application/javascript',
        body: "export function selectFeaturedCombination() { return 'yacht'; }",
      });
    });
    await page.addInitScript((value) => localStorage.setItem('locale', value), locale);
    await page.setViewportSize({ width: 320, height: 740 });
    await page.goto(PRODUCT_GAME_ORIGIN);
    await page
      .getByRole('button', { name: locale === 'ko' ? '게임 시작' : 'Start Game', exact: true })
      .click();
    const guest = await joinProductGame(page, browser);
    try {
      await page
        .getByRole('button', { name: locale === 'ko' ? '굴리기' : 'Roll', exact: true })
        .click();
      const sequence = page.locator('[data-achievement-kind="yacht"]');
      const host = page.locator('[data-dice-presentation-phase]');
      await expect(sequence).toBeVisible();
      await page
        .getByRole('button', { name: locale === 'ko' ? '점수판' : 'Scoreboard', exact: true })
        .click();
      await page
        .getByRole('button', { name: locale === 'ko' ? '닫기' : 'Close', exact: true })
        .click();
      await expect(sequence).toHaveCount(0);
      await expect(host).toHaveAttribute('data-dice-presentation-phase', 'achievement');
      await expect(page.locator('button[data-score-category]').first()).toBeDisabled();
      await page.screenshot({ path: test.info().outputPath(`achievement-skipped-${locale}.png`) });
      await expect(host).toHaveAttribute('data-dice-presentation-phase', 'settled');
      await page
        .getByRole('button', { name: locale === 'ko' ? '다시 굴리기' : 'Roll again', exact: true })
        .click();
      await expect(sequence).toBeVisible();
      await page
        .getByRole('button', { name: locale === 'ko' ? '설정' : 'Settings', exact: true })
        .click();
      await page
        .getByRole('button', { name: locale === 'ko' ? '닫기' : 'Close', exact: true })
        .click();
      await expect(sequence).toBeVisible();
    } finally {
      await guest.close();
    }
  });
}
