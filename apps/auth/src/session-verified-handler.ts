/**
 * Handler `POST /internal/session/verified` — bước 10-11 của §5.1.2.
 *
 * `account` đã đăng nhập user và đẩy kết quả về qua back-channel đã xác thực
 * HMAC (envelope được kiểm ở `main.ts` trước khi hàm này chạy). Việc còn lại,
 * theo đúng thứ tự hợp đồng §5.1.0-§5.1.2:
 *
 * 1. Validate canonical (`validateSessionVerifiedRequest`) — payload sai cấu
 *    trúc trả 400, KHÔNG chạm database.
 * 2. MỘT câu CAS (`consumeHandleXAndBindIdentity`) tiêu thụ X + bind identity.
 *    Điều kiện `state = 'browser_confirmed'` nằm TRONG WHERE của câu UPDATE —
 *    §5.1.0 điều kiện 2 được thực thi bởi database, không bởi nhánh if, và
 *    "X bị tiêu thụ" + "danh tính được bind" là MỘT sự kiện.
 * 3. CAS thắng → điều kiện 3 (`checkStatus`, fail-closed) rồi điều kiện 4
 *    (revocation), rồi `needsConsent` chọn nhánh:
 *    - `consent_required`: derive Y, CAS sang `awaiting_consent` kèm Y, gắn
 *      `result.login` vào Interaction, `continue_url` = consent UI của account.
 *    - `granted`: provider Grant (jti = `oauth_grants.id`), CAS sang
 *      `ready_to_complete` kèm Z, gắn `{login, consent}` vào Interaction,
 *      `continue_url` = resume URL của provider (`interaction.returnTo`).
 * 4. CAS thua → bảng idempotency §5.1.5a: replay cùng event trả lại đúng
 *    outcome đã lưu; event mới trên transaction terminal là
 *    `already_processed`; `event_id` tái sử dụng với payload khác là
 *    `invalid_request`; handle đã consume bởi event khác là `invalid_grant`.
 *
 * ⚠️ **Payload hash tự tính SHA-256 base64url trên raw bytes.** `hashBody` của
 * lib contracts trả HEX (dùng cho envelope HMAC) — cột `event_payload_hash`
 * đi qua `base64UrlToBytea` tức là base64url. Hai codec, hai mục đích; trộn
 * chúng là một so khớp sai âm thầm.
 */

import type { AccountStatusResponseValue } from '@ecoma-io/account-contracts';
import {
  type SessionVerifiedResponse,
  validateSessionVerifiedRequest,
} from '@ecoma-io/auth-contracts';
import { allowsIssuance, bytesToBase64Url, hashHandle, needsConsent } from '@ecoma-io/auth-domain';
import {
  advanceTransactionWithHandle,
  checkRevocationAtIssuance,
  consumeHandleXAndBindIdentity,
  findActiveGrant,
  findTransactionByHandleX,
  insertAuditEvent,
  type PostgresClientLike,
} from '@ecoma-io/auth-infrastructure';
import type { Provider } from 'oidc-provider';
import type { AuthorizationTransactionRecord, AuthStore } from '@ecoma-io/auth-application';
import {
  attachInteractionResult,
  buildLoginResult,
  createProviderGrant,
  deriveContinuationHandles,
  handleHash,
  saveProviderGrant,
} from './oidc/interaction';

/**
 * Ghi một hàng audit theo cơ chế "thông báo trong background" (fire-and-forget)
 * và không chặn quá trình phản hồi (SR-010): lỗi audit KHÔNG được đổi kết quả
 * nghiệp vụ, nhưng cũng KHÔNG được nuốt im lặng hoàn toàn — in ra `console.error`
 * để surface chiếm được. (AGENTS.md: observability không là dependency của serving
 * path. Ném lỗi ở đây biến hỏng audit thành 5xx cho người dùng — sai chiều.)
 *
 * ⚠️ Chỉ nhận giá trị allowlist: caller không truyền bất cứ thứ gì suy ra từ
 * payload thô ngoài các định danh (`sub`, `client_id`, transaction id).
 */
async function audit(
  postgresClient: PostgresClientLike,
  event: Parameters<typeof insertAuditEvent>[1],
): Promise<void> {
  try {
    await insertAuditEvent(postgresClient, event);
  } catch (error: unknown) {
    // oxlint-disable-next-line no-console
    console.error('audit write failed', error);
  }
}

