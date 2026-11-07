// Fixture cho rule `security-sensitive-value-in-http-response`.
//
// File này KHÔNG phải `*.spec.ts` (rule có `paths.exclude: ['*.spec.ts']`, nên nếu
// đặt tên `.spec.ts` thì rule sẽ không đọc và mọi `ok:` đều xanh giả). Đây là fixture
// của `semgrep --test`, chạy trên chính `.github/semgrep`.
//
// Quy trình bắt buộc khi sửa sanitizer (ghi lại trong `security.yml`): gỡ từng
// sanitizer rồi chạy lại `semgrep --test` — đúng SAN ca `ok:` phụ thuộc nó phải
// chuyển sang `incorrect lines`. Ca `ok:` không phụ thuộc sanitizer nào thì phải
// xanh vì một lý do khác có thể nêu tên được.

declare function signRequest(params: {
  method: string;
  path: string;
  body: Uint8Array;
  secret: string;
  timestamp: string;
  nonce: string;
}): Promise<Record<string, string>>;
declare function signInternalRequest(params: {
  secret: string;
  method: string;
  path: string;
  body: Uint8Array;
  nowMs: number;
}): Promise<{ headers: Headers; body: Uint8Array }>;
declare function verifyRequest(params: {
  headers: Record<string, string>;
  method: string;
  path: string;
  secret: string;
}): Promise<{ ok: boolean; nonce?: string; timestamp?: string; reason?: string }>;
declare function json(body: unknown): Response;
declare const secret: string;

// ---------------------------------------------------------------------------
// 1. CA THẬT PHẢI BẮT — secret rời handler ra HTTP.
// ---------------------------------------------------------------------------
export async function leakSecretPlain(_req: Request): Promise<Response> {
  // ruleid: security-sensitive-value-in-http-response
  return json({ secret });
}

// ---------------------------------------------------------------------------
// 2. CA THẬT PHẢI BẮT — chữ ký ký xong nhưng secret vẫn đi cùng.
// ---------------------------------------------------------------------------
export async function leakSecretAlongsideSignature(): Promise<Response> {
  const headers = await signRequest({
    method: 'GET',
    path: '/x',
    body: new Uint8Array(),
    secret,
    timestamp: '1',
    nonce: '2',
  });
  // ruleid: security-sensitive-value-in-http-response
  return json({ headers, secret });
}

// ---------------------------------------------------------------------------
// 3. RANH GIỚI PHẢI BẮT ĐƯỢC — SignRequest trả header ĐÃ KÝ cho request ĐI RA.
//
// Đây là shape thật của `signInternalRequest` trong `apps/auth/src/account-client.ts`
// trước khi PR #197 gỡ `nosemgrep` đi. Taint đi vào qua tham số `secret`, qua object
// literal argument, vào giá trị trả về của `signRequest`, rồi spread vào `new
// Headers(...)` và `return`. `new Headers(...)` KHÔNG bị `pattern-not`
// `return $CALLEE({..., ...})` loại, nên không có sanitizer thì nó rơi vào nhánh
// `return $VALUE` và bị báo.
// ---------------------------------------------------------------------------
export async function buildSignedHeaders(
  method: string,
  path: string,
  body: Uint8Array,
  nowMs: number,
): Promise<Headers> {
  const timestamp = String(Math.floor(nowMs / 1000));
  const headers = await signRequest({ method, path, body, secret, timestamp, nonce: 'n' });
  // ruleid: security-sensitive-value-in-http-response
  return new Headers({ 'content-type': 'application/json', ...headers });
}

// ---------------------------------------------------------------------------
// 4. RANH GIỚI PHẢI BẮT ĐƯỢC — `signInternalRequest` trả `{headers, body}` để hai
//    thứ không lệch nhau. Sanitizer của `signRequest` bên trong không cắt được đường
//    này (taint vào qua `secret` của chính nó, ra ở giá trị trả về).
//
//    Ca này ghim fingerprint thứ hai: bỏ nó đi thì chính hai dòng `return this.#send`
//    trong `apps/auth/src/account-client.ts` báo lại finding.
// ---------------------------------------------------------------------------
export async function sendInternalRequest(
  path: string,
  body: Uint8Array,
  nowMs: number,
): Promise<Response> {
  const signed = await signInternalRequest({
    secret,
    method: 'POST',
    path,
    body,
    nowMs,
  });
  // ruleid: security-sensitive-value-in-http-response
  return json({ path, headers: signed.headers });
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 6. `verifyRequest` trả `{ok, reason}` — không mang secret — nên `return
//    verifyRequest({...})` phải xanh. Ca này ghim ranh giới đó.
//    Lưu ý: nó xanh nhờ `pattern-not` `return $CALLEE({..., ...})` ở nhánh sink,
//    KHÔNG phải nhờ sanitizer `verifyRequest(...)` (sanitizer đó đã bị gỡ vì đo
//    được không có hiệu lực nào): gỡ `pattern-not` này khỏi nhánh sink thì ca đỏ.
// ---------------------------------------------------------------------------
export async function verifyThenReturn(headers: Record<string, string>): Promise<unknown> {
  // ok: security-sensitive-value-in-http-response
  return verifyRequest({ headers, method: 'GET', path: '/x', secret });
}
export async function verifyAndEchoSecret(headers: Record<string, string>): Promise<Response> {
  const result = await verifyRequest({ headers, method: 'GET', path: '/x', secret });
  return json({ result, secret });
}
