import { describe, expect, it } from 'vitest';

import {
  TEMPLATE_SCHEMA_MAX_KEYS,
  TEMPLATE_SCHEMA_VERSION,
  TEMPLATE_STRING_MAX_LENGTH_LIMIT,
  TEMPLATE_VARIABLE_KEY_PATTERN,
  parseTemplateSchema,
  validateTemplateUrl,
  validateVariablesAgainstSchema,
} from './mail-template-schema';

/**
 * Parse schema ở một tiến trình: hàm trả union, và mọi ca dưới đây cần schema đã parse. Ném khi
 * parse thất bại để một fixture sai lộ ra ngay ở chỗ dùng, thay vì trả `undefined` lặng lẽ.
 */
function schemaOf(rawJson: string) {
  const parsed = parseTemplateSchema(rawJson);

  if (!parsed.ok) {
    throw new Error(`fixture_has_broken_schema:${parsed.reason}`);
  }

  return parsed.schema;
}

/** Schema hợp lệ tối giản, đủ cho các ca kiểm giá trị biến. */
const OTP_SCHEMA = schemaOf(
  JSON.stringify({
    schema_version: 1,
    variables: {
      otp: { type: 'string', required: true, max_length: 8 },
      name: { type: 'string', required: false, max_length: 200 },
    },
  }),
);

/**
 * Schema hợp lệ với `count` biến `string` optional — dùng để chạm hai đầu ngưỡng 50 key.
 */
function schemaWithNKeys(count: number): string {
  return JSON.stringify({
    schema_version: 1,
    variables: Object.fromEntries(
      Array.from({ length: count }, (_unused, index) => [
        `k${index}`,
        { type: 'string', required: false },
      ]),
    ),
  });
}

