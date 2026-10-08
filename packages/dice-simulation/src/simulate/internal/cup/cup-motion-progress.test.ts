import { describe, expect, it } from 'bun:test';

import { cupPourProgress } from './cup-motion-progress';

describe('cup motion progress', () => {
  it('uses a bounded pour rotation clock', () => {
    expect(cupPourProgress(799, 800, 1080)).toBe(0);
    expect(cupPourProgress(870, 800, 1080)).toBe(0.25);
    expect(cupPourProgress(940, 800, 1080)).toBe(0.5);
    expect(cupPourProgress(1080, 800, 1080)).toBe(1);
  });
});
