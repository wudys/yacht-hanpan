// @vitest-environment jsdom

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

const FONT_BASE_URL = '/assets/fonts';
const PRELOAD_URLS = [
  `${FONT_BASE_URL}/noto-sans-kr-400.woff2`,
  `${FONT_BASE_URL}/noto-sans-kr-600.woff2`,
] as const;

describe('product font bootstrap', () => {
  test('declares the self-hosted stylesheet and critical WOFF2 preloads in document head', async () => {
    const html = await readFile(resolve(import.meta.dirname, '../../index.html'), 'utf8');

    const { head } = new DOMParser().parseFromString(html, 'text/html');
    expect(
      head.querySelector(`link[rel="stylesheet"][href="${FONT_BASE_URL}/noto-sans-kr.css"]`),
    ).not.toBeNull();
    for (const url of PRELOAD_URLS) {
      const link = head.querySelector(`link[rel="preload"][href="${url}"]`);
      expect(link).not.toBeNull();
      expect(link?.getAttribute('as')).toBe('font');
      expect(link?.getAttribute('type')).toBe('font/woff2');
      expect(['', 'anonymous']).toContain(link?.getAttribute('crossorigin'));
    }
  });
});
