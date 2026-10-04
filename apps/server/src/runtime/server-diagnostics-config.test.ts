import { expect, test } from 'bun:test';

import { readServerDiagnosticsConfig } from '@/runtime/server-diagnostics-config';

const settings = { sentryDsn: 'https://public@o0.ingest.sentry.io/0' };

test.each([undefined, '', 'false', 'TRUE', '1', 'invalid', ' true'])(
  'does not activate Sentry for flag %s',
  (flag) => {
    expect(readServerDiagnosticsConfig({ SENTRY_ENABLED: flag }, settings)).toEqual({ dsn: null });
  },
);

test.each(['development', 'test', 'production', 'preview'])(
  'activates only by explicit flag regardless of %s',
  (mode) => {
    expect(
      readServerDiagnosticsConfig(
        {
          SENTRY_ENABLED: 'true',
          NODE_ENV: mode,
          RENDER: 'true',
          ALLOWED_WEB_ORIGINS: 'https://preview.invalid',
        },
        settings,
      ),
    ).toEqual({ dsn: settings.sentryDsn });
  },
);

test.each([
  '',
  'not a URL',
  'http://public@o0.ingest.sentry.io/0',
  'https://public@outside.invalid/0',
  'https://public:secret@o0.ingest.sentry.io/0',
  'https://public@o0.ingest.sentry.io/0?token=private',
  'https://public@o0.ingest.sentry.io/0#private',
])('keeps missing or unsafe DSN inactive', (sentryDsn) => {
  expect(readServerDiagnosticsConfig({ SENTRY_ENABLED: 'true' }, { sentryDsn })).toEqual({
    dsn: null,
  });
});

test('does not treat an environment DSN as a configured product endpoint', () => {
  expect(
    readServerDiagnosticsConfig(
      { SENTRY_ENABLED: 'true', SENTRY_DSN: 'https://other@o1.ingest.sentry.io/1' },
      settings,
    ),
  ).toEqual({ dsn: settings.sentryDsn });
});
