import { expect, type Page } from '@playwright/test';
import { type GameSnapshot, MATCH_END_REASON } from '@repo/game-protocol/socket';

import {
  clearNativeCues,
  observeNativeCues,
  readNativeCues,
  retainNativeAudio,
} from '../helpers/native-audio';
import { joinProductGame, PRODUCT_GAME_ORIGIN } from '../helpers/product-game';
import {
  disposeScoreFeedback,
  observeScoreFeedback,
  readScoreFeedback,
} from '../helpers/score-feedback';
import { createSocketPacketObserver, readRoomStatePacket } from '../helpers/socket-packets';
import { createTestContext, test } from '../helpers/test';

for (const restore of [
  { name: 'portrait', width: 320, height: 740 },
  { name: 'wide', width: 1024, height: 768 },
] as const) {
  for (const locale of ['ko', 'en'] as const) {
    test(`${restore.name} return synchronizes before unlocking Game in ${locale}`, async ({
      browser,
    }, testInfo) => {
      const context = await createTestContext(browser, {
        hasTouch: true,
        viewport: { width: restore.width, height: restore.height },
      });
      const page = await context.newPage();
      let holdSync = false;
      let heldSyncCount = 0;
      let releaseSync: (() => void) | undefined;
      await page.routeWebSocket(/\/game-socket\//u, (socket) => {
        const server = socket.connectToServer();
        const packets = createSocketPacketObserver();
        socket.onMessage((message) => {
          packets.observeClient(message);
          server.send(message);
        });
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
          if (holdSync && response?.kind === 'sync' && response.ack.ok) {
            heldSyncCount += 1;
            releaseSync = () => socket.send(message);
            return;
          }
          socket.send(message);
        });
      });
      try {
        await page.goto(PRODUCT_GAME_ORIGIN);
        expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
        await page.getByRole('button', { name: '게임 시작', exact: true }).click();
        const guestContext = await joinProductGame(page, browser);
        try {
          await page.getByRole('button', { name: '설정', exact: true }).click();
          if (locale === 'en')
            await page.getByRole('button', { name: 'English', exact: true }).click();
          const settings = await page.locator('.web-settings-overlay').elementHandle();
          const canvas = await page.locator('.web-dice-canvas-host canvas').elementHandle();
          const captureSize =
            restore.name === 'portrait' ? { width: 320, height: 360 } : { width: 600, height: 300 };
          await page.setViewportSize(captureSize);
          const guard = page.locator('[data-play-area-blocker]');
          await expect(guard).toBeVisible();
          const message = guard.locator('.game-play-area-blocker__message');
          const messageBox = await message.boundingBox();
          expect(messageBox).not.toBeNull();
          expect(messageBox!.x).toBeGreaterThanOrEqual(0);
          expect(messageBox!.y).toBeGreaterThanOrEqual(0);
          expect(messageBox!.x + messageBox!.width).toBeLessThanOrEqual(captureSize.width);
          expect(messageBox!.y + messageBox!.height).toBeLessThanOrEqual(captureSize.height);
          await page.screenshot({
            path: testInfo.outputPath(
              `play-area-guard-${locale}-${captureSize.width}x${captureSize.height}.png`,
            ),
          });
          await page.setViewportSize({ width: 319, height: 740 });
          await expect(page.locator('[data-play-area-blocker]')).toBeVisible();
          await page.screenshot({
            path: testInfo.outputPath(`play-area-guard-${restore.name}-${locale}-319x740.png`),
          });
          await page.setViewportSize({ width: 740, height: 320 });
          await expect(page.locator('[data-play-area-blocker]')).toBeVisible();
          await page.screenshot({
            path: testInfo.outputPath(`play-area-guard-${restore.name}-${locale}-740x320.png`),
          });
          holdSync = true;
          await page.evaluate(() => {
            const probe = { unlockedFrames: 0, frame: 0 };
            Reflect.set(window, '__playAreaRecoveryProbe', probe);
            const sample = () => {
              const surface = document.querySelector('[data-game-interaction-surface]');
              if (
                !document.querySelector('[data-play-area-blocker]') &&
                surface &&
                !surface.hasAttribute('inert')
              ) {
                probe.unlockedFrames += 1;
              }
              probe.frame = requestAnimationFrame(sample);
            };
            probe.frame = requestAnimationFrame(sample);
          });
          await page.setViewportSize({ width: restore.width, height: restore.height });
          await expect.poll(() => releaseSync !== undefined).toBe(true);
          const surface = page.locator('[data-game-interaction-surface]');
          await expect(surface).toHaveAttribute('inert', '');
          await expect(page.locator('[data-game-recovery-overlay]')).toBeVisible();
          await page.screenshot({
            path: testInfo.outputPath(`play-area-sync-${restore.name}-${locale}.png`),
          });
          const unlockedFrames = await page.evaluate(() => {
            const probe = Reflect.get(window, '__playAreaRecoveryProbe') as {
              unlockedFrames: number;
              frame: number;
            };
            cancelAnimationFrame(probe.frame);
            return probe.unlockedFrames;
          });
          expect(unlockedFrames).toBe(0);
          expect(heldSyncCount).toBe(1);
          holdSync = false;
          releaseSync!();
          await expect(page.locator('[data-game-recovery-overlay]')).toHaveCount(0);
          await expect(surface).not.toHaveAttribute('inert');
          expect(await settings!.evaluate((element) => element.isConnected)).toBe(true);
          expect(await canvas!.evaluate((element) => element.isConnected)).toBe(true);
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
        } finally {
          await guestContext.close();
        }
      } finally {
        await context.close();
      }
    });
  }
}

