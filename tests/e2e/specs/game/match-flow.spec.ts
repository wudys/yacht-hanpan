import { expect } from '@playwright/test';

import {
  disposeScoreFeedback,
  observeScoreFeedback,
  readScoreFeedback,
} from '../../helpers/score-feedback';
import { test } from '../../helpers/test';
import { PRODUCT_GAME_ORIGIN } from '../../helpers/test-origins';
import { createTwoPlayerGame } from '../../helpers/two-player-game';

test('held dice survive rerolls and a zero score remains selectable after the last roll', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  const guestContext = await createTwoPlayerGame(page, browser, {
    viewport: { width: 320, height: 568 },
  });
  try {
    const guest = guestContext.pages()[0]!;
    const presentation = page.locator('[data-dice-presentation-phase]');
    await expect(presentation).toHaveAttribute('data-dice-canvas-state', 'ready');
    await expect(guest.locator('[data-dice-presentation-phase]')).toHaveAttribute(
      'data-dice-canvas-state',
      'ready',
    );
    await page.evaluate(() => document.fonts.ready);
    await guest.evaluate(() => document.fonts.ready);
    const upperTab = page.locator('[data-score-tab="upper"]');
    await expect(upperTab).toHaveAttribute('aria-selected', 'true');
    await expect(guest.locator('[data-score-tab="upper"]')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.locator('.game-board__first-roll-guide')).toBeVisible();
    await page.screenshot({
      path: `/tmp/hanpan-game-first-turn-pre-roll-ko-320-${test.info().project.name}.png`,
    });
    await expect(guest.locator('[data-product-view="game"]')).toHaveAttribute(
      'data-viewer-turn',
      'false',
    );
    await guest.screenshot({
      path: `/tmp/hanpan-game-opponent-turn-ko-320-${test.info().project.name}.png`,
    });

    await page.getByRole('button', { name: '굴리기', exact: true }).click();
    await expect(presentation).toHaveAttribute('data-dice-presentation-phase', 'settled');
    await expect(page.locator('button[data-score-category]').first()).toHaveAttribute(
      'data-value-state',
      'preview',
    );
    await expect(upperTab).toHaveAttribute('aria-selected', 'true');
    await page.screenshot({
      path: `/tmp/hanpan-game-post-roll-upper-ko-320-${test.info().project.name}.png`,
    });
    await page.locator('[data-score-tab="lower"]').click();
    await page.screenshot({
      path: `/tmp/hanpan-game-post-roll-lower-ko-320-${test.info().project.name}.png`,
    });
    for (let slot = 0; slot < 5; slot += 1) {
      const die = page.locator(`[data-settled-slot="${slot}"]`);
      await expect(die).toBeEnabled();
      await die.click();
      await expect(page.locator(`[data-held-slot="${slot}"]`)).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    }
    await expect(page.locator('[data-held-slot][aria-pressed="true"]')).toHaveCount(5);
    await page.screenshot({
      path: `/tmp/hanpan-game-all-held-ko-320-${test.info().project.name}.png`,
    });
    const reroll = page.getByRole('button', { name: '다시 굴리기', exact: true });
    await expect(reroll).toBeDisabled();
    const held = page.locator('[data-held-slot="0"] [data-die-face]');
    const face = await held.getAttribute('data-die-face');
    for (let slot = 1; slot < 5; slot += 1) {
      const die = page.locator(`[data-held-slot="${slot}"]`);
      await expect(die).toBeEnabled();
      await die.click();
      await expect(die).toHaveCount(0);
      await expect(page.locator(`[data-settled-slot="${slot}"]`)).toBeVisible();
    }
    for (let roll = 0; roll < 2; roll += 1) {
      await expect(reroll).toBeEnabled();
      await reroll.click();
      await expect(page.locator('.roll-action-rail .status-pill')).toHaveText(`${1 - roll}회 남음`);
      await expect(held).toHaveAttribute('data-die-face', face!);
      await expect(guest.locator('[data-held-slot="0"] [data-die-face]')).toHaveAttribute(
        'data-die-face',
        face!,
      );
    }
    await expect(presentation).toHaveAttribute('data-dice-presentation-phase', 'settled');
    await expect(page.locator('.roll-action-rail').getByRole('status')).toHaveText(
      '남은 굴림 없음',
    );
    await expect(page.locator('.roll-action-rail button')).toHaveCount(0);
    for (let slot = 0; slot < 5; slot += 1) {
      await expect(page.locator('.held-dice-rack__slot').nth(slot)).toBeDisabled();
    }
    await page.screenshot({
      path: `/tmp/hanpan-game-final-roll-ko-320-${test.info().project.name}.png`,
    });
    await page.locator('[data-score-tab="lower"]').click();
    // Every five-die hand has at least one unavailable special combination.
    const zero = page
      .locator('button[data-score-category]')
      .filter({
        has: page.locator('[data-score-value-kind]', { hasText: /^0$/u }),
      })
      .first();
    await expect(zero).toBeEnabled();
    const category = await zero.getAttribute('data-score-category');
    await zero.click();
    await expect(guest.locator('[data-product-view="game"]')).toHaveAttribute(
      'data-viewer-turn',
      'true',
    );
    await page.getByRole('button', { name: '점수판', exact: true }).click();
    await expect(
      page.locator(`[data-score-table] tr[data-score-category="${category}"] td`).first(),
    ).toHaveText('0');
    await page.screenshot({
      path: `/tmp/hanpan-recorded-zero-320-${test.info().project.name}.png`,
    });
    const scrollBody = page.locator('.scrollable-panel__body');
    const footer = page.locator('[data-layer-footer="true"]');
    const lastRow = page.locator('[data-score-row]').last();
    await lastRow.evaluate((element) => element.scrollIntoView({ block: 'end' }));
    const [bodyBounds, footerBounds, lastRowBounds] = await Promise.all([
      scrollBody.boundingBox(),
      footer.boundingBox(),
      lastRow.boundingBox(),
    ]);
    expect(bodyBounds).not.toBeNull();
    expect(footerBounds).not.toBeNull();
    expect(lastRowBounds).not.toBeNull();
    // Integer scroll offsets can round the uniformly scaled frame by half a CSS pixel.
    expect(lastRowBounds!.y + lastRowBounds!.height).toBeLessThanOrEqual(
      bodyBounds!.y + bodyBounds!.height + 0.5,
    );
    expect(lastRowBounds!.y + lastRowBounds!.height).toBeLessThanOrEqual(footerBounds!.y + 0.5);
    await page.screenshot({
      path: `/tmp/hanpan-game-scoreboard-last-row-ko-320-${test.info().project.name}.png`,
    });
  } finally {
    await guestContext.close();
  }
});

