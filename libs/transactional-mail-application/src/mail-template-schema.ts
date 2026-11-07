/**
 * Parse + validate `variables_schema_json` của **đúng template version** (FR-003).
 *
 * ⚠️ Đây là **subset JSON có version, KHÔNG phải JSON Schema đầy đủ**: không thêm dependency JSON
 * Schema và không có runtime validator nào trong contract library. Mọi field lạ trong schema, field
 * không áp dụng cho `type` khai báo, hay `schema_version` chưa hỗ trợ đều là **lỗi seed/template**
 * → `broken-schema`, tức fail-closed `500 internal_error` + alert ở caller, **không phải lỗi của
 * caller** và không gửi. Cột `NULL`/rỗng/không parse được vào **đúng** nhánh này, không được coi
 * là "không có biến".
 *
 * Schema khai báo **kiểu và giới hạn, không khai báo giá trị** — nó không bao giờ chứa dữ liệu
 * nhạy cảm (FR-003).
 *
 * Schema thuộc về **version**: đổi schema = tạo version mới. Version đã `active` không được sửa
 * schema, nếu không cùng một request sẽ hợp lệ tuỳ thời điểm.
 */

import { MAIL_VARIABLES_KEY_PATTERN, MAIL_VARIABLES_MAX_KEYS } from './normalize-request';

/**
 * Khai báo global tối thiểu cho `URL` — WHATWG URL parser, có ở **cả** Cloudflare Workers lẫn Node
 * (khác `URL` cũ của Node và cũng khác `import.meta.url`).
 *
 * ⚠️ Khai ở **phạm vi module** (file này là module) nên nó che global chứ không đụng file khác. Chỉ
 * khai những thành phần thực dùng: `hostname` đã punycode hoá, `protocol` đã lowercase và có dấu
 * `:`; `username`/`password` là thành phần userinfo.
 */
interface ParsedUrl {
  readonly protocol: string;
  readonly username: string;
  readonly password: string;
  readonly hostname: string;
}

declare const URL: {
  new (url: string, base?: string): ParsedUrl;
};

/**
 * Version duy nhất của format subset mà runtime hỗ trợ.
 *
 * Chốt `= 1` chứ không phải `>= 1`: tài liệu nói "số nguyên ≥ 1" cho định dạng, nhưng một version
 * format **chưa từng defined** thì phải là `broken-schema` (fail-closed), không phải được đọc
 * bằng luật của version 1.
 */
export const TEMPLATE_SCHEMA_VERSION = 1;

/** Số key tối đa trong `variables` của một schema. */
export const TEMPLATE_SCHEMA_MAX_KEYS = MAIL_VARIABLES_MAX_KEYS;

/** Pattern của một key biến trong schema — cùng pattern với tầng request-shape. */
export const TEMPLATE_VARIABLE_KEY_PATTERN = MAIL_VARIABLES_KEY_PATTERN;

/**
 * Trần của `max_length` trong schema — **10000**, trùng ngưỡng chuỗi ở tầng
 * request-shape (FR-003 AC: "`max_length` khai báo trong schema ≤ 10000").
 */
export const TEMPLATE_STRING_MAX_LENGTH_LIMIT = 10_000;

/** Kiểu JSON mà v1 hỗ trợ — không có `object`/`array`. */
export type TemplateVariableType = 'string' | 'number' | 'boolean';

/** Định dạng riêng: v1 chỉ có `url`. */
export type TemplateVariableFormat = 'url';

/** Đặc tả của một biến sau khi parse. */
export interface ParsedTemplateVariable {
  readonly type: TemplateVariableType;
  /**
   * `required` **khai báo tường minh** — không có mặc định ngầm (FR-003, bảng field).
   *
   * `required` chỉ nói về **vắng mặt**: `null` trên biến `nullable: true` **thỏa** `required: true`.
   */
  readonly required: boolean;
  readonly nullable: boolean;
  /** Chỉ có khi `type = 'string'`; `null` nghĩa là schema không giới hạn độ dài. */
  readonly maxLength: number | null;
  /** Chỉ có khi `type = 'string'`; `null` nghĩa là không có định dạng riêng. */
  readonly format: TemplateVariableFormat | null;
}

/** Schema đã parse — `ReadonlyMap` vì người đọc không được sửa. */
export type ParsedTemplateSchema = ReadonlyMap<string, ParsedTemplateVariable>;

