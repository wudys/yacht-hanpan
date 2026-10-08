import { type BrowserContext, expect, type JSHandle, type Page } from '@playwright/test';

import { test } from '../../helpers/test';
import { PRODUCT_GAME_ORIGIN } from '../../helpers/test-origins';
import { createTwoPlayerGame } from '../../helpers/two-player-game';
import { visibleTextIssues } from '../../helpers/visual-geometry';

interface AchievementAudit {
  readonly samples: Array<{
    readonly previews: number;
    readonly upperMaxima: number;
    readonly lowerMaxima: number;
    readonly scoresLocked: boolean;
    readonly holdsLocked: boolean;
    readonly rollLocked: boolean;
    readonly aligned: boolean;
    readonly insideFrame: boolean;
    readonly canvasVisible: boolean;
  }>;
  readonly maximumOpacity: number;
  readonly fadedAfterPeak: boolean;
  readonly maximumVisibleParticles: number;
  readonly particlesEnded: boolean;
  readonly particleContainerCount: number;
  readonly title: string | null;
  readonly attemptedInputs: boolean;
  readonly requestedGroup: string | null;
  readonly navigatedGroup: boolean;
  readonly rollingStarts: number;
  readonly ended: boolean;
  readonly dispose: () => void;
}

for (const locale of ['ko', 'en'] as const) {
  for (const kind of ['other', 'yacht'] as const) {
    test(`real achievement ${kind} ${locale} stays inside the locked dice board`, async ({
      page,
      browser,
    }, testInfo) => {
      test.setTimeout(90_000);
      const category = kind === 'yacht' ? 'yacht' : 'full-house';
      const selectorModule = '**/src/runtime/dice/achievement-selection.ts';
      // Only presentation selection is deterministic. The server's dice, scores,
      // command execution, replay and original turn deadline remain real.
      await page.route(selectorModule, (route) =>
        route.fulfill({
          contentType: 'application/javascript',
          body: `export function selectFeaturedCombination() { return '${category}'; }`,
        }),
      );
      let guestContext: BrowserContext | null = null;
      let audit: JSHandle<AchievementAudit> | null = null;
      try {
        await page.addInitScript((language) => localStorage.setItem('locale', language), locale);
        await page.setViewportSize({ width: 320, height: 568 });
        await page.goto(PRODUCT_GAME_ORIGIN);
        await page
          .getByRole('button', { name: locale === 'ko' ? '게임 시작' : 'Start Game', exact: true })
          .click();
        guestContext = await createTwoPlayerGame(page, browser, {
          locale,
          viewport: { width: 320, height: 568 },
        });
        const host = page.locator('[data-dice-presentation-phase]');
        await expect(host).toHaveAttribute('data-dice-canvas-state', 'ready');
        audit = await observeAchievement(page);
        await page
          .getByRole('button', { name: locale === 'ko' ? '굴리기' : 'Roll', exact: true })
          .click();
        await expect
          .poll(() => audit!.evaluate((value) => value.maximumOpacity))
          .toBeGreaterThanOrEqual(0.8);

        const title = page.locator(
          `[data-achievement-kind="${kind}"] .achievement-sequence__title`,
        );
        // Collect while opaque; the pre-roll observer retains short-phase evidence
        // while the screenshot and text inspection run together.
        const [textIssues] = await Promise.all([
          visibleTextIssues(title),
          page.screenshot({ path: testInfo.outputPath(`achievement-${kind}-${locale}-320.png`) }),
        ]);
        expect(textIssues).toEqual([]);
        await expect(host).toHaveAttribute('data-dice-presentation-phase', 'settled');
        const observed = await audit.evaluate(({ dispose: _dispose, ...value }) => value);
        expect(observed.samples.length).toBeGreaterThan(0);
        expect(
          observed.samples.filter(
            (sample) =>
              sample.previews !== 0 ||
              sample.upperMaxima !== 0 ||
              sample.lowerMaxima !== 0 ||
              !sample.scoresLocked ||
              !sample.holdsLocked ||
              !sample.rollLocked ||
              !sample.aligned ||
              !sample.insideFrame ||
              !sample.canvasVisible,
          ),
        ).toEqual([]);
        expect(observed.title).toBe(
          kind === 'yacht'
            ? locale === 'ko'
              ? '요트'
              : 'Yacht'
            : locale === 'ko'
              ? '풀 하우스'
              : 'Full House',
        );
        expect(observed.fadedAfterPeak).toBe(true);
        expect(observed.particleContainerCount).toBe(kind === 'yacht' ? 1 : 0);
        if (kind === 'yacht') {
          expect(observed.maximumVisibleParticles).toBeGreaterThan(0);
          expect(observed.particlesEnded).toBe(true);
        } else expect(observed.maximumVisibleParticles).toBe(0);
        expect(observed.attemptedInputs).toBe(true);
        expect(observed.navigatedGroup).toBe(true);
        expect(observed.rollingStarts).toBe(1);
        expect(observed.ended).toBe(true);
        await expect(page.locator('[data-achievement-kind]')).toHaveCount(0);
        await expect(page.locator('.achievement-sequence__particle')).toHaveCount(0);
        await expect(page.locator('[data-value-state="recorded"]')).toHaveCount(0);
        await expect(page.locator('[data-held="true"]')).toHaveCount(0);
        await expect(page.locator('[data-settled-slot]')).toHaveCount(5);
        await expect(page.locator('button[data-score-category]').first()).toBeEnabled();
        await expect(page.locator('[data-value-state="preview"]')).toHaveCount(6);
        await expect(page.locator('[data-score-tab] span')).toHaveCount(2);

        const faces = await page
          .locator('[data-authoritative-die-slot][data-die-face]')
          .evaluateAll((dice) => dice.map((die) => Number(die.getAttribute('data-die-face'))));
        expect(faces).toHaveLength(5);
        expect(faces.every((face) => Number.isInteger(face) && face >= 1 && face <= 6)).toBe(true);
        await page.locator('[data-score-tab="upper"]').click();
        const faceCategories = ['ones', 'twos', 'threes', 'fours', 'fives', 'sixes'];
        const upperScores = faceCategories.map(
          (_, index) => faces.filter((face) => face === index + 1).length * (index + 1),
        );
        for (const [index, faceCategory] of faceCategories.entries()) {
          await expect(
            page.locator(
              `[data-score-category="${faceCategory}"] [data-score-value-kind="preview"]`,
            ),
          ).toHaveText(String(upperScores[index]));
        }
        const maximumLabel = locale === 'ko' ? '최대' : 'Max';
        await expect(page.locator('[data-score-tab="upper"] span')).toHaveText(
          `${maximumLabel} ${Math.max(...upperScores)}`,
        );
        await page.locator('[data-score-tab="lower"]').click();
        await expect(
          page.locator('[data-score-category="choice"] [data-score-value-kind="preview"]'),
        ).toHaveText(String(faces.reduce((sum, face) => sum + face, 0)));
        const lowerScores = await page
          .locator('[data-score-value-kind="preview"]')
          .allTextContents();
        expect(lowerScores).toHaveLength(6);
        expect(lowerScores.every((score) => /^\d+$/u.test(score))).toBe(true);
        await expect(page.locator('[data-score-tab="lower"] span')).toHaveText(
          `${maximumLabel} ${Math.max(...lowerScores.map(Number))}`,
        );
      } finally {
        try {
          if (audit !== null) {
            await audit.evaluate(({ dispose }) => dispose());
            await audit.dispose();
          }
        } finally {
          await guestContext?.close();
          await page.unroute(selectorModule);
        }
      }
    });
  }
}

