/**
 * Hai handler back-channel consent — bước 12-13 của §5.1.2:
 * `POST /internal/consent/context` và `POST /internal/consent/decide`.
 *
 * ## `context` — đọc-only
 *
 * Trả `{client_name, scope, risk_level}` cho consent UI của account. Không có
 * side effect: transaction giữ nguyên (hàng 6 của state machine). Risk level
 * là TRÌNH BÀY, không phải control bảo mật.
 *
 * ## `decide` — MỘT sự kiện db-auth (§5.1.5b)
 *
 * Bên trong CÙNG `client.begin`:
 *   1. `advanceTransactionWithHandle` CAS `awaiting_consent →
 *      ready_to_complete|denied` kèm hash Z. Advance phải đi TRƯỚC: CHECK
 *      `authorization_transactions_handle_y_state_check` (0002) buộc hàng ở
 *      `awaiting_consent` phải có `handle_y_consumed_at IS NULL`, nên
 *      `consumeHandleY` chạy khi state còn `awaiting_consent` là vi phạm CHECK
 *      ngay — advance đưa hàng ra khỏi trạng thái đó trước.
 *   2. `consumeHandleY` CAS. Thua ⇒ throw ⇒ rollback toàn bộ tx (kể cả
 *      advance đã thành công) — không có trạng thái "Z đã đặt mà Y chưa
 *      consume".
 *   3. `insertConsentDecision` (+ `insertGrant` + `insertGrantScopes` khi
 *      approve).
 * Bất kỳ bước nào ném ⇒ không còn gì được ghi: "Y consumed" và "quyết định
 * được ghi" là MỘT sự kiện.
 *
 * Result gắn vào Interaction SAU khi commit: gắn trước là ghi state provider
 * cho một quyết định có thể chưa commit. `result.error = 'access_denied'`
 * cho nhánh deny → provider throw ở resume (resume.js:90-96) →
 * `authorization_error_handler` redirect `error=access_denied` về
 * `redirect_uri` của client (hàng 10; invariant 12: chỉ auth dựng OAuth
 * error redirect).
 *
 * ## Idempotency (b) của §5.1.5
 *
 * `event_id` được sinh deterministic: `consent:<decision>:<transaction_id>`.
 * Cùng Y + cùng decision sau commit → CÙNG outcome + CÙNG continuation (Z
 * derive-on-demand); cùng Y + decision khác → `invalid_request` (decision đã
 * commit là vĩnh viễn); Y consumed bởi đường khác (không nhận ra decision) →
 * `invalid_grant`.
 */

import type { ConsentContextResponse, ConsentDecideResponse } from '@ecoma-io/auth-contracts';
import { HANDLE_DOMAINS, assessRiskLevel, deriveHandle, hashHandle } from '@ecoma-io/auth-domain';
import {
  advanceTransactionWithHandle,
  consumeHandleY,
  findActiveGrant,
  findCommittedConsentDecision,
  findRegisteredClient,
  findTransactionByHandleY,
  insertAuditEvent,
  insertConsentDecision,
  insertGrant,
  insertGrantScopes,
  type PostgresClientLike,
} from '@ecoma-io/auth-infrastructure';
import type { Provider } from 'oidc-provider';
import type { AuthorizationTransactionRecord } from '@ecoma-io/auth-application';
import {
  attachInteractionResult,
  buildLoginResult,
  createProviderGrant,
  deriveContinuationHandles,
  saveProviderGrant,
} from './oidc/interaction';
import {
  FRESH_AUTHN_WINDOW_MS,
  GRANT_TTL_SECONDS,
  payloadHashOf,
} from './session-verified-handler';

/** Kết quả dùng chung — status + body JSON. */
export type ConsentResult =
  | {
      readonly status: 200;
      readonly body: ConsentContextResponse | ConsentDecideResponse;
    }
  | {
      readonly status: 400 | 404 | 422;
      readonly body: { error: string; error_description?: string };
    };

