import { describe, expect, it } from 'vitest';

import { escapeHtmlAttribute, escapeHtmlText, renderMail } from './mail-render';
import { parseTemplateSchema } from './mail-template-schema';

/** Schema parse từ JSON literal, ném nếu fixture sai — lỗi fixture lộ ra ngay tại chỗ dùng. */
function schemaOf(rawJson: string) {
  const parsed = parseTemplateSchema(rawJson);

  if (!parsed.ok) {
    throw new Error(`fixture_has_broken_schema:${parsed.reason}`);
  }

  return parsed.schema;
}

/** Schema hai biến: `name` (string, optional) và `count` (number, optional). */
const TWO_VARIABLE_SCHEMA = schemaOf(
  JSON.stringify({
    schema_version: 1,
    variables: {
      name: { type: 'string', required: false, max_length: 200 },
      count: { type: 'number', required: false },
    },
  }),
);

/**
 * Escape của context subject trong các ca render dưới đây.
 *
 * Header MIME không phải HTML, nên hàm này **identity** — xem `create-mail-message.ts`. Ở đây dùng
 * identity để `renderMail` được kiểm đúng trách nhiệm của nó: thay placeholder, kiểm control
 * character, và không render lần hai.
 */
const IDENTITY_ESCAPE = (value: string): string => value;

function render(input: {
  subjectTemplate?: string;
  bodyTemplate?: string;
  schema?: ReturnType<typeof schemaOf>;
  normalized?: ReadonlyMap<string, unknown>;
  escapeSubject?: (value: string) => string;
}) {
  return renderMail({
    subjectTemplate: input.subjectTemplate ?? 'Subject',
    bodyTemplate: input.bodyTemplate ?? 'Body',
    schema: input.schema ?? TWO_VARIABLE_SCHEMA,
    normalized: input.normalized ?? new Map<string, unknown>(),
    htmlEscapeForSubject: input.escapeSubject ?? IDENTITY_ESCAPE,
  });
}

