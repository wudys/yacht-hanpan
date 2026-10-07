import { expect } from '@playwright/test';

import { joinProductGame, PRODUCT_GAME_ORIGIN } from '../helpers/product-game';
import { readRoomStatePacket } from '../helpers/socket-packets';
import { test } from '../helpers/test';

type ObservedRoll = Readonly<{
  style: string;
  slots: number[];
  values: { slot: number; value: number }[];
}>;

test.use({ video: 'on' });

test('both players replay one through five dice while preserving held slots', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(150_000);
  const rolls: ObservedRoll[] = [];
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => {
      const update = readRoomStatePacket(payload);
      if (update?.type !== 'roll:committed') return;
      // Observe the real server recipe without printing credentials, seeds or snapshots.
      rolls.push({
        style: update.roll.replay.pourStyle,
        slots: [...update.roll.replay.rolledSlots],
        values: [...update.roll.outcome.authoritativeValuesBySlot],
      });
    });
  });
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  const guestContext = await joinProductGame(page, browser, {
    viewport: { width: 320, height: 568 },
  });
  try {
    const guest = guestContext.pages()[0]!;
    const clients = [page, guest];
    for (let turn = 0; turn < 4; turn += 1) {
      const actor = clients[turn % 2]!;
      const counts = turn < 2 ? [5, 4, 3] : [5, 2, 1];
      await expect(actor.locator('[data-product-view="game"]')).toHaveAttribute(
        'data-viewer-turn',
        'true',
      );
      for (const [rollIndex, count] of counts.entries()) {
        const heldCount = 5 - count;
        for (let slot = 0; slot < heldCount; slot += 1) {
          if (await actor.locator(`[data-held-slot="${slot}"]`).count()) continue;
          await actor.locator(`[data-settled-slot="${slot}"]`).click();
          await expect(actor.locator(`[data-held-slot="${slot}"]`)).toHaveAttribute(
            'aria-pressed',
            'true',
          );
        }
        const heldValues = await actor
          .locator('[data-held="true"] [data-die-face]')
          .evaluateAll((dice) => dice.map((die) => die.getAttribute('data-die-face')));
        const previousRolls = rolls.length;
        await actor
          .getByRole('button', { name: rollIndex === 0 ? '굴리기' : '다시 굴리기', exact: true })
          .click();
        await expect.poll(() => rolls.length).toBe(previousRolls + 1);
        const observed = rolls.at(-1)!;
        expect(observed.slots).toEqual(Array.from({ length: count }, (_, i) => heldCount + i));
        for (const client of clients) {
          await expect(client.locator('[data-dice-presentation-phase]')).toHaveAttribute(
            'data-dice-presentation-phase',
            'rolling',
          );
          await expect(client.locator('[data-value-state="preview"]')).toHaveCount(0);
          expect(
            await client
              .locator('[data-held="true"] [data-die-face]')
              .evaluateAll((dice) => dice.map((die) => die.getAttribute('data-die-face'))),
          ).toEqual(heldValues);
        }
        await actor.screenshot({
          path: test.info().outputPath(`${turn}-${count}-${observed.style}-rolling.png`),
        });
        for (const client of clients) {
          await expect(client.locator('[data-dice-presentation-phase]')).toHaveAttribute(
            'data-dice-presentation-phase',
            'settled',
          );
          await expect(client.locator('[data-settled-slot]')).toHaveCount(count);
          expect(
            await client
              .locator('[data-held="true"] [data-die-face]')
              .evaluateAll((dice) => dice.map((die) => die.getAttribute('data-die-face'))),
          ).toEqual(heldValues);
          for (const die of observed.values) {
            await expect(
              client.locator(`[data-authoritative-die-slot="${die.slot}"]`),
            ).toHaveAttribute('data-die-face', String(die.value));
          }
        }
        await actor.screenshot({
          path: test.info().outputPath(`${turn}-${count}-${observed.style}-settled.png`),
        });
      }
      await actor.locator('[data-score-tab="lower"]').click();
      await actor
        .locator(`[data-score-category="${turn < 2 ? 'choice' : 'four-of-a-kind'}"]`)
        .click();
    }
    // The production server chooses a gesture for each new roll.
    for (const roll of rolls) expect(['burst', 'oblique']).toContain(roll.style);
    console.log(
      JSON.stringify({
        diceCoverage: rolls.map(({ style, slots }) => ({ style, count: slots.length })),
      }),
    );
    await testInfo.attach('observed-dice-rolls', {
      body: JSON.stringify(rolls, null, 2),
      contentType: 'application/json',
    });
  } finally {
    await guestContext.close();
  }
});
