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

// @ts-expect-error Common state DTOs are exposed through State, not Socket.
type SocketGameSnapshot = import('@repo/game-protocol/socket').GameSnapshot;
// @ts-expect-error Common state DTO inputs are exposed through State, not Socket.
type SocketGameSnapshotInput = import('@repo/game-protocol/socket').GameSnapshotInput;
// @ts-expect-error Common state DTOs are exposed through State, not Socket.
type SocketPresenceSnapshot = import('@repo/game-protocol/socket').PresenceSnapshot;
// @ts-expect-error Common state DTO inputs are exposed through State, not Socket.
type SocketPresenceSnapshotInput = import('@repo/game-protocol/socket').PresenceSnapshotInput;
// @ts-expect-error Common state DTOs are exposed through State, not Socket.
type SocketPublicRoom = import('@repo/game-protocol/socket').PublicRoom;
// @ts-expect-error Common state DTO inputs are exposed through State, not Socket.
type SocketPublicRoomInput = import('@repo/game-protocol/socket').PublicRoomInput;
// @ts-expect-error Common state DTOs are exposed through State, not Socket.
type SocketRoomView = import('@repo/game-protocol/socket').RoomView;
// @ts-expect-error Common state DTO inputs are exposed through State, not Socket.
type SocketRoomViewInput = import('@repo/game-protocol/socket').RoomViewInput;

export type SocketStateDtoLeakCheck = [
  SocketGameSnapshot,
  SocketGameSnapshotInput,
  SocketPresenceSnapshot,
  SocketPresenceSnapshotInput,
  SocketPublicRoom,
  SocketPublicRoomInput,
  SocketRoomView,
  SocketRoomViewInput,
];

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
