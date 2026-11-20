/**
 * Edge cases của máy trạng thái scan JSONC (`wrangler-jsonc.ts`): comment
 * marker nội chuỗi, escape, `/` cuối input, block comment không đóng, trailing
 * comma trong/ngoài chuỗi, và hình cơ bản của `parseJsonc`. Helper là bản copy
 * có chủ đích (xem header `wrangler-jsonc.ts`) — spec này cũng giữ nguyên văn
 * ở CẢ HAI deploy project cho tới khi tổng quát hoá lên `@ecoma-io/deployment`
 * cùng engine staging (#543).
 */

import { describe, expect, it } from 'vitest';

import { parseJsonc, stripJsoncComments, stripTrailingCommas } from './wrangler-jsonc.js';

describe('stripJsoncComments', () => {
  it('keeps comment markers and escaped quotes that live inside a string', () => {
    const input = '{"url":"http://x/*y*/ \\"z\\""}';
    expect(stripJsoncComments(input)).toBe(input);
  });

  it('strips line and block comments outside strings', () => {
    expect(stripJsoncComments('// lead\n{"a": /* mid */ 1}')).toBe('\n{"a":  1}');
  });

  it('a lone slash at the end of input passes through without reading past the end', () => {
    expect(stripJsoncComments('{"a":1}/')).toBe('{"a":1}/');
  });

  it('an unterminated block comment fails loud instead of silently truncating', () => {
    expect(() => stripJsoncComments('{"a": /* oops')).toThrow(/unterminated block comment/u);
  });
});

describe('stripTrailingCommas', () => {
  it('drops commas only directly before a closing brace or bracket, outside strings', () => {
    expect(stripTrailingCommas('{"a":1,}')).toBe('{"a":1}');
    expect(stripTrailingCommas('[1,2,]')).toBe('[1,2]');
    expect(stripTrailingCommas('{"a":"b,"}')).toBe('{"a":"b,"}');
    expect(stripTrailingCommas('{"a":[1,2],"b":3}')).toBe('{"a":[1,2],"b":3}');
  });

  it('a comma at the very end of input is kept so JSON.parse fails loud', () => {
    expect(stripTrailingCommas('{"a":1,')).toBe('{"a":1,');
  });
});

describe('parseJsonc', () => {
  it('parses comments plus trailing commas into the annotated shape', () => {
    const parsed = parseJsonc<{ name: string; items: string[] }>(
      '// doc\n{ "name": "x", "items": ["a",], }',
    );
    expect(parsed.name).toBe('x');
    expect(parsed.items).toEqual(['a']);
  });

  it('malformed JSON fails loud from JSON.parse instead of a fabricated value', () => {
    expect(() => parseJsonc('{ nope')).toThrow(/Expected property name/u);
  });
});
