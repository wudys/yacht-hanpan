import { expect, type Page } from '@playwright/test';

import { joinProductGame, PRODUCT_GAME_ORIGIN } from '../helpers/product-game';
import { test } from '../helpers/test';

interface ProductAudioCall {
  readonly src: string;
  status: 'pending' | 'resolved' | 'rejected';
}

declare global {
  interface Window {
    readonly __productAudioCalls: ProductAudioCall[];
    __productAudioContextCount: number;
    __cueBuffers: AudioBuffer[];
  }
}

test('web unlocks and switches BGM through real admission and a server-confirmed result', async ({
  page,
  browser,
}) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    window.__productAudioContextCount = 0;
    window.__cueBuffers = [];
    const nativeCreateBuffer = BaseAudioContext.prototype.createBuffer;
    BaseAudioContext.prototype.createBuffer = function (
      ...args: Parameters<BaseAudioContext['createBuffer']>
    ) {
      const buffer = nativeCreateBuffer.apply(this, args);
      if (this instanceof AudioContext && buffer.duration > 0.02) window.__cueBuffers.push(buffer);
      return buffer;
    };
    const contexts = new WeakSet<BaseAudioContext>();
    const observeContext = (context: BaseAudioContext): void => {
      if (context instanceof AudioContext && !contexts.has(context)) {
        contexts.add(context);
        window.__productAudioContextCount += 1;
      }
    };
    const nativeCreateGain = BaseAudioContext.prototype.createGain;
    BaseAudioContext.prototype.createGain = function createGainWithProbe(): GainNode {
      observeContext(this);
      return nativeCreateGain.call(this);
    };
    const nativeCreateMediaSource = AudioContext.prototype.createMediaElementSource;
    AudioContext.prototype.createMediaElementSource = function createMediaSourceWithProbe(
      media: HTMLMediaElement,
    ): MediaElementAudioSourceNode {
      observeContext(this);
      return nativeCreateMediaSource.call(this, media);
    };
    const calls: ProductAudioCall[] = [];
    Object.defineProperty(window, '__productAudioCalls', { value: calls });
    const nativePlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function playWithProbe(): Promise<void> {
      const call: ProductAudioCall = { src: this.src, status: 'pending' };
      calls.push(call);
      const playback = nativePlay.call(this);
      void playback.then(
        () => {
          call.status = 'resolved';
        },
        () => {
          call.status = 'rejected';
        },
      );
      return playback;
    };
  });

  await page.goto(PRODUCT_GAME_ORIGIN);
  expect(await page.evaluate(() => window.__productAudioContextCount)).toBe(0);
  await page.getByRole('button', { name: '게임 시작' }).click();
  await expect(page.getByRole('heading', { name: '로비' })).toBeVisible();
  await expectScenePlayback(page, '/audio/bgm/lobby/');
  const synthesized = await page.evaluate(() =>
    window.__cueBuffers.map((buffer) => ({
      duration: buffer.duration,
      peak: buffer.getChannelData(0).reduce((peak, v) => Math.max(peak, Math.abs(v)), 0),
    })),
  );
  expect(synthesized).toHaveLength(8);
  expect(synthesized.every(({ peak }) => peak > 0.1 && peak <= 0.77)).toBe(true);
  expect(synthesized.every(({ duration }) => Number.isFinite(duration) && duration > 0)).toBe(true);
  await page.evaluate(() => {
    const calls: number[] = [];
    Object.defineProperty(window, '__sfxStarts', { value: calls });
    const original = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (
      ...args: Parameters<AudioBufferSourceNode['start']>
    ) {
      if (this.context instanceof AudioContext && this.buffer && this.buffer.duration > 0.02)
        calls.push(this.buffer.duration);
      return original.apply(this, args);
    };
  });
  const sfxCount = () =>
    page.evaluate(() => (window as unknown as { __sfxStarts: number[] }).__sfxStarts.length);
  await page.getByRole('button', { name: '설정', exact: true }).click();
  await expect.poll(sfxCount).toBe(1);
  await page.getByRole('switch', { name: '효과음', exact: true }).click();
  expect(await sfxCount()).toBe(1);
  await page.getByRole('switch', { name: '효과음', exact: true }).click();
  await expect.poll(sfxCount).toBe(2);
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await expect.poll(sfxCount).toBe(3);

  const guestContext = await joinProductGame(page, browser);
  try {
    await expectScenePlayback(page, '/audio/bgm/game/');

    await page.getByRole('button', { name: '설정', exact: true }).click();
    await page.getByRole('button', { name: '기권하기', exact: true }).click();
    await expect(page.locator('[data-game-view="result"]')).toBeVisible();
    await expectScenePlayback(page, '/audio/bgm/result/');

    await page.getByRole('button', { name: '로비로 돌아가기', exact: true }).click();
    await expect(page.getByRole('heading', { name: '로비' })).toBeVisible();
    await expectScenePlayback(page, '/audio/bgm/lobby/');
    const lobbyCalls = await page.evaluate(
      (path) => window.__productAudioCalls.filter(({ src }) => src.includes(path)),
      '/audio/bgm/lobby/',
    );
    expect(lobbyCalls).toHaveLength(2);
    expect(lobbyCalls.every(({ status }) => status === 'resolved')).toBe(true);
    expect(await page.evaluate(() => window.__productAudioContextCount)).toBe(1);
  } finally {
    await guestContext.close();
  }
});

async function expectScenePlayback(page: Page, path: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        (scenePath) =>
          window.__productAudioCalls.filter(({ src }) => src.includes(scenePath)).at(-1)?.status ??
          null,
        path,
      ),
    )
    .toBe('resolved');
}
