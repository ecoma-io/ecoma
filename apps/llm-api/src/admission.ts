/**
 * Quyết định admission THUẦN của POST /v1/chat/completions (01-architecture
 * §11; ADR-0028 §5; DECISION của slice P4 về usage bounds).
 *
 * Module này không đọc env, không chạm DB, không fetch — mọi hàm nhận input
 * phẳng và trả kết quả phân loại (discriminated union) để orchestration
 * (`chat-completions.ts`) map sang API error/DB write. Nhờ thuần, toàn bộ
 * bảng quyết định được unit test không cần workerd lẫn PostgreSQL.
 *
 * Hai identity ĐỘC LẬP VĨNH VIỄN của admission được suy tất định ở đây:
 * - quota reservation id: từ `request_id` (một logical request một reservation);
 * - financial admission identity: từ `(request_id, attempt_id)` — không bao
 *   giờ trùng identity quota (ADR-0028 §5).
 */

/** Giới hạn độ dài id opaque của hệ thống (khớp `isOpaqueId` của financial lib). */
const MAX_OPAQUE_ID_LENGTH = 200;

// ---------------------------------------------------------------------------
// Id tất định
// ---------------------------------------------------------------------------

/** Quota reservation id — identity thứ nhất, suy từ `request_id`. */
export function deriveQuotaReservationId(requestId: string): string {
  return `quota:${requestId}`;
}

/** Attempt id của attempt số `attemptNo` của một logical request. */
export function deriveAttemptId(requestId: string, attemptNo: number): string {
  return `attempt:${requestId}:${String(attemptNo)}`;
}

/** Financial reservation id — identity thứ hai, suy từ `(request_id, attempt_id)`. */
export function deriveFinancialReservationId(requestId: string, attemptId: string): string {
  return `finres:${requestId}:${attemptId}`;
}

/** Settlement id tất định của `(request_id, attempt_id)` — settle idempotent không tra cứu. */
export function deriveSettlementId(requestId: string, attemptId: string): string {
  return `settle:${requestId}:${attemptId}`;
}

/** Charge id tất định của `(request_id, attempt_id)`. */
export function deriveChargeId(requestId: string, attemptId: string): string {
  return `charge:${requestId}:${attemptId}`;
}

/** Completion id của response (`chatcmpl-` + request_id) — tất định, không randomness. */
export function deriveCompletionId(requestId: string): string {
  return `chatcmpl-${requestId}`;
}

// ---------------------------------------------------------------------------
// request_id + payload hash (idempotency)
// ---------------------------------------------------------------------------

/** Kết quả đọc `x-request-id`: tự sinh khi thiếu, từ chối khi sai hình. */
export type RequestIdResolution =
  | { readonly kind: 'generated'; readonly requestId: string }
  | { readonly kind: 'provided'; readonly requestId: string }
  | { readonly kind: 'invalid' };

/**
 * Đọc identity của logical request từ header `x-request-id`: trim, 1..200 ký
 * tự opaque. Thiếu header → tự sinh (UUID) — replay chỉ xảy ra khi caller CỐ
 * ý gửi lại cùng id (docs §11: bề mặt OpenAI-compat không có HTTP idempotency
 * key riêng). Header sai hình → lỗi 400, không tự sinh (caller thừa nhận một
 * contract không hợp lệ phải thấy lỗi, không phải một request mới im lặng).
 */
export function resolveRequestId(headerValue: string | undefined): RequestIdResolution {
  if (headerValue === undefined) {
    return { kind: 'generated', requestId: crypto.randomUUID() };
  }
  const trimmed = headerValue.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_OPAQUE_ID_LENGTH) {
    return { kind: 'invalid' };
  }
  return { kind: 'provided', requestId: trimmed };
}

/**
 * Canonical JSON: key sort đệ quy — cùng payload với thứ tự key khác nhau cho
 * cùng hash (replay đúng nghĩa), payload khác cho hash khác (conflict).
 * `undefined` field bị drop (JSON.stringify semantics), array giữ thứ tự.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .toSorted(([leftKey], [rightKey]) => (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

// ---------------------------------------------------------------------------
// Request validation (DECISION slice P4)
// ---------------------------------------------------------------------------

/** Mã lỗi validation — orchestration map sang ApiError tương ứng. */
export type ChatRequestFailure =
  | 'missing_model'
  | 'missing_messages'
  | 'invalid_messages'
  | 'streaming_not_supported'
  | 'max_tokens_required'
  | 'invalid_max_tokens';

/** Request chat đã hợp lệ: các field serving dùng (phần còn lại không truyền upstream). */
export interface ValidatedChatRequest {
  readonly model: string;
  readonly messages: readonly unknown[];
  readonly maxTokens: number;
}

/** Kết quả validate body chat completions. */
export type ChatRequestValidation =
  | { readonly kind: 'valid'; readonly request: ValidatedChatRequest }
  | { readonly kind: 'invalid'; readonly failure: ChatRequestFailure };