/** MỘT lần đọc trước CAS — phục vụ cả phân biệt replay lẫn nghiệp vụ. */
async function loadByHandleY(
  postgresClient: PostgresClientLike,
  handleY: string,
): Promise<AuthorizationTransactionRecord | undefined> {
  const handleYHash = await hashHandle(handleY);
  return findTransactionByHandleY(postgresClient, { handleYHash });
}

/**
 * Plaintext handle X của transaction — correlator Interaction trong đường consent.
 *
 * ⚠️ Consent request KHÔNG mang handle X (chỉ Y), và hàng transaction chỉ lưu
 * HASH X (FR-016p) — tra theo bản rõ là không làm được từ DB. Nhưng handle X
 * là HMAC deterministic (`beginAuthorization` derive nó từ chính
 * `transaction_id` + handleKey + `HANDLE_DOMAINS.loginHandoff`), nên bản rõ
 * TÍNH LẠI ĐƯỢC. Đây là cách duy nhất glue tìm lại Interaction mà không cần
 * thêm cột correlator nào.
 */
async function deriveHandleXCorrelator(params: {
  readonly handleKey: string;
  readonly transactionId: string;
}): Promise<string> {
  return deriveHandle({
    key: params.handleKey,
    transactionId: params.transactionId,
    domain: HANDLE_DOMAINS.loginHandoff,
  });
}

/**
 * `POST /internal/consent/context` — hàng 6 của state machine.
 *
 * ⚠️ `account_session_ref` phải khớp của transaction: transaction chỉ mang
 * MỘT session đã bind ở bước push; một ASR khác là một session khác đang hỏi
 * consent của transaction người khác — từ chối, không lộ thông tin nào về
 * transaction.
 */
export async function runConsentContext(params: {
  readonly postgresClient: PostgresClientLike;
  readonly payload: unknown;
  readonly now: Date;
}): Promise<ConsentResult> {
  const { postgresClient, now } = params;

  // Validate inline — contracts KHÔNG có validator canonical cho Consent DTOs
  // (chỉ có type). Không echo giá trị payload vào lỗi.
  if (typeof params.payload !== 'object' || params.payload === null) {
    return { status: 400, body: { error: 'invalid_payload' } };
  }
  const record = params.payload as Record<string, unknown>;
  const handleY = record['handle'];
  const asr = record['account_session_ref'];
  if (typeof handleY !== 'string' || handleY === '') {
    return { status: 400, body: { error: 'invalid_payload', error_description: 'handle' } };
  }
  if (typeof asr !== 'string' || asr === '') {
    return {
      status: 400,
      body: { error: 'invalid_payload', error_description: 'account_session_ref' },
    };
  }

  const transaction = await loadByHandleY(postgresClient, handleY);
  if (transaction === undefined || transaction.state !== 'awaiting_consent') {
    return { status: 404, body: { error: 'invalid_grant' } };
  }
  if (transaction.account_session_ref !== asr) {
    return { status: 422, body: { error: 'invalid_request' } };
  }
  if (transaction.expires_at.getTime() <= now.getTime()) {
    return { status: 422, body: { error: 'invalid_request', error_description: 'het han' } };
  }

  const client = await findRegisteredClient(postgresClient, transaction.client_id);
  if (client === undefined) {
    return { status: 422, body: { error: 'invalid_client' } };
  }

  // Risk level là trình bày: authn cũ hoặc bối cảnh client/scope mới → điểm cao.
  // Client/scope "mới" xét theo nghĩa broad (grant active nào tồn tại chưa) —
  // assessRiskLevel nhận các cờ boolean, chi tiết "mới" nào do caller quyết.
  const existingGrant = await findActiveGrant(postgresClient, {
    sub: transaction.sub ?? '',
    clientId: transaction.client_id,
  });
  const riskLevel = assessRiskLevel({
    isNewClient: existingGrant === undefined,
    isNewScope: existingGrant === undefined,
    isAuthenticationFresh:
      transaction.authn_at !== null &&
      now.getTime() - transaction.authn_at.getTime() <= FRESH_AUTHN_WINDOW_MS,
  });

  const body: ConsentContextResponse = {
    client_name: client.client_id,
    scope: [...transaction.requested_scopes],
    risk_level: riskLevel,
  };
  return { status: 200, body };
}

