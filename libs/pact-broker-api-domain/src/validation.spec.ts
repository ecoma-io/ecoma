/**
 * Port từ upstream `test/validation.unit.test.ts` — regex của schema là ranh
 * giới injection đầu tiên của URL param trước khi tới SQL.
 */
import { describe, it, expect } from 'vitest';
import {
  nameSchema,
  versionSchema,
  tagSchema,
  branchSchema,
  shaSchema,
  environmentNameSchema,
  idSchema,
  parseId,
} from './validation';

describe('nameSchema', () => {
  it('accepts alphanumerics + . _ -', () => {
    expect(nameSchema.safeParse('abc-123_foo.bar').success).toBe(true);
  });

  it.each([
    ['empty string', ''],
    ['path traversal', '../etc'],
    ['space', 'a b'],
    ['html-ish', '<script>'],
    ['sql quote', "a'b"],
    ['slash', 'foo/bar'],
  ])('rejects %s', (_label, input) => {
    expect(nameSchema.safeParse(input).success).toBe(false);
  });

  it('rejects >255 chars', () => {
    expect(nameSchema.safeParse('a'.repeat(256)).success).toBe(false);
  });
});

describe('versionSchema', () => {
  it.each(['1.0.0', 'abc123def', '2024-01-01', 'v1', '1.0.0-rc.1+build.42'])(
    'accepts %s',
    (input) => {
      expect(versionSchema.safeParse(input).success).toBe(true);
    },
  );

  it('rejects empty', () => {
    expect(versionSchema.safeParse('').success).toBe(false);
  });

  // `..` là dot-segment: encodeURIComponent không encode nó, nên một giá trị
  // version như vậy ghép vào URL sẽ đổi path thật của request. Chặn ở schema —
  // ranh giới đầu tiên — thay vì tin fetch/HTTP client chuẩn hoá giúp.
  it.each(['..', '../versions', '1.0.0/..', 'a..b'])('rejects dot-segment %s', (input) => {
    expect(versionSchema.safeParse(input).success).toBe(false);
  });

  it('still accepts single dots (semver/date shapes)', () => {
    expect(versionSchema.safeParse('1.0.0').success).toBe(true);
    expect(versionSchema.safeParse('2024.01.01').success).toBe(true);
  });
});

describe('tagSchema', () => {
  it('accepts simple tag', () => {
    expect(tagSchema.safeParse('prod').success).toBe(true);
  });

  it('rejects slashes (unlike branchSchema)', () => {
    expect(tagSchema.safeParse('prod/main').success).toBe(false);
  });
});

describe('branchSchema', () => {
  it('accepts slashes (unlike tagSchema)', () => {
    expect(branchSchema.safeParse('feature/foo').success).toBe(true);
  });

  it('rejects shell metachars', () => {
    expect(branchSchema.safeParse('$(whoami)').success).toBe(false);
  });
});

describe('shaSchema', () => {
  it('accepts 64-char hex (lowercase)', () => {
    expect(shaSchema.safeParse('a'.repeat(64)).success).toBe(true);
  });

  it('accepts 64-char hex (uppercase, regex has /i)', () => {
    expect(shaSchema.safeParse('A'.repeat(64)).success).toBe(true);
  });

  it('rejects 63 chars', () => {
    expect(shaSchema.safeParse('a'.repeat(63)).success).toBe(false);
  });

  it('rejects non-hex chars', () => {
    expect(shaSchema.safeParse('g'.repeat(64)).success).toBe(false);
  });
});

describe('environmentNameSchema', () => {
  it('accepts simple environment name', () => {
    expect(environmentNameSchema.safeParse('production').success).toBe(true);
  });

  it('rejects dots (stricter than nameSchema)', () => {
    expect(environmentNameSchema.safeParse('eu.prod').success).toBe(false);
  });
});

describe('idSchema + parseId', () => {
  it('accepts positive integer strings', () => {
    expect(idSchema.safeParse('42').success).toBe(true);
  });

  it('rejects zero', () => {
    expect(idSchema.safeParse('0').success).toBe(false);
  });

  it('rejects negative', () => {
    expect(idSchema.safeParse('-1').success).toBe(false);
  });

  it('rejects non-numeric', () => {
    expect(idSchema.safeParse('abc').success).toBe(false);
  });

  it('parseId returns a number', () => {
    expect(parseId('42')).toBe(42);
  });
});
