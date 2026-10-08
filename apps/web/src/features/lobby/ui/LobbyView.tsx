import { requireGameAsset } from '@repo/game-assets';
import type { ReactNode } from 'react';

import { BrandLockup } from '@/ui/brand';
import { Button, IconButton } from '@/ui/button';
import { PlayerAvatar } from '@/ui/profile';

export type LobbyViewProps = Readonly<{
  profile: Readonly<{ imageUrl: string; alt: string }>;
  labels: Readonly<{
    editProfile: string;
    settings: string;
    createRoom: string;
    joinRoom: string;
  }>;
  interactionLocked?: boolean;
  hideRoomActions?: boolean;
  createProgress?: ReactNode;
  onEditProfile?: () => void;
  onOpenSettings?: () => void;
  onCreateRoom?: () => void;
  onJoinRoom?: () => void;
}>;

export function LobbyView({
  profile,
  labels,
  interactionLocked = false,
  hideRoomActions = false,
  createProgress,
  onEditProfile,
  onOpenSettings,
  onCreateRoom,
  onJoinRoom,
}: LobbyViewProps) {
  return (
    <main className='lobby-view' data-product-view='lobby' inert={interactionLocked || undefined}>
      <div className='lobby-view__utility'>
        <div className='lobby-view__profile'>
          <IconButton
            label={labels.editProfile}
            icon={<PlayerAvatar imageUrl={profile.imageUrl} alt={profile.alt} size='sm' />}
            interactionLocked={interactionLocked}
            onClick={onEditProfile}
          />
        </div>
        <IconButton
          label={labels.settings}
          icon={<img src={requireGameAsset('ui.settings').url} alt='' />}
          interactionLocked={interactionLocked}
          onClick={onOpenSettings}
        />
      </div>
      <div className='lobby-view__brand'>
        <BrandLockup />
      </div>
      <div className='lobby-view__actions' data-hidden={hideRoomActions || undefined}>
        <div data-room-action='create'>
          <Button
            label={labels.createRoom}
            progress={createProgress}
            interactionLocked={interactionLocked}
            onClick={onCreateRoom}
          />
        </div>
        <div data-room-action='join'>
          <Button
            label={labels.joinRoom}
            variant='secondary'
            interactionLocked={interactionLocked}
            onClick={onJoinRoom}
          />
        </div>
      </div>
    </main>
  );
}
