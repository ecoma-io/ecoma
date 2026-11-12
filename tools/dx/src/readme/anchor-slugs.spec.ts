import { describe, expect, it } from 'vitest';

import { headingSlugs } from './anchor-slugs.js';
import type { HeadingInfo } from './markdown-ast-types.js';

const heading = (depth: HeadingInfo['depth'], text: string, line: number): HeadingInfo => ({
  depth,
  text,
  line,
  endLine: line,
});

describe('headingSlugs', () => {
  it('lowercases and turns spaces into hyphens', () => {
    expect(headingSlugs([heading(1, 'Purpose', 1)])).toEqual(new Set(['purpose']));
  });

  it('keeps Vietnamese diacritics instead of folding them', () => {
    expect(headingSlugs([heading(2, 'Thành phần phụ thuộc', 1)])).toEqual(
      new Set(['thành-phần-phụ-thuộc']),
    );
  });

  it('strips surrounding punctuation but keeps internal hyphens', () => {
    expect(headingSlugs([heading(2, 'Related Documentation!', 1)])).toEqual(
      new Set(['related-documentation']),
    );
  });

  it('numbers duplicate headings in document order', () => {
    expect(
      headingSlugs([heading(2, 'Testing', 3), heading(2, 'Testing', 7), heading(2, 'Testing', 11)]),
    ).toEqual(new Set(['testing', 'testing-1', 'testing-2']));
  });

  it('numbering restarts for a different document', () => {
    expect(headingSlugs([heading(2, 'Testing', 1)])).toEqual(new Set(['testing']));
    expect(headingSlugs([heading(2, 'Testing', 1), heading(2, 'Testing', 2)])).toEqual(
      new Set(['testing', 'testing-1']),
    );
  });

  it('deduplicates identical slugs produced from different texts', () => {
    expect(
      headingSlugs([heading(2, 'Developer setup', 1), heading(2, 'developer-setup', 2)]),
    ).toEqual(new Set(['developer-setup', 'developer-setup-1']));
  });

  it('keeps digits at the start of a heading unchanged', () => {
    // Thực tế: docs có heading '#0-how-generation-works'.
    expect(headingSlugs([heading(2, '0 How generation works', 1)])).toEqual(
      new Set(['0-how-generation-works']),
    );
  });
});
