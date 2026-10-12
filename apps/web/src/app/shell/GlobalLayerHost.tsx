import { type ReactNode, useSyncExternalStore } from 'react';

import type { AppLifecycle, AppLifecycleSnapshot } from '@/app/lifecycle/app-lifecycle';
import { APP_SCREEN_PATH } from '@/app/routing/screen-paths';
import { type Locale, translate } from '@/i18n';
import type { SessionCredentialStore } from '@/runtime/session/session-credential-store';
import { Button, ScrollablePanel } from '@/ui';

const FAILURE_MESSAGES = {
  replaced: {
    title: 'session.replacedTitle',
    message: 'session.replaced',
    action: 'session.restart',
  },
  runtimeFailure: {
    title: 'error.gameRuntimeFailedTitle',
    message: 'error.gameRuntimeFailed',
    action: 'common.refresh',
  },
  offline: {
    title: 'error.networkUnavailableTitle',
    message: 'error.networkUnavailable',
    action: 'common.refresh',
  },
} as const;

export function GlobalLayerHost({
  lifecycle,
  locale,
  routePath,
  sessionCredentialStore,
  children,
}: Readonly<{
  lifecycle: AppLifecycle;
  locale: Locale;
  routePath: string;
  sessionCredentialStore: SessionCredentialStore;
  children: ReactNode | ((state: { contentExposed: boolean }) => ReactNode);
}>) {
  const snapshot = useSyncExternalStore(lifecycle.subscribe, lifecycle.getSnapshot);
  const { persistence } = useSyncExternalStore(
    sessionCredentialStore.subscribe,
    sessionCredentialStore.getSnapshot,
  );
  const failure = getGlobalFailure(snapshot, routePath);
  const notice = failure === null ? null : FAILURE_MESSAGES[failure];
  const contentExposed = failure === null;

  return (
    <>
      <div
        className='web-global-interaction-surface'
        data-testid='global-interaction-surface'
        inert={!contentExposed || undefined}
        aria-hidden={!contentExposed || undefined}
      >
        {failure !== 'replaced' &&
          (typeof children === 'function' ? children({ contentExposed }) : children)}
      </div>
      <div
        className='web-global-layer-host'
        data-network-status={snapshot.networkStatus}
        data-testid='global-layer-host'
      >
        {persistence === 'memoryOnly' && !failure && routePath !== APP_SCREEN_PATH.GAME ? (
          <p className='web-session-storage-notice' role='status'>
            {translate(locale, 'session.storageFailure')}
          </p>
        ) : null}
        {notice ? (
          <div
            className='web-global-failure'
            role='alertdialog'
            aria-modal='true'
            aria-label={translate(locale, notice.title)}
            data-global-failure={failure}
          >
            <ScrollablePanel
              variant='notice'
              title={translate(locale, notice.title)}
              footer={
                <Button
                  label={translate(locale, notice.action)}
                  onClick={() => globalThis.location.reload()}
                />
              }
            >
              <p>{translate(locale, notice.message)}</p>
            </ScrollablePanel>
          </div>
        ) : null}
      </div>
    </>
  );
}

function getGlobalFailure(
  snapshot: AppLifecycleSnapshot,
  routePath: string,
): keyof typeof FAILURE_MESSAGES | null {
  if (snapshot.phase === 'replaced') return 'replaced';
  if (snapshot.phase === 'runtimeFailure') return 'runtimeFailure';
  if (snapshot.phase !== 'awaitingStart' && snapshot.phase !== 'ready') return null;
  if (routePath === APP_SCREEN_PATH.LOADING || routePath === APP_SCREEN_PATH.GAME) return null;
  return snapshot.networkStatus === 'offline' ? 'offline' : null;
}
