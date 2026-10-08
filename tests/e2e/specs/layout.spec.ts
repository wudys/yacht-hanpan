import { expect, type Locator } from '@playwright/test';

import { createTestContext, test } from '../helpers/test';
import { PRODUCTION_GAME_ORIGIN } from '../helpers/test-origins';

const WEB_BASE_URL = PRODUCTION_GAME_ORIGIN;
const LOGICAL_FRAME_WIDTH = 360;
const LOGICAL_FRAME_HEIGHT = 500;
const MAX_FRAME_SCALE = 16 / 9;
const MAX_FRAME_WIDTH = LOGICAL_FRAME_WIDTH * MAX_FRAME_SCALE;
const MAX_FRAME_HEIGHT = LOGICAL_FRAME_HEIGHT * MAX_FRAME_SCALE;

type ExpectedLayout = Readonly<{
  width: number;
  height: number;
  scale: number;
  frameWidth: number;
  frameHeight: number;
  x: number;
  mode: 'compact' | 'wide';
}>;

const FIXTURES: readonly ExpectedLayout[] = [
  {
    width: 280,
    height: 568,
    scale: 280 / LOGICAL_FRAME_WIDTH,
    frameWidth: 280,
    frameHeight: LOGICAL_FRAME_HEIGHT * (280 / LOGICAL_FRAME_WIDTH),
    x: 0,
    mode: 'compact',
  },
  {
    width: 320,
    height: 568,
    scale: 320 / LOGICAL_FRAME_WIDTH,
    frameWidth: 320,
    frameHeight: LOGICAL_FRAME_HEIGHT * (320 / LOGICAL_FRAME_WIDTH),
    x: 0,
    mode: 'compact',
  },
  {
    width: 360,
    height: 500,
    scale: 1,
    frameWidth: LOGICAL_FRAME_WIDTH,
    frameHeight: LOGICAL_FRAME_HEIGHT,
    x: 0,
    mode: 'compact',
  },
  {
    width: 390,
    height: 844,
    scale: 390 / LOGICAL_FRAME_WIDTH,
    frameWidth: 390,
    frameHeight: LOGICAL_FRAME_HEIGHT * (390 / LOGICAL_FRAME_WIDTH),
    x: 0,
    mode: 'compact',
  },
  {
    width: 430,
    height: 932,
    scale: 430 / LOGICAL_FRAME_WIDTH,
    frameWidth: 430,
    frameHeight: LOGICAL_FRAME_HEIGHT * (430 / LOGICAL_FRAME_WIDTH),
    x: 0,
    mode: 'compact',
  },
  {
    width: 431,
    height: 932,
    scale: 431 / LOGICAL_FRAME_WIDTH,
    frameWidth: 431,
    frameHeight: LOGICAL_FRAME_HEIGHT * (431 / LOGICAL_FRAME_WIDTH),
    x: 0,
    mode: 'wide',
  },
  {
    width: 390,
    height: 480,
    scale: 0.96,
    frameWidth: 345.6,
    frameHeight: 480,
    x: 22.2,
    mode: 'compact',
  },
  {
    width: 1024,
    height: 600,
    scale: 1.2,
    frameWidth: 432,
    frameHeight: 600,
    x: 296,
    mode: 'wide',
  },
  {
    width: 1366,
    height: 768,
    scale: 768 / 500,
    frameWidth: LOGICAL_FRAME_WIDTH * (768 / LOGICAL_FRAME_HEIGHT),
    frameHeight: 768,
    x: (1366 - LOGICAL_FRAME_WIDTH * (768 / LOGICAL_FRAME_HEIGHT)) / 2,
    mode: 'wide',
  },
  {
    width: 1536,
    height: 1024,
    scale: MAX_FRAME_SCALE,
    frameWidth: MAX_FRAME_WIDTH,
    frameHeight: MAX_FRAME_HEIGHT,
    x: 448,
    mode: 'wide',
  },
  {
    width: 1920,
    height: 950,
    scale: MAX_FRAME_SCALE,
    frameWidth: MAX_FRAME_WIDTH,
    frameHeight: MAX_FRAME_HEIGHT,
    x: 640,
    mode: 'wide',
  },
  {
    width: 1920,
    height: 900,
    scale: MAX_FRAME_SCALE,
    frameWidth: MAX_FRAME_WIDTH,
    frameHeight: MAX_FRAME_HEIGHT,
    x: 640,
    mode: 'wide',
  },
  {
    width: 1920,
    height: 850,
    scale: 1.7,
    frameWidth: 612,
    frameHeight: 850,
    x: 654,
    mode: 'wide',
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
    await expect(page.locator('[data-play-area-blocker]')).toHaveCount(fixture.width < 320 ? 1 : 0);
    if (fixture.width < 320) {
      await expect(slot).toHaveAttribute('inert', '');
      await expect(slot).toHaveAttribute('aria-hidden', 'true');
    }
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

test('live wide resize reuses the wrapper and reaches the 640px cap', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.goto('/');
  const wrapper = page.locator('[data-game-ui-root=true]');
  const slot = page.locator('[data-game-frame-slot=true]');
  await wrapper.evaluate((element) => element.setAttribute('data-resize-probe', 'same-node'));

  await page.setViewportSize({ width: 1920, height: 950 });

  await expect(wrapper).toHaveAttribute('data-resize-probe', 'same-node');
  await expect(wrapper).toHaveAttribute('data-layout-mode', 'wide');
  await expect.poll(async () => (await slot.boundingBox())?.width).toBeCloseTo(MAX_FRAME_WIDTH, 0);
  const slotBox = await slot.boundingBox();
  expect(slotBox).not.toBeNull();
  expect(slotBox!.x).toBeCloseTo(640, 0);
  expect(slotBox!.width).toBeCloseTo(MAX_FRAME_WIDTH, 0);
  expect(slotBox!.height).toBeCloseTo(MAX_FRAME_HEIGHT, 0);
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
  expect(slotBox!.width).toBeCloseTo(MAX_FRAME_WIDTH, 0);
  expect(slotBox!.height).toBeCloseTo(MAX_FRAME_HEIGHT, 0);

  const logo = page.locator('img.web-logo');
  await expect(logo).toBeVisible();
  await expect(logo).toHaveAttribute('src', /\/assets\/game\/brand\/logo\/.+\.png$/u);
  expect(
    await logo.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
  ).toBe(true);
  const logoBox = await logo.boundingBox();
  expect(logoBox).not.toBeNull();
  await expectLogoAspectRatio(logo);
  expect(logoBox!.width).toBeGreaterThan(0);
  expect(logoBox!.height).toBeGreaterThan(0);

  expect(logoBox!.x).toBeGreaterThanOrEqual(0);
  expect(logoBox!.y).toBeGreaterThanOrEqual(0);
  expect(logoBox!.x + logoBox!.width).toBeLessThanOrEqual(1920);
  expect(logoBox!.y + logoBox!.height).toBeLessThanOrEqual(950);
  expect(rectanglesOverlap(slotBox!, logoBox!)).toBe(false);
  // Layout can be measurable before Chromium has committed the resized compositor frame.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await page.screenshot({ path: test.info().outputPath('wrapper-logo-wide.png') });

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
  const compactLogoBox = await logo.boundingBox();
  const compactSlotBox = await slot.boundingBox();
  expect(compactLogoBox).not.toBeNull();
  expect(compactSlotBox).not.toBeNull();
  expect(compactLogoBox!.width).toBeGreaterThan(0);
  expect(compactLogoBox!.height).toBeGreaterThan(0);
  await expectLogoAspectRatio(logo);
  expect(compactLogoBox!.x).toBeGreaterThanOrEqual(0);
  expect(compactLogoBox!.y).toBeGreaterThanOrEqual(0);
  expect(compactLogoBox!.y + compactLogoBox!.height).toBeLessThanOrEqual(740);
  expect(rectanglesOverlap(compactSlotBox!, compactLogoBox!)).toBe(false);
  expect(compactLogoBox!.x + compactLogoBox!.width).toBeLessThanOrEqual(320);
  await page.screenshot({ path: test.info().outputPath('wrapper-logo-compact.png') });
});

test('production web blocks insufficient height and restores an exposed frame', async ({
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
    const blocker = page.locator('[data-play-area-blocker=true]');
    await expect(blocker).toBeVisible();
    expect(await blocker.boundingBox()).toEqual({ x: 0, y: 0, width: 844, height: 390 });
    expect(
      await page.evaluate(() =>
        document
          .elementFromPoint(innerWidth / 2, innerHeight / 2)
          ?.closest('[data-play-area-blocker=true]')
          ?.hasAttribute('data-play-area-blocker'),
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
      path: testInfo.outputPath('play-area-guard-ko-844x390.png'),
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

async function expectLogoAspectRatio(logo: Locator) {
  const image = await logo.evaluate((node: HTMLImageElement) => {
    const box = node.getBoundingClientRect();
    return {
      naturalRatio: node.naturalWidth / node.naturalHeight,
      boxRatio: box.width / box.height,
      objectFit: getComputedStyle(node).objectFit,
    };
  });
  expect(image.naturalRatio).toBeGreaterThan(0);
  // A contain/scale-down image keeps its natural ratio inside a differently shaped box.
  if (image.objectFit !== 'contain' && image.objectFit !== 'scale-down') {
    expect(image.boxRatio).toBeCloseTo(image.naturalRatio, 3);
  }
}

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

for (const hasTouch of [false, true]) {
  test(`insufficient portrait width and landscape height block ${hasTouch ? 'coarse' : 'fine'} input`, async ({
    browser,
  }) => {
    const context = await createTestContext(browser, {
      hasTouch,
      viewport: { width: 319, height: 740 },
    });
    try {
      const page = await context.newPage();
      await page.goto(WEB_BASE_URL);
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(hasTouch);
      const blocker = page.locator('[data-play-area-blocker]');
      const frame = page.locator('[data-game-frame-slot]');
      await expect(blocker).toBeVisible();
      await expect(frame).toHaveAttribute('inert', '');
      const start = page.getByRole('button', {
        name: '게임 시작',
        exact: true,
        includeHidden: true,
      });
      const hit = await start.boundingBox();
      expect(hit).not.toBeNull();
      await page.mouse.click(hit!.x + hit!.width / 2, hit!.y + hit!.height / 2);
      if (hasTouch) await page.touchscreen.tap(hit!.x + hit!.width / 2, hit!.y + hit!.height / 2);
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
      await expect(page.locator('[data-screen="entry"]')).toBeVisible();
      await page.setViewportSize({ width: 740, height: 444 });
      await expect(blocker).toBeVisible();
      await expect(frame).toHaveAttribute('inert', '');
      await page.setViewportSize({ width: 740, height: 445 });
      await expect(blocker).toHaveCount(0);
      await start.click();
      await expect(page.getByRole('heading', { name: '로비', exact: true })).toBeVisible();
    } finally {
      await context.close();
    }
  });
}

test('wrapper padding is excluded from usable width while logical geometry survives the guard', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 500 });
  await page.goto(WEB_BASE_URL);
  const wrapper = page.locator('[data-game-ui-root]');
  await wrapper.evaluate((element: HTMLElement) => {
    element.style.paddingLeft = '20px';
    element.style.paddingRight = '20px';
  });
  const frame = page.locator('[data-game-frame-slot]');
  await expect.poll(async () => (await frame.boundingBox())?.width).toBeCloseTo(320, 1);
  await expect(page.locator('[data-play-area-blocker]')).toHaveCount(0);
  await wrapper.evaluate((element: HTMLElement) => {
    element.style.paddingRight = '21px';
  });
  await expect(page.locator('[data-play-area-blocker]')).toBeVisible();
  await expect.poll(async () => (await frame.boundingBox())?.width).toBeCloseTo(319, 1);
  await expect(frame).toHaveAttribute('inert', '');
});
