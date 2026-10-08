export function GameTimer({ label, warning }: Readonly<{ label: string; warning: boolean }>) {
  return (
    <strong className='game-board__timer' data-timer-warning={warning}>
      {label}
    </strong>
  );
}
