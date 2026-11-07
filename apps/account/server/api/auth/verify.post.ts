/**
 * `POST /api/auth/verify` — xác minh OTP và phát hành session.
 *
 * ## Luồng
 *
 * 1. Đọc body (`email`, `code`, `handle` tuỳ chọn), hash địa chỉ như challenge
 *    đã làm.
 * 2. Tìm challenge active. Không có / hết hạn / hết lượt thử → 400 chung chung.
 * 3. Digest mã và so timing-safe với `code_digest`. Sai → tăng `attempts` và
 *    khoá ngay khi đạt trần — cùng trong MỘT câu UPDATE nguyên tử; 400 chung
 *    chung.
 * 4. Đúng → tra cứu địa chỉ **một lần nữa** tại thời điểm verify (không tin thứ
 *    tự事件 giữa challenge và verify): địa chỉ phải vẫn `verified`, account vẫn
 *    `active` — fail-closed với trạng thái account.
 * 5. Consume challenge (single-use, nguyên tử). Thua consume = request trùng đã
 *    thắng, trả 400 — không bao giờ phát hành hai session cho một mã.
 * 6. Tạo session identifier mới (rotate: session anonymous hiện có bị thu hồi
 *    trong cùng transaction), `acr = urn:ecoma:acr:email-otp`, ghi hai cookie
 *    session + CSRF.
 *
 * ## URL confirm sau verify (§5.1.2 hàng 7 — hop `/authorize/confirm`)
 *
 * Khi body mang `handle` (luồng `/authorize` của `auth`), response thành công
 * kèm `confirmUrl` — URL **do server dựng** tuyệt đối từ `NUXT_AUTH_ISSUER`
 * (ADR-0012: account không tự ghép chuỗi từ dữ liệu browser; UI chỉ relay bằng
 * điều hướng). URL chỉ được cấp khi **toàn bộ** các điều kiện cùng đúng:
 *
 * - `authIssuer` đã cấu hình (rỗng ⇒ không cấp — fail-closed, không default);
 * - body mang `handle`;
 * - binding `login_handoffs` khớp **chính session vừa được phát hành** (so khớp
 *   `session_ref` — lớp bảo vệ thứ nhất §3.6, FR-006c; session mới kế thừa
 *   binding từ session bị rotate trong cùng transaction, FR-006c4).
 *
 * Thiếu bất kỳ điều kiện nào ⇒ response vẫn `{ ok: true }` (đăng nhập thành công
 * không đổi) nhưng **không** có `confirmUrl` — UI hiện trạng thái "không tiếp
 * tục được" thay vì điều hướng. Response là additive: luồng đăng nhập account
 * thuần (không handle) không thấy trường này.
 *
 * ⚠️ **Không log `handle` hay `confirmUrl`** (FR-006k3): handle lọt access log,
 * `confirmUrl` chứa nó. Log chỉ ghi có/không có continuation.
 *
 * ## Thông điệp lỗi chung chung
 *
 * Mọi thất bại của luồng verify là `400 { "error": "invalid_code" }` — không phân
 * biệt "chưa từng yêu cầu mã", "mã hết hạn", "mã sai", "hết lượt thử". Phân biệt
 * là oracle cho attacker đang đoán mã: biết "hết hạn" hay "sai" rút ngắn việc
 * vét cạn. `401` dành cho session-based auth; đây là luồng trước-session.
 *
 * ## CSRF
 *
 * Verify là state-changing nhưng xảy ra **trước** khi có session, nên không có
 * CSRF token để kiểm (token phát hành cùng session). Lớp bảo vệ của luồng này là
 * rate-limit cấp mã + trần 5 lần thử per challenge — mô hình giống mọi form
 * pre-auth của OAuth.
 */

import {
  createError,
  defineEventHandler,
  getCookie,
  readValidatedBody,
  setCookie,
  setResponseHeader,
} from 'h3';

