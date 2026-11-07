/**
 * `POST /api/emails` — thêm địa chỉ email mới cho chính caller (pending) và
 * gửi mã xác minh qua đường mail có sẵn.
 *
 * ## Hợp đồng v1 và anti-enumeration (quyết định ghi trong PR body)
 *
 * Mọi body sai hình dạng → `400`. Mọi nhánh nghiệp vụ còn lại — thành công,
 * trần pending, rate-limit, cooldown, mail lỗi — đều trả **cùng một** `200`:
 *
 *   `{ ok: true, email: { id, address, status: 'pending', ... } }`
 *
 * Lý do là **authenticated anti-enumeration**, phiên bản nhẹ hơn của route
 * challenge (204 mọi nhánh): caller đã đăng nhập, nên giá trị dò của response
 * khác nhau thấp — nhưng contract vẫn không tiết lộ "địa chỉ này đã thuộc
 * account khác" qua body hay status. Nhánh email đã tồn tại được giữ hoàn toàn
 * im lặng: không có hàng mới, không có mail đi ra, response như thành công.
 * User thật tự hiểu qua việc không nhận mail (UX đã chấp nhận ở luồng login).
 *
 * ## Nhánh địa chỉ đã tồn tại
 *
 * - **Thuộc chính caller**: idempotent — trả hàng hiện có, KHÔNG tạo hàng
 *   thứ hai, KHÔNG gửi lại mail tự động (resend là route riêng, có cooldown
 *   riêng). Response vẫn `200 ok:true`.
 * - **Thuộc account khác và `verified`**: ràng buộc UNIQUE partial của 0005
 *   chặn verify sau này, nhưng route **không** dùng nhánh này để phân biệt —
 *   hàng pending vẫn KHÔNG được tạo (một hàng pending trỏ vào địa chỉ của
 *   người khác là dữ liệu rác + vector confuse khi hai account cùng thấy địa
 *   chỉ trong danh sách của mình). Response như thành công, không mail.
 * - **Thuộc account khác, `pending`/`revoked`**: hàng của account khác, không
 *   đụng; hàng pending của caller KHÔNG được tạo (cùng lý do confuse — địa chỉ
 *   chỉ được một account verify được, tạo pending là hứa giả). Response như
 *   thành công, không mail.
 *
 * ## Rate limit
 *
 * Hai lớp, cả hai từ durable state:
 * 1. Trần 5 hàng `pending`/giờ **theo `sub`** (`countRecentPendingEmails`) —
 *    chặn rác DB của một session đã đăng nhập.
 * 2. Rate limit OTP của `otp_challenges` purpose `verify_email` (3/15 phút +
 *    10/giờ + cooldown 60s, theo địa chỉ) — enforce trong
 *    `insertVerifyEmailChallenge`; bị chặn vẫn tạo hàng pending KHÔNG xảy ra:
 *    hàng chỉ ghi sau khi challenge được cấp (thứ tự ngược lại sẽ để lại hàng
 *    pending không có đường verify trong cửa sổ limit).
 *
 * ## Mail
 *
 * Gửi qua `sendMail` có sẵn của `server/lib/mail.ts` — cùng envelope HMAC,
 * cùng template `account.login-otp` (biến `code`; template duy nhất được
 * approve cho `svc.account` ở receiver). `Idempotency-Key` derive từ
 * `challengeId` như luồng login: retry cùng challenge không nhân đôi mail.
 * Mail lỗi không đổi response — chỉ log mã lý do (cùng hợp đồng với challenge).
 */

import { createError, defineEventHandler, readValidatedBody, setResponseHeader } from 'h3';

import { requireAuthedSession } from '../../lib/bff-session';
import {
  appendSecurityEvent,
  DATA_EVENT_TYPES,
  countRecentPendingEmails,
  findOwnedEmailByHash,
  findVerifiedEmailOwner,
  insertEmailPending,
  normalizeEmail,
  PENDING_EMAIL_MAX_PER_WINDOW,
  PENDING_EMAIL_WINDOW_SECONDS,
  toEmailView,
} from '../../lib/data-domain';
import {
  sendMail,
  buildOtpMailRequest,
  otpMailCorrelationId,
  otpMailIdempotencyKey,
} from '../../lib/mail';
import { createOtpChallenge } from '../../lib/otp';
import {
  OTP_PURPOSE_VERIFY_EMAIL,
  VERIFY_EMAIL_RATE_HOUR_WINDOW_SECONDS,
  VERIFY_EMAIL_RATE_SHORT_WINDOW_SECONDS,
  VERIFY_EMAIL_RESEND_COOLDOWN_SECONDS,
  VERIFY_EMAIL_TTL_SECONDS,
  addressKeyFromRaw,
  insertVerifyEmailChallenge,
} from '../../lib/email-verification';
import { accountHyperdrive } from '../../utils/bindings';
import { writeLog } from '../../utils/logger';
import { withRequestPool } from '../../utils/db';

function isEmailBody(value: unknown): { email: string } | false {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const email = (value as { email?: unknown }).email;
  if (typeof email !== 'string') {
    return false;
  }
  return { email };
}

/**
 * Gửi mã verify-mail với URL + credential từ config — cùng hình thức
 * `sendConfigured` của `challenge.post.ts`, tách hàm để test mock được
 * `sendMail` mà không dựng runtime config.
 */
