import { expect, type Page } from '@playwright/test';

import { test } from '../../helpers/test';

async function expectRawCanvas(page: Page) {
  const canvas = page.getByTestId('dice-canvas');
  const host = page.locator('.web-dice-canvas-host');
  await expect(canvas).toHaveCount(1);
  await expect(canvas).toBeVisible();
  await expect(host).toHaveAttribute('data-dice-canvas-state', 'ready');
  await expect(host).toHaveAttribute('data-dice-presentation-phase', 'rolling');
  const bounds = await canvas.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const board = document.querySelector('.physics-diagnostic__playfield')!.getBoundingClientRect();
    const host = element.closest<HTMLElement>('.web-dice-canvas-host')!;
    const { pointerEvents } = host.style;
    host.style.pointerEvents = 'auto';
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    host.style.pointerEvents = pointerEvents;
    return {
      width: rect.width,
      height: rect.height,
      deltas: [
        rect.x - board.x,
        rect.y - board.y,
        rect.width - board.width,
        rect.height - board.height,
      ],
      unobscured: hit === element,
    };
  });
  expect(bounds.width).toBeGreaterThan(0);
  expect(bounds.height).toBeGreaterThan(0);
  for (const delta of bounds.deltas) expect(Math.abs(delta)).toBeLessThan(1);
  expect(bounds.unobscured).toBe(true);
}

test('runs submitted physics inputs and repeats their raw Canvas without a new calculation', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 720, height: 1000 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/dev/physics.html');
  const run = page.getByRole('button', { name: 'Run', exact: true });
  const replay = page.getByRole('button', { name: 'Replay', exact: true });
  await expect(replay).toBeDisabled();
  await run.click();
  await expect(replay).toHaveAttribute('data-physics-complete', 'true', { timeout: 30_000 });
  await expectRawCanvas(page);
  await expect(page.locator('[data-physics-die-slot]')).toHaveCount(5);
  await page.screenshot({
    path: test.info().outputPath('physics-diagnostic-raw.png'),
  });
  const digest = await page.getByTestId('physics-result-digest').textContent();
  const eyes = await page.locator('[data-physics-die-slot]').allTextContents();
  const oldCanvas = await page.getByTestId('dice-canvas').elementHandle();
  await replay.click();
  await expect(replay).toHaveAttribute('data-physics-complete', 'false');
  expect(await oldCanvas!.evaluate((element) => element.isConnected)).toBe(false);
  await expect(replay).toHaveAttribute('data-physics-complete', 'true', { timeout: 20_000 });
  await expectRawCanvas(page);
  expect(await page.getByTestId('physics-result-digest').textContent()).toBe(digest);
  expect(await page.locator('[data-physics-die-slot]').allTextContents()).toEqual(eyes);

  await page.getByRole('textbox', { name: 'Seed' }).fill('1279b7ffdcc9abd2ee896d26ca76e958');
  await page.getByRole('combobox', { name: 'Pour style' }).selectOption('burst');
  await expect(page.getByTestId('physics-current-seed')).toHaveText('gesture-explore-20260921-14');
  await run.click();
  await expect(page.getByTestId('physics-current-seed')).toHaveText(
    '1279b7ffdcc9abd2ee896d26ca76e958',
  );
  await expect(page.getByTestId('physics-current-style')).toHaveText('burst');
  await expect(replay).toHaveAttribute('data-physics-complete', 'true', { timeout: 20_000 });
  await expectRawCanvas(page);
  await expect(page.locator('[data-physics-die-slot]')).toHaveCount(5);

  await page.getByRole('textbox', { name: 'Seed' }).fill('anchor-query');
  await page.getByRole('combobox', { name: 'Pour style' }).selectOption('classic');
  await page.getByRole('spinbutton', { name: 'Dice count' }).fill('2');
  await run.click();
  await expect(page.getByTestId('physics-current-seed')).toHaveText('anchor-query');
  await expect(page.getByTestId('physics-current-count')).toHaveText('2');
  await expect(replay).toHaveAttribute('data-physics-complete', 'true', { timeout: 20_000 });
  await expectRawCanvas(page);
  await expect(page.locator('[data-physics-die-slot]')).toHaveCount(2);
  await page.screenshot({
    path: test.info().outputPath('physics-diagnostic-small.png'),
  });

  await page.getByRole('spinbutton', { name: 'Dice count' }).fill('6');
  await run.click();
  await expect(page.getByRole('alert')).toHaveText('Count must be an integer from 1 to 5');
  await expect(replay).toBeDisabled();
  await expect(replay).toHaveAttribute('data-physics-complete', 'false');
  await expect(page.getByTestId('dice-canvas')).toHaveCount(0);
  expect(errors).toEqual([]);
});
