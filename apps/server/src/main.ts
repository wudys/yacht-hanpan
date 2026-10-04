import type { GameServer } from '@/app/start-game-server';
import {
  ROLL_SIMULATION_EXECUTOR_ERROR_CODE,
  RollSimulationExecutorError,
} from '@/roll/roll-simulation-executor';
import { type ErrorReporter, reportUnexpected } from '@/runtime/error-reporter';
import { type ServerDiagnostics, startServerDiagnostics } from '@/runtime/server-diagnostics';
import { readServerDiagnosticsConfig } from '@/runtime/server-diagnostics-config';

export async function runGameServerProcess(
  diagnostics: ServerDiagnostics,
  start: (reporter: ErrorReporter) => Promise<Pick<GameServer, 'url' | 'close'>> = async (
    reporter,
  ) => {
    const [{ parseServerConfig }, { startGameServer }] = await Promise.all([
      import('@/runtime/server-config'),
      import('@/app/start-game-server'),
    ]);
    return startGameServer({ config: parseServerConfig(process.env), reportUnexpected: reporter });
  },
): Promise<void> {
  let server: Pick<GameServer, 'url' | 'close'>;
  try {
    server = await start(diagnostics.reportUnexpected);
  } catch (error) {
    // The worker pool owns the original startup failure; this is its control result.
    if (
      !(error instanceof RollSimulationExecutorError) ||
      error.code !== ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE
    ) {
      reportUnexpected(diagnostics.reportUnexpected, error, 'startup');
    }
    console.error('Game server startup failed');
    process.exitCode = 1;
    await diagnostics.close();
    return;
  }
  console.log(`Game server listening at ${server.url}`);

  const shutdown = (): void => {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    void (async () => {
      try {
        await server.close();
        process.exitCode = 0;
      } catch (error) {
        reportUnexpected(diagnostics.reportUnexpected, error, 'shutdown');
        console.error('Game server shutdown failed');
        process.exitCode = 1;
      } finally {
        await diagnostics.close();
      }
    })();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (import.meta.main) {
  const diagnostics = await startServerDiagnostics(readServerDiagnosticsConfig(process.env));
  await runGameServerProcess(diagnostics);
}
