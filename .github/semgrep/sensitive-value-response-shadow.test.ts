// Fixture cho rule `security-sensitive-value-in-http-response`: phần chứng minh ranh
// giới sanitizer khớp theo HÌNH DẠNG envelope, không theo tên trần.
//
// Tách khỏi `sensitive-value-response.test.ts` có chủ đích: ở đó có khai báo
// `signRequest`/`signInternalRequest` phạm vi module, nên một hàm cục bộ trùng tên sẽ
// vi phạm `no-shadow` của oxlint. File này KHÔNG khai báo bản module-scope nào, nên
// hàm cục bộ ở đây là cái duy nhất trong file và không shadow ai.
//
// Mỗi hàm cục bộ cố ý đọc một biến của scope cha (`salt`) để không vướng
// `unicorn/consistent-function-scoping` — việc đó không đổi điều cần chứng minh: hàm
// vẫn trả lại chính `params.secret`.
//
// Điều phải chứng minh: một hàm tên `signRequest` / `signInternalRequest` nhưng KHÔNG
// có hình dạng envelope (`secret` + `timestamp`, hoặc `secret` + `nowMs`) không được
// miễn, nên secret nó trả ra vẫn bị báo khi rời handler.
//
// Đo được với rule cũ (sanitizer `- pattern: signRequest(...)` trần): dòng `return
// json({ data: out })` trong `leakThroughShadowedSigner` KHÔNG bị báo — taint biến mất
// ngay tại lời gọi trùng tên. Với rule đã hẹp: CÓ bị báo.

export function leakThroughShadowedSigner(salt: string): Response {
  function signRequest(params: { secret: string }): string {
    // ruleid: security-sensitive-value-in-http-response
    return salt + params.secret;
  }
  const out = signRequest({ secret });
  // ruleid: security-sensitive-value-in-http-response
  return json({ data: out });
}

export function leakThroughShadowedInternalSigner(salt: string): Response {
  function signInternalRequest(params: { secret: string }): string {
    // ruleid: security-sensitive-value-in-http-response
    return salt + params.secret;
  }
  const out = signInternalRequest({ secret });
  // ruleid: security-sensitive-value-in-http-response
  return json({ data: out });
}

declare function json(body: unknown): Response;
declare const secret: string;
