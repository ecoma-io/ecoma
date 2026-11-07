// Fixture semgrep --test cho security.yml. File này không phải là code của
// application — không gì dưới .github/semgrep được build hay chạy. Nó là TypeScript
// vì rule trong security.yml dùng `languages: [typescript]`: semgrep ghép cặp
// rule↔fixture theo tên file (`security.yml` ↔ `security.test.ts`) và chỉ chạy
// fixture có đuôi trùng ngôn ngữ của rule.
//
// Mỗi rule cần cả hai nửa: `ruleid:` phải khớp, `ok:` không được khớp. Các case
// `ok:` dưới đây chính là các ranh giới FP của threat model — userId/requestId
// là thứ AGENTS.md chỉ định PHÉP in ra để correlation, nên chúng không được
// nằm trong danh sách nguồn, và một identifier không nằm trong danh sách cũng
// không được tự biến thành nguồn chỉ vì nó nằm trong một biểu thức nhạy cảm.

/* oxlint-disable no-console */
// Fixture semgrep --test, không phải application code: mỗi dòng `console.*`
// bên dưới là SINK mà rule taint cần để tồn tại, và `.github/semgrep/` không
// thuộc Nx project nào nên chúng không bao giờ tới được runtime. `no-console`
// vẫn được giữ nguyên cho mọi file có thật — chính rule này là thứ đọc được
// GIÁ TRỊ bên trong console, cái mà lint không nhìn thấy.
// ruleid: security-sensitive-value-logged
console.log(token);
// ruleid: security-sensitive-value-logged
console.log(secret);
// ruleid: security-sensitive-value-logged
console.log(apiKey);
// ruleid: security-sensitive-value-logged
console.log(api_key);
// ruleid: security-sensitive-value-logged
console.error(password);
// ruleid: security-sensitive-value-logged
console.warn(accessToken);
// ruleid: security-sensitive-value-logged
console.log(refreshToken);
// ruleid: security-sensitive-value-logged
console.log(credentials);
// ruleid: security-sensitive-value-logged
console.log(prompt);
// ruleid: security-sensitive-value-logged
console.log(llm.response);
// ruleid: security-sensitive-value-logged
console.log(responseBody);
// ruleid: security-sensitive-value-logged
console.log(response_body);
// ruleid: security-sensitive-value-logged
console.log(cookie);
// ruleid: security-sensitive-value-logged
console.log(authorization);

// Ranh giới FP quan trọng nhất của rule này. `response` trần trong repository
// này là một `Response` của fetch/h3 — `response.status` và `await
// response.json()` đọc metadata HTTP, không phải body của LLM. Khi `response`
// được xếp vào nguồn trần, chính hai biểu thức đó đã sinh 7 FP trên
// apps/*/server/api/greet.spec.ts, nên `response` trần chỉ được nhận ở dạng
// field (`x.response`) và body phải tự nói tên mình là body.
// ok: security-sensitive-value-logged
console.log(response.status);
// ok: security-sensitive-value-logged
console.log(response);

// Nguồn dưới dạng field của object — `config.apiKey`, `env.SECRET` — cũng là
// cùng một đường đi, và đây là cách một secret environment thực sự xuất hiện.
// ruleid: security-sensitive-value-logged
console.log(config.apiKey);
// ruleid: security-sensitive-value-logged
console.error(process.env.SECRET);

// ── Ranh giới string thuần chữ ↔ giá trị runtime của nguồn ───────────────────
//
// Đo được trên 1.181.0: string literal single-quote không bao giờ là nguồn,
// NHƯNG template literal (backtick) thuần chữ — không có `${}` — VẪN là nguồn
// nếu text khớp regex, và taint sống qua interpolation. Đó là FP thật ở
// d1-inventory-repositories: CREDENTIAL_COLUMNS (template thuần chữ bắt đầu
// `credential_id`) interpolate vào câu SELECT rồi chảy về `return` của
// repository. `pattern-not: '"$_"'` loại đúng string không có interpolation.
export function fpPureTextTemplateIsNotASource(): void {
  // Template thuần chữ: giá trị nằm ngay trong source, không mang dữ liệu
  // runtime. Gỡ `pattern-not: '"$_"'` khỏi security.yml thì ca này đỏ.
  // ok: security-sensitive-value-logged
  const columns = `credential_id, credential_ciphertext, status`;
  console.log(columns);
}

