import { useNavigate } from '@tanstack/react-router';
import { useEffect, useSyncExternalStore } from 'react';

import type { AppLifecycle } from '@/app/lifecycle/app-lifecycle';
import { APP_SCREEN_PATH } from '@/app/routing/screen-paths';
import { LoadingView } from '@/features/loading/ui/LoadingView';
import { type Locale, translate } from '@/i18n';
import type { BrowserAudioRuntime } from '@/runtime/audio/browser-audio-runtime';
import { useScreenTelemetry } from '@/runtime/telemetry/TelemetryContext';
import { BrandLockup, Button, ScrollablePanel } from '@/ui';

export function LoadingScreen({
  audio,
  lifecycle,
  locale,
}: Readonly<{
  audio: BrowserAudioRuntime;
  lifecycle: AppLifecycle;
  locale: Locale;
}>) {
  useScreenTelemetry('loading');
  const navigate = useNavigate();
  const { phase, bootstrapProgress: progress } = useSyncExternalStore(
    lifecycle.subscribe,
    lifecycle.getSnapshot,
  );
  const ready = phase === 'ready';
  const resourceFailure = phase === 'resourceFailure';

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
              onClick={() => lifecycle.retryResources()}
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