async function rollAndSettle(page: Page, category: 'ones' | 'twos' = 'ones') {
  await page.getByRole('button', { name: '굴리기', exact: true }).click();
  await expect(page.locator('[data-dice-presentation-phase]')).toHaveAttribute(
    'data-dice-presentation-phase',
    'settled',
  );
  await expect(page.locator(`button[data-score-category="${category}"]`)).toHaveAttribute(
    'data-value-state',
    'preview',
  );
}

function observeLiveGame(page: Page) {
  let latest: GameSnapshot | null = null;
  let commands = 0;
  page.on('websocket', (socket) => {
    if (!socket.url().includes('/game-socket/')) return;
    const packets = createSocketPacketObserver();
    socket.on('framesent', ({ payload }) => {
      if (packets.observeClient(payload)?.kind === 'command') commands += 1;
    });
    socket.on('framereceived', ({ payload }) => {
      const update = readRoomStatePacket(payload);
      if (update?.view.game) latest = update.view.game;
      const response = packets.observeServer(payload);
      if (response?.ack.ok) {
        const game =
          response.kind === 'sync' ? response.ack.data.game : response.ack.data.view.game;
        if (game && (latest === null || game.stateVersion >= latest.stateVersion)) latest = game;
      }
    });
    socket.once('close', () => packets.dispose());
  });
  return { game: () => latest, commandCount: () => commands };
}

