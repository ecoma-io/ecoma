import { describe, it, expect } from 'vitest';
// @vitest-environment node
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  ECOMA_LOGO_MARK_X_BBOX,
  ECOMA_LOGO_RTL_MARK_TRANSLATE_X,
  ECOMA_LOGO_RTL_WORDMARK_TRANSLATE_X,
  ECOMA_LOGO_VIEWBOX_WIDTH,
  ECOMA_LOGO_WORDMARK_X_BBOX,
} from '../logo-artwork';

/**
 * Địa lý của phép đảo thứ tự mark ↔ wordmark khi RTL (issue #213).
 *
 * Các con số bbox dưới đây được tính MỘT LẦN từ dữ liệu path của file nguồn
 * `../../assets/ecoma-logo-horizontal.svg` bằng cách giải cực trị giải tích
 * của từng Bézier (q/c) cộng các điểm đầu-cuối đoạn thẳng (m/h/v), rồi làm
 * tròn 6 chữ số thập phân (giá trị thô tích luỹ sai số float ±1e-13 qua ~1000
 * bước relative nhỏ — dưới mọi ngưỡng hiển thị: 1 user unit ≈ 0.36px ở width
 * tự nhiên 160px). Spec này ghim chuỗi hệ quả: path (test khác ghim với file
 * nguồn) → bbox → hằng dịch (công thức `t = W − a − b`) → literal CSS trong
 * `EcomaLogo.vue` — sai một mắt xích nào (đổi artwork mà quên cập nhật số,
 * sửa CSS mà quên hằng) sẽ đỏ ngay tại đây.
 */
const MARK_X_BBOX = { min: 2, max: 81.5 };
const WORDMARK_X_BBOX = { min: 114.2, max: 442.3 };
const VIEWBOX_WIDTH = 444.93300000000005;

/** Nội dung `EcomaLogo.vue` — ghim literal CSS khớp hằng TS trong module artwork. */
const COMPONENT_SOURCE = readFileSync(resolve(import.meta.dirname, 'EcomaLogo.vue'), 'utf8');

/**
 * Công thức phản chiếu qua tâm viewBox: hộp `[a, b]` đổ về `[W−b, W−a]` khi
 * dịch `t = W − a − b`. Đặt ở module scope vì không bắt biến nào từ test.
 */
const mirror = (box: { min: number; max: number }): number => VIEWBOX_WIDTH - box.min - box.max;

