/** Một hàng outbox entitlement như relay đọc từ `staff_access.entitlement_outbox_events`. */
export interface OutboxRow {
  readonly event_id: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly event_type: string;
  /** Payload JSON serialised — envelope {@link EntitlementEvent} của contracts. */
  readonly payload: string;
  readonly occurred_at: string;
  readonly published_at: string | null;
  /** Consumer settlement receipt status: NULL = not yet settled; 'applied' = consumer acked. */
  readonly settle_status: string | null;
  readonly attempts: number;
  readonly last_error: string | null;
}
