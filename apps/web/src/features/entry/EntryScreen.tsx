import { useNavigate } from '@tanstack/react-router';
import { useSelector } from '@xstate/react';
import { useEffect } from 'react';
import type { ActorRefFrom } from 'xstate';

import { appLifecycleMachine } from '@/app/app-lifecycle-machine';
import { APP_SCREEN_PATH } from '@/app/screen-paths';
import { CapabilityFailureView } from '@/features/entry/view/CapabilityFailureView';
import { EntryView } from '@/features/entry/view/EntryView';
import { PrivacyDialog } from '@/features/privacy/PrivacyDialog';
import { type Locale, translate } from '@/i18n';
import type { BrowserAudioRuntime } from '@/runtime/audio/browser-audio-runtime';
import { useScreenTelemetry } from '@/runtime/telemetry/TelemetryContext';

export function EntryScreen({
  audio,
  globalActor,
  locale,
}: Readonly<{
  audio: BrowserAudioRuntime;
  globalActor: ActorRefFrom<typeof appLifecycleMachine>;
  locale: Locale;
}>) {
  useScreenTelemetry('entry');
  const navigate = useNavigate({ from: APP_SCREEN_PATH.ENTRY });
  const unsupported = useSelector(globalActor, (snapshot) => snapshot.matches('unsupported'));
  const capabilities = useSelector(
    globalActor,
    (snapshot) => snapshot.context.runtime.capabilities,
  );
  const activationFailure = useSelector(globalActor, (snapshot) =>
    snapshot.matches('activationFailure'),
  );
  const activatingAudio = useSelector(globalActor, (snapshot) =>
    snapshot.matches('activatingAudio'),
  );
  const loading = useSelector(
    globalActor,
    (snapshot) =>
      snapshot.matches('loadingResources') ||
      snapshot.matches('resourceFailure') ||
      snapshot.matches('ready'),
  );

  useEffect(() => {
    if (loading)
      void navigate({ to: APP_SCREEN_PATH.LOADING, replace: true, viewTransition: true });
  }, [loading, navigate]);

  useEffect(() => {
    void audio.setScene(null);
  }, [audio]);

  return (
    <div className='web-entry-scene' data-screen='entry'>
      <PrivacyDialog locale={locale}>
        {(privacyLink) =>
          unsupported && !capabilities.ok ? (
            <CapabilityFailureView
              footer={privacyLink}
              code={capabilities.code}
              title={translate(locale, 'capability.unsupportedTitle')}
              message={translate(locale, 'capability.unsupportedMessage')}
            />
          ) : (
            <EntryView
              footer={privacyLink}
              title={translate(locale, 'app.startTitle')}
              startLabel={translate(locale, 'app.startAction')}
              activationFailure={
                activationFailure ? translate(locale, 'app.activationFailure') : undefined
              }
              pending={activatingAudio}
              onStart={() => globalActor.send({ type: 'BOOTSTRAP.START' })}
            />
          )
        }
      </PrivacyDialog>
    </div>
  );
}
