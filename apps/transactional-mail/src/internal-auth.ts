/**
 * Receiver của internal HMAC contract: xác thực envelope của mọi request internal của
 * `transactional-mail` và suy ra principal **từ credential đã khớp**.
 *
 * ## Vì sao receiver phải tự có credential registry
 *
 * ⚠️ **Envelope không mang caller, principal hay key id** (`01-architecture.md` §7.4;
 * `libs/internal-auth-contracts/src/internal-auth.ts` — `SignRequestInput` nhận đúng
 * `một` `secret`, `VerifyResult.ok` chỉ trả `{ nonce, timestamp }`). Hệ quả: **chỉ phía
 * nhận** phân biệt được consumer nào đã ký. Vì vậy `transactional-mail` — tư cách bên
 * nhận — sở hữu registry `principal → credential`, và principal của một request là
 * credential đã khớp chứ không phải thứ gì khác.
 *
 * ⚠️ **Service Binding KHÔNG thay được signature.** Cloudflare ghi rõ không có header
 * hay request property nào phân biệt được request qua Service Binding với request từ
 * internet: mô hình chính thức là *cô lập*, không phải *xác minh*. Cũng vì vậy module
 * này **không đọc** `x-ecoma-principal` hay bất kỳ header identity nào do caller gửi —
 * một header đó là claim, không phải bằng chứng.
 *
 * ⚠️ **Module này KHÔNG log gì.** `reason` không đi ra đây; nó đi qua
 * {@link logInternalRejection} đúng một lần cho mỗi request, từ tầng route. Log theo
 * từng candidate sẽ lộ **vị trí khớp** trong registry.
 *
 * ⚠️ **Module này KHÔNG đọc body.** Body phải được đọc **dưới dạng byte thô** bởi caller
 * (`request.body` là stream một lần — không đọc lại được), có hạn mức, rồi truyền vào
 * đây. Việc verify đọc body là sẽ đọc body lần thứ hai trên một stream đã cạn.
 */

import {
  INTERNAL_BODY_LIMIT_BYTES,
  NONCE_TTL_BUFFER_SECONDS,
  resolveSkewSeconds,
  verifyRequest,
} from '@ecoma-io/internal-auth-contracts';
import type { InternalNonceStore } from '@ecoma-io/transactional-mail-application';

import type { TransactionalMailConfig } from './config';
import type { AuthenticatedPrincipal, AuthRejectionReason } from './principal';

/** Phụ thuộc của {@link authenticateInternalRequest}. */
export interface InternalAuthDeps {
  /** Config đã nạp — nguồn của registry credential, skew, và tập quyền. */
  readonly config: TransactionalMailConfig;
  /** Kho nonce bền của chính `transactional-mail` — tầng ghi duy nhất chống replay. */
  readonly nonces: InternalNonceStore;
  /** Epoch **mili**giây, do caller truyền vào — module này không tự đọc đồng hồ. */
  readonly nowMs: number;
}

/**
 * Kết quả xác thực — union phân biệt bằng `kind`.
 *
 * ⚠️ `rejected` **không mang secret, không mang credential đã thử, không mang nonce**.
 * Chỉ `status` + `reason`: đó là đủ để route trả response và để log một dòng, mà không
 * biến outcome thành một oracle dò chữ ký cho bất kỳ ai đọc được nó.
 */
export type AuthenticationOutcome =
  | { readonly kind: 'authenticated'; readonly principal: AuthenticatedPrincipal }
  | {
      readonly kind: 'rejected';
      readonly status: 401 | 413 | 503;
      readonly reason: AuthRejectionReason;
    };

