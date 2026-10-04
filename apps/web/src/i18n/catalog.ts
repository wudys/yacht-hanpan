import type { MessageKey } from '@/i18n/message-keys';
import { EN_MESSAGES } from '@/i18n/messages/en';
import { KO_MESSAGES } from '@/i18n/messages/ko';

export { EN_MESSAGES, KO_MESSAGES };
export type { MessageKey } from '@/i18n/message-keys';

export const LOCALE = {
  KO: 'ko',
  EN: 'en',
} as const;

export type Locale = (typeof LOCALE)[keyof typeof LOCALE];

export const DEFAULT_LOCALE: Locale = LOCALE.KO;

export const MESSAGES = {
  [LOCALE.KO]: KO_MESSAGES,
  [LOCALE.EN]: EN_MESSAGES,
} as const satisfies Record<Locale, Record<MessageKey, string>>;

export type MessageParamsByKey = {
  readonly [Key in MessageKey]: Key extends 'game.rollsRemaining'
    ? { readonly count: number }
    : Readonly<Record<never, never>>;
};

export type MessageKeyWithoutParams = {
  [Key in MessageKey]: keyof MessageParamsByKey[Key] extends never ? Key : never;
}[MessageKey];

type ParameterizedMessageKey = Exclude<MessageKey, MessageKeyWithoutParams>;
type TranslationArguments =
  | [key: MessageKeyWithoutParams, params?: Readonly<Record<never, never>>]
  | {
      [Key in ParameterizedMessageKey]: [key: Key, params: MessageParamsByKey[Key]];
    }[ParameterizedMessageKey];

const PLACEHOLDER_PATTERN = /\{([a-zA-Z][a-zA-Z0-9]*)\}/gu;

export function normalizeLocale(value: unknown): Locale {
  return value === LOCALE.KO || value === LOCALE.EN ? value : DEFAULT_LOCALE;
}

export function translate(locale: Locale, ...[key, params = {}]: TranslationArguments): string {
  return MESSAGES[locale][key].replace(PLACEHOLDER_PATTERN, (_match, name: string) => {
    const value = (params as Readonly<Record<string, string | number>>)[name];
    if (value === undefined) throw new Error(`Missing i18n parameter: ${name}`);
    return String(value);
  });
}
