import { useSelector } from '@xstate/react';
import { type ReactNode, useSyncExternalStore } from 'react';
import type { ActorRefFrom } from 'xstate';

import { appLifecycleMachine } from '@/app/app-lifecycle-machine';
import { APP_SCREEN_PATH } from '@/app/screen-paths';
import { type Locale, translate } from '@/i18n';
import type { BrowserSessionStore } from '@/runtime/session/browser-session-store';
import { Button } from '@/ui/button';
import { ScrollablePanel } from '@/ui/panel';

export function GlobalLayerHost({
  globalActor,
  locale,
  routePath,
  store,
  children,
}: Readonly<{
  globalActor: ActorRefFrom<typeof appLifecycleMachine>;
  locale: Locale;
  routePath: string;
  store: BrowserSessionStore;
  children: ReactNode;
}>) {
  const snapshot = useSelector(globalActor, (current) => current);
  const { persistence } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const replaced = snapshot.matches('replaced');
  const network = snapshot.context.networkStatus;
  const runtimeFailure = snapshot.matches('runtimeFailure');
  const networkLayerAllowed = snapshot.matches('interaction') || snapshot.matches('ready');
  const routeOwnsConnectivity =
    routePath === APP_SCREEN_PATH.LOADING || routePath === APP_SCREEN_PATH.GAME;
  const offline = network === 'offline' && networkLayerAllowed && !routeOwnsConnectivity;
  const failure = replaced
    ? 'replaced'
    : runtimeFailure
      ? 'runtimeFailure'
      : offline
        ? 'offline'
        : null;
  const title = translate(
    locale,
    replaced
      ? 'session.replacedTitle'
      : runtimeFailure
        ? 'error.gameRuntimeFailedTitle'
        : 'error.networkUnavailableTitle',
  );

  return (
    <>
      <div
        className='web-global-interaction-surface'
        data-testid='global-interaction-surface'
        inert={failure !== null || undefined}
        aria-hidden={failure !== null || undefined}
      >
        {!replaced && children}
      </div>
      <div
        className='web-global-layer-host'
        data-network-status={network}
        data-testid='global-layer-host'
      >
        {persistence === 'memoryOnly' && !failure && routePath !== APP_SCREEN_PATH.GAME ? (
          <p className='web-session-storage-notice' role='status'>
            {translate(locale, 'session.storageFailure')}
          </p>
        ) : null}
        {failure ? (
          <div
            className='web-global-failure'
            role='alertdialog'
            aria-modal='true'
            aria-label={title}
            data-global-failure={failure}
          >
            <ScrollablePanel
              variant='notice'
              title={title}
              footer={
                <Button
                  label={translate(locale, replaced ? 'session.restart' : 'common.refresh')}
                  onClick={() => globalThis.location.reload()}
                />
              }
            >
              <p>
                {translate(
                  locale,
                  failure === 'replaced'
                    ? 'session.replaced'
                    : failure === 'runtimeFailure'
                      ? 'error.gameRuntimeFailed'
                      : 'error.networkUnavailable',
                )}
              </p>
            </ScrollablePanel>
          </div>
        ) : null}
      </div>
    </>
  );
}
