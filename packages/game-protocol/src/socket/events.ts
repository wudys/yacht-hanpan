import * as v from 'valibot';

import { parseWith } from '../internal/parse';
import type { DeepReadonly } from '../internal/readonly';
import { roomViewSchema } from '../state/room-view';
import type { CommandAck, SyncAck } from './acks';
import type { GameCommand } from './commands';
import { resolvedRollArtifactSchema, rollMatchesGameSnapshot } from './roll-artifact';

export const GAME_SOCKET_PATH = '/game-socket' as const;

export const SOCKET_EVENT = {
  GAME_COMMAND: 'game:command',
  GAME_SYNC: 'game:sync',
  ROOM_STATE: 'room:state',
  SESSION_REPLACED: 'session:replaced',
} as const;

export const ROOM_UPDATE_TYPE = {
  STATE_COMMITTED: 'state:committed',
  ROLL_COMMITTED: 'roll:committed',
} as const;

const updateIdentityEntries = {
  view: roomViewSchema,
} as const;

const committedRoomUpdateSchema = v.variant('type', [
  v.strictObject({ type: v.literal(ROOM_UPDATE_TYPE.STATE_COMMITTED), ...updateIdentityEntries }),
  v.pipe(
    v.strictObject({
      type: v.literal(ROOM_UPDATE_TYPE.ROLL_COMMITTED),
      ...updateIdentityEntries,
      roll: resolvedRollArtifactSchema,
    }),
    v.check(({ view, roll }) => rollMatchesGameSnapshot(view.game, roll)),
  ),
]);

export type CommittedRoomUpdate = DeepReadonly<v.InferOutput<typeof committedRoomUpdateSchema>>;

export const parseCommittedRoomUpdate = (value: unknown): CommittedRoomUpdate =>
  parseWith(committedRoomUpdateSchema, value);

export interface ClientToServerEvents {
  [SOCKET_EVENT.GAME_COMMAND]: (
    command: GameCommand,
    acknowledge: (response: CommandAck) => void,
  ) => void;
  [SOCKET_EVENT.GAME_SYNC]: (acknowledge: (response: SyncAck) => void) => void;
}

export interface ServerToClientEvents {
  [SOCKET_EVENT.SESSION_REPLACED]: () => void;
  [SOCKET_EVENT.ROOM_STATE]: (update: CommittedRoomUpdate) => void;
}
