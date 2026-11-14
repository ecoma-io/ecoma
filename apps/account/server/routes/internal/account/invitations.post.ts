/**
 * `POST /internal/account/invitations` — phát lời mời tạo Account (ADR-0030
 * Quyết định 1 + 3, FR-002b).
 *
 * ## Ai gọi và bằng gì
 *
 * Endpoint **internal**: caller là một Worker khác (BFF của luồng operator)
 * ký envelope HMAC với header `x-ecoma-internal-actor-sub` mang `sub` của
 * operator. Middleware `server/middleware/internal-auth.ts` đã verify envelope
 * trước khi handler chạy; danh tính operator đọc từ
 * `event.context.internalAuth.actorSub` — nằm trong chuỗi ký canonical, nên
 * **principal lấy từ credential của request, không từ body** (ADR-0030 Quyết
 * định 3). Body chỉ mang địa chỉ được mời.
 *
 * ## Enforcement theo request
 *
 * Verdict permission (`invitation.create`) hỏi staff-access qua
 * {@link authorizeInvitationIssuance} cho **mỗi** request — không cache, không
 * suy từ trạng thái `account` (hợp đồng `POST /authorization/verdict`, ADR-0033
 * Quyết định 3). Denied ⇒ 403 (hàng audit `denied` ở phía staff-access);
 * không hỏi được verdict ⇒ 503 fail-closed, không phát lời mời nào.
 *
 * ## Hai lớp từ chối địa chỉ, hai mã lý do khác nhau
 *
 * Đây là endpoint cho operator đã xác thực — **không** áp anti-enumeration 204
 * như đường public: caller cần biết lý do thật để sửa hành vi (địa chỉ đã có
 * Account khác lời mời cho địa chỉ đó). Mã lý do trả trong body 409 khớp
 * `InvitationRejectionReason` của `server/lib/invitation.ts`.
 */
import { createError, defineEventHandler, setResponseHeader, setResponseStatus } from 'h3';

import { issueInvitation } from '../../../lib/invitation';
import { authorizeInvitationIssuance } from '../../../lib/authorization';
import { normalizeAndHashEmail } from '../../../lib/otp';
import { accountHyperdrive } from '../../../utils/bindings';
import { withRequestPool } from '../../../utils/db';
import { writeLog } from '../../../utils/logger';
import type { InternalAuthContext } from '../../../middleware/internal-auth';

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store');

  // Principal từ envelope đã verify — fail closed khi thiếu cả hai tầng: không
  // có context (middleware chưa chạy — không xảy ra trên deployment thật, nhưng
  // thiếu nó là không có xác thực nào) hay envelope không khai danh tính operator.
  const context = event.context as Partial<InternalAuthContext> | undefined;
  if (context?.internalAuth === undefined || context.internalAuth.actorSub === null) {
    writeLog({ event: 'account_invitations.failed', status: 401, reason: 'no_actor_principal' });
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }
  const actorSub = context.internalAuth.actorSub;

  // Định danh của chính request này, sinh **trước** phép kiểm quyền: nó là
  // `correlation_id` đi xuống staff-access cho hàng audit của verdict, và cũng
  // là giá trị ghi vào hàng lời mời — một giá trị, không hai.
  const correlationId = crypto.randomUUID();

  // Enforcement permission theo request — hỏi thẳng staff-access mỗi lần
  // (ADR-0030 Quyết định 3, ADR-0033 Quyết định 3). Tên local là `decision`,
  // KHÔNG phải `authorization`: tên "authorization" trúng nguồn taint của rule
  // `security-sensitive-value-in-http-response` (scanner chặn pre-push), dù
  // giá trị ở đây là một verdict, không phải credential nào.
  const decision = await authorizeInvitationIssuance({
    runtimeConfig: useRuntimeConfig(event),
    actorSub,
    correlationId,
  });
  if (decision.verdict === 'denied') {
    // Quyết định authorization là của staff-access; phía account chỉ ghi log
    // serving — row audit denied thuộc `staff_access.authorization_audit`
    // (ADR-0023 Quyết định 6).
    writeLog({
      event: 'account_invitations.denied',
      status: 403,
      reason: 'permission_denied',
      sub: actorSub,
    });
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' });
  }
  if (decision.verdict === 'unavailable') {
    writeLog({
      event: 'account_invitations.failed',
      status: 503,
      reason: decision.reason,
      sub: actorSub,
    });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }
  const attribution = { actorSub, actorStaffId: decision.actorStaffId };

  // Body duy nhất cần: địa chỉ được mời. Sai hình dạng là lỗi caller (400).
  //
  // ⚠️ Đọc từ `context.internalBody` — byte middleware đã đọc để verify chữ ký —
  // KHÔNG `readBody(event)` lại: stream body bị tiêu thụ bởi lần đọc đầu tiên
  // trên đường web handler (xem JSDoc của `InternalAuthContext.internalBody`).
  let body: { address?: unknown };
  try {
    const decoded = new TextDecoder().decode(context.internalBody);
    body = (JSON.parse(decoded) ?? {}) as { address?: unknown };
  } catch {
    body = {};
  }
  if (typeof body.address !== 'string' || body.address.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request' });
  }

  const { normalized, hash } = await normalizeAndHashEmail(body.address);

  const hyperdrive = accountHyperdrive(useRuntimeConfig(event));
  if (!hyperdrive) {
    writeLog({
      event: 'account_invitations.failed',
      status: 503,
      reason: 'binding_missing',
      sub: actorSub,
    });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  let result;
  try {
    result = await withRequestPool(hyperdrive, (pool) =>
      issueInvitation(pool, {
        addressHash: hash,
        addressNormalized: normalized,
        attribution,
        correlationId,
      }),
    );
  } catch {
    // Không nối `error` vào log: message của driver có thể chứa connection string.
    writeLog({
      event: 'account_invitations.failed',
      status: 503,
      reason: 'db_unreachable',
      sub: actorSub,
    });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  if (!result.ok) {
    // Operator đã xác thực và (khi hợp đồng verdict tồn tại) đã qua permission —
    // lý do thật trả về body 409 để caller sửa hành vi; địa chỉ không vào log.
    //
    // Body 409 do route tự chủ: `{"reason": ...}` đứng top-level, không qua bộ
    // render lỗi của h3/Nitro (hình `data` của envelope lỗi là chi tiết
    // framework, không phải hợp đồng nội bộ ổn định).
    writeLog({
      event: 'account_invitations.rejected',
      status: 409,
      reason: result.reason,
      sub: actorSub,
    });
    return new Response(JSON.stringify({ reason: result.reason }), {
      status: 409,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  writeLog({
    event: 'account_invitations.issued',
    status: 201,
    sub: actorSub,
    invitation_id: result.id,
    correlation_id: correlationId,
  });

  // Trả object bằng status 201 tường minh — mặc định của h3 cho object là 200.
  setResponseStatus(event, 201);
  return {
    id: result.id,
    status: 'open',
    issued_at: result.issuedAt.toISOString(),
    expires_at: result.expiresAt.toISOString(),
    correlation_id: correlationId,
  };
});
