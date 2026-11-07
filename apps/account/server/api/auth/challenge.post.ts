/**
 * `POST /api/auth/challenge` — cấp OTP đăng nhập cho một địa chỉ email.
 *
 * ## Anti-enumeration là bất biến số một của route này
 *
 * Mọi request với `email` hợp lệ về hình dạng nhận **cùng một response** —
 * `204`, không body — dù địa chỉ:
 *
 * - tồn tại và đã `verified` (mail thật được gửi),
 * - tồn tại nhưng `pending`/`revoked`,
 * - không tồn tại,
 * - thuộc account `suspended`/`deleted`,
 * - hay vừa bị rate-limit.
 *
 * Lý do: một response phân biệt được là một oracle đo sự tồn tại của account
 * (FR-011b áp cùng nguyên tắc cho contract status). Kẻ dò địa chỉ chỉ cần một
 * byte khác nhau để map toàn bộ cơ sở người dùng. Vì vậy ngay cả rate-limit
 * response cũng phải giống response thành công — kẻ dò không học được gì, còn
 * user thật sẽ không nhận mail và tự hiểu (mail không tới).
 *
 * ## Vẫn ghi challenge cho địa chỉ lạ
 *
 * Với địa chỉ không thuộc account nào, route **vẫn** ghi một hàng `otp_challenges`
 * ("challenge ma") với digest của một mã sẽ không bao giờ được gửi. Hai lý do:
 * (1) rate-limit đếm từ bảng này nên địa chỉ lạ phải chịu cùng giới hạn — nếu
 * không, dò địa chỉ là thao tác miễn phí trong khi user thật bị limit; (2) thời
 * gian xử lý hai nhánh là như nhau (một lần tra cứu + một lần ghi), không rò qua
 * timing. Mã của challenge ma cũng được sinh thật rồi digest — không có nhánh
 * "bỏ qua crypto" để không tạo lệch thời gian.
 *
 * ## Cooldown resend và rate limit trả cùng 204
 *
 * Cả hai là điều kiện bị chặn của cùng một luồng, và cả hai cùng không được phân
 * biệt với thành công. Challenge active còn cooldown: consume và cấp mã mới
 * **không** diễn ra — người dùng nhấn resend liên tục không được mail mới trước
 * 60 giây, nhưng không được biết là bị chặn.
 *
 * ## Binding handle X — first-binding-wins tại đây (FR-006c, FR-006c2)
 *
 * Khi body mang `handle` (opaque handle X do `auth` cấp trong `?handle=` của
 * `/login`), route ghi binding đầu tiên vào `login_handoffs` **trước** khi cấp
 * mã: handle X phải gắn với session đã trình nó (§3.6), không sau khi đăng nhập.
 * FR-006c: nếu browser chưa có session nào, một **session anonymous** được tạo
 * rồi handle bind vào đó — X không bao giờ được bind vào "không có session".
 *
 * Binding là một `INSERT ... ON CONFLICT DO NOTHING` duy nhất (first-binding-
 * wins, AC-008b2): request này thắng khi chưa ai bind, và đi tiếp bình thường;
 * khi session khác đã bind trước, request này chỉ **so khớp** và cũng đi tiếp
 * bình thường — response vẫn 204, anti-enumeration không bị phá. Việc từ chối
 * thật sự diễn ra ở `/api/auth/handoff` (so khớp trước push), không ở đây: một
 * nhánh bị chặn ở challenge sẽ là một response phân biệt được cho kẻ dò, còn
 * ở đây im lặng đúng nghĩa "route cấp mã không biết gì về tranh chấp binding".
 *
 * ⚠️ **Không log giá trị handle** — chỉ `handle_hash` (§3.6; X đi qua query
 * string, lọt vào access log của tầng trung gian).
 *
 * ⚠️ `handle` sai hình dạng (không phải chuỗi 1–1000 ký tự) bị 400 trước khi
 * chạm crypto/DB — cùng cách body sai hình dạng của `email` là 400.
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
  sendMail,
  buildOtpMailRequest,
  otpMailCorrelationId,
  otpMailIdempotencyKey,
} from '../../lib/mail';
import {
  countChallengesSince,
  createOtpChallenge,
  findActiveChallenge,
  insertChallenge,
  isRateLimited,
  isResendBlocked,
  isUniqueViolation,
  lookupVerifiedAddress,
  normalizeAndHashEmail,
  OTP_PURPOSE_LOGIN,
  OTP_RATE_LIMIT_HOUR_WINDOW_SECONDS,
  OTP_RATE_LIMIT_SHORT_WINDOW_SECONDS,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_SECONDS,
  resolveOtpTarget,
} from '../../lib/otp';
import { LOGIN_HANDOFF_TTL_SECONDS, bindHandleFirst, hashHandle } from '../../lib/handoff';
import {
  ANONYMOUS_SESSION_TTL_SECONDS,
  SESSION_COOKIE_NAME,
  SESSION_ABSOLUTE_SECONDS,
  createSessionIdentifier,
  hashSessionIdentifier,
  insertAnonymousSession,
} from '../../lib/session';

/** Body hợp lệ: `email` là chuỗi có hình dạng địa chỉ, giới hạn độ dài để chống abuse. */
interface ChallengeBody {
  email: string;
  /** Handle X opaque — tùy chọn; chỉ luồng `/authorize` của `auth` mới mang. */
  handle?: string;
}

