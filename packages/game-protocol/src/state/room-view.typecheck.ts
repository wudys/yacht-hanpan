import type {
  GameSnapshotInput,
  parseGameSnapshot,
  parsePresenceSnapshot,
  parsePublicRoom,
  parseRoomView,
  PresenceSnapshotInput,
  PublicRoomInput,
} from '@repo/game-protocol/state';

// Producers can build and revise inputs before publishing the parsed read-only output.
export function buildPublicState(
  room: PublicRoomInput,
  game: GameSnapshotInput,
  presence: PresenceSnapshotInput,
): void {
  room.seats[0].profile.variant = true;
  game.stateVersion += 1;
  game.match.players[0].timeoutCount = 2;
  // @ts-expect-error Public timeout counts stop at the second cumulative timeout.
  game.match.players[0].timeoutCount = 3;
  game.match.players[0].scorecard.ones = 5;
  presence.presenceVersion += 1;
  if (game.match.status === 'playing' && game.match.currentTurn.rollCount !== 0) {
    game.match.currentTurn.heldSlots.push(0);
    game.match.currentTurn.dice[0].value = 6;
  }
}

// Parsed views preserve nested immutability without freezing producer inputs at runtime.
export function checkParsedPublicState(
  room: ReturnType<typeof parsePublicRoom>,
  game: ReturnType<typeof parseGameSnapshot>,
  presence: ReturnType<typeof parsePresenceSnapshot>,
  view: ReturnType<typeof parseRoomView>,
): void {
  // @ts-expect-error Parsed room seat tuples are read-only.
  room.seats[0] = { profile: { characterId: 'navy-bob', variant: false } };
  // @ts-expect-error Parsed seat profiles are read-only.
  room.seats[0].profile.variant = true;
  // @ts-expect-error Parsed match player tuples are read-only.
  game.match.players[0] = { scorecard: {}, timeoutCount: 0 };
  // @ts-expect-error Parsed player scorecards are read-only.
  game.match.players[0].scorecard.ones = 5;
  if (game.match.status === 'playing' && game.match.currentTurn.rollCount !== 0) {
    // @ts-expect-error Parsed ordered hold membership is read-only.
    game.match.currentTurn.heldSlots.push(0);
    // @ts-expect-error Parsed dice tuples are read-only.
    game.match.currentTurn.dice[0] = { value: 6 };
    // @ts-expect-error Parsed dice values are read-only.
    game.match.currentTurn.dice[0].value = 6;
  }
  if (presence.seats[0].status === 'disconnected') {
    // @ts-expect-error Parsed reconnect deadlines are read-only.
    presence.seats[0].reconnectDeadlineAt = null;
  }
  // @ts-expect-error Parsed presence seat tuples are read-only.
  presence.seats[0] = { status: 'connected' };
  // @ts-expect-error A complete parsed view retains read-only nested room data.
  view.room.seats[0].profile.variant = true;
  // @ts-expect-error A complete parsed view retains read-only nested presence data.
  view.presence.seats[0] = { status: 'connected' };
  if (view.game !== null) {
    // @ts-expect-error A complete parsed view retains read-only nested game data.
    view.game.match.players[0].scorecard.ones = 5;
  }
}