describe('parseTemplateSchema — every deviation is broken-schema', () => {
  it('exposes the closed constants of the subset format', () => {
    expect(TEMPLATE_SCHEMA_VERSION).toBe(1);
    expect(TEMPLATE_SCHEMA_MAX_KEYS).toBe(50);
    expect(TEMPLATE_STRING_MAX_LENGTH_LIMIT).toBe(10_000);
    expect(TEMPLATE_VARIABLE_KEY_PATTERN.test('otp')).toBe(true);
    expect(TEMPLATE_VARIABLE_KEY_PATTERN.test('has space')).toBe(false);
  });

  it('accepts the documented example schema', () => {
    const parsed = parseTemplateSchema(
      JSON.stringify({
        schema_version: 1,
        variables: {
          otp: { type: 'string', required: true, max_length: 8 },
          name: { type: 'string', required: true, max_length: 200 },
          cta_url: { type: 'string', required: true, max_length: 2048, format: 'url' },
          org: { type: 'string', required: false, max_length: 200 },
          ttl: { type: 'number', required: false, nullable: true },
        },
      }),
    );

    expect(parsed.ok).toBe(true);

    if (!parsed.ok) {
      return;
    }

    expect(parsed.schema.get('otp')).toEqual({
      type: 'string',
      required: true,
      nullable: false,
      maxLength: 8,
      format: null,
    });
    expect(parsed.schema.get('cta_url')?.format).toBe('url');
    // `nullable` không khai báo → mặc định `false`; `max_length`/`format` không khai báo → `null`.
    expect(parsed.schema.get('org')?.nullable).toBe(false);
    expect(parsed.schema.get('ttl')).toEqual({
      type: 'number',
      required: false,
      nullable: true,
      maxLength: null,
      format: null,
    });
  });

  it('rejects a null, empty or unparseable schema', () => {
    // Cột `NULL`/rỗng/không parse được vào **đúng** nhánh fail-closed này, không được coi là
    // "không có biến" — coi vậy là render một lá thư không có nội dung và không ai biết.
    for (const raw of [null, '', '   ', 'not json', '{', '[]', '"text"', '123', 'null']) {
      expect(parseTemplateSchema(raw)).toEqual({ ok: false, reason: 'broken-schema' });
    }
  });

  it('rejects an unsupported schema_version instead of guessing', () => {
    for (const version of [0, 2, 99, '1', 1.5, null, undefined]) {
      const raw = JSON.stringify({
        schema_version: version,
        variables: { otp: { type: 'string', required: true } },
      });

      expect(parseTemplateSchema(raw)).toEqual({ ok: false, reason: 'broken-schema' });
    }
  });

  it('rejects a non-object variables map', () => {
    for (const variables of [[], 'x', 1, null, true]) {
      const raw = JSON.stringify({ schema_version: 1, variables });

      expect(parseTemplateSchema(raw)).toEqual({ ok: false, reason: 'broken-schema' });
    }

    // `variables` vắng mặt hoàn toàn cũng là schema không hợp lệ.
    expect(parseTemplateSchema(JSON.stringify({ schema_version: 1 }))).toEqual({
      ok: false,
      reason: 'broken-schema',
    });
  });

  it('rejects an unknown field inside a variable spec', () => {
    // Im lặng bỏ qua field lạ nghĩa là template bị xem là hợp lệ trong khi luật thực thi chỉ hiểu
    // một phần — và `seed` sẽ không bắt được.
    for (const extra of [{ pattern: '^a' }, { enum: [1] }, { minimum: 0 }, { extra: true }]) {
      const raw = JSON.stringify({
        schema_version: 1,
        variables: { otp: { type: 'string', required: true, ...extra } },
      });

      expect(parseTemplateSchema(raw)).toEqual({ ok: false, reason: 'broken-schema' });
    }
  });

  it('rejects an unknown field at the schema root', () => {
    const raw = JSON.stringify({
      schema_version: 1,
      variables: {},
      additional_variables: true,
    });

    expect(parseTemplateSchema(raw)).toEqual({ ok: false, reason: 'broken-schema' });
  });

  it('rejects a field that does not apply to the declared type', () => {
    // `max_length`/`format` chỉ áp dụng khi `type = 'string'`; đặt chúng trên `number`/`boolean` là
    // schema **không hợp lệ**, không phải "bỏ qua".
    for (const variable of [
      { type: 'number', required: true, max_length: 8 },
      { type: 'boolean', required: true, max_length: 8 },
      { type: 'number', required: true, format: 'url' },
      { type: 'boolean', required: true, format: 'url' },
    ]) {
      const raw = JSON.stringify({ schema_version: 1, variables: { v: variable } });

      expect(parseTemplateSchema(raw)).toEqual({ ok: false, reason: 'broken-schema' });
    }
  });

  it('rejects a type outside string, number and boolean', () => {
    // v1 không có `object`/`array`.
    for (const type of ['object', 'array', 'Object', 'str', 'integer', '', 1, null]) {
      const raw = JSON.stringify({
        schema_version: 1,
        variables: { v: { type, required: true } },
      });

      expect(parseTemplateSchema(raw)).toEqual({ ok: false, reason: 'broken-schema' });
    }
  });

  it('requires required to be an explicitly declared boolean', () => {
    // `required` **khai báo tường minh** — không có mặc định ngầm.
    for (const required of [undefined, 'true', 1, 0, null]) {
      const raw = JSON.stringify({ schema_version: 1, variables: { v: { required } } });

      expect(parseTemplateSchema(raw)).toEqual({ ok: false, reason: 'broken-schema' });
    }
  });

  it('rejects a non-boolean nullable', () => {
    for (const nullable of ['true', 1, 0, null]) {
      const raw = JSON.stringify({
        schema_version: 1,
        variables: { v: { type: 'string', required: true, nullable } },
      });

      expect(parseTemplateSchema(raw)).toEqual({ ok: false, reason: 'broken-schema' });
    }
  });

  it('rejects max_length outside 1..10000', () => {
    for (const maxLength of [0, -1, 10_001, 1.5, '8', true, null]) {
      const raw = JSON.stringify({
        schema_version: 1,
        variables: { v: { type: 'string', required: true, max_length: maxLength } },
      });

      expect(parseTemplateSchema(raw)).toEqual({ ok: false, reason: 'broken-schema' });
    }

    // Hai đầu khoảng đều hợp lệ.
    for (const maxLength of [1, TEMPLATE_STRING_MAX_LENGTH_LIMIT]) {
      const raw = JSON.stringify({
        schema_version: 1,
        variables: { v: { type: 'string', required: true, max_length: maxLength } },
      });

      expect(parseTemplateSchema(raw).ok).toBe(true);
    }
  });

  it('rejects a format other than url', () => {
    for (const format of ['email', 'uri', 'URL', '', 1, true]) {
      const raw = JSON.stringify({
        schema_version: 1,
        variables: { v: { type: 'string', required: true, format } },
      });

      expect(parseTemplateSchema(raw)).toEqual({ ok: false, reason: 'broken-schema' });
    }
  });

  it('rejects a key outside the pattern and more than 50 keys', () => {
    for (const key of ['', 'has space', 'has-dash', 'has.dot', 'a'.repeat(65)]) {
      const raw = JSON.stringify({
        schema_version: 1,
        variables: { [key]: { type: 'string', required: true } },
      });

      expect(parseTemplateSchema(raw)).toEqual({ ok: false, reason: 'broken-schema' });
    }

    expect(parseTemplateSchema(schemaWithNKeys(TEMPLATE_SCHEMA_MAX_KEYS)).ok).toBe(true);
    expect(parseTemplateSchema(schemaWithNKeys(TEMPLATE_SCHEMA_MAX_KEYS + 1))).toEqual({
      ok: false,
      reason: 'broken-schema',
    });
  });
});

