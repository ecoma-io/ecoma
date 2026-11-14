/**
 * Consumer-side contract test (06-testing.md §7 — biên giữa hai deploy unit
 * phải có contract test qua public surface, không import internals): consumer
 * là **BFF của `pact-broker-app`**, provider là `pact-broker-api`.
 *
 * Hợp đồng mà consumer phụ thuộc và test này verify qua public surface:
 *
 *  1. `GET /pacticipants` trả `_embedded.pacticipants[]` với `name: string`.
 *  2. `GET /matrix?q[][pacticipant]=...` (selector lặp) trả ma trận HAL với
 *     row: `consumer.name`, `consumer.version.number`, `provider.name`,
 *     `pact.createdAt`, `verificationResult` = `null | {success, verifiedAt}`.
 *  3. Composition phía BFF của hai endpoint đó cho ra đúng dữ liệu thật ở
 *     `GET /api/broker/pacts` — mặt mà trang Pacts tiêu thụ.
 *
 * Đi qua **public surface của cả hai phía** (BFF HTTP + API HTTP), với full
 * stack thật: PostgreSQL container, migrations + bootstrap + machine token qua
 * CLI vận hành của API, workerd cho cả hai deploy unit, dữ liệu seed qua API.
 * Không import code nào của API — hợp đồng được quan sát, không được nhân bản
 * (anti-pattern §9: "Nhân bản định nghĩa contract vào tests/ của consumer").
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startBrokerStack, type BrokerSession, type BrokerStack } from './broker-stack';

let stack: BrokerStack;
/**
 * Phiên user đã đăng nhập (ADR-0031 §2) — mọi call BFF trong suite này phải
 * mang cookie phiên, vì middleware authn chặn `/api/**` không có phiên.
 */
let session: BrokerSession;

beforeAll(async () => {
  stack = await startBrokerStack();
  session = await stack.loginSession();
}, 300_000);

afterAll(async () => {
  // close() là bắt buộc: workerd còn sống giữ port, container còn sống giữ
  // tài nguyên Docker — tiến trình vitest phải thoát sạch.
  await stack?.close();
}, 120_000);

/** Row HAL của matrix mà API công bố — chỉ phần mà trang dashboard tiêu thụ. */
interface MatrixRowWire {
  consumer?: { name?: unknown; version?: { number?: unknown } };
  provider?: { name?: unknown };
  pact?: { createdAt?: unknown };
  verificationResult?: { success?: unknown; verifiedAt?: unknown } | null;
}

interface MatrixWire {
  matrix?: unknown;
}

async function fetchBffPacts(): Promise<{ status: number; body: MatrixWire }> {
  const response = await fetch(`${stack.appUrl}/api/broker/pacts`, {
    headers: { accept: 'application/json', cookie: session.cookieHeader },
  });
  const body = (await response.json().catch(() => null)) as MatrixWire | null;
  return { status: response.status, body: body ?? {} };
}

