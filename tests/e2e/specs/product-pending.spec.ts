import { expect, type Page } from '@playwright/test';

import { joinProductGame, PRODUCT_GAME_ORIGIN } from '../helpers/product-game';
import { test } from '../helpers/test';

test('real command pending and opponent presence retain the authoritative Game', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(90_000);
  const rollGate = deferred();
  const scoreGate = deferred();
  const rollReached = deferred();
  const scoreReached = deferred();
  let rollCommandCount = 0;
  let scoreCommandCount = 0;

  await page.routeWebSocket(/\/game-socket\//u, (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => socket.send(message));
    socket.onMessage((message) => {
      const event = typeof message === 'string' ? /^42(\d+)(\[.*\])$/u.exec(message) : null;
      if (event) {
        const [name, command] = JSON.parse(event[2]!) as [string, { type?: unknown }];
        if (name === 'game:command' && command.type === 'rollDice') {
          rollCommandCount += 1;
          rollReached.resolve();
          void rollGate.promise.then(() => server.send(message));
          return;
        }
        if (name === 'game:command' && command.type === 'selectScoreCategory') {
          scoreCommandCount += 1;
          scoreReached.resolve();
          void scoreGate.promise.then(() => server.send(message));
          return;
        }
      }
      server.send(message);
    });
  });

  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  const guestContext = await joinProductGame(page, browser, {
    locale: 'en',
    viewport: { width: 320, height: 568 },
  });
  let creatorOffline = false;

  try {
    const guest = guestContext.pages()[0]!;
    const rollAction = page.locator('.roll-action-rail .ui-button');
    const rollProgress = rollAction.locator('[role="status"]');
    const idleRollBounds = await rollAction.boundingBox();
    expect(idleRollBounds).not.toBeNull();
    await rollAction.click();
    await rollReached.promise;
    await expect(rollAction).toHaveAttribute('aria-disabled', 'true');
    await expect(rollAction.locator('.ui-button__label')).toHaveText('굴리기');
    await expect(rollProgress).toHaveCount(0);
    await page.screenshot({
      path: `/tmp/hanpan-roll-pending-before-600-ko-320-${testInfo.project.name}.png`,
    });
    await expect(rollProgress).toBeVisible();
    await page.screenshot({
      path: `/tmp/hanpan-roll-pending-after-600-ko-320-${testInfo.project.name}.png`,
    });
    const rollBounds = await rollAction.boundingBox();
    expect(rollBounds).not.toBeNull();
    expect(rollBounds!.x).toBeCloseTo(idleRollBounds!.x, 1);
    expect(rollBounds!.y).toBeCloseTo(idleRollBounds!.y, 1);
    expect(rollBounds!.width).toBeCloseTo(idleRollBounds!.width, 1);
    expect(rollBounds!.height).toBeCloseTo(idleRollBounds!.height, 1);
    await page.mouse.click(
      rollBounds!.x + rollBounds!.width / 2,
      rollBounds!.y + rollBounds!.height / 2,
    );
    await nextPaint(page);
    expect(rollCommandCount).toBe(1);

    rollGate.resolve();
    const presentation = page.locator('[data-dice-presentation-phase]');
    await expect(presentation).toHaveAttribute('data-dice-presentation-phase', 'settled');
    const score = page.locator('button[data-score-category][data-value-state="preview"]').first();
    await expect(score).toBeEnabled();
    const category = await score.getAttribute('data-score-category');
    const preview = await score.locator('[data-score-value-kind="preview"]').textContent();
    const idleScoreBounds = await score.boundingBox();
    expect(category).not.toBeNull();
    expect(preview).toMatch(/^\d+$/u);
    expect(idleScoreBounds).not.toBeNull();

    await score.click();
    await scoreReached.promise;
    await expect(score).toHaveAttribute('aria-disabled', 'true');
    await expect(score).toHaveAttribute('data-value-state', 'preview');
    await expect(score.locator('[data-score-value-kind="preview"]')).toHaveText(preview!);
    const scoreBounds = await score.boundingBox();
    expect(scoreBounds).not.toBeNull();
    expect(scoreBounds!.x).toBeCloseTo(idleScoreBounds!.x, 1);
    expect(scoreBounds!.y).toBeCloseTo(idleScoreBounds!.y, 1);
    expect(scoreBounds!.width).toBeCloseTo(idleScoreBounds!.width, 1);
    expect(scoreBounds!.height).toBeCloseTo(idleScoreBounds!.height, 1);
    await page.screenshot({
      path: `/tmp/hanpan-score-pending-ko-320-${testInfo.project.name}.png`,
    });
    await page.mouse.click(
      scoreBounds!.x + scoreBounds!.width / 2,
      scoreBounds!.y + scoreBounds!.height / 2,
    );
    await nextPaint(page);
    expect(scoreCommandCount).toBe(1);

    scoreGate.resolve();
    await expect(guest.locator('[data-product-view="game"]')).toHaveAttribute(
      'data-viewer-turn',
      'true',
    );
    await page.getByRole('button', { name: '점수판', exact: true }).click();
    await expect(
      page.locator(`[data-score-table] tr[data-score-category="${category}"] td`).first(),
    ).toHaveText(preview!);
    await page.getByRole('button', { name: '닫기', exact: true }).click();

    creatorOffline = true;
    await page.context().setOffline(true);
    const presence = guest.locator('.game-board__presence');
    await expect(presence).toHaveText(/.+/u);
    await expect(presence).toHaveAttribute('role', 'status');
    const disconnectedPresence = await presence.textContent();
    expect(disconnectedPresence).not.toBeNull();
    await guest.screenshot({
      path: `/tmp/hanpan-presence-disconnected-en-320-${testInfo.project.name}.png`,
    });

    await page.context().setOffline(false);
    creatorOffline = false;
    await expect
      .poll(async () => {
        const current = await presence.textContent();
        return current !== null && current !== '' && current !== disconnectedPresence;
      })
      .toBe(true);
    await guest.screenshot({
      path: `/tmp/hanpan-presence-reconnected-en-320-${testInfo.project.name}.png`,
    });
    await expect(presence).toHaveText('');
  } finally {
    rollGate.resolve();
    scoreGate.resolve();
    if (creatorOffline) await page.context().setOffline(false);
    await guestContext.close();
  }
});

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolveDeferred!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

async function nextPaint(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}
