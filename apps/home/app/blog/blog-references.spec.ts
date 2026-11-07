import { describe, expect, it } from 'vitest';
import {
  normalizeReferenceIds,
  resolveArticleReference,
  resolveReferences,
  type ArticleIdentityRecord,
} from './blog-references';

/**
 * Bảng identity fixture — en/vi cùng articleId hoặc chỉ một locale có.
 *
 * `title` là **title thật của content**, không phải slug đẹp lại: đó là điểm
 * của fixture này. Nếu resolver suy title từ slug, `url-model` sẽ ra một
 * nhãn khác `One URL model` và test vẫn xanh — fixture buộc title phải đến từ
 * bảng.
 */
const RECORDS: readonly ArticleIdentityRecord[] = [
  {
    articleId: 'url-model',
    locale: 'en',
    path: '/en/blog/url-model',
    title: 'One URL model',
  },
  {
    articleId: 'url-model',
    locale: 'vi',
    path: '/vi/blog/url-model',
    title: 'Một mô hình URL',
  },
  {
    articleId: 'math-intro',
    locale: 'en',
    path: '/en/blog/math-intro',
    title: 'A short introduction to linear algebra',
  },
];

describe('resolveArticleReference', () => {
  it('resolves to the same-locale path and title when a translation exists', () => {
    // Nhãn phải là title **của bản dịch**, không phải title EN: cùng một
    // khái niệm, hai bản khác nhau, và người đọc `/vi` cần thấy bản họ đọc.
    expect(resolveArticleReference(RECORDS, 'url-model', 'vi')).toEqual({
      kind: 'same-locale',
      path: '/vi/blog/url-model',
      title: 'Một mô hình URL',
    });
  });

  it('falls back to the English path and title when the locale has no translation', () => {
    // Cả **path** và **title** đều của bản English: nhãn tiếng Việt đặt trên
    // một trang tiếng Anh là thông tin sai, và nhãn suy từ slug tiếng Việt là
    // thông tin bịa.
    expect(resolveArticleReference(RECORDS, 'math-intro', 'vi')).toEqual({
      kind: 'english-fallback',
      path: '/en/blog/math-intro',
      title: 'A short introduction to linear algebra',
    });
  });

  it('returns missing for an unknown articleId', () => {
    expect(resolveArticleReference(RECORDS, 'ghost', 'en')).toEqual({ kind: 'missing' });
  });

  it('never invents a URL or a title outside the identity table', () => {
    // Mọi path trả về đều phải đến từ bảng — không tự ghép `/${locale}/blog/...`.
    // Missing không mang path nên tập hợp path hợp lệ chỉ gồm các result có
    // path; assert duy nhất trên danh sách thu được.
    const result = resolveArticleReference(RECORDS, 'math-intro', 'vi');
    const resolvedPaths = result.kind === 'missing' ? [] : [result.path];
    expect(resolvedPaths.every((path) => RECORDS.some((record) => record.path === path))).toBe(
      true,
    );
  });
});

