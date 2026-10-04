// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- the live actor is stopped with the rendered tree. */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { createActor } from 'xstate';

import { appLifecycleMachine } from '@/app/app-lifecycle-machine';
import { GlobalLayerHost } from '@/app/GlobalLayerHost';
import { APP_SCREEN_PATH } from '@/app/screen-paths';
import {
  CAPABILITY_FAILURE_CODE,
  type StaticCapabilityResult,
} from '@/bootstrap/static-capabilities';
import { EntryScreen } from '@/features/entry/EntryScreen';
import { LOCALE, type Locale, translate } from '@/i18n';
import type { ProductAudioRuntime } from '@/runtime/audio/browser-audio-runtime';
import { createBrowserSessionStore } from '@/runtime/session/browser-session-store';

const navigate = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => navigate,
}));

const actors: Array<ReturnType<typeof createActor<typeof appLifecycleMachine>>> = [];

afterEach(() => {
  cleanup();
  for (const actor of actors.splice(0)) actor.stop();
  navigate.mockReset();
});

function createAudio(): ProductAudioRuntime {
  return {
    supported: true,
    activate: vi.fn(() => Promise.resolve()),
    prepareCues: vi.fn(() => Promise.resolve()),
    playCue: vi.fn(),
    setSfxEnabled: vi.fn(),
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
  const actor = createActor(appLifecycleMachine, {
    input: {
      capabilities,
      activateAudio,
      loadResources: () => new Promise<void>(() => {}),
    },
  });
  actor.start();
  actors.push(actor);
  render(
    <div className='game-logical-canvas'>
      <GlobalLayerHost
        store={createBrowserSessionStore()}
        globalActor={actor}
        locale={locale}
        routePath={APP_SCREEN_PATH.ENTRY}
      >
        <EntryScreen audio={createAudio()} globalActor={actor} locale={locale} />
      </GlobalLayerHost>
    </div>,
  );
  return { actor, activateAudio };
}

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
  fireEvent.click(screen.getByRole('button', { name: '개인정보처리방침' }));
  expect(screen.getByRole('dialog', { name: '개인정보처리방침' })).not.toBeNull();
  expect(screen.queryByText('WEBGL_UNAVAILABLE')).toBeNull();
});

/* eslint-disable testing-library/no-node-access -- input ownership requires observing inert ancestors across the composed layers. */
test('keeps the global offline action accessible above privacy and retains its input guard on privacy cleanup', () => {
  const { actor } = renderEntry();
  const trigger = screen.getByRole('button', { name: 'Privacy Policy' });
  fireEvent.click(trigger);
  const privacy = screen.getByRole('dialog', { name: 'Privacy Policy' });
  const close = within(privacy).getByRole('button', { name: 'Close' });

  act(() => actor.send({ type: 'NETWORK.CHANGED', status: 'offline' }));
  const refresh = screen.getByRole('button', { name: 'Refresh' });
  expect(refresh.closest('[inert]')).toBeNull();
  expect(privacy.closest('[inert]')).not.toBeNull();

  // Ending the retained local layer must not release a still-active global guard.
  fireEvent.click(close);
  expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
  expect(screen.getByTestId('global-interaction-surface').getAttribute('inert')).toBe('');

  act(() => actor.send({ type: 'NETWORK.CHANGED', status: 'connected' }));
  expect(screen.getByTestId('global-interaction-surface').hasAttribute('inert')).toBe(false);
  expect(screen.getByRole('button', { name: 'Privacy Policy' })).toBe(trigger);
});

test.each([true, false])(
  'privacy blocks only Entry content and unlocks it after closing with supported=%s',
  (supported) => {
    const { actor } = renderEntry({
      capabilities: supported
        ? { ok: true }
        : { ok: false, code: CAPABILITY_FAILURE_CODE.WEBGL_UNAVAILABLE },
    });
    const trigger = screen.getByRole('button', { name: 'Privacy Policy' });
    fireEvent.click(trigger);
    const privacy = screen.getByRole('dialog', { name: 'Privacy Policy' });
    expect(trigger.closest('[inert]')).not.toBeNull();
    expect(privacy.closest('[inert]')).toBeNull();
    const globalHost = screen.getByTestId('global-layer-host');
    expect(globalHost.closest('[inert]')).toBeNull();
    act(() => actor.send({ type: 'NETWORK.CHANGED', status: 'offline' }));
    act(() => actor.send({ type: 'NETWORK.CHANGED', status: 'connected' }));
    fireEvent.click(within(privacy).getByRole('button', { name: 'OK' }));
    expect(trigger.closest('[inert]')).toBeNull();
  },
);
