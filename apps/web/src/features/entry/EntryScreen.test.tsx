// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- the live lifecycle is stopped with the rendered tree. */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { type AppLifecycle, createAppLifecycle } from '@/app/lifecycle/app-lifecycle';
import { APP_SCREEN_PATH } from '@/app/routing/screen-paths';
import { GlobalLayerHost } from '@/app/shell/GlobalLayerHost';
import {
  CAPABILITY_FAILURE_CODE,
  type StaticCapabilityResult,
} from '@/bootstrap/static-capabilities';
import { EntryScreen } from '@/features/entry/EntryScreen';
import { LOCALE, type Locale, translate } from '@/i18n';
import type { BrowserAudioRuntime } from '@/runtime/audio/browser-audio-runtime';
import { createSessionCredentialStore } from '@/runtime/session/session-credential-store';

const navigate = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => navigate,
}));

const lifecycles: Array<AppLifecycle> = [];

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  for (const lifecycle of lifecycles.splice(0)) lifecycle.dispose();
  navigate.mockReset();
});

function createAudio(): BrowserAudioRuntime {
  return {
    supported: true,
    activate: vi.fn(() => Promise.resolve()),
    prepareCues: vi.fn(() => Promise.resolve()),
    playCue: vi.fn(),
    setSfxEnabled: vi.fn(),
    setSurfaceExposed: vi.fn(),
    stopCue: vi.fn(),
    prefetchScenes: vi.fn(() => Promise.resolve()),
    setBgmEnabled: vi.fn(() => Promise.resolve()),
    setScene: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(() => Promise.resolve()),
  };
}

function renderEntry({
  capabilities = { ok: true },
  activateAudio = vi.fn(() => Promise.resolve()),
  locale = LOCALE.EN,
}: Readonly<{
  capabilities?: StaticCapabilityResult;
  activateAudio?: () => Promise<void>;
  locale?: Locale;
}> = {}) {
  const lifecycle = createAppLifecycle({
    capabilities,
    activateAudio,
    loadResources: () => new Promise<void>(() => {}),
  });

  lifecycles.push(lifecycle);
  render(
    <div className='game-logical-canvas'>
      <GlobalLayerHost
        sessionCredentialStore={createSessionCredentialStore()}
        lifecycle={lifecycle}
        locale={locale}
        routePath={APP_SCREEN_PATH.ENTRY}
      >
        <EntryScreen audio={createAudio()} lifecycle={lifecycle} locale={locale} />
      </GlobalLayerHost>
    </div>,
  );
  return { lifecycle, activateAudio };
}

test.each([undefined, '', 'false', 'true'])(
  'shows the demo server notice only with the enabled build flag (%s)',
  (value) => {
    vi.stubEnv('VITE_DEMO_NOTICE_ENABLED', value);
    renderEntry();
    expect(
      screen.queryByText(translate(LOCALE.EN, 'app.demoServerNotice').replace('\n', ' ')) !== null,
    ).toBe(value === 'true');
    expect(screen.getByRole('button', { name: 'Start Game' })).not.toBeNull();
  },
);

test('shows activation failure inline and retries audio activation from the start action', async () => {
  const activateAudio = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error('activation failed'))
    .mockImplementationOnce(() => new Promise<void>(() => {}));
  renderEntry({ activateAudio });
  const start = screen.getByRole('button', { name: translate(LOCALE.EN, 'app.startAction') });

  fireEvent.click(start, { detail: 1, button: 0 });
  expect(activateAudio).toHaveBeenCalledTimes(1);
  expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t start the game.');

  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'app.startAction') }), {
    detail: 1,
    button: 0,
  });
  await waitFor(() => expect(activateAudio).toHaveBeenCalledTimes(2));
  expect(
    screen
      .getByRole('button', { name: translate(LOCALE.EN, 'app.startAction') })
      .hasAttribute('disabled'),
  ).toBe(true);
});

test('replaces Entry with a full-frame unsupported notice without CTA or technical code', () => {
  const locale = LOCALE.KO;
  renderEntry({
    capabilities: { ok: false, code: CAPABILITY_FAILURE_CODE.WEBGL_UNAVAILABLE },
    locale,
  });

  const notice = screen.getByRole('alert');
  expect(notice.getAttribute('data-product-view')).toBe('unsupported');
  expect(
    within(notice).getByRole('heading', {
      name: translate(locale, 'capability.unsupportedTitle'),
    }),
  ).not.toBeNull();
  expect(
    within(notice).getByText(translate(locale, 'capability.unsupportedMessage')),
  ).not.toBeNull();
  expect(screen.queryByRole('button', { name: '게임 시작' })).toBeNull();
  expect(screen.queryByRole('button', { name: '개인정보처리방침' })).toBeNull();
  expect(screen.queryByText('WEBGL_UNAVAILABLE')).toBeNull();
});

/* eslint-disable testing-library/no-node-access -- input ownership requires observing inert ancestors across the composed layers. */
test('keeps the global offline action accessible above privacy and retains its input guard on privacy cleanup', () => {
  const { lifecycle } = renderEntry();
  const trigger = screen.getByRole('button', { name: 'Privacy Policy' });
  fireEvent.click(trigger);
  const privacy = screen.getByRole('dialog', { name: 'Privacy Policy' });
  const close = within(privacy).getByRole('button', { name: 'Close' });

  act(() => lifecycle.setNetworkStatus('offline'));
  const refresh = screen.getByRole('button', { name: 'Refresh' });
  expect(refresh.closest('[inert]')).toBeNull();
  expect(privacy.closest('[inert]')).not.toBeNull();

  // Ending the retained local layer must not release a still-active global guard.
  fireEvent.click(close);
  expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
  expect(screen.getByTestId('global-interaction-surface').getAttribute('inert')).toBe('');

  act(() => lifecycle.setNetworkStatus('online'));
  expect(screen.getByTestId('global-interaction-surface').hasAttribute('inert')).toBe(false);
  expect(screen.getByRole('button', { name: 'Privacy Policy' })).toBe(trigger);
});

test('privacy blocks only Entry content and unlocks it after closing', () => {
  const { lifecycle } = renderEntry();
  const trigger = screen.getByRole('button', { name: 'Privacy Policy' });
  fireEvent.click(trigger);
  const privacy = screen.getByRole('dialog', { name: 'Privacy Policy' });
  expect(trigger.closest('[inert]')).not.toBeNull();
  expect(privacy.closest('[inert]')).toBeNull();
  const globalHost = screen.getByTestId('global-layer-host');
  expect(globalHost.closest('[inert]')).toBeNull();
  act(() => lifecycle.setNetworkStatus('offline'));
  act(() => lifecycle.setNetworkStatus('online'));
  fireEvent.click(within(privacy).getByRole('button', { name: 'OK' }));
  expect(trigger.closest('[inert]')).toBeNull();
});
