import type { GameSession } from './session';

export function assertSnapshotIsBorrowed(session: GameSession): void {
  const snapshot = session.getSnapshot();
  if (snapshot.room) {
    // @ts-expect-error A borrowed room profile cannot be changed by a subscriber.
    snapshot.room.seats[0].profile.variant = true;
    // @ts-expect-error A borrowed seat tuple cannot be reordered.
    snapshot.room.seats.reverse();
  }
  if (snapshot.presence) {
    // @ts-expect-error Presence versions are owned by the session.
    snapshot.presence.presenceVersion++;
    // @ts-expect-error Presence seats are borrowed nested values.
    snapshot.presence.seats[0].status = 'connected';
  }
  if (snapshot.game) {
    // @ts-expect-error Versions are authoritative and cannot be incremented by a subscriber.
    snapshot.game.stateVersion++;
    // @ts-expect-error A scorecard is a borrowed nested object.
    snapshot.game.match.players[0].scorecard.ones = 5;
    if (snapshot.game.match.status === 'playing') {
      // @ts-expect-error Held slots cannot be changed through the snapshot.
      snapshot.game.match.currentTurn.heldSlots.reverse();
      if (snapshot.game.match.currentTurn.dice) {
        // @ts-expect-error A die is borrowed even inside a tuple.
        snapshot.game.match.currentTurn.dice[0].value = 6;
      }
    }
  }
  if (snapshot.presentation?.kind === 'roll') {
    // @ts-expect-error Presentation state is owned by the session.
    snapshot.presentation.kind = 'roll';
    // @ts-expect-error Replay slots cannot be changed through the snapshot.
    snapshot.presentation.roll.replay.rolledSlots.reverse();
    // @ts-expect-error Authoritative outcomes are nested borrowed values.
    snapshot.presentation.roll.outcome.authoritativeValuesBySlot[0]!.value = 6;
  }
  if (snapshot.presentation?.kind === 'score') {
    // @ts-expect-error Accepted score facts cannot be changed by a subscriber.
    snapshot.presentation.record.score = 50;
    // @ts-expect-error A score record belongs to its authoritative version.
    snapshot.presentation.record.stateVersion++;
  }
  if (snapshot.presentation?.kind === 'turn') {
    const { turnId } = snapshot.presentation;
    // @ts-expect-error A fresh turn identity is owned by the session.
    snapshot.presentation.turnId = turnId;
  }
}

export async function assertReceiptIsBorrowed(session: GameSession): Promise<void> {
  const result = await session.rollDice();
  if (!result.ok) return;
  // @ts-expect-error The original receipt version cannot be changed by its consumer.
  result.data.stateVersion++;
  if ('roll' in result.data) {
    // @ts-expect-error The original roll receipt shares the readonly artifact contract.
    result.data.roll.replay.rolledSlots.reverse();
  }
}
