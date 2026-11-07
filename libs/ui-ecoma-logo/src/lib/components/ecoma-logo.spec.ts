import { describe, it, expect } from 'vitest';
// @vitest-environment jsdom
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { mount } from '@vue/test-utils';
import { ECOMA_LOGO_HORIZONTAL_SVG_URL, EcomaLogo } from '../../index';
import {
  ECOMA_LOGO_MARK_PATH,
  ECOMA_LOGO_VIEWBOX,
  ECOMA_LOGO_WORDMARK_PATH,
} from '../logo-artwork';

/**
 * Nội dung file artwork nguồn — nguồn sự thật của HÌNH HỌC logo. Đọc bằng
 * `resolve` + `import.meta.dirname` chứ không `new URL(..., import.meta.url)`:
 * Vitest chạy jsdom nên `import.meta.url` không phải scheme `file:` và
 * `fileURLToPath` ném `TypeError: The URL must be of scheme file` — đã thử,
 * lỗi đúng như vậy. `readFileSync` ở đây chạy ở **test time** trên Node và
 * không được bundle vào Worker, nên được phép bởi override `node:fs` của
 * `.oxlintrc.json` cho file spec và test.
 */
const SOURCE_SVG = readFileSync(
  resolve(import.meta.dirname, '../../assets/ecoma-logo-horizontal.svg'),
  'utf8',
);

