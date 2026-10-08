import { type Browser, type BrowserContext, expect, type Page } from '@playwright/test';

import { createTestContext } from './test';
import { PRODUCT_GAME_ORIGIN } from './test-origins';

type CreateTwoPlayerGameOptions = Readonly<{
  locale?: 'ko' | 'en';
  viewport?: Readonly<{ width: number; height: number }>;
  onGuestPage?: (page: Page) => void | Promise<void>;
}>;

/** Uses two isolated browser stores and the real HTTP/Socket server, never fixture admission. */
export async function createTwoPlayerGame(
  creator: Page,
  browser: Browser,
  options: CreateTwoPlayerGameOptions = {},
): Promise<BrowserContext> {
  const guestContext = await createTestContext(browser, {
    viewport: options.viewport ?? { width: 320, height: 740 },
  });
  try {
    await creator.locator('[data-room-action="create"] button').click();
    const codeView = creator.locator('[data-room-code]');
    await expect(codeView).toBeVisible();
    const code = await codeView.getAttribute('data-room-code');
    expect(code).toMatch(/^[0-9]{6}$/u);

    const guest = await guestContext.newPage();
    await options.onGuestPage?.(guest);
    if (options.locale) {
      await guest.addInitScript((locale) => localStorage.setItem('locale', locale), options.locale);
    }
    const english = options.locale === 'en';
    await guest.goto(PRODUCT_GAME_ORIGIN);
    await guest
      .getByRole('button', { name: english ? 'Start Game' : '게임 시작', exact: true })
      .click();
    await guest
      .getByRole('button', { name: english ? 'Join Game' : '게임 참가', exact: true })
      .click();
    await guest.getByRole('textbox').fill(code!);
    await guest.getByRole('button', { name: english ? 'Join' : '참가하기', exact: true }).click();
    await expect(creator.locator('[data-screen="game"]')).toBeVisible();
    await expect(guest.locator('[data-screen="game"]')).toBeVisible();
    return guestContext;
  } catch (error) {
    await guestContext.close();
    throw error;
  }
}