/**
 * Xác thực một request internal bằng envelope HMAC.
 *
 * ## Thuật toán (theo `01-architecture.md` §7.4)
 *
 * 1. Thân vượt {@link INTERNAL_BODY_LIMIT_BYTES} ⇒ `413`. Đây là **phòng thủ kép**: caller
 *    phải tự chặn lúc đọc (nếu không, một payload khổng lồ đã bị nạp vào heap rồi mới bị
 *    từ chối), còn ở đây nó bảo đảm **trước candidate đầu tiên** không có phép băm nào
 *    chạy — đúng thứ §7.4 đòi.
 * 2. Duyệt `config.credentialRegistry` theo **thứ tự cố định** (`current` trước `previous` của
 *    cùng principal), gọi `verifyRequest` cho từng credential với cùng `now`, cùng
 *    `skewSeconds`, và cùng một `claimNonce` bind theo principal **của candidate đó**.
 * 3. `bad_signature` ⇒ credential không khớp ⇒ **thử tiếp**. Mọi `reason` khác **dừng
 *    ngay**: chúng được kiểm trước băm body/chữ ký nên không phụ thuộc secret, và thử
 *    tiếp không đổi kết quả — chỉ tốn thêm CPU. `replayed_nonce` thuộc nhóm này: nó
 *    chứng minh chữ ký **đã** hợp lệ với một entry nào đó, tức dừng ở đây là đúng chứ
 *    không phải "thử candidate khác có lỡ khớp không".
 * 4. `ok: true` ⇒ trả principal của credential khớp và **dừng ngay**: mỗi request được
 *    chấp nhận tạo **đúng một** claim nonce.
 * 5. Hết candidate mà toàn `bad_signature` ⇒ `401`.
 * 6. Lỗi của kho nonce ⇒ `503` (`nonce_store_unavailable`), **không bao giờ** phải `401`.
 *
 * ## Vì sao path dùng `pathname`, không phải `pathname + search`
 *
 * ⚠️ Canonical của contract ký `path` **kể cả query string**, nhưng `transactional-mail`
 * **không có route nào định nghĩa query string** (`01-architecture.md` §7.4 + bảng
 * endpoint: `delivery_id` nằm trong `path`, không phải query param). Receiver do đó dựng
 * canonical từ `pathname`, và một request **có** query string bị từ chối ngay với
 * `invalid_field` — xem bước 2 bên dưới.
 *
 * ⚠️ Đây là **quyết định của receiver, được kiểm bằng test**, không phải hệ quả hiển nhiên
 * của `URL`: `new URL(...)` có `.pathname` không kèm query, và `pathname + search` sẽ cho
 * một canonical khác với bất kỳ bên ký nào đang ký theo `pathname`. Đổi sang `+ search`
 * không phải một chi tiết — nó đổi canonical mà receiver kiểm, tức **đổi giao thức**, và
 * một thay đổi như vậy phải đi qua test chứ không qua review im lặng.
 *
 * @param deps Registry + kho nonce + đồng hồ (xem {@link InternalAuthDeps}).
 * @param request Request của Workers; chỉ đọc `method`, `headers`, `url`.
 * @param body Byte thô **đã đọc** của thân request; `null` khi request không có thân.
 */