export function diseaseSensitiveIdentifierStillSource(token: string): void {
  // Identifier mang dữ liệu runtime vẫn là nguồn dù string thuần chữ được
  // miễn — hai ca ghim hai chiều của ranh giới.
  // ruleid: security-sensitive-value-logged
  console.log(token);
}

// ⚠️ Giới hạn đã biết, KHÔNG ghim fixture: `pattern-not: '"$_"'` trên
// semgrep 1.181.0 khớp cả template CÓ interpolation (`m1` matches
// `` `with_${x}` `` — đã đo), nên `` const t = `token_${user}` `` cũng được
// miễn. Hình dạng đòi tiền tố literal khớp tên nhạy cảm + interpolation + đưa
// string đó ra sink — không tồn tại trong repo, và `\`${token}\`` thuần
// (tiền tố là `${`) không bao giờ khớp regex nguồn từ đầu. Không có cách diễn
// đạt "string thuần chữ" riêng trên OSS 1.181.0: `pattern-nots: or:` bị từ
// chối schema, và pattern `` `...${...}...` `` không ghim được vào pattern-not.
// Nếu semgrep tách hai node kind này trong tương lai, thu hẹp exemption là
// việc cần làm lại — các ca `ok:`/`ruleid:` ở trên vẫn đúng khi đó.

// Ranh giới FP: hai identifier mà AGENTS.md chỉ định là được phép in ra, và
// hai identifier thông thường không có tên trong threat model.
// ok: security-sensitive-value-logged
console.log(userId);
// ok: security-sensitive-value-logged
console.log(requestId);
// ok: security-sensitive-value-logged
console.log(count);
// ok: security-sensitive-value-logged
console.log(message);

// Fixture cho rule response: giá trị nhạy cảm rời khỏi handler.
export function returnToken(): string {
  // ruleid: security-sensitive-value-in-http-response
  return token;
}

export function returnField(): string {
  // ruleid: security-sensitive-value-in-http-response
  return config.accessToken;
}

export function returnSafe(): string {
  // ok: security-sensitive-value-in-http-response
  return userId;
}

export function returnObject() {
  // ruleid: security-sensitive-value-in-http-response
  return { token };
}

// ── Ranh giới FP đo được trên các auth lib cũ của bounded context identity (PR #175) ───────────────────────
//
// Các case dưới đây nằm TRONG function: một `return` ở top-level của module là
// lỗi cú pháp, parser bỏ qua nên `ok:` sẽ "pass" vì lý do sai — ca kiểm thử
// phải đúng nơi parser thực sự nhìn thấy.

// 1. Object literal làm ARGUMENT của lời gọi hàm: giá trị đi vào máy kiểm
//    chữ ký, không đi ra ngoài. Rule chỉ nhìn "tên field có `secret`" + "có
//    `return`" nên bắt nhầm; xem chú thích trong security.yml.
export function fpArgumentToCallee() {
  // ok: security-sensitive-value-in-http-response
  return verifyEnvelope({ secret, nonce, signature });
}

// 2. Object literal có field KHÔNG nhạy cảm: đây là kết quả xác thực được
//    kiểm chứng, không phải credential.
export function fpVerifiedResult() {
  // ok: security-sensitive-value-in-http-response
  return { ok: true, nonce };
}

// Ranh giới BỆNH: trả object ra ngoài vẫn phải bị bắt khi nó chứa giá trị nhạy
// cảm thật. Đây là thứ giữ cho việc thu hẹp rule ở trên không biến thành lỗ.
export function diseaseReturnObject() {
  // ruleid: security-sensitive-value-in-http-response
  return { token };
}

// Ranh giới BỆNH: cùng nguyên tắc, đi qua sink `c.json` của framework. Nếu
// chỉ bắt `return { token }` thì rule bị lách chỉ bằng cách đổi tên hàm.
export function diseaseJsonObject() {
  // ruleid: security-sensitive-value-in-http-response
  return c.json({ token });
}

