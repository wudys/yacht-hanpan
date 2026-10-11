import { createServer, type Server as HttpServer } from 'node:http';

import { Server as SocketServer } from 'socket.io';

export interface CompatibilitySocketServer {
  url: string;
  close: () => Promise<void>;
}

export async function startCompatibilitySocketServer(
  port: number = 0,
): Promise<CompatibilitySocketServer> {
  const httpServer = createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, runtime: 'bun' }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const io = new SocketServer(httpServer, { serveClient: false });

  io.on('connection', (socket) => {
    socket.on(
      'compatibility:ping',
      (payload: { nonce: string }, acknowledge: (value: unknown) => void) => {
        acknowledge({ nonce: payload.nonce, runtime: 'bun' });
      },
    );
    socket.on(
      'compatibility:join',
      async (payload: { roomId: string }, acknowledge: (value: unknown) => void) => {
        await socket.join(payload.roomId);
        acknowledge({ joined: true });
      },
    );
    socket.on('compatibility:message', (payload: { roomId: string; value: string }) => {
      if (!socket.rooms.has(payload.roomId)) return;
      io.to(payload.roomId).emit('compatibility:message', payload);
    });
  });

  await listen(httpServer, port);
  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('Compatibility server did not expose a TCP address');
  }

  let closed: boolean = false;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      if (closed) return;
      closed = true;
      await io.close();
      if (httpServer.listening) await closeHttpServer(httpServer);
    },
  };
}

async function listen(server: HttpServer, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
