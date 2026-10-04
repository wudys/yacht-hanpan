import { createHash } from 'node:crypto';

import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  test as base,
  type TestInfo,
} from '@playwright/test';

import { PRODUCT_SERVER_ORIGIN } from './test-origins';

export const test = base.extend({
  context: async ({ context }, use, testInfo) => {
    await isolateRoomRequests(context, testInfo);
    await use(context);
  },
});

/** Explicit contexts need the same room-request isolation as the default page fixture. */
export async function createTestContext(
  browser: Browser,
  options: BrowserContextOptions = {},
): Promise<BrowserContext> {
  const context = await browser.newContext(options);
  try {
    await isolateRoomRequests(context, test.info());
    return context;
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function isolateRoomRequests(context: BrowserContext, testInfo: TestInfo): Promise<void> {
  const digest = createHash('sha256')
    .update(`${testInfo.testId}:${testInfo.repeatEachIndex}`)
    .digest('hex');
  const groups = Array.from({ length: 6 }, (_, index) => digest.slice(index * 4, index * 4 + 4));
  // Add the proxy address after browser CORS processing, as the real ingress does.
  await context.route(`${PRODUCT_SERVER_ORIGIN}/**`, (route) =>
    route.continue({
      headers: { ...route.request().headers(), 'cf-connecting-ip': `2001:db8:${groups.join(':')}` },
    }),
  );
}
