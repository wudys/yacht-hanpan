import { expect, type Locator, type Page } from '@playwright/test';

import { test } from '../helpers/test';
import { PRODUCT_GAME_ORIGIN } from '../helpers/test-origins';

const origin = `${PRODUCT_GAME_ORIGIN}/dev/anchors.html`;

const RESULT_STATES = [
  { mode: 'win', outcome: 'viewer-win', winner: 'viewer', reason: null },
  { mode: 'loss', outcome: 'opponent-win', winner: 'opponent', reason: null },
  { mode: 'draw', outcome: 'draw', winner: null, reason: null },
  { mode: 'forfeit', outcome: 'opponent-win', winner: 'opponent', reason: 'forfeit' },
  { mode: 'timeout', outcome: 'opponent-win', winner: 'opponent', reason: 'timeout' },
  {
    mode: 'connection-ended',
    outcome: 'viewer-win',
    winner: 'viewer',
    reason: 'connection-ended',
  },
] as const;

for (const locale of ['ko', 'en'] as const) {
  for (const state of RESULT_STATES) {
    test(`result ${state.mode} ${locale} uses the complete terminal result surface`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: 320, height: 568 });
      await openAnchor(page, 'result', locale, state.mode);

      const result = page.locator('[data-product-view="result"]');
      await expect(result).toHaveAttribute('data-result-outcome', state.outcome);
      await expect(result).toHaveAttribute('data-winner', state.winner ?? 'none');
      await expect(page.locator('.scrollable-panel__meta')).toHaveCount(0);
      await expect(page.locator('.game-board__turn, .game-board__timer')).toHaveCount(0);

      const reason = page.locator('[data-result-reason]');
      if (state.reason === null) {
        await expect(reason).toHaveCount(0);
      } else {
        await expect(reason).toHaveAttribute('data-result-reason', state.reason);
      }

      const crownedPlayers = page.locator('[data-score-player] [data-result-crown]');
      if (state.winner === null) {
        await expect(crownedPlayers).toHaveCount(0);
      } else {
        await expect(
          page.locator(`[data-score-player="${state.winner}"] [data-result-crown]`),
        ).toHaveCount(1);
      }

      const heading = page.getByRole('heading').first();
      const neighbors =
        '.score-table-player__heading, .score-table-player__avatar, .score-table-player__total, [data-result-crown], .scrollable-panel__footer button';
      expect(await visibleTextIssues(heading, neighbors)).toEqual([]);
      for (const playerHeading of await page.locator('.score-table-player__heading').all()) {
        expect(await visibleTextIssues(playerHeading, neighbors)).toEqual([]);
      }
      if (state.mode === 'win') {
        // Width-only and height-only clipping must both fail this text observation.
        const originalStyle = await heading.getAttribute('style');
        for (const dimension of ['width', 'height'] as const) {
          try {
            await heading.evaluate((node: HTMLElement, axis) => {
              node.style[axis] = '1px';
              node.style.overflow = 'hidden';
              node.style.whiteSpace = 'nowrap';
            }, dimension);
            const issues = await visibleTextIssues(heading, neighbors);
            if (dimension === 'width') {
              expect(issues).toContain('scroll width exceeds text box');
            } else {
              expect(issues).toEqual(
                expect.arrayContaining([expect.stringMatching(/^text clipped by /u)]),
              );
            }
          } finally {
            await heading.evaluate((node, style) => {
              if (style === null) node.removeAttribute('style');
              else node.setAttribute('style', style);
            }, originalStyle);
          }
          expect(await visibleTextIssues(heading, neighbors)).toEqual([]);
        }
      }
      const footerAction = page.locator('.scrollable-panel__footer button');
      await expect(footerAction).toBeVisible();
      const fit = await frameFit(page, footerAction);
      expect(fit.inside).toBe(true);
      expect(fit.logicalHeight).toBeGreaterThanOrEqual(43.9);

      if (state.reason === null) {
        await expect(
          page.locator('[data-score-category="full-house"] td[data-score-state="recorded"]', {
            hasText: '0',
          }),
        ).toHaveCount(state.mode === 'draw' ? 0 : 1);
      } else {
        await expect(
          page.locator('[data-score-category="yacht"] td[data-score-state="empty"]'),
        ).toHaveCount(2);
      }

      await page.screenshot({
        path: testInfo.outputPath(`result-${state.mode}-${locale}-320.png`),
      });

      const lastRow = page.locator('[data-score-row]').last();
      await lastRow.scrollIntoViewIfNeeded();
      const [lastBox, footerBox] = await Promise.all([
        lastRow.boundingBox(),
        footerAction.boundingBox(),
      ]);
      expect(lastBox).not.toBeNull();
      expect(footerBox).not.toBeNull();
      expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(footerBox!.y + 0.5);
    });
  }
}

