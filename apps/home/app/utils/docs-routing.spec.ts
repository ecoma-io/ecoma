import { describe, expect, it } from 'vitest';
import { isDocsRoute, parseDocsRoute } from './docs-routing';

/**
 * Ma trận định tuyến của bề mặt docs.
 *
 * Đây là test bảo vệ boundary quan trọng nhất của PR: chỉ **một** route phục vụ
 * docs, và nó phải từ chối mọi pathname không thuộc mount `docs`. Đặc biệt
 * `/en/docs/api` phải bị từ chối — nếu không, docs sẽ nuốt mất bề mặt
 * `api-reference` (mount riêng, deployment unit riêng).
 */
describe('docs route acceptance', () => {
  it.each([
    '/en/docs',
    '/vi/docs',
    '/en/docs/getting-started',
    '/vi/docs/getting-started',
    '/en/docs/getting-started/installation',
    '/vi/docs/getting-started/installation',
    '/en/docs/concepts',
    '/en/docs/guides',
    '/vi/docs/foo/bar',
  ])('accepts %s', (pathname) => {
    expect(isDocsRoute(pathname)).toBe(true);
  });

  it.each([
    // locale ngoài registry
    '/fr/docs',
    // locale phải khớp từng byte — `EN` không phải `en`
    '/EN/docs',
    // trailing slash bị `parsePublicPath` từ chối
    '/en/docs/',
    // mount khác
    '/en/blog',
    // `/en` là locale-root không mount
    '/en',
    // `/` là locale-resolution entry point
    '/',
    // boundary của mount `docs/api` — docs KHÔNG được chiếm
    '/en/docs/api',
    '/en/docs/api/foo',
    '/vi/docs/api',
    '/vi/docs/api/foo',
    // không phải pathname
    'en/docs',
  ])('rejects %s', (pathname) => {
    expect(isDocsRoute(pathname)).toBe(false);
    expect(parseDocsRoute(pathname)).toBeNull();
  });

  it('treats a valid topology with unknown content as a docs page, not a route rejection', () => {
    // `/en/docs/unknown` thuộc docs về topology; việc content không tồn tại là
    // chuyện của tầng query (404), không phải của route. Nếu route từ chối ở
    // đây thì Nuxt sẽ trả 404 vì "không có route", che mất 404 vì "không có
    // document" — hai lỗi khác nhau, cần phân biệt được.
    expect(isDocsRoute('/en/docs/unknown')).toBe(true);
    expect(isDocsRoute('/vi/docs/unknown/deep/path')).toBe(true);
  });
});

describe('docs route layout', () => {
  it('exposes the validated locale and the remainder after the docs mount', () => {
    expect(parseDocsRoute('/vi/docs/getting-started/installation')).toEqual({
      locale: 'vi',
      path: '/vi/docs/getting-started/installation',
      remainder: '/getting-started/installation',
    });
  });

  it('reports an empty remainder for the docs landing', () => {
    expect(parseDocsRoute('/en/docs')).toEqual({
      locale: 'en',
      path: '/en/docs',
      remainder: '',
    });
  });

  it('never resolves a pathname to the api mount', () => {
    // Mount `docs/api` được match deepest-first, nên nó luôn thắng `docs`.
    expect(parseDocsRoute('/en/docs/api/guide')).toBeNull();
  });
});
