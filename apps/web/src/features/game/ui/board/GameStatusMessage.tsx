export function GameStatusMessage({ message }: Readonly<{ message?: string }>) {
  return (
    <span className='game-board__presence' role={message ? 'status' : undefined}>
      {message}
    </span>
  );
}
