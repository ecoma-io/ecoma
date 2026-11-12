import { describe, expect, it } from 'vitest';

import { checkHeadingContract, REQUIRED_SECTIONS } from './readme-contract.js';
import { parseMarkdown } from './markdown-ast.js';

/**
 * Contract heading của README: H1 duy nhất và sáu section H2 bắt buộc.
 * Fixture là chuỗi Markdown thuần (không đọc ổ) nên các kiểm này chạy nhanh
 * và hoàn toàn-offline.
 *
 * Mỗi kiểm cô lập MỘT chiều của contract: base là một README đầy đủ hợp lệ,
 * rồi thay đúng một phần để khẳng định chiều đó. Như vậy một vi phạm ở chiều
 * khác không che mất vi phạm đang kiểm — và `expect(codes).toEqual([...])` là
 * khẳng định đầy đủ, không phải "có chứa".
 */

const check = (source: string) => checkHeadingContract(parseMarkdown(source), source.split('\n'));

const codes = (source: string) => check(source).map((violation) => violation.code);

/** README đầy đủ hợp lệ: một H1 và sáu section H2, mỗi section có nội dung. */
const validReadme = (): string =>
  '# alpha\n\n' + REQUIRED_SECTIONS.map((name) => `## ${name}\n\nnội dung ${name}\n\n`).join('');

describe('REQUIRED_SECTIONS', () => {
  it('lists the six sections exactly as the contract names them', () => {
    expect(REQUIRED_SECTIONS).toEqual([
      'Purpose',
      'Responsibilities',
      'Boundaries',
      'Development',
      'Testing',
      'Related Documentation',
    ]);
  });
});

describe('H1', () => {
  it('accepts a valid README', () => {
    expect(codes(validReadme())).toEqual([]);
  });

  it('reports a README with no H1', () => {
    const violations = check(validReadme().replace('# alpha\n\n', ''));

    expect(violations).toEqual([
      expect.objectContaining({
        code: 'missing-h1',
        line: 0,
        message: expect.stringContaining('no H1'),
      }),
    ]);
  });

  it('reports every H1 after the first as multiple-h1', () => {
    const violations = check(`${validReadme()}\n# Second H1\n`);

    expect(violations.map((v) => v.code)).toEqual(['multiple-h1']);
    expect(violations[0].message).toContain('line 1');
    expect(violations[0].message).toContain('line 28');
  });

  it('reports an empty H1 heading', () => {
    const violations = check(validReadme().replace('# alpha', '#'));

    expect(violations.map((v) => v.code)).toEqual(['empty-h1']);
    expect(violations[0].message).toContain('no text');
  });
});

describe('required H2 section', () => {
  it('reports each missing required section by name', () => {
    const violations = check('# alpha\n\n## Purpose\n\nnội dung\n');

    const missing = REQUIRED_SECTIONS.slice(1);
    expect(violations.filter((v) => v.code === 'missing-section').map((v) => v.message)).toEqual(
      missing.map((name) => expect.stringContaining(name)),
    );
  });

  it.each(REQUIRED_SECTIONS)('reports "%s" when the section is absent', (name) => {
    const source = validReadme().replace(new RegExp(`## ${name}\\n\\n[^\\n]*\\n\\n`, 'u'), '');

    expect(codes(source)).toEqual(['missing-section']);
    expect(check(source)[0].message).toContain(name);
  });

  it.each(REQUIRED_SECTIONS)('accepts "%s" with non-empty content', (name) => {
    const source = validReadme();

    expect(codes(source)).toEqual([]);
    expect(source).toContain(`## ${name}`);
  });

  it('reports a section whose body is empty before the next heading', () => {
    const source = validReadme().replace('## Purpose\n\nnội dung Purpose\n\n', '## Purpose\n\n');

    expect(codes(source)).toEqual(['empty-section-body']);
    expect(check(source)[0].message).toContain('Purpose');
    expect(check(source)[0].line).toBe(3);
  });

  it('treats a subsection heading as ending the parent section body', () => {
    const source = validReadme().replace(
      '## Purpose\n\nnội dung Purpose\n\n',
      '## Purpose\n\n### subsection\n\nnội dung\n\n',
    );

    expect(codes(source)).toEqual(['empty-section-body']);
  });

  it('counts a code fence, list and quote as non-empty section body', () => {
    const source =
      '# alpha\n\n## Purpose\n\n```ts\nconst x = 1\n```\n\n- list item\n\n> quote\n\n## Responsibilities\n\nnội dung\n\n## Boundaries\n\nnội dung\n\n## Development\n\nnội dung\n\n## Testing\n\nnội dung\n\n## Related Documentation\n\nnội dung\n';

    expect(codes(source)).toEqual([]);
  });

  it('accepts a setext H2 as a required section', () => {
    const source = validReadme().replace(
      '## Testing\n\nnội dung Testing\n\n',
      'Testing\n-------\n\nnội dung\n\n',
    );

    expect(codes(source)).toEqual([]);
  });

  it('treats a case-differing heading as missing but names the near-match in hint', () => {
    const source = validReadme().replace('## Testing\n', '## testing\n');

    expect(codes(source)).toEqual(['missing-section']);
    const violation = check(source)[0];
    expect(violation.message).toContain('differs only in case');
    // Hint nêu đúng heading gần đúng và dòng của nó, để người sửa đi thẳng.
    expect(violation.hint).toContain('rename the heading at line 19');
    expect(violation.hint).toContain('"Testing"');
  });

  it('is case-sensitive: "Testing" satisfies the contract but "testing" does not', () => {
    const good = validReadme();
    const bad = validReadme().replace('## Testing\n', '## testing\n');

    expect(codes(good)).toEqual([]);
    expect(codes(bad)).toEqual(['missing-section']);
  });

  it('reports an empty body for a duplicated required heading', () => {
    const source = validReadme().replace(
      '## Purpose\n\nnội dung Purpose\n\n',
      '## Purpose\n\nnội dung Purpose\n\n## Purpose\n\n',
    );

    const empty = check(source).filter((v) => v.code === 'empty-section-body');
    expect(empty).toHaveLength(1);
    expect(empty[0].message).toContain('Purpose');
  });

  it('does not report a duplicated required heading that has content', () => {
    const source = validReadme().replace(
      '## Purpose\n\nnội dung Purpose\n\n',
      '## Purpose\n\nnội dung Purpose\n\n## Purpose\n\nnội dung lặp\n\n',
    );

    expect(codes(source)).toEqual([]);
  });
});
