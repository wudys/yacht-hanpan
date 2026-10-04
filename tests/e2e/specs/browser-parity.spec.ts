import { readFileSync } from 'node:fs';

import { expect } from '@playwright/test';

import { test } from '../helpers/test';

interface BrowserParityBaseline {
  readonly schemaVersion: 1;
  readonly playwrightVersion: string;
  readonly seed: string;
  readonly replayDigest: string;
  readonly authoritativeValues: string;
  readonly additionalStyles: readonly {
    readonly pourStyle: 'burst' | 'oblique';
    readonly replayDigest: string;
    readonly authoritativeValues: string;
  }[];
  readonly browsers: Readonly<Record<'chromium' | 'firefox' | 'webkit', string>>;
}

interface E2ePackage {
  readonly devDependencies: Readonly<Record<string, string>>;
}

const BASELINE: BrowserParityBaseline = JSON.parse(
  readFileSync(new URL('../fixtures/browser-parity.v1.json', import.meta.url), 'utf8'),
) as BrowserParityBaseline;
const E2E_PACKAGE: E2ePackage = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as E2ePackage;

for (const variant of [{ ...BASELINE, pourStyle: 'classic' }, ...BASELINE.additionalStyles]) {
  test(`reconstructs the reviewed ${variant.pourStyle} seeded-physics artifact in every supported engine`, async ({
    browser,
    page,
  }, testInfo) => {
    const browserName = testInfo.project.name as keyof BrowserParityBaseline['browsers'];
    expect(E2E_PACKAGE.devDependencies['@playwright/test']).toBe(BASELINE.playwrightVersion);
    expect(browser.version()).toBe(BASELINE.browsers[browserName]);

    await page.goto(
      `/dev/anchors.html?anchor=replay&seed=${encodeURIComponent(BASELINE.seed)}&style=${variant.pourStyle}&count=5`,
    );
    const roll = page.locator('[data-replay-digest]');
    await expect(roll).toHaveAttribute('data-replay-digest', variant.replayDigest);
    await expect(roll).toHaveAttribute('data-authoritative-values', variant.authoritativeValues);
    await expect(roll).toHaveAttribute('data-replay-complete', 'true', { timeout: 20_000 });
    await expect(page.locator('[data-capability-failure]')).toHaveCount(0);
  });
}
