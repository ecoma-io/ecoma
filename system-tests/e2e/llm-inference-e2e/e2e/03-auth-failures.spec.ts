/**
 * Kịch bản (i) — auth thất bại ổn định: thiếu header, header sai hình, key
 * không tồn tại (không resolve ra tenant nào) đều trả cùng một lớp lỗi ổn định
 * 401 `invalid_api_key`, và KHÔNG để lại dấu vết nào trên sổ cái/logic request
 * (admission chặn trước mọi ghi).
 *
 * Đây là so sánh TƯƠNG ĐỐI (count trước/sau) nên spec không phụ thuộc số dòng
 * tuyệt đối mà spec 02 đã tạo.
 */

import { describe, expect, it } from 'vitest';

import {
  DRONIE_MODEL_ID,
  GATEWAY_DATABASE,
  WORKER_BASE_URL,
  psqlCount,
  requestInNetwork,
} from '../support/lane.mts';

const completionRequestBody = JSON.stringify({
  model: DRONIE_MODEL_ID,
  messages: [{ role: 'user', content: 'unauthorized probe' }],
  max_tokens: 8,
});

function ledgerFingerprint(): {
  requests: number;
  reservations: number;
  charges: number;
  entries: number;
} {
  return {
    requests: psqlCount(GATEWAY_DATABASE, `SELECT count(*) FROM llm_gateway.logical_requests`),
    reservations: psqlCount(
      GATEWAY_DATABASE,
      `SELECT count(*) FROM llm_gateway.quota_reservations`,
    ),
    charges: psqlCount(GATEWAY_DATABASE, `SELECT count(*) FROM llm_financial.customer_charges`),
    entries: psqlCount(GATEWAY_DATABASE, `SELECT count(*) FROM llm_financial.ledger_entries`),
  };
}

function postCompletion(headers: Record<string, string>): {
  status: number;
  errorCode: string | null;
} {
  const response = requestInNetwork({
    url: `${WORKER_BASE_URL}/v1/chat/completions`,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-request-id': `e2e-auth-${crypto.randomUUID()}`,
      ...headers,
    },
    body: completionRequestBody,
  });
  const body = JSON.parse(response.body) as { error?: { code: string | null } };
  return { status: response.status, errorCode: body.error?.code ?? null };
}

describe('auth failures stay stable and leave no ledger trace (i)', () => {
  it('rejects a missing authorization header with 401 invalid_api_key', () => {
    const outcome = postCompletion({});
    expect(outcome.status).toBe(401);
    expect(outcome.errorCode).toBe('invalid_api_key');
  });

  it('rejects a malformed authorization header with the same stable error', () => {
    // Header không mang scheme Bearer — sai hình, cùng lớp lỗi với thiếu. GIÁ
    // TRỊ TỔNG HỢP (không suy từ key thật): một phần plaintext của key thật
    // trong header là bề mặt rò rỉ thừa — fence chỉ quét FULL plaintext nên một
    // phần sẽ lọt qua mọi fence. Độ dài 43 khớp hình dạng key thật
    // (base64url 32 byte) để sai hình chỉ nằm ở scheme, không ở độ dài.
    const syntheticMalformedKey = 'x'.repeat(43);
    const outcome = postCompletion({
      authorization: `sk-no-bearer-prefix-${syntheticMalformedKey}`,
    });
    expect(outcome.status).toBe(401);
    expect(outcome.errorCode).toBe('invalid_api_key');
  });

  it('rejects an unknown key that resolves to no tenant with the same stable error', () => {
    // Key sai hình chữ nhật hash nào cũng không resolve ra row api_keys nào —
    // fail-closed không lộ lý do nội bộ (cùng envelope với thiếu header).
    const outcome = postCompletion({ authorization: 'Bearer sk-e2e-not-a-real-key' });
    expect(outcome.status).toBe(401);
    expect(outcome.errorCode).toBe('invalid_api_key');
  });

  it('leaves the logical request, quota, charge and journal tables untouched', () => {
    const before = ledgerFingerprint();
    postCompletion({});
    postCompletion({ authorization: 'Bearer sk-e2e-not-a-real-key' });
    const after = ledgerFingerprint();
    expect(after).toEqual(before);
  });
});
