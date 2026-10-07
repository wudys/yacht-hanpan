import { expect } from '@playwright/test';

import { joinProductGame, PRODUCT_GAME_ORIGIN } from '../helpers/product-game';
import { createSocketPacketObserver, readRoomStatePacket } from '../helpers/socket-packets';
import { test } from '../helpers/test';

test('real deadline warns at five seconds and locks input before the next server turn arrives', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(130_000);
  let holdState = false;
  let commandCount = 0;
  const pendingStates: Array<() => void> = [];
  await page.routeWebSocket(/\/game-socket\//u, (socket) => {
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
      packets.observeServer(message);
      const update = readRoomStatePacket(message);
      // Hold only delivery of genuine updates; the server and opponent keep running.
      if (holdState && update !== null) {
        pendingStates.push(() => socket.send(message));
        return;
      }
      socket.send(message);
    });
    socket.onMessage((message) => {
      if (packets.observeClient(message)?.kind === 'command') {
        commandCount += 1;
      }
      server.send(message);
    });
  });
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  const guestContext = await joinProductGame(page, browser, {
    viewport: { width: 320, height: 568 },
  });
  try {
    const guest = guestContext.pages()[0]!;
    const timer = page.locator('.game-board__timer');
    await expect(timer).toHaveAttribute('data-timer-warning', 'false');
    const ordinaryColor = await timer.evaluate((node) => getComputedStyle(node).color);
    await page.getByRole('button', { name: '굴리기', exact: true }).click();
    await page.locator('[data-score-tab="lower"]').click();
    const choice = page.locator('button[data-score-category="choice"]');
    await expect(choice).toBeEnabled();
    const roll = page.getByRole('button', { name: '다시 굴리기', exact: true });
    await expect(roll).toBeEnabled();
    holdState = true;

    await expect(timer).toHaveText('5초', { timeout: 95_000 });
    await expect(timer).toHaveAttribute('data-timer-warning', 'true');
    expect(await timer.evaluate((node) => getComputedStyle(node).color)).not.toBe(ordinaryColor);
    await expect(choice).toBeEnabled();
    await page.screenshot({ path: `/tmp/hanpan-timer-five-ko-320-${testInfo.project.name}.png` });

    await expect(timer).toHaveText('0초');
    await expect(roll).toBeDisabled();
    await expect(choice).toBeDisabled();
    const before = commandCount;
    for (const action of [roll, choice]) {
      const box = await action.boundingBox();
      expect(box).not.toBeNull();
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    }
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    expect(commandCount).toBe(before);
    await page.screenshot({ path: `/tmp/hanpan-timer-zero-ko-320-${testInfo.project.name}.png` });
    await expect(guest.locator('[data-product-view="game"]')).toHaveAttribute(
      'data-viewer-turn',
      'true',
    );
    expect(pendingStates.length).toBeGreaterThan(0);

    holdState = false;
    for (const send of pendingStates.splice(0)) send();
    await expect(page.locator('[data-product-view="game"]')).toHaveAttribute(
      'data-viewer-turn',
      'false',
    );
    await expect(timer).toHaveAttribute('data-timer-warning', 'false');
    await expect(timer).not.toHaveText('0초');
  } finally {
    holdState = false;
    for (const send of pendingStates.splice(0)) send();
    await guestContext.close();
  }
});