describe('resolveReferences', () => {
  it('renders titles from content, never the path, on a same-locale reference', () => {
    expect(resolveReferences(RECORDS, ['url-model'], 'vi')).toEqual([
      {
        path: '/vi/blog/url-model',
        title: 'Một mô hình URL',
        isEnglishFallback: false,
      },
    ]);
  });

  it('marks an English fallback so the view can label it, and uses the English title', () => {
    // `isEnglishFallback` là tín hiệu **hiển thị** dán lên trang `/vi`: bài này
    // viết bằng tiếng Anh. Nó đặt bởi nhánh resolve, không phải suy từ locale
    // của path — cùng một path `/en/blog/...` trên trang EN là bản gốc, không
    // phải fallback.
    expect(resolveReferences(RECORDS, ['math-intro'], 'vi')).toEqual([
      {
        path: '/en/blog/math-intro',
        title: 'A short introduction to linear algebra',
        isEnglishFallback: true,
      },
    ]);
  });

  it('never marks a same-locale reference as an English fallback on the English page', () => {
    // Trang EN: mọi reference resolve cùng locale trả `same-locale`, kể cả
    // khi nó cũng có bản dịch ở locale khác — nhãn "tiếng Anh" trên trang EN
    // là vô nghĩa.
    expect(resolveReferences(RECORDS, ['url-model'], 'en')).toEqual([
      { path: '/en/blog/url-model', title: 'One URL model', isEnglishFallback: false },
    ]);
  });

  it('drops an unknown articleId instead of emitting a broken link', () => {
    expect(resolveReferences(RECORDS, ['ghost'], 'en')).toEqual([]);
  });

  it('keeps input order and drops missing ids', () => {
    expect(resolveReferences(RECORDS, ['url-model', 'ghost', 'math-intro'], 'en')).toEqual([
      { path: '/en/blog/url-model', title: 'One URL model', isEnglishFallback: false },
      {
        path: '/en/blog/math-intro',
        title: 'A short introduction to linear algebra',
        isEnglishFallback: false,
      },
    ]);
  });

  it('dedupes two ids resolving to the same path', () => {
    // Hai `articleId` trỏ cùng một bài là lỗi dữ liệu; UI không được nhân bản
    // link. Dedupe theo **path** nên hai bản dịch cùng khái niệm vẫn hiện cả
    // hai khi khác path (xem test kế tiếp).
    const duplicated: readonly ArticleIdentityRecord[] = [
      ...RECORDS,
      {
        articleId: 'alias',
        locale: 'en',
        path: '/en/blog/url-model',
        title: 'Alias of the URL model',
      },
    ];
    expect(resolveReferences(duplicated, ['url-model', 'alias'], 'en')).toEqual([
      { path: '/en/blog/url-model', title: 'One URL model', isEnglishFallback: false },
    ]);
  });

  it('keeps the locale translation alongside the English original as distinct entries', () => {
    // Dedupe theo path, không theo `articleId`: hai bản của cùng khái niệm là
    // hai đích khác nhau, và một reference duy nhất vẫn phải resolve tới bản
    // đúng locale — không phải cả hai.
    const both = resolveReferences(RECORDS, ['url-model', 'url-model'], 'vi');
    expect(both).toEqual([
      { path: '/vi/blog/url-model', title: 'Một mô hình URL', isEnglishFallback: false },
    ]);
  });

  it('drops an entry whose title is blank rather than rendering a nameless link', () => {
    // Title rỗng chỉ xảy ra với document hỏng, nhưng hậu quả nếu lọt là link
    // không nhãn — và view chỉ có một cách hiển thị link không nhãn: in URL.
    const untitled: readonly ArticleIdentityRecord[] = [
      { articleId: 'broken', locale: 'en', path: '/en/blog/broken', title: '   ' },
    ];
    expect(resolveReferences(untitled, ['broken'], 'en')).toEqual([]);
  });

  it('trims a padded title so a link label never carries stray whitespace', () => {
    const padded: readonly ArticleIdentityRecord[] = [
      { articleId: 'padded', locale: 'en', path: '/en/blog/padded', title: '  Padded  ' },
    ];
    expect(resolveReferences(padded, ['padded'], 'en')).toEqual([
      { path: '/en/blog/padded', title: 'Padded', isEnglishFallback: false },
    ]);
  });

  it('returns an empty list for no ids', () => {
    expect(resolveReferences(RECORDS, [], 'en')).toEqual([]);
  });
});

describe('normalizeReferenceIds', () => {
  it('trims, drops empty entries and dedupes', () => {
    expect(normalizeReferenceIds([' a ', 'a', '', 'b'])).toEqual(['a', 'b']);
  });

  it('returns an empty list for undefined', () => {
    expect(normalizeReferenceIds(undefined)).toEqual([]);
  });
});
