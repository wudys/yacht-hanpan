import { useState } from 'react';

export type TurnCueFeedback = Readonly<{ identity: string; startedAt: number }>;

export function TurnStartCue({ cue, label }: Readonly<{ cue: TurnCueFeedback; label: string }>) {
  const [elapsed] = useState(() => Math.max(0, performance.now() - cue.startedAt));
  if (elapsed >= 650) return null;
  return (
    <>
      <div
        className='game-turn-cue'
        data-turn-cue='true'
        aria-hidden='true'
        style={{ animationDelay: `${-elapsed}ms` }}
      >
        <i />
        <span>YOUR TURN</span>
        <i />
      </div>
      <span className='game-turn-cue__accessible' role='status'>
        {label}
      </span>
    </>
  );
}
