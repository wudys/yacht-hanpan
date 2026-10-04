export type PlayerAvatarProps = Readonly<{
  imageUrl?: string;
  alt: string;
  size?: 'sm' | 'md' | 'lg';
  winner?: boolean;
  selfLabel?: string;
}>;

export function PlayerAvatar({
  imageUrl,
  alt,
  size = 'md',
  winner = false,
  selfLabel,
}: PlayerAvatarProps) {
  return (
    <span className='player-avatar' data-avatar-size={size} data-winner={winner ? 'true' : 'false'}>
      {imageUrl ? <img src={imageUrl} alt={alt} /> : null}
      {selfLabel ? (
        <span className='player-avatar__self' role='img' aria-label={selfLabel} />
      ) : null}
    </span>
  );
}
