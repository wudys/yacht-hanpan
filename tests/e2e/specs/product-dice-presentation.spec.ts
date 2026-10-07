import { expect, type WebSocketRoute } from '@playwright/test';

import { joinProductGame, PRODUCT_GAME_ORIGIN } from '../helpers/product-game';
import { createSocketPacketObserver } from '../helpers/socket-packets';
import { test } from '../helpers/test';

test('full sync settles a pending roll and its delayed duplicate ACK does not replay it', async ({
  page,
  browser,
}) => {
  test.setTimeout(60_000);
  let activeSocket: WebSocketRoute | undefined;
  let releaseRollAck: (() => void) | undefined;
  let heldRollAcks = 0;
  let gateOpen = false;
  const rollCommands: unknown[] = [];
  await page.routeWebSocket(/\/game-socket\//u, (socket) => {
    activeSocket = socket;
    const server = socket.connectToServer();
    const packets = createSocketPacketObserver();
    socket.onClose((code, reason) => {
      packets.dispose();
      void server.close({ code, reason });
    });
    server.onClose((code, reason) => {
      packets.dispose();
      void socket.close({ code, reason });
    });
    server.onMessage((message) => {
      const response = packets.observeServer(message);
      if (
        !gateOpen &&
        response?.kind === 'command' &&
        response.ack.ok &&
        'roll' in response.ack.data.receipt
      ) {
        heldRollAcks += 1;
        releaseRollAck = () => socket.send(message);
        return;
      }
      socket.send(message);
    });
    socket.onMessage((message) => {
      const request = packets.observeClient(message);
      if (request?.kind === 'command' && request.command.type === 'rollDice')
        rollCommands.push(request.command);
      server.send(message);
    });
  });
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  const guestContext = await joinProductGame(page, browser);
  try {
    const host = page.locator('[data-dice-presentation-phase]');
    await host.evaluate((element) => {
      let previous = element.getAttribute('data-dice-presentation-phase');
      let rollingStarts = 0;
      const record = () => {
        const phase = element.getAttribute('data-dice-presentation-phase');
        if (phase === 'rolling' && previous !== 'rolling') rollingStarts += 1;
        previous = phase;
        element.setAttribute('data-rolling-starts', String(rollingStarts));
      };
      record();
      new MutationObserver(record).observe(element, {
        attributes: true,
        attributeFilter: ['data-dice-presentation-phase'],
      });
    });
    await page.getByRole('button', { name: '굴리기', exact: true }).click();
    await expect(host).toHaveAttribute('data-dice-presentation-phase', 'rolling');
    await expect.poll(() => heldRollAcks).toBe(1);
    expect(activeSocket).toBeDefined();
    await activeSocket!.close({ code: 1012, reason: 'pending roll restore regression' });
    await expect(page.locator('[data-game-recovery-overlay]')).toBeVisible();
    await expect(page.locator('[data-game-recovery-overlay]')).toHaveCount(0);
    await expect(host).toHaveAttribute('data-dice-presentation-phase', 'settled');
    await expect(page.locator('[data-settled-slot]')).toHaveCount(5);
    await expect(page.locator('button[data-score-category]').first()).toBeDisabled();
    await expect.poll(() => heldRollAcks).toBe(2);
    expect(rollCommands).toHaveLength(2);
    expect(rollCommands[1]).toEqual(rollCommands[0]);
    await expect(host).toHaveAttribute('data-rolling-starts', '1');
    gateOpen = true;
    releaseRollAck!();
    await expect(page.locator('button[data-score-category]').first()).toBeEnabled();
    await expect(host).toHaveAttribute('data-dice-presentation-phase', 'settled');
    await expect(host).toHaveAttribute('data-rolling-starts', '1');
  } finally {
    gateOpen = true;
    await guestContext.close();
  }
});

