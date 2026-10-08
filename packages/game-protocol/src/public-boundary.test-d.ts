import type * as Root from '@repo/game-protocol';
import type {
  GameSnapshot,
  GameSnapshotInput,
  PresenceSnapshot,
  PresenceSnapshotInput,
  PublicRoom,
  PublicRoomInput,
  RoomView,
  RoomViewInput,
} from '@repo/game-protocol/state';

// Raw schema objects are implementation details; consumers receive parsers and inferred DTO types.
// @ts-expect-error raw command schemas are intentionally absent from the public Socket entry.
type GameCommandSchema = typeof import('@repo/game-protocol/socket').gameCommandSchema;
type ResolvedRollArtifactSchema =
  // @ts-expect-error raw artifact schemas are intentionally absent from the public Socket entry.
  typeof import('@repo/game-protocol/socket').resolvedRollArtifactSchema;

// @ts-expect-error raw room schemas are intentionally absent from the public State entry.
type PublicRoomSchema = typeof import('@repo/game-protocol/state').publicRoomSchema;
// @ts-expect-error raw presence schemas are intentionally absent from the public State entry.
type PresenceSnapshotSchema = typeof import('@repo/game-protocol/state').presenceSnapshotSchema;
// @ts-expect-error raw game schemas are intentionally absent from the public State entry.
type GameSnapshotSchema = typeof import('@repo/game-protocol/state').gameSnapshotSchema;
// @ts-expect-error raw view schemas are intentionally absent from the public State entry.
type RoomViewSchema = typeof import('@repo/game-protocol/state').roomViewSchema;
// @ts-expect-error raw view schemas are intentionally absent from the public root entry.
type RootRoomViewSchema = typeof import('@repo/game-protocol').roomViewSchema;

export type PublicStateDtoCheck = [
  GameSnapshot,
  GameSnapshotInput,
  PresenceSnapshot,
  PresenceSnapshotInput,
  PublicRoom,
  PublicRoomInput,
  RoomView,
  RoomViewInput,
];

export type RootSocketDtoCheck = [
  Root.ClientToServerEvents,
  Root.CommandAck,
  Root.CommandReceipt,
  Root.CommittedRoomUpdate,
  Root.GameCommand,
  Root.ResolvedRollArtifact,
  Root.ServerToClientEvents,
  Root.SocketAuth,
  Root.SocketConnectionFailure,
  Root.SyncAck,
];

export type PublicSchemaLeakCheck = [
  GameCommandSchema,
  ResolvedRollArtifactSchema,
  PublicRoomSchema,
  PresenceSnapshotSchema,
  GameSnapshotSchema,
  RoomViewSchema,
  RootRoomViewSchema,
];
