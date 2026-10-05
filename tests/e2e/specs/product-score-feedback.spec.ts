import { expect, type Page } from '@playwright/test';

import { joinProductGame, PRODUCT_GAME_ORIGIN } from '../helpers/product-game';
import {
  disposeScoreFeedback,
  holdScorePublication,
  observeScoreFeedback,
  readScoreFeedback,
  scoreFeedbackNodesRetained,
} from '../helpers/score-feedback';
import { test } from '../helpers/test';

async function rollAndSettle(page: Page, english: boolean = false) {
  await page.getByRole('button', { name: english ? 'Roll' : '굴리기', exact: true }).click();
  await expect(page.locator('button[data-score-category]').first()).toHaveAttribute(
    'data-value-state',
    'preview',
  );
  await expect(page.locator('[data-dice-presentation-phase]')).toHaveAttribute(
    'data-dice-presentation-phase',
    'settled',
  );
}

test('both clients confirm zero and normal records with the source owner, then YOUR TURN permits an immediate roll', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  const guestContext = await joinProductGame(page, browser, { locale: 'en' });
  try {
    const guest = guestContext.pages()[0]!;
    const players = [page, guest] as const;
    for (const [seat, recorder] of players.entries()) {
      if (seat === 0) await rollAndSettle(recorder);
      else
        await expect(recorder.locator('[data-dice-presentation-phase]')).toHaveAttribute(
          'data-dice-presentation-phase',
          'settled',
        );
      await recorder.locator('[data-score-tab="lower"]').click();
      const cell =
        seat === 0
          ? recorder
              .locator('button[data-score-category]')
              .filter({
                has: recorder.locator('[data-score-value-kind="preview"]', { hasText: /^0$/u }),
              })
              .first()
          : recorder.locator('button[data-score-category="choice"]');
      await expect(cell).toBeEnabled();
      const category = await cell.getAttribute('data-score-category');
      const value = await cell.locator('[data-score-value-kind="preview"]').textContent();
      expect(category).not.toBeNull();
      expect(value).toMatch(/^\d+$/u);
      const audits = await Promise.all(players.map(observeScoreFeedback));
      await cell.click();
      for (const [viewer, client] of players.entries()) {
        await expect
          .poll(async () =>
            (await readScoreFeedback(audits[viewer]!)).some(
              (event) =>
                event.phase === 'confirming' &&
                event.category === category &&
                event.owner === (viewer === seat ? 'viewer' : 'opponent') &&
                event.score === value &&
                Number(event.total?.replace(/\D/gu, '')) === Number(value),
            ),
          )
          .toBe(true);
        await expect(client.locator('[data-score-tab="lower"]')).toHaveAttribute(
          'aria-selected',
          'true',
        );
        await expect(client.locator('button[data-score-category]').first()).toHaveAttribute(
          'aria-disabled',
          'true',
        );
      }
      const next = players[1 - seat]!;
      await expect(next.locator('[data-turn-cue]')).toBeVisible();
      const roll = next.getByRole('button', {
        name: next === guest ? 'Roll' : '굴리기',
        exact: true,
      });
      // Read while the cue is visible: waiting for enabled input could hide an extra cue lock.
      expect(await roll.getAttribute('aria-disabled')).toBe('false');
      await roll.click();
      await expect(next.locator('[data-turn-cue]')).toHaveCount(0);
      await expect(next.locator('[data-dice-presentation-phase]')).toHaveAttribute(
        'data-dice-presentation-phase',
        'rolling',
      );
      for (const [viewer, client] of players.entries()) {
        const observations = await readScoreFeedback(audits[viewer]!);
        const confirmation = observations.find(
          (event) => event.phase === 'confirming' && event.category === category,
        );
        expect(confirmation).toBeDefined();
        expect(
          observations.filter(
            (event) => event.phase === 'confirming' && event.category === category,
          ),
        ).toHaveLength(1);
        const handoff = observations.find(
          (event) =>
            event.at > confirmation!.at &&
            event.phase === null &&
            event.owner === (viewer === seat ? 'opponent' : 'viewer'),
        );
        expect(handoff).toBeDefined();
        expect(handoff!.at - confirmation!.at).toBeGreaterThanOrEqual(950);
        expect(await scoreFeedbackNodesRetained(audits[viewer]!)).toEqual({
          grid: true,
          summary: true,
          canvas: true,
        });
        await expect(client.locator('[data-player-summary]')).toHaveAttribute(
          'data-player-summary',
          viewer === seat ? 'opponent' : 'viewer',
        );
        await disposeScoreFeedback(audits[viewer]!);
      }
      await expect(next.locator('[data-dice-presentation-phase]')).toHaveAttribute(
        'data-dice-presentation-phase',
        'settled',
      );
    }
  } finally {
    await guestContext.close();
  }
});

