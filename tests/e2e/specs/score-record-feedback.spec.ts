import { expect, type Locator } from '@playwright/test';

import { test } from '../helpers/test';

async function readPausedAnimations(targets: Locator) {
  const states = await targets.evaluateAll(async (elements) => {
    await Promise.all(elements.flatMap((element) => element.getAnimations().map((a) => a.ready)));
    return elements.map((element) => ({
      playState: getComputedStyle(element).animationPlayState,
      animations: element.getAnimations().map((animation) => ({
        time: animation.currentTime,
        progress: animation.effect?.getComputedTiming().progress,
      })),
    }));
  });
  expect(states.length).toBeGreaterThan(0);
  for (const state of states) {
    expect(state.playState).toBe('paused');
    expect(state.animations.length).toBeGreaterThan(0);
    for (const animation of state.animations) {
      expect(typeof animation.time).toBe('number');
      expect(Number.isFinite(animation.time)).toBe(true);
      expect(typeof animation.progress).toBe('number');
    }
  }
  return states;
}

for (const [scenario, score, locale] of [
  ['yacht-zero', 0, 'ko'],
  ['yacht', 50, 'en'],
] as const) {
  test(`Yacht ${score} selects the matching record effect without granting input`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    await page.goto(
      `/dev/anchors.html?anchor=game&feedback=${scenario}&elapsed=250&recorder=opponent&locale=${locale}`,
    );
    await page.locator('[data-feedback-fixture]').evaluate((element) => {
      element.removeAttribute('data-feedback-fixture');
    });
    const cell = page.locator('button[data-score-category="yacht"]');
    await expect(cell).toHaveAttribute('data-score-confirmed', 'true');
    await expect(cell.locator('[data-score-value-kind="recorded"]')).toHaveText(String(score));
    await expect(cell).toHaveAttribute('data-input-available', 'false');
    await expect(cell.locator('.score-feedback__sweep')).toBeAttached();
    if (score === 0) {
      expect(await cell.locator('.score-feedback__particle').count()).toBeGreaterThan(0);
      await expect(cell.locator('[data-yacht-ring]')).toHaveCount(0);
    } else {
      await expect(cell.locator('[data-yacht-ring="recorded"]')).toBeAttached();
      await expect(cell.locator('.score-feedback__particle')).toHaveCount(0);
    }
    await cell.click({ force: true });
    await expect(page.locator('[data-last-intent]')).toHaveAttribute('data-last-intent', 'none');
    await expect(cell.locator('.score-feedback__sweep')).toHaveCSS(
      'animation-play-state',
      'paused',
    );
    const animated = cell.locator(
      '.score-feedback__sweep, .score-feedback__particle, [data-yacht-ring="recorded"] rect',
    );
    const paused = await readPausedAnimations(animated);
    await page.waitForTimeout(1100);
    expect(await readPausedAnimations(animated)).toEqual(paused);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: test.info().outputPath(`yacht-${score}-${locale}-320.png`) });
  });
}

