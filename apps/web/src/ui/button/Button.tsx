import type { ReactNode } from 'react';

export type ButtonProps = Readonly<{
  label: string;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  interactionLocked?: boolean;
  progress?: ReactNode;
  busy?: boolean;
  preserveLabelOnProgress?: boolean;
  onClick?: () => void;
}>;

export function Button({
  label,
  variant = 'primary',
  disabled = false,
  interactionLocked = false,
  progress,
  busy = false,
  preserveLabelOnProgress = false,
  onClick,
}: ButtonProps) {
  const showProgress = preserveLabelOnProgress && progress !== null && progress !== undefined;
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
      aria-busy={busy || showProgress || undefined}
      onClick={activate}
    >
      <span className='ui-button__label'>
        {preserveLabelOnProgress ? label : (progress ?? label)}
      </span>
      {showProgress ? (
        <span className='ui-button__progress' aria-hidden='true'>
          {progress}
        </span>
      ) : null}
    </button>
  );
}
