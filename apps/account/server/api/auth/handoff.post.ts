/**
 * `POST /api/auth/handoff` — hoàn tất bàn giao login từ `account` về `auth`.
 *
 * ## Luồng browser qua đây
 *
 * `auth` redirect user tới `/login?handle=X` (tham số `ecoma_x` của provider),
 * `account` xác minh OTP và phát hành session — rồi **push**
 * `POST /internal/session/verified` về `auth` (§5.1.2 hàng 5). Route này là
 * đường push đó: đọc session vừa được verify, đọc handle continuation từ body,
 * ký envelope HMAC và gọi auth qua Service Binding `AUTH_SERVICE` (tên binding
 * do Workstream hạ tầng khai báo; chưa có ⇒ fail-closed, không ngụy trang).
 *
 * UI gọi route này (qua adapter, từ `/login/continue`) sau khi mã được chấp
 * nhận. Handle đi vào body từ browser **chỉ relay** — opaque, không parse.
 *
 * ## Ràng buộc handle X trước khi relay (FR-006c, §3.6 — lớp bảo vệ thứ nhất)
 *
 * Trước mọi thứ khác, route đọc `login_handoffs` và so khớp: handle X phải
 * được bind bởi **chính session đang gọi** (so khớp qua `session_ref` — con
 * trỏ nội bộ, không phải credential). Lệch ⇒ `ok: false` với reason
 * `binding_mismatch`, **không push** về auth — fail-closed. Đây là đạo nghĩa
 * của "session khác trình X": một session bất kỳ không được relay kết quả xác
 * thực cho một transaction nó không khởi tạo. (`missing` — handle chưa từng
 * bind — và `unusable` — terminal/quá TTL — cùng được chặn ở đây: handle lạ,
 * hết hạn, đã dùng đều không tới auth; không phân biệt mã lỗi để không mở
 * oracle thêm cho holder của X.)
 *
 * ⚠️ **Không thay lớp thứ hai của auth** (§3.6.3): `/internal/session/verified`
 * của auth vẫn tự từ chối transaction chưa `browser_confirmed`. Hai lớp cùng
 * tồn tại — lớp 1 của account chặn ghi đè binding và so khớp session; lớp 2
 * của auth chặn pre-binding. Chỉ có lớp này thì hở pre-binding, chỉ có lớp
 * auth thì vẫn để session bất kỳ đẩy kết quả xác thực — vì vậy cả hai cùng
 * chạy.
 *
 * ## Consume sau push thành công (FR-006d2)
 *
 * Push thành công (`ok`) ⇒ binding chuyển `consumed`: handoff đã dùng xong,
 * không có đường dùng lại (single-use, `checkHandoffBinding` từ chối mọi
 * request sau). Push **không** thành công ⇒ binding giữ nguyên — UI retry
 * được, cùng `event_id` idempotent phía auth.
 *
 * ## `event_id` bất biến cho từng lần xác minh
 *
 * Contract `session-verified` yêu cầu `event_id` — key idempotency của event.
 * Nó được dựng từ `session_ref` của session vừa verify: cùng một lần xác minh
 * luôn cho cùng event_id, nên retry của BFF KHÔNG kích hoạt lại transaction —
 * nếu lần đầu đã thành công, auth trả `already_processed` (200). `event_id`
 * thay đổi theo attempt là đường hiện tại của một bug thật: mỗi retry là một
 * event mới, transaction của auth bị đẩy đi đẩy lại.
 *
 * ## Fail-closed mà không hủy session
 *
 * Mọi nhánh lỗi (binding lệch, auth chết/unreachable/binding chưa provision)
 * trả HTTP 200 với `ok:false` + mã lý do ổn định — session vẫn sống, người
 * dùng đăng nhập thành công với account; UI cho retry (push idempotent).
 * Chọn 200 thay vì một mã lỗi HTTP thật: BFF không proxy phải phân biệt khuyến
 * khích browser hiện trang lỗi riêng — cùng một bảng results, cùng một UI
 * state retry. Sự kiện được ghi vào log với reason; không có nhánh nào biến
 * "auth chết" thành "bàn giao xong".
 */