describe('validateVariablesAgainstSchema — required, optional and null', () => {
  it('rejects a key the schema does not declare', () => {
    expect(validateVariablesAgainstSchema(OTP_SCHEMA, { otp: '1', extra: 'x' })).toEqual({
      ok: false,
      reason: 'invalid_request',
    });
  });

  it('rejects a missing required variable and accepts a missing optional one', () => {
    expect(validateVariablesAgainstSchema(OTP_SCHEMA, {})).toEqual({
      ok: false,
      reason: 'invalid_request',
    });

    const optionalMissing = validateVariablesAgainstSchema(OTP_SCHEMA, { otp: '1' });

    expect(optionalMissing.ok).toBe(true);

    if (!optionalMissing.ok) {
      return;
    }

    // Biến optional vắng mặt **không** có trong normalized — không có mặc định ngầm, vì chèn
    // default trước khi fingerprint sẽ biến hai request vốn khác nhau thành một.
    expect(optionalMissing.normalized.has('name')).toBe(false);
    expect(optionalMissing.normalized.get('otp')).toBe('1');
  });

  it('rejects null on a non-nullable variable and accepts it on a nullable one', () => {
    expect(validateVariablesAgainstSchema(OTP_SCHEMA, { otp: null })).toEqual({
      ok: false,
      reason: 'invalid_request',
    });

    const nullableSchema = schemaOf(
      JSON.stringify({
        schema_version: 1,
        variables: { ttl: { type: 'number', required: true, nullable: true } },
      }),
    );
    const withNull = validateVariablesAgainstSchema(nullableSchema, { ttl: null });

    expect(withNull.ok).toBe(true);

    if (!withNull.ok) {
      return;
    }

    // `null` được **giữ** trong normalized: nó khác vắng mặt ở canonical (FR-002).
    expect(withNull.normalized.has('ttl')).toBe(true);
    expect(withNull.normalized.get('ttl')).toBeNull();
  });

  it('treats a present null as satisfying required, because required is about absence', () => {
    const nullableSchema = schemaOf(
      JSON.stringify({
        schema_version: 1,
        variables: { ttl: { type: 'number', required: true, nullable: true } },
      }),
    );

    expect(validateVariablesAgainstSchema(nullableSchema, { ttl: null }).ok).toBe(true);
    expect(validateVariablesAgainstSchema(nullableSchema, {}).ok).toBe(false);
  });
});

