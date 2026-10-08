import { readFileSync } from 'node:fs';

import { expect } from '@playwright/test';

import { test } from '../../helpers/test';

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
  readFileSync(new URL('../../fixtures/browser-parity.v1.json', import.meta.url), 'utf8'),
) as BrowserParityBaseline;
const E2E_PACKAGE: E2ePackage = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as E2ePackage;

for (const variant of [{ ...BASELINE, pourStyle: 'classic' }, ...BASELINE.additionalStyles]) {
  test(`reconstructs the reviewed ${variant.pourStyle} seeded-physics artifact in every supported engine`, async ({
    browser,
    page,
  }, testInfo) => {
    const browserName = testInfo.project.name as keyof BrowserParityBaseline['browsers'];
    expect(E2E_PACKAGE.devDependencies['@playwright/test']).toBe(BASELINE.playwrightVersion);
    expect(browser.version()).toBe(BASELINE.browsers[browserName]);

    // A test-owned same-origin document loads the existing Vite TS/WASM path.
    // Physics parity is independent of React, Canvas and presentation completion.
    await page.route('**/__physics-parity.html', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Physics parity</title>',
      }),
    );
    await page.goto('/__physics-parity.html');
    const roll = await page.evaluate(
      async ({ moduleUrl, input }) => {
        const diagnostic = (await import(moduleUrl)) as {
          runPhysicsDiagnostic(options: typeof input): Promise<{
            replayDigest: string;
            authoritativeValuesBySlot: readonly { slot: number; value: number }[];
          }>;
        };
        const result = await diagnostic.runPhysicsDiagnostic(input);
        return {
          replayDigest: result.replayDigest,
          authoritativeValuesBySlot: result.authoritativeValuesBySlot,
        };
      },
      {
        moduleUrl: '/src/dev/physics-diagnostic-simulation.ts',
        input: { seed: BASELINE.seed, pourStyle: variant.pourStyle, count: 5 },
      },
    );
    expect(roll.replayDigest).toBe(variant.replayDigest);
    expect(roll.authoritativeValuesBySlot.map(({ slot }) => slot)).toEqual([0, 1, 2, 3, 4]);
    expect(roll.authoritativeValuesBySlot.map(({ value }) => value).join(',')).toBe(
      variant.authoritativeValues,
    );
  });
}