for (const delay of ['300ms', 'after-start'] as const) {
  test(`a genuine score publication delivered ${delay} follows local confirmation and server readiness`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(60_000);
    await page.goto(PRODUCT_GAME_ORIGIN);
    await page.getByRole('button', { name: '게임 시작', exact: true }).click();
    let gate!: Awaited<ReturnType<typeof holdScorePublication>>;
    const guestContext = await joinProductGame(page, browser, {
      onGuestPage: async (guest) => {
        gate = await holdScorePublication(guest);
      },
    });
    try {
      const guest = guestContext.pages()[0]!;
      await rollAndSettle(page);
      const cell = page.locator('button[data-score-category="ones"]');
      await expect(cell).toBeEnabled();
      gate.hold('ones');
      const audit = await observeScoreFeedback(guest);
      await cell.click();
      await expect.poll(() => gate.current()).not.toBeNull();
      const publication = gate.current()!;
      expect(publication.deadlineAt - publication.startedAt).toBe(90_000);
      expect(
        await guest.locator('[data-product-view="game"]').getAttribute('data-viewer-turn'),
      ).toBe('false');
      if (delay === '300ms') {
        await expect
          .poll(() => Date.now() - publication.receivedAt, { intervals: [20] })
          .toBeGreaterThanOrEqual(300);
        expect(Date.now()).toBeLessThan(publication.startedAt);
      } else {
        await expect
          .poll(() => Date.now(), { intervals: [20] })
          .toBeGreaterThanOrEqual(publication.startedAt + 30);
      }
      gate.release();
      const roll = guest.getByRole('button', { name: '굴리기', exact: true });
      if (delay === '300ms') {
        await expect
          .poll(async () =>
            (await readScoreFeedback(audit)).some(
              (event) => event.phase === 'confirming' && event.category === 'ones',
            ),
          )
          .toBe(true);
        expect(await roll.getAttribute('aria-disabled')).toBe('true');
        await expect(guest.locator('[data-turn-cue]')).toBeVisible();
        const events = await readScoreFeedback(audit);
        const confirming = events.find((event) => event.phase === 'confirming')!;
        const ready = events.find((event) => event.turnCue)!;
        expect(ready.at - confirming.at).toBeGreaterThanOrEqual(950);
        // The server's 90 seconds already run after startedAt, including the 300ms delivery cost.
        expect(publication.deadlineAt - Date.now()).toBeLessThan(90_000);
        await expect(guest.locator('.game-board__timer')).toHaveText(/^(?:89|90)초$/u);
      } else {
        await expect(roll).toBeEnabled();
        expect(
          (await readScoreFeedback(audit)).some((event) => event.phase !== null || event.turnCue),
        ).toBe(false);
        await expect(guest.locator('[data-score-confirmed]')).toHaveCount(0);
        await expect(guest.locator('[data-turn-cue]')).toHaveCount(0);
      }
      await roll.click();
      await expect(guest.locator('[data-turn-cue]')).toHaveCount(0);
      await expect(guest.locator('[data-dice-presentation-phase]')).toHaveAttribute(
        'data-dice-presentation-phase',
        'rolling',
      );
      await disposeScoreFeedback(audit);
    } finally {
      gate.release();
      await guestContext.close();
    }
  });
}
