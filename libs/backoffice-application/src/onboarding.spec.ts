/**
 * Unit test của quyết định gate onboarding (`onboarding.ts`) —
 * logic thuần, không mock gì.
 */

import { describe, expect, it } from 'vitest';

import { needsDisplayName } from './onboarding';

const SUB = 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'sub_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('needsDisplayName', () => {
  it('is true when the sub is absent from the batch', () => {
    expect(needsDisplayName([{ sub: OTHER, displayName: 'X' }], SUB)).toBe(true);
  });

  it('is true when the sub has a null displayName', () => {
    expect(needsDisplayName([{ sub: SUB, displayName: null }], SUB)).toBe(true);
  });

  it('is false when the sub has a display name', () => {
    expect(needsDisplayName([{ sub: SUB, displayName: 'Nguyễn Văn A' }], SUB)).toBe(false);
  });

  it('is true for an empty batch', () => {
    expect(needsDisplayName([], SUB)).toBe(true);
  });

  it('matches the exact sub, not a prefix or suffix', () => {
    const profiles = [{ sub: SUB, displayName: 'X' }];
    expect(needsDisplayName(profiles, `${SUB}b`)).toBe(true);
  });
});