// Ranh giới BỆNH: giá trị nhạy cảm đi qua sink `c.json` mà không bọc object.
export function diseaseJsonValue() {
  // ruleid: security-sensitive-value-in-http-response
  return c.json(config.accessToken);
}

// Ranh giới BỆNH: constructor của Response.
export function diseaseResponseConstructor() {
  // ruleid: security-sensitive-value-in-http-response
  return new Response(config.accessToken);
}

// Ranh giới BÉNH: free function `json(...)` với object literal — `pattern-not`
// `return $CALLEE({..., ...})` của nhánh 2 cũng khớp hình dạng này ($CALLEE
// = json), nên nếu nhánh 1 không có pattern `json({...})` riêng thì ca này
// trôi qua cả hai nhánh. Đây là lỗ đã đo bằng probe, không phải suy đoán.
export function diseaseJsonFreeFunctionObject() {
  // ruleid: security-sensitive-value-in-http-response
  return json({ token });
}

// Ranh giới LÀNH tương ứng: free function `json(...)` trả object KHÔNG chứa
// giá trị nhạy cảm — vẫn phải sạch, nếu không nhánh 1 mở rộng sẽ giết nốt
// hình dạng hợp pháp cuối cùng của tầng response.
export function fpJsonFreeFunctionObject() {
  // ok: security-sensitive-value-in-http-response
  return json({ ok: true, nonce });
}

// Ranh giới BỆNH: object spread đẩy nguyên object ra ngoài — không có field
// `tên: giá trị` nào cho nhánh 1 bám, và `pattern-not` `return {..., ...}`
// ở nhánh 2 loại nó. Đã đo bằng probe trước khi thêm pattern `...$REST`.
export function diseaseSpreadReturn() {
  // Biến spread phải mang tên khớp pattern-sources (`tokens`); tên khác
  // (`tokenResponse`) không tạo taint nên không báo — đã đo, không suy đoán.
  const tokens = issueTokens();
  // ruleid: security-sensitive-value-in-http-response
  return { ...tokens };
}

export function diseaseSpreadJsonObject() {
  const tokens = issueTokens();
  // ruleid: security-sensitive-value-in-http-response
  return c.json({ ...tokens });
}

// Ranh giới BỆNH: các tên khóa OIDC mà $LEAK trước đây thiếu — `id_token` là
// artifact nhạy cảm nhất của authorization server, nhưng regex cũ chỉ có
// `tokens?` không có tiền tố `id_`.
export function diseaseIdTokenKey() {
  // ruleid: security-sensitive-value-in-http-response
  return c.json({ access_token, refresh_token, id_token });
}

export function diseaseClientSecretKey() {
  // ruleid: security-sensitive-value-in-http-response
  return c.json({ client_secret });
}

// Ranh giới BỆNH: `c.json({...}, status)` với ĐÚNG HAI tham số — hình dạng
// mà token endpoint sẽ dùng. Nhánh $LEAK không khớp (thiếu `, ...`) nhưng
// nhánh GIÁ TRỊ vẫn bắt: `pattern-not` `return $CALLEE({..., ...})` chỉ loại
// lời gọi có ĐÚNG MỘT tham số object literal. Đã đo bằng probe trước khi
// ghim — nếu một ngày nào đó pattern-not đổi thành `$CALLEE($...ARGS)`,
// case này phải chuyển đỏ.
export function diseaseJsonWithStatus() {
  // ruleid: security-sensitive-value-in-http-response
  return c.json({ access_token, refresh_token }, 200);
}

// Ranh giới LÀNH: cùng hình dạng hai tham số, không khóa nhạy cảm.
export function fpJsonWithStatus() {
  // ok: security-sensitive-value-in-http-response
  return c.json({ ok: true, nonce }, 200);
}

// Ranh giới LÀNH: object thường KHÔNG chứa khóa nhạy cảm vẫn phải sạch —
// chứng minh pattern `...$REST` không nuốt chửng mọi object literal.
export function fpPlainObject() {
  // ok: security-sensitive-value-in-http-response
  return { ok: true, nonce };
}