/**
 * Validate body của POST /v1/chat/completions:
 * - `model` string không rỗng — bắt buộc (alias công khai; resolve qua catalogue).
 * - `messages` array không rỗng, mỗi item là object có `role` string — bắt buộc.
 * - `max_tokens` integer ≥ 1 — BẮT BUỘC (DECISION 2: output bound không có
 *   tokenizer, lấy trực tiếp từ client; thiếu là 422 ổn định).
 * - `stream` chỉ nhận vắng mặt/`false` — streaming là non-goal (#28), từ chối
 *   ổn định 400 thay vì im lặng downgrade.
 * Các field khác (temperature, tools, ...) không đọc — MVP passthrough tối
 * thiểu, payload upstream chỉ gồm model/messages/max_tokens.
 */
export function validateChatRequest(body: unknown): ChatRequestValidation {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { kind: 'invalid', failure: 'missing_model' };
  }
  const record = body as Record<string, unknown>;
  if (typeof record['model'] !== 'string' || record['model'].length === 0) {
    return { kind: 'invalid', failure: 'missing_model' };
  }
  const messages = record['messages'];
  if (!Array.isArray(messages) || messages.length === 0) {
    return { kind: 'invalid', failure: 'missing_messages' };
  }
  for (const message of messages) {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      return { kind: 'invalid', failure: 'invalid_messages' };
    }
    if (typeof (message as Record<string, unknown>)['role'] !== 'string') {
      return { kind: 'invalid', failure: 'invalid_messages' };
    }
  }
  if (record['stream'] === true) {
    return { kind: 'invalid', failure: 'streaming_not_supported' };
  }
  if (record['stream'] !== undefined && record['stream'] !== false) {
    return { kind: 'invalid', failure: 'streaming_not_supported' };
  }
  const maxTokens = record['max_tokens'];
  if (maxTokens === undefined || maxTokens === null) {
    return { kind: 'invalid', failure: 'max_tokens_required' };
  }
  if (
    typeof maxTokens !== 'number' ||
    !Number.isInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens > Number.MAX_SAFE_INTEGER
  ) {
    return { kind: 'invalid', failure: 'invalid_max_tokens' };
  }
  return {
    kind: 'valid',
    request: { model: record['model'], messages, maxTokens },
  };
}

/**
 * Ước lượng ký tự prompt — determinstic, KHÔNG tokenizer (DECISION 2; MVP
 * limitation được ghi nhận): cộng độ dài `content` dạng string hoặc
 * mảng text part (`{type:'text', text}`) của mỗi message.
 */
export function estimatePromptCharacters(messages: readonly unknown[]): number {
  let total = 0;
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) {
      continue;
    }
    const content = (message as Record<string, unknown>)['content'];
    if (typeof content === 'string') {
      total += content.length;
      continue;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (
          typeof part === 'object' &&
          part !== null &&
          (part as Record<string, unknown>)['type'] === 'text' &&
          typeof (part as Record<string, unknown>)['text'] === 'string'
        ) {
          total += ((part as Record<string, unknown>)['text'] as string).length;
        }
      }
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Token bounds + admission hold (DECISION 2)
// ---------------------------------------------------------------------------

/** Cận token của một request sau khi qua cap của pricing snapshot. */
export interface TokenBounds {
  /** min(ceil(ký tự prompt / 2), cap input của snapshot). */
  readonly inputTokens: bigint;
  /** min(max_tokens client, cap output của snapshot). */
  readonly outputTokens: bigint;
}

/**
 * Hai cận token admission (DECISION 2):
 * - input bound = ceil(ký tự prompt / 2) — over-estimate determinstic, không
 *   phụ thuộc tokenizer; byte-length an toàn hơn nhưng chars là đơn vị người
 *   đọc được ghi trong DECISION.
 * - output bound = `max_tokens` client (bắt buộc).
 * Cả hai bị CAP bởi per-request bounds của snapshot TRƯỚC khi tính giá
 * (hold = min(bound, cap) × rate); vượt cap không chặn request — charge thật
 * vượt hold bị cap tại held + audit `financial_charge_capped` (ADR-0028 §5).
 */
export function computeTokenBounds(input: {
  promptCharacters: number;
  maxTokens: number;
  maxInputTokensPerRequest: bigint;
  maxOutputTokensPerRequest: bigint;
}): TokenBounds {
  const inputEstimate = BigInt(Math.ceil(input.promptCharacters / 2));
  const clientOutput = BigInt(input.maxTokens);
  return {
    inputTokens:
      inputEstimate < input.maxInputTokensPerRequest
        ? inputEstimate
        : input.maxInputTokensPerRequest,
    outputTokens:
      clientOutput < input.maxOutputTokensPerRequest
        ? clientOutput
        : input.maxOutputTokensPerRequest,
  };
}
