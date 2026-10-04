import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import { describe, expect, test } from 'vitest';

import {
  DEFAULT_LOCALE,
  LOCALE,
  MESSAGES,
  normalizeLocale,
  PUBLIC_ERROR_MESSAGE_KEY,
  translate,
} from '@/i18n/index';

describe('i18n catalog', () => {
  test('ko and en expose identical keys and placeholders', () => {
    const keys = Object.keys(MESSAGES.ko).sort() as (keyof typeof MESSAGES.ko)[];
    expect(Object.keys(MESSAGES.en).sort()).toEqual(keys);
    const placeholders = (message: string) =>
      (message.match(/\{[a-zA-Z][a-zA-Z0-9]*\}/gu) ?? []).sort();
    for (const key of keys) {
      expect(placeholders(MESSAGES.en[key])).toEqual(placeholders(MESSAGES.ko[key]));
    }
  });

  test.each([LOCALE.KO, LOCALE.EN])('rate limit copy has no countdown in %s', (locale) => {
    expect(translate(locale, 'error.rateLimited')).not.toMatch(/[0-9{}]/u);
  });

  test('rejects missing placeholder params instead of rendering blank text', () => {
    expect(() =>
      translate(LOCALE.EN, 'game.rollsRemaining', {} as { readonly count: number }),
    ).toThrow('Missing i18n parameter: count');
  });

  test.each(Object.values(PUBLIC_ERROR_CODE))(
    'renders public error %s in both languages',
    (code) => {
      const key = PUBLIC_ERROR_MESSAGE_KEY[code];
      for (const locale of [LOCALE.KO, LOCALE.EN]) {
        const text = translate(locale, key);
        expect(text.trim().length).toBeGreaterThan(0);
        expect(text).not.toBe(key);
        expect(text).not.toMatch(/\{[^}]+\}/u);
      }
    },
  );

  test('normalizes supported locales and falls back to the canonical default', () => {
    expect(normalizeLocale('en')).toBe(LOCALE.EN);
    expect(normalizeLocale('ko')).toBe(LOCALE.KO);
    expect(normalizeLocale('ko-KR')).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale(undefined)).toBe(DEFAULT_LOCALE);
  });
});