import { accountHyperdrive } from '../../utils/bindings';
import { writeLog } from '../../utils/logger';
import { withRequestPool } from '../../utils/db';
import {
  consumeChallenge,
  expireChallengeIfExpired,
  findActiveChallenge,
  lookupVerifiedAddress,
  normalizeAndHashEmail,
  OTP_PURPOSE_LOGIN,
  otpDigest,
  recordFailedAttemptAndLock,
  resolveOtpTarget,
  timingSafeDigestEqual,
} from '../../lib/otp';
import {
  CSRF_COOKIE_NAME,
  createCsrfToken,
  createSessionIdentifier,
  hashSessionIdentifier,
  insertAuthenticatedSession,
  OTP_ACR,
  SESSION_ABSOLUTE_SECONDS,
  SESSION_COOKIE_NAME,
  SESSION_IDLE_SECONDS,
} from '../../lib/session';
import { checkHandoffBinding, expireHandoff, hashHandle, lookupHandoff } from '../../lib/handoff';

interface VerifyBody {
  email: string;
  code: string;
  /** Handle X opaque — tùy chọn; chỉ luồng `/authorize` của `auth` mới mang. */
  handle?: string;
}

/** Body hợp lệ: hình dạng tối thiểu, mã đúng 8 chữ số. */
function isVerifyBody(value: unknown): VerifyBody | false {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const email = (value as { email?: unknown }).email;
  const code = (value as { code?: unknown }).code;
  if (
    typeof email !== 'string' ||
    email.length <= 3 ||
    email.length > 254 ||
    !email.includes('@') ||
    typeof code !== 'string' ||
    !/^\d{8}$/u.test(code)
  ) {
    return false;
  }
  // Handle opaque — hình dạng tối thiểu, cận trên chặn abuse, cùng cận với
  // `isHandoffBody` (`handoff.post.ts`) và `isChallengeBody` (`challenge.post.ts`):
  // không parse, không kiểm định dạng khác. `undefined` = đăng nhập account thuần.
  const handle = (value as { handle?: unknown }).handle;
  if (
    handle !== undefined &&
    (typeof handle !== 'string' || handle.length === 0 || handle.length > 1_000)
  ) {
    return false;
  }
  return handle === undefined ? { email, code } : { email, code, handle };
}

