/**
 * `POST /api/consent/decide` — proxy quyết định consent tới `auth`.
 *
 * ## Luồng
 *
 * Browser bấm Allow/Deny trên `/consent?handle=Y`. Route đọc quyết định từ
 * body (chỉ 'approve' | 'deny'), session lấy `account_session_ref`, rồi
 * `POST /internal/consent/decide` (§5.1.7 hàng 7/8). Auth: advance transaction
 * (consent_pending → decision), consume Y, decide trong MỘT transaction
 * db-auth, mint continue URL cuối. Response relay nguyên vẹn `continue_url`
 * cho browser (window relay, không tự dựng).
 *
 * ## Không nhầm `denied` với lỗi
 *
 * `outcome: 'denied'` là kết quả hợp lệ theo protocol — auth sẽ redirect về RP
 * với `error=access_denied`. Route coi 200 shape này là thành công, UI report
 * đúng; vẫn cover lỗi của route (`rejected/unreachable`...) thành reason.
 *
 * ## CSRF + session bắt buộc
 *
 * State-changing op kích hoạt consume handle — double-submit như logout.
 */

import { createError, defineEventHandler, readValidatedBody, setResponseHeader } from 'h3';

import type { ConsentDecision, ConsentDecideRequest } from '@ecoma-io/auth-contracts';

import { authServiceBinding, submitConsentDecision } from '../../lib/auth-client';
import { requireAuthedSession } from '../../lib/bff-session';
import { writeLog } from '../../utils/logger';

/** Body hợp lệ: handle opaque + quyết định giới hạn đúng hai giá trị. */
function isDecideBody(value: unknown): { handle: string; decision: ConsentDecision } | false {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const handle = (value as { handle?: unknown }).handle;
  const decision = (value as { decision?: unknown }).decision;
  if (typeof handle !== 'string' || handle.length === 0 || handle.length > 1_000) {
    return false;
  }
  if (decision !== 'approve' && decision !== 'deny') {
    return false;
  }
  return { handle, decision };
}

/** Response cho browser. */
export interface ConsentDecideBody {
  readonly ok: boolean;
  readonly reason?: string;
  readonly outcome?: 'approved' | 'denied';
  /** URL tuyệt đối do `auth` dựng — browser relay, không tự dựng. */
  readonly continueUrl?: string;
}

export default defineEventHandler(async (event): Promise<ConsentDecideBody> => {
  setResponseHeader(event, 'Cache-Control', 'no-store');

  const body = await readValidatedBody(event, isDecideBody).catch(() => null);
  if (body === null) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request' });
  }

  const authed = await requireAuthedSession(event);
  if (authed === null) {
    writeLog({ event: 'consent_decide.rejected', status: 401, reason: 'no_session' });
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const config = useRuntimeConfig(event);
  const signingKey = typeof config.internalHmacSecret === 'string' ? config.internalHmacSecret : '';
  if (signingKey.length === 0) {
    writeLog({ event: 'consent_decide.failed', status: 503, reason: 'config_missing' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }
  // `kid` của khoá đang ký — rỗng nghĩa là transition chưa bật `kid`; chỉ forward
  // khi nó là chuỗi không rỗng.
  const signingKid =
    typeof config.internalHmacKid === 'string' && config.internalHmacKid.length > 0
      ? config.internalHmacKid
      : undefined;

  const request: ConsentDecideRequest = {
    handle: body.handle,
    decision: body.decision,
    account_session_ref: authed.session.sessionRef,
  };

  const result = await submitConsentDecision({
    binding: authServiceBinding(config),
    signingKey,
    signingKid,
    request,
    nowMs: Date.now(),
  });

  if (!result.ok) {
    writeLog({ event: 'consent_decide.failed', status: 502, reason: result.reason });
    return { ok: false, reason: result.reason };
  }

  // `outcome` không nằm trong allowlist của `LogFields` — dùng `reason` làm
  // slot mã ổn định cho log: `approved`/`denied` là mã nhánh, không phải dữ liệu
  // người dùng.
  writeLog({ event: 'consent_decide.done', status: 200, reason: result.value.outcome });
  return {
    ok: true,
    outcome: result.value.outcome,
    continueUrl: result.value.continue_url as string,
  };
});
