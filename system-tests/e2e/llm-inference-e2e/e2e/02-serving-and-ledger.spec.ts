/**
 * Kịch bản (e)+(f)+(g)+(h) — serving thật trên lane và sổ cái bền vững:
 * catalogue model, MỘT chat completion đi qua worker → mock upstream với
 * envelope + usage thật, metadata-only log hai đầu, và trạng thái
 * usage/quota/settlement/journal trên DB settled đúng MỘT lần với escrow còn
 * bảo toàn; replay cùng x-request-id không double charge.
 *
 * Request id là DUY NHẤT THEO LẦN CHẠY (`e2e-inference-<run-token>`): replay
 * guard của worker chặn MỌI request id đã thấy kể cả khi lần trước FAILED —
 * id tĩnh làm run thứ hai dính 409 `request_id_replay` từ hàng cũ của run
 * trước. Mọi assertion "đúng một dòng" scope theo id này (logical_requests,
 * quota_reservations theo request_id; charge/financial reservation theo
 * charge_id all định `charge:<rid>:attempt:<rid>:1` từ `admission.ts`), nên
 * hàng của các run cũ không đụng vào; spec 03/04 khẳng định các thất bại auth
 * không thêm dòng nào.
 */

import { describe, expect, it } from 'vitest';

import {
  CONSUMER_TENANT_ID,
  DRONIE_MODEL_ID,
  GATEWAY_DATABASE,
  MOCK_DETERMINISTIC_CONTENT,
  SPONSOR_GRANT_AMOUNT_MINOR,
  WORKER_BASE_URL,
  containerLogs,
  laneConsumerApiKey,
  mockContainer,
  psqlCount,
  psqlQuery,
  requestInNetwork,
  workerContainer,
} from '../support/lane.mts';

/** Token chạy-riêng cho request id — base36 timestamp, an toàn charset [a-z0-9]. */
const RUN_TOKEN = Date.now().toString(36);
const REQUEST_ID = `e2e-inference-${RUN_TOKEN}`;
/** Charge id tất định của attempt 1 — cùng derivation với `admission.ts`. */
const CHARGE_ID = `charge:${REQUEST_ID}:attempt:${REQUEST_ID}:1`;
const PROMPT_MARKER = 'e2e-inference-prompt-of-record';

const completionRequestBody = JSON.stringify({
  model: DRONIE_MODEL_ID,
  messages: [{ role: 'user', content: PROMPT_MARKER }],
  max_tokens: 16,
});

