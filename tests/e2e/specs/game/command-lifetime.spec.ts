import { expect, type Page } from '@playwright/test';
import type { CommandAck, CommittedRoomUpdate, GameCommand } from '@repo/game-protocol/socket';

import {
  clearNativeCues,
  observeNativeCues,
  readNativeCues,
} from '../../helpers/native-audio-probe';
import { createSocketPacketObserver, readRoomStatePacket } from '../../helpers/socket-packets';
import { test } from '../../helpers/test';
import { PRODUCT_GAME_ORIGIN } from '../../helpers/test-origins';
import { createTwoPlayerGame } from '../../helpers/two-player-game';

test('the first roll ACK still completes after all three short acknowledgement windows', async ({
  page,
  browser,
}) => {
  test.setTimeout(60_000);
  const transport = await holdRollAcknowledgements(page);
  await observeNativeCues(page);
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  const guestContext = await createTwoPlayerGame(page, browser);
  try {
    const playback = await observeRollingStarts(page);
    await page.getByRole('button', { name: '굴리기', exact: true }).click();
    await expect(page.locator('[data-dice-presentation-phase]')).toHaveAttribute(
      'data-dice-presentation-phase',
      'settled',
    );
    // The old waiter discarded every callback by 9.3s. Keep the real server clock running.
    await expect.poll(() => transport.elapsed(), { timeout: 15_000 }).toBeGreaterThan(10_000);
    expectSingleRoll(transport);
    expect(transport.syncRequests).toHaveLength(0);
    const score = page.locator('button[data-score-category="ones"]');
    await expect(score).toBeDisabled();
    await expect(page.locator('.roll-action-rail [aria-busy="true"]')).toHaveCount(1);
    await clearNativeCues(page);

    transport.releaseFirstAck();
    await expect(score).toBeEnabled();
    await expect(page.locator('.roll-action-rail [aria-busy="true"]')).toHaveCount(0);
    await page.waitForTimeout(250);
    expect(await playback.evaluate((audit) => audit.starts)).toBe(1);
    expect(await readNativeCues(page)).toEqual([]);
    expect(transport.syncRequests).toHaveLength(0);
    expectSingleRoll(transport);
    await playback.evaluate((audit) => audit.observer.disconnect());
    await playback.dispose();
  } finally {
    await guestContext.close();
  }
});

test('lost roll ACKs end with one full sync and a late ACK cannot replay the roll', async ({
  page,
  browser,
}) => {
  test.setTimeout(80_000);
  const transport = await holdRollAcknowledgements(page);
  await observeNativeCues(page);
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  const guestContext = await createTwoPlayerGame(page, browser);
  try {
    const playback = await observeRollingStarts(page);
    await page.getByRole('button', { name: '굴리기', exact: true }).click();
    await expect(page.locator('[data-dice-presentation-phase]')).toHaveAttribute(
      'data-dice-presentation-phase',
      'settled',
    );
    await expect.poll(() => transport.elapsed(), { timeout: 15_000 }).toBeGreaterThan(10_000);
    const score = page.locator('button[data-score-category="ones"]');
    await expect(score).toBeDisabled();
    expect(transport.syncRequests).toHaveLength(0);
    expectSingleRoll(transport);

    await expect(score).toBeEnabled({ timeout: 42_000 });
    expect(transport.syncRequests).toHaveLength(1);
    expect(transport.syncRequests[0]).toBeGreaterThanOrEqual(44_000);
    expect(transport.elapsed()).toBeLessThan(55_000);
    await expect(page.locator('[data-game-recovery-overlay]')).toHaveCount(0);
    await expect(page.locator('[data-game-recovery-terminal]')).toHaveCount(0);
    const authoritativeFaces = page.locator('[data-authoritative-die-slot][data-die-face]');
    const before = await authoritativeFaces.evaluateAll((dice) =>
      dice.map((die) => die.getAttribute('data-die-face')),
    );
    expect(before).toHaveLength(5);
    await clearNativeCues(page);
    transport.releaseFirstAck();
    await page.waitForTimeout(250);
    expect(await playback.evaluate((audit) => audit.starts)).toBe(1);
    expect(await readNativeCues(page)).toEqual([]);
    expect(
      await authoritativeFaces.evaluateAll((dice) =>
        dice.map((die) => die.getAttribute('data-die-face')),
      ),
    ).toEqual(before);
    await expect(score).toBeEnabled();
    expect(transport.syncRequests).toHaveLength(1);
    expectSingleRoll(transport);
    // A real score command proves that pending and recovery released the gameplay input gate.
    await score.click();
    await expect(guestContext.pages()[0]!.locator('[data-product-view="game"]')).toHaveAttribute(
      'data-viewer-turn',
      'true',
    );
    await playback.evaluate((audit) => audit.observer.disconnect());
    await playback.dispose();
  } finally {
    await guestContext.close();
  }
});