/**
 * Cửa sổ "authentication mới" — dùng cho `assessRiskLevel` ở `/consent/context`,
 * không dùng ở handler này. Hằng sống ở đây vì consent/context import từ file
 * này để hai đường dùng MỘT cửa sổ.
 */
export const FRESH_AUTHN_WINDOW_MS = 5 * 60 * 1000;

/**
 * TTL (giây) khi save provider Grant — khớp `TTL.Grant` của `oidc/provider.ts`.
 * Cùng giá trị bằng hằng lặp lại được canh bởi spec; import chéo
 * store→provider là phụ thuộc không cần thiết.
 */
export const GRANT_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * SHA-256 base64url trên raw bytes — bản base64url của `hashBody` (bản HEX).
 */
export async function payloadHashOf(body: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(body));
  return bytesToBase64Url(new Uint8Array(digest));
}

/** Parse JSON an toàn: trả `undefined` thay vì ném cho body không phải JSON. */
function safeParseJson(raw: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(raw)) as unknown;
  } catch {
    return undefined;
  }
}

/** Kết quả của một lần chạy handler — trả thẳng cho route của main.ts. */
export type SessionVerifiedResult =
  | { readonly status: 200; readonly body: SessionVerifiedResponse }
  | {
      readonly status: 400 | 404 | 422;
      readonly body: { error: string; error_description?: string };
    };

/** Ngữ cảnh dùng chung của cả hai nhánh — một object, không tham số rải. */
interface RunContext {
  readonly provider: Provider;
  readonly postgresClient: PostgresClientLike;
  readonly store: AuthStore;
  readonly handleKey: string;
  readonly accountBaseUrl: string;
  readonly now: Date;
  /**
   * Control point fail-closed (điều kiện 3) — bọc để unit test stub được mà
   * không dựng AccountClient thật.
   */
  readonly checkStatus: (accountId: string) => Promise<AccountStatusResponseValue>;
}

/** Ngữ cảnh + handle X bản rõ, có sau bước validate (lấy từ request). */
interface RunContextWithHandle extends RunContext {
  /**
   * Handle X BẢN RỰ từ request đã validate — duy nhất nơi giữ bản rõ này:
   * hàng `authorization_transactions` chỉ lưu HASH (FR-016p), nên replay không
   * tái dựng được từ DB. Mọi tra Interaction theo correlator đi qua đây.
   */
  readonly handleX: string;
}

/**
 * Chạy toàn bộ nghiệp vụ `session/verified` sau khi envelope đã verify.
 *
 * Mọi kết quả từ chối được quy về `{status, body}` — KHÔNG ném ra ngoài cho
 * lỗi protocol; lỗi hạ tầng (DB chết, Account không trả lời) VẪN NÉM để
 * main.ts phân loại 503. `error_description` không bao giờ chứa giá trị từ
 * payload (handle, sub, ref) — invariant 9.
 */
