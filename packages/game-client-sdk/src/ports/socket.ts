import type { GameCommand, SocketAuth } from '@repo/game-protocol/socket';

export interface RawGameSocket {
  // Fulfillment confirms transport authentication; callbacks may occur before or after it.
  readonly connect: () => Promise<void>;
  // Explicit shutdown need not emit onDisconnected; the session owns its local postcondition.
  readonly disconnect: () => void;
  readonly dispose: () => void;
  readonly emitCommand: (command: GameCommand, acknowledge: (value: unknown) => void) => void;
  readonly emitSync: (acknowledge: (value: unknown) => void) => void;
  readonly onConnected: (listener: () => void) => () => void;
  readonly onConnectionError: (listener: (value: unknown) => void) => () => void;
  readonly onReplaced: (listener: () => void) => () => void;
  readonly onDisconnected: (listener: () => void) => () => void;
  readonly onRoomUpdate: (listener: (value: unknown) => void) => () => void;
}

export interface GameSocketFactory {
  readonly create: (options: {
    readonly url: string;
    readonly getAuth: () => SocketAuth;
  }) => RawGameSocket;
}
