import { expect } from '@playwright/test';

import { createTestContext, test } from '../helpers/test';
import { PRODUCTION_GAME_ORIGIN } from '../helpers/test-origins';

const WEB_BASE_URL = PRODUCTION_GAME_ORIGIN;
const LOGICAL_FRAME_WIDTH = 360;
const LOGICAL_FRAME_HEIGHT = 500;
const DESKTOP_MAX_SCALE = 16 / 9;
const DESKTOP_MAX_WIDTH = LOGICAL_FRAME_WIDTH * DESKTOP_MAX_SCALE;
const DESKTOP_MAX_HEIGHT = LOGICAL_FRAME_HEIGHT * DESKTOP_MAX_SCALE;

type ExpectedLayout = Readonly<{
  width: number;
  height: number;
  scale: number;
  frameWidth: number;
  frameHeight: number;
  x: number;
  mode: 'mobile' | 'desktop';
}>;

const FIXTURES: readonly ExpectedLayout[] = [
  {
    width: 280,
    height: 568,
    scale: 280 / LOGICAL_FRAME_WIDTH,
    frameWidth: 280,
    frameHeight: LOGICAL_FRAME_HEIGHT * (280 / LOGICAL_FRAME_WIDTH),
    x: 0,
    mode: 'mobile',
  },
  {
    width: 320,
    height: 568,
    scale: 320 / LOGICAL_FRAME_WIDTH,
    frameWidth: 320,
    frameHeight: LOGICAL_FRAME_HEIGHT * (320 / LOGICAL_FRAME_WIDTH),
    x: 0,
    mode: 'mobile',
  },
  {
    width: 360,
    height: 500,
    scale: 1,
    frameWidth: LOGICAL_FRAME_WIDTH,
    frameHeight: LOGICAL_FRAME_HEIGHT,
    x: 0,
    mode: 'mobile',
  },
  {
    width: 390,
    height: 844,
    scale: 390 / LOGICAL_FRAME_WIDTH,
    frameWidth: 390,
    frameHeight: LOGICAL_FRAME_HEIGHT * (390 / LOGICAL_FRAME_WIDTH),
    x: 0,
    mode: 'mobile',
  },
  {
    width: 430,
    height: 932,
    scale: 430 / LOGICAL_FRAME_WIDTH,
    frameWidth: 430,
    frameHeight: LOGICAL_FRAME_HEIGHT * (430 / LOGICAL_FRAME_WIDTH),
    x: 0,
    mode: 'mobile',
  },
  {
    width: 431,
    height: 932,
    scale: 431 / LOGICAL_FRAME_WIDTH,
    frameWidth: 431,
    frameHeight: LOGICAL_FRAME_HEIGHT * (431 / LOGICAL_FRAME_WIDTH),
    x: 0,
    mode: 'desktop',
  },
  {
    width: 390,
    height: 480,
    scale: 0.96,
    frameWidth: 345.6,
    frameHeight: 480,
    x: 22.2,
    mode: 'mobile',
  },
  {
    width: 1024,
    height: 600,
    scale: 1.2,
    frameWidth: 432,
    frameHeight: 600,
    x: 296,
    mode: 'desktop',
  },
  {
    width: 1366,
    height: 768,
    scale: 768 / 500,
    frameWidth: LOGICAL_FRAME_WIDTH * (768 / LOGICAL_FRAME_HEIGHT),
    frameHeight: 768,
    x: (1366 - LOGICAL_FRAME_WIDTH * (768 / LOGICAL_FRAME_HEIGHT)) / 2,
    mode: 'desktop',
  },
  {
    width: 1536,
    height: 1024,
    scale: DESKTOP_MAX_SCALE,
    frameWidth: DESKTOP_MAX_WIDTH,
    frameHeight: DESKTOP_MAX_HEIGHT,
    x: 448,
    mode: 'desktop',
  },
  {
    width: 1920,
    height: 950,
    scale: DESKTOP_MAX_SCALE,
    frameWidth: DESKTOP_MAX_WIDTH,
    frameHeight: DESKTOP_MAX_HEIGHT,
    x: 640,
    mode: 'desktop',
  },
  {
    width: 1920,
    height: 900,
    scale: DESKTOP_MAX_SCALE,
    frameWidth: DESKTOP_MAX_WIDTH,
    frameHeight: DESKTOP_MAX_HEIGHT,
    x: 640,
    mode: 'desktop',
  },
  {
    width: 1920,
    height: 850,
    scale: 1.7,
    frameWidth: 612,
    frameHeight: 850,
    x: 654,
    mode: 'desktop',
  },
];

for (const fixture of FIXTURES) {
  test(`${fixture.width}x${fixture.height} preserves the logical canvas`, async ({ page }) => {
    await page.setViewportSize({ width: fixture.width, height: fixture.height });
    await page.goto('/');
    const wrapper = page.locator('[data-game-ui-root=true]');
    const slot = page.locator('[data-game-frame-slot=true]');
    const canvas = page.locator('[data-game-logical-canvas=true]');
    await expect(wrapper).toHaveAttribute('data-layout-mode', fixture.mode);
    await expect(wrapper).toHaveAttribute('data-measured', 'true');
    const slotBox = await slot.boundingBox();
    const canvasBox = await canvas.boundingBox();
    expect(slotBox).not.toBeNull();
    expect(canvasBox).not.toBeNull();
    expect(slotBox!.x).toBeCloseTo(fixture.x, 0);
    expect(slotBox!.y).toBeCloseTo(0, 0);
    expect(slotBox!.width).toBeCloseTo(fixture.frameWidth, 0);
    expect(slotBox!.height).toBeCloseTo(fixture.frameHeight, 0);
    expect(canvasBox!.width / canvasBox!.height).toBeCloseTo(
      LOGICAL_FRAME_WIDTH / LOGICAL_FRAME_HEIGHT,
      4,
    );
    expect(canvasBox!.width).toBeCloseTo(fixture.frameWidth, 0);
    expect(
      await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        width: innerWidth,
        height: innerHeight,
      })),
    ).toEqual({
      scrollWidth: fixture.width,
      scrollHeight: fixture.height,
      width: fixture.width,
      height: fixture.height,
    });
  });
}

