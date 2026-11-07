/**
 * Functional tests của route `POST /admin/v1/providers/:id/test` sau WB-4 — probe **thật**.
 *
 * ⚠️ Mỗi test đi qua `worker.fetch` thật và đọc lại D1. `globalThis.fetch` bị stub để không có
 * network thật; adapter (`createWebPushSender`) đọc chính `globalThis.fetch`, nên stub ảnh hưởng
 * trực tiếp tới phân loại — đây là cách duy nhất chứng minh probe gọi provider thật.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetConfigCacheForTest } from '../../src/config';

import { callRoute } from './app-env';
import {
  APP,
  OTHER_APP,
  createTestDatabase,
  seedScope,
  type SeededScope,
  type TestDatabase,
} from './d1-harness';
import { vapidTestKeyPair } from './vapid-test-keys';

/** Header của một caller Admin API đã xác thực. */
function adminHeaders(): Record<string, string> {
  return { authorization: 'Bearer admin-token', 'content-type': 'application/json' };
}

/** Material subscription hợp lệ (RFC 8291 Appendix A) — đủ để encryption không throw. */
const VALID_P256DH =
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'; // gitleaks:allow (vector công khai RFC 8291 Appendix A)
const VALID_AUTH = 'BTBZMqHH6r4Tts7J_aSIgg'; // gitleaks:allow (vector công khai RFC 8291 Appendix A)

async function rotateRealCredential(
  db: TestDatabase,
  providerId: string,
  vapidKeyId: string,
  label = 'probe',
): Promise<void> {
  const keyPair = await vapidTestKeyPair(label);
  const response = await callRoute(
    db,
    `/admin/v1/providers/${providerId}/rotate-credential`,
    adminHeaders(),
    {
      method: 'POST',
      body: {
        app: APP,
        vapid_key_id: vapidKeyId,
        public_key: keyPair.publicPointBase64Url,
        private_key: keyPair.privateKeyDerBase64Url,
        retire_vapid_key_id: null,
      },
    },
  );
  expect(response.status).toBe(200);
}

async function readAuditTestResults(db: TestDatabase, providerId: string): Promise<string[]> {
  const rows = await db.rows<{ detail_json: string }>(
    "SELECT detail_json FROM audit_records WHERE entity_id = ? AND event = 'provider_updated' ORDER BY recorded_at",
    providerId,
  );
  return rows.map((row) => {
    const parsed = JSON.parse(row.detail_json) as { test_result?: string };
    return parsed.test_result ?? '';
  });
}

