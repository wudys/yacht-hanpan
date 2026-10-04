// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { createActor, waitFor as waitForActor } from 'xstate';

import { appLifecycleMachine } from '@/app/app-lifecycle-machine';
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
  const actor = createActor(appLifecycleMachine, { input: runtime }).start();
  const view = render(
    <GlobalLayerHost
      sessionCredentialStore={createSessionCredentialStore()}
      globalActor={actor}
      locale='en'
      routePath={APP_SCREEN_PATH.ENTRY}
    >
      <button type='button'>Preserved route</button>
    </GlobalLayerHost>,
  );
  const route = screen.getByRole('button', { name: 'Preserved route' });

  act(() => actor.send({ type: 'NETWORK.CHANGED', status: 'offline' }));

  const interactionSurface = screen.getByTestId('global-interaction-surface');
  const modal = screen.getByRole('alertdialog', { name: 'Connection lost' });
  expect(interactionSurface.getAttribute('inert')).toBe('');
  expect(interactionSurface.getAttribute('aria-hidden')).toBe('true');
  expect(screen.getByText('Preserved route')).toBe(route);
  expect(modal.getAttribute('data-global-failure')).toBe('offline');
  expect(reload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(reload).toHaveBeenCalledOnce();

  act(() => actor.send({ type: 'NETWORK.CHANGED', status: 'online' }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(interactionSurface.getAttribute('inert')).toBeNull();
  expect(screen.getByRole('button', { name: 'Preserved route' })).toBe(route);
  view.unmount();
  actor.stop();
});

test('keeps unsupported, Loading, and Game failure owners above browser offline hints', () => {
  const unsupported = createActor(appLifecycleMachine, {
    input: {
      ...runtime,
      capabilities: { ok: false, code: 'WEBGL_UNAVAILABLE' } as const,
    },
  }).start();
  unsupported.send({ type: 'NETWORK.CHANGED', status: 'offline' });
  const view = render(
    <GlobalLayerHost
      sessionCredentialStore={createSessionCredentialStore()}
      globalActor={unsupported}
      locale='en'
      routePath={APP_SCREEN_PATH.ENTRY}
    >
      <p>Unsupported owner</p>
    </GlobalLayerHost>,
  );
  expect(screen.queryByRole('alertdialog')).toBeNull();
  unsupported.stop();

  const interaction = createActor(appLifecycleMachine, { input: runtime }).start();
  interaction.send({ type: 'NETWORK.CHANGED', status: 'offline' });
  view.rerender(
    <GlobalLayerHost
      sessionCredentialStore={createSessionCredentialStore()}
      globalActor={interaction}
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
      globalActor={interaction}
      locale='en'
      routePath={APP_SCREEN_PATH.GAME}
    >
      <p>Game recovery owner</p>
    </GlobalLayerHost>,
  );
  expect(screen.queryByRole('alertdialog')).toBeNull();
  view.unmount();
  interaction.stop();
});

test('keeps a post-ready runtime failure visible above route and network changes', async () => {
  const reload = vi.fn();
  vi.stubGlobal('location', { reload });
  const actor = createActor(appLifecycleMachine, { input: runtime }).start();
  actor.send({ type: 'BOOTSTRAP.START' });
  await waitForActor(actor, (snapshot) => snapshot.matches('ready'));
  const view = render(
    <GlobalLayerHost
      sessionCredentialStore={createSessionCredentialStore()}
      globalActor={actor}
      locale='en'
      routePath={APP_SCREEN_PATH.GAME}
    >
      <p>Latest game snapshot</p>
    </GlobalLayerHost>,
  );

  act(() => actor.send({ type: 'RUNTIME.CAPABILITY_FAILED' }));
  const modal = await screen.findByRole('alertdialog', { name: 'Game error' });
  expect(modal.getAttribute('data-global-failure')).toBe('runtimeFailure');
  expect(screen.getByText('Latest game snapshot')).not.toBeNull();
  expect(reload).not.toHaveBeenCalled();

  act(() => actor.send({ type: 'NETWORK.CHANGED', status: 'offline' }));
  act(() => actor.send({ type: 'NETWORK.CHANGED', status: 'online' }));
  await waitFor(() => expect(screen.getByRole('alertdialog')).toBe(modal));
  view.unmount();
  actor.stop();
});

test('replacement ends the route and keeps one short reload action despite later network changes', () => {
  const reload = vi.fn();
  vi.stubGlobal('location', { reload });
  const actor = createActor(appLifecycleMachine, { input: runtime }).start();
  const sessionCredentialStore = createSessionCredentialStore();
  const view = render(
    <GlobalLayerHost
      sessionCredentialStore={sessionCredentialStore}
      globalActor={actor}
      locale='ko'
      routePath={APP_SCREEN_PATH.GAME}
    >
      <button type='button'>게임 조작</button>
    </GlobalLayerHost>,
  );
  act(() => actor.send({ type: 'SESSION.REPLACED' }));
  expect(screen.queryByText('게임 조작')).toBeNull();
  expect(screen.getByRole('alertdialog').textContent).toContain(
    '다른 곳에서 이 게임에 접속했어요.',
  );
  fireEvent.keyDown(document, { key: 'Escape' });
  act(() => actor.send({ type: 'NETWORK.CHANGED', status: 'online' }));
  expect(screen.getByRole('alertdialog')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '시작 화면으로' }));
  expect(reload).toHaveBeenCalledOnce();
  expect(actor.getSnapshot().status).toBe('done');
  view.unmount();
});
