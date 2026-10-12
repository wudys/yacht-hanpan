import { useEffect, useRef, useState } from 'react';

import type { LobbyPhase } from '@/features/lobby/lobby-state';
import type { WaitingRoomSummary } from '@/runtime/room-access/room-access';

export type CopyStatus = 'idle' | 'copied' | 'failed';

export function useRoomCodeClipboard(
  phase: LobbyPhase,
  waitingRoom: WaitingRoomSummary | null,
  onCopied: () => void,
) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempt = useRef(0);
  const [status, setStatus] = useState<CopyStatus>('idle');

  useEffect(() => {
    attempt.current += 1;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setStatus('idle');
    return () => {
      attempt.current += 1;
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [phase, waitingRoom?.expiresAt, waitingRoom?.roomCode]);

  async function copy() {
    if (!waitingRoom || phase !== 'waiting') return;
    const currentAttempt = ++attempt.current;
    try {
      await navigator.clipboard.writeText(waitingRoom.roomCode);
      if (attempt.current !== currentAttempt) return;
      setStatus('copied');
      onCopied();
    } catch {
      if (attempt.current !== currentAttempt) return;
      setStatus('failed');
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (attempt.current !== currentAttempt) return;
      timer.current = null;
      setStatus('idle');
    }, 1_200);
  }

  return { status, copy };
}