// Ranh giới sanitizer: HMAC là phép băm có khóa nên kết quả KHÔNG phải secret.
// `signCanonical()` trong internal-auth-contracts là hình dạng thật của nhánh này:
// secret đi qua `crypto.subtle.sign` rồi chữ ký hex được trả ra. Không có
// sanitizer thì rule flag đúng cái dòng đó — false positive, và FP kiểu này
// là thứ khiến rule dần biến thành tiếng ồn rồi bị bỏ qua.
// ok: security-sensitive-value-in-http-response
export async function signWithSecret(): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    {
      name: 'HMAC',
      hash: 'SHA-256',
    },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('canonical'));
  return new Uint8Array(signature).toString('hex');
}

// Ranh giới ngược lại, quan trọng ngang nhau: `encrypt` KHÔNG phải sanitizer.
// Ciphertext mà `decrypt` khôi phục lại được plaintext gốc, nên trả nó ra ngoài
// vẫn là rò rỉ — miễn `encrypt` sẽ mở đúng lỗ hổng rule này sinh ra để chặn.
// Ở đây taint đi thẳng từ `token` (nguồn) qua `encrypt` rồi ra `return`, nên
// nếu `encrypt` bị thêm nhầm vào sanitizer, case này sẽ xanh im lặng — đó là
// lý do case này phải tồn tại cùng với case HMAC ở trên.
export async function encryptSecret(): Promise<ArrayBuffer> {
  // ruleid: security-sensitive-value-in-http-response
  return crypto.subtle.encrypt({ name: 'AES-GCM' }, token, new TextEncoder().encode('pt'));
}

// Ranh giới sanitizer `verifyRequest`: đầu vào là secret, đầu ra là KẾT QUẢ
// kiểm tra (`{ok, nonce, timestamp}` | `{ok, reason}`) — không trường nào mang
// lại khóa. Đó là ranh giới một chiều, nên giá trị đi vào không thể đi ra, và
// caller truyền secret ĐỂ KIỂM TRA nó chứ không phải để phát ra nó.
// ok: security-sensitive-value-in-http-response
export async function verifyWithSecret(): Promise<unknown> {
  return verifyRequest({ method: 'POST', path, body, headers, secret, now, claimNonce });
}

// Sanitizer trên KHÔNG được lan sang giá trị khác: handler lộ cả kết quả verify
// lẫn secret vẫn phải bị flag. Nếu `verifyRequest` bị hiểu nhầm là "hàm này
// không bao giờ rò gì" theo nghĩa đen thì case này sẽ xanh im lặng — đó là lý
// do case này phải tồn tại cùng hai case trên.
export async function leakVerifyInput(): Promise<unknown> {
  const outcome = await verifyRequest({
    method: 'POST',
    path,
    body,
    headers,
    secret,
    now,
    claimNonce,
  });
  // ruleid: security-sensitive-value-in-http-response
  return { outcome, secret };
}

// Ranh giới sanitizer `signRequest`: cùng ranh giới một chiều như `verifyRequest`,
// nhưng ở chiều KÝ. `signRequest({secret, …})` trả timestamp + nonce + chữ ký HMAC
// (`v1=<hex>`), không trường nào mang lại secret. Hình dạng dưới đây là hình dạng
// thật của `signInternalRequest` trong `apps/auth`: header đã ký được spread vào một
// object rồi `return`. `new Headers(...)` không được `pattern-not`
// `return $CALLEE({..., ...})` loại (New khác Call), nên không có sanitizer thì
// dòng này bị flag.
// ok: security-sensitive-value-in-http-response
export async function signInternalHeaders(): Promise<Headers> {
  const headers = await signRequest({ method: 'GET', path, body, secret, timestamp, nonce });
  return new Headers({ 'content-type': 'application/json', ...headers });
}

// Sanitizer trên KHÔNG được lan sang giá trị khác — cùng lý do như case
// `leakVerifyInput`: handler trả cả header đã ký LẪN secret vẫn phải bị flag. Nếu
// `signRequest` bị hiểu nhầm thành "hàm này không bao giờ rò gì" theo nghĩa đen thì
// case này sẽ xanh im lặng.
export async function leakSignedInput(): Promise<unknown> {
  const headers = await signRequest({ method: 'GET', path, body, secret, timestamp, nonce });
  // ruleid: security-sensitive-value-in-http-response
  return { headers, secret };
}

