import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'bun:test';

const FONT_ROOT = '../public/assets/fonts';

describe('self-hosted product font', () => {
  test('uses WOFF2 with WOFF fallback and non-blocking swap behavior', async () => {
    const stylesheetUrl = new URL(`${FONT_ROOT}/noto-sans-kr.css`, import.meta.url);
    const css = await Bun.file(stylesheetUrl).text();

    expect(css.match(/@font-face/gu)).toHaveLength(3);
    expect(css.match(/font-display:\s*swap/gu)).toHaveLength(3);
    expect(css).toContain("url('./noto-sans-kr-400.woff2') format('woff2')");
    expect(css).toContain("url('./noto-sans-kr-400.woff') format('woff')");
    expect(css).toContain("url('./noto-sans-kr-600.woff2') format('woff2')");
    expect(css).toContain("url('./noto-sans-kr-600.woff') format('woff')");
    expect(css).toContain("url('./noto-sans-kr-500.woff2') format('woff2')");
    expect(css).toContain("url('./noto-sans-kr-500.woff') format('woff')");
    expect(css).toContain("--game-font-family: 'Noto Sans KR', sans-serif");
    expect(css).not.toMatch(/local\(|\.eot|embedded-opentype|cdn\.jsdelivr/iu);
    for (const [, reference] of css.matchAll(/url\(['"]([^'"]+)['"]\)/gu)) {
      const bytes = await readFile(new URL(reference, stylesheetUrl));
      expect(bytes.length).toBeGreaterThan(0);
    }
  });
});