describe('POST /admin/v1/providers/:id/test — probe thật (WB-4, FR-018)', () => {
  let db: TestDatabase;
  let scoped: SeededScope;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    resetConfigCacheForTest();
    db = await createTestDatabase();
    scoped = await seedScope(db);
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    // ⚠️ Huỷ instance workerd của database test — mỗi `createTestDatabase` là một tiến trình;
    // không huỷ là rò tiến trình suốt lần chạy (06-testing.md §6: suite tự dọn).
    await db.dispose();
    resetConfigCacheForTest();
  });

  async function setupValidMaterial(): Promise<void> {
    const newVapidKeyId = scoped.vapidKeyId.replace('vapid-k1', 'vapid-k2');
    await rotateRealCredential(db, scoped.providerId, newVapidKeyId);
    await db.run(
      'UPDATE push_subscriptions SET p256dh = ?, auth = ?, vapid_key_id = ? WHERE subscription_id = ?',
      VALID_P256DH,
      VALID_AUTH,
      newVapidKeyId,
      scoped.subscriptionId,
    );
  }

  it('2xx → delivery_accepted và gọi provider thật', async () => {
    await setupValidMaterial();
    fetchMock.mockResolvedValue(new Response(null, { status: 201 }));

    const response = await callRoute(
      db,
      `/admin/v1/providers/${scoped.providerId}/test`,
      adminHeaders(),
      {
        method: 'POST',
        body: { app: APP, subscription_id: scoped.subscriptionId },
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: string };
    expect(body.result).toBe('delivery_accepted');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const results = await readAuditTestResults(db, scoped.providerId);
    expect(results).toContain('delivery_accepted');
  });

  it('401 → authentication_failed', async () => {
    await setupValidMaterial();
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

    const response = await callRoute(
      db,
      `/admin/v1/providers/${scoped.providerId}/test`,
      adminHeaders(),
      {
        method: 'POST',
        body: { app: APP, subscription_id: scoped.subscriptionId },
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: string };
    expect(body.result).toBe('authentication_failed');
  });

  it('403 → authentication_failed', async () => {
    await setupValidMaterial();
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));

    const response = await callRoute(
      db,
      `/admin/v1/providers/${scoped.providerId}/test`,
      adminHeaders(),
      {
        method: 'POST',
        body: { app: APP, subscription_id: scoped.subscriptionId },
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: string };
    expect(body.result).toBe('authentication_failed');
  });

  it('404 → subscription_invalid', async () => {
    await setupValidMaterial();
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));

    const response = await callRoute(
      db,
      `/admin/v1/providers/${scoped.providerId}/test`,
      adminHeaders(),
      {
        method: 'POST',
        body: { app: APP, subscription_id: scoped.subscriptionId },
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: string };
    expect(body.result).toBe('subscription_invalid');
  });

  it('410 → subscription_invalid', async () => {
    await setupValidMaterial();
    fetchMock.mockResolvedValue(new Response(null, { status: 410 }));

    const response = await callRoute(
      db,
      `/admin/v1/providers/${scoped.providerId}/test`,
      adminHeaders(),
      {
        method: 'POST',
        body: { app: APP, subscription_id: scoped.subscriptionId },
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: string };
    expect(body.result).toBe('subscription_invalid');
  });

  it('413 → configuration_invalid', async () => {
    await setupValidMaterial();
    fetchMock.mockResolvedValue(new Response(null, { status: 413 }));

    const response = await callRoute(
      db,
      `/admin/v1/providers/${scoped.providerId}/test`,
      adminHeaders(),
      {
        method: 'POST',
        body: { app: APP, subscription_id: scoped.subscriptionId },
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: string };
    expect(body.result).toBe('configuration_invalid');
  });

  it('3xx redirect → provider_rejected_request (không đi theo redirect)', async () => {
    await setupValidMaterial();
    fetchMock.mockResolvedValue(new Response(null, { status: 301 }));

    const response = await callRoute(
      db,
      `/admin/v1/providers/${scoped.providerId}/test`,
      adminHeaders(),
      {
        method: 'POST',
        body: { app: APP, subscription_id: scoped.subscriptionId },
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: string };
    expect(body.result).toBe('provider_rejected_request');
  });

  it('429 → provider_rejected_request', async () => {
    await setupValidMaterial();
    fetchMock.mockResolvedValue(new Response(null, { status: 429 }));

    const response = await callRoute(
      db,
      `/admin/v1/providers/${scoped.providerId}/test`,
      adminHeaders(),
      {
        method: 'POST',
        body: { app: APP, subscription_id: scoped.subscriptionId },
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: string };
    expect(body.result).toBe('provider_rejected_request');
  });

  it('5xx → provider_rejected_request', async () => {
    await setupValidMaterial();
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

    const response = await callRoute(
      db,
      `/admin/v1/providers/${scoped.providerId}/test`,
      adminHeaders(),
      {
        method: 'POST',
        body: { app: APP, subscription_id: scoped.subscriptionId },
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: string };
    expect(body.result).toBe('provider_rejected_request');
  });

  it('network throw → provider_rejected_request', async () => {
    await setupValidMaterial();
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const response = await callRoute(
      db,
      `/admin/v1/providers/${scoped.providerId}/test`,
      adminHeaders(),
      {
        method: 'POST',
        body: { app: APP, subscription_id: scoped.subscriptionId },
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: string };
    expect(body.result).toBe('provider_rejected_request');
  });

  it('thiếu credential active → configuration_invalid, không gọi provider', async () => {
    await db.run(
      "UPDATE push_provider_credentials SET status = 'retired' WHERE provider_id = ?",
      scoped.providerId,
    );

    fetchMock.mockResolvedValue(new Response(null, { status: 201 }));

    const response = await callRoute(
      db,
      `/admin/v1/providers/${scoped.providerId}/test`,
      adminHeaders(),
      {
        method: 'POST',
        body: { app: APP, subscription_id: scoped.subscriptionId },
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: string };
    expect(body.result).toBe('configuration_invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('endpoint không parse được → configuration_invalid, không gọi provider', async () => {
    await setupValidMaterial();
    await db.run(
      "UPDATE push_subscriptions SET endpoint = 'http://not-https.example.com/push' WHERE subscription_id = ?",
      scoped.subscriptionId,
    );

    fetchMock.mockResolvedValue(new Response(null, { status: 201 }));

    const response = await callRoute(
      db,
      `/admin/v1/providers/${scoped.providerId}/test`,
      adminHeaders(),
      {
        method: 'POST',
        body: { app: APP, subscription_id: scoped.subscriptionId },
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: string };
    expect(body.result).toBe('configuration_invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('credential public key hỏng → configuration_invalid (vapid_key_missing), không gọi provider', async () => {
    await setupValidMaterial();
    await db.run(
      "UPDATE push_provider_credentials SET public_key = 'not-a-valid-key' WHERE provider_id = ? AND status = 'active'",
      scoped.providerId,
    );
    await db.run(
      'UPDATE push_subscriptions SET p256dh = ?, auth = ? WHERE subscription_id = ?',
      VALID_P256DH,
      VALID_AUTH,
      scoped.subscriptionId,
    );

    fetchMock.mockResolvedValue(new Response(null, { status: 201 }));

    const response = await callRoute(
      db,
      `/admin/v1/providers/${scoped.providerId}/test`,
      adminHeaders(),
      {
        method: 'POST',
        body: { app: APP, subscription_id: scoped.subscriptionId },
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: string };
    expect(body.result).toBe('configuration_invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('target subscription thuộc app khác → không gọi provider', async () => {
    const other = await seedScope(db, { app: OTHER_APP });
    await setupValidMaterial();

    fetchMock.mockResolvedValue(new Response(null, { status: 201 }));

    const response = await callRoute(
      db,
      `/admin/v1/providers/${scoped.providerId}/test`,
      adminHeaders(),
      {
        method: 'POST',
        body: { app: APP, subscription_id: other.subscriptionId },
      },
    );

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('target subscription khác transport → subscription_invalid, không gọi provider', async () => {
    await setupValidMaterial();
    await db.run(
      "UPDATE push_subscriptions SET transport = 'app' WHERE subscription_id = ?",
      scoped.subscriptionId,
    );

    fetchMock.mockResolvedValue(new Response(null, { status: 201 }));

    const response = await callRoute(
      db,
      `/admin/v1/providers/${scoped.providerId}/test`,
      adminHeaders(),
      {
        method: 'POST',
        body: { app: APP, subscription_id: scoped.subscriptionId },
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: string };
    expect(body.result).toBe('subscription_invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('audit được ghi với provider_updated + test_result, không rò secret', async () => {
    await setupValidMaterial();
    fetchMock.mockResolvedValue(new Response('SECRET-RESPONSE-BODY-XYZ', { status: 201 }));

    const response = await callRoute(
      db,
      `/admin/v1/providers/${scoped.providerId}/test`,
      adminHeaders(),
      {
        method: 'POST',
        body: { app: APP, subscription_id: scoped.subscriptionId },
      },
    );
    expect(response.status).toBe(200);

    const bodyText = await response.text();
    const auditRows = await db.rows<{ detail_json: string }>(
      "SELECT detail_json FROM audit_records WHERE entity_id = ? AND event = 'provider_updated'",
      scoped.providerId,
    );
    expect(auditRows.length).toBeGreaterThan(0);
    const auditText = auditRows.map((r) => r.detail_json).join(' ');
    const combined = bodyText + ' ' + auditText;

    for (const secret of ['SECRET-RESPONSE-BODY-XYZ', VALID_P256DH, VALID_AUTH]) {
      expect(combined).not.toContain(secret);
    }

    const lastAuditRow = auditRows[auditRows.length - 1];
    const parsed = JSON.parse(lastAuditRow?.detail_json ?? '{}') as {
      test_result: string;
    };
    const allowed = new Set([
      'configuration_invalid',
      'authentication_failed',
      'provider_rejected_request',
      'subscription_invalid',
      'delivery_accepted',
    ]);
    expect(allowed.has(parsed.test_result)).toBe(true);
  });

  it('decrypt lỗi → configuration_invalid', async () => {
    await setupValidMaterial();
    await db.run(
      "UPDATE push_provider_credentials SET credential_encryption_version = 'K9' WHERE provider_id = ? AND status = 'active'",
      scoped.providerId,
    );

    fetchMock.mockResolvedValue(new Response(null, { status: 201 }));

    const response = await callRoute(
      db,
      `/admin/v1/providers/${scoped.providerId}/test`,
      adminHeaders(),
      {
        method: 'POST',
        body: { app: APP, subscription_id: scoped.subscriptionId },
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: string };
    expect(body.result).toBe('configuration_invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