import { createError, defineEventHandler, readValidatedBody, setResponseHeader } from 'h3';

import type { SessionVerifiedRequest } from '@ecoma-io/auth-contracts';

import { announceSessionVerified, authServiceBinding } from '../../lib/auth-client';
import { requireAuthedSession } from '../../lib/bff-session';
import {
  checkHandoffBinding,
  consumeHandoff,
  expireHandoff,
  hashHandle,
  lookupHandoff,
} from '../../lib/handoff';
import { accountHyperdrive } from '../../utils/bindings';
import { withRequestPool } from '../../utils/db';
import { writeLog } from '../../utils/logger';

/** Body hợp lệ: `handle` opaque — hình dạng tối thiểu, không parse. */
function isHandoffBody(value: unknown): { handle: string } | false {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const handle = (value as { handle?: unknown }).handle;
  // Cận trên chặn abuse; không kiểm hình dạng khác — handle là thứ opaque.
  if (typeof handle !== 'string' || handle.length === 0 || handle.length > 1_000) {
    return false;
  }
  return { handle };
}

/** Response cho browser — `ok` chỉ khi auth xác nhận continuation. */
export interface HandoffResponse {
  readonly ok: boolean;
  /** Lý do thất bại — mã ổn định cho UI hiện, không chi tiết transport. */
  readonly reason?: string;
  readonly outcome?: 'consent_required' | 'granted' | 'already_processed';
  /** URL tuyệt đối do `auth` dựng — browser relay, không tự dựng. */
  readonly continueUrl?: string;
}

