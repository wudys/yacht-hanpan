import { requireGameAsset } from '@repo/game-assets';

export function BrandLockup() {
  return (
    <span className='brand-lockup'>
      <img className='brand-lockup__ci' src={requireGameAsset('brand.ci.flat').url} alt='' />
      <img
        className='brand-lockup__logo'
        src={requireGameAsset('brand.logo').url}
        alt='Yacht Hanpan'
      />
    </span>
  );
}