/**
 * Lỗi điều khiển cho race CAS trong tx — tách class để bắt CHỈ lỗi này, không
 * nuốt lỗi hạ tầng (DB chết) đang lan cùng đường.
 */
class ConsentRaceError extends Error {}

/**
 * `POST /internal/consent/decide` — hàng 7/8 của state machine + bảng (b) của
 * §5.1.5.
 */
export async function runConsentDecide(params: {
  readonly provider: Provider;
  readonly postgresClient: PostgresClientLike;
  readonly payload: unknown;
  readonly handleKey: string;
  readonly now: Date;
}): Promise<ConsentResult> {
  const { postgresClient, now } = params;

  if (typeof params.payload !== 'object' || params.payload === null) {
    return { status: 400, body: { error: 'invalid_payload' } };
  }
  const record = params.payload as Record<string, unknown>;
  const handleY = record['handle'];
  const decision = record['decision'];
  const asr = record['account_session_ref'];
  if (typeof handleY !== 'string' || handleY === '') {
    return { status: 400, body: { error: 'invalid_payload', error_description: 'handle' } };
  }
  if (decision !== 'approve' && decision !== 'deny') {
    return { status: 400, body: { error: 'invalid_payload', error_description: 'decision' } };
  }
  if (typeof asr !== 'string' || asr === '') {
    return {
      status: 400,
      body: { error: 'invalid_payload', error_description: 'account_session_ref' },
    };
  }

  const transaction = await loadByHandleY(postgresClient, handleY);
  if (transaction === undefined) {
    return { status: 404, body: { error: 'invalid_grant' } };
  }
  if (transaction.state !== 'awaiting_consent') {
    // Không còn `awaiting_consent` ⇒ Y đã consumed và transaction đã advance ở
    // một event trước — bảng (b) xử lý dưới qua replay/reject.
    return await replayOrReject(params, transaction, decision);
  }
  if (transaction.account_session_ref !== asr) {
    return { status: 422, body: { error: 'invalid_request' } };
  }

  const handles = await deriveContinuationHandles({
    handleKey: params.handleKey,
    transactionId: transaction.transaction_id,
  });
  const handleZHash = await hashHandle(handles.handleZ);

  // Event id deterministic để replay nhận ra quyết định đã commit (xem header).
  const eventId = `consent:${decision}:${transaction.transaction_id}`;
  const payloadHash = await payloadHashOf(
    new TextEncoder().encode(JSON.stringify({ handle: handleY, decision, asr })),
  );

  const targetState = decision === 'approve' ? 'ready_to_complete' : 'denied';

  let grantId: string | undefined;
  try {
    await postgresClient.begin(async (tx) => {
      // (1) Advance CAS TRƯỚC — thoát ràng buộc CHECK của `awaiting_consent`.
      const advanced = await advanceTransactionWithHandle(tx, {
        transactionId: transaction.transaction_id,
        from: 'awaiting_consent',
        to: targetState,
        handleHash: handleZHash,
        eventId,
        payloadHash,
        outcome: 'success',
        now,
      });
      if (!advanced) {
        throw new ConsentRaceError('transaction da doi trang thai');
      }
      // (2) Consume Y CAS SAU. Thua ⇒ throw ⇒ rollback kể cả advance.
      //
      // ⚠️ `accountSessionRef`/`sub` truyền từ HÀNG đã load — identity
      // authoritative của bước decide đã qua kiểm app-layer ở trên (lỗi 422 trước
      // khi vào tx). Điểm của bind này khác kiểm đó: kiểm app-layer là
      // read-then-CAS (TOCTOU giữa load và consume), còn bind là điều kiện của
      // chính câu CAS — canonical CAS 2 của `0002` mà
      // `authorization-transaction-store.ts` chép (xem comment `consumeHandleY`).
      // KNOWN LIMITATION: `sub` nullable trên DTO nhưng CHECK schema (`0002`)
      // đảm bảo sub IS NULL chỉ ở hàng chưa qua CAS 1; khi state đã của
      // `awaiting_consent` (CHECK `handle_y_state_check`), CAS 1 đã bind sub
      // non-null — nhưng TS không biết điều đó, nên phải dồn về '' khi thiếu.
      const handleYHash = await hashHandle(handleY);
      const consumed = await consumeHandleY(tx, {
        handleYHash,
        accountSessionRef: transaction.account_session_ref ?? '',
        sub: transaction.sub ?? '',
        decision,
        eventId,
        payloadHash,
        now,
      });
      if (consumed === undefined) {
        throw new ConsentRaceError('handle_y da duoc tieu thu');
      }
      // (3) Audit + grant — cùng tx, cùng sự kiện. Khác các audit "fire-and-forget"
      // ở session-verified-handler: quyết định consent là MỘT sự kiện state machine
      // (§5.1.5b), nên hàng audit PHẢI commit/cùng rollback với nó — ném ở đây
      // rollback toàn bộ, đúng nghĩa "quyết định chưa được ghi".
      await insertAuditEvent(tx, {
        eventType: 'consent_decided',
        subjectRef: transaction.sub ?? undefined,
        clientId: transaction.client_id,
        authorizationTransactionId: transaction.transaction_id,
        outcome: 'success',
        details: { decision },
      });
      const decisionId = await insertConsentDecision(tx, {
        sub: transaction.sub ?? '',
        clientId: transaction.client_id,
        redirectUri: transaction.redirect_uri,
        grantedScopes: decision === 'approve' ? transaction.requested_scopes : [],
        decision,
        authorizationTransactionId: transaction.transaction_id,
        now,
      });
      if (decision === 'approve') {
        grantId = await insertGrant(tx, {
          sub: transaction.sub ?? '',
          clientId: transaction.client_id,
          scopes: transaction.requested_scopes,
          consentDecisionId: decisionId,
          now,
        });
        await insertGrantScopes(tx, { grantId, scopes: transaction.requested_scopes });
      }
    });
  } catch (error) {
    if (error instanceof ConsentRaceError) {
      // Một decide khác đã thắng giữa lúc ta đọc và lúc ta CAS: đọc lại và trả
      // qua bảng (b) — cùng decision ⇒ replay cùng outcome; khác decision ⇒
      // invalid_request. KHÔNG nuốt lỗi hạ tầng (không phải ConsentRaceError).
      const fresh = await loadByHandleY(postgresClient, handleY);
      if (fresh !== undefined) {
        return await replayOrReject(params, fresh, decision);
      }
      return { status: 422, body: { error: 'invalid_grant', error_description: 'race' } };
    }
    throw error;
  }

  return await decidedResponse(params, transaction, {
    decision,
    grantId,
    handleX: await deriveHandleXCorrelator({
      handleKey: params.handleKey,
      transactionId: transaction.transaction_id,
    }),
  });
}

