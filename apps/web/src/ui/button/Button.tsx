import type { ReactNode } from 'react';

export type ButtonProps = Readonly<{
  label: string;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  interactionLocked?: boolean;
  progress?: ReactNode;
  onClick?: () => void;
}>;

export function Button({
  label,
  variant = 'primary',
  disabled = false,
  interactionLocked = false,
  progress,
  onClick,
}: ButtonProps) {
  const activate = () => {
    if (!disabled && !interactionLocked) onClick?.();
  };

  return (
    <button
      className='ui-button'
      type='button'
      data-variant={variant}
      data-interaction-locked={!disabled && interactionLocked ? 'true' : 'false'}
      disabled={disabled}
      aria-disabled={disabled || interactionLocked}
      onClick={activate}
    >
      <span className='ui-button__label'>{progress ?? label}</span>
    </button>
  );
}