export async function runSessionVerified(
  params: RunContext & {
    /** Raw body ĐÃ verify envelope — bytes này cũng là nguồn của payload hash. */
    readonly rawBody: Uint8Array;
  },
): Promise<SessionVerifiedResult> {
  const ctx = params;

  // Bước 1 — validate canonical. 400 với `reason` làm mã lỗi.
  const validation = validateSessionVerifiedRequest(safeParseJson(params.rawBody));
  if (!validation.ok) {
    return {
      status: 400,
      body: { error: validation.reason, error_description: validation.detail },
    };
  }
  const request = validation.request;

  // Bước 2 — MỘT câu CAS: tiêu thụ X + bind identity.
  const ctxWithHandle: RunContextWithHandle = { ...ctx, handleX: request.handle };
  const handleXHash = await handleHash(request.handle);
  const payloadHash = await payloadHashOf(params.rawBody);
  const cas = await consumeHandleXAndBindIdentity(ctx.postgresClient, {
    handleXHash,
    sub: request.sub,
    acr: request.acr,
    authnAt: new Date(request.authn_at),
    accountSessionRef: request.account_session_ref,
    eventId: request.event_id,
    payloadHash,
    outcome: 'success',
    now: ctx.now,
  });

  if (!cas.won) {
    return await replayOutcome(ctxWithHandle, {
      handleXHash,
      eventId: request.event_id,
      payloadHash,
    });
  }

  const bound = cas.transaction;
  if (bound === undefined) {
    // Bất khả thi theo schema — RETURNING luôn có hàng khi UPDATE khớp WHERE.
    return { status: 422, body: { error: 'server_error' } };
  }

  // Điều kiện 3 — fail-closed. `checkStatus` NÉM khi không gọi được Account;
  // ném ra ngoài là CHỦ Ý (main.ts phân loại hạ tầng), không có try/catch
  // biến lỗi thành "coi như khoẻ".
  const status = await ctxWithHandle.checkStatus(request.sub);
  if (!allowsIssuance(status)) {
    await audit(ctxWithHandle.postgresClient, {
      eventType: 'session_verified',
      subjectRef: request.sub,
      clientId: bound.client_id,
      authorizationTransactionId: bound.transaction_id,
      outcome: 'denied',
      errorCode: 'access_denied',
      details: { reason: 'account_status' },
    });
    return {
      status: 422,
      body: {
        error: 'access_denied',
        error_description: 'account status khong cho phep phat hanh',
      },
    };
  }

  // Bước 6 — consent là điều kiện: grant phải phủ TRỌN scope được yêu cầu
  // (yêu cầu ít hơn grant hiện có VẪN cần hỏi — `needsConsent`). Đọc grant
  // TRƯỚC revocation để điều kiện 4a kiểm cả mức `token` (theo grant).
  const grant = await findActiveGrant(ctxWithHandle.postgresClient, {
    sub: request.sub,
    clientId: bound.client_id,
  });

  // Điều kiện 4a — revocation (mọi hàng khớp = revoked, bảo thủ). Cả ba mức:
  // subject, client, và token (grant_id — SR-014a family: thu hồi một grant bị
  // lộ phải chặn luôn luồng authorize mới tái sử dụng grant đó).
  const revocation = await checkRevocationAtIssuance(ctxWithHandle.postgresClient, {
    sub: request.sub,
    clientId: bound.client_id,
    grantId: grant?.id,
  });
  if (revocation !== 'not_revoked') {
    await audit(ctxWithHandle.postgresClient, {
      eventType: 'session_verified',
      subjectRef: request.sub,
      clientId: bound.client_id,
      authorizationTransactionId: bound.transaction_id,
      grantId: grant?.id,
      outcome: 'denied',
      errorCode: 'access_denied',
      details: { reason: 'revoked' },
    });
    return {
      status: 422,
      body: { error: 'access_denied', error_description: 'grant da bi thu hoi' },
    };
  }

  if (needsConsent({ existingGrant: grant, requestedScope: bound.requested_scopes })) {
    return await consentRequiredPath(ctxWithHandle, bound);
  }
  return await grantedPath(ctxWithHandle, bound, grant);
}

/* ------------------------------------------------------------------ */
/* Nhánh CAS thua — bảng idempotency §5.1.5a                           */
/* ------------------------------------------------------------------ */

interface ReplayInputs {
  readonly handleXHash: string;
  readonly eventId: string;
  readonly payloadHash: string;
}

