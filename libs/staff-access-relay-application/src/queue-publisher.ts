export interface QueuePublisher {
  /** Gửi message vào Queue với idempotency key = event_id. */
  send(message: unknown, idempotencyKey: string): Promise<void>;
}