describe('EcomaLogo RTL geometry', () => {
  it('matches the x bounding boxes computed from the source path geometry', () => {
    // Ghim bbox trong `logo-artwork.ts` với số tính từ path nguồn: đổi artwork
    // mà quên cập nhật bbox thì mọi phép dịch phía sau đều sai tọa độ.
    expect(ECOMA_LOGO_VIEWBOX_WIDTH).toBe(VIEWBOX_WIDTH);
    expect(ECOMA_LOGO_MARK_X_BBOX).toEqual(MARK_X_BBOX);
    expect(ECOMA_LOGO_WORDMARK_X_BBOX).toEqual(WORDMARK_X_BBOX);
  });

  it('derives each translate from the mirror formula t = W - min - max', () => {
    // Phản chiếu qua TÂM viewBox, không phải soi gương từng nét. Sai số cho
    // phép 1e-9 — hằng đã được làm tròn 6 chữ số thập phân, còn dư dấu phẩy
    // động ở cấp 1e-13.
    expect(ECOMA_LOGO_RTL_MARK_TRANSLATE_X).toBeCloseTo(mirror(MARK_X_BBOX), 9);
    expect(ECOMA_LOGO_RTL_WORDMARK_TRANSLATE_X).toBeCloseTo(mirror(WORDMARK_X_BBOX), 9);
  });

  it('swaps the two groups into complementary halves without overlap', () => {
    // Sau phép dịch: mark ở mép phải, wordmark ở mép trái, hai hộp KHÔNG
    // chồng nhau, và tổng thể vẫn nằm gọn trong [0, W] (không tràn viewBox).
    const markRtl = {
      min: MARK_X_BBOX.min + ECOMA_LOGO_RTL_MARK_TRANSLATE_X,
      max: MARK_X_BBOX.max + ECOMA_LOGO_RTL_MARK_TRANSLATE_X,
    };
    const wordmarkRtl = {
      min: WORDMARK_X_BBOX.min + ECOMA_LOGO_RTL_WORDMARK_TRANSLATE_X,
      max: WORDMARK_X_BBOX.max + ECOMA_LOGO_RTL_WORDMARK_TRANSLATE_X,
    };

    expect(markRtl.min).toBeGreaterThan(wordmarkRtl.max);
    expect(wordmarkRtl.min).toBeGreaterThanOrEqual(0);
    expect(markRtl.max).toBeLessThanOrEqual(VIEWBOX_WIDTH);
  });

  it('preserves the gap between mark and wordmark under the swap', () => {
    // Phản chiếu bảo toàn khoảng cách: khoảng hở LTR (wordmark cách mark) phải
    // đúng bằng khoảng hở RTL (mark cách wordmark) — logo không được nén giãn.
    const gapLtr = WORDMARK_X_BBOX.min - MARK_X_BBOX.max;
    const gapRtl =
      MARK_X_BBOX.min +
      ECOMA_LOGO_RTL_MARK_TRANSLATE_X -
      (WORDMARK_X_BBOX.max + ECOMA_LOGO_RTL_WORDMARK_TRANSLATE_X);

    expect(gapRtl).toBeCloseTo(gapLtr, 9);
  });

  it('spans the mirrored extent of the LTR layout', () => {
    // Tổng thể hai nhóm sau dịch = phản chiếu của tổng thể LTR qua tâm viewBox:
    // mép trái RTL = W − mép phải LTR, mép phải RTL = W − mép trái LTR.
    const unionLtr = {
      min: Math.min(MARK_X_BBOX.min, WORDMARK_X_BBOX.min),
      max: Math.max(MARK_X_BBOX.max, WORDMARK_X_BBOX.max),
    };
    const unionRtlMin = WORDMARK_X_BBOX.min + ECOMA_LOGO_RTL_WORDMARK_TRANSLATE_X;
    const unionRtlMax = MARK_X_BBOX.max + ECOMA_LOGO_RTL_MARK_TRANSLATE_X;

    expect(unionRtlMin).toBeCloseTo(VIEWBOX_WIDTH - unionLtr.max, 9);
    expect(unionRtlMax).toBeCloseTo(VIEWBOX_WIDTH - unionLtr.min, 9);
  });

  it('hardcodes the same translate values in the component CSS as the artwork constants', () => {
    // CSS không đọc được hằng TS nên literal nằm ngay trong `<style scoped>`,
    // lồng bên trong `:global([dir='rtl'])` (dạng phẳng bị compiler nuốt
    // selector — giải thích trong comment của khối style). Ghim hai bên khớp
    // từng ký tự — cùng phong cách với test ghim path `d` với file SVG nguồn
    // trong `ecoma-logo.spec.ts`. Bắt nguyên khối `:global` (cả hai group
    // dùng chung một khối) rồi moi từng rule bên trong.
    const globalBlock = COMPONENT_SOURCE.match(/:global\(\[dir='rtl'\]\)\s*\{([\s\S]*?)\n\}/u)?.[1];
    expect(globalBlock).toBeDefined();

    const rules = [
      ...(globalBlock as string).matchAll(
        /\.ecoma-logo-(mark|wordmark)\s*\{\s*transform:\s*translateX\((-?[\d.]+)px\)/gu,
      ),
    ];
    expect(rules).toHaveLength(2);

    const byGroup = new Map(rules.map((rule) => [rule[1], Number(rule[2])]));
    expect(byGroup.get('mark')).toBe(ECOMA_LOGO_RTL_MARK_TRANSLATE_X);
    expect(byGroup.get('wordmark')).toBe(ECOMA_LOGO_RTL_WORDMARK_TRANSLATE_X);
  });

  it('never mirrors the glyphs', () => {
    // Quyết định thiết kế: CHỈ dịch chuyển, KHÔNG lật. `scaleX(-1)` (hoặc
    // `scale(-1, …)`) làm chữ Latin "ecoma" đọc ngược — sai thương hiệu ngay
    // cả khi hình học "đúng". Ghim trong khối `<style scoped>` thật (không
    // phải toàn file — comment văn xuôi có nhắc đúng chuỗi này để giải thích
    // vì sao cấm, và bản thân chữ `<style>` cũng xuất hiện trong comment đầu
    // file) để mọi biến thể tương lai (media query, selector khác) bị chặn.
    const style = COMPONENT_SOURCE.match(/<style scoped>([\s\S]*?)<\/style>/u)?.[1];

    expect(style).toBeDefined();
    expect(style).toMatch(/translateX\(/u);
    expect(style).not.toMatch(/scaleX?\(\s*-/u);
  });
});
