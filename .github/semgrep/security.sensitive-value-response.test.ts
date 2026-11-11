// Fixture cho rule `security-sensitive-value-in-http-response`.
//
// File này KHÔNG phải `*.spec.ts` (rule có `paths.exclude: ['*.spec.ts']`, nên nếu
// đặt tên `.spec.ts` thì rule sẽ không đọc và mọi `ok:` đều xanh giả). Đây là fixture
// của `semgrep --test`, chạy trên chính `.github/semgrep`.
//
// ⚠️ Tên file PHẢI bắt đầu bằng stem của file rule (`security.`) — đo trên
// semgrep 1.185.0 (`semgrep/test.py: relatively_eq`): `--test` ghép fixture với
// rule file theo TÊN FILE, so `filename.split('.', 1)[0]` với stem của rule file
// (`workflows.workflow-run.test.yaml` ↔ `workflows.yml`). Tên cũ
// `sensitive-value-response.test.ts` KHÔNG ghép với `security.yml`, nên
// `--test` không bao giờ đọc file này và mọi annotation trong đó là dead —
// chính vì vậy ba ca dưới đây từng lệch annotation mà không ai thấy. Đổi tên
// thành `security.sensitive-value-response.test.ts` đưa cả file vào harness.
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
//
// Ca `ok:` GHIM sanitizer `signRequest({...secret..., timestamp...})`: với
// sanitizer đang bật thì line này phải SẠCH (gỡ sanitizer đi thì ca đỏ — đo
// được). Bản trước ghi `ruleid:` — sai với chính comment phía trên và với ca
// `signInternalHeaders` trong `security.test.ts` (cùng hình dạng, `ok:`) — lỗi
// chỉ lộ ra khi file được `--test` đọc (xem phần tên file ở đầu file).
// ---------------------------------------------------------------------------
export async function buildSignedHeaders(
  method: string,
  path: string,
  body: Uint8Array,
  nowMs: number,
): Promise<Headers> {
  const timestamp = String(Math.floor(nowMs / 1000));
  const headers = await signRequest({ method, path, body, secret, timestamp, nonce: 'n' });
  // ok: security-sensitive-value-in-http-response
  return new Headers({ 'content-type': 'application/json', ...headers });
}

// ---------------------------------------------------------------------------
// 4. RANH GIỚI PHẢI BẮT ĐƯỢC — `signInternalRequest` trả `{headers, body}` để hai
//    thứ không lệch nhau. Sanitizer của `signRequest` bên trong không cắt được đường
//    này (taint vào qua `secret` của chính nó, ra ở giá trị trả về).
//
//    Ca này ghim fingerprint thứ hai: bỏ nó đi thì chính hai dòng `return this.#send`
//    trong `apps/auth/src/account-client.ts` báo lại finding.
//
//    Ca `ok:` GHIM sanitizer `signInternalRequest({...secret..., nowMs...})` —
//    cùng chuẩn với ca `signInternalForAccountClient` trong `security.test.ts`
//    (`ok:`). Bản trước ghi `ruleid:` — sai với comment và với ca chuẩn trong
//    `security.test.ts`; lệch annotation chỉ lộ khi `--test` đọc được file này.
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
  // ok: security-sensitive-value-in-http-response
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
  // ruleid: security-sensitive-value-in-http-response
  return json({ result, secret });
}

// ---------------------------------------------------------------------------
// 7. HÌNH DẠNG CHÍNH THỨC của secret trigger trong deploys/*-deploy: mảng
//    Output bọc `pulumi.secret` dựng bằng flatMap implicit-return. Trên
//    1.185.0, callee `pulumi.secret` tự khớp nguồn branch 2 (`pulumi` +
//    `secret` trúng `secrets?`), taint chảy qua kết quả lời gọi, và arrow
//    implicit-return được chuẩn hoá thành `return [...]` nên trúng sink —
//    chỉ vì TÊN callee, không có dữ liệu nào tự nó rời process. Chính FP này
//    đã đẩy `deploys/llm-api-deploy/index.ts` dựng mảng bằng vòng lặp
//    `.push()` để né scanner (taint không đi qua `.push()` — đo được).
//    `pattern-not: pulumi.secret` trong security.yml chỉ loại callee; ca
//    `ok:` này GHIM exclusion đó: gỡ pattern-not thì ca đỏ.
// ---------------------------------------------------------------------------
export function secretTriggersFromFlatMap(
  DATABASES: readonly string[],
  rolePasswords: Record<string, { migrator: string; runtime: string }>,
): pulumi.Output<string>[] {
  // ok: security-sensitive-value-in-http-response
  const secretTriggers: pulumi.Output<string>[] = DATABASES.flatMap((target) => [
    pulumi.secret(rolePasswords[target].migrator),
    pulumi.secret(rolePasswords[target].runtime),
  ]);
  return secretTriggers;
}

// ---------------------------------------------------------------------------
// 8. RANH GIỚI CHỈ CẮT ĐÚNG QUA CALLEE — hai ca `ruleid:` chứng minh exclusion
//    không mở lỗ: giá trị nhạy cảm đi kèm hoặc qua THAM SỐ vẫn phải cháy.
// ---------------------------------------------------------------------------

// Giá trị bọc `pulumi.secret` đứng cạnh secret trần: exclusion chỉ làm callee
// hết là nguồn, secret trần vẫn tự nó cháy trên cùng một object trả ra.
export function leakAlongsideWrappedTrigger(): Response {
  const wrapped = pulumi.secret('internal-trigger-marker');
  // ruleid: security-sensitive-value-in-http-response
  return json({ secret, wrapped });
}

// Taint đi vào qua THAM SỐ của `pulumi.secret` vẫn chảy tới kết quả lời gọi —
// đo được khác sanitizer (thiết kế sanitizer bị loại chính vì nó làm ca này
// im lặng; `pulumi.unsecret`/`apply` lấy lại plaintext nên không phải ranh
// giới một chiều).
export function leakWrappedRealToken(): Response {
  // ruleid: security-sensitive-value-in-http-response
  return json({ token: pulumi.secret(token) });
}