describe('serving and ledger on the lane (e/f/g/h)', () => {
  it('(e) serves the dronie model catalogue through the worker', () => {
    const response = requestInNetwork({ url: `${WORKER_BASE_URL}/v1/models` });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      object: string;
      data: { id: string; object: string }[];
    };
    expect(body.object).toBe('list');
    expect(body.data.some((model) => model.id === DRONIE_MODEL_ID)).toBe(true);
    expect(body.data.every((model) => model.object === 'model')).toBe(true);
  });

  it('(f) serves a chat completion with the deterministic mock content and honest usage', () => {
    const response = requestInNetwork({
      url: `${WORKER_BASE_URL}/v1/chat/completions`,
      method: 'POST',
      headers: {
        authorization: `Bearer ${laneConsumerApiKey()}`,
        'content-type': 'application/json',
        'x-request-id': REQUEST_ID,
      },
      body: completionRequestBody,
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      id: string;
      object: string;
      model: string;
      choices: {
        index: number;
        message: { role: string; content: string };
        finish_reason: string;
      }[];
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
    };
    expect(body.object).toBe('chat.completion');
    // Response model = normalized_model_id của offer, không phải tên upstream.
    expect(body.model).toBe(DRONIE_MODEL_ID);
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0]?.message).toEqual({
      role: 'assistant',
      content: MOCK_DETERMINISTIC_CONTENT,
    });
    expect(body.choices[0]?.finish_reason).toBe('stop');
    // Usage thật từ upstream (mock phục vụ usage đầy đủ) — worker không bịa số.
    expect(body.usage).not.toBeNull();
    expect(body.usage?.total_tokens).toBe(
      (body.usage?.prompt_tokens ?? 0) + (body.usage?.completion_tokens ?? 0),
    );
  });

  it('(f) records the mock handshake as auth=ok with metadata-only logging', () => {
    const logs = containerLogs(mockContainer());
    // Dòng log của mock: method route scenario status duration + verdict auth.
    expect(logs).toContain('POST /v1/chat/completions scenario=ok status=200');
    expect(logs).toContain('auth=ok');
    // Fence log mock: không prompt, không content response.
    expect(logs).not.toContain(PROMPT_MARKER);
    expect(logs).not.toContain(MOCK_DETERMINISTIC_CONTENT);
  });

  it('(f) records the worker serving outcome without echoing request content', () => {
    const logs = containerLogs(workerContainer());
    expect(logs).toContain(`chat-completions ok request_id=${REQUEST_ID}`);
    expect(logs).not.toContain(PROMPT_MARKER);
    expect(logs).not.toContain(MOCK_DETERMINISTIC_CONTENT);
  });

  it('(g) settles the logical request exactly once with full attribution', () => {
    // BẢY cột: count + status + usage_status + evidence + requested_model +
    // resolved_model + flag charge dương — GROUP BY gộp về đúng MỘT nhóm khi
    // request id (duy nhất theo run) settled đúng một lần.
    const row = psqlQuery(
      GATEWAY_DATABASE,
      `SELECT count(*), status, usage_status, evidence, requested_model, resolved_model, charge_minor IS NOT NULL AND charge_minor > 0 ` +
        `FROM llm_gateway.logical_requests WHERE request_id = '${REQUEST_ID}' GROUP BY status, usage_status, evidence, requested_model, resolved_model, charge_minor`,
    );
    const fields = row.split('|');
    expect(fields).toHaveLength(7);
    expect(fields[0]).toBe('1');
    expect(fields[1]).toBe('completed');
    expect(fields[2]).toBe('known');
    expect(fields[3]).toBe('confirmed_completed');
    expect(fields[4]).toBe(DRONIE_MODEL_ID);
    expect(fields[5]).toBe(DRONIE_MODEL_ID);
    expect(fields[6]).toBe('t');
  });

  it('(g) settles exactly one quota reservation for the request', () => {
    const settled = psqlQuery(
      GATEWAY_DATABASE,
      `SELECT state, count(*) FROM llm_gateway.quota_reservations WHERE request_id = '${REQUEST_ID}' GROUP BY state`,
    );
    expect(settled).toBe('settled|1');
    const active = psqlCount(
      GATEWAY_DATABASE,
      `SELECT count(*) FROM llm_gateway.quota_reservations WHERE request_id = '${REQUEST_ID}' AND state = 'active'`,
    );
    expect(active).toBe(0);
  });

  it('(g) posts one charge bounded by its reservation and keeps the escrow conserved', () => {
    const chargeMinor = psqlQuery(
      GATEWAY_DATABASE,
      `SELECT charge_minor FROM llm_gateway.logical_requests WHERE request_id = '${REQUEST_ID}'`,
    );
    expect(BigInt(chargeMinor) > 0n).toBe(true);

    // ĐÚNG MỘT charge của REQUEST NÀY (charge_id tất định từ request id —
    // `admission.ts`), posted, amount đúng charge của request. Scope theo
    // charge_id (không đếm toàn bảng) để lane sống qua nhiều run suite.
    const charge = psqlQuery(
      GATEWAY_DATABASE,
      `SELECT state, count(*), amount_minor FROM llm_financial.customer_charges WHERE charge_id = '${CHARGE_ID}' GROUP BY state, amount_minor`,
    );
    expect(charge).toBe(`posted|1|${chargeMinor}`);

    // Reservation tài chính của charge đó: captured đúng amount, không release,
    // và reserved (ceiling cận trên) ≥ captured — "charged ≤ held".
    const reservation = psqlQuery(
      GATEWAY_DATABASE,
      `SELECT fr.state, fr.reserved_minor, fr.captured_minor, fr.released_minor ` +
        `FROM llm_financial.financial_reservations fr JOIN llm_financial.customer_charges cc ON cc.reservation_id = fr.reservation_id ` +
        `WHERE cc.charge_id = '${CHARGE_ID}'`,
    );
    const fields = reservation.split('|');
    expect(fields).toHaveLength(4);
    expect(fields[0]).toBe('captured');
    expect(BigInt(fields[1]) >= BigInt(chargeMinor)).toBe(true);
    expect(fields[2]).toBe(chargeMinor);
    expect(fields[3]).toBe('0');

    // Escrow còn bảo toàn sau serving: net BA leg wallet của consumer (quy ước
    // DƯƠNG là debit — posting grant là `wallet_available` debit, mirror
    // clearing credit) = amount grant (tiền không mất không sinh); leg charged
    // đã mang đúng amount charge.
    const walletId = psqlQuery(
      GATEWAY_DATABASE,
      `SELECT w.wallet_id FROM llm_financial.wallets w JOIN llm_financial.billing_accounts b ON b.billing_account_id = w.billing_account_id WHERE b.tenant_ref = '${CONSUMER_TENANT_ID}'`,
    );
    // Projection wallet materialize LƯỜI ở request serving đầu tiên
    // (`ensureWalletRow` chỉ gọi từ serving phase) — (f) phía trên là request
    // đó, nên row wallet phải tồn tại với denomination serving duy nhất. Trên
    // lane trình kiến (d) của spec 01 chỉ ghim hàng aggregate B1–B4.
    expect(walletId).not.toBe('');
    const denomination = psqlQuery(
      GATEWAY_DATABASE,
      `SELECT denomination FROM llm_financial.wallets WHERE wallet_id = '${walletId}'`,
    );
    expect(denomination).toBe('UC');
    const walletLegsNet = psqlQuery(
      GATEWAY_DATABASE,
      `SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount_minor ELSE -amount_minor END), 0) FROM llm_financial.ledger_entries ` +
        `WHERE wallet_id = '${walletId}' AND account IN ('wallet_available', 'wallet_held', 'wallet_charged')`,
    );
    expect(walletLegsNet).toBe(SPONSOR_GRANT_AMOUNT_MINOR);
    const chargedMinor = psqlQuery(
      GATEWAY_DATABASE,
      `SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount_minor ELSE -amount_minor END), 0) FROM llm_financial.ledger_entries WHERE wallet_id = '${walletId}' AND account = 'wallet_charged'`,
    );
    expect(BigInt(chargedMinor) >= BigInt(chargeMinor)).toBe(true);
  });

  it('(h) rejects the same request id as a replay without settling anything new', () => {
    const requestsBefore = psqlCount(
      GATEWAY_DATABASE,
      `SELECT count(*) FROM llm_gateway.logical_requests WHERE request_id = '${REQUEST_ID}'`,
    );
    const chargesBefore = psqlCount(
      GATEWAY_DATABASE,
      `SELECT count(*) FROM llm_financial.customer_charges WHERE charge_id = '${CHARGE_ID}'`,
    );
    const ledgerBefore = psqlCount(
      GATEWAY_DATABASE,
      `SELECT count(*) FROM llm_financial.ledger_entries`,
    );

    const response = requestInNetwork({
      url: `${WORKER_BASE_URL}/v1/chat/completions`,
      method: 'POST',
      headers: {
        authorization: `Bearer ${laneConsumerApiKey()}`,
        'content-type': 'application/json',
        'x-request-id': REQUEST_ID,
      },
      body: completionRequestBody,
    });
    expect(response.status).toBe(409);
    const envelope = JSON.parse(response.body) as { error: { code: string | null } };
    expect(envelope.error.code).toBe('request_id_replay');

    // Không mở reserve mới, không post charge mới, không ghi thêm journal.
    expect(
      psqlCount(
        GATEWAY_DATABASE,
        `SELECT count(*) FROM llm_gateway.logical_requests WHERE request_id = '${REQUEST_ID}'`,
      ),
    ).toBe(requestsBefore);
    expect(
      psqlCount(
        GATEWAY_DATABASE,
        `SELECT count(*) FROM llm_financial.customer_charges WHERE charge_id = '${CHARGE_ID}'`,
      ),
    ).toBe(chargesBefore);
    expect(psqlCount(GATEWAY_DATABASE, `SELECT count(*) FROM llm_financial.ledger_entries`)).toBe(
      ledgerBefore,
    );
  });
});