async function replayOutcome(
  ctx: RunContextWithHandle,
  inputs: ReplayInputs,
): Promise<SessionVerifiedResult> {
  // MỘT lần đọc lại sau CAS thua: mọi nhánh dưới phán từ bản này.
  const transaction = await findTransactionByHandleX(ctx.postgresClient, {
    handleXHash: inputs.handleXHash,
  });
  if (transaction === undefined) {
    // Handle không tồn tại / đã prune: §5.1.6 hàng "Transaction / handle hết TTL".
    return {
      status: 404,
      body: { error: 'invalid_grant', error_description: 'handle khong ton tai' },
    };
  }

  const sameEvent = transaction.event_id === inputs.eventId;
  if (sameEvent && transaction.event_payload_hash !== inputs.payloadHash) {
    // §5.1.5a dòng 3: cùng event_id, payload khác — không ghi đè kết quả.
    return {
      status: 422,
      body: {
        error: 'invalid_request',
        error_description: 'event_id da duoc dung voi payload khac',
      },
    };
  }
  if (sameEvent) {
    // §5.1.5a dòng 2: cùng event_id + cùng payload → trả lại ĐÚNG outcome đã
    // lưu, cùng continuation, không sinh Y/Z thứ hai (hàng 5 của state machine).
    return await replayedOutcome(ctx, transaction);
  }

  // `event_id` mới — trạng thái hiện tại quyết định (§5.1.5a dòng 4-6).
  if (transaction.state === 'completed' || transaction.state === 'denied') {
    // Hàng 13: terminal → `already_processed`, KHÔNG có continue_url.
    return {
      status: 200,
      body: { outcome: 'already_processed', transaction_state: transaction.state },
    };
  }
  if (
    transaction.state === 'ready_to_complete' ||
    transaction.state === 'awaiting_consent' ||
    transaction.state === 'browser_confirmed'
  ) {
    // X đã consume bởi event khác — `invalid_grant` + audit theo §5.1.5a dòng 4.
    // ⚠️ `browser_confirmed` nằm ở đây vì X đã bị event kia tiêu thụ rồi; thông
    // điệp "chưa được browser xác nhận" ở nhánh dưới chỉ đúng cho
    // `pending_browser` (hàng chưa từng bind, `event_id` còn NULL).
    return {
      status: 422,
      body: {
        error: 'invalid_grant',
        error_description: 'handle da duoc tieu thu boi event khac',
      },
    };
  }
  // `pending_browser` — §5.1.0 điều kiện 2: `invalid_request`, xử lý trước mọi
  // trường khác (CAS đã chặn, nhánh này chỉ dịch trạng thái thành mã lỗi đúng).
  return {
    status: 422,
    body: {
      error: 'invalid_request',
      error_description: 'transaction chua duoc browser xac nhan',
    },
  };
}

/**
 * Trả lại outcome của một event ĐÃ xử lý (replay §5.1.5a dòng 2): cùng Y cho
 * `awaiting_consent`, cùng Z-continuation cho `ready_to_complete`,
 * `already_processed` cho terminal.
 *
 * ⚠️ Y/Z là derive-on-demand từ HMAC (§5.6) — replay tính lại được cùng giá trị
 * mà không cần tra cột hash. Cột chỉ là CAS target của lần đầu.
 */
async function replayedOutcome(
  ctx: RunContextWithHandle,
  transaction: AuthorizationTransactionRecord,
): Promise<SessionVerifiedResult> {
  if (transaction.state === 'completed' || transaction.state === 'denied') {
    return {
      status: 200,
      body: { outcome: 'already_processed', transaction_state: transaction.state },
    };
  }

  const handles = await deriveContinuationHandles({
    handleKey: ctx.handleKey,
    transactionId: transaction.transaction_id,
  });

  if (transaction.state === 'awaiting_consent') {
    const continueUrl = new URL('/consent', ctx.accountBaseUrl);
    continueUrl.searchParams.set('handle', handles.handleY);
    return {
      status: 200,
      body: { outcome: 'consent_required', continue_url: continueUrl.href },
    };
  }

  if (transaction.state === 'pending_browser' || transaction.state === 'browser_confirmed') {
    // ⚠️ `browser_confirmed` + cùng event_id nghĩa là event này đã CAS thắng
    // consume X nhưng KHÔNG advance (checkStatus từ chối — fail-closed — hoặc
    // một lỗi hạ tầng giữa hai bước). Replay phải trả CÙNG kết quả từ chối,
    // KHÔNG BAO GIỜ rơi xuống nhánh `ready_to_complete` dưới đây — rơi xuống
    // là biến một từ chối `access_denied` đã ghi thành `granted` trong im
    // lặng. Không có outcome nào an toàn để tái lập ở hai trạng thái này:
    // buộc account dùng event_id MỚI, request sau sẽ thấy trạng thái hiện tại
    // và đi đúng nhánh.
    return {
      status: 422,
      body: {
        error: 'invalid_request',
        error_description: 'event da xu ly ma khong co continuation',
      },
    };
  }

  // `ready_to_complete` — replay của một event granted/consent-approved.
  // Hai thế hệ continuation phân biệt nhau bằng việc Interaction còn sống:
  //   - CÒN SỐNG: account mất response TRƯỚC khi browser resume — trả lại ĐÚNG
  //     outcome đã lưu (`granted`) + CÙNG resume URL (§5.1.5a dòng 2). Resume
  //     có thể NẠP lại không kèm result (tránh xoá result đã gắn ở event gốc).
  //   - ĐÃ CHẾT: resume.js:73 destroy Interaction ngay khi browser nhận code —
  //     luồng ĐÃ hoàn tất. `invalid_grant` ở đây là ngược §5.1.6 ("retry không
  //     dẫn tới trạng thái không thể tiếp tục") và là thành `granted` giả:
  //     browser đã có code, không có continuation nào hợp lệ nữa. Câu trả lời
  //     trung thực là `already_processed` — cùng chữ với hàng "transaction đã
  //     xong" của bảng (a), vì về bản chất flow đã xong bằng provider resume
  //     (deviation: resume là completion của nhánh granted).
  const grant = await findActiveGrant(ctx.postgresClient, {
    sub: transaction.sub ?? '',
    clientId: transaction.client_id,
  });
  if (grant === undefined) {
    return {
      status: 422,
      body: { error: 'access_denied', error_description: 'grant mat hieu luc' },
    };
  }
  const attached = await attachInteractionResult({
    provider: ctx.provider,
    postgresClient: ctx.postgresClient,
    // Replay KHÔNG gắn result lần hai — result của event gốc vẫn nguyên.
    handleX: ctx.handleX,
  });
  if (attached === undefined) {
    return {
      status: 200,
      body: {
        outcome: 'already_processed',
        transaction_state: transaction.state,
      },
    };
  }
  return {
    status: 200,
    body: { outcome: 'granted', continue_url: attached.continueUrl },
  };
}

