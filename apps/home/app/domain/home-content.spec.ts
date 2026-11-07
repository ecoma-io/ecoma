import { describe, expect, it } from 'vitest';

import { HOME_CONTENT } from './home-content';
import { PUBLIC_LOCALES } from '../i18n/index';

describe('HOME_CONTENT', () => {
  it('covers all of PUBLIC_LOCALES (exact keys)', () => {
    const contentKeys = Object.keys(HOME_CONTENT).toSorted();
    const localeKeys = PUBLIC_LOCALES.map((d) => d.code).toSorted();
    expect(contentKeys).toEqual(localeKeys);
  });

  it('has non-empty title/heading/description for each locale', () => {
    for (const def of PUBLIC_LOCALES) {
      const c = HOME_CONTENT[def.code];
      expect(c.title.trim().length).toBeGreaterThan(0);
      expect(c.heading.trim().length).toBeGreaterThan(0);
      expect(c.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('intro and platformPoints are readonly arrays with at least 1 item', () => {
    for (const def of PUBLIC_LOCALES) {
      const c = HOME_CONTENT[def.code];
      expect(Array.isArray(c.intro)).toBe(true);
      expect(Array.isArray(c.platformPoints)).toBe(true);
      expect(c.intro.length).toBeGreaterThan(0);
      expect(c.platformPoints.length).toBeGreaterThan(0);
    }
  });

  it('title contains "Ecoma.io"', () => {
    for (const def of PUBLIC_LOCALES) {
      const c = HOME_CONTENT[def.code];
      expect(c.title).toContain('Ecoma.io');
    }
  });
});
