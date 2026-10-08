import { expect, type Page } from '@playwright/test';

import { test } from '../../helpers/test';
import { PRODUCT_GAME_ORIGIN } from '../../helpers/test-origins';
import { createTwoPlayerGame } from '../../helpers/two-player-game';

async function expectLayerFits(page: Page) {
  const frame = await page.locator('[data-game-frame-slot]').boundingBox();
  const layer = await page.locator('.scrollable-panel').boundingBox();
  expect(frame).not.toBeNull();
  expect(layer).not.toBeNull();
  expect(layer!.x).toBeGreaterThanOrEqual(frame!.x);
  expect(layer!.y).toBeGreaterThanOrEqual(frame!.y);
  expect(layer!.x + layer!.width).toBeLessThanOrEqual(frame!.x + frame!.width + 0.1);
  expect(layer!.y + layer!.height).toBeLessThanOrEqual(frame!.y + frame!.height + 0.1);
}

for (const locale of ['ko', 'en'] as const) {
  for (const width of [320, 360]) {
    test(`initial profile write failure stays inside its panel and can be saved again ${locale} ${width}`, async ({
      page,
    }) => {
      const english = locale === 'en';
      await page.setViewportSize({ width, height: 740 });
      await page.addInitScript((value) => {
        localStorage.setItem('locale', value);
        const { setItem } = Storage.prototype;
        Storage.prototype.setItem = function (key: string, data: string) {
          if (key === 'profileSelection' && sessionStorage.getItem('allow-profile-save') !== 'true')
            throw new DOMException('Synthetic write denial', 'QuotaExceededError');
          return setItem.call(this, key, data);
        };
      }, locale);
      await page.goto(PRODUCT_GAME_ORIGIN);
      await page
        .getByRole('button', { name: english ? 'Start Game' : '게임 시작', exact: true })
        .click();
      await expect(page.locator('[data-lobby-view="home"]')).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
      await page
        .getByRole('button', { name: english ? 'Profile Settings' : '프로필 설정', exact: true })
        .click();
      await expect(page.getByRole('alert')).toHaveText(
        english ? 'Couldn’t save your profile.' : '프로필을 저장하지 못했어요.',
      );
      await expectLayerFits(page);
      await page.screenshot({ path: test.info().outputPath('initial-profile-failure.png') });
      await page.evaluate(() => sessionStorage.setItem('allow-profile-save', 'true'));
      const selected = page.locator('[data-character-id][aria-pressed="true"]');
      const characterId = await selected.getAttribute('data-character-id');
      await selected.click();
      await expect(page.getByRole('alert')).toHaveCount(0);
      expect(
        await page.evaluate(
          () => JSON.parse(localStorage.getItem('profileSelection')!).characterId,
        ),
      ).toBe(characterId);
      await page.getByRole('button', { name: english ? 'Close' : '닫기', exact: true }).click();
      await expect(page.locator('[data-room-action="create"] button')).toBeEnabled();
    });
  }
}

