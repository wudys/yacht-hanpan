// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { createAppLifecycle } from '@/app/app-lifecycle';
import { GlobalLayerHost } from '@/app/GlobalLayerHost';
import { APP_SCREEN_PATH } from '@/app/screen-paths';
import { createSessionCredentialStore } from '@/runtime/session/session-credential-store';

const runtime = {
  capabilities: { ok: true } as const,
  activateAudio: () => Promise.resolve(),
  loadResources: () => Promise.resolve(),
};

afterEach(() => {
  vi.unstubAllGlobals();
});

test('locks and retains a non-game route while offline, then restores it online', () => {
  const reload = vi.fn();
  vi.stubGlobal('location', { reload });
  const lifecycle = createAppLifecycle(runtime);
  const view = render(
    <GlobalLayerHost
      sessionCredentialStore={createSessionCredentialStore()}
      lifecycle={lifecycle}
      locale='en'
      routePath={APP_SCREEN_PATH.ENTRY}
    >
      <button type='button'>Preserved route</button>
    </GlobalLayerHost>,
  );
  const route = screen.getByRole('button', { name: 'Preserved route' });

  act(() => lifecycle.setNetworkStatus('offline'));

  const interactionSurface = screen.getByTestId('global-interaction-surface');
  const modal = screen.getByRole('alertdialog', { name: 'Connection lost' });
  expect(interactionSurface.getAttribute('inert')).toBe('');
  expect(interactionSurface.getAttribute('aria-hidden')).toBe('true');
  expect(screen.getByText('Preserved route')).toBe(route);
  expect(modal.getAttribute('data-global-failure')).toBe('offline');
  expect(reload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(reload).toHaveBeenCalledOnce();

  act(() => lifecycle.setNetworkStatus('online'));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(interactionSurface.getAttribute('inert')).toBeNull();
  expect(screen.getByRole('button', { name: 'Preserved route' })).toBe(route);
  view.unmount();
  lifecycle.dispose();
});

test('keeps unsupported, Loading, and Game failure owners above browser offline hints', () => {
  const unsupported = createAppLifecycle({
    ...runtime,
    capabilities: { ok: false, code: 'WEBGL_UNAVAILABLE' } as const,
  });
  unsupported.setNetworkStatus('offline');
  const view = render(
    <GlobalLayerHost
      sessionCredentialStore={createSessionCredentialStore()}
      lifecycle={unsupported}
      locale='en'
      routePath={APP_SCREEN_PATH.ENTRY}
    >
      <p>Unsupported owner</p>
    </GlobalLayerHost>,
  );
  expect(screen.queryByRole('alertdialog')).toBeNull();
  unsupported.dispose();

  const interaction = createAppLifecycle(runtime);
  interaction.setNetworkStatus('offline');
  view.rerender(
    <GlobalLayerHost
      sessionCredentialStore={createSessionCredentialStore()}
      lifecycle={interaction}
      locale='en'
      routePath={APP_SCREEN_PATH.LOADING}
    >
      <p>Loading owner</p>
    </GlobalLayerHost>,
  );
  expect(screen.queryByRole('alertdialog')).toBeNull();

  view.rerender(
    <GlobalLayerHost
      sessionCredentialStore={createSessionCredentialStore()}
      lifecycle={interaction}
      locale='en'
      routePath={APP_SCREEN_PATH.GAME}
    >
      <p>Game recovery owner</p>
    </GlobalLayerHost>,
  );
  expect(screen.queryByRole('alertdialog')).toBeNull();
  view.unmount();
  interaction.dispose();
});

test('keeps a post-ready runtime failure visible above route and network changes', async () => {
  const reload = vi.fn();
  vi.stubGlobal('location', { reload });
  const lifecycle = createAppLifecycle(runtime);
  lifecycle.startBootstrap();
  await vi.waitFor(() => expect(lifecycle.getSnapshot().phase).toBe('ready'));
  const view = render(
    <GlobalLayerHost
      sessionCredentialStore={createSessionCredentialStore()}
      lifecycle={lifecycle}
      locale='en'
      routePath={APP_SCREEN_PATH.GAME}
    >
      <p>Latest game snapshot</p>
    </GlobalLayerHost>,
  );

  act(() => lifecycle.reportRuntimeFailure());
  const modal = await screen.findByRole('alertdialog', { name: 'Game error' });
  expect(modal.getAttribute('data-global-failure')).toBe('runtimeFailure');
  expect(screen.getByText('Latest game snapshot')).not.toBeNull();
  expect(reload).not.toHaveBeenCalled();

  act(() => lifecycle.setNetworkStatus('offline'));
  act(() => lifecycle.setNetworkStatus('online'));
  await waitFor(() => expect(screen.getByRole('alertdialog')).toBe(modal));
  view.unmount();
  lifecycle.dispose();
});

test('replacement ends the route and keeps one short reload action despite later network changes', () => {
  const reload = vi.fn();
  vi.stubGlobal('location', { reload });
  const lifecycle = createAppLifecycle(runtime);
  const sessionCredentialStore = createSessionCredentialStore();
  const view = render(
    <GlobalLayerHost
      sessionCredentialStore={sessionCredentialStore}
      lifecycle={lifecycle}
      locale='ko'
      routePath={APP_SCREEN_PATH.GAME}
    >
      <button type='button'>게임 조작</button>
    </GlobalLayerHost>,
  );
  act(() => lifecycle.replaceSession());
  expect(screen.queryByText('게임 조작')).toBeNull();
  expect(screen.getByRole('alertdialog').textContent).toContain(
    '다른 곳에서 이 게임에 접속했어요.',
  );
  fireEvent.keyDown(document, { key: 'Escape' });
  act(() => lifecycle.setNetworkStatus('online'));
  expect(screen.getByRole('alertdialog')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '시작 화면으로' }));
  expect(reload).toHaveBeenCalledOnce();
  expect(lifecycle.getSnapshot().phase).toBe('replaced');
  view.unmount();
});
