/**
 * Unit test của body builder `/v1/models` — port của 4 test Rust
 * `src/models.rs` (`#[cfg(test)] mod tests`): shape OpenAI-compatible, thứ tự
 * phần tử và escaping phải byte-tương-thích với runtime Rust.
 */
import { describe, expect, it } from 'vitest';

import { jsonEscape, modelsListBody, type ServingModel } from './models';

function model(id: string, created: number, ownedBy: string): ServingModel {
  return { id, created, ownedBy };
}

describe('modelsListBody', () => {
  it('empty catalogue keeps the frozen empty list body', () => {
    expect(modelsListBody([])).toBe('{"object":"list","data":[]}');
  });

  it('one model renders the OpenAI compatible shape', () => {
    const body = modelsListBody([model('dronie-flash', 1_760_000_000, 'dronie')]);
    expect(body).toBe(
      '{"object":"list","data":[{"id":"dronie-flash","object":"model","created":1760000000,"owned_by":"dronie"}]}',
    );
  });

  it('models render in given order without separating comma issues', () => {
    const body = modelsListBody([model('model-a', 1, 'tenant-a'), model('model-b', 2, 'tenant-b')]);
    expect(body).toBe(
      '{"object":"list","data":[{"id":"model-a","object":"model","created":1,"owned_by":"tenant-a"},{"id":"model-b","object":"model","created":2,"owned_by":"tenant-b"}]}',
    );
  });
});

describe('jsonEscape', () => {
  it('neutralizes quotes and backslashes', () => {
    expect(jsonEscape('a"b\\c')).toBe('a\\"b\\\\c');
  });
});