describe('renderMail — placeholder substitution', () => {
  it('substitutes a value in both subject and body', () => {
    const normalized = new Map<string, unknown>([['name', 'An']]);

    expect(
      render({
        subjectTemplate: 'Hello {{ name }}',
        bodyTemplate: '<p>Hi {{name}}</p>',
        normalized,
      }),
    ).toEqual({ ok: true, subject: 'Hello An', body: '<p>Hi An</p>' });
  });

  it('tolerates whitespace inside the braces', () => {
    const normalized = new Map<string, unknown>([['name', 'An']]);

    for (const template of ['{{name}}', '{{ name }}', '{{  name  }}', '{{\tname\t}}']) {
      const result = render({ subjectTemplate: template, normalized });

      expect(result.ok && result.subject).toBe('An');
    }
  });

  it('renders a missing optional variable as an empty string without crashing', () => {
    // FR-003: biến optional vắng mặt → hợp lệ, `{{ var }}` render thành **chuỗi rỗng**.
    const result = render({ subjectTemplate: 'Hello {{ name }}', bodyTemplate: 'Hi {{ name }}' });

    expect(result).toEqual({ ok: true, subject: 'Hello ', body: 'Hi ' });
  });

  it('renders null, zero and false rather than treating them as absent', () => {
    const nullSchema = schemaOf(
      JSON.stringify({
        schema_version: 1,
        variables: { ttl: { type: 'number', required: false, nullable: true } },
      }),
    );
    const nullable = new Map<string, unknown>([['ttl', null]]);

    expect(
      render({ subjectTemplate: '[{{ ttl }}]', schema: nullSchema, normalized: nullable }),
    ).toEqual({ ok: true, subject: '[]', body: 'Body' });

    const numbers = new Map<string, unknown>([['count', 0]]);

    expect(render({ subjectTemplate: '[{{ count }}]', normalized: numbers })).toEqual({
      ok: true,
      subject: '[0]',
      body: 'Body',
    });

    const booleanSchema = schemaOf(
      JSON.stringify({
        schema_version: 1,
        variables: { flag: { type: 'boolean', required: false } },
      }),
    );

    for (const [flag, rendered] of [
      [true, 'true'],
      [false, 'false'],
    ] as const) {
      const result = render({
        subjectTemplate: '[{{ flag }}]',
        schema: booleanSchema,
        normalized: new Map<string, unknown>([['flag', flag]]),
      });

      expect(result.ok && result.subject).toBe(`[${rendered}]`);
    }
  });

  it('renders a number with the ECMAScript Number::toString form', () => {
    const numbers = new Map<string, unknown>([['count', 1.5]]);

    expect(render({ subjectTemplate: '[{{ count }}]', normalized: numbers })).toEqual({
      ok: true,
      subject: '[1.5]',
      body: 'Body',
    });
  });

  it('rejects a placeholder the schema does not declare instead of silently emptying it', () => {
    // Seed lỗi lọt ra ngoài. Thay bằng chuỗi rỗng sẽ gửi một lá thư thiếu chữ mà không ai biết,
    // nên đây là fail-closed `500`.
    expect(render({ subjectTemplate: 'Hello {{ undeclared }}' })).toEqual({
      ok: false,
      reason: 'unrenderable_placeholder',
    });
    expect(render({ bodyTemplate: 'Hi {{ undeclared }}' })).toEqual({
      ok: false,
      reason: 'unrenderable_placeholder',
    });
  });

  it('leaves brace text that is not a valid placeholder alone', () => {
    // Renderer hiểu **duy nhất** `{{ name }}`; `{{ user.name }}` có dấu chấm nên không phải
    // placeholder hợp lệ và seed phải từ chối, runtime không tự hiểu.
    expect(render({ bodyTemplate: '{{ user.name }}' })).toEqual({
      ok: true,
      subject: 'Subject',
      body: '{{ user.name }}',
    });
    expect(render({ bodyTemplate: '{name}' })).toEqual({
      ok: true,
      subject: 'Subject',
      body: '{name}',
    });
  });
});

