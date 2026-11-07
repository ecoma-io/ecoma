/**
 * `POST /api/emails/:id/verify` — xác minh địa chỉ email bằng mã OTP.
 *
 * ## Hợp đồng v1 (quyết định ghi trong PR body)
 *
 * Mọi nhánh thất bại nghiệp vụ — không có challenge, sai mã, hết hạn, hết lượt
 * thử, sai địa chỉ (mã của địa chỉ khác) — trả **cùng một** `400` với body rỗng
 * nghĩa chung: không câu chữ phân biệt nguyên nhân (anti-guessing, cùng hợp
 * đồng với `verify.post.ts` của luồng login). Không có session → `401`; CSRF
 * sai → `403`; id/email không thuộc caller → `404` (không xác nhận tồn tại);
 * body sai hình dạng → `400`.
 *
 * Thành công → `200 { ok: true, email: view }`: hàng chuyển `verified`
 * (`verified_at` = now), `is_sign_in` được đặt `true` — địa chỉ vừa verify là
 * địa chỉ người dùng chủ động thêm, và là địa chỉ đăng nhập (`FR-002`: mọi
 * verified đều đăng nhập được; cột `is_sign_in` của 0005 phân biệt hiển thị
 * địa chỉ nào đang là địa chỉ đăng nhập chính).
 *
 * ## Verify là CAS trên hai hàng
 *
 * 1. `consumeVerifyChallenge` — consume OTP (single-use, nguyên tử).
 * 2. `markEmailVerified` — UPDATE có điều kiện `WHERE status = 'pending'`
 *    (nguyên tử, zero-row khi đã verified).
 *
 * Thứ tự này có khoảng hở: consume xong mà UPDATE hỏng (DB chết giữa hai câu)
 * thì mã đã đốt nhưng địa chỉ chưa verified — user phải resend. Chọn hở phía
 * đó thay vì verify được bằng một mã dùng hai lần.
 *
 * ## Mã của địa chỉ khác không verify được
 *
 * Challenge tra cứu theo `address_hash` của **địa chỉ được hỏi** (lấy từ hàng
 * email của caller) — không có đường ném mã của địa chỉ A vào verify của địa
 * chỉ B. Domain separation của purpose `verify_email` tách mã verify khỏi mã
 * login (`otpDigest(key, purpose, code)`).
 */

import {
  createError,
  defineEventHandler,
  getRouterParam,
  readValidatedBody,
  setResponseHeader,
} from 'h3';

import { requireAuthedSession } from '../../../lib/bff-session';
import {
  appendSecurityEvent,
  DATA_EVENT_TYPES,
  findEmailById,
  markEmailVerified,
  toEmailView,
} from '../../../lib/data-domain';
import {
  addressKeyFromRaw,
  consumeVerifyChallenge,
  expireVerifyChallengeIfExpired,
  findActiveVerifyChallenge,
  recordVerifyFailedAttemptAndLock,
} from '../../../lib/email-verification';
import { otpDigest, timingSafeDigestEqual } from '../../../lib/otp';
import { accountHyperdrive } from '../../../utils/bindings';
import { writeLog } from '../../../utils/logger';
import { withRequestPool } from '../../../utils/db';

/** Body hợp lệ: mã đúng 8 chữ số — cùng hình dạng với mã login. */
function isVerifyCodeBody(value: unknown): { code: string } | false {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const code = (value as { code?: unknown }).code;
  if (typeof code !== 'string' || !/^\d{8}$/u.test(code)) {
    return false;
  }
  return { code };
}

/** Hình dạng id của route — uuid; sai hình dạng là 400 trước khi chạm DB. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store');

  const id = getRouterParam(event, 'id');
  if (typeof id !== 'string' || !UUID_SHAPE.test(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request' });
  }

  const body = await readValidatedBody(event, isVerifyCodeBody).catch(() => null);
  if (body === null) {
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
    writeLog({ event: 'email_verify.failed', status: 503, reason: 'config_or_binding_missing' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  try {
    const result = await withRequestPool(hyperdrive, async (pool) => {
      // 404 cho record không thuộc caller — không xác nhận tồn tại cho người
      // khác (404-not-403).
      const email = await findEmailById(pool, { userSub: authed.session.sub, id });
      if (email === null) {
        return 'not_found' as const;
      }
      if (email.status === 'verified') {
        // Idempotent: verify lại một địa chỉ đã verified trả chính nó, không
        // đốt mã, không audit thêm.
        return { kind: 'ok' as const, view: toEmailView(email) };
      }
      if (email.status !== 'pending') {
        // `revoked`: địa chỉ đã bị gỡ — từ chối như mọi nhánh 400.
        return 'invalid' as const;
      }

      const addressKey = await addressKeyFromRaw(email.address_normalized);
      const challenge = await findActiveVerifyChallenge(pool, addressKey);
      if (challenge === null) {
        return 'invalid' as const;
      }
      const nowMs = Date.now();
      if (nowMs >= challenge.expires_at.getTime()) {
        await expireVerifyChallengeIfExpired(pool, addressKey, nowMs);
        return 'invalid' as const;
      }

      const digest = await otpDigest(otpSecret, 'verify_email', body.code);
      if (!timingSafeDigestEqual(digest, challenge.code_digest)) {
        // Sai mã: tăng attempts và khoá khi đạt trần — trong MỘT câu UPDATE
        // (cùng lập luận `recordFailedAttemptAndLock` của login).
        await recordVerifyFailedAttemptAndLock(pool, challenge.id);
        return 'invalid' as const;
      }

      // Đúng mã — consume OTP trước, verify hàng email sau (CAS).
      const consumed = await consumeVerifyChallenge(pool, challenge.id);
      if (!consumed) {
        return 'invalid' as const;
      }
      const verifiedRow = await markEmailVerified(pool, {
        userSub: authed.session.sub,
        id,
      });
      if (verifiedRow === null) {
        // Race: request song song đã verified hàng này. Hàng vẫn về trạng thái
        // đích — trả như thành công (idempotent), không lỗi.
        const existing = await findEmailById(pool, { userSub: authed.session.sub, id });
        if (existing === null || existing.status !== 'verified') {
          return 'invalid' as const;
        }
        return { kind: 'ok' as const, view: toEmailView(existing) };
      }

      const audited = await appendSecurityEvent(pool, {
        subjectSub: authed.session.sub,
        type: DATA_EVENT_TYPES.emailVerified,
        metadata: { field_count: 1 },
      });
      if (!audited) {
        writeLog({ event: 'email_verify.audit_failed', status: 200, sub: authed.session.sub });
      }
      writeLog({ event: 'email_verify.done', status: 200, sub: authed.session.sub });
      return { kind: 'ok' as const, view: toEmailView(verifiedRow) };
    });

    if (result === 'not_found') {
      throw createError({ statusCode: 404, statusMessage: 'Not Found' });
    }
    if (result === 'invalid') {
      throw createError({ statusCode: 400, statusMessage: 'Bad Request' });
    }
    return { ok: true, email: result.view };
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
    ) {
      throw error;
    }
    writeLog({ event: 'email_verify.failed', status: 503, reason: 'db_unreachable' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }
});
