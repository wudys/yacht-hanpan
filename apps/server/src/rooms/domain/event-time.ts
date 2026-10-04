export interface RoomCommandTime {
  readonly source: 'command';
  readonly effectiveAt: number;
  readonly priority: 'gameplay' | 'forfeit';
}

interface RoomDeadlineTime {
  readonly source: 'deadline';
  readonly effectiveAt: number;
}

export type RoomEventTime = RoomCommandTime | RoomDeadlineTime;

export function deadlineTime(checkedAt: number): RoomDeadlineTime {
  return { source: 'deadline', effectiveAt: checkedAt };
}

export function commandMayPrecede(
  current: RoomCommandTime,
  queued: RoomCommandTime | undefined,
): boolean {
  return (
    current.priority === 'gameplay' &&
    queued?.priority === 'forfeit' &&
    current.effectiveAt === queued.effectiveAt
  );
}

export function commandWakeAt(command: RoomCommandTime, checkedAt: number): number | null {
  return command.priority === 'forfeit' && !isReceiptGroupClosed(command.effectiveAt, checkedAt)
    ? receiptGroupWakeAt(command.effectiveAt)
    : null;
}

// All commands captured in this millisecond can enter before its lower-priority ending.
export function receiptGroupWakeAt(effectiveAt: number): number {
  return effectiveAt + 1;
}

export function isReceiptGroupClosed(effectiveAt: number, checkedAt: number): boolean {
  return checkedAt > effectiveAt;
}

export function reconnectDeadlineIsDue(time: RoomEventTime, deadlineAt: number): boolean {
  // Commands leave equality open; deadline adjudication closes it after receipt admission.
  return time.source === 'command' ? deadlineAt < time.effectiveAt : deadlineAt <= time.effectiveAt;
}