for (const [scenario, locale] of [
  ['score', 'ko'],
  ['bonus', 'en'],
] as const) {
  test(`paused ${scenario} retains its 350ms age after real time and tab remount (${locale})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    await page.goto(
      `/dev/anchors.html?anchor=game&feedback=${scenario}&elapsed=350&recorder=opponent&locale=${locale}`,
    );
    const fixture = page.locator('[data-feedback-elapsed]');
    await fixture.evaluate((element) => element.removeAttribute('data-feedback-fixture'));
    const cell = page.locator('button[data-score-category="sixes"]');
    const effect = cell.locator('.score-feedback__effect');
    const sweep = cell.locator('.score-feedback__sweep');
    await expect(cell).toBeVisible();
    await expect(cell).toHaveAttribute('data-score-confirmed', 'true');
    await expect(cell.locator('[data-score-value-kind="recorded"]')).toHaveText('18');
    await expect(effect).toBeAttached();
    const delay = await effect.evaluate((element) =>
      getComputedStyle(element).getPropertyValue('--record-delay'),
    );
    expect(delay).toBe('-350ms');
    await expect(sweep).toHaveCSS('animation-play-state', 'paused');
    const bonusEffect = page.locator('.player-summary__bonus-effect');
    let bonusDelay: string | null = null;
    if (scenario === 'bonus') {
      await expect(bonusEffect).toBeAttached();
      await expect(bonusEffect.locator('.player-summary__bonus-gain')).toHaveText('+35');
      bonusDelay = await bonusEffect.evaluate((element) =>
        getComputedStyle(element).getPropertyValue('--record-delay'),
      );
      expect(bonusDelay).toBe('-350ms');
      await expect(bonusEffect.locator('.player-summary__bonus-gain')).toHaveCSS(
        'animation-play-state',
        'paused',
      );
    }
    const animated = page.locator(
      '.score-feedback__sweep, .score-feedback__particle, .player-summary__bonus-check-glow, .player-summary__bonus-star, .player-summary__bonus-gain',
    );
    const paused = await readPausedAnimations(animated);

    // Actual elapsed time is the regression trigger; advancing a fake clock would hide it.
    await page.waitForTimeout(1100);
    expect(await readPausedAnimations(animated)).toEqual(paused);
    await expect(effect).toBeAttached();
    await expect(effect).toHaveCSS('--record-delay', delay);
    await page.locator('[data-score-tab="lower"]').click();
    await expect(cell).toHaveCount(0);
    await page.locator('[data-score-tab="upper"]').click();
    await expect(cell).toBeVisible();
    await expect(effect).toBeAttached();
    await expect(effect).toHaveCSS('--record-delay', delay);
    await expect(sweep).toHaveCSS('animation-play-state', 'paused');
    await expect(cell.locator('[data-score-value-kind="recorded"]')).toHaveText('18');
    await expect(fixture).toHaveAttribute('data-feedback-elapsed', '350');
    if (bonusDelay !== null) {
      await expect(bonusEffect).toBeAttached();
      await expect(bonusEffect).toHaveCSS('--record-delay', bonusDelay);
      await expect(bonusEffect.locator('.player-summary__bonus-gain')).toHaveText('+35');
    }
    await expect(cell).toHaveAttribute('data-input-available', 'false');
    await cell.click({ force: true });
    await expect(fixture).toHaveAttribute('data-last-intent', 'none');
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: test.info().outputPath(`${scenario}-${locale}-350ms-320.png`) });
  });
}

for (const { scenario, elapsed, locale, selector } of [
  { scenario: 'score', elapsed: 850, locale: 'ko', selector: '[data-score-transition="outgoing"]' },
  { scenario: 'score', elapsed: 950, locale: 'en', selector: '[data-score-transition="incoming"]' },
  { scenario: 'turn', elapsed: 350, locale: 'ko', selector: '.game-turn-cue, .game-turn-cue > i' },
  {
    scenario: 'yacht-available',
    elapsed: 350,
    locale: 'en',
    selector: '[data-yacht-ring="available"] rect',
  },
]) {
  test(`paused ${scenario} at ${elapsed}ms keeps its animation position (${locale})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    await page.goto(
      `/dev/anchors.html?anchor=game&feedback=${scenario}&elapsed=${elapsed}&recorder=opponent&locale=${locale}`,
    );
    if (scenario !== 'yacht-available') {
      await page.locator('[data-feedback-fixture]').evaluate((element) => {
        element.removeAttribute('data-feedback-fixture');
      });
    }
    const animated = page.locator(selector);
    const paused = await readPausedAnimations(animated);
    await page.waitForTimeout(1100);
    expect(await readPausedAnimations(animated)).toEqual(paused);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: test.info().outputPath(`${scenario}-${locale}-${elapsed}ms-320.png`),
    });
  });
}