/** Response thành công của verify — `confirmUrl` chỉ có ở luồng continuation. */
export interface VerifyResponse {
  readonly ok: true;
  /** URL `/authorize/confirm` do server dựng — vắng mặt ⇒ không có continuation. */
  readonly confirmUrl?: string;
}

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store');

  const body = await readValidatedBody(event, isVerifyBody).catch(() => null);
  if (body === null) {
    // Body sai hình dạng — khác `invalid_code` ở chỗ người gọi tự sửa được;
    // vẫn chung 400 nhưng mã lỗi nói rõ phần sai của request.
    throw createError({ statusCode: 400, statusMessage: 'Bad Request' });
  }

  const config = useRuntimeConfig(event);
  const otpSecret = config.otpHmacSecret;
  const hyperdrive = accountHyperdrive(config);
  if (typeof otpSecret !== 'string' || otpSecret.length === 0 || !hyperdrive) {
    writeLog({ event: 'otp_verify.failed', status: 503, reason: 'config_or_binding_missing' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  const { hash } = await normalizeAndHashEmail(body.email);

  // `session_ref` của session vừa phát hành — hoá ra khỏi closure để bước URL
  // confirm bên dưới so khớp binding đúng với session browser đang cầm cookie.
  let issuedSessionRef: string | undefined;

  try {
    const result = await withRequestPool(hyperdrive, async (pool) => {
      const challenge = await findActiveChallenge(pool, hash, OTP_PURPOSE_LOGIN);
      if (challenge === null) {
        writeLog({ event: 'otp_verify.rejected', status: 400, reason: 'no_active_challenge' });
        return false;
      }
      const nowMs = Date.now();
      if (isExpired(challenge.expires_at, nowMs)) {
        // Hết hạn: khoá nguyên tử hàng này (hygiene vòng đời — chi tiết ở
        // `expireChallengeIfExpired`) rồi từ chối như mọi nhánh khác. Khoá KHÔNG
        // đổi response: vẫn 400 chung chung, không chữ "hết hạn" phân biệt được
        // ra ngoài.
        await expireChallengeIfExpired(pool, hash, OTP_PURPOSE_LOGIN, nowMs);
        writeLog({ event: 'otp_verify.rejected', status: 400, reason: 'challenge_expired' });
        return false;
      }

      const digest = await otpDigest(otpSecret, OTP_PURPOSE_LOGIN, body.code);
      if (!timingSafeDigestEqual(digest, challenge.code_digest)) {
        // Tăng và khoá trong MỘT câu UPDATE: nếu khoá là UPDATE riêng chạy sau,
        // hai request cạnh nhau có khoảng trống giữa tăng và khoá để lần thử
        // thứ MAX_OTP_ATTEMPTS + 1 tăng tiếp — trần thành tuỳ hứng.
        await recordFailedAttemptAndLock(pool, challenge.id);
        writeLog({ event: 'otp_verify.rejected', status: 400, reason: 'code_mismatch' });
        return false;
      }

      // Đúng mã — xác minh lại trạng thái địa chỉ + account TẠI THỜI ĐIỂM verify.
      // Account suspended giữa lúc cấp mã và verify phải dừng ở đây (FR-012).
      const target = resolveOtpTarget(await lookupVerifiedAddress(pool, hash));
      if (target.kind !== 'verified' || target.userSub === undefined) {
        writeLog({ event: 'otp_verify.rejected', status: 400, reason: 'address_unusable' });
        return false;
      }

      // Consume trước khi phát hành — single-use của mã là thứ giữ hai request
      // mang cùng mã không phát hành hai session.
      const consumed = await consumeChallenge(pool, challenge.id);
      if (!consumed) {
        writeLog({ event: 'otp_verify.rejected', status: 400, reason: 'already_consumed' });
        return false;
      }

      // Rotate (FR-004a): session anonymous của browser (nếu có) bị thu hồi trong
      // cùng transaction với INSERT session mới. Đọc cookie cũ — giá trị, không
      // hash — để biết session_ref cần thu hồi.
      //
      // Cùng session_ref đó là mốc chuyển binding handoff (FR-006c4, §3.6.2):
      // nếu trình duyệt trình X ở bước challenge, binding đang trỏ vào session
      // (anonymous) cũ và PHẢI chuyển sang session mới trong đúng transaction
      // rotate — tách ra là một khoảng chết sống sót giữa hai thao tác, đúng
      // cái §3.6.2 gọi là login hỏng. Không có binding thì UPDATE khớp 0 hàng,
      // rotate đi tiếp bình thường.
      const previousCookie = getCookie(event, '__Host-account-session');
      const previousHash =
        previousCookie === undefined ? null : await hashSessionIdentifier(previousCookie);
      const revokeRef =
        previousHash === null ? undefined : await findSessionRefByHash(pool, previousHash);

      const identifier = createSessionIdentifier();
      const sessionRef = await hashSessionIdentifier(identifier + ':ref:' + target.userSub);
      issuedSessionRef = sessionRef;
      const now = Date.now();
      await insertAuthenticatedSession(pool, {
        idHash: await hashSessionIdentifier(identifier),
        sessionRef,
        userSub: target.userSub,
        acr: OTP_ACR,
        authnAt: new Date(now),
        expiresAt: new Date(now + SESSION_IDLE_SECONDS * 1000),
        revokeSessionRef: revokeRef,
        // FR-006c4: chuyển binding trong cùng transaction rotate — session mới
        // kế thừa binding, không có session thứ ba chiếm X giữa hai bước.
        carryHandoffFromSessionRef: revokeRef,
      });

      const csrfToken = createCsrfToken();
      setResponseHeader(event, 'Cache-Control', 'no-store');
      setCookie(event, SESSION_COOKIE_NAME, identifier, {
        maxAge: SESSION_ABSOLUTE_SECONDS,
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
      });
      setCookie(event, CSRF_COOKIE_NAME, csrfToken, {
        maxAge: SESSION_ABSOLUTE_SECONDS,
        path: '/',
        secure: true,
        sameSite: 'lax',
      });
      writeLog({ event: 'otp_verify.issued', status: 200, sub: target.userSub });
      return true;
    });

    if (!result) {
      // Cùng một body lỗi cho mọi nhánh từ chối — anti-guessing.
      throw createError({ statusCode: 400, statusMessage: 'Bad Request' });
    }
  } catch (error) {
    if (isHttpError(error)) {
      throw error;
    }
    writeLog({ event: 'otp_verify.failed', status: 503, reason: 'db_unreachable' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  // ── URL confirm sau verify (§5.1.2 hàng 7) ─────────────────────────────────
  //
  // Chạy SAU khi session đã phát hành: đăng nhập thành công không phụ thuộc
  // bước này — mọi nhánh không cấp URL vẫn là `{ ok: true }`. Đọc binding TRÊN
  // session MỚI (rotate đã chuyển binding sang `session_ref` mới — FR-006c4),
  // tức đúng session mà browser đang cầm cookie sau response này.
  let confirmUrl: string | undefined;
  const issuer = typeof config.authIssuer === 'string' ? config.authIssuer : '';
  if (issuer !== '' && body.handle !== undefined && hyperdrive !== null) {
    try {
      const handleHash = await hashHandle(body.handle);
      const bindingCheck = await withRequestPool(hyperdrive, async (pool) => {
        // Hygiene TTL như `handoff.post.ts`: mark `expired` trước khi so khớp —
        // quyết định fail của `checkHandoffBinding` tự so `expires_at` với mốc
        // now, bước này chỉ để state DB khớp sự thật máy trạng thái.
        const row = await lookupHandoff(pool, handleHash);
        if (row !== null && row.expires_at.getTime() <= Date.now()) {
          await expireHandoff(pool, handleHash, Date.now());
        }
        // `result === true` nghĩa là `issuedSessionRef` đã được gán trong
        // closure — TS không theo được liên kết đó qua `withRequestPool`, cast
        // ở đây phản ánh đúng thứ tự thực thi.
        return checkHandoffBinding(row, {
          sessionRef: issuedSessionRef as string,
          nowMs: Date.now(),
        });
      });
      if (bindingCheck.kind === 'matched') {
        const url = new URL('/authorize/confirm', issuer);
        url.searchParams.set('handle', body.handle);
        confirmUrl = url.href;
        writeLog({ event: 'otp_verify.confirm_url', status: 200 });
      } else {
        // Handle lạ, trình khác session, đã dùng hay hết TTL — cùng một log
        // chung, không giá trị handle, không phân biệt mã lỗi ra ngoài
        // (không oracle thêm cho holder của X).
        writeLog({ event: 'otp_verify.confirm_url_skipped', status: 200 });
      }
    } catch {
      // DB chết khi đọc binding: đăng nhập đã xong, không được biến nó thành
      // 5xx — chỉ bỏ cấp URL (fail-closed của continuation, không phải của login).
      writeLog({ event: 'otp_verify.confirm_url_skipped', status: 200, reason: 'db_unreachable' });
    }
  } else {
    writeLog({ event: 'otp_verify.confirm_url_skipped', status: 200, reason: 'no_continuation' });
  }

  return confirmUrl === undefined ? { ok: true } : { ok: true, confirmUrl };
});

/** Challenge đã quá hạn chưa — thuần. */
function isExpired(expiresAt: Date, nowMs: number): boolean {
  return nowMs >= expiresAt.getTime();
}

/** `session_ref` của session đang sống theo hash identifier — cho rotation. */
async function findSessionRefByHash(
  pool: import('pg').Pool,
  idHash: string,
): Promise<string | undefined> {
  const result = await pool.query<{ session_ref: string }>(
    `SELECT session_ref FROM account.account_sessions
      WHERE id_hash = $1 AND revoked_at IS NULL
      LIMIT 1`,
    [idHash],
  );
  return result.rows[0]?.session_ref;
}

/** HTTPError của h3 (đã có statusCode) — không bọc lại thành 503. */
function isHttpError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof (error as { statusCode?: unknown }).statusCode === 'number'
  );
}

export type { VerifyBody };
