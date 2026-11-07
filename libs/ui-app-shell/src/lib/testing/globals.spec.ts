import { describe, expect, it } from 'vitest';

/**
 * Ghim rằng `setupFiles` của `vitest.config.mts` thật sự có tác dụng.
 *
 * File này **cố ý không** import `../testing/nuxt-env`. Ba global dưới đây
 * không có trong jsdom, và nhiều dependency của thư viện (`reka-ui`, các
 * component dùng `matchMedia`/`ResizeObserver`) đọc chúng **lúc module được
 * evaluate** — tức là trước cả `describe` của spec. Nếu global chỉ được cài
 * bằng import tường minh trong từng spec thì một spec quên import sẽ chết ở
 * `TypeError: window.matchMedia is not a function` ném ra từ một component
 * không liên quan, đúng lúc một test khác đang chạy.
 *
 * Vì vậy `setupFiles` phải nạp module đó **trước mọi module của test file**;
 * spec này kiểm đúng thứ tự đó bằng cách chỉ dựa vào setup, không tự import.
 * Bỏ `setupFiles` khỏi config là spec này đỏ ngay. Test này và config đi thành
 * một cặp: không đổi cái này mà quên cái kia.
 */
describe('globals of the jsdom environment installed by setupFiles', () => {
  it('provides matchMedia, ResizeObserver and IntersectionObserver without any extra import', () => {
    expect(typeof window.matchMedia).toBe('function');
    expect(typeof globalThis.ResizeObserver).toBe('function');
    expect(typeof globalThis.IntersectionObserver).toBe('function');
  });

  it('matchMedia returns a MediaQueryList whose matches is a boolean', () => {
    const query = window.matchMedia('(min-width: 768px)');

    expect(query).toBeDefined();
    expect(typeof query.matches).toBe('boolean');
    expect(typeof query.addEventListener).toBe('function');
  });
});