/**
 * Field hợp lệ ở **gốc** schema — mọi field khác là `broken-schema`.
 *
 * `additional_variables`, `$schema`, `definitions` … là của JSON Schema đầy đủ; subset format này
 * không biết chúng, và im lặng bỏ qua là schema bị xem là hợp lệ trong khi luật thực thi chỉ hiểu
 * một phần.
 */
const ALLOWED_SCHEMA_FIELDS: ReadonlySet<string> = new Set(['schema_version', 'variables']);

/** Field hợp lệ trong object đặc tả của một biến — **mọi** field khá là `broken-schema`. */
const ALLOWED_VARIABLE_FIELDS: ReadonlySet<string> = new Set([
  'type',
  'required',
  'nullable',
  'max_length',
  'format',
]);

/** `type` hợp lệ. */
const VARIABLE_TYPES: ReadonlySet<string> = new Set(['string', 'number', 'boolean']);

/** `format` hợp lệ — v1 chỉ có `url`. */
const VARIABLE_FORMATS: ReadonlySet<string> = new Set(['url']);

/** Kết quả parse schema. */
export type ParseTemplateSchemaResult =
  | { readonly ok: true; readonly schema: ParsedTemplateSchema }
  | { readonly ok: false; readonly reason: 'broken-schema' };

/**
 * Parse + kiểm `variables_schema_json`.
 *
 * Trả `broken-schema` cho **mọi** trường hợp lệch, gồm: `null`/rỗng, JSON không parse được, shape
 * không phải object, `schema_version !== 1`, `variables` không phải object, > {@link
 * TEMPLATE_SCHEMA_MAX_KEYS} key, key sai pattern, `type` ngoài `string|number|boolean`,
 * `required`/`nullable` không boolean, `max_length`/`format` trên `number`/`boolean`, `format`
 * khác `'url'`, `max_length` ngoài `1..10000`, và mọi field lạ trong object đặc tả biến.
 */
export function parseTemplateSchema(rawJson: string | null): ParseTemplateSchemaResult {
  if (rawJson === null || rawJson.trim() === '') {
    return { ok: false, reason: 'broken-schema' };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { ok: false, reason: 'broken-schema' };
  }

  if (!isPlainRecord(parsed)) {
    return { ok: false, reason: 'broken-schema' };
  }

  for (const field of Object.keys(parsed)) {
    if (!ALLOWED_SCHEMA_FIELDS.has(field)) {
      return { ok: false, reason: 'broken-schema' };
    }
  }

  const schemaVersion = parsed['schema_version'];

  if (schemaVersion !== TEMPLATE_SCHEMA_VERSION) {
    return { ok: false, reason: 'broken-schema' };
  }

  const rawVariables = parsed['variables'];

  if (!isPlainRecord(rawVariables)) {
    return { ok: false, reason: 'broken-schema' };
  }

  const names = Object.keys(rawVariables);

  if (names.length > TEMPLATE_SCHEMA_MAX_KEYS) {
    return { ok: false, reason: 'broken-schema' };
  }

  const variables = new Map<string, ParsedTemplateVariable>();

  for (const name of names) {
    if (!TEMPLATE_VARIABLE_KEY_PATTERN.test(name)) {
      return { ok: false, reason: 'broken-schema' };
    }

    const variable = parseVariable(rawVariables[name]);

    if (variable === null) {
      return { ok: false, reason: 'broken-schema' };
    }

    variables.set(name, variable);
  }

  return { ok: true, schema: variables };
}

/**
 * Kết quả kiểm `variables` theo schema của version đã chọn.
 *
 * `normalized` chỉ chứa **biến có mặt trong request** và đã vượt kiểm — biến optional vắng mặt
 * **không** có trong map (FR-003: không có mặc định ngầm; chèn default trước khi fingerprint còn
 * làm biến hai request vốn khác nhau thành một).
 *
 * ⚠️ `allowlist_unconfigured` phải là lý do **riêng**, không gộp vào `invalid_request`: caller map
 * nó thành `503` (lỗi cấu hình server) chứ không phải `400` — trùng lý do thì một deploy thiếu
 * cấu hình sẽ trả `400` và không ai thấy nó là sự cố vận hành.
 */
