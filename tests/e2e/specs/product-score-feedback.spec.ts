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

async function readScoreOptions(page: Page) {
  return page.locator('[data-score-grid]').evaluate((grid) => ({
    cells: Array.from(grid.querySelectorAll('[data-score-cell]'), (cell) => ({
      category: cell.getAttribute('data-score-category'),
      state: cell.getAttribute('data-value-state'),
      value: cell.querySelector('[data-score-value-kind]')?.textContent,
    })),
    maxima: Array.from(grid.querySelectorAll('[data-score-tab]'), (tab) => ({
      group: tab.getAttribute('data-score-tab'),
      value: tab.querySelector('span')?.textContent?.match(/\d+/u)?.[0] ?? null,
    })),
  }));
}

test('both clients confirm zero and normal records with the source owner, then YOUR TURN permits an immediate roll', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  const gameplayCommands: [number, number] = [0, 0];
  const observeCommands = (client: Page, seat: 0 | 1) =>
    client.on('websocket', (socket) =>
      socket.on('framesent', ({ payload }) => {
        if (/"(?:selectScoreCategory|rollDice|setDieHeld)"/u.test(payload.toString()))
          gameplayCommands[seat] += 1;
      }),
    );
  observeCommands(page, 0);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  const guestContext = await joinProductGame(page, browser, {
    locale: 'en',
    onGuestPage: (guest) => {
      observeCommands(guest, 1);
    },
  });
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
      const next = players[1 - seat]!;
      await expect(next.locator('[data-dice-presentation-phase]')).toHaveAttribute(
        'data-dice-presentation-phase',
        'settled',
      );
      for (const group of ['upper', 'lower']) {
        await recorder.locator(`[data-score-tab="${group}"]`).click();
        await next.locator(`[data-score-tab="${group}"]`).click();
        const options = await readScoreOptions(recorder);
        expect(options.cells.some((cell) => cell.state === 'preview')).toBe(true);
        expect(options.maxima.every((maximum) => maximum.value !== null)).toBe(true);
        expect(await readScoreOptions(next)).toEqual(options);
      }
      const readonlyCell = next.locator('[data-score-cell][data-value-state="preview"]').first();
      await expect(readonlyCell).toBeDisabled();
      await expect(readonlyCell).toHaveAttribute('data-input-available', 'false');
      await expect(next.locator('[data-authoritative-die-slot]').first()).toBeDisabled();
      const commandsBeforeClick = [...gameplayCommands];
      const cellBounds = await readonlyCell.boundingBox();
      expect(cellBounds).not.toBeNull();
      await next.mouse.click(
        cellBounds!.x + cellBounds!.width / 2,
        cellBounds!.y + cellBounds!.height / 2,
      );
      expect(await readScoreOptions(next)).toEqual(await readScoreOptions(recorder));
      expect(gameplayCommands).toEqual(commandsBeforeClick);
      for (const width of [320, 360, 430]) {
        await next.setViewportSize({ width, height: 740 });
        const gridBounds = await next.locator('[data-score-grid]').boundingBox();
        expect(gridBounds).not.toBeNull();
        expect(gridBounds!.x).toBeGreaterThanOrEqual(0);
        expect(gridBounds!.x + gridBounds!.width).toBeLessThanOrEqual(width);
        await next.screenshot({
          path: test.info().outputPath(`opponent-preview-${seat === 0 ? 'en' : 'ko'}-${width}.png`),
        });
      }
      await next.setViewportSize({ width: 320, height: 740 });
      const previousTab = next.locator('[data-score-tab="upper"]');
      await previousTab.click();
      await previousTab.focus();
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
                event.group === 'lower' &&
                event.owner === (viewer === seat ? 'viewer' : 'opponent') &&
                event.score === value &&
                Number(event.total?.replace(/\D/gu, '')) === Number(value),
            ),
          )
          .toBe(true);
        await expect(client.locator('button[data-score-category]').first()).toHaveAttribute(
          'aria-disabled',
          'true',
        );
      }
      await expect(next.locator('[data-turn-cue]')).toBeVisible();
      await expect(previousTab).toHaveAttribute('aria-selected', 'true');
      await expect(previousTab).toBeFocused();
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
          observations
            .filter((event) => event.phase !== null)
            .every((event) => event.previewCount === 0 && !event.hasGroupPreview),
        ).toBe(true);
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
        expect(
          observations.some(
            (event) =>
              event.phase === 'incoming' &&
              event.owner === (viewer === seat ? 'opponent' : 'viewer') &&
              event.group === (viewer === seat ? 'lower' : 'upper'),
          ),
        ).toBe(true);
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
      if (seat === 1) {
        await Promise.all(
          players.map((client, viewer) =>
            client.screenshot({ path: test.info().outputPath(`tab-return-${viewer}-320.png`) }),
          ),
        );
      }
    }
  } finally {
    await guestContext.close();
  }
});

