import type { Server as HttpServer } from 'node:http';

interface GameServerResources {
  readonly telemetry?: { close(): void } | null;
  readonly rooms?: { close(): void } | null;
  readonly socketServer?: { close(): Promise<void> } | null;
  readonly httpServer?: HttpServer | null;
  readonly rollSimulation?: { close(): Promise<void> } | null;
}

export async function closeGameServerResources(resources: GameServerResources): Promise<void> {
  const errors: unknown[] = [];
  try {
    resources.telemetry?.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    resources.rooms?.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await resources.socketServer?.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    if (resources.httpServer?.listening) {
      const server = resources.httpServer;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    await resources.rollSimulation?.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Game server cleanup failed');
}