export type ValidateVariablesAgainstSchemaResult =
  | { readonly ok: true; readonly normalized: ReadonlyMap<string, unknown> }
  | { readonly ok: false; readonly reason: 'invalid_request' | 'allowlist_unconfigured' };

/**
 * Kiểm `variables` theo schema (FR-001 bước 6) — chạy **sau** khi chọn template version, và
 * **sau** khi fingerprint đã được so.
 *
 * Bảng hành vi theo FR-003:
 *
 * - key không khai báo trong schema → từ chối (không render).
 * - biến `required` **vắng mặt** → từ chối. Biến optional vắng mặt → hợp lệ.
 * - `null` trên `nullable: false` → từ chối (sai kiểu). `null` trên `nullable: true` → hợp lệ, giữ
 *   `null` trong `normalized`.
 * - sai kiểu → từ chối, **không tự ép kiểu**: `1` ≠ `"1"`, boolean không cho `type: "string"`.
 *   (object/array đã bị chặn ở tầng shape; nhánh này vẫn từ chối để hàm đứng được một mình.)
 * - chuỗi vượt `max_length` → từ chối. `max_length` đo trên **giá trị gốc** bằng **UTF-16 code
 *   unit**, **trước** khi HTML escape — độ dài để validate và độ dài sau escape là hai thứ khác.
 * - `format: 'url'` → {@link validateTemplateUrl}. Kiểm `format` **chỉ** khi giá trị có mặt và
 *   khác `null`: biến optional `format: 'url'` bị thiếu (hoặc `null`) hợp lệ, không áp luật URL.
 */
export function validateVariablesAgainstSchema(
  schema: ParsedTemplateSchema,
  variables: Record<string, unknown>,
  allowlist: readonly string[] = [],
): ValidateVariablesAgainstSchemaResult {
  const normalized = new Map<string, unknown>();

  for (const [name, value] of Object.entries(variables)) {
    const variable = schema.get(name);

    // Key không khai báo trong schema: schema khai báo "kiểu và giới hạn", không phải "mọi thứ đều
    // được phép" — từ chối thay vì render.
    if (variable === undefined) {
      return { ok: false, reason: 'invalid_request' };
    }

    if (value === null) {
      if (!variable.nullable) {
        return { ok: false, reason: 'invalid_request' };
      }

      normalized.set(name, null);
      continue;
    }

    if (!matchesDeclaredType(variable.type, value)) {
      return { ok: false, reason: 'invalid_request' };
    }

    if (variable.type === 'string') {
      const text = value as string;

      if (variable.maxLength !== null && text.length > variable.maxLength) {
        return { ok: false, reason: 'invalid_request' };
      }

      /**
       * Luật URL chỉ áp khi giá trị **có mặt và khác `null`** — nhánh `null` đã `continue` ở trên
       * và biến vắng mặt không vào vòng lặp này, nên `format: 'url'` thiếu/`null` hợp lệ và render
       * chuỗi rỗng như mọi biến optional khác.
       */
      if (variable.format === 'url') {
        const url = validateTemplateUrl(text, allowlist);

        if (!url.ok) {
          return { ok: false, reason: url.reason };
        }
      }

      normalized.set(name, text);
      continue;
    }

    normalized.set(name, value);
  }

  for (const [name, variable] of schema) {
    if (variable.required && !normalized.has(name)) {
      return { ok: false, reason: 'invalid_request' };
    }
  }

  return { ok: true, normalized };
}

/**
 * Kết quả kiểm URL của biến `format: 'url'`.
 *
 * `allowlist_unconfigured` là **lỗi cấu hình server**, không phải lỗi request: allowlist rỗng →
 * caller map `503 service_unavailable` + alert, **không phải** `400`.
 */
export type ValidateTemplateUrlResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'invalid_request' | 'allowlist_unconfigured' };

/**
 * Luật URL của biến `format: 'url'` (FR-003, mục "Render an toàn").
 *
 * Phải là absolute URL, scheme `https`, `username`/`password` rỗng, và hostname khớp allowlist
 * **theo ranh giới nhãn** — khớp chính xác host, hoặc suffix có boundary `.`: allowlist
 * `example.com` khớp `a.example.com` nhưng **KHÔNG** khớp `evil-example.com`. So khớp chuỗi con
 * bị bỏ qua là lỗ hổng, nên chỉ so trên hostname đã chuẩn hoá (WHATWG `URL` đã punycode hoá).
 */
