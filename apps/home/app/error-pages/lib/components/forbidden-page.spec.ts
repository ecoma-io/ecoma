import { describe, expect, it } from 'vitest';
// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { ForbiddenPage, NotFoundPage } from '../../index';
import type { ErrorPageContent } from '../../index';

/** Nội dung mẫu tối thiểu — test tự override field cần assert. */
function sampleContent(overrides: Partial<ErrorPageContent> = {}): ErrorPageContent {
  return {
    title: 'Access denied',
    description: 'You do not have permission to view this page.',
    primaryAction: { label: 'Go home', href: '/en' },
    ...overrides,
  };
}

describe('ForbiddenPage', () => {
  it('renders consumer content: one h1 title, description and primary CTA', () => {
    const wrapper = mount(ForbiddenPage, {
      props: {
        content: sampleContent({
          title: 'Không có quyền truy cập',
          description: 'Bạn không được phép xem trang này.',
          primaryAction: { label: 'Về trang chủ', href: '/vi' },
        }),
      },
    });

    expect(wrapper.findAll('h1')).toHaveLength(1);
    expect(wrapper.find('h1').text()).toBe('Không có quyền truy cập');
    expect(wrapper.text()).toContain('Bạn không được phép xem trang này.');

    const primary = wrapper.find('a');
    expect(primary.text()).toBe('Về trang chủ');
    expect(primary.attributes('href')).toBe('/vi');
  });

  it('renders the 403 status code visually hidden from assistive tech', () => {
    const wrapper = mount(ForbiddenPage, { props: { content: sampleContent() } });

    const status = wrapper.findAll('span').find((s) => s.text() === '403');
    expect(status).toBeDefined();
    expect(status?.attributes('aria-hidden')).toBe('true');
  });

  it('renders an alert region without emitting its own main landmark', () => {
    const wrapper = mount(ForbiddenPage, { props: { content: sampleContent() } });

    // Component không render `<main>`: consumer bọc trong shell đã sở hữu
    // landmark đó; hai landmark lồng nhau vi phạm a11y.
    expect(wrapper.find('main').exists()).toBe(false);
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(wrapper.find('[role="alert"]').text()).toContain('Access denied');
  });

  it('never injects auth hints of its own', () => {
    // 403 KHÔNG được tự render hint đăng nhập/đăng ký ("sign in", "log in",
    // "sign up"…): người dùng có thể đã xác thực mà vẫn thiếu quyền, và hint
    // auth là thông tin rơi ra từ sai lớp. Mọi chữ trên trang phải đến từ
    // props của consumer.
    const wrapper = mount(ForbiddenPage, {
      props: {
        content: sampleContent({
          title: 'MARKER_TITLE',
          description: 'MARKER_DESCRIPTION',
          primaryAction: { label: 'MARKER_CTA', href: '/MARKER_HREF' },
        }),
      },
    });

    const text = wrapper.text().toLowerCase();
    expect(text).toContain('marker_title');
    for (const forbiddenHint of ['sign in', 'sign up', 'log in', 'login', 'password']) {
      expect(text).not.toContain(forbiddenHint);
    }
  });

  it('is a distinct component from NotFoundPage with its own status code', () => {
    // Hai page là hai component riêng (không gộp một component nhiều prop
    // status): mã hiển thị phải khác nhau ngay ở cùng content shape.
    const content = sampleContent();
    const forbidden = mount(ForbiddenPage, { props: { content } });
    const notFound = mount(NotFoundPage, { props: { content } });

    expect(forbidden.html()).toMatch(/>\s*403\s*</u);
    expect(notFound.html()).toMatch(/>\s*404\s*</u);
  });

  it('supports optional secondary action and reactivity like the shared stage', async () => {
    const wrapper = mount(ForbiddenPage, {
      props: {
        content: sampleContent({
          secondaryAction: { label: 'Contact support', href: '/en/support' },
        }),
      },
    });

    const links = wrapper.findAll('a');
    expect(links).toHaveLength(2);
    expect(links[1]?.attributes('href')).toBe('/en/support');

    await wrapper.setProps({
      content: sampleContent({ title: 'Zugriff verweigert' }),
    });
    expect(wrapper.find('h1').text()).toBe('Zugriff verweigert');
  });
});
