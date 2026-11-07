/**
 * Webhook repo — CRUD cấu hình webhook (schema đã tạo sẵn, outbound execution
 * TẮT — SR-006). Port CRUD từ upstream DO; execute KHÔNG mở kết nối ra ngoài
 * khi `webhooksEnabled` false: ghi một execution `succeeded = false` với ghi
 * chú delivery disabled thay vì fetch. Kết quả: cấu hình được, log được,
 * không có HTTP nào ra ngoài.
 */
import type { Pool } from 'pg';

export interface WebhookRecord {
  id: string;
  events: string[];
  url: string;
  headers: Record<string, string> | null;
  consumerName: string | null;
  providerName: string | null;
  enabled: boolean;
  createdAt: string;
}

interface WebhookRow {
  id: string;
  events: string;
  url: string;
  headers: unknown;
  consumer_name: string | null;
  provider_name: string | null;
  enabled: boolean;
  created_at: Date;
}

export class PgWebhookRepo {
  constructor(private readonly pool: Pool) {}

  async listWebhooks(tenantId: string): Promise<WebhookRecord[]> {
    const { rows } = await this.pool.query<WebhookRow>(
      `SELECT w.id, w.events, w.url, w.headers,
              pc.name AS consumer_name, prov.name AS provider_name,
              w.enabled, w.created_at
         FROM pact.webhooks w
         LEFT JOIN pact.pacticipants pc ON pc.tenant_id = w.tenant_id AND pc.id = w.consumer_id
         LEFT JOIN pact.pacticipants prov ON prov.tenant_id = w.tenant_id AND prov.id = w.provider_id
        WHERE w.tenant_id = $1
        ORDER BY w.created_at ASC, w.id ASC`,
      [tenantId],
    );
    return rows.map(toRecord);
  }

  async getWebhook(tenantId: string, id: string): Promise<WebhookRecord | null> {
    const { rows } = await this.pool.query<WebhookRow>(
      `SELECT w.id, w.events, w.url, w.headers,
              pc.name AS consumer_name, prov.name AS provider_name,
              w.enabled, w.created_at
         FROM pact.webhooks w
         LEFT JOIN pact.pacticipants pc ON pc.tenant_id = w.tenant_id AND pc.id = w.consumer_id
         LEFT JOIN pact.pacticipants prov ON prov.tenant_id = w.tenant_id AND prov.id = w.provider_id
        WHERE w.tenant_id = $1 AND w.id = $2::uuid`,
      [tenantId, id],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async createWebhook(
    tenantId: string,
    input: {
      events: string[];
      url: string;
      headers: Record<string, string> | null;
      consumer: string | null;
      provider: string | null;
      enabled?: boolean;
    },
  ): Promise<WebhookRecord> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO pact.webhooks (tenant_id, consumer_id, provider_id, events, url, headers, enabled)
       VALUES ($1,
               (SELECT id FROM pact.pacticipants WHERE tenant_id = $1 AND name = $2),
               (SELECT id FROM pact.pacticipants WHERE tenant_id = $1 AND name = $3),
               $4, $5, $6::jsonb, $7)
       RETURNING id`,
      [
        tenantId,
        input.consumer,
        input.provider,
        input.events.join(','),
        input.url,
        JSON.stringify(input.headers ?? {}),
        input.enabled ?? true,
      ],
    );
    const created = await this.getWebhook(tenantId, rows[0].id);
    if (created === null) throw new Error('webhook disappeared after insert');
    return created;
  }

  async updateWebhook(
    tenantId: string,
    id: string,
    patch: {
      events?: string[];
      url?: string;
      headers?: Record<string, string>;
      consumer?: string | null;
      provider?: string | null;
      enabled?: boolean;
    },
  ): Promise<WebhookRecord | null> {
    const { rowCount } = await this.pool.query(
      `UPDATE pact.webhooks
          SET events = COALESCE($3, events),
              url = COALESCE($4, url),
              headers = COALESCE($5::jsonb, headers),
              consumer_id = CASE WHEN $6::text IS NULL THEN consumer_id
                                 ELSE (SELECT id FROM pact.pacticipants WHERE tenant_id = $1 AND name = $6) END,
              provider_id = CASE WHEN $7::text IS NULL THEN provider_id
                                 ELSE (SELECT id FROM pact.pacticipants WHERE tenant_id = $1 AND name = $7) END,
              enabled = COALESCE($8, enabled),
              updated_at = now()
        WHERE tenant_id = $1 AND id = $2::uuid`,
      [
        tenantId,
        id,
        patch.events !== undefined ? patch.events.join(',') : null,
        patch.url ?? null,
        patch.headers !== undefined ? JSON.stringify(patch.headers) : null,
        patch.consumer ?? null,
        patch.provider ?? null,
        patch.enabled ?? null,
      ],
    );
    if ((rowCount ?? 0) === 0) return null;
    return this.getWebhook(tenantId, id);
  }

  async deleteWebhook(tenantId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM pact.webhooks WHERE tenant_id = $1 AND id = $2::uuid`,
      [tenantId, id],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Ghi execution. Khi outbound TẮT, route gọi hàm này với `deliveryDisabled`
   * để log việc không delivery — audit trail giữ được, không HTTP nào đi ra.
   */
  async recordExecution(
    tenantId: string,
    webhookId: string,
    input: {
      event: string;
      trigger: 'manual' | 'automatic';
      succeeded: boolean;
      responseStatus?: number | null;
      responseBody?: string | null;
    },
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO pact.webhook_executions
         (tenant_id, webhook_id, event, trigger, attempt, succeeded, response_status, response_body)
       VALUES ($1, $2::uuid, $3, $4, 1, $5, $6, $7)`,
      [
        tenantId,
        webhookId,
        input.event,
        input.trigger,
        input.succeeded,
        input.responseStatus ?? null,
        input.responseBody ?? null,
      ],
    );
  }

  async getExecutions(
    tenantId: string,
    webhookId: string,
  ): Promise<
    Array<{
      id: string;
      event: string;
      trigger: string;
      succeeded: boolean;
      responseStatus: number | null;
      responseBody: string | null;
      executedAt: string;
    }>
  > {
    const { rows } = await this.pool.query<{
      id: string;
      event: string;
      trigger: string;
      succeeded: boolean;
      response_status: number | null;
      response_body: string | null;
      executed_at: Date;
    }>(
      `SELECT id, event, trigger, succeeded, response_status, response_body, executed_at
         FROM pact.webhook_executions
        WHERE tenant_id = $1 AND webhook_id = $2::uuid
        ORDER BY executed_at DESC, id DESC`,
      [tenantId, webhookId],
    );
    return rows.map((r) => ({
      id: r.id,
      event: r.event,
      trigger: r.trigger,
      succeeded: r.succeeded,
      responseStatus: r.response_status,
      responseBody: r.response_body,
      executedAt: r.executed_at.toISOString(),
    }));
  }
}

function toRecord(row: WebhookRow): WebhookRecord {
  let headers: Record<string, string> | null = null;
  if (row.headers !== null && typeof row.headers === 'object') {
    headers = row.headers as Record<string, string>;
  }
  return {
    id: row.id,
    events: row.events.split(',').map((s) => s.trim()),
    url: row.url,
    headers,
    consumerName: row.consumer_name,
    providerName: row.provider_name,
    enabled: row.enabled,
    createdAt: row.created_at.toISOString(),
  };
}