export function validateTemplateUrl(
  value: string,
  allowlist: readonly string[],
): ValidateTemplateUrlResult {
  if (allowlist.length === 0) {
    return { ok: false, reason: 'allowlist_unconfigured' };
  }

  let parsed: ParsedUrl;

  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: 'invalid_request' };
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    !isAllowlistedHost(parsed.hostname, allowlist)
  ) {
    return { ok: false, reason: 'invalid_request' };
  }

  return { ok: true };
}

/**
 * Host có khớp allowlist theo **ranh giới nhãn** hay không.
 *
 * Cả **hai** phía đều được chuẩn hoá trước khi so: hostname của URL đã punycode hoá + lowercase,
 * và entry allowlist đi qua **cùng** một đường. Nếu chỉ chuẩn hoá một phía thì allowlist cấu hình
 * bằng chữ Unicode sẽ không bao giờ khớp URL punycoded — cấu hình đúng mà hệ thống từ chối.
 *
 * Entry không phải host hợp lệ (URL parser ném) thì **không** khớp gì: một entry hỏng không được
 * biến thành allowlist rỗng chạy tự do.
 */
function isAllowlistedHost(hostname: string, allowlist: readonly string[]): boolean {
  const host = hostname.toLowerCase();

  return allowlist.some((entry) => {
    const candidate = hostToAscii(entry);

    return candidate !== null && (host === candidate || host.endsWith(`.${candidate}`));
  });
}

/** Host → ASCII (punycode + lowercase) qua cùng WHATWG parser; `null` khi entry không hợp lệ. */
function hostToAscii(value: string): string | null {
  try {
    return new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Khớp kiểu đã khai báo — **không coercion**.
 *
 * `typeof` phân biệt `number` và `string` nên `1` khác `"1"`; boolean không khớp `string`. Với
 * `type: 'number'`, mọi số hữu hạn đều hợp lệ (âm, thập phân, exponent); số không hữu hạn đã bị
 * chặn ở tầng shape và cũng bị chặn ở đây — không serialize thành `null`.
 */
function matchesDeclaredType(type: TemplateVariableType, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return false;
  }
}

/**
 * Parse một object đặc tả biến; `null` khi **bất kỳ** field nào lệch bảng field của FR-003.
 *
 * Kiểm field lạ bằng **duyệt key** chứ không kiểm "có đủ các field hợp lệ không": một schema có
 * thêm `pattern`, `enum`, `minimum` là schema **không hợp lệ** với runtime này, và im lặng bỏ qua
 * chúng nghĩa là template được xem là hợp lệ trong khi luật thực thi chỉ hiểu một phần.
 */
function parseVariable(raw: unknown): ParsedTemplateVariable | null {
  if (!isPlainRecord(raw)) {
    return null;
  }

  for (const field of Object.keys(raw)) {
    if (!ALLOWED_VARIABLE_FIELDS.has(field)) {
      return null;
    }
  }

  const type = raw['type'];

  if (typeof type !== 'string' || !VARIABLE_TYPES.has(type)) {
    return null;
  }

  const required = raw['required'];

  if (typeof required !== 'boolean') {
    return null;
  }

  const nullable = raw['nullable'];

  if (nullable !== undefined && typeof nullable !== 'boolean') {
    return null;
  }

  const maxLength = raw['max_length'];

  if (maxLength !== undefined) {
    // `max_length` chỉ áp dụng khi `type = 'string'`; đặt nó trên `number`/`boolean` là schema
    // không hợp lệ chứ không phải "bỏ qua".
    if (type !== 'string') {
      return null;
    }

    if (
      !Number.isInteger(maxLength) ||
      (maxLength as number) < 1 ||
      (maxLength as number) > TEMPLATE_STRING_MAX_LENGTH_LIMIT
    ) {
      return null;
    }
  }

  const format = raw['format'];

  if (format !== undefined) {
    if (type !== 'string' || typeof format !== 'string' || !VARIABLE_FORMATS.has(format)) {
      return null;
    }
  }

  return {
    type: type as TemplateVariableType,
    required,
    nullable: nullable === true,
    maxLength: maxLength === undefined ? null : (maxLength as number),
    format: format === undefined ? null : (format as TemplateVariableFormat),
  };
}

/** Object thuần — chặn array, `null` và class instance. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}
