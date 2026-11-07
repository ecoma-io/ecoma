import { describe, expect, it } from 'vitest';

/**
 * Regression cho các bảng số **tự khai** trong văn bản bài học.
 *
 * Vì sao cần: `verify-examples.py` chạy code và đối chiếu `print` với comment,
 * nhưng nó **không** chạm vào Markdown table hay phương trình hiển thị. Một
 * bảng số trong bài 16 từng in ra `6,710,886,400` cho `4Ld_{model}^2` trong khi
 * tổng bên dưới lại là giá trị đúng của `L = 32` — hai dòng mâu thuẫn nhau, và
 * cả hai đều "hợp lý" với mắt thường. Spec này chặn đúng lớp lỗi đó.
 *
 * Nguyên tắc: **expected tính ở đây, trong test**, không đọc từ bài viết. Bài
 * viết là thứ bị kiểm; nếu lấy số từ bài rồi so với chính bài thì test luôn
 * xanh và vô dụng. Vì vậy hằng số mô hình (`L`, `d_model`, ...) khai lại ở
 * đây một lần nữa, và bảng trong bài được **parse** ra rồi so với giá trị
 * tính được — đổi bảng mà không đổi công thức sẽ đỏ.
 */

const LESSON_16 = import.meta.glob<string>(
  '../content/en/blog/16.training-a-transformer/index.md',
  { query: '?raw', import: 'default', eager: true },
);

const lesson16Raw = Object.values(LESSON_16)[0] ?? '';

/** Body bài viết, bỏ frontmatter. */
const lesson16Body = lesson16Raw.replace(/^---[\s\S]*?---\s*/u, '');

/**
 * Cấu hình mô hình mà bài 16 dùng làm ví dụ. Khai lại ở đây độc lập với bài:
 * đây là "đáp án" mà bảng trong bài phải khớp.
 */
const MODEL = {
  L: 32,
  dModel: 4096,
  dFf: 11008,
  h: 32,
  V: 32000,
} as const;

/** Số trong một ô bảng: bỏ dấu phẩy phân tách nghìn trước khi parse. */
function tableNumber(cell: string): number {
  const cleaned = cell.replace(/[,$\s]/gu, '');
  if (!/^\d+(?:\.\d+)?$/u.test(cleaned)) {
    throw new Error(`not a plain number: ${JSON.stringify(cell)}`);
  }
  return Number(cleaned);
}

/**
 * Bảng markdown đầu tiên có cột `Parameters`. Trả về map nhãn -> giá trị.
 *
 * Bảng là **khối dòng `|` liền nhau**, hai bảng trong bài 16 ngăn cách nhau bằng
 * một dòng trống. Dừng ở dòng trống đầu tiên sau header: phải, vì bảng attention
 * ngay dưới có separator trông y hệt (`| --- | --- | --- |`) và cột thứ hai
 * không phải số.
 */
function parameterTable(body: string): Map<string, number> {
  const values = new Map<string, number>();
  const lines = body.split('\n');
  const start = lines.findIndex((line) => /^\|\s*Component\s*\|/u.test(line.trim()));
  if (start === -1) throw new Error('parameter table header not found');

  for (const line of lines.slice(start + 1)) {
    if (!/^\s*\|/u.test(line)) break; // hết bảng
    const cells = line
      .trim()
      .replace(/^\||\|$/gu, '')
      .split('|')
      .map((cell) => cell.trim());
    // Dòng separator `| --- | --- | --- |`.
    if (cells.every((cell) => /^-+$/u.test(cell))) continue;
    const label = cells[0] ?? '';
    const valueCell = cells[2] ?? '';
    if (valueCell === 'not counted' || valueCell === '—' || valueCell === '') continue;
    values.set(label, tableNumber(valueCell));
  }
  return values;
}