describe('pact-broker-app BFF to pact-broker-api matrix contract', () => {
  it('serves the composed matrix read with 200 and a real HAL matrix array', async () => {
    const { status, body } = await fetchBffPacts();

    // 200 chứng tỏ composition BFF (/pacticipants → /matrix với selector lặp)
    // đi hết vòng với API thật — không phải 400 của zero-selector cũ.
    expect(status).toBe(200);
    expect(Array.isArray(body.matrix)).toBe(true);
    expect((body.matrix as unknown[]).length).toBeGreaterThanOrEqual(3);
  });

  it('delivers matrix rows matching the HAL row contract the page renders', async () => {
    const { body } = await fetchBffPacts();
    const rows = body.matrix as MatrixRowWire[];

    for (const row of rows) {
      expect(typeof row.consumer?.name, 'consumer.name').toBe('string');
      expect(typeof row.consumer?.version?.number, 'consumer.version.number').toBe('string');
      expect(typeof row.provider?.name, 'provider.name').toBe('string');
      expect(typeof row.pact?.createdAt, 'pact.createdAt').toBe('string');
    }

    // verificationResult là `null | {success, verifiedAt}` — nhánh verified
    // tách khỏi vòng để expect không nằm trong conditional (oxlint
    // vitest/no-conditional-expect); seed luôn có ít nhất một verified.
    const verifiedRows = rows.filter(
      (
        row,
      ): row is MatrixRowWire & {
        verificationResult: { success?: unknown; verifiedAt?: unknown };
      } => row.verificationResult !== null && row.verificationResult !== undefined,
    );
    expect(verifiedRows.length).toBeGreaterThanOrEqual(1);
    for (const row of verifiedRows) {
      expect(typeof row.verificationResult.success, 'verificationResult.success').toBe('boolean');
      expect(typeof row.verificationResult.verifiedAt, 'verificationResult.verifiedAt').toBe(
        'string',
      );
    }
  });

  it('carries the seeded consumer/provider pairs with their real versions', async () => {
    const { body } = await fetchBffPacts();
    const rows = body.matrix as MatrixRowWire[];

    const describeRow = (row: MatrixRowWire): string =>
      `${String(row.consumer?.name)}@${String(row.consumer?.version?.number)}->${String(row.provider?.name)}`;

    // Cả hai version của cặp seed xuất hiện — ma trận liệt kê version thật,
    // không phải chỉ "latest".
    expect(
      rows.some(
        (row) =>
          row.consumer?.name === 'svc-consumer' &&
          row.consumer?.version?.number === '1.0.0' &&
          row.provider?.name === 'svc-provider',
      ),
      `expected row svc-consumer@1.0.0->svc-provider, got: ${rows.map(describeRow).join(', ')}`,
    ).toBe(true);
    expect(
      rows.some(
        (row) =>
          row.consumer?.name === 'svc-consumer' &&
          row.consumer?.version?.number === '2.0.0' &&
          row.provider?.name === 'svc-provider',
      ),
    ).toBe(true);
    expect(
      rows.some(
        (row) =>
          row.consumer?.name === 'svc-other' &&
          row.consumer?.version?.number === '0.3.0' &&
          row.provider?.name === 'svc-provider',
      ),
    ).toBe(true);
  });

  it('reflects the recorded verification on the verified pact and null on the rest', async () => {
    const { body } = await fetchBffPacts();
    const rows = body.matrix as MatrixRowWire[];

    const verified = rows.find(
      (row) => row.consumer?.name === 'svc-consumer' && row.consumer?.version?.number === '1.0.0',
    );
    expect(verified?.verificationResult).toEqual(expect.objectContaining({ success: true }));

    // Hai pact còn lại chưa có verification — null đúng shape HAL, không phải
    // field thiếu hay object rỗng.
    const unverified = rows.filter(
      (row) =>
        !(row.consumer?.name === 'svc-consumer' && row.consumer?.version?.number === '1.0.0'),
    );
    expect(unverified.length).toBeGreaterThanOrEqual(2);
    for (const row of unverified) {
      expect(row.verificationResult, `row ${String(row.consumer?.name)}`).toBeNull();
    }
  });

  it('exposes the same read through the BFF listing route the composition uses', async () => {
    // Hop 1 của composition — contract của /pacticipants: danh sách tên là
    // nguồn mà selector lặp của hop 2 được dựng từ đó.
    const response = await fetch(`${stack.appUrl}/api/broker/pacticipants`, {
      headers: { accept: 'application/json', cookie: session.cookieHeader },
    });
    expect(response.status).toBe(200);
    // Bracket-string cho khoá HAL — `_embedded` ở dot notation là
    // no-underscore-dangle (cùng pattern api.spec.ts của API).
    const body = (await response.json()) as { _embedded?: { pacticipants?: { name?: unknown }[] } };
    const names = (body['_embedded']?.pacticipants ?? [])
      .map((pacticipant) => pacticipant.name)
      .filter((name): name is string => typeof name === 'string');

    expect(names).toEqual(expect.arrayContaining(['svc-consumer', 'svc-other', 'svc-provider']));
  });
});