test('a coarse tablet landscape permits real admission, roll, and score', async ({ browser }) => {
  const context = await createTestContext(browser, {
    hasTouch: true,
    viewport: { width: 1024, height: 768 },
  });
  try {
    const page = await context.newPage();
    const live = observeLiveGame(page);
    await page.goto(PRODUCT_GAME_ORIGIN);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await expect(page.locator('[data-play-area-blocker]')).toHaveCount(0);
    await page.getByRole('button', { name: '게임 시작', exact: true }).click();
    const guestContext = await joinProductGame(page, browser, {
      viewport: { width: 1024, height: 768 },
    });
    try {
      const roll = page.locator('.roll-action-rail .ui-button');
      await roll.focus();
      const hit = await roll.boundingBox();
      expect(hit).not.toBeNull();
      await page.mouse.move(hit!.x + hit!.width / 2, hit!.y + hit!.height / 2);
      await page.mouse.down();
      await page.setViewportSize({ width: 740, height: 320 });
      await expect(page.locator('[data-play-area-blocker]')).toBeVisible();
      await page.mouse.up();
      const coveredHit = await roll.boundingBox();
      expect(coveredHit).not.toBeNull();
      await page.touchscreen.tap(
        coveredHit!.x + coveredHit!.width / 2,
        coveredHit!.y + coveredHit!.height / 2,
      );
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      expect(live.commandCount()).toBe(0);
      await page.setViewportSize({ width: 1024, height: 768 });
      await expect(page.locator('[data-game-recovery-overlay]')).toHaveCount(0);
      await expect(page.locator('[data-play-area-blocker]')).toHaveCount(0);
      await rollAndSettle(page);
      const ones = page.locator('button[data-score-category="ones"]');
      const preview = await ones.locator('[data-score-value-kind]').textContent();
      await ones.click();
      await expect.poll(() => live.game()?.match.players[0].scorecard.ones).toBe(Number(preview));
      await expect(guestContext.pages()[0]!.locator('[data-player-summary]')).toHaveAttribute(
        'data-player-summary',
        'viewer',
      );
      expect(live.commandCount()).toBe(2);
    } finally {
      await guestContext.close();
    }
  } finally {
    await context.close();
  }
});

test('covered real records update both seats without native SFX or deferred feedback', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await observeNativeCues(page);
  const hostLive = observeLiveGame(page);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  let guestLive: ReturnType<typeof observeLiveGame> | undefined;
  const guestContext = await joinProductGame(page, browser, {
    onGuestPage: async (guest) => {
      await observeNativeCues(guest);
      guestLive = observeLiveGame(guest);
    },
  });
  const guest = guestContext.pages()[0]!;
  try {
    for (const [seat, actor, observer, live] of [
      [0, page, guest, guestLive!],
      [1, guest, page, hostLive],
    ] as const) {
      await actor.setViewportSize({ width: 320, height: 740 });
      await expect(actor.locator('[data-game-recovery-overlay]')).toHaveCount(0);
      await rollAndSettle(actor);
      await expect(observer.locator('[data-dice-presentation-phase]')).toHaveAttribute(
        'data-dice-presentation-phase',
        'settled',
      );
      const audio = await retainNativeAudio(observer);
      await observer.locator('[data-score-tab="lower"]').click();
      await observer.setViewportSize({ width: 740, height: 320 });
      await expect(observer.locator('[data-play-area-blocker]')).toBeVisible();
      await clearNativeCues(observer);
      const feedback = await observeScoreFeedback(observer);
      try {
        const version = live.game()!.stateVersion;
        const ones = actor.locator('button[data-score-category="ones"]');
        const preview = Number(await ones.locator('[data-score-value-kind]').textContent());
        await ones.click();
        await expect.poll(() => live.game()?.match.players[seat].scorecard.ones).toBe(preview);
        expect(live.game()!.stateVersion).toBeGreaterThan(version);
        await expect(observer.locator('[data-player-summary]')).toHaveAttribute(
          'data-player-summary',
          'viewer',
        );
        // Observe the whole 1000ms local confirmation window, including short-lived effects.
        await observer.waitForTimeout(1100);
        expect((await readNativeCues(observer)).filter(({ kind }) => kind === 'start')).toEqual([]);
        const covered = await readScoreFeedback(feedback);
        expect(covered.every(({ category, turnCue }) => category === null && !turnCue)).toBe(true);
        expect(covered.some(({ group }) => group === 'upper')).toBe(true);
        await expect(observer.locator('[data-score-tab="upper"]')).toHaveAttribute(
          'aria-selected',
          'true',
        );
        expect(
          await audio.evaluate(({ context, media }) => ({
            contextState: context?.state,
            playing: media !== undefined && !media.paused,
          })),
        ).toEqual({ contextState: 'running', playing: true });
        await observer.setViewportSize({ width: 320, height: 740 });
        await expect(observer.locator('[data-game-recovery-overlay]')).toHaveCount(0);
        await expect(observer.locator('[data-play-area-blocker]')).toHaveCount(0);
        await expect(observer.locator('[data-score-tab="upper"]')).toHaveAttribute(
          'aria-selected',
          'true',
        );
        expect((await readNativeCues(observer)).filter(({ kind }) => kind === 'start')).toEqual([]);
      } finally {
        await disposeScoreFeedback(feedback);
        await audio.dispose();
      }
    }
    await rollAndSettle(page, 'twos');
    await expect(guest.locator('[data-dice-presentation-phase]')).toHaveAttribute(
      'data-dice-presentation-phase',
      'settled',
    );
    await clearNativeCues(guest);
    const feedback = await observeScoreFeedback(guest);
    try {
      await page.locator('button[data-score-category="twos"]').click();
      await expect
        .poll(
          async () => (await readNativeCues(guest)).filter(({ kind }) => kind === 'start').length,
        )
        .toBe(1);
      await expect
        .poll(async () =>
          (await readScoreFeedback(feedback)).some(({ category }) => category === 'twos'),
        )
        .toBe(true);
      const starts = (await readNativeCues(guest)).filter(({ kind }) => kind === 'start');
      expect(starts[0]).toMatchObject({ covered: false, contextState: 'running' });
    } finally {
      await disposeScoreFeedback(feedback);
    }
  } finally {
    await guestContext.close();
  }
});