export async function authenticateInternalRequest(
  deps: InternalAuthDeps,
  request: Request,
  body: Uint8Array | null,
): Promise<AuthenticationOutcome> {
  // ⚠️ Chặn TRƯỚC candidate đầu tiên: không có phép băm nào chạy trên một thân vượt hạn
  // mức. Xem JSDoc của hàm ở bước 1.
  if (body !== null && body.byteLength > INTERNAL_BODY_LIMIT_BYTES) {
    return { kind: 'rejected', status: 413, reason: 'invalid_field' };
  }

  const url = new URL(request.url);

  // ⚠️ **Query string ⇒ `invalid_field`, không phải `bad_signature`.** Không route nào của
  // service này định nghĩa query string, nên canonical hợp lệ của mọi endpoint **không
  // bao giờ** chứa một cái. Một request có query vì vậy bị từ chối với một lý do **không
  // phụ thuộc secret** — đúng nghĩa của `invalid_field` ("trường của envelope nhận được
  // không dựng được canonical ở đây"), và từ chối nó **trước vòng duyệt** nghĩa là một
  // request chưa xác thực không tốn N phép HMAC vô ích.
  //
  // ⚠️ Nếu để nó chạy tới `verifyRequest`, kết quả vẫn là từ chối nhưng là
  // `bad_signature` **sau N lần băm + HMAC** — tức một đường tốn CPU tự do trên request
  // chưa xác thực, và một mã lý do sai nghĩa (chữ ký không sai; canonical không dựng
  // được).
  if (url.search !== '') {
    return { kind: 'rejected', status: 401, reason: 'invalid_field' };
  }

  // `resolveSkewSeconds` là đúng hàm lib dùng trong `verifyRequest`, nên con số này
  // không thể lệch với con số mà `verifyRequest` sẽ dùng ở bên dưới — và nó cũng chính là
  // con số dùng cho TTL của nonce. Ba nơi lấy từ CÙNG một hàm là cách không thể lệch.
  const skewSeconds = resolveSkewSeconds(deps.config.skewSeconds);
  const now = String(Math.floor(deps.nowMs / 1000));
  const method = request.method;
  const path = url.pathname;
  const { credentialRegistry: credentials, permissionsByPrincipal } = deps.config;

  try {
    for (const credential of credentials) {
      const verification = await verifyRequest({
        method,
        path,
        body,
        headers: request.headers,
        secret: credential.secret,
        now,
        skewSeconds,
        // ⚠️ Bind theo principal **của candidate này**, không phải theo "principal của
        // request" (thứ chưa biết) và không phải một principal hằng. Khoá của kho nonce là
        // `(principal, nonce)`: một consumer giữ credential hợp lệ không được phép "đốt"
        // nonce của consumer khác bằng key của mình (`01-architecture.md` §7.4).
        claimNonce: (nonce, envelopeTimestamp) =>
          deps.nonces.claimNonce({
            principal: credential.principal,
            nonce,
            // TTL neo theo timestamp **của envelope**, không theo `now` của ta: cửa sổ
            // replay kết thúc ở `timestamp + skew`, nên `+ NONCE_TTL_BUFFER_SECONDS` là
            // lượng sống sót qua đúng cửa sổ đó.
            expiresAtEpochSeconds: envelopeTimestamp + skewSeconds + NONCE_TTL_BUFFER_SECONDS,
          }),
      });

      if (verification.ok) {
        // ⚠️ Dừng ở lần khớp đầu — mỗi request chấp nhận tạo đúng một claim.
        return {
          kind: 'authenticated',
          principal: {
            principal: credential.principal,
            permissions: permissionsByPrincipal.get(credential.principal) ?? [],
          },
        };
      }

      // ⚠️ `bad_signature` là **lý do duy nhất** đi tiếp candidate: nó nói "secret này không
      // phải của envelope". Mọi reason khác không phụ thuộc secret.
      if (verification.reason !== 'bad_signature') {
        return { kind: 'rejected', status: 401, reason: verification.reason };
      }
    }
  } catch {
    // ⚠️ `verifyRequest` **ném** khi `claimNonce` ném — `VerifyFailureReason` không có nhánh
    // cho lỗi kho nonce, và đó là cố ý: `false` (không phải replay) khi kho không gọi được
    // là khẳng định sai, mở cửa sổ replay vĩnh viễn. Fail-closed nghĩa là **503**, không
    // phải 401 và không phải "coi như chưa thấy".
    //
    // ⚠️ Nuốt lỗi mà **không** nối `error` vào bất cứ đâu: message của driver D1 có thể
    // chứa chi tiết binding, và `reason` đã đủ để phân loại sự cố vận hành.
    return { kind: 'rejected', status: 503, reason: 'nonce_store_unavailable' };
  }

  // Hết registry mà không candidate nào khớp — fail-closed, 401 chung cho mọi lý do.
  return { kind: 'rejected', status: 401, reason: 'bad_signature' };
}

/**
 * Ghi MỘT dòng log cho một lần từ chối internal.
 *
 * ⚠️ **Tập trường ở đây là tập ĐÓNG, nên không cần bộ lọc allowlist.** `reason` là mã
 * trong union đóng của `VerifyRequestInput` cộng `nonce_store_unavailable`. Không có byte
 * nào từ request đi vào dòng log — không route, không method, không giá trị header, không
 * tên credential nào đã khớp hay đã thử tới đâu. Lấy `route`/`method` từ request sẽ đưa
 * dữ liệu do người gọi kiểm soát vào log (log injection bằng newline), nên ở đây chúng
 * không được ghi.
 *
 * ⚠️ **Nuốt mọi lỗi** — observability không được nằm trên serving path, nên một lần ghi
 * log thất bại không được làm một request đổi trạng thái.
 *
 * ⚠️ `no-console` bị tắt ở đúng một dòng dưới đây: Workers không có sink nào khác, log
 * đi qua `console.*`, và `observability.enabled` trong `wrangler.jsonc` đã bật sẵn.
 *
 * @param reason Mã lý do từ chối — **chỉ mã**, không bao giờ là message của driver.
 */
export function logInternalRejection(reason: AuthRejectionReason): void {
  try {
    // oxlint-disable-next-line no-console
    console.log(JSON.stringify({ event: 'internal_auth_rejected', reason }));
  } catch {
    // Cố tình im lặng — xem JSDoc ở trên.
  }
}