/**
 * Nhánh `state !== 'awaiting_consent'` của decide — bảng (b):
 *   - replay cùng decision sau commit → CÙNG outcome + CÙNG continuation;
 *   - decision khác sau khi đã commit → `invalid_request`;
 *   - Y consumed bởi đường không nhận ra decision → `invalid_grant`.
 */
async function replayOrReject(
  params: {
    readonly provider: Provider;
    readonly postgresClient: PostgresClientLike;
    readonly handleKey: string;
    readonly now: Date;
  },
  transaction: AuthorizationTransactionRecord,
  decision: 'approve' | 'deny',
): Promise<ConsentResult> {
  const committedDecision = await findCommittedConsentDecision(params.postgresClient, {
    authorizationTransactionId: transaction.transaction_id,
  });
  if (committedDecision === undefined) {
    return {
      status: 422,
      body: { error: 'invalid_grant', error_description: 'handle da duoc tieu thu' },
    };
  }
  if (committedDecision !== decision) {
    // Cùng Y, decision khác — quyết định đã commit là vĩnh viễn (§5.1.5b).
    // `invalid_request` (request có cấu trúc đúng) chứ không phải `invalid_grant`.
    return {
      status: 422,
      body: {
        error: 'invalid_request',
        error_description: 'quyet dinh khac da duoc ghi cho handle nay',
      },
    };
  }
  // Replay — trả lại cùng outcome + cùng continuation.
  return await decidedResponse(params, transaction, {
    decision,
    grantId: undefined,
    handleX: await deriveHandleXCorrelator({
      handleKey: params.handleKey,
      transactionId: transaction.transaction_id,
    }),
  });
}

