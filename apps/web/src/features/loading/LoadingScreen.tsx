import { useNavigate } from '@tanstack/react-router';
import { useSelector } from '@xstate/react';
import { useEffect } from 'react';
import type { ActorRefFrom } from 'xstate';

import { appLifecycleMachine } from '@/app/app-lifecycle-machine';
import { APP_SCREEN_PATH } from '@/app/screen-paths';
import { LoadingView } from '@/features/loading/view/LoadingView';
import { type Locale, translate } from '@/i18n';
import type { BrowserAudioRuntime } from '@/runtime/audio/browser-audio-runtime';
import { useScreenTelemetry } from '@/runtime/telemetry/TelemetryContext';
import { BrandLockup } from '@/ui/brand';
import { Button } from '@/ui/button';
import { ScrollablePanel } from '@/ui/panel';

export function LoadingScreen({
  audio,
  globalActor,
  locale,
}: Readonly<{
  audio: BrowserAudioRuntime;
  globalActor: ActorRefFrom<typeof appLifecycleMachine>;
  locale: Locale;
}>) {
  useScreenTelemetry('loading');
  const navigate = useNavigate();
  const ready = useSelector(globalActor, (snapshot) => snapshot.matches('ready'));
  const progress = useSelector(globalActor, (snapshot) => snapshot.context.bootstrapProgress);
  const resourceFailure = useSelector(globalActor, (snapshot) =>
    snapshot.matches('resourceFailure'),
  );

  useEffect(() => {
    void audio.setScene(null);
  }, [audio]);

  useEffect(() => {
    if (!ready || progress.progress < 1) return;
    let navigationFrame: number | undefined;
    let completionTimer: ReturnType<typeof setTimeout> | undefined;
    const completedPaintFrame = requestAnimationFrame(() => {
      navigationFrame = requestAnimationFrame(() => {
        completionTimer = setTimeout(() => {
          void navigate({ to: APP_SCREEN_PATH.LOBBY, replace: true });
        }, 200);
      });
    });
    return () => {
      cancelAnimationFrame(completedPaintFrame);
      if (navigationFrame !== undefined) cancelAnimationFrame(navigationFrame);
      if (completionTimer !== undefined) clearTimeout(completionTimer);
    };
  }, [navigate, progress.progress, ready]);

  const content = resourceFailure ? (
    <>
      <div className='game-status-view loading-view' aria-hidden='true'>
        <BrandLockup />
      </div>
      <div
        className='web-loading-error'
        role='alertdialog'
        aria-modal='true'
        aria-label={translate(locale, 'resource.failureTitle')}
        data-resource-failure='BOOTSTRAP_FAILED'
      >
        <ScrollablePanel
          variant='notice'
          title={translate(locale, 'resource.failureTitle')}
          footer={
            <Button
              label={translate(locale, 'common.retry')}
              onClick={() => globalActor.send({ type: 'BOOTSTRAP.RETRY' })}
            />
          }
        >
          <p>{translate(locale, 'resource.failureMessage')}</p>
        </ScrollablePanel>
      </div>
    </>
  ) : (
    <LoadingView
      progress={progress.progress}
      label={translate(locale, 'loading.preparingGame')}
      progressLabel={translate(locale, 'loading.progressLabel')}
    />
  );

  return (
    <div className='web-loading-scene' data-screen='loading'>
      {content}
    </div>
  );
}
