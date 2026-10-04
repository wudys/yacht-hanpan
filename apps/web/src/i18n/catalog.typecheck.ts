import { type MessageKey, translate } from '@/i18n/catalog';

// Compiled by the web typecheck, never invoked at runtime.
export function checkTranslationArguments(key: MessageKey, plainKey: 'game.you' | 'game.opponent') {
  translate('ko', plainKey);
  translate('en', 'game.rollsRemaining', { count: 2 });
  translate('ko', 'error.rateLimited');
  // @ts-expect-error This message requires a count.
  translate('ko', 'game.rollsRemaining');
  // @ts-expect-error A dynamic key must be narrowed before omitting params.
  translate('ko', key);
  // @ts-expect-error Params must match the message, not another parameterized key.
  translate('ko', 'game.rollsRemaining', { retryAfterMs: 1000 });
  // @ts-expect-error Counts are numeric.
  translate('en', 'game.rollsRemaining', { count: '2' });
}
