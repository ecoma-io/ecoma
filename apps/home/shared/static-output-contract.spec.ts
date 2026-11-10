import { describe, expect, it } from 'vitest';
import { EXPECTED_OUTPUT_HTML_PATHS, assessOutputHtmlInventory } from './static-output-contract';

/**
 * Test hàm thuần đánh giá inventory HTML output — hợp đồng dùng chung của
 * static-output test (`tests/static-output.spec.ts`, assert cùng hàm trên
 * artifact build thật). Chốt đúng các nhánh đánh giá (khớp, thiếu, thừa,
 * vừa thiếu vừa thừa) và tính bất biến của thông báo vi phạm (thông báo đó
 * là thứ dev nhìn thấy khi test đỏ, nên phải giữ được hướng chẩn đoán).
 */
describe('assessOutputHtmlInventory', () => {
  it('returns null when the inventory matches the contract exactly', () => {
    expect(assessOutputHtmlInventory([...EXPECTED_OUTPUT_HTML_PATHS])).toBeNull();
  });

  it('returns null when the actual paths are in any order', () => {
    expect(assessOutputHtmlInventory([...EXPECTED_OUTPUT_HTML_PATHS].toReversed())).toBeNull();
  });

  it('reports missing prerendered HTML with the build-side diagnosis path', () => {
    const violation = assessOutputHtmlInventory(['404.html']);
    expect(violation).not.toBeNull();
    expect(violation).toContain('en/index.html');
    expect(violation).toContain('vi/index.html');
    expect(violation).toContain('Missing:');
    expect(violation).toContain('prerender.routes');
  });

  it('reports every missing file when the artifact is empty', () => {
    const violation = assessOutputHtmlInventory([]);
    expect(violation).toContain(EXPECTED_OUTPUT_HTML_PATHS.join(', '));
    expect(violation).toContain('expected exactly');
  });

  it('reports unexpected HTML files as a contract violation', () => {
    const violation = assessOutputHtmlInventory([
      ...EXPECTED_OUTPUT_HTML_PATHS,
      'en/docs/index.html',
    ]);
    expect(violation).toContain('Unexpected:');
    expect(violation).toContain('en/docs/index.html');
    expect(violation).toContain('EXPECTED_OUTPUT_HTML_PATHS');
  });

  it('reports both missing and unexpected files in one message', () => {
    const violation = assessOutputHtmlInventory(['en/index.html', 'vi/index.html', 'old.html']);
    expect(violation).toContain('Missing:');
    expect(violation).toContain('404.html');
    expect(violation).toContain('Unexpected:');
    expect(violation).toContain('old.html');
  });

  it('treats duplicate actual entries as one path, not an extra file', () => {
    expect(assessOutputHtmlInventory([...EXPECTED_OUTPUT_HTML_PATHS, 'en/index.html'])).toBeNull();
  });
});
