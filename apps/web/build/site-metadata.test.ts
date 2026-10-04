import { expect, it } from 'vitest';

import { createSiteMetadata } from './site-metadata';

it('uses the configured public origin for crawler-visible image and canonical URLs', () => {
  const tags = createSiteMetadata('https://yacht.example.com');
  const ogImage = tags.find((tag) => tag.attrs?.property === 'og:image');
  const twitterImage = tags.find((tag) => tag.attrs?.name === 'twitter:image');
  expect(ogImage?.attrs?.content).toMatch(/^https:\/\/yacht\.example\.com\/assets\/.+\.png$/u);
  expect(twitterImage?.attrs?.content).toBe(ogImage?.attrs?.content);
  expect(tags.find((tag) => tag.attrs?.property === 'og:url')?.attrs?.content).toBe(
    'https://yacht.example.com/',
  );
  expect(tags.find((tag) => tag.attrs?.rel === 'canonical')?.attrs?.href).toBe(
    'https://yacht.example.com/',
  );
});

it('keeps local asset URLs without publishing an invented or invalid canonical origin', () => {
  for (const origin of ['', 'http://localhost:3001', 'https://yacht.example.com/path']) {
    const tags = createSiteMetadata(origin);
    expect(tags.find((tag) => tag.attrs?.property === 'og:image')?.attrs?.content).toMatch(
      /^\/assets\/.+\.png$/u,
    );
    expect(tags.some((tag) => tag.attrs?.rel === 'canonical')).toBe(false);
    expect(tags.some((tag) => tag.attrs?.property === 'og:url')).toBe(false);
  }
});