function isChallengeBody(value: unknown): ChallengeBody | false {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const email = (value as { email?: unknown }).email;
  // Hình dạng tối thiểu — không phải RFC 5321 đầy đủ. Chuỗi rỗng, quá dài
  // (> 254 theo RFC 5321 giới hạn path) hay thiếu `@` bị 400; mọi địa chỉ khác
  // đi qua luồng anti-enumeration bình thường.
  if (
    typeof email !== 'string' ||
    email.length <= 3 ||
    email.length > 254 ||
    !email.includes('@')
  ) {
    return false;
  }
  // Handle opaque — hình dạng tối thiểu, cận trên chặn abuse, cùng cận với
  // `isHandoffBody` (`handoff.post.ts`): không parse, không kiểm định dạng
  // khác. `undefined` = gọi từ `/login` thuần (không có luồng `/authorize`).
  const handle = (value as { handle?: unknown }).handle;
  if (
    handle !== undefined &&
    (typeof handle !== 'string' || handle.length === 0 || handle.length > 1_000)
  ) {
    return false;
  }
  return handle === undefined ? { email } : { email, handle };
}

export default defineEventHandler(async (event) => {
  // FR-011e là cho contract status; route public này tương tự không được cache —
  // mỗi request là một lần cấp mã.
  setResponseHeader(event, 'Cache-Control', 'no-store');

  const body = await readValidatedBody(event, isChallengeBody).catch(() => null);
  if (body === null) {
    // 400 chỉ cho body sai **hình dạng** — điều người gọi có thể tự sửa, không
    // lộ gì về tồn tại của account.
    throw createError({ statusCode: 400, statusMessage: 'Bad Request' });
  }

  // `useRuntimeConfig(event)` — truyền event như mọi route khác: binding của
  // request đến từ env của Worker trên preset Cloudflare.
  const config = useRuntimeConfig(event);
  const otpSecret = config.otpHmacSecret;
  const hyperdrive = accountHyperdrive(config);
  if (typeof otpSecret !== 'string' || otpSecret.length === 0 || !hyperdrive) {
    // Fail closed: không có secret hay DB thì không cấp mã. Trả 503 chung —
    // không phân biệt thiếu config với DB chết qua response.
    writeLog({ event: 'otp_challenge.failed', status: 503, reason: 'config_or_binding_missing' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  const { hash } = await normalizeAndHashEmail(body.email);

  // Quyết định rate-limit/cooldown **trước** block binding (OCR): block binding
  // ghi `account_sessions` anonymous + `login_handoffs` — hàng DB thật của một
  // endpoint public. Rate limit đếm `otp_challenges` (ghi sau state này) nên nó
  // không gate được phần trước; với handle mới + không cookie, mỗi request bị
  // limit vẫn tạo 2 hàng. Xác định sớm nhánh bị chặn để **bỏ qua ghi binding**
  // — response vẫn 204, anti-enumeration giữ nguyên (kẻ dò không phân biệt được
  // nhánh này), chỉ lượng ghi DB là 0.
  let otpBlocked: boolean;
  try {
    otpBlocked = await withRequestPool(hyperdrive, async (pool) => {
      // Hai cửa sổ trượt của rate limit — phép đo **pre-check** ngoài transaction.
      // Đây không phải guard cấp mã (guard cuối cùng nằm trong `insertChallenge`,
      // xem OCR-3) — vai trò của phép đo này là DOẦN ĐO trước khi block binding
      // có cơ hội ghi hàng: request sắp bị rate-limit/cooldown không được tạo ra
      // hàng `account_sessions`/`login_handoffs` mới (OCR vòng 2). Phép đo ngoài
      // transaction không tuần tự hoá được với INSERT — N request đồng thời có
      // thể cùng thấy còn dư allowance rồi cùng đi tiếp; phần tràn còn lại do
      // đo trong `insertChallenge` đóng lại.
      const [shortCount, hourCount] = await Promise.all([
        countChallengesSince(pool, hash, OTP_RATE_LIMIT_SHORT_WINDOW_SECONDS),
        countChallengesSince(pool, hash, OTP_RATE_LIMIT_HOUR_WINDOW_SECONDS),
      ]);
      if (isRateLimited(shortCount, hourCount)) {
        return true;
      }
      // Cooldown resend cùng họ: một challenge active còn dưới 60s nghĩa là
      // request này không được cấp mã — cũng không ghi binding mới.
      const active = await findActiveChallenge(pool, hash, OTP_PURPOSE_LOGIN);
      return active !== null && isResendBlocked(active.created_at, Date.now());
    });
  } catch {
    writeLog({ event: 'otp_challenge.failed', status: 503, reason: 'db_unreachable' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }
  if (otpBlocked) {
    writeLog({ event: 'otp_challenge.suppressed', status: 204 });
    event.node.res.statusCode = 204;
    return null;
  }

  // Binding handle X — TRƯỚC khi cấp mã (FR-006c: "ràng buộc ngay khi được
  // trình"). Chỉ chạy khi body mang handle; `/login` thuần đi tiếp như cũ.
  //
  // ⚠️ Chỉ tới được đây khi phép đo pre-check phía trên chưa thấy request bị
  // chặn — tức là mỗi lần ghi binding tương ứng một attempt **có thể** được cấp
  // mã, không phải mỗi lần dò. Guard cấp mã cuối cùng vẫn nằm trong
  // `insertChallenge` (OCR-3), nên một request race lọt qua pre-check có thể
  // bị chặn ở đó — trong trường hợp đó nó đã ghi binding mà không cấp mã; đây
  // là mức chênh lệch gần như không thể xảy ra (binding chỉ ghi khi request đi
  // qua cùng phép đo) và chấp nhận được vì binding tự hoá theo TTL 10 phút
  // (không prune job) và response vẫn 204 mọi nhánh.
  //
  // ⚠️ Nhánh lỗi của phần này **không** bao giờ đổi response: binding thành
  // công hay thua đều 204 — từ chối thật sự là việc của handoff route, một
  // response khác nhau ở đây là oracle cho kẻ dò đúng như mọi nhánh khác trên.
  if (body.handle !== undefined) {
    const handleHash = await hashHandle(body.handle);
    try {
      await withRequestPool(hyperdrive, async (handoffPool) => {
        // Session trình X: cookie hiện có (nếu còn khớp một hàng còn sống)
        // hoặc session anonymous được tạo ngay đây — FR-006c, X không bind vào
        // "không có session".
        //
        // L3: `expires_at` được kiểm ở đây chứ không chỉ `revoked_at` — một
        // session đã quá idle-expiry nhưng chưa bị thu hồi không được chọn làm
        // session trình X (nó sẽ bị `isSessionLive` của handoff route từ chối
        // sau này, để lại binding orphan + một log `binding_mismatch` sai nhánh).
        // Điều kiện `expires_at > now()` là chính phép kiểm của `isSessionLive`
        // đẩy xuống SQL, đáng tin hơn đồng hồ Worker so với hàng.
        const previousCookie = getCookie(event, SESSION_COOKIE_NAME);
        let presentSessionRef: string | undefined;
        if (previousCookie !== undefined) {
          const idHash = await hashSessionIdentifier(previousCookie);
          const existing = await handoffPool.query<{
            session_ref: string;
            revoked_at: Date | null;
          }>(
            `SELECT session_ref, revoked_at FROM account.account_sessions
              WHERE id_hash = $1 AND revoked_at IS NULL AND expires_at > now()
              LIMIT 1`,
            [idHash],
          );
          const row = existing.rows[0];
          if (row !== undefined) {
            presentSessionRef = row.session_ref;
          }
        }
        if (presentSessionRef === undefined) {
          // Không cookie / cookie không khớp gì (hoặc đã chết): cấp session
          // anonymous mới. Rotate FR-004a lúc verify sẽ thu hồi nó trong cùng
          // transaction — anonymous session chỉ là vật chứa của binding,
          // không có quyền nào.
          //
          // L2: hai Statement (session anonymous + binding) chạy trong **một**
          // transaction `PoolClient` — cùng hình thức `insertAuthenticatedSession`
          // (§3.6.2). Nếu binding fail sau khi session đã ghi trên `Pool` thuần,
          // một hàng anonymous orphan không có đường dọn nào sẽ nằm lại; quấn
          // transaction khiến hai bước cùng thành công hay cùng không có gì —
          // đúng nghĩa "X không bind vào một session không tồn tại được phép
          // sinh ra".
          const identifier = createSessionIdentifier();
          const idHash = await hashSessionIdentifier(identifier);
          const anonymousRef = await hashSessionIdentifier(`${identifier}:ref:anonymous`);
          const client = await handoffPool.connect();
          try {
            await client.query('BEGIN');
            await insertAnonymousSession(client, {
              idHash,
              sessionRef: anonymousRef,
              expiresAt: new Date(Date.now() + ANONYMOUS_SESSION_TTL_SECONDS * 1000),
            });
            await bindHandleFirst(client, {
              handleHash,
              presentSessionRef: anonymousRef,
              expiresAt: new Date(Date.now() + LOGIN_HANDOFF_TTL_SECONDS * 1000),
            });
            await client.query('COMMIT');
            // Cookie đi ra ngoài response ở cuối handler — cùng thuộc tính với
            // cookie của verify (FR-004). setCookie ghi header response NGAY LẶP
            // TỨC, nên nó PHẢI đứng sau COMMIT: bind hay COMMIT thất bại ⇒
            // rollback ⇒ không cookie nào rò ra browser trỏ tới một hàng session
            // không tồn tại trong DB.
            setCookie(event, SESSION_COOKIE_NAME, identifier, {
              maxAge: SESSION_ABSOLUTE_SECONDS,
              path: '/',
              secure: true,
              httpOnly: true,
              sameSite: 'lax',
            });
          } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
          } finally {
            client.release();
          }
          presentSessionRef = anonymousRef;
        }

        const binding = await bindHandleFirst(handoffPool, {
          handleHash,
          presentSessionRef,
          expiresAt: new Date(Date.now() + LOGIN_HANDOFF_TTL_SECONDS * 1000),
        });
        // So khớp thôi — không ghi đè, không phân nhánh response. Binding của
        // session khác được giữ nguyên vẹn (FR-006c3, lớp 1); handoff route
        // là nơi fail `binding_mismatch` (§3.6: so khớp trước push).
        writeLog({
          event: 'otp_challenge.handoff_binding',
          status: 204,
          bound_to_current: binding.session_ref === presentSessionRef,
        });
        return undefined;
      });
    } catch {
      // DB chết khi ghi binding: 503 chung như mọi lỗi DB của route. Không có
      // đường nào "bỏ qua binding mà vẫn cấp mã" — X không bind nghĩa là
      // `/login?handle=X` của trình duyệt này không thể hoàn tất handoff sau;
      // đó là fail-closed đúng nghĩa, và 503 là response chung của mọi hỏng DB.
      writeLog({
        event: 'otp_challenge.failed',
        status: 503,
        reason: 'handoff_binding_unavailable',
      });
      throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
    }
  }

  let outcome: 'sent' | 'silently_rejected';
  try {
    outcome = await withRequestPool(hyperdrive, async (pool) => {
      // OCR-3: phép đo rolling-window cuối cùng đã được dời **vào transaction**
      // của `insertChallenge` (khoá hàng active `FOR UPDATE` trước — đếm hai cửa
      // sổ sau, Hyperdrive không hỗ trợ advisory lock nên tuần tự hoá dựa vào
      // chuỗi khoá hàng + partial UNIQUE index) — đó là nơi tuần tự hoá thực sự
      // với COMMIT của transaction trước cùng địa chỉ. Phép đo `otpBlocked` phía
      // trên chỉ gate block binding (để không ghi `account_sessions`/
      // `login_handoffs` cho request sẽ bị rate-limit) và không còn là guard cấp
      // mã. Route không đo lại ở đây nữa: đo lại bằng `Pool` chung là redundant
      // query, và không tuần tự hoá được gì với INSERT.
      //
      // Sinh mã + digest — cho **mọi** địa chỉ, kể cả lạ (challenge ma).
      const material = await createOtpChallenge(otpSecret, OTP_PURPOSE_LOGIN);
      const expiresAt = new Date(Date.now() + OTP_TTL_SECONDS * 1000);

      // Tra cứu địa chỉ — quyết định gửi mail hay không, KHÔNG quyết định response.
      const target = resolveOtpTarget(await lookupVerifiedAddress(pool, hash));

      let inserted: { id: string; expiresAt: Date } | undefined;
      try {
        inserted = await insertChallenge(pool, {
          addressHash: hash,
          digest: material.digest,
          purpose: OTP_PURPOSE_LOGIN,
          expiresAt,
          resendCooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS,
          rateLimitShortWindowSeconds: OTP_RATE_LIMIT_SHORT_WINDOW_SECONDS,
          rateLimitHourWindowSeconds: OTP_RATE_LIMIT_HOUR_WINDOW_SECONDS,
        });
        if (inserted === undefined) {
          // Bị chặn **trong** transaction — cửa sổ trượt đã tràn hoặc request
          // song song vừa commit một challenge còn trong 60s cooldown. Cả hai
          // cùng họ nhánh bị chặn bình thường, về `silently_rejected` (204): KHÔNG
          // có hàng nào bị consume, KHÔNG có mail đi ra.
          return 'silently_rejected' as const;
        }
      } catch (error) {
        if (isUniqueViolation(error)) {
          // Thua race: request song song vừa consume/insert trước. Đây là nhánh
          // bị chặn bình thường — cùng họ với cooldown — nên về `silently_rejected`
          // (204). Ném tiếp sẽ thành 503, một response phân biệt được và là
          // oracle cho kẻ dò ("địa chỉ này đang có người cấp mã thật").
          return 'silently_rejected' as const;
        }
        throw error;
      }

      if (target.kind !== 'verified') {
        // Challenge ma: digest được ghi (rate-limit địa chỉ lạ như địa chỉ thật),
        // mail KHÔNG đi ra. Log mã ổn định — không log địa chỉ (đó là dữ liệu
        // định danh, SR-001; address_hash đủ để điều tra mà không lộ).
        return 'silently_rejected' as const;
      }

      // ⚠️ Mail đi ra CHỈ SAU khi `insertChallenge` đã cấp `id` (UUID của DB):
      // id là identity duy nhất per challenge — nguồn của `Idempotency-Key` lẫn
      // `correlation_id`. Derive khoá từ digest HMAC của mã là sai: digest tất định
      // theo (key, purpose, code) và mã chỉ có 10^8 giá trị, nên hai challenge trùng
      // mã ⇒ cùng khoá ⇒ receiver trả `200` replay thay vì gửi mail thứ hai — user
      // thứ hai không nhận được mã, một lỗi im lặng. UUID không thể va: PRIMARY KEY
      // của DB là ràng buộc cuối cùng. Xem `otpMailIdempotencyKey` (lib/mail.ts).
      const mailResult = await sendConfigured(config, {
        recipient: body.email,
        code: material.code,
        challengeId: inserted.id,
      });

      // Mail lỗi không đổi response (anti-enumeration) — chỉ log mã lý do.
      //
      // ⚠️ Nuốt lỗi ở đây KHÔNG đồng nghĩa với ngụy trang: `sendMail` không bao giờ
      // ném cho lỗi đã phân loại (`rejected`/`invalid_payload`/`unreachable` đều là
      // `{ ok: false, reason }` — lib/mail.ts), và response luôn 204 giữ nguyên.
      // Bằng chứng phía service duy nhất của nhánh failed là log `mail_failed`
      // dưới: đây là contract observability của route (SR-010 — quan sát, không
      // điều kiện cấp), và không đường nào biến một gửi-thất-bại thành `ok` hay
      // response "đã gửi" cho client.
      if (!mailResult.ok) {
        writeLog({
          event: 'otp_challenge.mail_failed',
          status: 204,
          reason: mailResult.reason,
          error_code: mailResult.detail ?? 'none',
        });
      } else {
        writeLog({ event: 'otp_challenge.created', status: 204 });
      }
      return 'sent' as const;
    });
  } catch {
    writeLog({ event: 'otp_challenge.failed', status: 503, reason: 'db_unreachable' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  // Nhánh nào cũng 204 — bất biến anti-enumeration của route.
  setResponseHeader(event, 'Cache-Control', 'no-store');
  if (outcome === 'silently_rejected') {
    writeLog({ event: 'otp_challenge.suppressed', status: 204 });
  }
  event.node.res.statusCode = 204;
  return null;
});

/**
 * Gửi mail với URL + credential ký từ config — tách hàm để route ngắn và để test
 * mock được `sendMail` qua module mock mà không dựng runtime config.
 *
 * ⚠️ `Idempotency-Key` per-challenge: `sendMail` nhận khoá **tường minh** từ
 * `otpMailIdempotencyKey(challengeId)` — `challengeId` là UUID mà `insertChallenge`
 * vừa ghi (identity duy nhất per challenge, stable cho retry). Không derive từ digest
 * HMAC của mã: digest tất định theo (key, purpose, code), hai challenge trùng mã 8
 * chữ số ⇒ cùng digest ⇒ cùng khoá ⇒ mail thứ hai bị receiver coi là replay — đúng
 * lỗi mà cách derive cũ đã có. `correlation_id` đi vào body dùng cùng challengeId
 * (quan sát), tách bạch với khoá (an toàn) — xem lib/mail.ts.
 *
 * ⚠️ Credential ký là của riêng path Account↔Mail (`NUXT_MAIL_INTERNAL_AUTH_SECRET`),
 * và thiếu nó là một reason riêng của `sendMail` (`credential_missing`) — không
 * ngụy trang thành `config_missing` của URL hay lỗi transport, để log giữ được
 * nhánh "thiếu secret" tách khỏi nhánh "URL sai khi cài đặt".
 */
function sendConfigured(
  config: { mailServiceUrl?: unknown; mailInternalAuthSecret?: unknown },
  params: { recipient: string; code: string; challengeId: string },
): ReturnType<typeof sendMail> {
  const url = typeof config.mailServiceUrl === 'string' ? config.mailServiceUrl : undefined;
  const signingSecret =
    typeof config.mailInternalAuthSecret === 'string' ? config.mailInternalAuthSecret : undefined;
  const request = buildOtpMailRequest({
    recipient: params.recipient,
    code: params.code,
    correlationId: otpMailCorrelationId(params.challengeId),
  });
  return sendMail(url, request, otpMailIdempotencyKey(params.challengeId), signingSecret);
}
