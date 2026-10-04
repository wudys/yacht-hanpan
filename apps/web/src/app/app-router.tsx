/* eslint-disable react-refresh/only-export-components -- this module owns the code-based route tree and router factory. */

import type { ServerClock } from '@repo/game-client-sdk';
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  useRouterState,
} from '@tanstack/react-router';
import { lazy, Suspense, useCallback, useSyncExternalStore } from 'react';
import type { ActorRefFrom } from 'xstate';

import { appLifecycleMachine } from '@/app/app-lifecycle-machine';
import { AppShell } from '@/app/AppShell';
import { APP_SCREEN_PATH } from '@/app/screen-paths';
import { EntryScreen } from '@/features/entry/EntryScreen';
import { LoadingScreen } from '@/features/loading/LoadingScreen';
import type { BrowserAudioRuntime } from '@/runtime/audio/browser-audio-runtime';
import type { GameAudioFeedback } from '@/runtime/audio/game-audio-feedback';
import type { RendererReadiness } from '@/runtime/dice/canvas/renderer-readiness';
import type { DicePresentation } from '@/runtime/dice/dice-presentation';
import type { PreferencesStore } from '@/runtime/preferences/preferences-store';
import type { ProfileSelectionStore } from '@/runtime/profile/profile-selection-store';
import type { RoomAccess } from '@/runtime/room-access/room-access';
import type { GameSessionHolder } from '@/runtime/session/game-session-holder';
import type { SessionCredentialStore } from '@/runtime/session/session-credential-store';
import type { SessionRecovery } from '@/runtime/session/session-recovery';

const LobbyScreen = lazy(() => import('@/features/lobby/LobbyScreen'));
const GameScreen = lazy(() => import('@/features/game/GameScreen'));

export interface AppRouterContext {
  readonly activity: AbortSignal;
  readonly access: RoomAccess;
  readonly audio: BrowserAudioRuntime;
  readonly feedback: Pick<GameAudioFeedback, 'observeCommand'>;
  readonly preferences: PreferencesStore;
  readonly profile: ProfileSelectionStore;
  readonly globalActor: ActorRefFrom<typeof appLifecycleMachine>;
  readonly renderer: RendererReadiness;
  readonly clock: Pick<ServerClock, 'now'>;
  readonly sessions: GameSessionHolder;
  readonly sessionCredentialStore: SessionCredentialStore;
  readonly recovery: SessionRecovery;
  readonly presentation: DicePresentation;
}

const rootRoute = createRootRouteWithContext<AppRouterContext>()({
  component: RootLayout,
});

const entryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: APP_SCREEN_PATH.ENTRY,
  component: EntryRoute,
});

const loadingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: APP_SCREEN_PATH.LOADING,
  component: LoadingRoute,
});

const lobbyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: APP_SCREEN_PATH.LOBBY,
  component: LobbyRoute,
});

const gameRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: APP_SCREEN_PATH.GAME,
  component: GameRoute,
});

const routeTree = rootRoute.addChildren([entryRoute, loadingRoute, lobbyRoute, gameRoute]);

export function createAppRouter(context: AppRouterContext) {
  return createRouter({
    context,
    history: createMemoryHistory({ initialEntries: [APP_SCREEN_PATH.ENTRY] }),
    routeTree,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}

function RootLayout() {
  const {
    globalActor,
    preferences,
    audio,
    recovery,
    renderer,
    presentation,
    sessionCredentialStore,
  } = rootRoute.useRouteContext();
  const routePath = useRouterState({ select: (state) => state.location.pathname });
  return (
    <AppShell
      audio={audio}
      globalActor={globalActor}
      preferences={preferences}
      renderer={renderer}
      presentation={presentation}
      sessionCredentialStore={sessionCredentialStore}
      routePath={routePath}
      onOrientationGuardExit={recovery.requestSynchronization}
    >
      <Outlet />
    </AppShell>
  );
}

function EntryRoute() {
  const { audio, globalActor, preferences } = entryRoute.useRouteContext();
  const locale = useRouteLocale(preferences);
  return <EntryScreen audio={audio} globalActor={globalActor} locale={locale} />;
}

function LoadingRoute() {
  const { audio, globalActor, preferences } = loadingRoute.useRouteContext();
  const locale = useRouteLocale(preferences);
  return <LoadingScreen audio={audio} globalActor={globalActor} locale={locale} />;
}

function LobbyRoute() {
  const { activity, access, audio, preferences, clock, profile } = lobbyRoute.useRouteContext();
  const locale = useRouteLocale(preferences);
  return (
    <Suspense fallback={null}>
      <LobbyScreen
        activity={activity}
        access={access}
        audio={audio}
        locale={locale}
        clock={clock}
        profile={profile}
        preferences={preferences}
      />
    </Suspense>
  );
}

function GameRoute() {
  const {
    audio,
    feedback,
    preferences,
    clock,
    sessions,
    sessionCredentialStore,
    recovery,
    presentation,
  } = gameRoute.useRouteContext();
  const locale = useRouteLocale(preferences);
  return (
    <Suspense fallback={null}>
      <GameScreen
        audio={audio}
        feedback={feedback}
        locale={locale}
        clock={clock}
        sessions={sessions}
        sessionCredentialStore={sessionCredentialStore}
        preferences={preferences}
        recovery={recovery}
        presentation={presentation}
      />
    </Suspense>
  );
}

function useRouteLocale(preferences: PreferencesStore) {
  const getLocale = useCallback(() => preferences.getSnapshot().locale, [preferences]);
  return useSyncExternalStore(preferences.subscribe, getLocale);
}
