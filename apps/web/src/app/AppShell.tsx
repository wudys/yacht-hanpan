import { requireGameAsset } from '@repo/game-assets';
import { type CSSProperties, memo, type ReactNode, useEffect, useSyncExternalStore } from 'react';
import type { ActorRefFrom } from 'xstate';

import type { appLifecycleMachine } from '@/app/app-lifecycle-machine';
import { GlobalLayerHost } from '@/app/GlobalLayerHost';
import { ProductSurfaceBoundary } from '@/app/ProductSurfaceBoundary';
import { translate } from '@/i18n';
import type { BrowserAudioRuntime } from '@/runtime/audio/browser-audio-runtime';
import type { RendererReadiness } from '@/runtime/dice/canvas/renderer-readiness';
import type { DicePresentation } from '@/runtime/dice/dice-presentation';
import { PersistentDiceCanvas } from '@/runtime/dice/PersistentDiceCanvas';
import type { PreferencesStore } from '@/runtime/preferences/preferences-store';
import type { SessionCredentialStore } from '@/runtime/session/session-credential-store';
import { GameFrame } from '@/ui/layout';

const wrapperPatternUrl = requireGameAsset('brand.wrapper-pattern').url;
const wrapperLogoUrl = requireGameAsset('brand.logo').url;
const MemoizedDiceCanvas = memo(PersistentDiceCanvas);
const webShellStyle = {
  '--web-wrapper-pattern-image': `url("${wrapperPatternUrl}")`,
} as CSSProperties;

export function AppShell({
  audio,
  globalActor,
  preferences,
  renderer,
  presentation,
  sessionCredentialStore,
  routePath,
  onPlayableAreaRestored,
  onSurfaceExposureChange,
  children,
}: Readonly<{
  audio: BrowserAudioRuntime;
  globalActor: ActorRefFrom<typeof appLifecycleMachine>;
  preferences: PreferencesStore;
  renderer: RendererReadiness;
  presentation: DicePresentation;
  sessionCredentialStore: SessionCredentialStore;
  routePath: string;
  onPlayableAreaRestored: () => void;
  onSurfaceExposureChange: (exposed: boolean) => void;
  children: ReactNode;
}>) {
  const { locale, bgmEnabled, sfxEnabled } = useSyncExternalStore(
    preferences.subscribe,
    preferences.getSnapshot,
  );
  useEffect(() => {
    void audio.setBgmEnabled(bgmEnabled);
  }, [audio, bgmEnabled]);
  useEffect(() => {
    audio.setSfxEnabled(sfxEnabled);
  }, [audio, sfxEnabled]);
  return (
    <div className='web-app-shell' data-web-app-shell='true' style={webShellStyle}>
      <GameFrame
        playAreaMessage={
          <>
            <strong>{translate(locale, 'layout.insufficientSpaceTitle')}</strong>
            <span>{translate(locale, 'layout.insufficientSpaceDescription')}</span>
          </>
        }
        logo={<img className='web-logo' src={wrapperLogoUrl} alt='' draggable={false} />}
      >
        {(frameAvailability) => (
          <GlobalLayerHost
            sessionCredentialStore={sessionCredentialStore}
            globalActor={globalActor}
            locale={locale}
            routePath={routePath}
          >
            {({ contentExposed }) => (
              <ProductSurfaceBoundary
                frameAvailability={frameAvailability}
                contentExposed={contentExposed}
                onPlayableAreaRestored={onPlayableAreaRestored}
                onSurfaceExposureChange={onSurfaceExposureChange}
              >
                <MemoizedDiceCanvas renderer={renderer} presentation={presentation} />
                {children}
              </ProductSurfaceBoundary>
            )}
          </GlobalLayerHost>
        )}
      </GameFrame>
    </div>
  );
}
