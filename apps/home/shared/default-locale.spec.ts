import { describe, expect, it } from 'vitest';

import { HOME_DEFAULT_LOCALE } from './default-locale';

describe('HOME_DEFAULT_LOCALE', () => {
  it('must be "en"', () => {
    expect(HOME_DEFAULT_LOCALE).toBe('en');
  });
});