for (const locale of ['ko', 'en'] as const) {
  for (const kind of ['other', 'yacht'] as const) {
    test(`achievement ${kind} ${locale} stays inside the locked dice board`, async ({
      page,
    }, testInfo) => {
      const achieved =
        kind === 'yacht'
          ? { category: 'yacht', score: '50', stageFace: 'fives' }
          : { category: 'full-house', score: '22', stageFace: 'fours' };
      await page.setViewportSize({ width: 320, height: 568 });
      await openAnchor(page, 'achievement', locale, kind);
      await page.reload();
      await page.locator('[data-anchor="achievement"]').waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page
        .locator('[data-game-logical-canvas] img')
        .evaluateAll((images) =>
          Promise.all(images.map((image) => (image as HTMLImageElement).decode())),
        );

      const sequence = page.locator(`[data-achievement-kind="${kind}"]`);
      await expect(sequence).toBeVisible();
      const content = sequence.locator('.achievement-sequence__content');
      await expect
        .poll(() => content.evaluate((node) => Number.parseFloat(getComputedStyle(node).opacity)))
        .toBeGreaterThanOrEqual(0.8);

      const particles = sequence.locator('[data-achievement-particles]');
      await expect(particles).toHaveCount(kind === 'yacht' ? 1 : 0);
      if (kind === 'yacht') {
        await expect.poll(() => visibleParticleCount(sequence)).toBeGreaterThan(0);
      }
      await page.screenshot({ path: testInfo.outputPath(`achievement-${kind}-${locale}-320.png`) });
      expect(await visibleTextIssues(sequence.locator('.achievement-sequence__title'))).toEqual([]);
      await expect(page.locator('[data-held="true"] [data-die-face="5"]')).toHaveCount(2);
      await expect(page.locator(`[data-anchor-stage-face="${achieved.stageFace}"]`)).toHaveCount(3);
      await expect(
        page.locator(
          `[data-score-category="${achieved.category}"] [data-score-value-kind="preview"]`,
        ),
      ).toHaveText(achieved.score);

      const geometry = await page.evaluate(() => {
        const diceBoard = document.querySelector('.dice-board')!.getBoundingClientRect();
        const overlay = document
          .querySelector('[data-game-achievement-layer]')!
          .getBoundingClientRect();
        const animation = getComputedStyle(
          document.querySelector('.achievement-sequence__content')!,
        );
        return {
          offset: {
            left: Math.abs(diceBoard.left - overlay.left),
            top: Math.abs(diceBoard.top - overlay.top),
            right: Math.abs(diceBoard.right - overlay.right),
            bottom: Math.abs(diceBoard.bottom - overlay.bottom),
          },
          animationDuration: animation.animationDuration,
          animationIterationCount: animation.animationIterationCount,
        };
      });
      expect(Object.values(geometry.offset).every((distance) => distance <= 0.5)).toBe(true);
      expect(geometry.animationDuration).not.toBe('0s');
      expect(geometry.animationIterationCount).toBe('1');
      await expect(page.locator('.roll-action-rail button')).toHaveAttribute(
        'aria-disabled',
        'true',
      );

      await expect
        .poll(() => content.evaluate((node) => Number.parseFloat(getComputedStyle(node).opacity)))
        .toBe(0);
      if (kind === 'yacht') {
        await expect.poll(() => visibleParticleCount(sequence)).toBe(0);
      }
    });
  }
}

