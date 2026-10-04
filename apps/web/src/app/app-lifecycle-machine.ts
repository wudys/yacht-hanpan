import { assign, fromPromise, setup } from 'xstate';

import type { BootstrapProgress } from '@/bootstrap/bootstrap-progress';
import type { StaticCapabilityResult } from '@/bootstrap/static-capabilities';

export type AppNetworkStatus = 'idle' | 'online' | 'offline';

export interface AppLifecycleRuntime {
  readonly capabilities: StaticCapabilityResult;
  readonly activateAudio: () => Promise<void>;
  readonly onUnexpected?: (error: unknown) => void;
  readonly loadResources: (
    onProgress: (progress: BootstrapProgress) => void,
    signal: AbortSignal,
  ) => Promise<void>;
}

type AppLifecycleContext = Readonly<{
  runtime: AppLifecycleRuntime;
  networkStatus: AppNetworkStatus;
  bootstrapProgress: BootstrapProgress;
}>;

type AppLifecycleEvent =
  | Readonly<{ type: 'BOOTSTRAP.START' }>
  | Readonly<{ type: 'BOOTSTRAP.RETRY' }>
  | Readonly<{ type: 'BOOTSTRAP.PROGRESS'; progress: BootstrapProgress }>
  | Readonly<{ type: 'NETWORK.CHANGED'; status: AppNetworkStatus }>
  | Readonly<{ type: 'RUNTIME.CAPABILITY_FAILED' }>
  | Readonly<{ type: 'SESSION.REPLACED' }>;

export const appLifecycleMachine = setup({
  types: {
    context: {} as AppLifecycleContext,
    events: {} as AppLifecycleEvent,
    input: {} as AppLifecycleRuntime,
  },
  actors: {
    activateAudio: fromPromise<void, AppLifecycleRuntime>(({ input }) => input.activateAudio()),
    loadResources: fromPromise<
      void,
      Readonly<{ runtime: AppLifecycleRuntime; report: (progress: BootstrapProgress) => void }>
    >(({ input, signal }) =>
      input.runtime.loadResources((progress) => {
        if (!signal.aborted) input.report(progress);
      }, signal),
    ),
  },
  guards: {
    capabilityUnavailable: ({ context }) => !context.runtime.capabilities.ok,
  },
}).createMachine({
  context: ({ input }) => ({
    runtime: input,
    networkStatus: 'idle',
    bootstrapProgress: { phase: 'modules', progress: 0 },
  }),
  initial: 'checkingCapabilities',
  on: {
    'SESSION.REPLACED': '.replaced',
    'NETWORK.CHANGED': {
      actions: assign({ networkStatus: ({ event }) => event.status }),
    },
  },
  states: {
    checkingCapabilities: {
      always: [
        { guard: 'capabilityUnavailable', target: 'unsupported' },
        { target: 'interaction' },
      ],
    },
    interaction: {
      on: { 'BOOTSTRAP.START': 'activatingAudio' },
    },
    activatingAudio: {
      invoke: {
        src: 'activateAudio',
        input: ({ context }) => context.runtime,
        onDone: 'loadingResources',
        onError: {
          target: 'activationFailure',
          actions: ({ context, event }) => context.runtime.onUnexpected?.(event.error),
        },
      },
    },
    loadingResources: {
      on: {
        'BOOTSTRAP.PROGRESS': {
          actions: assign({ bootstrapProgress: ({ event }) => event.progress }),
        },
        'RUNTIME.CAPABILITY_FAILED': 'runtimeFailure',
      },
      invoke: {
        src: 'loadResources',
        input: ({ context, self }) => ({
          runtime: context.runtime,
          report: (progress: BootstrapProgress) =>
            self.send({ type: 'BOOTSTRAP.PROGRESS', progress }),
        }),
        onDone: {
          target: 'ready',
          actions: assign({
            bootstrapProgress: { phase: 'gpu', progress: 1 },
          }),
        },
        onError: 'resourceFailure',
      },
    },
    ready: { on: { 'RUNTIME.CAPABILITY_FAILED': 'runtimeFailure' } },
    replaced: { type: 'final' },
    runtimeFailure: {},
    unsupported: {},
    activationFailure: { on: { 'BOOTSTRAP.START': 'activatingAudio' } },
    resourceFailure: { on: { 'BOOTSTRAP.RETRY': 'loadingResources' } },
  },
});