export async function leakThroughShadowedSignerLocal(salt: string): Promise<Response> {
  function signRequest(params: { secret: string }): string {
    // ruleid: security-sensitive-value-in-http-response
    return salt + params.secret;
  }
  const out = signRequest({ secret });
  // ruleid: security-sensitive-value-in-http-response
  return json({ data: out });
}

export async function leakThroughShadowedInternalSignerLocal(salt: string): Promise<Response> {
  function signInternalRequest(params: { secret: string }): string {
    // ruleid: security-sensitive-value-in-http-response
    return salt + params.secret;
  }
  const out = signInternalRequest({ secret });
  // ruleid: security-sensitive-value-in-http-response
  return json({ data: out });
}

// Các ca dưới đây GHIM từng sanitizer còn lại trong `pattern-sanitizers`. Quy
// trình ở cuối khối comment trong security.yml đòi mỗi sanitizer phải có ít
// nhất một ca `ok:` phụ thuộc nó: gỡ sanitizer đi thì đúng dòng `ok:` đó phải
// chuyển thành "incorrect line". Đã đo bằng cách gỡ từng sanitizer một — kết
// quả ghi ở comment tương ứng trong security.yml.

// Ghim `signInternalRequest({...secret..., nowMs...})` — hình dạng thật của
// `signInternalRequest` trong `apps/auth/src/account-client.ts`: kết quả đã ký
// được forward vào một lời gọi HAI tham số rồi `return`. Lời gọi hai tham số
// không bị `pattern-not: return $CALLEE({..., ...})` loại, nên không có
// sanitizer thì chính dòng `return send(...)` bị flag — đã đo: gỡ sanitizer
// này ra thì ca này đỏ, và scan repo báo thêm đúng hai finding
// (`account-client.ts:337` và `:349`).
// ok: security-sensitive-value-in-http-response
export async function signInternalForAccountClient(path: string): Promise<Response> {
  const signed = await signInternalRequest({ secret, method: 'GET', path, body, nowMs });
  return send(path, { method: 'GET', headers: signed.headers });
}

// Ghim `crypto.subtle.digest`: SHA-256 KHÔNG có khóa nên đầu vào không suy ra
// được từ digest — trả digest ra ngoài không làm lộ `secret`. `hashBody()` trong
// internal-auth-contracts là hình dạng thật của nhánh này.
// ok: security-sensitive-value-in-http-response
export async function hashSecret(): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
}

// Ghim `crypto.subtle.verify`: kết quả là boolean, một bit không mang lại bit
// nào của khóa, nên không có đường rò rỉ từ giá trị trả về.
// ok: security-sensitive-value-in-http-response
export async function verifySecretMac(key: CryptoKey, signature: ArrayBuffer): Promise<boolean> {
  return crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(secret));
}

// Ghim sanitizer `totalLifetime() < N`: hình dạng thật là `rotateRefreshToken`
// trong apps/auth/src/oidc/provider.ts — biến mang tên nguồn (entity refresh
// token của OIDC provider) chỉ quyết định MỘT BOOLEAN so sánh tuổi. Giá trị
// trả về là một bit, không mang lại bit nào của token. Nếu một hình dạng rò
// rỉ thật muốn trốn qua đây, nó phải trả nguyên `$ENTITY` ra ngoài — hình
// dạng đó KHÔNG khớp sanitizer này và vẫn bị flag (ca `ruleid:` ngay dưới).
// ok: security-sensitive-value-in-http-response
export function refreshLifetimeBoolean(refreshToken: { totalLifetime(): number }): boolean {
  return refreshToken.totalLifetime() < 30 * 24 * 60 * 60;
}

// Ranh giới ngược: entity TỰ NÓ ra ngoài thì vẫn phải bị flag — sanitizer chỉ
// miễn KẾT QUẢ so sánh boolean của hình dạng `totalLifetime() < N`, không miễn
// giá trị entity. Tham số mang tên nguồn (`refreshTokens`) để taint khởi phát:
// branch-2 `return $VALUE` phải bắt nó.
export function leakRefreshEntity(refreshTokens: unknown): unknown {
  // ruleid: security-sensitive-value-in-http-response
  return refreshTokens;
}
