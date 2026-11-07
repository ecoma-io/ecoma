import type { Pool } from 'pg';
import { insertAuditEvent } from './token-repo';

export class PgAuditRepo {
  constructor(private readonly pool: Pool) {}

  async writeAudit(event: {
    readonly tenantId: string | null;
    readonly actorSub: string | null;
    readonly action: string;
    readonly outcome: 'success' | 'failure';
    readonly detail?: Record<string, unknown>;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await insertAuditEvent(client, {
        tenantId: event.tenantId,
        actorSub: event.actorSub,
        actorTokenId: null,
        action: event.action,
        outcome: event.outcome,
        detail: event.detail,
      });
    } finally {
      client.release();
    }
  }
}