describe('lesson 16 parameter table agrees with its own formulas', () => {
  const attention = 4 * MODEL.L * MODEL.dModel ** 2;
  const feedForward = 3 * MODEL.L * MODEL.dModel * MODEL.dFf;
  const nonEmbedding = attention + feedForward;
  const embedding = 2 * MODEL.V * MODEL.dModel;
  const total = nonEmbedding + embedding;
  const table = parameterTable(lesson16Body);

  it('states the model shape the table is computed from', () => {
    // Không có dòng này thì bảng có thể đúng *với một mô hình khác* và test
    // vẫn xanh — đúng cái lỗi L=100 đã xảy ra.
    for (const token of [
      `$L = ${MODEL.L}`,
      `$d_{model} = ${MODEL.dModel}`,
      `$d_{ff} = ${MODEL.dFf}`,
      `$h = ${MODEL.h}`,
      `$V = ${MODEL.V}`,
    ]) {
      expect(lesson16Body).toContain(token);
    }
  });

  it('prints each component exactly as its formula evaluates', () => {
    expect(table.get('Attention (Q, K, V, output projections)')).toBe(attention);
    expect(table.get('Feed-forward, SwiGLU')).toBe(feedForward);
    expect(table.get('Embedding table and output head (untied)')).toBe(embedding);
    expect(table.get('Total')).toBe(total);
  });

  it('makes the component rows sum to the non-embedding total', () => {
    // Đây là bất biến đã bị vi phạm: hai dòng cộng lại ra 20,237,516,800 trong
    // khi tổng ghi bên dưới là 6,476,005,376.
    expect(attention + feedForward).toBe(table.get('Non-embedding total'));
  });

  it('makes the non-embedding total plus embeddings the stated total', () => {
    expect(nonEmbedding + embedding).toBe(table.get('Total'));
  });

  it('keeps 6N and 6ND consistent with the non-embedding parameter count', () => {
    const sixN = 6 * nonEmbedding;
    expect(sixN).toBeCloseTo(3.886e10, -10);
    // 6ND cho D = 1.4e12 token, và bài phải nói 54.4 ZFLOP chứ không phải 0.54.
    const sixND = sixN * 1.4e12;
    expect(sixND / 1e21).toBeCloseTo(54.4, 1);
    expect(lesson16Body).toContain('54.4');
  });

  it('recomputes the AdamW state figure from the total parameter count', () => {
    // 16 byte/param (bf16 weight + bf16 grad + fp32 master + fp32 m + fp32 v).
    expect((total * 16) / 1e9).toBeCloseTo(108, 0);
    expect(lesson16Body).toContain('108 GB');
  });
});

describe('lesson 16 attention FLOPs carry no factor of the head count', () => {
  const { L, dModel, h } = MODEL;
  const sixN = 6 * (4 * L * dModel ** 2 + 3 * L * dModel * MODEL.dFf);

  it('states the per-token cost without a spurious h factor', () => {
    // Mỗi head rộng `d_model/h`, nên h đầu tổng cùng `d_model`. Công thức
    // `4*L*h*S*d_model` thừa đúng `h` lần — bảng cũ phóng đại 32×.
    expect(lesson16Body).toContain('$4Ld_{model}S$');
    // Dạng có `h` không được xuất hiện ở đây nữa.
    expect(lesson16Body).not.toContain('$4Lhd_{model}S$');
  });

  it('agrees with counting heads individually', () => {
    for (const S of [2048, 4096, 8192]) {
      const perToken = 4 * L * S * dModel;
      const perHeadCount = L * h * 4 * S * S * (dModel / h);
      expect(perToken * S).toBe(perHeadCount);
    }
  });

  it('quotes the crossover at ~74k tokens, not ~2.3k', () => {
    expect(sixN / (4 * L * dModel)).toBeCloseTo(74112, -3);
    expect(lesson16Body).toContain('74000');
    expect(lesson16Body).not.toContain('2300');
  });

  it('keeps every published attention row within a percent of the formula', () => {
    // Bảng "Attention FLOPs per token" phải khớp `4*L*S*d_model`; đây là bảng
    // đã sai 32× ở bản trước.
    const rows = [
      ...lesson16Body.matchAll(/^\|\s*(\d+)\s*\|[^|]*?([\d.]+)\\times10\^\{(\d+)\}\$/gmu),
    ];
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const [, sText, mantissa, exponent] of rows) {
      const S = Number(sText);
      const published = Number(`${mantissa}e${exponent}`);
      // Ba chữ số có nghĩa đã quyết định phần lớn sai số; dùng ngưỡng tương
      // đối để con số làm tròn trong bảng vẫn pass.
      expect(Math.abs(published - 4 * L * S * dModel) / (4 * L * S * dModel)).toBeLessThan(0.005);
    }
  });
});

describe('lesson 16 states activation recomputation as optional', () => {
  it('does not claim distributed training requires full recomputation', () => {
    // Cụm từ cũ là "which distributed training needs" — sai kỹ thuật: recompute
    // là đánh đổi FLOPp lấy bộ nhớ, tùy chọn, không phải điều kiện của sharding.
    expect(lesson16Body).not.toMatch(/recompute[^.]*which\s+\[distributed/iu);
    expect(lesson16Body).not.toMatch(/which\s+\[distributed[^\]]*\]\([^)]*\)\s+needs/iu);
  });

  it('frames it as a compute-memory trade-off and keeps the 8N figure', () => {
    expect(lesson16Body).toContain('8N');
    expect(lesson16Body).toContain('33%');
    // Chi phí hồi tính một lớp ~= 2N/L mỗi token; toàn bộ -> 8N.
    expect(lesson16Body).toContain('2N/L');
  });
});

const LESSON_05 = import.meta.glob<string>(
  '../content/en/blog/05.information-theory-and-cross-entropy/index.md',
  { query: '?raw', import: 'default', eager: true },
);

const lesson05Body = (Object.values(LESSON_05)[0] ?? '').replace(/^---[\s\S]*?---\s*/u, '');

