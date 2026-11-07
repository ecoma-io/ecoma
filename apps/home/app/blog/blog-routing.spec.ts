import { describe, expect, it } from 'vitest';
import { isBlogRoute, parseBlogRoute } from './blog-routing';

/**
 * Ma trận định tuyến của bề mặt blog.
 *
 * Đây là test bảo vệ boundary quan trọng nhất của PR: chỉ **một** route phục vụ
 * blog, và nó phải từ chối mọi pathname không thuộc mount `blog`. Đặc biệt
 * `/en/docs` phải bị từ chối — blogs không được chiếm mount của deploy unit
 * khác, và `/en/docs/api` thuộc mount `docs/api`.
 */
describe('blog route acceptance', () => {
  it.each([
    '/en/blog',
    '/vi/blog',
    '/en/blog/url-model',
    '/vi/blog/url-model',
    '/en/blog/nested/slug',
    '/vi/blog/1.url-model',
  ])('accepts %s', (pathname) => {
    expect(isBlogRoute(pathname)).toBe(true);
  });

  it.each([
    // locale ngoài registry
    '/fr/blog',
    // locale phải khớp từng byte — `EN` không phải `en`
    '/EN/blog',
    // trailing slash bị `parsePublicPath` từ chối
    '/en/blog/',
    // mount khác — blogs không sở hữu docs
    '/en/docs',
    '/vi/docs',
    '/en/docs/api',
    '/vi/docs/api',
    // `/en` là locale-root không mount
    '/en',
    // `/` là locale-resolution entry point
    '/',
    // full segment boundary — `/en/blogging` không phải mount `blog`
    '/en/blogging',
    // không phải pathname
    'en/blog',
  ])('rejects %s', (pathname) => {
    expect(isBlogRoute(pathname)).toBe(false);
    expect(parseBlogRoute(pathname)).toBeNull();
  });

  it('treats a valid topology with unknown content as a blog page, not a route rejection', () => {
    // `/en/blog/unknown` thuộc blog về topology; việc content không tồn tại là
    // chuyện của tầng query (404), không phải của route. Nếu route từ chối ở
    // đây thì Nuxt sẽ trả 404 vì "không có route", che mất 404 vì "không có
    // article" — hai lỗi khác nhau, cần phân biệt được.
    expect(isBlogRoute('/en/blog/unknown')).toBe(true);
    expect(isBlogRoute('/vi/blog/unknown/deep/path')).toBe(true);
  });
});

describe('blog route layout', () => {
  it('exposes the validated locale and the remainder after the blog mount', () => {
    expect(parseBlogRoute('/vi/blog/url-model')).toEqual({
      locale: 'vi',
      path: '/vi/blog/url-model',
      remainder: '/url-model',
    });
  });

  it('reports an empty remainder for the blog landing', () => {
    expect(parseBlogRoute('/en/blog')).toEqual({
      locale: 'en',
      path: '/en/blog',
      remainder: '',
    });
  });

  it('never resolves a pathname to another mount', () => {
    // Mount `blog` chỉ match đúng segment của nó — mọi pathname ngoài topology
    // blog phải trả `null`, kể cả khi prefix trông giống.
    expect(parseBlogRoute('/en/blogging')).toBeNull();
    expect(parseBlogRoute('/en/blogroll')).toBeNull();
  });
});