function sendVerifyCode(
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

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store');

  const body = await readValidatedBody(event, isEmailBody).catch(() => null);
  if (body === null) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request' });
  }
  if (!/^[^\s@]{1,64}@[^\s@]{1,255}$/u.test(body.email) || !body.email.includes('@')) {
    // Hình dạng tối thiểu giống challenge: sai hình dạng là 400, KHÔNG đi vào
    // nhánh im lặng — người gọi tự sửa được, không phải oracle.
    throw createError({ statusCode: 400, statusMessage: 'Bad Request' });
  }

  const authed = await requireAuthedSession(event);
  if (authed === null) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const config = useRuntimeConfig(event);
  const otpSecret = config.otpHmacSecret;
  const hyperdrive = accountHyperdrive(config);
  if (typeof otpSecret !== 'string' || otpSecret.length === 0 || !hyperdrive) {
    writeLog({ event: 'email_add.failed', status: 503, reason: 'config_or_binding_missing' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  const normalized = normalizeEmail(body.email);
  const addressKey = await addressKeyFromRaw(body.email);

  try {
    const outcome = await withRequestPool(hyperdrive, async (pool) => {
      // Trần pending theo sub — lớp 1. Nhánh bị chặn là nhánh im lặng: response
      // như thành công, chỉ log. (Sai khác challenge: caller đã đăng nhập nên
      // 4xx ở đây không phải oracle dò địa chỉ, nhưng im lặng giữ cho một loại
      // abuse không được phân biệt khỏi thành công qua status.)
      const pendingCount = await countRecentPendingEmails(
        pool,
        authed.session.sub,
        PENDING_EMAIL_WINDOW_SECONDS,
      );
      if (pendingCount >= PENDING_EMAIL_MAX_PER_WINDOW) {
        writeLog({
          event: 'email_add.suppressed',
          status: 200,
          sub: authed.session.sub,
          reason: 'pending_ceiling',
        });
        return null;
      }

      // Hàng hiện có của chính caller với địa chỉ này? Idempotent — không tạo
      // hàng mới, không mail, trả hàng cũ.
      const owned = await findOwnedEmailByHash(pool, {
        addressHash: addressKey,
        userSub: authed.session.sub,
      });
      if (owned !== null && owned.status !== 'revoked') {
        return toEmailView(owned);
      }

      // Địa chỉ đã verified bởi sub bất kỳ (kể cả chính caller qua hàng khác)?
      // Không tạo hàng pending — ràng buộc ownership của verified (0005) khiến
      // hàng này không bao giờ verify được; tạo là hứa giả.
      const verifiedOwner = await findVerifiedEmailOwner(pool, addressKey);
      if (verifiedOwner !== null) {
        return null;
      }

      // Cấp mã TRƯỚC khi ghi hàng: bị rate-limit/cooldown thì KHÔNG có hàng
      // pending mồ côi (thứ tự ngược lại để lại hàng không có đường verify).
      const material = await createOtpChallenge(otpSecret, OTP_PURPOSE_VERIFY_EMAIL);
      const inserted = await insertVerifyEmailChallenge(pool, {
        addressKey,
        digest: material.digest,
        expiresAt: new Date(Date.now() + VERIFY_EMAIL_TTL_SECONDS * 1000),
        resendCooldownSeconds: VERIFY_EMAIL_RESEND_COOLDOWN_SECONDS,
        rateShortWindowSeconds: VERIFY_EMAIL_RATE_SHORT_WINDOW_SECONDS,
        rateHourWindowSeconds: VERIFY_EMAIL_RATE_HOUR_WINDOW_SECONDS,
      });
      if (inserted === undefined) {
        // Bị chặn trong transaction (cooldown/rate limit): không hàng, không
        // mail, response im lặng như mọi nhánh bị chặn.
        writeLog({
          event: 'email_add.suppressed',
          status: 200,
          sub: authed.session.sub,
          reason: 'otp_limited',
        });
        return null;
      }

      const row = await insertEmailPending(pool, {
        userSub: authed.session.sub,
        addressNormalized: normalized,
        addressHash: addressKey,
      });
      const view = toEmailView(row);

      // Mail chỉ đi ra sau khi cả challenge lẫn hàng pending đã ghi. Mail lỗi
      // KHÔNG đổi response (cùng hợp đồng challenge) — user dùng resend.
      const mailResult = await sendVerifyCode(config, {
        recipient: body.email,
        code: material.code,
        challengeId: inserted.id,
      });
      if (!mailResult.ok) {
        writeLog({
          event: 'email_add.mail_failed',
          status: 200,
          sub: authed.session.sub,
          reason: mailResult.reason,
          error_code: mailResult.detail ?? 'none',
        });
      } else {
        // Audit sau khi hàng + mail đã xong; audit lỗi không đổi response.
        const audited = await appendSecurityEvent(pool, {
          subjectSub: authed.session.sub,
          type: DATA_EVENT_TYPES.emailAdded,
          metadata: { field_count: 1 },
        });
        if (!audited) {
          writeLog({ event: 'email_add.audit_failed', status: 200, sub: authed.session.sub });
        }
        writeLog({ event: 'email_add.done', status: 200, sub: authed.session.sub });
      }
      return view;
    });

    // Nhánh `null` (bị chặn) và nhánh có hàng dùng chung response `ok:true`
    // — anti-enumeration của route này.
    return { ok: true, email: outcome ?? null };
  } catch {
    writeLog({ event: 'email_add.failed', status: 503, reason: 'db_unreachable' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }
});
