/**
 * Helper validate gắn Hono Context — tách từ upstream `src/lib/validation.ts`
 * (ADAPT): phần pure schema nằm ở `src/domain/validation.ts`, phần cần
 * `Context` (tạo 400 response) nằm ở đây.
 */
import type { Context } from 'hono';
import type { ZodType } from 'zod';

/**
 * Validate một param và trả 400 response nếu sai.
 * Trả giá trị đã validate nếu đúng, hoặc null kèm error response nếu sai.
 */
export function validateParam<T>(
  c: Context,
  schema: ZodType<T>,
  value: string | undefined,
  paramName: string,
): { valid: true; value: T } | { valid: false; errorResponse: Response } {
  const result = schema.safeParse(value);

  if (!result.success) {
    const errorMessage = result.error.issues[0]?.message || 'Invalid input';
    return {
      valid: false,
      errorResponse: c.json(
        {
          error: 'Bad Request',
          message: `Invalid ${paramName}: ${errorMessage}`,
        },
        400,
      ) as unknown as Response,
    };
  }

  return { valid: true, value: result.data };
}

/**
 * Validate nhiều param một lúc.
 * Trả mọi giá trị đã validate hoặc error response của cái sai đầu tiên.
 */
export function validateParams(
  c: Context,
  validations: Array<{
    schema: ZodType;
    value: string | undefined;
    name: string;
  }>,
): { valid: true; values: unknown[] } | { valid: false; errorResponse: Response } {
  const values: unknown[] = [];

  for (const { schema, value, name } of validations) {
    const result = validateParam(c, schema, value, name);
    if (!result.valid) {
      return result;
    }
    values.push(result.value);
  }

  return { valid: true, values };
}

/**
 * Validate query param tuỳ chọn. Nếu value là undefined hoặc rỗng thì trả
 * undefined (caller tự quyết định có chấp nhận không). Nếu có mặt thì phải
 * parse được theo schema; không thì trả 400 response.
 */
export function validateOptionalQuery<T>(
  c: Context,
  schema: ZodType<T>,
  value: string | undefined,
  paramName: string,
): { valid: true; value: T | undefined } | { valid: false; errorResponse: Response } {
  if (value === undefined || value === '') {
    return { valid: true, value: undefined };
  }
  const inner = validateParam(c, schema, value, paramName);
  if (!inner.valid) return inner;
  return { valid: true, value: inner.value };
}

/** Body vượt giới hạn → 413 response chuẩn hoá (message theo ngữ cảnh gọi). */
function payloadTooLarge(c: Context, maxBytes: number, what: string): Response {
  return c.json(
    { error: 'Payload Too Large', message: `${what} exceeds maximum size of ${maxBytes} bytes` },
    413,
  );
}

/**
 * Đọc JSON body với **trần byte thật**, không tin `Content-Length`.
 *
 * Kiểm Content-Length header bỏ qua request `Transfer-Encoding: chunked`
 * (không có header đó) — điều kiện hiện hữu thành no-op và `c.req.json()`
 * buffer toàn bộ body vào isolate. Helper này đếm byte trên stream: vượt
 * trần ngay khi chunk kế tiếp lọt qua, KHÔNG buffer quá giới hạn.
 *
 * `c.req.raw.body` là `null` với GET/HEAD — caller chỉ gọi trên route POST.
 * Body không phải UTF-8 hợp lệ → JSON.parse ném ở caller như trước.
 */
export async function readJsonBodyWithLimit(
  c: Context,
  maxBytes: number,
  what: string,
): Promise<{ ok: true; value: unknown } | { ok: false; errorResponse: Response }> {
  const body = c.req.raw.body;
  if (body === null) {
    // Không body — giữ hợp đồng cũ: caller xử lý JSON.parse('') thành 400.
    return { ok: true, value: undefined };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { ok: false, errorResponse: payloadTooLarge(c, maxBytes, what) };
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(merged);
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      errorResponse: c.json({ error: 'Bad Request', message: 'Invalid JSON body' }, 400),
    };
  }
}