/**
 * Dựng response sau khi quyết định đã ghi (lần đầu hoặc replay).
 *
 * Provider Grant: lần đầu dùng `grantId` vừa insert trong tx; replay tra lại
 * grant active (`oauth_grants` có index unique active (sub, client) nên replay
 * trả đúng hàng cũ — không sinh grant thứ hai).
 */
async function decidedResponse(
  params: {
    readonly provider: Provider;
    readonly postgresClient: PostgresClientLike;
    readonly now: Date;
  },
  transaction: AuthorizationTransactionRecord,
  applied: {
    readonly decision: 'approve' | 'deny';
    readonly grantId: string | undefined;
    readonly handleX: string;
  },
): Promise<ConsentResult> {
  const { provider, postgresClient } = params;
  const sub = transaction.sub ?? '';

  if (applied.decision === 'deny') {
    // result.error → resume.js throw AccessDenied → authError redirect
    // `error=access_denied` về redirect_uri (hàng 10).
    const attached = await attachInteractionResult({
      provider,
      postgresClient,
      handleX: applied.handleX,
      result: {
        error: 'access_denied',
        error_description: 'user tu choi consent',
      },
    });
    if (attached === undefined) {
      return {
        status: 422,
        body: { error: 'server_error', error_description: 'interaction khong tim thay' },
      };
    }
    const body: ConsentDecideResponse = {
      outcome: 'denied',
      continue_url: attached.continueUrl,
    };
    return { status: 200, body };
  }

  // Approve — provider Grant jti = oauth_grants.id.
  let grantId = applied.grantId;
  if (grantId === undefined) {
    const grant = await findActiveGrant(postgresClient, {
      sub,
      clientId: transaction.client_id,
    });
    if (grant === undefined) {
      return {
        status: 422,
        body: { error: 'access_denied', error_description: 'grant mat hieu luc' },
      };
    }
    grantId = grant.id;
  }

  const providerGrant = createProviderGrant({
    provider,
    accountId: sub,
    clientId: transaction.client_id,
    scopes: transaction.requested_scopes,
    grantId,
    ttlSeconds: GRANT_TTL_SECONDS,
  });
  await saveProviderGrant(providerGrant, GRANT_TTL_SECONDS);

  const attached = await attachInteractionResult({
    provider,
    postgresClient,
    handleX: applied.handleX,
    result: {
      ...buildLoginResult({
        sub,
        acr: transaction.acr ?? '',
        authnAtMs:
          transaction.authn_at === null ? params.now.getTime() : transaction.authn_at.getTime(),
      }),
      consent: { grantId },
    },
  });
  if (attached === undefined) {
    return {
      status: 422,
      body: { error: 'server_error', error_description: 'interaction khong tim thay' },
    };
  }
  const body: ConsentDecideResponse = {
    outcome: 'approved',
    continue_url: attached.continueUrl,
  };
  return { status: 200, body };
}