for (const completion of ['covered', 'restored'] as const) {
  test(`a real pending hold completes once with no deferred cue when its ACK arrives ${completion}`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(60_000);
    await observeNativeCues(page);
    let holdAck = true;
    let releaseHold: (() => void) | undefined;
    let holds = 0;
    let receiptVersion: number | undefined;
    const live = observeLiveGame(page);
    await page.routeWebSocket(/\/game-socket\//u, (socket) => {
      const server = socket.connectToServer();
      const packets = createSocketPacketObserver();
      socket.onMessage((message) => {
        const request = packets.observeClient(message);
        if (request?.kind === 'command' && request.command.type === 'setDieHeld') holds += 1;
        server.send(message);
      });
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
          holdAck &&
          response?.kind === 'command' &&
          response.command.type === 'setDieHeld' &&
          response.ack.ok
        ) {
          receiptVersion = response.ack.data.receipt.stateVersion;
          releaseHold = () => socket.send(message);
          return;
        }
        socket.send(message);
      });
    });
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto(PRODUCT_GAME_ORIGIN);
    await page.getByRole('button', { name: '게임 시작', exact: true }).click();
    const guestContext = await joinProductGame(page, browser);
    try {
      await rollAndSettle(page);
      await page.locator('[data-settled-slot="0"]').click();
      await expect.poll(() => releaseHold !== undefined).toBe(true);
      await page.setViewportSize({ width: 740, height: 320 });
      await expect(page.locator('[data-play-area-blocker]')).toBeVisible();
      await clearNativeCues(page);
      if (completion === 'restored') {
        await page.setViewportSize({ width: 1024, height: 768 });
        await expect(page.locator('[data-play-area-blocker]')).toHaveCount(0);
        await expect(page.locator('[data-game-recovery-overlay]')).toHaveCount(0);
      }
      holdAck = false;
      releaseHold!();
      await expect.poll(() => live.game()?.stateVersion).toBeGreaterThanOrEqual(receiptVersion!);
      if (completion === 'covered') {
        await page.setViewportSize({ width: 1024, height: 768 });
        await expect(page.locator('[data-game-recovery-overlay]')).toHaveCount(0);
      }
      const held = page.locator('[data-held-slot="0"]');
      await expect(held).toHaveAttribute('aria-pressed', 'true');
      await expect(held).toBeEnabled();
      const game = live.game();
      expect(game?.match.status).toBe('playing');
      if (game?.match.status === 'playing') {
        expect(game.match.currentTurn.rollCount).toBe(1);
        expect(game.match.currentTurn.heldSlots).toEqual([0]);
      }
      expect(holds).toBe(1);
      expect((await readNativeCues(page)).filter(({ kind }) => kind === 'start')).toEqual([]);
      // The next exposed hold command uses the same real ACK completion path and must sound.
      await held.click();
      await expect
        .poll(
          async () => (await readNativeCues(page)).filter(({ kind }) => kind === 'start').length,
        )
        .toBe(1);
      expect(holds).toBe(2);
    } finally {
      await guestContext.close();
    }
  });
}