/* ------------------------------------------------------------------ */
/* Nhánh consent_required                                              */
/* ------------------------------------------------------------------ */

async function consentRequiredPath(
  ctx: RunContextWithHandle,
  bound: AuthorizationTransactionRecord,
): Promise<SessionVerifiedResult> {
  const handles = await deriveContinuationHandles({
    handleKey: ctx.handleKey,
    transactionId: bound.transaction_id,
  });
  const handleYHash = await hashHandle(handles.handleY);

  // CAS `browser_confirmed → awaiting_consent` KÈ hash Y — một câu (schema
  // CHECK buộc `awaiting_consent` phải có Y chưa consume).
  const moved = await advanceTransactionWithHandle(ctx.postgresClient, {
    transactionId: bound.transaction_id,
    from: 'browser_confirmed',
    to: 'awaiting_consent',
    handleHash: handleYHash,
    eventId: bound.event_id ?? '',
    payloadHash: bound.event_payload_hash ?? '',
    outcome: 'success',
    now: ctx.now,
  });
  if (!moved) {
    return {
      status: 422,
      body: {
        error: 'invalid_grant',
        error_description: 'transaction da doi trang thai',
      },
    };
  }

  // Gắn result.login vào Interaction: prompt login sẽ tắt khi browser resume,
  // prompt consent vẫn fire (policy check `result.consent === undefined`) và
  // policy mới redirect browser về `interactions.url` — nhưng đường ECOMA
  // KHÔNG qua đó: account điều hướng browser bằng `continue_url` dưới đây và
  // quyết định consent đi qua `/internal/consent/decide`. Result này vẫn cần
  // cho resume SAU decide (resume.js đọc result.login để loginAccount).
  await attachInteractionResult({
    provider: ctx.provider,
    postgresClient: ctx.postgresClient,
    // Correlator là handle X BẢN RỰ của request (RunContext) — hàng DB chỉ có
    // hash (FR-016p), và CAS vừa thắng nghĩa là request này chính là chủ của
    // handle, nên bản rõ trong ctx khớp hàng vừa bind.
    handleX: ctx.handleX,
    result: buildLoginResult({
      sub: bound.sub ?? '',
      acr: bound.acr ?? '',
      authnAtMs: bound.authn_at === null ? ctx.now.getTime() : bound.authn_at.getTime(),
    }),
  });

  // ⚠️ `continue_url` của nhánh này là consent UI của ACCOUNT (§5.1.1) — KHÔNG
  // phải `interaction.returnTo` (resume của provider). Account hiển thị UI
  // rồi gọi `/internal/consent/decide` khi user quyết định.
  const continueUrl = new URL('/consent', ctx.accountBaseUrl);
  continueUrl.searchParams.set('handle', handles.handleY);
  await audit(ctx.postgresClient, {
    eventType: 'session_verified',
    subjectRef: bound.sub ?? undefined,
    clientId: bound.client_id,
    authorizationTransactionId: bound.transaction_id,
    outcome: 'success',
    details: { path: 'consent_required' },
  });
  return {
    status: 200,
    body: { outcome: 'consent_required', continue_url: continueUrl.href },
  };
}

