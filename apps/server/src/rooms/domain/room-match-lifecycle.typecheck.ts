import { markGameFinished } from '@/rooms/domain/room-match-lifecycle';
import type { FinishedRoom, PlayingRoom, Room } from '@/rooms/domain/room-model';

function playingSuccess(room: PlayingRoom): void {
  const result = markGameFinished(room, { finishedAt: 10_000 });
  if (result.ok) {
    const { changed }: { changed: true } = result;
    const { room: finished }: { room: FinishedRoom } = result;
    void changed;
    void finished;
  }
}

function generalSuccess(room: Room): void {
  const result = markGameFinished(room, { finishedAt: 10_000 });
  if (result.ok) {
    // A general room may already be finished and must retain its no-op result.
    // @ts-expect-error General room success does not guarantee a changed transition.
    const { changed }: { changed: true } = result;
    void changed;
  }
}

void playingSuccess;
void generalSuccess;