test('Lobby code, caret, local layer and Canvas survive exposed resizing and a visualViewport-only keyboard change', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  await page.getByRole('button', { name: '게임 참가', exact: true }).click();
  const input = page.getByRole('textbox');
  await input.fill('1234');
  await input.evaluate((element: HTMLInputElement) => element.setSelectionRange(2, 2));
  const canvas = await page.locator('.web-dice-canvas-host canvas').elementHandle();
  const codeInput = await input.elementHandle();
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(page.locator('[data-play-area-blocker]')).toHaveCount(0);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('1234');
  expect(await input.evaluate((element: HTMLInputElement) => element.selectionStart)).toBe(2);
  await input.press('5');
  await expect(input).toHaveValue('12534');
  const frame = await page.locator('[data-game-frame-slot]').boundingBox();
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.defineProperty(viewport, 'height', { configurable: true, get: () => 200 });
    viewport.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('[data-play-area-blocker]')).toHaveCount(0);
  expect(await page.locator('[data-game-frame-slot]').boundingBox()).toEqual(frame);
  await expect(input).toBeFocused();
  expect(await codeInput!.evaluate((element) => element.isConnected)).toBe(true);
  expect(await canvas!.evaluate((element) => element.isConnected)).toBe(true);
});

test('a covered game-only disconnect restores a missed score through fresh sync before exposed input', async ({
  page,
  browser,
}) => {
  test.setTimeout(60_000);
  const hostLive = observeLiveGame(page);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  let disconnectGuest: (() => Promise<void>) | undefined;
  let holdAuthentication = false;
  let releaseAuthentication: (() => void) | undefined;
  let syncs = 0;
  let deliveredGame: GameSnapshot | null = null;
  const guestGame = (): GameSnapshot | null => deliveredGame;
  const guestContext = await joinProductGame(page, browser, {
    onGuestPage: async (guest) => {
      await observeNativeCues(guest);
      await guest.routeWebSocket(/\/game-socket\//u, (socket) => {
        const server = socket.connectToServer();
        const packets = createSocketPacketObserver();
        let retired = false;
        disconnectGuest = async () => {
          retired = true;
          packets.dispose();
          await socket.close({ code: 1012, reason: 'covered game connection regression' });
          await server.close({ code: 1012, reason: 'covered game connection regression' });
        };
        socket.onMessage((message) => {
          if (holdAuthentication && typeof message === 'string' && message.startsWith('40')) {
            releaseAuthentication = () => server.send(message);
            return;
          }
          packets.observeClient(message);
          server.send(message);
        });
        socket.onClose((code, reason) => {
          packets.dispose();
          void server.close({ code, reason });
        });
        server.onClose((code, reason) => {
          packets.dispose();
          void socket.close({ code, reason });
        });
        server.onMessage((message) => {
          if (retired) return;
          const response = packets.observeServer(message);
          if (response?.kind === 'sync' && response.ack.ok) {
            syncs += 1;
            deliveredGame = response.ack.data.game;
          }
          const update = readRoomStatePacket(message);
          if (update?.view.game) deliveredGame = update.view.game;
          socket.send(message);
        });
      });
    },
  });
  const guest = guestContext.pages()[0]!;
  try {
    await rollAndSettle(page);
    await expect.poll(() => guestGame()?.stateVersion).toBe(hostLive.game()!.stateVersion);
    await guest.getByRole('button', { name: '점수판', exact: true }).click();
    const guestScoreRow = guest.locator('[data-score-row][data-score-category="ones"]');
    const guestRecordedScore = guestScoreRow.locator('[data-score-state="recorded"]');
    await expect(guestScoreRow).toHaveCount(1);
    await expect(guestScoreRow.locator('[data-score-state="empty"]')).toHaveCount(2);
    await expect(guestRecordedScore).toHaveCount(0);
    const before = guestGame()!;
    await guest.setViewportSize({ width: 740, height: 320 });
    await expect(guest.locator('[data-play-area-blocker]')).toBeVisible();
    holdAuthentication = true;
    const beforeSyncs = syncs;
    await disconnectGuest!();
    await expect(guest.locator('[data-game-recovery-overlay]')).toHaveCount(1);
    await expect.poll(() => releaseAuthentication !== undefined).toBe(true);
    const ones = page.locator('button[data-score-category="ones"]');
    const score = Number(await ones.locator('[data-score-value-kind]').textContent());
    await ones.click();
    await expect.poll(() => hostLive.game()?.match.players[0].scorecard.ones).toBe(score);
    const current = hostLive.game()!;
    expect(current.stateVersion).toBeGreaterThan(before.stateVersion);
    expect(guestGame()?.match.players[0].scorecard.ones).toBeUndefined();
    await expect(guestScoreRow).toHaveCount(1);
    await expect(guestScoreRow.locator('[data-score-state="empty"]')).toHaveCount(2);
    await expect(guestRecordedScore).toHaveCount(0);
    await clearNativeCues(guest);
    holdAuthentication = false;
    releaseAuthentication!();
    await expect.poll(() => syncs).toBeGreaterThan(beforeSyncs);
    await expect.poll(() => guestGame()?.stateVersion).toBe(current.stateVersion);
    await expect(guestRecordedScore).toHaveText(String(score));
    await expect(guest.locator('[data-game-recovery-overlay]')).toHaveCount(0);
    await expect(guest.locator('[data-play-area-blocker]')).toBeVisible();
    expect(guestGame()).toEqual(current);
    const beforeExposureSyncs = syncs;
    await guest.setViewportSize({ width: 1024, height: 768 });
    await expect.poll(() => syncs).toBeGreaterThan(beforeExposureSyncs);
    await expect(guest.locator('[data-game-recovery-overlay]')).toHaveCount(0);
    await expect(guest.locator('[data-game-interaction-surface]')).not.toHaveAttribute('inert');
    await expect(guest.locator('[data-score-confirmed]')).toHaveCount(0);
    await expect(guest.locator('[data-turn-cue]')).toHaveCount(0);
    expect((await readNativeCues(guest)).filter(({ kind }) => kind === 'start')).toEqual([]);
    await expect(guestRecordedScore).toHaveText(String(score));
    await guest.getByRole('button', { name: '닫기', exact: true }).click();
    await rollAndSettle(guest);
  } finally {
    await guestContext.close();
  }
});

