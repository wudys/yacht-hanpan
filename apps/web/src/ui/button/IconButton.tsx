import type { ReactNode } from 'react';

export type IconButtonProps = Readonly<{
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  interactionLocked?: boolean;
  onClick?: () => void;
}>;

export function IconButton({
  label,
  icon,
  disabled = false,
  interactionLocked = false,
  onClick,
}: IconButtonProps) {
  return (
    <button
      className='ui-icon-button'
      type='button'
      aria-label={label}
      aria-disabled={disabled || interactionLocked}
      disabled={disabled}
      data-interaction-locked={!disabled && interactionLocked ? 'true' : 'false'}
      onClick={() => {
        if (!disabled && !interactionLocked) onClick?.();
      }}
    >
      <span className='ui-icon-button__surface' aria-hidden='true'>
        {icon}
      </span>
    </button>
  );
}