test('opponent forfeit cancels active physical replay on both clients', async ({
  page,
  browser,
}) => {
  test.setTimeout(60_000);
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  const guestContext = await joinProductGame(page, browser);
  try {
    const guest = guestContext.pages()[0]!;
    // Open the opponent's settings before the roll so the terminal command is
    // sent during actual replay, without a fabricated snapshot or slowed clock.
    await guest.getByRole('button', { name: '설정', exact: true }).click();
    await page.getByRole('button', { name: '굴리기', exact: true }).click();
    for (const client of [page, guest]) {
      await expect(client.locator('[data-dice-presentation-phase]')).toHaveAttribute(
        'data-dice-presentation-phase',
        'rolling',
      );
    }
    const forfeit = guest.locator('[data-settings-action="forfeit"] button');
    // Read immediately: waiting for an enabled button could hide a lock until settled.
    expect(await forfeit.getAttribute('aria-disabled')).toBe('false');
    await guest.screenshot({
      path: `/tmp/hanpan-settings-rolling-ko-${test.info().project.name}.png`,
    });
    await guest.getByRole('button', { name: 'English', exact: true }).click();
    await guest.getByRole('switch', { name: 'Music', exact: true }).click();
    await guest.getByRole('switch', { name: 'Sound effects', exact: true }).click();
    await expect(guest.getByRole('switch', { name: 'Music', exact: true })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await expect(guest.getByRole('switch', { name: 'Sound effects', exact: true })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(
      await guest
        .locator('[data-dice-presentation-phase]')
        .getAttribute('data-dice-presentation-phase'),
    ).toBe('rolling');
    await guest.screenshot({
      path: `/tmp/hanpan-settings-rolling-en-${test.info().project.name}.png`,
    });
    await guest.getByRole('button', { name: 'Forfeit', exact: true }).click();
    for (const client of [page, guest]) {
      await expect(client.locator('[data-product-view="result"]')).toBeVisible();
      await expect(client.locator('[data-dice-presentation-phase]')).toHaveAttribute(
        'data-dice-presentation-phase',
        'hidden',
      );
      await expect(client.locator('[data-settled-slot]')).toHaveCount(0);
      await expect(client.locator('[data-value-state="preview"]')).toHaveCount(0);
    }
  } finally {
    await guestContext.close();
  }
});

test('lost WebGL context releases the Canvas and preserves the session', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  const guestContext = await joinProductGame(page, browser);
  try {
    await page.evaluate(() => {
      Object.defineProperty(window, '__contextLossAuthority', {
        value: localStorage.getItem('recentRoom'),
      });
    });
    await page.getByRole('button', { name: '굴리기', exact: true }).click();
    await expect(page.locator('[data-dice-presentation-phase]')).toHaveAttribute(
      'data-dice-presentation-phase',
      'rolling',
    );
    await page.locator('.web-dice-canvas-host canvas').evaluate((element) => {
      const context = (element as HTMLCanvasElement).getContext('webgl2');
      const extension = context?.getExtension('WEBGL_lose_context');
      if (!extension) throw new Error('Browser test requires WEBGL_lose_context');
      extension.loseContext();
    });
    const failure = page.locator('[data-global-failure="runtimeFailure"]');
    await expect(failure).toBeVisible();
    await expect(failure.getByRole('button', { name: '새로고침', exact: true })).toBeVisible();
    await expect(page.getByTestId('global-interaction-surface')).toHaveAttribute('inert', '');
    await expect(page.locator('.web-dice-canvas-host canvas')).toHaveCount(0);
    await expect(page.locator('[data-screen="game"]')).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          localStorage.getItem('recentRoom') !== null &&
          localStorage.getItem('recentRoom') === Reflect.get(window, '__contextLossAuthority'),
      ),
    ).toBe(true);
    const guest = guestContext.pages()[0]!;
    await guest.getByRole('button', { name: '설정', exact: true }).click();
    await guest.getByRole('button', { name: '기권하기', exact: true }).click();
    await expect(page.locator('[data-product-view="result"]')).toBeVisible();
  } finally {
    await guestContext.close();
  }
});