describe('validateVariablesAgainstSchema — no coercion between types', () => {
  const numberSchema = schemaOf(
    JSON.stringify({
      schema_version: 1,
      variables: {
        count: { type: 'number', required: true },
        flag: { type: 'boolean', required: true },
        text: { type: 'string', required: true },
      },
    }),
  );

  it('rejects a number where a string is declared', () => {
    // `1` và `"1"` là **hai** giá trị khác nhau; không tự ép kiểu.
    expect(
      validateVariablesAgainstSchema(numberSchema, { count: '1', flag: true, text: 'x' }),
    ).toEqual({
      ok: false,
      reason: 'invalid_request',
    });
    expect(
      validateVariablesAgainstSchema(numberSchema, { count: 1, flag: true, text: 'x' }).ok,
    ).toBe(true);
  });

  it('rejects a boolean given to a string and a string given to a boolean', () => {
    expect(
      validateVariablesAgainstSchema(numberSchema, { count: 1, flag: true, text: true }),
    ).toEqual({ ok: false, reason: 'invalid_request' });
    expect(
      validateVariablesAgainstSchema(numberSchema, { count: 1, flag: 'true', text: 'x' }),
    ).toEqual({ ok: false, reason: 'invalid_request' });
  });

  it('accepts any finite IEEE-754 double for a number', () => {
    for (const count of [0, -1, -0.5, 1.5, 1e21, Number.MAX_SAFE_INTEGER]) {
      expect(
        validateVariablesAgainstSchema(numberSchema, { count, flag: true, text: 'x' }).ok,
      ).toBe(true);
    }
  });

  it('rejects a non-finite number rather than serializing it as null', () => {
    // `1e400` là JSON hợp lệ nhưng parse ra `Infinity`; nó phải ra `400`, không thành `null`.
    expect(
      validateVariablesAgainstSchema(numberSchema, {
        count: Number.POSITIVE_INFINITY,
        flag: true,
        text: 'x',
      }),
    ).toEqual({ ok: false, reason: 'invalid_request' });
    expect(
      validateVariablesAgainstSchema(numberSchema, {
        count: Number.NaN,
        flag: true,
        text: 'x',
      }),
    ).toEqual({ ok: false, reason: 'invalid_request' });
  });

  it('rejects an object or array even when this function stands alone', () => {
    // Ở v1 shape đã chặn trước, nhưng hàm này vẫn phải đứng được một mình: schema khai báo `type`
    // và `typeof` không khớp bất kỳ kiểu nào trong v1.
    expect(
      validateVariablesAgainstSchema(numberSchema, {
        count: { nested: 1 },
        flag: true,
        text: 'x',
      }),
    ).toEqual({ ok: false, reason: 'invalid_request' });
  });
});

describe('validateVariablesAgainstSchema — max_length on the original value', () => {
  const boundedSchema = schemaOf(
    JSON.stringify({
      schema_version: 1,
      variables: { name: { type: 'string', required: true, max_length: 10 } },
    }),
  );

  it('accepts a value exactly at the bound and rejects one past it', () => {
    expect(validateVariablesAgainstSchema(boundedSchema, { name: 'a'.repeat(10) }).ok).toBe(true);
    expect(validateVariablesAgainstSchema(boundedSchema, { name: 'a'.repeat(11) })).toEqual({
      ok: false,
      reason: 'invalid_request',
    });
  });

  it('measures the original value in UTF-16 code units, before any escaping', () => {
    // Mười ký tự `&` đúng ngưỡng; sau HTML escape thành `&amp;` (5 ký tự) là 50, nhưng độ dài để
    // validate và độ dài sau escape là **hai thứ khác nhau**.
    expect(validateVariablesAgainstSchema(boundedSchema, { name: '&'.repeat(10) }).ok).toBe(true);
    expect(validateVariablesAgainstSchema(boundedSchema, { name: '&'.repeat(11) }).ok).toBe(false);

    // Ca biên có ký tự astral: 5 emoji = 10 code unit, đúng ngưỡng.
    expect(validateVariablesAgainstSchema(boundedSchema, { name: '😀😀😀😀😀' }).ok).toBe(true);
    expect(validateVariablesAgainstSchema(boundedSchema, { name: '😀😀😀😀😀😀' }).ok).toBe(false);
  });
});