test('lost command and final sync ACKs require refresh within one command budget in English', async ({
  page,
  browser,
}) => {
  test.setTimeout(85_000);
  const transport = await holdRollAcknowledgements(page, { dropFinalSync: true });
  await page.addInitScript(() => localStorage.setItem('locale', 'en'));
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: 'Start Game', exact: true }).click();
  const guestContext = await createTwoPlayerGame(page, browser, { locale: 'en' });
  try {
    await page.evaluate(() => {
      // Retain opaque authority only inside the browser, never in a test assertion payload.
      Reflect.set(window, '__commandLifetimeAuthority', localStorage.getItem('recentRoom'));
    });
    await page.getByRole('button', { name: 'Roll', exact: true }).click();
    const terminal = page.locator('[data-game-recovery-terminal="refreshRequired"]');
    // 45s command response + one 3s sync, with scheduling tolerance; no extra 30s incident.
    await expect(terminal).toBeVisible({ timeout: 55_000 });
    expect(transport.elapsed()).toBeGreaterThanOrEqual(47_000);
    expect(transport.elapsed()).toBeLessThan(55_000);
    expect(transport.syncRequests).toHaveLength(1);
    expect(transport.syncRequests[0]).toBeGreaterThanOrEqual(44_000);
    expectSingleRoll(transport);
    await expect(terminal).toHaveAccessibleName('Notice');
    await expect(terminal.getByRole('button')).toHaveCount(1);
    await expect(terminal.getByRole('button')).toHaveText('Refresh');
    await expect(page.locator('[data-game-interaction-surface]')).toHaveAttribute('inert', '');
    expect(
      await page.evaluate(
        () =>
          localStorage.getItem('recentRoom') !== null &&
          localStorage.getItem('recentRoom') === Reflect.get(window, '__commandLifetimeAuthority'),
      ),
    ).toBe(true);
    await page.waitForTimeout(1_000);
    expect(transport.syncRequests).toHaveLength(1);
    expectSingleRoll(transport);
    await terminal.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Start Game', exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('recentRoom') !== null)).toBe(true);
  } finally {
    await guestContext.close();
  }
});

/** Delay only real ACK delivery; commands, room publications and server deadlines stay real. */
async function holdRollAcknowledgements(
  page: Page,
  options: { readonly dropFinalSync?: boolean } = {},
) {
  const commands: GameCommand[] = [];
  const acknowledgements: CommandAck[] = [];
  const rolls: CommittedRoomUpdate[] = [];
  const syncRequests: number[] = [];
  let firstAckId: string | null = null;
  let firstAck: (() => void) | undefined;
  let startedAt: number | null = null;
  const elapsed = () => (startedAt === null ? 0 : performance.now() - startedAt);
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
      if (response?.kind === 'command' && response.command.type === 'rollDice') {
        acknowledgements.push(response.ack);
        if (response.ackId === firstAckId) firstAck = () => socket.send(message);
        return;
      }
      if (response?.kind === 'sync' && startedAt !== null && options.dropFinalSync) return;
      const update = readRoomStatePacket(message);
      if (update?.type === 'roll:committed') rolls.push(update);
      socket.send(message);
    });
    socket.onMessage((message) => {
      const request = packets.observeClient(message);
      if (request?.kind === 'command' && request.command.type === 'rollDice') {
        startedAt ??= performance.now();
        firstAckId ??= request.ackId;
        commands.push(request.command);
      }
      if (request?.kind === 'sync' && startedAt !== null) syncRequests.push(elapsed());
      server.send(message);
    });
  });
  return {
    commands,
    acknowledgements,
    rolls,
    syncRequests,
    elapsed,
    releaseFirstAck() {
      expect(firstAck).toBeDefined();
      firstAck!();
    },
  };
}

function expectSingleRoll(transport: Awaited<ReturnType<typeof holdRollAcknowledgements>>) {
  expect(transport.commands).toHaveLength(3);
  expect(transport.commands[1]).toEqual(transport.commands[0]);
  expect(transport.commands[2]).toEqual(transport.commands[0]);
  expect(transport.acknowledgements).toHaveLength(3);
  for (const ack of transport.acknowledgements) {
    expect(ack).toMatchObject({
      ok: true,
      data: { view: { game: { match: { status: 'playing', currentTurn: { rollCount: 1 } } } } },
    });
  }
  expect(transport.rolls).toHaveLength(1);
}

async function observeRollingStarts(page: Page) {
  return page.locator('[data-dice-presentation-phase]').evaluateHandle((element) => {
    const audit = { starts: 0, observer: new MutationObserver(() => {}) };
    let previous = element.getAttribute('data-dice-presentation-phase');
    audit.observer = new MutationObserver(() => {
      const phase = element.getAttribute('data-dice-presentation-phase');
      if (phase === 'rolling' && previous !== 'rolling') audit.starts += 1;
      previous = phase;
    });
    audit.observer.observe(element, {
      attributes: true,
      attributeFilter: ['data-dice-presentation-phase'],
    });
    return audit;
  });
}