for (const [method, chosenGroup, width] of [
  ['click', 'lower', 360],
  ['keyboard', 'upper', 430],
] as const) {
  test(`manual ${method} of the ${chosenGroup} tab during confirmation survives the handoff`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: 740 });
    await page.goto(PRODUCT_GAME_ORIGIN);
    await page.getByRole('button', { name: '게임 시작', exact: true }).click();
    const guestContext = await joinProductGame(page, browser, {
      locale: 'en',
      viewport: { width, height: 740 },
    });
    try {
      const guest = guestContext.pages()[0]!;
      await rollAndSettle(page);
      await page.locator('[data-score-tab="lower"]').click();
      await guest.locator('[data-score-tab="upper"]').click();
      const chosenTab = guest.locator(`[data-score-tab="${chosenGroup}"]`);
      await chosenTab.focus();
      const audit = await observeScoreFeedback(guest);
      await page.locator('button[data-score-category="choice"]').click();
      await expect(guest.locator('[data-score-confirmed="true"]')).toBeVisible();
      await expect(guest.locator('[data-score-tab="lower"]')).toHaveAttribute(
        'aria-selected',
        'true',
      );
      if (method === 'click') await chosenTab.click();
      else await chosenTab.press('Enter');
      await expect(chosenTab).toHaveAttribute('aria-selected', 'true');
      await expect(guest.locator('[data-turn-cue]')).toBeVisible();
      await expect(chosenTab).toHaveAttribute('aria-selected', 'true');
      await expect(chosenTab).toBeFocused();
      const events = await readScoreFeedback(audit);
      expect(
        events.some(
          (event) =>
            event.phase === 'incoming' && event.owner === 'viewer' && event.group === chosenGroup,
        ),
      ).toBe(true);
      expect(await scoreFeedbackNodesRetained(audit)).toEqual({
        grid: true,
        summary: true,
        canvas: true,
      });
      const roll = guest.getByRole('button', { name: 'Roll', exact: true });
      expect(await roll.getAttribute('aria-disabled')).toBe('false');
      await rollAndSettle(guest, true);
      await Promise.all([
        page.screenshot({ path: test.info().outputPath(`manual-${method}-ko-${width}.png`) }),
        guest.screenshot({ path: test.info().outputPath(`manual-${method}-en-${width}.png`) }),
      ]);
      await disposeScoreFeedback(audit);
    } finally {
      await guestContext.close();
    }
  });
}

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
      await guest.locator('[data-score-tab="lower"]').click();
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
              (event) =>
                event.phase === 'confirming' &&
                event.category === 'ones' &&
                event.group === 'upper',
            ),
          )
          .toBe(true);
        expect(await roll.getAttribute('aria-disabled')).toBe('true');
        await expect(guest.locator('[data-turn-cue]')).toBeVisible();
        await expect(guest.locator('[data-score-tab="lower"]')).toHaveAttribute(
          'aria-selected',
          'true',
        );
        const events = await readScoreFeedback(audit);
        const confirming = events.find((event) => event.phase === 'confirming')!;
        const ready = events.find((event) => event.turnCue)!;
        expect(ready.at - confirming.at).toBeGreaterThanOrEqual(950);
        // The server's 90 seconds already run after startedAt, including the 300ms delivery cost.
        expect(publication.deadlineAt - Date.now()).toBeLessThan(90_000);
        await expect(guest.locator('.game-board__timer')).toHaveText(/^(?:89|90)초$/u);
      } else {
        await expect(roll).toBeEnabled();
        await expect(guest.locator('[data-score-tab="upper"]')).toHaveAttribute(
          'aria-selected',
          'true',
        );
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
