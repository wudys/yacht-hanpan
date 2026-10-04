import { describe, expect, it } from 'vitest';

import { readTelemetryConfig, TELEMETRY_SETTINGS } from '@/runtime/telemetry/telemetry-config';

const siteOrigin = 'https://yacht.example.com';
const production = {
  PROD: true,
  MODE: 'production',
  VITE_DEPLOYMENT_ENV: 'production',
  VITE_SITE_ORIGIN: siteOrigin,
};
const settings = {
  ...TELEMETRY_SETTINGS,
  measurementId: 'G-RZBLW49TR1',
  sentryDsn: 'https://public@o1.ingest.us.sentry.io/123',
  sentryOrg: 'wudy',
  sentryProject: 'web',
};

describe('production telemetry gate', () => {
  it('uses public code settings only on the configured production origin', () => {
    const result = readTelemetryConfig(production, siteOrigin, settings);
    expect(result.enabled).toBe(true);
    expect(result.measurementId).toBe(settings.measurementId);
  });
  it('accepts a digit-prefixed domain while preserving exact origin matching', () => {
    const env = { ...production, VITE_SITE_ORIGIN: 'https://3d-yacht.example.com' };
    expect(readTelemetryConfig(env, env.VITE_SITE_ORIGIN, settings).enabled).toBe(true);
    expect(readTelemetryConfig(env, 'https://other.example.com', settings).enabled).toBe(false);
  });
  it.each([
    [{ ...production, PROD: false }, siteOrigin, settings],
    [{ ...production, MODE: 'test' }, siteOrigin, settings],
    [{ ...production, VITE_DEPLOYMENT_ENV: 'preview' }, siteOrigin, settings],
    [production, 'https://preview.yacht.example.com', settings],
    [production, 'http://localhost:4173', settings],
    [{ ...production, VITE_SITE_ORIGIN: 'https://localhost' }, 'https://localhost', settings],
    [
      { ...production, VITE_SITE_ORIGIN: 'https://game.localhost.' },
      'https://game.localhost.',
      settings,
    ],
    [{ ...production, VITE_SITE_ORIGIN: '' }, siteOrigin, settings],
    [{ ...production, VITE_SITE_ORIGIN: undefined }, siteOrigin, settings],
    [{ ...production, VITE_SITE_ORIGIN: 42 }, siteOrigin, settings],
  ])('blocks development, preview and incomplete public settings', (env, origin, config) => {
    expect(readTelemetryConfig(env, origin, config).enabled).toBe(false);
  });
  it('does not accept arbitrary endpoints or environment overrides of public settings', () => {
    const config = readTelemetryConfig(
      { ...production, VITE_GA_MEASUREMENT_ID: 'G-OVERRIDE', SENTRY_AUTH_TOKEN: 'secret' },
      siteOrigin,
      { ...settings, sentryDsn: 'https://key@attacker.example/1' },
    );
    expect(config.sentryDsn).toBeNull();
    expect(config.measurementId).toBe(settings.measurementId);
    expect(JSON.stringify(config)).not.toContain('secret');
  });
});