describe('validateTemplateUrl — absolute https inside the label boundary', () => {
  it('accepts an https URL whose host matches exactly or as a dotted suffix', () => {
    for (const value of [
      'https://example.com/reset',
      'https://a.example.com/reset',
      'https://deep.sub.example.com/reset',
    ]) {
      expect(validateTemplateUrl(value, ['example.com'])).toEqual({ ok: true });
    }
  });

  it('does not match evil-example.com against an example.com allowlist', () => {
    // So khớp chuỗi con là lỗ hổng: `evil-example.com` chứa `example.com` nhưng là host khác.
    expect(validateTemplateUrl('https://evil-example.com/x', ['example.com'])).toEqual({
      ok: false,
      reason: 'invalid_request',
    });
    expect(validateTemplateUrl('https://notexample.com/x', ['example.com'])).toEqual({
      ok: false,
      reason: 'invalid_request',
    });
    expect(validateTemplateUrl('https://example.com.evil.test/x', ['example.com'])).toEqual({
      ok: false,
      reason: 'invalid_request',
    });
  });

  it('requires https and rejects every other scheme', () => {
    for (const value of [
      'http://example.com/x',
      'javascript:alert(1)',
      'data:text/html,<script>',
      'ftp://example.com/x',
      'mailto:a@example.com',
    ]) {
      expect(validateTemplateUrl(value, ['example.com'])).toEqual({
        ok: false,
        reason: 'invalid_request',
      });
    }
  });

  it('rejects userinfo, because it hides the real host from a reader', () => {
    for (const value of [
      'https://user@example.com/x',
      'https://user:pass@example.com/x',
      'https://example.com@evil.test/x',
    ]) {
      expect(validateTemplateUrl(value, ['example.com'])).toEqual({
        ok: false,
        reason: 'invalid_request',
      });
    }
  });

  it('rejects a relative or unparseable value', () => {
    for (const value of ['/reset', 'reset', '', 'https://', 'not a url']) {
      expect(validateTemplateUrl(value, ['example.com'])).toEqual({
        ok: false,
        reason: 'invalid_request',
      });
    }
  });

  it('compares the punycoded hostname, so an IDN matches its A-label', () => {
    expect(validateTemplateUrl('https://bücher.example/x', ['xn--bcher-kva.example'])).toEqual({
      ok: true,
    });
    expect(validateTemplateUrl('https://bücher.example/x', ['bücher.example'])).toEqual({
      ok: true,
    });
    expect(validateTemplateUrl('https://bücher.example/x', ['example.com'])).toEqual({
      ok: false,
      reason: 'invalid_request',
    });
  });

  it('reports an empty allowlist as a server configuration failure, not a bad request', () => {
    // Allowlist rỗng là lỗi cấu hình → `503`, không phải `400`: trùng lý do thì một deploy thiếu
    // cấu hình sẽ trả `400` và không ai thấy nó là sự cố vận hành.
    expect(validateTemplateUrl('https://example.com/x', [])).toEqual({
      ok: false,
      reason: 'allowlist_unconfigured',
    });
  });

  it('is case-insensitive on the allowlist entry', () => {
    expect(validateTemplateUrl('https://EXAMPLE.com/x', ['example.com'])).toEqual({ ok: true });
    expect(validateTemplateUrl('https://example.com/x', ['EXAMPLE.COM'])).toEqual({ ok: true });
  });
});

describe('validateVariablesAgainstSchema — format url is only applied to a present value', () => {
  const urlSchema = schemaOf(
    JSON.stringify({
      schema_version: 1,
      variables: {
        cta_url: { type: 'string', required: false, max_length: 2048, format: 'url' },
      },
    }),
  );

  it('rejects a host outside the allowlist', () => {
    expect(
      validateVariablesAgainstSchema(urlSchema, { cta_url: 'https://evil.test/x' }, [
        'example.com',
      ]),
    ).toEqual({ ok: false, reason: 'invalid_request' });
  });

  it('accepts a missing optional url variable without applying the URL rule', () => {
    const missing = validateVariablesAgainstSchema(urlSchema, {}, ['example.com']);

    expect(missing.ok).toBe(true);

    if (!missing.ok) {
      return;
    }

    expect(missing.normalized.has('cta_url')).toBe(false);
  });

  it('accepts a null on a nullable url variable without applying the URL rule', () => {
    const nullableUrlSchema = schemaOf(
      JSON.stringify({
        schema_version: 1,
        variables: {
          cta_url: {
            type: 'string',
            required: false,
            nullable: true,
            max_length: 2048,
            format: 'url',
          },
        },
      }),
    );

    expect(
      validateVariablesAgainstSchema(nullableUrlSchema, { cta_url: null }, ['example.com']).ok,
    ).toBe(true);
  });

  it('surfaces allowlist_unconfigured separately from invalid_request', () => {
    // Allowlist rỗng + biến url có mặt ⇒ `503`; allowlist rỗng + biến url vắng mặt ⇒ hợp lệ, vì
    // luật URL không áp lên giá trị vắng mặt.
    expect(
      validateVariablesAgainstSchema(urlSchema, { cta_url: 'https://example.com/x' }, []),
    ).toEqual({ ok: false, reason: 'allowlist_unconfigured' });
    expect(validateVariablesAgainstSchema(urlSchema, {}, [])).toEqual({
      ok: true,
      normalized: expect.anything(),
    });
  });
});