describe('renderMail — a value is data, never template syntax', () => {
  it('does not re-render a value that itself contains placeholder syntax', () => {
    const normalized = new Map<string, unknown>([['name', '{{ name }}']]);
    const result = render({ bodyTemplate: 'A{{ name }}B', normalized });

    // Single-pass: giá trị chứa `{{` đi thẳng vào output (đã escape), không quét lại.
    expect(result).toEqual({ ok: true, subject: 'Subject', body: 'A{{ name }}B' });
  });

  it('does not let a value introduce a placeholder for another variable', () => {
    const normalized = new Map<string, unknown>([
      ['name', '{{ count }}'],
      ['count', 7],
    ]);
    const result = render({ bodyTemplate: '{{ name }}', normalized });

    expect(result.ok && result.body).toBe('{{ count }}');
  });

  it('substitutes each placeholder exactly once, even when it repeats', () => {
    const normalized = new Map<string, unknown>([['name', 'An']]);

    expect(render({ bodyTemplate: '{{ name }}-{{ name }}', normalized })).toEqual({
      ok: true,
      subject: 'Subject',
      body: 'An-An',
    });
  });

  it('escapes the value in the body, so an injected value cannot introduce markup', () => {
    const normalized = new Map<string, unknown>([['name', '<script>alert(1)</script>']]);
    const result = render({ bodyTemplate: '<p>{{ name }}</p>', normalized });

    expect(result.ok && result.body).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it('uses attribute escaping when the placeholder sits inside a quoted attribute', () => {
    // FR-003: "context attribute escape thêm `"` và `'`". Một URL hợp lệ có thể chứa `"` ở
    // query sau khi caller encode tay — placeholder trong href="..." phải không cho phép giá
    // trị thoát khỏi dấu nháy, kẻo attribute đóng sớm và markup được inject.
    const urlSchema = schemaOf(
      JSON.stringify({
        schema_version: 1,
        variables: { url: { type: 'string', required: false, max_length: 2048, format: 'url' } },
      }),
    );
    const normalized = new Map<string, unknown>([
      ['url', 'https://example.com/\u0022 onmouseover=\u0022alert(1)'],
    ]);
    const result = render({
      bodyTemplate: '<a href="{{ url }}">go</a>',
      normalized,
      schema: urlSchema,
    });

    // Dấu nháy của TEMPLATE giữ nguyên văn; mọi dấu nháy từ GIÁ TRỊ thành `&quot;` —
    // attribute không thể đóng sớm, markup không được inject.
    expect(result.ok && result.body).toBe(
      '<a href="https://example.com/&quot; onmouseover=&quot;alert(1)">go</a>',
    );
  });

  it('keeps text escaping when the placeholder sits in text even near markup', () => {
    // Không có dấu nháy quanh placeholder ⇒ context text; `"` trong giá trị phải được giữ
    // nguyên (escape attribute ở đây sẽ làm đổi nội dung hiển thị).
    const normalized = new Map<string, unknown>([['name', 'say \u0022hi\u0022']]);
    const result = render({ bodyTemplate: '<p>{{ name }}</p>', normalized });

    expect(result.ok && result.body).toBe('<p>say \u0022hi\u0022</p>');
  });

  it('does not let a neighboring value create an attribute context for the next placeholder', () => {
    // Dấu nháy đến TỪ GIÁ TRỊ đã escape của placeholder trước không được mở context attribute
    // cho placeholder sau: detector phải nhìn template gốc, không phải chuỗi đang render.
    const normalized = new Map<string, unknown>([
      ['name', '\u0022'], // render thành &quot; — không còn dấu nháy nguyên văn
      ['count', 'x'],
    ]);
    const result = render({ bodyTemplate: '<p title="{{ name }}">{{ count }}</p>', normalized });

    // Dấu nháy template nguyên văn; giá trị `"` thành `&quot;` dù placeholder sau nó (count)
    // nằm ngoài attribute và vẫn nhận text escape.
    expect(result.ok && result.body).toBe('<p title="&quot;">x</p>');
  });

  it.each([
    ['newline', '\n'],
    ['tab', '\t'],
    ['carriage return', '\r'],
    ['form feed', '\u000C'],
  ])(
    'treats a placeholder around %s inside a quoted attribute as attribute context',
    (_label, separator) => {
      // HTML cho phép whitespace giữa dấu nháy và value của một attribute — detector chỉ skip
      // `0x20` nên template `href="\n{{ v }}"` bị coi là text context, và một giá trị chứa `"`
      // không bị escape: giá trị thoát attribute được. Các ca đối xứng với placeholder trước
      // dấu nháy đóng (`{{ v }}\n`) cũng phải vào context attribute.
      const normalized = new Map<string, unknown>([['v', '" onmouseover="alert(1)']]);
      const vSchema = schemaOf(
        JSON.stringify({
          schema_version: 1,
          variables: { v: { type: 'string', required: false, max_length: 200 } },
        }),
      );
      const before = render({
        bodyTemplate: `<a href="${separator}{{ v }}">go</a>`,
        normalized,
        schema: vSchema,
      });
      const after = render({
        bodyTemplate: `<a href="{{ v }}${separator}">go</a>`,
        normalized,
        schema: vSchema,
      });

      for (const result of [before, after]) {
        expect(result.ok).toBe(true);
        // Mọi dấu nháy của GIÁ TRỊ phải thành `&quot;` — attribute không thể đóng sớm.
        expect(result.ok && result.body).not.toContain('" onmouseover');
        expect(result.ok && result.body.startsWith('<a href="')).toBe(true);
        expect(result.ok && result.body.endsWith('">go</a>')).toBe(true);
      }
    },
  );
});

describe('renderMail — subject is a header, so control characters are rejected', () => {
  it('rejects a subject whose rendered value contains CR or LF', () => {
    // Header injection: CR/LF trong subject ngắt header và cho kẻ tấn công thêm header riêng.
    // HTML escape không loại bỏ CR/LF, nên luật này phải đứng **riêng** — không giao cho escape.
    for (const value of ['An\rBcc: victim@example.com', 'An\nBcc: victim@example.com']) {
      const normalized = new Map<string, unknown>([['name', value]]);

      expect(render({ subjectTemplate: 'Hello {{ name }}', normalized })).toEqual({
        ok: false,
        reason: 'subject_control_character',
      });
    }
  });

  it('rejects every ASCII control character in the rendered subject', () => {
    for (const codeUnit of [0x00, 0x07, 0x0b, 0x1f, 0x7f]) {
      const normalized = new Map<string, unknown>([['name', `A${String.fromCharCode(codeUnit)}B`]]);

      expect(render({ subjectTemplate: 'X{{ name }}', normalized })).toEqual({
        ok: false,
        reason: 'subject_control_character',
      });
    }
  });

  it('allows a control character in the body, because the body is not a header', () => {
    const normalized = new Map<string, unknown>([['name', 'line1\r\nline2']]);
    const result = render({ bodyTemplate: '{{ name }}', normalized });

    expect(result.ok && result.body).toBe('line1\r\nline2');
  });

  it('applies the caller-supplied escape to the subject, exactly once', () => {
    const normalized = new Map<string, unknown>([['name', '<b>&</b>']]);
    const result = render({
      subjectTemplate: 'X{{ name }}',
      normalized,
      // Caller này chọn escape HTML cho subject; hàm render phải gọi nó và không tự escape thêm.
      escapeSubject: escapeHtmlText,
    });

    expect(result.ok && result.subject).toBe('X&lt;b&gt;&amp;&lt;/b&gt;');
  });
});

describe('escapeHtmlText — context text', () => {
  it('escapes &, < and >', () => {
    expect(escapeHtmlText('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('escapes ampersand first, so an escape sequence is not escaped a second time', () => {
    // Nếu thay `<` trước `&` thì `&lt;` sinh ra sẽ thành `&amp;lt;` — double-escape, và người
    // nhận thấy `&lt;` thay vì `<`.
    expect(escapeHtmlText('<')).toBe('&lt;');
    expect(escapeHtmlText('&lt;')).toBe('&amp;lt;');
    expect(escapeHtmlText('&')).toBe('&amp;');
  });

  it('leaves quotes alone, because text context opens no attribute', () => {
    // Escape `"`/`'` ở context text sẽ đổi nội dung người nhận thấy mà không bảo vệ thêm gì.
    expect(escapeHtmlText(`" ' quoted`)).toBe(`" ' quoted`);
  });

  it('escapes exactly once, leaving the ampersand of an entity alone', () => {
    expect(escapeHtmlText('&lt;b&gt;')).toBe('&amp;lt;b&amp;gt;');
  });
});

describe('escapeHtmlAttribute — context attribute', () => {
  it('escapes the text set and additionally both quote characters', () => {
    expect(escapeHtmlAttribute('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
    expect(escapeHtmlAttribute(`"double" 'single'`)).toBe('&quot;double&quot; &#39;single&#39;');
  });

  it('uses the numeric entity for the single quote, because &apos; is not in HTML4', () => {
    expect(escapeHtmlAttribute("'")).toBe('&#39;');
  });

  it('closes the double-quote context the value could otherwise break out of', () => {
    const value = '" onmouseover="alert(1)';
    const escaped = escapeHtmlAttribute(value);

    expect(escaped).not.toContain('"');
    expect(escaped).toBe('&quot; onmouseover=&quot;alert(1)');
  });
});
