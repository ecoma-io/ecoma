import { describe, expect, it } from 'vitest';

import { arrayField } from './broker-body';

describe('arrayField', () => {
  it('returns the nested array for a valid path', () => {
    expect(
      arrayField({ _embedded: { environments: [{ name: 'test' }] } }, '_embedded', 'environments'),
    ).toEqual([{ name: 'test' }]);
  });

  it('returns an empty array for a null body or an odd shape — never throws', () => {
    expect(arrayField(null, 'matrix')).toEqual([]);
    expect(arrayField(undefined, 'matrix')).toEqual([]);
    expect(arrayField('nope', 'matrix')).toEqual([]);
    expect(arrayField({ matrix: 'not-an-array' }, 'matrix')).toEqual([]);
    expect(arrayField({ _embedded: null }, '_embedded', 'environments')).toEqual([]);
    expect(arrayField({}, 'matrix')).toEqual([]);
  });
});
