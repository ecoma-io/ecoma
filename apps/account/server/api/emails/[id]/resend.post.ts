/**
 * `POST /api/emails/:id/resend` — cấp lại mã xác minh cho một địa chỉ pending.
 *
 * ## Hợp đồng v1
 *
 * - `id` không thuộc caller / không phải hàng pending → `404` (không xác nhận
 *   tồn tại; resend của hàng verified là request vô nghĩa nhưng trả 404 cùng
 *   nhóm với "không có" — không tiết lộ trạng thái hàng cho id đoán mò).
 * - Body phải rỗng — route không nhận tham số nào.
 * - Bị rate-limit/cooldown → `200 { ok: true }` im lặng, KHÔNG có mail (cùng
 *   anti-enumeration với challenge: kẻ dò không học được gì; user thật sẽ nhận
 *   thấy không có mail và thử lại sau cooldown 60s).
 * - Thành công → `200 { ok: true }` + mail đi ra + audit
 *   `data_email_resend_sent`.
 *
 * Rate limit là của challenge `verify_email` (3/15 phút, 10/giờ, cooldown 60s
 * theo địa chỉ) — enforce trong `insertVerifyEmailChallenge`, nên mọi đường cấp
 * mã (add mới hay resend) chia cùng allowance của địa chỉ: resend spam không
 * vượt được qua bằng cách đổi id.
 */

import { createError, defineEventHandler, getRouterParam, setResponseHeader } from 'h3';

import { requireAuthedSession } from '../../../lib/bff-session';
import { appendSecurityEvent, DATA_EVENT_TYPES, findEmailById } from '../../../lib/data-domain';
import {
  sendMail,
  buildOtpMailRequest,
  otpMailCorrelationId,
  otpMailIdempotencyKey,
} from '../../../lib/mail';
import { createOtpChallenge } from '../../../lib/otp';
import {
  OTP_PURPOSE_VERIFY_EMAIL,
  VERIFY_EMAIL_RATE_HOUR_WINDOW_SECONDS,
  VERIFY_EMAIL_RATE_SHORT_WINDOW_SECONDS,
  VERIFY_EMAIL_RESEND_COOLDOWN_SECONDS,
  VERIFY_EMAIL_TTL_SECONDS,
  addressKeyFromRaw,
  insertVerifyEmailChallenge,
} from '../../../lib/email-verification';
import { accountHyperdrive } from '../../../utils/bindings';
import { writeLog } from '../../../utils/logger';
import { withRequestPool } from '../../../utils/db';

/** Hình dạng id — uuid; sai hình dạng là 400 trước khi chạm DB. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store');

  const id = getRouterParam(event, 'id');
  if (typeof id !== 'string' || !UUID_SHAPE.test(id)) {
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
    writeLog({ event: 'email_resend.failed', status: 503, reason: 'config_or_binding_missing' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  try {
    const outcome = await withRequestPool(hyperdrive, async (pool) => {
      const email = await findEmailById(pool, { userSub: authed.session.sub, id });
      if (email === null || email.status !== 'pending') {
        return 'not_found' as const;
      }

      const addressKey = await addressKeyFromRaw(email.address_normalized);
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
        // Cooldown/rate-limit: nhánh im lặng — `ok:true` không mail.
        writeLog({
          event: 'email_resend.suppressed',
          status: 200,
          sub: authed.session.sub,
          reason: 'otp_limited',
        });
        return 'suppressed' as const;
      }

      // Mail qua đường có sẵn; mail lỗi KHÔNG đổi response (cùng hợp đồng
      // challenge) — chỉ log mã lý do.
      const url = typeof config.mailServiceUrl === 'string' ? config.mailServiceUrl : undefined;
      const signingSecret =
        typeof config.mailInternalAuthSecret === 'string'
          ? config.mailInternalAuthSecret
          : undefined;
      const mailResult = await sendMail(
        url,
        buildOtpMailRequest({
          recipient: email.address_normalized,
          code: material.code,
          correlationId: otpMailCorrelationId(inserted.id),
        }),
        otpMailIdempotencyKey(inserted.id),
        signingSecret,
      );
      if (!mailResult.ok) {
        writeLog({
          event: 'email_resend.mail_failed',
          status: 200,
          sub: authed.session.sub,
          reason: mailResult.reason,
          error_code: mailResult.detail ?? 'none',
        });
        return 'suppressed' as const;
      }

      const audited = await appendSecurityEvent(pool, {
        subjectSub: authed.session.sub,
        type: DATA_EVENT_TYPES.emailResendSent,
        metadata: { field_count: 1 },
      });
      if (!audited) {
        writeLog({ event: 'email_resend.audit_failed', status: 200, sub: authed.session.sub });
      }
      writeLog({ event: 'email_resend.done', status: 200, sub: authed.session.sub });
      return 'sent' as const;
    });

    if (outcome === 'not_found') {
      throw createError({ statusCode: 404, statusMessage: 'Not Found' });
    }
    return { ok: true };
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
    ) {
      throw error;
    }
    writeLog({ event: 'email_resend.failed', status: 503, reason: 'db_unreachable' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }
});