test('two browsers finish all twelve turns and return from the authoritative result', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  const guestContext = await createTwoPlayerGame(page, browser);
  try {
    const players = [page, guestContext.pages()[0]!] as const;
    const groups = {
      upper: ['ones', 'twos', 'threes', 'fours', 'fives', 'sixes'],
      lower: [
        'choice',
        'four-of-a-kind',
        'full-house',
        'small-straight',
        'large-straight',
        'yacht',
      ],
    };
    const recorded: number[][] = [[], []];
    for (const [group, categories] of Object.entries(groups)) {
      for (const category of categories) {
        for (const [seat, current] of players.entries()) {
          await expect(current.locator('[data-product-view="game"]')).toHaveAttribute(
            'data-viewer-turn',
            'true',
          );
          await current.getByRole('button', { name: '굴리기', exact: true }).click();
          await current.locator(`[data-score-tab="${group}"]`).click();
          const cell = current.locator(`button[data-score-category="${category}"]`);
          await expect(cell).toHaveAttribute('data-value-state', 'preview');
          await expect(cell).toBeEnabled();
          const preview = Number(await cell.locator('[data-score-value-kind]').textContent());
          expect(Number.isInteger(preview)).toBe(true);
          expect(preview).toBeGreaterThanOrEqual(0);
          recorded[seat]!.push(preview);
          const finalRecord = group === 'lower' && category === 'yacht' && seat === 1;
          const finalAudits = finalRecord
            ? await Promise.all(players.map(observeScoreFeedback))
            : [];
          await cell.click();
          if (finalRecord) {
            for (const [viewer, client] of players.entries()) {
              const audit = finalAudits[viewer]!;
              await expect
                .poll(async () =>
                  (await readScoreFeedback(audit)).some(
                    (event) =>
                      event.phase === 'confirming' &&
                      event.category === 'yacht' &&
                      event.owner === (viewer === seat ? 'viewer' : 'opponent') &&
                      event.score === String(preview),
                  ),
                )
                .toBe(true);
              await expect(client.locator('[data-product-view="result"]')).toBeVisible();
              const observations = await readScoreFeedback(audit);
              const confirming = observations.find(
                (event) => event.phase === 'confirming' && event.category === 'yacht',
              )!;
              const result = observations.find(
                (event) => event.at > confirming.at && event.owner === null,
              );
              expect(result).toBeDefined();
              expect(result!.at - confirming.at).toBeGreaterThanOrEqual(950);
              await disposeScoreFeedback(audit);
            }
          }
          await expect(
            current.locator('[data-product-view="game"][data-viewer-turn="true"]'),
          ).toHaveCount(0);
          if (group === 'lower' && category === 'choice' && seat === 0) {
            await expect(current.locator('[data-player-summary="opponent"]')).toBeVisible();
            const opponentChoice = current.locator('button[data-score-category="choice"]');
            await expect(current.locator('[data-score-grid]')).toHaveAttribute(
              'data-mode',
              'opponent-turn',
            );
            await expect(opponentChoice).toHaveAttribute('data-value-state', 'empty');
            await expect(opponentChoice.locator('[data-score-value-kind]')).toBeEmpty();
            await expect(opponentChoice).toHaveAccessibleName(/미기록/);
          }
        }
      }
    }
    const totals = recorded.map((scores) => {
      const upper = scores.slice(0, 6).reduce((sum, value) => sum + value, 0);
      return scores.reduce((sum, value) => sum + value, 0) + (upper >= 63 ? 35 : 0);
    });
    for (const [seat, current] of players.entries()) {
      const result = current.locator('[data-product-view="result"]');
      await expect(result).toBeVisible();
      await expect(result.locator('[data-result-reason]')).toHaveCount(0);
      await expect(result.locator('[data-score-row]')).toHaveCount(12);
      await expect(result.locator('td[data-score-state="recorded"]')).toHaveCount(24);
      await expect(
        result.locator('[data-score-player="viewer"] .score-table-player__total'),
      ).toHaveText(String(totals[seat]));
      await expect(
        result.locator('[data-score-player="opponent"] .score-table-player__total'),
      ).toHaveText(String(totals[1 - seat]));
      const outcome =
        totals[seat] === totals[1 - seat]
          ? 'draw'
          : totals[seat]! > totals[1 - seat]!
            ? 'viewer-win'
            : 'opponent-win';
      await expect(result).toHaveAttribute('data-result-outcome', outcome);
      const rows = result.locator('[data-score-row]');
      for (let index = 0; index < 12; index += 1) {
        await expect(rows.nth(index).locator('td').first()).toHaveText(
          String(recorded[seat]![index]),
        );
        await expect(rows.nth(index).locator('td').last()).toHaveText(
          String(recorded[1 - seat]![index]),
        );
      }
      const contrastSamples = await result
        .locator('td[data-score-state="recorded"]')
        .evaluateAll((cells) => {
          const luminance = (color: string) => {
            const values = color.match(/[\d.]+/gu)!.map(Number);
            if (values.length > 3 && values[3] !== 1)
              throw new Error(`Contrast needs an opaque color: ${color}`);
            const channels = values.slice(0, 3).map((value) => {
              const channel = value / 255;
              return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
            });
            return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
          };
          return cells.map((cell) => {
            const style = getComputedStyle(cell);
            const ink = luminance(style.color);
            const surface = luminance(style.backgroundColor);
            const row = cell.closest('tr') as HTMLTableRowElement;
            return {
              category: row.dataset.scoreCategory,
              player: (cell as HTMLTableCellElement).cellIndex === 1 ? 'viewer' : 'opponent',
              parity: row.sectionRowIndex % 2 === 0 ? 'odd' : 'even',
              ink: style.color,
              surface: style.backgroundColor,
              ratio: (Math.max(ink, surface) + 0.05) / (Math.min(ink, surface) + 0.05),
            };
          });
        });
      expect(new Set(contrastSamples.map(({ player, parity }) => `${player}-${parity}`))).toEqual(
        new Set(['viewer-odd', 'viewer-even', 'opponent-odd', 'opponent-even']),
      );
      for (const sample of contrastSamples) {
        expect(sample.ratio, JSON.stringify({ seat, ...sample })).toBeGreaterThanOrEqual(4.5);
      }
      await current.screenshot({
        path: `/tmp/hanpan-normal-result-seat-${seat}-320-${test.info().project.name}.png`,
      });
      await result.getByRole('button', { name: '로비로 돌아가기', exact: true }).click();
      await expect(current.locator('[data-room-action="create"] button')).toBeVisible();
      await expect(current.locator('[data-product-view="result"]')).toHaveCount(0);
      if (seat === 0) {
        await current.locator('[data-room-action="create"] button').click();
        await expect(current.locator('[data-room-code]')).toBeVisible();
        await expect(players[1].locator('[data-product-view="result"]')).toBeVisible();
      }
    }
  } finally {
    await guestContext.close();
  }
});