/** Samples real CSS/DOM throughout the effect, without pausing animation or clocks. */
async function observeAchievement(page: Page): Promise<JSHandle<AchievementAudit>> {
  return page.evaluateHandle(() => {
    const audit = {
      samples: [] as AchievementAudit['samples'],
      maximumOpacity: 0,
      fadedAfterPeak: false,
      maximumVisibleParticles: 0,
      particlesEnded: false,
      particleContainerCount: 0,
      title: null as string | null,
      attemptedInputs: false,
      requestedGroup: null as string | null,
      navigatedGroup: false,
      rollingStarts: 0,
      ended: false,
      dispose,
    };
    let previousPhase: string | null = null;
    let frame = 0;
    let disposed = false;
    const locked = (button: HTMLButtonElement) =>
      button.disabled || button.getAttribute('aria-disabled') === 'true';
    const sample = () => {
      if (disposed) return;
      const phase =
        document
          .querySelector('[data-dice-presentation-phase]')
          ?.getAttribute('data-dice-presentation-phase') ?? null;
      if (phase === 'rolling' && previousPhase !== 'rolling') audit.rollingStarts += 1;
      previousPhase = phase;
      if (phase === 'settled' && audit.samples.length > 0) audit.ended = true;
      const sequence = document.querySelector('[data-achievement-kind]');
      const content = sequence?.querySelector('.achievement-sequence__content');
      const board = document.querySelector('.dice-board');
      const overlay = document.querySelector('[data-game-achievement-layer]');
      const frameElement = document.querySelector('[data-game-logical-canvas]');
      if (phase !== 'achievement' || !sequence || !content || !board || !overlay || !frameElement)
        return;
      const opacity = Number.parseFloat(getComputedStyle(content).opacity);
      audit.maximumOpacity = Math.max(audit.maximumOpacity, opacity);
      if (audit.maximumOpacity >= 0.8 && opacity <= 0.1) audit.fadedAfterPeak = true;
      audit.title = sequence.querySelector('.achievement-sequence__title')?.textContent ?? null;
      audit.particleContainerCount = sequence.querySelectorAll(
        '[data-achievement-particles]',
      ).length;
      const boardBounds = board.getBoundingClientRect();
      const overlayBounds = overlay.getBoundingClientRect();
      const frameBounds = frameElement.getBoundingClientRect();
      const canvas = document.querySelector('.web-dice-canvas-host canvas');
      const visibleParticles = [
        ...sequence.querySelectorAll('.achievement-sequence__particle'),
      ].filter((particle) => {
        const rect = particle.getBoundingClientRect();
        return (
          particle.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
          Number.parseFloat(getComputedStyle(particle).opacity) >= 0.1 &&
          rect.width > 0 &&
          rect.height > 0 &&
          rect.left < boardBounds.right &&
          rect.right > boardBounds.left &&
          rect.top < boardBounds.bottom &&
          rect.bottom > boardBounds.top
        );
      }).length;
      audit.maximumVisibleParticles = Math.max(audit.maximumVisibleParticles, visibleParticles);
      if (audit.fadedAfterPeak && audit.maximumVisibleParticles > 0 && visibleParticles === 0)
        audit.particlesEnded = true;
      const scores = [
        ...document.querySelectorAll<HTMLButtonElement>('button[data-score-category]'),
      ];
      const holds = [...document.querySelectorAll<HTMLButtonElement>('[data-settled-slot]')];
      const roll = document.querySelector<HTMLButtonElement>('.roll-action-rail button');
      audit.samples.push({
        previews: document.querySelectorAll('[data-value-state="preview"]').length,
        upperMaxima: document.querySelectorAll('[data-score-tab="upper"] span').length,
        lowerMaxima: document.querySelectorAll('[data-score-tab="lower"] span').length,
        scoresLocked: scores.length > 0 && scores.every(locked),
        holdsLocked: holds.length > 0 && holds.every(locked),
        rollLocked: roll !== null && locked(roll),
        aligned:
          Math.abs(boardBounds.left - overlayBounds.left) <= 0.5 &&
          Math.abs(boardBounds.top - overlayBounds.top) <= 0.5 &&
          Math.abs(boardBounds.right - overlayBounds.right) <= 0.5 &&
          Math.abs(boardBounds.bottom - overlayBounds.bottom) <= 0.5,
        insideFrame:
          overlayBounds.left >= frameBounds.left - 0.5 &&
          overlayBounds.top >= frameBounds.top - 0.5 &&
          overlayBounds.right <= frameBounds.right + 0.5 &&
          overlayBounds.bottom <= frameBounds.bottom + 0.5,
        canvasVisible:
          canvas !== null &&
          canvas.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
      });
      const selected = document
        .querySelector('[data-score-tab][aria-selected="true"]')
        ?.getAttribute('data-score-tab');
      if (audit.requestedGroup !== null && selected === audit.requestedGroup)
        audit.navigatedGroup = true;
      if (!audit.attemptedInputs && opacity >= 0.8) {
        audit.attemptedInputs = true;
        scores[0]?.click();
        holds[0]?.click();
        roll?.click();
        audit.requestedGroup = selected === 'upper' ? 'lower' : 'upper';
        document
          .querySelector<HTMLButtonElement>(`[data-score-tab="${audit.requestedGroup}"]`)
          ?.click();
      }
    };
    const tick = () => {
      sample();
      if (!disposed && !audit.ended) frame = requestAnimationFrame(tick);
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.body, { attributes: true, childList: true, subtree: true });
    frame = requestAnimationFrame(tick);
    function dispose() {
      disposed = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
    }
    return audit;
  });
}

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
    const guest = await createTwoPlayerGame(page, browser);
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
