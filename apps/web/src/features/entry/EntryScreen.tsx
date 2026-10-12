import { useNavigate } from '@tanstack/react-router';
import { useEffect, useSyncExternalStore } from 'react';

import type { AppLifecycle } from '@/app/app-lifecycle';
import { APP_SCREEN_PATH } from '@/app/screen-paths';
import { CapabilityFailureView } from '@/features/entry/ui/CapabilityFailureView';
import { EntryView } from '@/features/entry/ui/EntryView';
import { PrivacyDialog } from '@/features/privacy/PrivacyDialog';
import { type Locale, translate } from '@/i18n';
import type { BrowserAudioRuntime } from '@/runtime/audio/browser-audio-runtime';
import { useScreenTelemetry } from '@/runtime/telemetry/TelemetryContext';

export function EntryScreen({
  audio,
  lifecycle,
  locale,
}: Readonly<{
  audio: BrowserAudioRuntime;
  lifecycle: AppLifecycle;
  locale: Locale;
}>) {
  useScreenTelemetry('entry');
  const navigate = useNavigate({ from: APP_SCREEN_PATH.ENTRY });
  const { phase, capabilities } = useSyncExternalStore(lifecycle.subscribe, lifecycle.getSnapshot);
  const unsupported = phase === 'unsupported';
  const activationFailure = phase === 'activationFailure';
  const activatingAudio = phase === 'activatingAudio';
  const shouldEnterLoading =
    phase === 'loadingResources' || phase === 'resourceFailure' || phase === 'ready';

  useEffect(() => {
    if (shouldEnterLoading)
      void navigate({ to: APP_SCREEN_PATH.LOADING, replace: true, viewTransition: true });
  }, [shouldEnterLoading, navigate]);

  useEffect(() => {
    void audio.setScene(null);
  }, [audio]);

  return (
    <div className='web-entry-scene' data-screen='entry'>
      <PrivacyDialog locale={locale}>
        {(privacyLink) =>
          unsupported && !capabilities.ok ? (
            <CapabilityFailureView
              code={capabilities.code}
              title={translate(locale, 'capability.unsupportedTitle')}
              message={translate(locale, 'capability.unsupportedMessage')}
            />
          ) : (
            <EntryView
              privacyAction={privacyLink}
              title={translate(locale, 'app.startTitle')}
              startLabel={translate(locale, 'app.startAction')}
              demoServerNotice={
                import.meta.env.VITE_DEMO_NOTICE_ENABLED === 'true'
                  ? translate(locale, 'app.demoServerNotice')
                  : undefined
              }
              activationFailure={
                activationFailure ? translate(locale, 'app.activationFailure') : undefined
              }
              pending={activatingAudio}
              onStart={() => lifecycle.startBootstrap()}
            />
          )
        }
      </PrivacyDialog>
    </div>
  );
}