export default defineEventHandler(async (event): Promise<HandoffResponse> => {
  setResponseHeader(event, 'Cache-Control', 'no-store');

  const body = await readValidatedBody(event, isHandoffBody).catch(() => null);
  if (body === null) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request' });
  }

  const authed = await requireAuthedSession(event);
  if (authed === null) {
    writeLog({ event: 'handoff.rejected', status: 401, reason: 'no_session' });
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const config = useRuntimeConfig(event);
  const signingKey = typeof config.internalHmacSecret === 'string' ? config.internalHmacSecret : '';
  if (signingKey.length === 0) {
    writeLog({
      event: 'handoff.failed',
      status: 503,
      reason: 'config_missing',
    });
    throw createError({
      statusCode: 503,
      statusMessage: 'Service Unavailable',
    });
  }
  // `kid` của khoá đang ký — rỗng nghĩa là transition chưa bật `kid`; chỉ forward
  // khi nó là chuỗi không rỗng.
  const signingKid =
    typeof config.internalHmacKid === 'string' && config.internalHmacKid.length > 0
      ? config.internalHmacKid
      : undefined;

  // ── Ràng buộc handle X ↔ session trình nó (§3.6, FR-006c) ──────────────────
  //
  // Đọc bảng TRƯỚC khi relay payload (yêu cầu của FR-006c): handle X phải khớp
  // `session_ref` của session đang verify; mọi nhánh lệch là fail-closed với
  // `binding_mismatch`, không push gì về auth. `handle_hash` là giá trị duy
  // nhất chạm DB/log — không có giá trị handle rõ nào được ghi (§3.6).
  const hyperdrive = accountHyperdrive(config);
  if (!hyperdrive) {
    writeLog({ event: 'handoff.failed', status: 503, reason: 'db_binding_missing' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  const handleHash = await hashHandle(body.handle);
  const bindingCheck = await withRequestPool(hyperdrive, async (pool) => {
    const row = await lookupHandoff(pool, handleHash);
    // Hygiene TTL: hàng quá mốc được mark `expired` trước khi so khớp — quyết
    // định fail của `checkHandoffBinding` tự so `expires_at` với mốc now, nên
    // bước này chỉ để state DB khớp sự thật máy trạng thái, không đổi hành vi.
    if (row !== null && row.expires_at.getTime() <= Date.now()) {
      await expireHandoff(pool, handleHash, Date.now());
      writeLog({ event: 'handoff.binding_expired', status: 200, handle_hash: handleHash });
    }
    return checkHandoffBinding(row, { sessionRef: authed.session.sessionRef, nowMs: Date.now() });
  }).catch(() => {
    // DB chết khi đọc binding: fail-closed tương tự config_missing — không
    // push, nhưng 503 là về hạ tầng, không phải về "bàn giao xong".
    writeLog({ event: 'handoff.failed', status: 503, reason: 'db_unreachable' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  });

  if (bindingCheck.kind !== 'matched') {
    // Mọi nhánh không khớp cùng một reason ổn định `binding_mismatch` trong
    // log + response — không phân biệt "handle lạ" / "trình khác session" /
    // "đã dùng" ra ngoài (không oracle thêm cho holder của X).
    writeLog({
      event: 'handoff.rejected',
      status: 200,
      reason: 'binding_mismatch',
      binding_kind: bindingCheck.kind,
    });
    return { ok: false, reason: 'binding_mismatch' };
  }

  // ⚠️ Invariant idempotency: **tài liệu đây, không phải ngẫu nhiên** — một lần
  // verifyOTP = một `session_ref` = một `event_id` = một lần push duy nhất vào
  // một transaction của auth. Route này KHÔNG nhận `event_id` từ body (browser
  // không được cấp quyền chọn key idempotency); nếu bỏ điều đó cho một caller
  // mới, retry sẽ mở lại transaction đã xong đúng như cảnh báo ở header. Test
  // neo: `tests/integrations/bff-routes-e2e.spec.ts` — "retry sau thành công trả
  // `already_processed` thay vì mở lại".
  const pushRequest: SessionVerifiedRequest = {
    handle: body.handle,
    sub: authed.session.sub,
    acr: authed.session.acr,
    authn_at: authed.session.authnAtMs,
    account_session_ref: authed.session.sessionRef,
    event_id: `session_verified:${authed.session.sessionRef}`,
  };

  const result = await announceSessionVerified({
    binding: authServiceBinding(config),
    signingKey,
    signingKid,
    request: pushRequest,
    nowMs: Date.now(),
  });

  if (!result.ok) {
    // Chỉ mã ổn định trong log — không giá trị handle, không chi tiết transport.
    // ⚠️ `status` ở đây là HTTP status route trả về browser (200, có `ok:false`
    // trong body), KHÔNG phải status của auth phía sau. Reason phân loại bên
    // trong (`rejected` = auth trả 4xx, `auth_unavailable` = auth trả 503,
    // `unreachable`/`binding_missing` = không tới được auth) mới là chi tiết
    // upstream; response là một bảng results thống nhất cho UI.
    writeLog({ event: 'handoff.failed', status: 200, reason: result.reason });
    return { ok: false, reason: result.reason };
  }

  // Push thành công ⇒ consume binding (FR-006d2). Consume thất bại ở đây không
  // đổi response — push đã ok, auth đã coi là xong; consume là hygiene vòng
  // đời của lớp 1. Consume được bởi chính điều kiện `session_ref` đúng ⇒
  // request song song với session khác không consume binding này được.
  try {
    await withRequestPool(hyperdrive, (pool) =>
      consumeHandoff(pool, {
        handleHash,
        sessionRef: authed.session.sessionRef,
      }),
    );
  } catch {
    // Chi tiết vòng đời — không đổi kết quả push đã thành công. Nhưng
    // im lặng hoàn toàn là mất vết: một DB hiccup tại nhánh này là nhánh duy
    // nhất dẫn tới handoff có thể được dùng lần thứ hai (binding vẫn `bound`/
    // `session_rotated` sau khi push đã ok). Log hash — không giá trị handle
    // rõ, không session_ref (§3.6, SR-001) — để nhánh hỏng này triage được.
    writeLog({ event: 'handoff.consume_failed', status: 200, handle_hash: handleHash });
  }

  writeLog({
    event: 'handoff.done',
    status: 200,
    reason: result.value.outcome,
  });
  return {
    ok: true,
    outcome: result.value.outcome,
    continueUrl: result.value.continue_url,
  };
});
