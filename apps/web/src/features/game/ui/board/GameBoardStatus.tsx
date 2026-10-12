export function GameTimer({ label, warning }: Readonly<{ label: string; warning: boolean }>) {
  return (
    <strong className='game-board__timer' data-timer-warning={warning}>
      {label}
    </strong>
  );
}

export function GameStatusMessage({ message }: Readonly<{ message?: string }>) {
  return (
    <span className='game-board__presence' role={message ? 'status' : undefined}>
      {message}
    </span>
  );
}