/**
 * Bài 05 từng in phần đóng góp từng token của KL theo `H - CE` thay vì
 * `CE - H`. Tổng vẫn ra đúng 0.033147 vì hai số chỉ đổi chỗ, nên **không**
 * lỗi nào khác bắt được: bài chạy, bảng khớp, prose khớp — nhưng mọi dấu đều
 * đảo và câu "over-assigning costs more" thành sai. Đây là lớp lỗi mà test
 * phải chặn riêng: đảo thứ tự hai số hạn mà tổng vẫn đúng.
 */
describe('lesson 05 per-token KL decomposition keeps its sign convention', () => {
  const q = [0.4, 0.3, 0.2, 0.1];
  const p = [0.5, 0.25, 0.15, 0.1];

  const ce = q.map((qi, i) => qi * -Math.log2(p[i]));
  const h = q.map((qi) => qi * -Math.log2(qi));
  const perToken = ce.map((value, i) => value - h[i]);
  const total = perToken.reduce((sum, value) => sum + value, 0);
  const hq = h.reduce((sum, value) => sum + value, 0);

  it('computes a per-token KL that sums to the reported total', () => {
    expect(total).toBeCloseTo(0.033147, 6);
    expect(total).toBeCloseTo(1.879586 - hq, 6);
  });

  it('gives a negative contribution to the over-assigned token and positive to the starved one', () => {
    // p[0] = 0.50 > q[0] = 0.40: over-assigning a frequent token leaves less
    // surprisal to pay there, so its own contribution goes negative.
    expect(perToken[0]).toBeCloseTo(-0.128771, 6);
    // p[1] = 0.25 < q[1] = 0.30: starved, so it carries a positive penalty.
    expect(perToken[1]).toBeCloseTo(0.07891, 6);
    expect(perToken[2]).toBeCloseTo(0.083007, 6);
    // p[3] = q[3]: exactly zero.
    expect(perToken[3]).toBeCloseTo(0, 12);
  });

  it('publishes those signed values, not their negation', () => {
    expect(lesson05Body).toContain('-0.128771');
    expect(lesson05Body).toContain('+0.078910');
    expect(lesson05Body).toContain('+0.083007');
    // Dạng đảo dấu từng bản cũ không được xuất hiện nữa.
    expect(lesson05Body).not.toMatch(/0\.528771\s*-\s*0\.400000/gu);
    expect(lesson05Body).not.toMatch(/-0\.521090\s*\+\s*0\.600000/gu);
  });

  it('adds up the published per-token values in the prose to the same total', () => {
    // Chỉ kiểm từng số rời rạc là không đủ: bản cũ có thể in đúng từng số ở
    // hai chỗ khác nhau rồi đảo dấu cả dãi cộng, và test vẫn xanh vì mọi giá
    // trị đều khớp. Phải bắt đúng dấu của chính phép cộng trong văn bản.
    //
    // Dải số được liệt kê **trước** dãi cộng, nên phải so khớp trên chính
    // biểu thức cộng — lấy "ba số có dấu đầu tiên" thì đọc trúng phần liệt kê
    // và đảo dấu dãi cộng không bao giờ làm đỏ. Dấu ở từng số hạn là **tùy
    // chọn**: trong `$-0.128771 + 0.078910 + ...$` chỉ số hạn đầu mang dấu
    // âm, các số sau dương nên không cần `+` phía trước. Vế phải cũng bắt
    // luôn để kiểm cả phương trình, chứ không chỉ dãi cộng.
    const addition = lesson05Body.match(
      /([+-]?0\.\d{6})\s*\+\s*([+-]?0\.\d{6})\s*\+\s*([+-]?0\.\d{6})\s*=\s*([+-]?0\.\d{6})/u,
    );
    expect(addition).not.toBeNull();
    const [, a, b, c, rhs] = addition as RegExpMatchArray;
    // Ngưỡng 1e-5 là sai số làm tròn của chính ba số in ra: mỗi số bị cắt ở
    // 6 chữ số thập phân nên tổng lệch ~6e-7 so với tổng từ số chưa làm tròn.
    // Vẫn bắt được đảo dấu (sai số 0.0663 cho trường hợp đảo cả ba).
    expect(Number(a) + Number(b) + Number(c)).toBeCloseTo(total, 5);
    expect(Number(rhs)).toBeCloseTo(total, 5);
    // Và từng số hạn phải đúng dấu như bản sửa.
    expect(Number(a)).toBeCloseTo(perToken[0], 6);
    expect(Number(b)).toBeCloseTo(perToken[1], 6);
    expect(Number(c)).toBeCloseTo(perToken[2], 6);
  });

  it('subtracts the entropy term from the cross-entropy term in the runnable block', () => {
    // Bug nằm ở cả prose lẫn code: `self_term - model_term` đảo dấu toàn bộ.
    expect(lesson05Body).toContain('model_term - self_term');
    expect(lesson05Body).not.toContain('self_term - model_term');
  });
});
