// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import { expect, it } from 'vitest';

import { readTelemetryConfig, TELEMETRY_SETTINGS } from '@/runtime/telemetry/telemetry-config';

import { configureAnalyticsHtml } from './analytics-html';

const html = readFileSync('index.html', 'utf8');
const origin = 'https://yacht.example.com';
const settings = {
  ...TELEMETRY_SETTINGS,
  measurementId: 'G-TEST123',
};
const env = {
  PROD: true,
  MODE: 'production',
  VITE_DEPLOYMENT_ENV: 'production',
  VITE_SITE_ORIGIN: origin,
};

it('initializes the tag once in the HTML head before app execution without an automatic pageview', () => {
  const output = configureAnalyticsHtml(html, readTelemetryConfig(env, origin, settings));
  const parsed = new DOMParser().parseFromString(output, 'text/html');
  const bootstrap = parsed.querySelector('script[data-hanpan-analytics-init]')!;
  const remote = parsed.querySelector<HTMLScriptElement>('script[data-hanpan-analytics]')!;
  expect(remote.hasAttribute('async')).toBe(true);
  expect(remote.src).toContain(`gtag/js?id=${settings.measurementId}`);
  expect(bootstrap.parentElement?.tagName).toBe('HEAD');
  const host: Record<string, unknown> = {};
  host.location = { origin };
  runInNewContext(bootstrap.textContent!, { window: host });
  const commands = (host.hanpanDataLayer as IArguments[]).map((args) => Array.from(args));
  expect(commands.filter(([name]) => name === 'config')).toHaveLength(1);
  expect(commands.find(([name]) => name === 'config')?.[2]).toMatchObject({
    send_page_view: false,
    allow_google_signals: false,
    page_referrer: '',
  });
  expect(commands.some(([name]) => name === 'event')).toBe(false);
});

it('keeps the tag but disables initialization in dev, preview and unconfigured builds', () => {
  for (const config of [
    readTelemetryConfig({ ...env, PROD: false }, origin, settings),
    readTelemetryConfig({ ...env, VITE_DEPLOYMENT_ENV: 'preview' }, origin, settings),
    readTelemetryConfig({ ...env, VITE_SITE_ORIGIN: undefined }, origin),
  ]) {
    const output = configureAnalyticsHtml(html, config);
    const parsed = new DOMParser().parseFromString(output, 'text/html');
    expect(parsed.querySelector('script[data-hanpan-analytics]')).not.toBeNull();
    const script = parsed.querySelector('script[data-hanpan-analytics-init]')!;
    const host: Record<string, unknown> = { location: { origin } };
    runInNewContext(script.textContent!, { window: host });
    expect(host[`ga-disable-${config.measurementId}`]).toBe(true);
    expect(host.hanpanDataLayer).toBeUndefined();
    expect(host.hanpanGtag).toBeUndefined();
  }
});

it('does not initialize collection when a production artifact is opened on another origin', () => {
  const output = configureAnalyticsHtml(html, readTelemetryConfig(env, origin, settings));
  const parsed = new DOMParser().parseFromString(output, 'text/html');
  const script = parsed.querySelector('script[data-hanpan-analytics-init]')!;
  const host: Record<string, unknown> = { location: { origin: 'http://localhost:4173' } };
  runInNewContext(script.textContent!, { window: host });
  expect(host[`ga-disable-${settings.measurementId}`]).toBe(true);
  expect(host.hanpanDataLayer).toBeUndefined();
});