test('real rolls replay inside the board and settle before score input unlocks', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  const guestContext = await joinProductGame(page, browser, {
    viewport: { width: 320, height: 568 },
  });
  try {
    const guest = guestContext.pages()[0]!;
    const host = page.locator('[data-dice-presentation-phase]');
    await expect(host).toHaveAttribute('data-dice-canvas-state', 'ready');
    await page.evaluate(() => {
      const canvasHost = document.querySelector('[data-dice-presentation-phase]')!;
      const observer = new MutationObserver(() => {
        if (canvasHost.getAttribute('data-dice-presentation-phase') !== 'revealing') return;
        const audit = {
          previews: document.querySelectorAll('[data-value-state="preview"]').length,
          scoresLocked: [
            ...document.querySelectorAll<HTMLButtonElement>('button[data-score-category]'),
          ].every((button) => button.disabled || button.getAttribute('aria-disabled') === 'true'),
        };
        canvasHost.setAttribute('data-reveal-audit', JSON.stringify(audit));
        observer.disconnect();
      });
      observer.observe(canvasHost, {
        attributes: true,
        attributeFilter: ['data-dice-presentation-phase'],
      });
    });
    // Observe the first real roll, not a fixture replay that already warmed its resources.
    // Font/BGM background requests and API/Socket traffic are not gameplay assets.
    const lateRequests: string[] = [];
    for (const client of [page, guest]) {
      client.on('request', (request) => {
        if (
          ['script', 'image'].includes(request.resourceType()) ||
          /\.wasm(?:\?|$)/u.test(request.url())
        )
          lateRequests.push(request.url());
      });
    }
    await page.getByRole('button', { name: '굴리기', exact: true }).click();
    await expect(host).toHaveAttribute('data-dice-presentation-phase', 'rolling');
    await expect(page.locator('button[data-score-category]').first()).toBeDisabled();
    await expect(page.locator('[data-value-state="preview"]')).toHaveCount(0);
    // Current ScoreGrid omits the highest-score label until a preview is available.
    await expect(page.locator('[data-score-tab="lower"] span')).toHaveCount(0);
    const canvasBounds = await host.boundingBox();
    const boardBounds = await page.locator('.dice-board').boundingBox();
    const scoreBounds = await page.locator('.score-grid').boundingBox();
    const frameBounds = await page.locator('[data-game-logical-canvas]').boundingBox();
    expect(canvasBounds).not.toBeNull();
    expect(boardBounds).not.toBeNull();
    expect(scoreBounds).not.toBeNull();
    expect(frameBounds).not.toBeNull();
    const frameScale = frameBounds!.width / 360;
    expect(Math.abs(canvasBounds!.x - boardBounds!.x)).toBeLessThan(1);
    expect(Math.abs(canvasBounds!.width - boardBounds!.width)).toBeLessThan(1);
    expect(canvasBounds!.y + canvasBounds!.height).toBeLessThanOrEqual(scoreBounds!.y);
    await page.screenshot({
      path: `/tmp/hanpan-physical-roll-320-${test.info().project.name}.png`,
    });
    await expect(page.locator('.roll-action-rail')).toBeHidden();
    await expect(page.locator('.held-dice-rack')).toBeVisible();
    await expect(host).toHaveAttribute('data-dice-presentation-phase', 'settled');
    expect(JSON.parse((await host.getAttribute('data-reveal-audit'))!)).toEqual({
      previews: 0,
      scoresLocked: true,
    });
    await expect(page.locator('button[data-score-category]').first()).toBeEnabled();
    await expect(page.locator('[data-value-state="preview"]')).toHaveCount(6);
    await expect(page.locator('[data-score-tab="lower"] span')).not.toHaveText(/—$/u);
    const scoreTabBounds = await page.locator('[data-score-tab="lower"]').boundingBox();
    const scoreCellBounds = await page.locator('button[data-score-category]').first().boundingBox();
    expect(scoreTabBounds).not.toBeNull();
    expect(scoreCellBounds).not.toBeNull();
    expect(scoreCellBounds!.height / frameScale).toBeGreaterThanOrEqual(44);
    expect(scoreTabBounds!.height).toBeLessThan(scoreCellBounds!.height);
    const targets = page.locator('[data-settled-slot]');
    await expect(targets).toHaveCount(5);
    let previousRight = 0;
    for (const target of await targets.all()) {
      const bounds = await target.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.width / frameScale).toBeGreaterThanOrEqual(43.9);
      expect(bounds!.height / frameScale).toBeGreaterThanOrEqual(43.9);
      expect(bounds!.x).toBeGreaterThanOrEqual(previousRight);
      expect(bounds!.y).toBeGreaterThanOrEqual(boardBounds!.y);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(boardBounds!.y + boardBounds!.height);
      previousRight = bounds!.x + bounds!.width;
      expect(
        await target.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return hit === element || element.contains(hit);
        }),
      ).toBe(true);
    }
    await expect(guest.locator('[data-dice-presentation-phase]')).toHaveAttribute(
      'data-dice-presentation-phase',
      'settled',
    );
    expect(lateRequests).toEqual([]);
    const faces = '[data-authoritative-die-slot][data-die-face]';
    await expect(page.locator(faces)).toHaveCount(5);
    const ownFaces = await page
      .locator(faces)
      .evaluateAll((dice) => dice.map((die) => die.getAttribute('data-die-face')));
    await expect
      .poll(() =>
        guest
          .locator(faces)
          .evaluateAll((dice) => dice.map((die) => die.getAttribute('data-die-face'))),
      )
      .toEqual(ownFaces);
    await page.screenshot({
      path: `/tmp/hanpan-physical-settled-320-${test.info().project.name}.png`,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('[data-settled-slot="4"]').click();
    const held = page.locator('.held-dice-rack__slot[data-held="true"]');
    await expect(held).toHaveAttribute('data-held-slot', '4');
    await expect(page.locator('.held-dice-rack__slot').first()).toHaveAttribute(
      'data-held',
      'true',
    );
    await page.getByRole('button', { name: '다시 굴리기', exact: true }).click();
    await expect(host).toHaveAttribute('data-dice-presentation-phase', 'rolling');
    await expect(held).toBeVisible();
    await expect(page.locator('.roll-action-rail')).toBeHidden();
    const floor = await page.locator('.dice-board__physics-area').boundingBox();
    const rack = await page.locator('.held-dice-rack').boundingBox();
    const rollingCanvas = await host.boundingBox();
    expect(floor).not.toBeNull();
    expect(rack).not.toBeNull();
    expect(rollingCanvas).not.toBeNull();
    expect(floor!.y).toBeGreaterThanOrEqual(rack!.y + rack!.height - 1);
    expect(floor!.y + floor!.height).toBeLessThanOrEqual(rollingCanvas!.y + rollingCanvas!.height);
    const desktopScale = rollingCanvas!.width / 340;
    expect(Math.abs(floor!.x - rollingCanvas!.x - 4 * desktopScale)).toBeLessThan(1);
    expect(Math.abs(floor!.width - 332 * desktopScale)).toBeLessThan(1);
    await page.screenshot({
      path: `/tmp/hanpan-reroll-held-desktop-${test.info().project.name}.png`,
    });
    await expect(host).toHaveAttribute('data-dice-presentation-phase', 'settled');
    await expect(held).toHaveAttribute('data-held-slot', '4');
  } finally {
    await guestContext.close();
  }
});
