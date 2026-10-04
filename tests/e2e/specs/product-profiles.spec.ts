import { expect } from '@playwright/test';

import { PRODUCT_GAME_ORIGIN } from '../helpers/product-game';
import { createTestContext, test } from '../helpers/test';

for (const duplicate of [false, true]) {
  test(`full sync and turn summary preserve ${duplicate ? 'duplicate' : 'different'} seat profiles`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 320, height: 740 });
    const guestContext = await createTestContext(browser, {
      viewport: { width: 320, height: 740 },
    });
    try {
      const guest = await guestContext.newPage();
      for (const [index, participant] of [page, guest].entries()) {
        await participant.goto(PRODUCT_GAME_ORIGIN);
        await participant.getByRole('button', { name: '게임 시작', exact: true }).click();
        await participant.getByRole('button', { name: '프로필 설정', exact: true }).click();
        await participant.getByRole('tab', { name: '스타일 2', exact: true }).click();
        await participant
          .locator('[data-character-id]')
          .nth(duplicate ? 0 : index)
          .click();
        await participant.getByRole('button', { name: '닫기', exact: true }).click();
      }
      await page.locator('[data-room-action="create"] button').click();
      const codeView = page.locator('[data-room-code]');
      await expect(codeView).toBeVisible();
      const code = await codeView.getAttribute('data-room-code');
      expect(code).toMatch(/^[0-9]{6}$/u);
      await guest.getByRole('button', { name: '게임 참가', exact: true }).click();
      await guest.getByRole('textbox').fill(code!);
      await guest.getByRole('button', { name: '참가하기', exact: true }).click();
      for (const participant of [page, guest]) {
        await expect(participant.locator('[data-screen="game"]')).toBeVisible();
        await participant.getByRole('button', { name: '점수판', exact: true }).click();
      }
      const creatorOwn = page.locator('[data-score-player="viewer"] .player-avatar img');
      const creatorOpponent = page.locator('[data-score-player="opponent"] .player-avatar img');
      const guestOwn = guest.locator('[data-score-player="viewer"] .player-avatar img');
      const guestOpponent = guest.locator('[data-score-player="opponent"] .player-avatar img');
      await expect(creatorOwn).toBeVisible();
      await expect(guestOwn).toBeVisible();
      const creatorSource = await creatorOwn.getAttribute('src');
      const guestSource = await guestOwn.getAttribute('src');
      expect(creatorSource).toBeTruthy();
      expect(guestSource).toBeTruthy();
      if (duplicate) expect(creatorSource).toBe(guestSource);
      else expect(creatorSource).not.toBe(guestSource);
      expect(creatorSource).toContain('/variant/');
      expect(guestSource).toContain('/variant/');
      for (const participant of [page, guest]) {
        await expect(
          participant.locator('[data-score-player="viewer"] .player-avatar__self'),
        ).toBeVisible();
        await expect(
          participant.locator('[data-score-player="opponent"] .player-avatar__self'),
        ).toHaveCount(0);
      }
      await expect(creatorOpponent).toHaveAttribute('src', guestSource!);
      await expect(guestOpponent).toHaveAttribute('src', creatorSource!);
      await page.screenshot({
        path: test.info().outputPath('profiles-scoreboard-320.png'),
      });
      for (const participant of [page, guest]) {
        await participant.getByRole('button', { name: '닫기', exact: true }).click();
        await expect(participant.locator('.player-summary img').first()).toHaveAttribute(
          'src',
          creatorSource!,
        );
      }
      await expect(page.locator('.player-summary img').first()).toHaveAttribute('alt', '나');
      await expect(guest.locator('.player-summary img').first()).toHaveAttribute('alt', '상대');
      await page.getByRole('button', { name: '굴리기', exact: true }).click();
      const score = page.locator('button[data-score-category]').first();
      await expect(score).toBeEnabled({ timeout: 30_000 });
      await score.click();
      for (const participant of [page, guest]) {
        await expect(participant.locator('.player-summary img').first()).toHaveAttribute(
          'src',
          guestSource!,
        );
      }
      await expect(page.locator('.player-summary img').first()).toHaveAttribute('alt', '상대');
      await expect(guest.locator('.player-summary img').first()).toHaveAttribute('alt', '나');
      await guest.screenshot({
        path: test.info().outputPath('turn-summary-guest-320.png'),
      });
      await guest.reload();
      await guest.getByRole('button', { name: '게임 시작', exact: true }).click();
      await expect(guest.locator('[data-screen="game"]')).toBeVisible();
      await guest.getByRole('button', { name: '점수판', exact: true }).click();
      await expect(guestOwn).toHaveAttribute('src', guestSource!);
      await guest.getByRole('button', { name: '닫기', exact: true }).click();
      await guest.getByRole('button', { name: '설정', exact: true }).click();
      await guest.getByRole('button', { name: '기권하기', exact: true }).click();
      for (const participant of [page, guest]) {
        const result = participant.locator('[data-product-view="result"]');
        await expect(result).toBeVisible();
      }
      await expect(guestOwn).toHaveAttribute('src', guestSource!);
      await expect(creatorOwn).toHaveAttribute('src', creatorSource!);
      await page.screenshot({
        path: test.info().outputPath('profile-result-winner.png'),
      });
    } finally {
      await guestContext.close();
    }
  });
}
