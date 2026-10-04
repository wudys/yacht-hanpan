import { expect, type Page } from '@playwright/test';

import { test } from '../helpers/test';
import { PRODUCT_GAME_ORIGIN } from '../helpers/test-origins';

const origin = `${PRODUCT_GAME_ORIGIN}/dev/anchors.html`;

for (const locale of ['ko', 'en'] as const) {
  test(`DEV replay entry preserves query options and replays in ${locale}`, async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}?anchor=replay&locale=${locale}`);
    const replay = page.getByRole('button', { name: 'Replay fixture', exact: true });
    await expect(replay).toBeEnabled({ timeout: 30_000 });
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.locator('[data-anchor="replay"]')).toBeVisible();
    await expect(replay).toHaveAttribute('data-authoritative-values', /^\d,\d,\d,\d,\d$/u);
    await expect(replay).toHaveAttribute('data-replay-complete', 'true', { timeout: 20_000 });
    const digest = await replay.getAttribute('data-replay-digest');
    await replay.click();
    await expect(replay).toHaveAttribute('data-replay-complete', 'true', { timeout: 20_000 });
    expect(await replay.getAttribute('data-replay-digest')).toBe(digest);

    await page.goto(
      `${origin}?anchor=replay&locale=${locale}&seed=anchor-query&style=classic&count=2&arrange=1`,
    );
    await expect(replay).toBeEnabled({ timeout: 30_000 });
    await expect(replay).toHaveAttribute('data-authoritative-values', /^\d,\d$/u);
    await expect(replay).toHaveAttribute('data-replay-complete', 'true', { timeout: 20_000 });
    expect(errors).toEqual([]);
  });
}

test('new-turn emphasis visibly highlights the turn pill without shifting its layout', async ({
  page,
}) => {
  await openAnchor(page, 'game');
  const cue = await page.locator('.player-summary').evaluate((summary) => {
    const pill = summary.querySelector('.player-summary__turn')!;
    const before = getComputedStyle(pill).backgroundColor;
    const bounds = pill.getBoundingClientRect().toJSON();
    summary.setAttribute('data-summary-emphasized', 'true');
    const animations = summary.getAnimations({ subtree: true });
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = 0;
    }
    const during = getComputedStyle(pill).backgroundColor;
    for (const animation of animations) animation.finish();
    return {
      before,
      during,
      after: getComputedStyle(pill).backgroundColor,
      bounds,
      afterBounds: pill.getBoundingClientRect().toJSON(),
    };
  });
  expect(cue.during).not.toBe(cue.before);
  expect(cue.after).toBe(cue.before);
  expect(cue.afterBounds).toEqual(cue.bounds);
});

test('recorded table scores retain readable contrast', async ({ page }) => {
  await openAnchor(page, 'result', 'en');
  const contrast = await page
    .locator('tbody td')
    .first()
    .evaluate((cell) => {
      const style = getComputedStyle(cell);
      const luminance = (color: string) => {
        const channels = color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((value) => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
        return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
      };
      const ink = luminance(style.color);
      const surface = luminance(style.backgroundColor);
      return (Math.max(ink, surface) + 0.05) / (Math.min(ink, surface) + 0.05);
    });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
});

async function openAnchor(
  page: Page,
  anchor: string,
  locale: string = 'ko',
  mode: string = 'playing',
) {
  await page.goto(`${origin}?anchor=${anchor}&locale=${locale}&mode=${mode}`);
  await page.locator(`[data-anchor="${anchor}"]`).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page
    .locator('[data-game-logical-canvas] img')
    .evaluateAll((images) =>
      Promise.all(images.map((image) => (image as HTMLImageElement).decode())),
    );
  await expect(page.locator('[data-game-frame-slot]')).toBeVisible();
}

test('scoreboard rounded corners use the product canvas backing', async ({ page }) => {
  await openAnchor(page, 'scoreboard', 'en');
  const colors = await page.locator('[data-game-logical-canvas]').evaluate((canvas) => {
    const probe = document.createElement('span');
    probe.style.backgroundColor = 'var(--product-base-deep)';
    canvas.append(probe);
    const productBase = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      canvas: getComputedStyle(canvas).backgroundColor,
      productBase,
    };
  });
  expect(colors.canvas).toBe(colors.productBase);
});

for (const locale of ['ko', 'en']) {
  test(`bonus tag ${locale} keeps both achievement states readable and reachable at 320px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 568 });
    const appearances = [];
    for (const mode of ['playing', 'bonus-earned']) {
      await openAnchor(page, 'game', locale, mode);
      const earned = mode === 'bonus-earned';
      const action = page.locator('[data-bonus-info-action]');
      await expect(action).toHaveText(locale === 'ko' ? '보너스' : 'Bonus');
      await expect(action).toHaveAccessibleDescription(
        locale === 'ko'
          ? earned
            ? '보너스 달성'
            : '보너스 미달성'
          : earned
            ? 'Bonus earned'
            : 'Bonus not earned',
      );
      const geometry = await action.evaluate((button) => {
        const tag = button.querySelector('.player-summary__bonus')!;
        const icon = button.querySelector('.player-summary__bonus-icon')!;
        const surface = tag.getBoundingClientRect();
        const hit = button.getBoundingClientRect();
        const frame = button.closest('[data-game-logical-canvas]')!.getBoundingClientRect();
        const center = document.elementFromPoint(hit.x + hit.width / 2, hit.y + hit.height / 2);
        const scale = frame.width / 360;
        return {
          fits:
            surface.x >= hit.x &&
            surface.right <= hit.right &&
            surface.y >= hit.y &&
            surface.bottom <= hit.bottom &&
            tag.scrollWidth <= tag.clientWidth,
          hitSize: hit.width / scale >= 43.9 && hit.height / scale >= 43.9,
          reachable: center === button || button.contains(center),
          background: getComputedStyle(tag).backgroundColor,
          mask: getComputedStyle(icon).maskImage,
        };
      });
      expect(geometry.fits).toBe(true);
      expect(geometry.hitSize).toBe(true);
      expect(geometry.reachable).toBe(true);
      appearances.push(geometry);
      await action.click();
      await expect(page.locator('[data-anchor]')).toHaveAttribute('data-last-intent', 'bonus');
      await page.screenshot({ path: testInfo.outputPath(`bonus-tag-${mode}-${locale}-320.png`) });
    }
    expect(appearances[0]!.mask).not.toBe(appearances[1]!.mask);
    expect(appearances[0]!.background).not.toBe(appearances[1]!.background);
  });

  test(`game ${locale} keeps localized score maxima and both turn labels readable at 320px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await openAnchor(page, 'game', locale);
    await expect(page.locator('.score-group-tab span').first()).toHaveText(
      locale === 'ko' ? /^최대 \d+$/u : /^Max \d+$/u,
    );

    for (const mode of ['playing', 'opponent']) {
      await openAnchor(page, 'game', locale, mode);
      const pill = page.locator('.player-summary__turn');
      await expect(pill).toHaveText(
        locale === 'ko'
          ? mode === 'playing'
            ? '내 턴'
            : '상대 턴'
          : mode === 'playing'
            ? 'Your Turn'
            : 'Opponent’s Turn',
      );
      if (mode === 'opponent') await expect(page.locator('.score-group-tab span')).toHaveCount(0);
      const [turn, score, bonus, action, summary, scoreboardFace] = await Promise.all(
        [
          pill,
          page.locator('.player-summary__score'),
          page.locator('.player-summary__bonus-anchor'),
          page.locator('.player-summary > button'),
          page.locator('.player-summary'),
          page.locator('.player-summary > button .ui-icon-button__surface'),
        ].map((locator) => locator.boundingBox()),
      );
      expect(turn!.x + turn!.width).toBeLessThanOrEqual(score!.x);
      expect(score!.x + score!.width).toBeLessThanOrEqual(bonus!.x);
      expect(bonus!.x + bonus!.width).toBeLessThanOrEqual(action!.x);
      expect(
        Math.abs(scoreboardFace!.x + scoreboardFace!.width - summary!.x - summary!.width),
      ).toBeLessThan(0.5);
      expect(Math.abs(action!.y - summary!.y)).toBeLessThan(0.5);
      expect(Math.abs(action!.height - summary!.height)).toBeLessThan(0.5);
      expect(action!.width).toBeGreaterThanOrEqual(scoreboardFace!.width);
      expect(await pill.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      for (const y of [1, action!.height - 1]) {
        await page
          .locator('.player-summary > button')
          .click({ position: { x: action!.width / 2, y } });
        await expect(page.locator('[data-anchor]')).toHaveAttribute(
          'data-last-intent',
          'scoreboard',
        );
      }
      await page.screenshot({ path: testInfo.outputPath(`game-${mode}-${locale}-320.png`) });
    }
  });

  for (const anchor of ['lobby', 'game', 'scoreboard', 'result']) {
    test(`${anchor} ${locale} fits the smallest supported frame with distinct hit targets`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: 320, height: 568 });
      await openAnchor(page, anchor, locale);
      const geometry = await page.evaluate(() => {
        const canvas = document.querySelector('[data-game-logical-canvas]')!;
        const frame = canvas.getBoundingClientRect();
        const scale = frame.width / 360;
        const buttons = [...canvas.querySelectorAll('button')].map((node) => ({
          label: node.getAttribute('aria-label') ?? node.textContent,
          compactScoreTab: node.matches('.score-group-tab'),
          summaryScoreboard: node.matches('.player-summary > .ui-icon-button'),
          rect: node.getBoundingClientRect().toJSON() as {
            x: number;
            y: number;
            width: number;
            height: number;
            right: number;
            bottom: number;
          },
        }));
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
          collisions,
          small: buttons.filter(
            ({ compactScoreTab, summaryScoreboard, rect }) =>
              // Score tabs use a 34px row including its 1px divider: 33px button hit.
              // Summary scoreboard covers its icon width and the entire summary row.
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
          frame: { width: frame.width, height: frame.height },
          documentOverflow: document.documentElement.scrollWidth > innerWidth,
          missingImages: [...canvas.querySelectorAll('img')]
            .filter((node) => !node.complete || node.naturalWidth === 0)
            .map((node) => node.src),
        };
      });
      expect(geometry.collisions).toEqual([]);
      expect(geometry.small).toEqual([]);
      expect(geometry.outside).toEqual([]);
      expect(geometry.documentOverflow).toBe(false);
      expect(geometry.missingImages).toEqual([]);
      expect(geometry.frame.width).toBeCloseTo(320, 0);
      expect(geometry.frame.height).toBeCloseTo(444.44, 0);
      await page.screenshot({ path: testInfo.outputPath(`${anchor}-${locale}-320.png`) });
    });
  }
}

test('preview and recorded score values share size with distinct ink and weight through pending', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await openAnchor(page, 'game');
  const readStyles = () =>
    page.locator('[data-score-value-kind]').evaluateAll((nodes) =>
      nodes.map((node) => {
        const css = getComputedStyle(node);
        return {
          kind: node.getAttribute('data-score-value-kind'),
          color: css.color,
          surface: css.backgroundColor,
          weight: css.fontWeight,
          size: css.fontSize,
          opacity: css.opacity,
        };
      }),
    );
  const before = await readStyles();
  const recorded = before.find(({ kind }) => kind === 'recorded');
  const preview = before.find(({ kind }) => kind === 'preview');
  expect(recorded).toBeDefined();
  expect(preview).toBeDefined();
  expect(Number(recorded?.weight)).toBeGreaterThan(Number(preview?.weight));
  expect(recorded?.size).toBe(preview?.size);
  expect(recorded?.color).not.toBe(preview?.color);
  expect(preview?.surface).toBe(recorded?.surface);
  expect(before.every(({ opacity }) => opacity === '1')).toBe(true);
  await openAnchor(page, 'game', 'ko', 'pending');
  expect(await readStyles()).toEqual(before);
  const lockedCategory = page.locator('[data-score-category="yacht"]');
  const surfaceBeforeHover = await lockedCategory.evaluate((node) => ({
    color: getComputedStyle(node).backgroundColor,
    filter: getComputedStyle(node).filter,
  }));
  await lockedCategory.hover();
  await expect(lockedCategory).toHaveCSS('background-color', surfaceBeforeHover.color);
  await expect(lockedCategory).toHaveCSS('filter', surfaceBeforeHover.filter);
});

test('comparison tables scroll their last category above the footer on desktop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  for (const anchor of ['scoreboard', 'result']) {
    await openAnchor(page, anchor, 'en');
    const last = page.locator('tbody tr').last();
    await last.scrollIntoViewIfNeeded();
    const lastBox = await last.boundingBox();
    const footerBox = await page.getByRole('button').last().boundingBox();
    expect(lastBox).not.toBeNull();
    expect(footerBox).not.toBeNull();
    expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(footerBox!.y + 0.5);
  }
});