test('a covered finished publication preserves pending ACK, clears authority and restores Result without reentry', async ({
  page,
  browser,
}) => {
  test.setTimeout(60_000);
  await observeNativeCues(page);
  const live = observeLiveGame(page);
  let releaseForfeit: (() => void) | undefined;
  let releaseAck: (() => void) | undefined;
  let forfeitCommands = 0;
  let syncRequests = 0;
  let receiptVersion: number | undefined;
  let socketClosed = false;
  await page.routeWebSocket(/\/game-socket\//u, (socket) => {
    const server = socket.connectToServer();
    const packets = createSocketPacketObserver();
    socket.onMessage((message) => {
      const request = packets.observeClient(message);
      if (request?.kind === 'sync') syncRequests += 1;
      if (request?.kind === 'command' && request.command.type === 'forfeitMatch') {
        forfeitCommands += 1;
        releaseForfeit = () => server.send(message);
        return;
      }
      server.send(message);
    });
    socket.onClose((code, reason) => {
      socketClosed = true;
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
        response?.kind === 'command' &&
        response.command.type === 'forfeitMatch' &&
        response.ack.ok
      ) {
        receiptVersion = response.ack.data.receipt.stateVersion;
        releaseAck = () => socket.send(message);
        return;
      }
      socket.send(message);
    });
  });
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  const guestContext = await joinProductGame(page, browser);
  try {
    const canvas = await page.locator('.web-dice-canvas-host canvas').elementHandle();
    await page.getByRole('button', { name: '설정', exact: true }).click();
    await page.getByRole('button', { name: '기권하기', exact: true }).click();
    await expect.poll(() => releaseForfeit !== undefined).toBe(true);
    await page.setViewportSize({ width: 740, height: 320 });
    await expect(page.locator('[data-play-area-blocker]')).toBeVisible();
    await clearNativeCues(page);
    releaseForfeit!();
    await expect.poll(() => releaseAck !== undefined).toBe(true);
    await expect(page.locator('[data-game-view="result"]')).toHaveCount(1);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('recentRoom') === null))
      .toBe(true);
    expect(socketClosed).toBe(false);
    const game = live.game();
    expect(game?.match.status).toBe('finished');
    if (game?.match.status === 'finished')
      expect(game.match.result).toMatchObject({
        reason: MATCH_END_REASON.EXPLICIT_FORFEIT,
        winnerSeatIndex: 1,
      });
    expect(game?.stateVersion).toBe(receiptVersion);
    const syncsBeforeReturn = syncRequests;
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(page.locator('[data-play-area-blocker]')).toHaveCount(0);
    await expect(page.locator('[data-game-view="result"]')).toBeVisible();
    expect(syncRequests).toBe(syncsBeforeReturn);
    expect(socketClosed).toBe(false);
    releaseAck!();
    await expect.poll(() => socketClosed).toBe(true);
    expect(forfeitCommands).toBe(1);
    expect((await readNativeCues(page)).filter(({ kind }) => kind === 'start')).toEqual([]);
    expect(await canvas!.evaluate((element) => element.isConnected)).toBe(true);
    await expect(page.locator('[data-game-view="result"]')).toBeVisible();
  } finally {
    await guestContext.close();
  }
});