test('alternating turns preserve recorded scores and explain blocked category selection', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 320, height: 568 });
  const scoreCommands: string[] = [];
  page.on('websocket', (socket) =>
    socket.on('framesent', ({ payload }) => {
      const message = payload.toString();
      if (message.includes('"selectScoreCategory"')) scoreCommands.push(message);
    }),
  );
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  const guestContext = await createTwoPlayerGame(page, browser, {
    viewport: { width: 320, height: 568 },
  });
  try {
    const guest = guestContext.pages()[0]!;
    await expect(page.locator('[data-product-view="game"]')).toHaveAttribute(
      'data-viewer-turn',
      'true',
    );
    await expect(guest.locator('[data-product-view="game"]')).toHaveAttribute(
      'data-viewer-turn',
      'false',
    );

    for (const current of [page, guest]) {
      const english = current === guest;
      if (english) {
        await current.getByRole('button', { name: '설정', exact: true }).click();
        await current.getByRole('button', { name: 'English', exact: true }).click();
        await current.getByRole('button', { name: 'Close', exact: true }).click();
      }
      await current
        .getByRole('button', { name: english ? 'Bonus rule' : '보너스 규칙', exact: true })
        .click();
      const bonus = current.locator('[data-bonus-info]');
      await expect(bonus).toBeVisible();
      await expect(bonus.locator('[data-bonus-progress]')).toHaveText('0/63');
      const bounds = await bonus.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
      const award = bonus.locator('[data-bonus-award]');
      expect(
        await award.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return hit === element || element.contains(hit);
        }),
      ).toBe(true);
      await current.screenshot({
        path: `/tmp/hanpan-bonus-${english ? 'en' : 'ko'}-320-${test.info().project.name}.png`,
      });
      const bonusAction = current.getByRole('button', {
        name: english ? 'Bonus rule' : '보너스 규칙',
        exact: true,
      });
      expect(
        await bonusAction.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return hit === element || element.contains(hit);
        }),
      ).toBe(true);
      await bonusAction.click();
      await expect(bonus).not.toBeVisible();
      await bonusAction.click();
      await bonus.getByRole('button', { name: english ? 'Close' : '닫기', exact: true }).click();
      if (english) {
        await current.getByRole('button', { name: 'Settings', exact: true }).click();
        await current.getByRole('button', { name: '한국어', exact: true }).click();
        await current.getByRole('button', { name: '닫기', exact: true }).click();
      }
      await current.getByRole('button', { name: '굴리기', exact: true }).click();
      await current.locator('[data-score-tab="lower"]').click();
      const choice = current.locator('button[data-score-category="choice"]');
      await expect(choice).toHaveAttribute('data-value-state', 'preview');
      const preview = await choice.locator('[data-score-value-kind]').textContent();
      expect(Number(preview)).toBeGreaterThanOrEqual(5);
      expect(Number(preview)).toBeLessThanOrEqual(30);
      await choice.click();
      await expect(current.locator('[data-product-view="game"]')).toHaveAttribute(
        'data-viewer-turn',
        'false',
      );
      await current.getByRole('button', { name: '점수판', exact: true }).click();
      await expect(
        current.locator('[data-score-table] tr[data-score-category="choice"] td').first(),
      ).toHaveText(preview!);
      await current.getByRole('button', { name: '닫기', exact: true }).click();
    }
    await expect(page.locator('[data-product-view="game"]')).toHaveAttribute(
      'data-viewer-turn',
      'true',
    );
    await expect(page.locator('.game-board__first-roll-guide')).toHaveCount(0);
    await expect(page.locator('[data-settled-slot]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '굴리기', exact: true })).toBeEnabled();
    await page.screenshot({
      path: `/tmp/hanpan-game-later-turn-pre-roll-ko-320-${test.info().project.name}.png`,
    });
    await page.getByRole('button', { name: '굴리기', exact: true }).click();
    await expect(page.locator('[data-dice-presentation-phase]')).toHaveAttribute(
      'data-dice-presentation-phase',
      'settled',
    );
    const recorded = page.locator('button[data-score-category="choice"]');
    await expect(recorded).toHaveAttribute('data-value-state', 'recorded');
    const value = await recorded.locator('[data-score-value-kind]').textContent();
    expect(scoreCommands).toHaveLength(1);
    // aria-disabled forbids scoring, but a real user click must still explain why.
    // Playwright's click intentionally refuses aria-disabled; use the physical pointer.
    // Unlike locator.click(), raw pointer input needs an explicit hit-target check.
    await expect
      .poll(() =>
        recorded.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return hit === element || (hit !== null && element.contains(hit));
        }),
      )
      .toBe(true);
    const bounds = await recorded.boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    const notice = page.getByRole('alertdialog', { name: '이미 기록한 항목', exact: true });
    await expect(notice).toBeVisible();
    await notice.getByRole('button', { name: '확인', exact: true }).click();
    await expect(notice).toHaveCount(0);
    await expect(recorded.locator('[data-score-value-kind]')).toHaveText(value!);
    await expect(page.locator('[data-product-view="game"]')).toHaveAttribute(
      'data-viewer-turn',
      'true',
    );
    expect(scoreCommands).toHaveLength(1);
  } finally {
    await guestContext.close();
  }
});
