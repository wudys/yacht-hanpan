import { expect } from '@playwright/test';

import { joinProductGame, PRODUCT_GAME_ORIGIN } from '../helpers/product-game';
import { createSocketPacketObserver } from '../helpers/socket-packets';
import { test } from '../helpers/test';

for (const { code, expires } of [
  { code: 'INTERNAL_ERROR', expires: false },
  { code: 'ROLL_UNAVAILABLE', expires: false },
  { code: 'ROLL_UNAVAILABLE', expires: true },
] as const) {
  test(
    expires
      ? 'Game expires a roll retry when the server turn advances'
      : `Game explicitly retries the original roll after ${code}`,
    async ({ page, browser }) => {
      test.setTimeout(expires ? 120_000 : 90_000);
      let protocolVersion: string | undefined;
      const commands: unknown[] = [];
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
          const response = packets.observeServer(message);
          protocolVersion = response?.ack.meta.gameProtocolVersion ?? protocolVersion;
          socket.send(message);
        });
        socket.onMessage((message) => {
          const request = packets.observeClient(message);
          if (request?.kind === 'command') {
            const { command } = request;
            commands.push(command);
            if (commands.length === 1) {
              // Reject before server delivery; subsequent sync and retry use the real authority.
              socket.send(
                `43${request.ackId}${JSON.stringify([
                  {
                    ok: false,
                    error: { code, params: {} },
                    meta: {
                      requestId: globalThis.crypto.randomUUID(),
                      gameProtocolVersion: protocolVersion,
                      actionId: command.actionId,
                    },
                  },
                ])}`,
              );
              return;
            }
          }
          server.send(message);
        });
      });
      await page.setViewportSize({ width: 320, height: 740 });
      await page.goto(PRODUCT_GAME_ORIGIN);
      await page.getByRole('button', { name: '게임 시작', exact: true }).click();
      const guestContext = await joinProductGame(page, browser);
      try {
        await page.getByRole('button', { name: '굴리기', exact: true }).click();
        const notice = page.locator('[data-game-command-notice="retryable"]');
        await expect(notice).toBeVisible();
        await expect(notice).toHaveAccessibleName('안내');
        expect(commands).toHaveLength(1);
        if (expires) {
          // Let the actual server deadline advance the turn while the retry notice is open.
          await expect(notice).toHaveCount(0, { timeout: 95_000 });
          await expect(page.getByRole('status')).toHaveText('상대 턴');
          expect(commands).toHaveLength(1);
          return;
        }
        await notice.getByRole('button', { name: '다시 시도', exact: true }).click();
        await expect(notice).toHaveCount(0);
        await expect(page.locator('[data-dice-presentation-phase]')).toHaveAttribute(
          'data-dice-presentation-phase',
          'rolling',
        );
        await expect(page.locator('[data-dice-presentation-phase]')).toHaveAttribute(
          'data-dice-presentation-phase',
          'settled',
        );
        expect(commands).toHaveLength(2);
        expect(commands[1]).toEqual(commands[0]);
        await expect(page.locator('button[data-score-category]').first()).toBeEnabled();
      } finally {
        await guestContext.close();
      }
    },
  );
}

