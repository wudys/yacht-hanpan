import {
  type ClientToServerEvents,
  GAME_SOCKET_PATH,
  type ServerToClientEvents,
  SOCKET_EVENT,
  type SocketAuth,
} from '@repo/game-protocol/socket';
import { io, type Socket } from 'socket.io-client';

import type { GameSocketFactory, RawGameSocket } from '../ports';

type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
const AUTHENTICATION_TIMEOUT_MS = 20_000;

const SOCKET_IO_CLIENT_EVENT = {
  CONNECT: 'connect',
  CONNECTION_ERROR: 'connect_error',
  DISCONNECT: 'disconnect',
} as const;

export const socketIoGameSocketFactory: GameSocketFactory = {
  create: ({ url, getAuth }) => createSocketIoGameSocket(url, getAuth),
};

export function createSocketIoGameSocket(url: string, getAuth: () => SocketAuth): RawGameSocket {
  const socket: GameSocket = io(url, {
    auth: (send) => send(getAuth()),
    autoConnect: false,
    path: GAME_SOCKET_PATH,
    reconnection: true,
    transports: ['websocket'],
  });
  let cancelConnection: (() => void) | null = null;

  return {
    connect: () =>
      new Promise<void>((resolve, reject) => {
        if (socket.connected) {
          resolve();
          return;
        }
        let settled = false;
        let finish: (error: unknown) => void = () => {};
        const onError = (error: Error): void => finish(connectionErrorData(error));
        const onConnect = (): void => finish(null);
        const timeout = setTimeout(() => {
          finish(new Error('Socket authentication timed out'));
          socket.disconnect();
        }, AUTHENTICATION_TIMEOUT_MS);
        finish = (error: unknown): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          cancelConnection = null;
          socket.off(SOCKET_IO_CLIENT_EVENT.CONNECT, onConnect);
          socket.off(SOCKET_IO_CLIENT_EVENT.CONNECTION_ERROR, onError);
          if (error === null) resolve();
          else reject(error);
        };
        cancelConnection = () => finish(new Error('Socket connection cancelled'));
        socket.once(SOCKET_IO_CLIENT_EVENT.CONNECT, onConnect);
        socket.once(SOCKET_IO_CLIENT_EVENT.CONNECTION_ERROR, onError);
        socket.connect();
      }),
    disconnect: () => {
      cancelConnection?.();
      socket.disconnect();
    },
    dispose: () => {
      cancelConnection?.();
      socket.removeAllListeners();
      socket.close();
    },
    emitCommand: (command, acknowledge) => {
      socket.emit(SOCKET_EVENT.GAME_COMMAND, command, acknowledge);
    },
    emitSync: (acknowledge) => {
      socket.emit(SOCKET_EVENT.GAME_SYNC, acknowledge);
    },
    onConnected: (listener) => {
      socket.on(SOCKET_IO_CLIENT_EVENT.CONNECT, listener);
      return () => socket.off(SOCKET_IO_CLIENT_EVENT.CONNECT, listener);
    },
    onConnectionError: (listener) => {
      const handler = (error: Error): void => listener(connectionErrorData(error));
      socket.on(SOCKET_IO_CLIENT_EVENT.CONNECTION_ERROR, handler);
      return () => socket.off(SOCKET_IO_CLIENT_EVENT.CONNECTION_ERROR, handler);
    },
    onReplaced: (listener) => {
      socket.on(SOCKET_EVENT.SESSION_REPLACED, listener);
      return () => socket.off(SOCKET_EVENT.SESSION_REPLACED, listener);
    },
    onDisconnected: (listener) => {
      socket.on(SOCKET_IO_CLIENT_EVENT.DISCONNECT, listener);
      return () => socket.off(SOCKET_IO_CLIENT_EVENT.DISCONNECT, listener);
    },
    onRoomUpdate: (listener) => {
      socket.on(SOCKET_EVENT.ROOM_STATE, listener);
      return () => socket.off(SOCKET_EVENT.ROOM_STATE, listener);
    },
  };
}

function connectionErrorData(error: Error): unknown {
  return 'data' in error ? (error as Error & { readonly data?: unknown }).data : error;
}
