import { describe, expect, it } from 'vitest';
// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { NotFoundPage } from '../../index';
import type { ErrorPageContent } from '../../index';

/** Nội dung mẫu tối thiểu — test tự override field cần assert. */
function sampleContent(overrides: Partial<ErrorPageContent> = {}): ErrorPageContent {
  return {
    title: 'Page not found',
    description: 'The page you requested does not exist.',
    primaryAction: { label: 'Go home', href: '/en' },
    ...overrides,
  };
}

describe('NotFoundPage', () => {
  it('renders consumer content: one h1 title, description and primary CTA', () => {
    const wrapper = mount(NotFoundPage, {
      props: {
        content: sampleContent({
          title: 'Trang không tồn tại',
          description: 'Đường dẫn bạn yêu cầu không có thật.',
          primaryAction: { label: 'Về trang chủ', href: '/vi' },
        }),
      },
    });

    // Một `<h1>` duy nhất — trang lỗi phải giữ thứ tự heading hợp lý.
    expect(wrapper.findAll('h1')).toHaveLength(1);
    expect(wrapper.find('h1').text()).toBe('Trang không tồn tại');
    expect(wrapper.text()).toContain('Đường dẫn bạn yêu cầu không có thật.');

    const primary = wrapper.find('a');
    expect(primary.text()).toBe('Về trang chủ');
    // href được đưa vào nguyên trạng — library không biến đổi destination.
    expect(primary.attributes('href')).toBe('/vi');
  });

  it('renders the 404 status code visually hidden from assistive tech', () => {
    const wrapper = mount(NotFoundPage, { props: { content: sampleContent() } });

    // Mã số 404 là chi tiết thị giác: aria-hidden để screen reader không đọc
    // "bốn không bốn" trước tiêu đề thật; tiêu đề trong `<h1>` mới là thông
    // điệp chính.
    const status = wrapper.findAll('span').find((s) => s.text() === '404');
    expect(status).toBeDefined();
    expect(status?.attributes('aria-hidden')).toBe('true');
  });

  it('renders an alert region without emitting its own main landmark', () => {
    const wrapper = mount(NotFoundPage, { props: { content: sampleContent() } });

    // Component không render `<main>`: consumer bọc trong shell đã sở hữu
    // landmark đó; `role="alert"` bảo đảm screen reader đọc nội dung lỗi
    // ngay khi nó thay thế trang thật.
    expect(wrapper.find('main').exists()).toBe(false);
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(wrapper.find('[role="alert"]').text()).toContain('Page not found');
  });

  it('hides the secondary action when it is not provided', () => {
    const wrapper = mount(NotFoundPage, { props: { content: sampleContent() } });

    expect(wrapper.findAll('a')).toHaveLength(1);
  });

  it('renders the secondary action after the primary one when provided', () => {
    const wrapper = mount(NotFoundPage, {
      props: {
        content: sampleContent({
          secondaryAction: { label: 'Read the docs', href: '/en/docs' },
        }),
      },
    });

    const links = wrapper.findAll('a');
    expect(links).toHaveLength(2);
    const [homeLink, docsLink] = links;
    expect(homeLink?.text()).toBe('Go home');
    expect(homeLink?.attributes('href')).toBe('/en');
    expect(docsLink?.text()).toBe('Read the docs');
    expect(docsLink?.attributes('href')).toBe('/en/docs');
    // Thứ tự DOM: primary trước secondary.
    expect(wrapper.html().indexOf('Go home')).toBeLessThan(wrapper.html().indexOf('Read the docs'));
  });

  it('rerenders reactively when content changes', async () => {
    // Pin reactivity của props destructure: consumer có thể render error page
    // với nội dung đổi theo locale sau khi component đã mount.
    const wrapper = mount(NotFoundPage, { props: { content: sampleContent() } });

    await wrapper.setProps({
      content: sampleContent({
        title: 'Seite nicht gefunden',
        primaryAction: { label: 'Zur Startseite', href: '/de' },
      }),
    });

    expect(wrapper.find('h1').text()).toBe('Seite nicht gefunden');
    expect(wrapper.find('a').text()).toBe('Zur Startseite');
    expect(wrapper.find('a').attributes('href')).toBe('/de');
  });

  it('never mentions ownership domains it does not own', () => {
    // Trang 404 không được tự bịa hint đăng nhập/UX điều hướng của app:
    // mọi chữ trên trang đến từ props. Render với nội dung marker đặc biệt
    // rồi assert toàn bộ text trên page chỉ chứa marker đó.
    const wrapper = mount(NotFoundPage, {
      props: {
        content: sampleContent({
          title: 'MARKER_TITLE',
          description: 'MARKER_DESCRIPTION',
          primaryAction: { label: 'MARKER_CTA', href: '/MARKER_HREF' },
        }),
      },
    });

    const text = wrapper.text();
    expect(text).toContain('MARKER_TITLE');
    expect(text).toContain('MARKER_DESCRIPTION');
    expect(text).toContain('MARKER_CTA');
    // Không có chữ nào ngoài marker + mã status tĩnh.
    expect(text.replace(/MARKER_\w+|404/gu, '').trim()).toBe('');
  });
});
