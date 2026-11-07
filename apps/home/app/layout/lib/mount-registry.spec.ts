import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  PUBLIC_MOUNTS,
  PUBLIC_MOUNTS_IN_DECLARATION_ORDER,
  getMountDefinition,
  isPublicMount,
  type PublicMount,
} from '../index';
// Chiếu typeof vào đúng nguồn dữ liệu registry (export nội bộ, không qua
// entrypoint): test này chứng minh PublicMount derive từ registry, không
// phải union viết tay trùng giá trị.
import type { PUBLIC_MOUNT_DEFINITIONS } from './mount-registry';

describe('mount registry', () => {
  it('declares exactly the four public mounts in declaration order', () => {
    expect(PUBLIC_MOUNTS_IN_DECLARATION_ORDER.map((definition) => definition.path)).toEqual([
      'blog',
      'docs',
      'docs/api',
      'legal',
    ]);
  });

  it('orders PUBLIC_MOUNTS deepest-first so nested mounts win matching', () => {
    expect(PUBLIC_MOUNTS.map((definition) => definition.path)).toEqual([
      'docs/api',
      'blog',
      'docs',
      'legal',
    ]);
  });

  it('exposes the same frozen entry objects through both collections', () => {
    for (const definition of PUBLIC_MOUNTS_IN_DECLARATION_ORDER) {
      expect(PUBLIC_MOUNTS).toContain(definition);
    }
    expect(getMountDefinition('blog')).toBe(PUBLIC_MOUNTS_IN_DECLARATION_ORDER[0]);
    expect(getMountDefinition('docs/api')).toBe(PUBLIC_MOUNTS_IN_DECLARATION_ORDER[2]);
    expect(getMountDefinition('legal')).toBe(PUBLIC_MOUNTS_IN_DECLARATION_ORDER[3]);
  });

  it('freezes both collections and every entry', () => {
    expect(Object.isFrozen(PUBLIC_MOUNTS)).toBe(true);
    expect(Object.isFrozen(PUBLIC_MOUNTS_IN_DECLARATION_ORDER)).toBe(true);
    for (const definition of PUBLIC_MOUNTS) {
      expect(Object.isFrozen(definition)).toBe(true);
    }
    expect(() => {
      // @ts-expect-error -- registry là readonly policy, không phải mutable state
      PUBLIC_MOUNTS[0].path = 'x';
    }).toThrow(TypeError);
    expect(PUBLIC_MOUNTS).toHaveLength(4);
    expect(PUBLIC_MOUNTS.map((definition) => definition.path)).toEqual([
      'docs/api',
      'blog',
      'docs',
      'legal',
    ]);
  });

  it('keeps the registry unchanged after failed lookups', () => {
    getMountDefinition('nope');
    getMountDefinition('');
    isPublicMount('blogging');
    expect(PUBLIC_MOUNTS).toHaveLength(4);
    expect(PUBLIC_MOUNTS_IN_DECLARATION_ORDER).toHaveLength(4);
  });

  describe('isPublicMount', () => {
    it('narrows exact registered paths only', () => {
      expect(isPublicMount('blog')).toBe(true);
      expect(isPublicMount('docs')).toBe(true);
      expect(isPublicMount('docs/api')).toBe(true);
    });

    it('rejects prefixes, suffixes, case variants and unknown paths', () => {
      expect(isPublicMount('blogging')).toBe(false);
      expect(isPublicMount('blog/')).toBe(false);
      expect(isPublicMount('/blog')).toBe(false);
      expect(isPublicMount('docs/api/')).toBe(false);
      expect(isPublicMount('docs/ap')).toBe(false);
      expect(isPublicMount('BLOG')).toBe(false);
      expect(isPublicMount('home')).toBe(false);
      expect(isPublicMount('')).toBe(false);
    });
  });

  describe('getMountDefinition', () => {
    it('returns the same frozen instance for a known mount', () => {
      const definition = getMountDefinition('docs');
      expect(definition?.path).toBe('docs');
      expect(definition).toBe(getMountDefinition('docs'));
      expect(Object.isFrozen(definition)).toBe(true);
    });

    it('returns undefined for unknown mounts without throwing', () => {
      expect(getMountDefinition('pricing')).toBeUndefined();
      expect(getMountDefinition('BLOG')).toBeUndefined();
      expect(getMountDefinition('')).toBeUndefined();
      expect(PUBLIC_MOUNTS).toHaveLength(4);
    });
  });

  describe('type safety', () => {
    it('PublicMount is the closed union of registry paths', () => {
      expectTypeOf<PublicMount>().toEqualTypeOf<'blog' | 'docs' | 'docs/api' | 'legal'>();
    });

    it('derives PublicMount from the registry data, not from a hand-written union', () => {
      type DerivedMount = (typeof PUBLIC_MOUNT_DEFINITIONS)[number]['path'];
      expectTypeOf<PublicMount>().toEqualTypeOf<DerivedMount>();
    });

    it('every registry entry satisfies the public metadata shape', () => {
      expectTypeOf<(typeof PUBLIC_MOUNT_DEFINITIONS)[number]>().toExtend<{
        readonly path: PublicMount;
      }>();
    });

    it('lookup accepts an untrusted string and returns a definition or undefined', () => {
      expectTypeOf(getMountDefinition).parameter(0).toEqualTypeOf<string>();
      expectTypeOf(getMountDefinition('blog')).toEqualTypeOf<
        { readonly path: PublicMount } | undefined
      >();
    });
  });
});