describe('EcomaLogo', () => {
  it('renders an inline svg rather than an img element', () => {
    // Inline `<svg>` là điều kiện để logo đi theo design token: `<img>` khoá
    // artwork trong tài liệu riêng nên `fill` bị nướng thành hex, CSS trang
    // không chạm vào được. Quay lại `<img>` là mất khả năng đổi màu.
    const wrapper = mount(EcomaLogo);

    expect(wrapper.find('svg').exists()).toBe(true);
    expect(wrapper.find('img').exists()).toBe(false);
  });

  it('colors the mark with the primary brand token and the wordmark with the ink text token', () => {
    // Token-driven color là cả lý do của việc đổi sang inline. Mark theo
    // `fill-brand` (`--color-brand` #006AFF — "Primary thương hiệu"), wordmark
    // theo `fill-foam` (`--color-foam`, màu chữ chính của body) thay cho
    // `#161616` gần như tịt trên nền tối của file nguồn.
    const wrapper = mount(EcomaLogo);

    const [mark, wordmark] = wrapper.findAll('path');
    expect(mark?.classes()).toContain('fill-brand');
    expect(wordmark?.classes()).toContain('fill-foam');
  });

  it('draws the artwork with the source viewBox and both source paths', () => {
    const wrapper = mount(EcomaLogo);

    const svg = wrapper.find('svg');
    expect(svg.attributes('viewBox')).toBe(ECOMA_LOGO_VIEWBOX);
    const [mark, wordmark] = wrapper.findAll('path');
    expect(mark?.attributes('d')).toBe(ECOMA_LOGO_MARK_PATH);
    expect(wordmark?.attributes('d')).toBe(ECOMA_LOGO_WORDMARK_PATH);
  });

  it('preserves the fill-rule the source artwork relies on', () => {
    // Mark có lỗ hổng kín; bỏ `fill-rule` làm nó đổ thành nét đặc.
    const wrapper = mount(EcomaLogo);

    expect(wrapper.find('path').attributes('fill-rule')).toBe('evenodd');
  });

  it('carries no fill of its own, so the token classes are what color it', () => {
    // Nếu component tự đặt `fill`, attribute đó thắng class `fill-*` của
    // Tailwind (CSS specificity: presentation attribute < class) và logo
    // không còn đổi màu được nữa.
    for (const path of mount(EcomaLogo).findAll('path')) {
      expect(path.attributes('fill')).toBeUndefined();
    }
  });

  it('matches the geometry of the source SVG file exactly', () => {
    // `logo-artwork.ts` chép hai path từ file nguồn. Chép tay là chỗ dễ lệch
    // (đổi artwork mà quên cập nhật module, hoặc ngược lại) — và lệch đó
    // không làm hỏng type/test/build nào, chỉ hiện ra khi người dùng nhìn logo
    // méo. Ghim hai bên khớp từng ký tự, cùng phong cách với
    // `anchors the asset URL to the real SVG source file` bên dưới.
    const sourcePaths = [...SOURCE_SVG.matchAll(/<path[^>]*\sd="([^"]+)"/gu)].map(
      (match) => match[1] as string,
    );

    expect(ECOMA_LOGO_MARK_PATH).toBe(sourcePaths[0]);
    expect(ECOMA_LOGO_WORDMARK_PATH).toBe(sourcePaths[1]);
    expect(ECOMA_LOGO_VIEWBOX).toBe(SOURCE_SVG.match(/viewBox="([^"]+)"/u)?.[1]);
  });

  it('keeps the viewBox origin intact, because the mark is drawn above y=0', () => {
    // Đỉnh mark nằm ở `y≈-7.6`, tức **trên** origin của viewBox. Đây không phải
    // lỗi làm tròn của exporter: nội dung thật sự vượt biên, nên `min-y` âm là
    // bắt buộc. Ai "dọn" viewBox về `0 0 …` sẽ cắt mất đỉnh mark — và chỉ thấy
    // được bằng mắt, nên test này phải ghim.
    const [, minY] = ECOMA_LOGO_VIEWBOX.split(' ');

    expect(Number(minY)).toBeLessThan(0);
  });

  it('defaults the accessible name to the brand name', () => {
    // `<svg>` không có `alt`, nên accessible name phải đến từ `aria-label` —
    // đây là hợp đồng a11y thay cho `alt` của `<img>`.
    const wrapper = mount(EcomaLogo);

    expect(wrapper.find('svg').attributes('aria-label')).toBe('ecoma.io');
  });

  it('lets the consumer override the accessible name per usage context', () => {
    const wrapper = mount(EcomaLogo, { props: { alt: 'Về trang chủ ecoma.io' } });

    expect(wrapper.find('svg').attributes('aria-label')).toBe('Về trang chủ ecoma.io');
  });

  it('exposes the logo as an image to assistive technology', () => {
    const wrapper = mount(EcomaLogo);

    // Không có `role="img"` thì AT coi `<svg>` là nhóm graphics trừu tượng và
    // bỏ qua accessible name vừa gán.
    expect(wrapper.find('svg').attributes('role')).toBe('img');
  });

  it('is not an extra tab stop inside the brand link', () => {
    // Logo nằm trong `<a href>` sẵn có; một SVG inline focusable sẽ thêm một
    // tab stop không điều hướng được. `focusable="false"` tắt hành vi đó ở
    // engine/AT cũ vẫn coi inline SVG là focusable.
    const wrapper = mount(EcomaLogo);

    expect(wrapper.find('svg').attributes('focusable')).toBe('false');
  });

  it('falls through extra attributes to the svg root', () => {
    // Consumer tùy chỉnh qua attribute fallthrough (single root): class merge
    // với class của component, attr tự do (data-*) đi thẳng vào `<svg>`.
    const wrapper = mount(EcomaLogo, {
      attrs: { class: 'h-6 w-auto', 'data-testid': 'brand-logo' },
    });

    const svg = wrapper.find('svg');
    expect(svg.classes()).toContain('ecoma-logo');
    expect(svg.classes()).toContain('h-6');
    expect(svg.classes()).toContain('w-auto');
    expect(svg.attributes('data-testid')).toBe('brand-logo');
  });

  it('lets the consumer override sizing through CSS classes, not width attributes', () => {
    // width/height KHÔNG đi qua fallthrough: override một mình một trên hai
    // làm méo artwork. Sizing của consumer chỉ qua CSS.
    const wrapper = mount(EcomaLogo, { attrs: { width: '48', height: '48' } });

    expect(wrapper.find('svg').attributes('width')).toBeUndefined();
    expect(wrapper.find('svg').attributes('height')).toBeUndefined();
  });

  it('never lets fallthrough attributes replace the artwork', () => {
    // Artwork là source of truth: nhóm nguồn ảnh bị filter khỏi fallthrough.
    // Sau khi thành inline SVG thì không còn `src` nào để thay, nhưng consumer
    // cũ vẫn có thể truyền — và nó phải bị bỏ qua chứ không đọng lại trong DOM.
    const wrapper = mount(EcomaLogo, {
      attrs: {
        src: '/replaced.svg',
        srcset: '/replaced-2x.svg 2x',
        imagesrcset: '/replaced.avif 2x',
      },
    });

    const svg = wrapper.find('svg');
    expect(svg.attributes('src')).toBeUndefined();
    expect(svg.attributes('srcset')).toBeUndefined();
    expect(svg.attributes('imagesrcset')).toBeUndefined();
  });

  it('still exports the raw SVG asset URL for consumers that need the file itself', () => {
    // Inline SVG phục vụ hiển thị trong trang; URL asset phục vụ consumer cần
    // **file** logo (Open Graph image, favicon…) — hai nhu cầu khác nhau, nên
    // export này được giữ nguyên.
    expect(ECOMA_LOGO_HORIZONTAL_SVG_URL.endsWith('ecoma-logo-horizontal.svg')).toBe(true);
  });
});