test('profile and preferences persist and remain shared in the actual Game', async ({
  page,
  browser,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  await page.getByRole('button', { name: '프로필 설정', exact: true }).click();
  const choices = page.locator('[data-character-id]');
  await expect(choices).toHaveCount(12);
  const initialProfile = await page.evaluate(() => localStorage.getItem('profileSelection'));
  const order = await choices.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-character-id')),
  );
  await page.getByRole('tab', { name: '스타일 2', exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem('profileSelection'))).toBe(initialProfile);
  expect(
    await choices.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-character-id')),
    ),
  ).toEqual(order);
  const selected = choices.nth(3);
  const characterId = await selected.getAttribute('data-character-id');
  await selected.click();
  const cardBounds = await selected.boundingBox();
  expect(cardBounds!.width).toBeCloseTo(cardBounds!.height, 1);
  await expect(selected).toHaveAttribute('aria-pressed', 'true');
  await expectLayerFits(page);
  await page.screenshot({ path: `/tmp/hanpan-profile-320-${test.info().project.name}.png` });
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '설정', exact: true }).click();
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Settings', exact: true })).toBeVisible();
  await page.getByRole('switch', { name: 'Music', exact: true }).click();
  await page.getByRole('switch', { name: 'Sound effects', exact: true }).click();
  await expectLayerFits(page);
  await page.screenshot({
    path: `/tmp/hanpan-settings-lobby-en-320-${test.info().project.name}.png`,
  });
  await page.reload();
  await page.getByRole('button', { name: 'Start Game', exact: true }).click();
  await page.getByRole('button', { name: 'Profile Settings', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Style 2', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator(`[data-character-id="${characterId}"]`)).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const guestContext = await createTwoPlayerGame(page, browser);
  try {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('switch', { name: 'Music' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await expect(page.getByRole('switch', { name: 'Sound effects' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await expect(page.getByRole('button', { name: 'Forfeit', exact: true })).toBeVisible();
    await expectLayerFits(page);
    await page.screenshot({
      path: `/tmp/hanpan-settings-game-en-320-${test.info().project.name}.png`,
    });
    const timer = page.locator('.game-board__timer');
    const timerBefore = await timer.textContent();
    await expect(timer).not.toHaveText(timerBefore!);
    await page.getByRole('button', { name: '한국어', exact: true }).click();
    await expect(page.getByRole('button', { name: '기권하기', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '닫기', exact: true }).click();
    await expect(page.getByRole('button', { name: '굴리기', exact: true })).toBeVisible();
  } finally {
    await guestContext.close();
  }
});

for (const locale of ['ko', 'en'] as const) {
  for (const width of [320, 360]) {
    test(`blocked settings storage retains toggles and displays one inline warning ${locale} ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 740 });
      await page.addInitScript((value) => {
        localStorage.setItem('locale', value);
        Storage.prototype.setItem = () => {
          throw new Error('blocked');
        };
      }, locale);
      await page.goto(PRODUCT_GAME_ORIGIN);
      await page
        .getByRole('button', { name: locale === 'ko' ? '게임 시작' : 'Start Game', exact: true })
        .click();
      await page
        .getByRole('button', { name: locale === 'ko' ? '설정' : 'Settings', exact: true })
        .click();
      const surface = page.locator('.settings-view .scrollable-panel');
      const panelBefore = await surface.boundingBox();
      await page
        .getByRole('switch', { name: locale === 'ko' ? '배경음' : 'Music', exact: true })
        .click();
      await page
        .getByRole('switch', { name: locale === 'ko' ? '효과음' : 'Sound effects', exact: true })
        .click();
      await expect(
        page.getByRole('switch', { name: locale === 'ko' ? '배경음' : 'Music' }),
      ).toHaveAttribute('aria-checked', 'false');
      await expect(
        page.getByRole('switch', { name: locale === 'ko' ? '효과음' : 'Sound effects' }),
      ).toHaveAttribute('aria-checked', 'false');
      await expect(page.getByRole('alert')).toHaveCount(1);
      const panelAfter = await surface.boundingBox();
      expect(panelAfter!.y).toBeCloseTo(panelBefore!.y, 1);
      expect(panelAfter!.height).toBeGreaterThan(panelBefore!.height);
      await page
        .getByRole('button', { name: locale === 'ko' ? '닫기' : 'Close', exact: true })
        .click();
      await page
        .getByRole('button', { name: locale === 'ko' ? '설정' : 'Settings', exact: true })
        .click();
      await expect(page.getByRole('alert')).toHaveCount(1);
      await expectLayerFits(page);
      await page.screenshot({
        path: `/tmp/hanpan-settings-storage-${locale}-${width}-${test.info().project.name}.png`,
      });
    });
  }
}

for (const locale of ['ko', 'en'] as const) {
  test(`profile persistence failure keeps the selection and recovers inline (${locale})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await enterLobby(page, locale);
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key === 'profileSelection') {
          Storage.prototype.setItem = original;
          throw new DOMException('Storage denied', 'QuotaExceededError');
        }
        original.call(this, key, value);
      };
    });
    await page.locator('.lobby-view__profile button').click();
    const choices = page.locator('[data-character-id]');
    const selection = choices
      .filter({ hasNot: page.locator('.character-choice-grid__selection') })
      .first();
    const selectedId = await selection.getAttribute('data-character-id');
    const surface = page.locator('.scrollable-panel');
    const panelBefore = await surface.boundingBox();
    const gridBefore = await page.locator('.character-choice-grid').boundingBox();
    await selection.click();
    const warning = page.getByRole('alert');
    await expect(warning).toHaveText(
      locale === 'ko' ? '프로필을 저장하지 못했어요.' : 'Couldn’t save your profile.',
    );
    await expect(page.locator(`[data-character-id="${selectedId}"]`)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(warning).toBeVisible();
    const panelAfter = await surface.boundingBox();
    expect(panelAfter!.y).toBeCloseTo(panelBefore!.y, 1);
    expect(panelAfter!.height).toBeGreaterThan(panelBefore!.height);
    expect(await page.locator('.character-choice-grid').boundingBox()).toEqual(gridBefore);
    const warningBounds = await warning.boundingBox();
    expect(warningBounds).not.toBeNull();
    expect(warningBounds!.x).toBeGreaterThanOrEqual(0);
    expect(warningBounds!.x + warningBounds!.width).toBeLessThanOrEqual(320);
    await page.screenshot({
      path: `/tmp/hanpan-profile-storage-${locale}-${test.info().project.name}.png`,
    });
    await choices
      .filter({ hasNot: page.locator('.character-choice-grid__selection') })
      .first()
      .click();
    await expect(warning).toHaveCount(0);
    expect(await surface.boundingBox()).toEqual(panelBefore);
    const saved = await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('profileSelection') ?? 'null') as { characterId: string },
    );
    await expect(page.locator(`[data-character-id="${saved.characterId}"]`)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
}

async function enterLobby(page: Page, locale: 'ko' | 'en' = 'ko'): Promise<void> {
  await page.addInitScript((value) => localStorage.setItem('locale', value), locale);
  await page.goto(PRODUCT_GAME_ORIGIN);
  await page
    .getByRole('button', { name: locale === 'ko' ? '게임 시작' : 'Start Game', exact: true })
    .click();
  await expect(page.locator('[data-screen="lobby"]')).toBeVisible();
}