test('a roll pending at size loss preserves its real receipt, Canvas and single authoritative outcome', async ({
  page,
  browser,
}) => {
  test.setTimeout(60_000);
  let releaseRollAck: (() => void) | undefined;
  let receiptVersion: number | undefined;
  let rollRequests = 0;
  const live = observeLiveGame(page);
  await page.routeWebSocket(/\/game-socket\//u, (socket) => {
    const server = socket.connectToServer();
    const packets = createSocketPacketObserver();
    socket.onMessage((message) => {
      const request = packets.observeClient(message);
      if (request?.kind === 'command' && request.command.type === 'rollDice') rollRequests += 1;
      server.send(message);
    });
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
      if (response?.kind === 'command' && response.command.type === 'rollDice' && response.ack.ok) {
        receiptVersion = response.ack.data.receipt.stateVersion;
        releaseRollAck = () => socket.send(message);
        return;
      }
      socket.send(message);
    });
  });
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  const guestContext = await joinProductGame(page, browser);
  try {
    const canvas = await page.locator('.web-dice-canvas-host canvas').elementHandle();
    const beforeVersion = live.game()!.stateVersion;
    await page.getByRole('button', { name: '굴리기', exact: true }).click();
    await expect.poll(() => releaseRollAck !== undefined).toBe(true);
    await page.setViewportSize({ width: 740, height: 320 });
    await expect(page.locator('[data-play-area-blocker]')).toBeVisible();
    releaseRollAck!();
    await expect(page.locator('[data-dice-presentation-phase]')).toHaveAttribute(
      'data-dice-presentation-phase',
      'settled',
    );
    expect(await canvas!.evaluate((element) => element.isConnected)).toBe(true);
    expect(live.game()?.stateVersion).toBe(receiptVersion);
    expect(receiptVersion).toBe(beforeVersion + 1);
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(page.locator('[data-game-recovery-overlay]')).toHaveCount(0);
    await expect(page.locator('button[data-score-category="ones"]')).toBeEnabled();
    const game = live.game();
    expect(game?.match.status).toBe('playing');
    if (game?.match.status === 'playing') {
      expect(game.match.currentTurn.rollCount).toBe(1);
      expect(game.match.currentTurn.dice).toHaveLength(5);
    }
    expect(rollRequests).toBe(1);
    expect(await canvas!.evaluate((element) => element.isConnected)).toBe(true);
  } finally {
    await guestContext.close();
  }
});

