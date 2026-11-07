import { describe, expect, it } from 'vitest';
import { PUBLIC_LOCALES } from '../i18n/index';
import { docsUiStrings } from './docs-ui-strings';

describe('docs UI strings', () => {
  it('resolves the documented labels for each locale', () => {
    expect(docsUiStrings('en')).toEqual({
      onThisPage: 'On this page',
      previous: 'Previous',
      next: 'Next',
      pagination: 'Pagination',
      documentation: 'Documentation',
      breadcrumbs: 'Breadcrumbs',
      sections: 'Sections',
      tableRegion: 'Data table',
    });
    expect(docsUiStrings('vi')).toEqual({
      onThisPage: 'Nội dung',
      previous: 'Trước',
      next: 'Tiếp',
      pagination: 'Phân trang',
      documentation: 'Tài liệu',
      breadcrumbs: 'Đường dẫn',
      sections: 'Các phần',
      tableRegion: 'Bảng dữ liệu',
    });
  });

  it('covers every locale in the registry', () => {
    // Dictionary khai báo `Record<PublicLocale, ...>` nên thiếu locale là lỗi
    // type ngay; test này khẳng định thêm rằng không locale nào trả undefined
    // lúc runtime (ví dụ khi registry được nạp khác đi).
    for (const definition of PUBLIC_LOCALES) {
      expect(docsUiStrings(definition.code)).toBeDefined();
    }
  });

  it('does not leak English copy into the Vietnamese strings', () => {
    const vi = docsUiStrings('vi');
    for (const value of Object.values(vi)) {
      expect(value).not.toMatch(
        /On this page|Previous|Next|Pagination|Documentation|Breadcrumbs|Sections/u,
      );
    }
  });

  it('keeps the nav landmark labels distinct within a locale', () => {
    // Breadcrumb, sidebar và TOC là ba `<nav>` cùng tồn tại trên một page. Nếu
    // hai trong số đó trùng tên truy cập được thì screen reader đọc hai landmark
    // giống hệt nhau và người dùng không phân biệt được chúng — đúng lỗi đã có
    // với nhãn `documentation` dùng cho cả breadcrumb lẫn sidebar. Test này chốt
    // rằng tập nhãn landmark không có phần tử trùng.
    for (const definition of PUBLIC_LOCALES) {
      const ui = docsUiStrings(definition.code);
      const landmarkLabels = [ui.documentation, ui.breadcrumbs, ui.onThisPage, ui.pagination];
      expect(new Set(landmarkLabels).size).toBe(landmarkLabels.length);
    }
  });

  it('localizes the TOC label as Nội dung and the pager labels as Trước / Tiếp', () => {
    const vi = docsUiStrings('vi');
    expect(vi.onThisPage).toBe('Nội dung');
    expect(vi.previous).toBe('Trước');
    expect(vi.next).toBe('Tiếp');
    expect(vi.pagination).toBe('Phân trang');
  });

  it('localizes the table region label for each locale', () => {
    // `ProseTable` hợp nhất dùng key này cho region cuộn ngang của bảng Markdown
    // trên mọi bề mặt content (docs lẫn blog) — mỗi locale phải có bản dịch.
    expect(docsUiStrings('en').tableRegion).toBe('Data table');
    expect(docsUiStrings('vi').tableRegion).toBe('Bảng dữ liệu');
  });
});
