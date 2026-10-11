import type { RoomTaskQueue } from '@/rooms/application/scheduling/room-task-queue';
import type { TaskScheduler } from '@/runtime/task-scheduler';

export function closeRoomApplicationResources(
  queue: RoomTaskQueue | null,
  tasks: TaskScheduler | null,
): void {
  const errors: unknown[] = [];
  try {
    queue?.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    tasks?.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Room application cleanup failed');
}
