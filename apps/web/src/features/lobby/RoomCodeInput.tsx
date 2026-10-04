import { useLayoutEffect, useRef, useState } from 'react';

import type { LobbyError } from '@/features/lobby/lobby-errors';
import { normalizeRoomCode, ROOM_CODE_LENGTH } from '@/features/lobby/room-code';

type RoomCodeInputProps = Readonly<{
  code: string;
  label: string;
  error: LobbyError | null;
  joining: boolean;
  onCodeChange: (code: string) => void;
  onCodeFocus: () => void;
}>;

export function RoomCodeInput({
  code,
  label,
  error,
  joining,
  onCodeChange,
  onCodeFocus,
}: RoomCodeInputProps) {
  const joinInputRef = useRef<HTMLInputElement | null>(null);
  const [codeCaretPosition, setCodeCaretPosition] = useState(0);
  const [pendingCodeCaret, setPendingCodeCaret] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (pendingCodeCaret === null) return;
    const input = joinInputRef.current;
    if (!input) return;
    const caret = Math.min(pendingCodeCaret, input.value.length);
    input.setSelectionRange(caret, caret);
    setCodeCaretPosition(caret);
    setPendingCodeCaret(null);
  }, [pendingCodeCaret, code]);

  return (
    <>
      <label htmlFor='lobby-room-code'>{label}</label>
      <div className='web-lobby-code-entry' data-code-length={code.length}>
        <input
          ref={joinInputRef}
          id='lobby-room-code'
          type='text'
          inputMode='numeric'
          pattern='[0-9]*'
          maxLength={ROOM_CODE_LENGTH}
          autoComplete='one-time-code'
          value={code}
          readOnly={joining}
          aria-describedby={error ? 'lobby-code-error' : undefined}
          aria-invalid={error && error.kind !== 'rate-limited' ? true : undefined}
          onFocus={onCodeFocus}
          onChange={(event) => {
            onCodeChange(event.currentTarget.value);
            setCodeCaretPosition(event.currentTarget.selectionStart ?? 0);
          }}
          onSelect={(event) => setCodeCaretPosition(event.currentTarget.selectionStart ?? 0)}
          onPaste={(event) => {
            if (joining) return;
            // Apply normalized clipboard text while preserving the replacement selection.
            event.preventDefault();
            const input = event.currentTarget;
            const start = input.selectionStart ?? input.value.length;
            const end = input.selectionEnd ?? start;
            const pasted = event.clipboardData.getData('text');
            const nextCode = normalizeRoomCode(
              `${input.value.slice(0, start)}${pasted}${input.value.slice(end)}`,
            );
            setPendingCodeCaret(
              Math.min(
                normalizeRoomCode(`${input.value.slice(0, start)}${pasted}`).length,
                nextCode.length,
              ),
            );
            onCodeChange(nextCode);
          }}
        />
        <div className='web-lobby-code-cells' aria-hidden='true'>
          {Array.from({ length: ROOM_CODE_LENGTH }, (_, index) => (
            <span
              data-active-cell={
                Math.min(codeCaretPosition, ROOM_CODE_LENGTH - 1) === index ? 'true' : 'false'
              }
              data-caret-end={
                codeCaretPosition === ROOM_CODE_LENGTH && index === ROOM_CODE_LENGTH - 1
                  ? 'true'
                  : undefined
              }
              key={index}
            >
              {code[index] ?? ''}
            </span>
          ))}
        </div>
      </div>
    </>
  );
}