async function openAnchor(page: Page, anchor: string, locale: string, mode: string) {
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

async function visibleParticleCount(sequence: Locator): Promise<number> {
  return sequence.locator('.achievement-sequence__particle').evaluateAll(
    (nodes) =>
      nodes.filter((node) => {
        const rect = node.getBoundingClientRect();
        const board = node.closest('[data-achievement-kind]')!.getBoundingClientRect();
        return (
          node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
          rect.width > 0 &&
          rect.height > 0 &&
          rect.left < board.right &&
          rect.right > board.left &&
          rect.top < board.bottom &&
          rect.bottom > board.top
        );
      }).length,
  );
}

/** Inspect text only: image/decorative boxes do not count as rendered lines. */
async function visibleTextIssues(
  locator: Locator,
  neighborSelector: string = '',
): Promise<string[]> {
  return locator.evaluate((node, neighbors) => {
    const issues: string[] = [];
    const tolerance = 0.5; // Viewport CSS pixels, including the frame transform.
    const textRects: DOMRect[] = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode;
      const value = text.textContent ?? '';
      if (!value.trim()) continue;
      const range = document.createRange();
      range.setStart(text, value.length - value.trimStart().length);
      range.setEnd(text, value.trimEnd().length);
      textRects.push(
        ...Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0),
      );
    }
    if (textRects.length === 0) issues.push('no rendered text');
    const lines: { top: number; bottom: number }[] = [];
    for (const rect of textRects) {
      const line = lines.find(
        (candidate) => rect.top < candidate.bottom && candidate.top < rect.bottom,
      );
      if (line) {
        line.top = Math.min(line.top, rect.top);
        line.bottom = Math.max(line.bottom, rect.bottom);
      } else lines.push({ top: rect.top, bottom: rect.bottom });
    }
    if (lines.length !== 1) issues.push(`rendered ${lines.length} text lines`);
    if (node.scrollWidth > node.clientWidth + 1) issues.push('scroll width exceeds text box');
    const bounds = node.getBoundingClientRect();
    for (const rect of textRects) {
      if (rect.left < bounds.left - tolerance || rect.right > bounds.right + tolerance) {
        issues.push(
          `text exceeds element bounds: ${JSON.stringify({ text: rect.toJSON(), bounds: bounds.toJSON() })}`,
        );
      }
      // Glyphs may extend vertically beyond a tight line-height when overflow is visible;
      // the text element, clipping ancestors and frame constrain actual visible bounds.
      for (let parent: Element | null = node; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const clipX = style.overflowX !== 'visible';
        const clipY = style.overflowY !== 'visible';
        const frame = parent.hasAttribute('data-game-logical-canvas');
        const parentBounds = parent.getBoundingClientRect();
        if (
          ((clipX || frame) &&
            (rect.left < parentBounds.left - tolerance ||
              rect.right > parentBounds.right + tolerance)) ||
          ((clipY || frame) &&
            (rect.top < parentBounds.top - tolerance ||
              rect.bottom > parentBounds.bottom + tolerance))
        ) {
          issues.push(
            `text clipped by ${parent.className}: ${JSON.stringify({ text: rect.toJSON(), bounds: parentBounds.toJSON() })}`,
          );
        }
      }
      if (!neighbors) continue;
      for (const neighbor of document.querySelectorAll(neighbors)) {
        if (neighbor === node || node.contains(neighbor) || neighbor.contains(node)) continue;
        const other = neighbor.getBoundingClientRect();
        if (
          rect.left < other.right - tolerance &&
          other.left < rect.right - tolerance &&
          rect.top < other.bottom - tolerance &&
          other.top < rect.bottom - tolerance
        ) {
          issues.push(
            `text overlaps ${neighbor.className}: ${JSON.stringify({ text: rect.toJSON(), neighbor: other.toJSON() })}`,
          );
        }
      }
    }
    return issues;
  }, neighborSelector);
}

async function frameFit(page: Page, locator: Locator) {
  const [frame, action] = await Promise.all([
    page.locator('[data-game-logical-canvas]').boundingBox(),
    locator.boundingBox(),
  ]);
  if (frame === null || action === null) throw new Error('Missing anchor geometry');
  return {
    inside:
      action.x >= frame.x - 0.5 &&
      action.y >= frame.y - 0.5 &&
      action.x + action.width <= frame.x + frame.width + 0.5 &&
      action.y + action.height <= frame.y + frame.height + 0.5,
    logicalHeight: action.height / (frame.width / 360),
  };
}