for (const locale of ['ko', 'en'] as const) {
  test(`Game rate-limit notice preserves Settings and does not replay in ${locale}`, async ({
    page,
    browser,
  }) => {
    let protocolVersion: string | undefined;
    let commandCount = 0;
    let rejectNextCommand = true;
    let rejectedAt = 0;
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
        const response = packets.observeServer(message);
        protocolVersion = response?.ack.meta.gameProtocolVersion ?? protocolVersion;
        socket.send(message);
      });
      socket.onMessage((message) => {
        const request = packets.observeClient(message);
        if (request?.kind === 'command') {
          const { command } = request;
          commandCount += 1;
          if (rejectNextCommand) {
            rejectNextCommand = false;
            rejectedAt = Date.now();
            // Fault injection only: never forward the rejected command to the real server.
            // Admission, full-sync, timer and subsequent gameplay remain authoritative.
            socket.send(
              `43${request.ackId}${JSON.stringify([
                {
                  ok: false,
                  error: { code: 'RATE_LIMITED', params: { retryAfterMs: 1500 } },
                  meta: {
                    requestId: globalThis.crypto.randomUUID(),
                    gameProtocolVersion: protocolVersion,
                    actionId: command.actionId,
                  },
                },
              ])}`,
            );
            return;
          }
        }
        server.send(message);
      });
    });
    await page.setViewportSize({ width: 320, height: 740 });
    await page.goto(PRODUCT_GAME_ORIGIN);
    await page.getByRole('button', { name: '게임 시작', exact: true }).click();
    const guestContext = await joinProductGame(page, browser);
    try {
      expect(protocolVersion).toBeDefined();
      await page.getByRole('button', { name: '설정', exact: true }).click();
      if (locale === 'en') await page.getByRole('button', { name: 'English', exact: true }).click();
      const settings = await page.locator('.web-settings-overlay').elementHandle();
      await page
        .getByRole('button', { name: locale === 'en' ? 'Forfeit' : '기권하기', exact: true })
        .click();
      const notice = page.locator('[data-game-command-notice="rate-limited"]');
      await expect(notice).toBeVisible();
      await expect(
        notice.getByRole('heading', { name: locale === 'en' ? 'Notice' : '안내', exact: true }),
      ).toBeVisible();
      await expect(notice.locator('p')).not.toBeEmpty();
      await expect(notice.locator('p')).not.toContainText(/[0-9]/u);
      await expect(page.locator('[data-game-interaction-surface]')).toHaveAttribute('inert', '');
      await expect(notice.getByRole('button')).toHaveCount(1);
      const confirm = notice.getByRole('button', {
        name: locale === 'en' ? 'OK' : '확인',
        exact: true,
      });
      await expect(confirm).toBeVisible();
      const bounds = await notice.boundingBox();
      expect(bounds).not.toBeNull();
      for (const element of await notice.locator('h2, p, button').all()) {
        const box = await element.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(320);
        expect(box!.y + box!.height).toBeLessThanOrEqual(500 * (320 / 360));
        expect(await element.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      }
      const timer = page.locator('.game-board__timer');
      const before = await timer.textContent();
      await expect(timer).not.toHaveText(before!);
      await page.screenshot({
        path: `/tmp/hanpan-rate-limit-${locale}-320-${test.info().project.name}.png`,
      });
      await confirm.click();
      await expect(notice).toHaveCount(0);
      expect(await settings!.evaluate((element) => element.isConnected)).toBe(true);
      await expect(page.locator('[data-game-interaction-surface]')).not.toHaveAttribute('inert');
      // Observe beyond the injected 1500ms cooldown, including a scheduling margin.
      await expect.poll(() => Date.now() - rejectedAt).toBeGreaterThan(1750);
      expect(commandCount).toBe(1);
      await expect(guestContext.pages()[0]!.locator('[data-product-view="game"]')).toBeVisible();
      await page
        .getByRole('button', { name: locale === 'en' ? 'Close' : '닫기', exact: true })
        .click();
      await page
        .getByRole('button', { name: locale === 'en' ? 'Roll' : '굴리기', exact: true })
        .click();
      await expect(page.locator('button[data-score-category="ones"]')).toHaveAttribute(
        'data-value-state',
        'preview',
      );
      expect(commandCount).toBe(2);
    } finally {
      await guestContext.close();
    }
  });
}

test('Game malformed command acknowledgement requires refresh without replaying the command', async ({
  page,
  browser,
}) => {
  let commands = 0;
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
      socket.send(message);
    });
    socket.onMessage((message) => {
      const request = packets.observeClient(message);
      if (request?.kind === 'command') {
        commands += 1;
        // Deliberately malformed: bypass the observer and exercise the client's parser.
        socket.send(`43${request.ackId}${JSON.stringify([{ unexpected: true }])}`);
        return;
      }
      server.send(message);
    });
  });
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  const guest = await joinProductGame(page, browser);
  try {
    await page.getByRole('button', { name: '굴리기', exact: true }).click();
    const terminal = page.locator('[data-game-recovery-terminal="refreshRequired"]');
    await expect(terminal).toBeVisible();
    await expect(terminal.getByRole('button')).toHaveText('새로고침');
    await expect(page.locator('[data-game-interaction-surface]')).toHaveAttribute('inert', '');
    expect(commands).toBe(1);
  } finally {
    await guest.close();
  }
});
