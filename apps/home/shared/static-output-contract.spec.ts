import { describe, expect, it } from 'vitest';
import { MIN_OUTPUT_SVG_ASSETS, assessOutputSvgAssets } from './static-output-contract';

/**
 * Test hàm thuần đánh giá sàn asset output - hợp đồng dùng chung giữa hook
 * build (`modules/static-assets-guard.ts`, throw khi vi phạm) và static-output
 * test (`tests/static-output.spec.ts`, assert cùng hàm). Chốt đúng ba nhánh
 * đánh giá + tính bất biến của thông báo vi phạm (thông báo đó là thứ dev nhìn
 * thấy khi build đỏ, nên phải giữ được hướng chẩn đoán).
 */
describe('assessOutputSvgAssets', () => {
  it('returns null when the count meets the contract floor', () => {
    expect(assessOutputSvgAssets(MIN_OUTPUT_SVG_ASSETS)).toBeNull();
  });

  it('returns null when the count exceeds the contract floor', () => {
    expect(assessOutputSvgAssets(MIN_OUTPUT_SVG_ASSETS + 10)).toBeNull();
  });

  it('reports a violation with the diagnosis path when the count is below the floor', () => {
    const violation = assessOutputSvgAssets(MIN_OUTPUT_SVG_ASSETS - 1);
    expect(violation).not.toBeNull();
    expect(violation).toContain('nuxt-content-assets');
    expect(violation).toContain('Unable to load content config');
  });

  it('reports a violation for an empty assets directory (count 0)', () => {
    const violation = assessOutputSvgAssets(0);
    expect(violation).toContain(String(MIN_OUTPUT_SVG_ASSETS));
    expect(violation).toContain('0 .svg file(s)');
  });
});
