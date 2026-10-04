import { GAME_ASSET_MANIFEST } from '@repo/game-assets/manifest';
import type { HtmlTagDescriptor } from 'vite';

import { isPublicHttpsOrigin } from '../src/bootstrap/public-origin.ts'; // eslint-disable-line import-x/extensions -- Also loaded by the native Vite config.

export function createSiteMetadata(productionOrigin: string): HtmlTagDescriptor[] {
  const title = '요트 한판 - Yacht Hanpan';
  const description = '설치 없이 바로 즐기는 1:1 요트 주사위 게임';
  const image = GAME_ASSET_MANIFEST.find((asset) => asset.id === 'brand.social-card')!;
  const favicon = GAME_ASSET_MANIFEST.find((asset) => asset.id === 'brand.favicon')!;
  const origin = isPublicHttpsOrigin(productionOrigin) ? productionOrigin : '';
  const imageUrl = `${origin}${image.url}`;
  const meta = (key: string, content: string): HtmlTagDescriptor => ({
    tag: 'meta',
    attrs: { [key.startsWith('og:') ? 'property' : 'name']: key, content },
    injectTo: 'head',
  });

  return [
    { tag: 'title', children: title, injectTo: 'head' },
    {
      tag: 'link',
      attrs: { rel: 'icon', type: favicon.mime, href: favicon.url },
      injectTo: 'head',
    },
    meta('description', description),
    meta('og:type', 'website'),
    meta('og:site_name', '요트 한판'),
    meta('og:locale', 'ko_KR'),
    meta('og:title', title),
    meta('og:description', description),
    meta('og:image', imageUrl),
    meta('og:image:type', image.mime),
    meta('og:image:width', String(image.width)),
    meta('og:image:height', String(image.height)),
    meta('og:image:alt', title),
    meta('twitter:card', 'summary_large_image'),
    meta('twitter:title', title),
    meta('twitter:description', description),
    meta('twitter:image', imageUrl),
    meta('twitter:image:alt', title),
    ...(origin
      ? [
          meta('og:url', `${origin}/`),
          {
            tag: 'link',
            attrs: { rel: 'canonical', href: `${origin}/` },
            injectTo: 'head' as const,
          },
        ]
      : []),
  ];
}