test('clipboard completion under the guard preserves copy status without native SFX or return catchup', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: PRODUCT_GAME_ORIGIN,
  });
  await observeNativeCues(page);
  await page.addInitScript(() => {
    const nativeWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
    const probe = {
      hold: true,
      calls: 0,
      completed: 0,
      release: undefined as (() => void) | undefined,
    };
    Reflect.set(window, '__playAreaClipboard', probe);
    navigator.clipboard.writeText = async (text: string) => {
      probe.calls += 1;
      await nativeWrite(text);
      probe.completed += 1;
      if (probe.hold) {
        await new Promise<void>((resolve) => {
          probe.release = resolve;
        });
      }
    };
  });
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  await page.locator('[data-room-action="create"] button').click();
  const copy = page.locator('.web-lobby-copy-button');
  await expect(copy).toHaveAttribute('data-copy-status', 'idle');
  await copy.click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const probe = Reflect.get(window, '__playAreaClipboard') as {
          calls: number;
          completed: number;
          release: (() => void) | undefined;
        };
        return { calls: probe.calls, completed: probe.completed, held: !!probe.release };
      }),
    )
    .toEqual({ calls: 1, completed: 1, held: true });
  expect(
    await page.evaluate(async () => {
      const code = document.querySelector('[data-room-code]')?.getAttribute('data-room-code');
      return (await navigator.clipboard.readText()) === code;
    }),
  ).toBe(true);
  await page.setViewportSize({ width: 740, height: 320 });
  await expect(page.locator('[data-play-area-blocker]')).toBeVisible();
  await clearNativeCues(page);
  await page.evaluate(() => {
    const probe = Reflect.get(window, '__playAreaClipboard') as {
      hold: boolean;
      release: () => void;
    };
    probe.hold = false;
    probe.release();
  });
  await expect(copy).toHaveAttribute('data-copy-status', 'copied');
  expect((await readNativeCues(page)).filter(({ kind }) => kind === 'start')).toEqual([]);
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(page.locator('[data-play-area-blocker]')).toHaveCount(0);
  await expect(copy).toHaveAttribute('data-copy-status', 'copied');
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  expect((await readNativeCues(page)).filter(({ kind }) => kind === 'start')).toEqual([]);
  await copy.click();
  await expect
    .poll(async () => (await readNativeCues(page)).filter(({ kind }) => kind === 'start').length)
    .toBe(1);
  const starts = (await readNativeCues(page)).filter(({ kind }) => kind === 'start');
  expect(starts[0]).toMatchObject({ covered: false, contextState: 'running' });
  expect(
    await page.evaluate(() => {
      const probe = Reflect.get(window, '__playAreaClipboard') as {
        calls: number;
        completed: number;
      };
      return { calls: probe.calls, completed: probe.completed };
    }),
  ).toEqual({ calls: 2, completed: 2 });
});