/* ------------------------------------------------------------------ */
/* Nhánh granted                                                       */
/* ------------------------------------------------------------------ */

async function grantedPath(
  ctx: RunContextWithHandle,
  bound: AuthorizationTransactionRecord,
  grant: Awaited<ReturnType<typeof findActiveGrant>>,
): Promise<SessionVerifiedResult> {
  const handles = await deriveContinuationHandles({
    handleKey: ctx.handleKey,
    transactionId: bound.transaction_id,
  });
  const handleZHash = await hashHandle(handles.handleZ);

  // CAS `browser_confirmed → ready_to_complete` KÈ hash Z — schema CHECK buộc
  // `ready_to_complete` phải có Z chưa consume.
  const moved = await advanceTransactionWithHandle(ctx.postgresClient, {
    transactionId: bound.transaction_id,
    from: 'browser_confirmed',
    to: 'ready_to_complete',
    handleHash: handleZHash,
    eventId: bound.event_id ?? '',
    payloadHash: bound.event_payload_hash ?? '',
    outcome: 'success',
    now: ctx.now,
  });
  if (!moved) {
    return {
      status: 422,
      body: {
        error: 'invalid_grant',
        error_description: 'transaction da doi trang thai',
      },
    };
  }

  // `needsConsent` đã xác nhận grant phủ scope — không thể undefined trừ khi
  // race xoá grant giữa hai câu; fail-closed.
  if (grant === undefined) {
    return {
      status: 422,
      body: { error: 'access_denied', error_description: 'grant mat hieu luc' },
    };
  }

  // Provider Grant với jti = `oauth_grants.id` — hai vế thu hồi cùng một định
  // danh (xem `oidc/interaction.ts`).
  const providerGrant = createProviderGrant({
    provider: ctx.provider,
    accountId: bound.sub ?? '',
    clientId: bound.client_id,
    scopes: bound.requested_scopes,
    grantId: grant.id,
    ttlSeconds: GRANT_TTL_SECONDS,
  });
  await saveProviderGrant(providerGrant, GRANT_TTL_SECONDS);

  // Gắn {login, consent:{grantId}} — cả hai prompt tắt khi browser resume,
  // respond() cấp code và 302 browser về `redirect_uri` của client.
  const attached = await attachInteractionResult({
    provider: ctx.provider,
    postgresClient: ctx.postgresClient,
    // Correlator là handle X BẢN RỰ của request (RunContext) — hàng DB chỉ có
    // hash (FR-016p).
    handleX: ctx.handleX,
    result: {
      ...buildLoginResult({
        sub: bound.sub ?? '',
        acr: bound.acr ?? '',
        authnAtMs: bound.authn_at === null ? ctx.now.getTime() : bound.authn_at.getTime(),
      }),
      consent: { grantId: grant.id },
    },
  });

  // ⚠️ Deviation so §5.1.1 (disclosure trong report): `continue_url` của nhánh
  // granted là resume URL của PROVIDER (`interaction.returnTo`), không phải
  // `/authorize/complete?handle=Z` của docs. Provider là BỘ MÁY CẤP CODE duy
  // nhất — code cấp tại resume, `/token` chỉ nhận code của provider. Z vẫn
  // được ghi (CAS ở trên) làm bằng chứng idempotency §5.1.5a.
  if (attached === undefined) {
    // Không có Interaction: browser sẽ 302 tới URL không có cookie
    // `_interaction` → SessionNotFound. Interaction được tạo ở `/auth` trước
    // khi push, nên nhánh này là lỗi glue — fail-closed.
    return {
      status: 422,
      body: {
        error: 'server_error',
        error_description: 'interaction tuong ung khong tim thay',
      },
    };
  }
  await audit(ctx.postgresClient, {
    eventType: 'session_verified',
    subjectRef: bound.sub ?? undefined,
    clientId: bound.client_id,
    authorizationTransactionId: bound.transaction_id,
    grantId: grant.id,
    outcome: 'success',
    details: { path: 'granted' },
  });
  return {
    status: 200,
    body: { outcome: 'granted', continue_url: attached.continueUrl },
  };
}
