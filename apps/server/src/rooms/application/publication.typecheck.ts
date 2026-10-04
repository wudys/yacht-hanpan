import type { RoomStatePublisher } from '@/rooms/application/room-state-committer';

export function checkSynchronousPublication(asyncPublisher: () => Promise<undefined>): void {
  // @ts-expect-error A room commit must publish synchronously before its queue operation releases.
  const publisher: RoomStatePublisher = asyncPublisher;
  void publisher;
}