test('live desktop resize reuses the wrapper and reaches the 640px cap', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.goto('/');
  const wrapper = page.locator('[data-game-ui-root=true]');
  const slot = page.locator('[data-game-frame-slot=true]');
  await wrapper.evaluate((element) => element.setAttribute('data-resize-probe', 'same-node'));

  await page.setViewportSize({ width: 1920, height: 950 });

  await expect(wrapper).toHaveAttribute('data-resize-probe', 'same-node');
  await expect(wrapper).toHaveAttribute('data-layout-mode', 'desktop');
  await expect
    .poll(async () => (await slot.boundingBox())?.width)
    .toBeCloseTo(DESKTOP_MAX_WIDTH, 0);
  const slotBox = await slot.boundingBox();
  expect(slotBox).not.toBeNull();
  expect(slotBox!.x).toBeCloseTo(640, 0);
  expect(slotBox!.width).toBeCloseTo(DESKTOP_MAX_WIDTH, 0);
  expect(slotBox!.height).toBeCloseTo(DESKTOP_MAX_HEIGHT, 0);
});

test('production web keeps the responsive frame across a route transition', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 950 });
  await page.goto(WEB_BASE_URL);
  const wrapper = page.locator('[data-game-ui-root=true]');
  const slot = page.locator('[data-game-frame-slot=true]');
  await wrapper.evaluate((element) => element.setAttribute('data-route-probe', 'same-node'));

  const slotBox = await slot.boundingBox();
  expect(slotBox).not.toBeNull();
  expect(slotBox!.x).toBeCloseTo(640, 0);
  expect(slotBox!.width).toBeCloseTo(DESKTOP_MAX_WIDTH, 0);
  expect(slotBox!.height).toBeCloseTo(DESKTOP_MAX_HEIGHT, 0);

  const logo = page.locator('img.web-logo');
  await expect(logo).toBeVisible();
  await expect(logo).toHaveAttribute('src', /\/assets\/game\/brand\/logo\/.+\.png$/u);
  expect(
    await logo.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
  ).toBe(true);
  const logoBox = await logo.boundingBox();
  expect(logoBox).not.toBeNull();
  expect(logoBox!.width).toBe(80);
  expect(logoBox!.height).toBe(32);
  expect(rectanglesOverlap(slotBox!, logoBox!)).toBe(false);
  // Layout can be measurable before Chromium has committed the resized compositor frame.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await page.screenshot({ path: test.info().outputPath('wrapper-logo-desktop.png') });

  await page.getByRole('button', { name: '게임 시작' }).click();
  await expect(page.getByRole('heading', { name: '로비' })).toBeVisible();
  await expect(wrapper).toHaveAttribute('data-route-probe', 'same-node');
  await page.setViewportSize({ width: 320, height: 740 });
  await expect.poll(async () => (await slot.boundingBox())?.width).toBe(320);
  await expect
    .poll(async () => {
      const bounds = await logo.boundingBox();
      return bounds ? bounds.x + bounds.width : Infinity;
    })
    .toBeLessThanOrEqual(320);
  await expect(logo).toBeVisible();
  const mobileLogoBox = await logo.boundingBox();
  const mobileSlotBox = await slot.boundingBox();
  expect(mobileLogoBox).not.toBeNull();
  expect(mobileSlotBox).not.toBeNull();
  expect(rectanglesOverlap(mobileSlotBox!, mobileLogoBox!)).toBe(false);
  expect(mobileLogoBox!.x + mobileLogoBox!.width).toBeLessThanOrEqual(320);
  await page.screenshot({ path: test.info().outputPath('wrapper-logo-mobile.png') });
});

test('production web blocks coarse landscape input and restores portrait', async ({
  browser,
}, testInfo) => {
  const context = await createTestContext(browser, {
    hasTouch: true,
    isMobile: true,
    viewport: { width: 844, height: 390 },
  });
  try {
    const page = await context.newPage();
    await page.goto(WEB_BASE_URL);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    const blocker = page.locator('[data-orientation-blocker=true]');
    await expect(blocker).toBeVisible();
    expect(await blocker.boundingBox()).toEqual({ x: 0, y: 0, width: 844, height: 390 });
    expect(
      await page.evaluate(() =>
        document
          .elementFromPoint(innerWidth / 2, innerHeight / 2)
          ?.closest('[data-orientation-blocker=true]')
          ?.hasAttribute('data-orientation-blocker'),
      ),
    ).toBe(true);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    await blocker.screenshot({
      path: testInfo.outputPath('orientation-guard-ko-844x390.png'),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(blocker).toHaveCount(0);
    await expect(page.locator('[data-game-frame-slot=true]')).toBeInViewport();
    await page.getByRole('button', { name: '게임 시작', exact: true }).click();
    await expect(page.getByRole('heading', { name: '로비', exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

function rectanglesOverlap(
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number },
): boolean {
  return !(
    first.x + first.width <= second.x ||
    second.x + second.width <= first.x ||
    first.y + first.height <= second.y ||
    second.y + second.height <= first.y
  );
}
