import { expect, type WebSocketRoute } from '@playwright/test';

import { PRODUCT_GAME_ORIGIN } from '../helpers/product-game';
import { test } from '../helpers/test';

test('Lobby bounds a stalled Socket authentication and stops the connection', async ({ page }) => {
  test.setTimeout(40_000);
  let connections = 0;
  let closed = false;
  await page.routeWebSocket(/\/game-socket\//u, (socket) => {
    connections += 1;
    socket.onClose(() => {
      closed = true;
    });
    socket.send(
      `0${JSON.stringify({ sid: 'held-authentication', upgrades: [], pingInterval: 60_000, pingTimeout: 60_000, maxPayload: 1024 })}`,
    );
    socket.onMessage(() => {});
  });
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  await page.getByRole('button', { name: '게임 만들기', exact: true }).click();
  await expect(page.locator('.web-lobby-room-code')).toBeVisible();
  await expect(page.getByRole('button', { name: '새로고침', exact: true })).toBeVisible({
    timeout: 22_000,
  });
  await expect.poll(() => closed).toBe(true);
  await expect(page.getByText('게임에 연결하지 못했어요.', { exact: true })).toBeVisible();
  expect(connections).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem('recentRoom') !== null)).toBe(true);
});

test('Waiting room recovers via full sync or ends at 30 seconds without clearing authority', async ({
  page,
}) => {
  test.setTimeout(60_000);
  let activeSocket: WebSocketRoute | undefined;
  let synced = false;
  let holdSync = false;
  let blockConnections = false;
  let releaseSync: (() => void) | undefined;
  await page.routeWebSocket(/\/game-socket\//u, (socket) => {
    if (blockConnections) {
      void socket.close({ code: 1012 });
      return;
    }
    activeSocket = socket;
    const server = socket.connectToServer();
    server.onMessage((message) => {
      if (
        typeof message === 'string' &&
        message.startsWith('43') &&
        message.includes('serverTime')
      ) {
        synced = true;
        if (holdSync) {
          releaseSync = () => socket.send(message);
          return;
        }
      }
      socket.send(message);
    });
  });
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  await page.getByRole('button', { name: '게임 만들기', exact: true }).click();
  await expect(page.locator('.web-lobby-room-code')).toBeVisible();
  await expect.poll(() => synced).toBe(true);
  await page.evaluate(() =>
    Object.defineProperty(window, '__waitingAuthority', {
      value: localStorage.getItem('recentRoom'),
    }),
  );
  holdSync = true;
  await activeSocket!.close({ code: 1012 });
  await expect(page.getByText('다시 연결 중', { exact: true })).toBeVisible();
  await expect(page.getByText('게임 상태 불러오는 중', { exact: true })).toBeVisible();
  await expect.poll(() => releaseSync !== undefined).toBe(true);
  await page.screenshot({ path: `/tmp/hanpan-waiting-recovery-${test.info().project.name}.png` });
  holdSync = false;
  releaseSync!();
  await expect(page.getByText('상대를 기다리는 중', { exact: true })).toBeVisible();
  blockConnections = true;
  await activeSocket!.close({ code: 1012 });
  await expect(page.getByText('다시 연결 중', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '새로고침', exact: true })).toBeVisible({
    timeout: 32_000,
  });
  await expect(page.locator('.web-lobby-room-code')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => localStorage.getItem('recentRoom') === Reflect.get(window, '__waitingAuthority'),
    ),
  ).toBe(true);
  await page.screenshot({
    path: `/tmp/hanpan-waiting-recovery-ended-${test.info().project.name}.png`,
  });
});

for (const entry of ['admission', 'restore'] as const) {
  test(`Lobby stops a disconnected first full sync during ${entry} and reload restores the saved seat`, async ({
    page,
  }) => {
    let failSync = entry === 'admission';
    let firstSync = false;
    let failedConnections = 0;
    await page.routeWebSocket(/\/game-socket\//u, (socket) => {
      if (failSync) failedConnections += 1;
      const server = socket.connectToServer();
      server.onMessage((message) => {
        if (
          typeof message === 'string' &&
          message.startsWith('43') &&
          message.includes('serverTime')
        ) {
          firstSync = true;
          if (failSync) {
            void socket.close({ code: 1012 });
            return;
          }
        }
        socket.send(message);
      });
    });
    await page.goto(PRODUCT_GAME_ORIGIN);
    await page.getByRole('button', { name: '게임 시작', exact: true }).click();
    await page.getByRole('button', { name: '게임 만들기', exact: true }).click();
    await expect.poll(() => firstSync).toBe(true);
    const saved = await page.evaluate(() => localStorage.getItem('recentRoom'));
    expect(saved).not.toBeNull();
    if (entry === 'restore') {
      failSync = true;
      await page.reload();
      await page.getByRole('button', { name: '게임 시작', exact: true }).click();
    }
    await expect(page.getByRole('button', { name: '새로고침', exact: true })).toBeVisible();
    await expect(page.getByText('게임에 연결하지 못했어요.', { exact: true })).toBeVisible();
    expect(failedConnections).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem('recentRoom'))).toBe(saved);
    failSync = false;
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await page.getByRole('button', { name: '게임 시작', exact: true }).click();
    await expect(page.getByText('상대를 기다리는 중', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('recentRoom'))).toBe(saved);
  });
}
