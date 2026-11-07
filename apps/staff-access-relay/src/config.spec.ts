/**
 * Specs của loader cấu hình (`src/config.ts`) — fakes in-memory.
 *
 * Fail-closed: thiếu Hyperdrive/Queue binding là `throw` (cron đỏ ở Past
 * events), không "bỏ qua run này". Connection string không bao giờ rơi vào
 * message lỗi — message chỉ nêu tên binding (SR-001).
 */

import { describe, expect, it } from 'vitest';

import {
  DB_STAFF_ACCESS_BINDING,
  ENTITLEMENT_EVENTS_QUEUE_BINDING,
  loadRelayConfig,
  RelayConfigError,
} from './config';

function makeEnv(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    [DB_STAFF_ACCESS_BINDING]: {
      connectionString: 'postgres://relay:secret@hd-staff-access/db-staff-access',
    },
    [ENTITLEMENT_EVENTS_QUEUE_BINDING]: {
      send: async () => undefined,
    },
    ...overrides,
  };
}

describe('loadRelayConfig', () => {
  it('returns both bindings when present and well-shaped', () => {
    const config = loadRelayConfig(makeEnv({}));
    expect(config.db.connectionString).toBe(
      'postgres://relay:secret@hd-staff-access/db-staff-access',
    );
    expect(typeof config.queue.send).toBe('function');
  });

  it('throws when the Hyperdrive binding is missing entirely', () => {
    expect(() => loadRelayConfig(makeEnv({ [DB_STAFF_ACCESS_BINDING]: undefined }))).toThrow(
      new RegExp(`${DB_STAFF_ACCESS_BINDING}`, 'u'),
    );
  });

  it('throws when the Queue binding is missing entirely', () => {
    expect(() =>
      loadRelayConfig(makeEnv({ [ENTITLEMENT_EVENTS_QUEUE_BINDING]: undefined })),
    ).toThrow(new RegExp(`${ENTITLEMENT_EVENTS_QUEUE_BINDING}`, 'u'));
  });

  it('rejects a Hyperdrive binding that is not an object', () => {
    expect(() => loadRelayConfig(makeEnv({ [DB_STAFF_ACCESS_BINDING]: 'postgres://x' }))).toThrow(
      RelayConfigError,
    );
  });

  it('rejects a Hyperdrive binding whose connectionString is empty or missing', () => {
    expect(() =>
      loadRelayConfig(makeEnv({ [DB_STAFF_ACCESS_BINDING]: { connectionString: '' } })),
    ).toThrow(RelayConfigError);
    expect(() => loadRelayConfig(makeEnv({ [DB_STAFF_ACCESS_BINDING]: {} }))).toThrow(
      RelayConfigError,
    );
  });

  it('rejects a Queue binding without a send function', () => {
    expect(() =>
      loadRelayConfig(makeEnv({ [ENTITLEMENT_EVENTS_QUEUE_BINDING]: { send: 'nope' } })),
    ).toThrow(RelayConfigError);
  });

  it('keeps the binding name and never a credential in every config error message', () => {
    const messages: string[] = [];
    const throwsOn = (env: Record<string, unknown>): void => {
      try {
        loadRelayConfig(env);
      } catch (error) {
        messages.push((error as Error).message);
        return;
      }
      messages.push('<no throw>');
    };
    throwsOn({});
    throwsOn({ [DB_STAFF_ACCESS_BINDING]: 'postgres://worker:wrong-type@host/x' });
    throwsOn({ [DB_STAFF_ACCESS_BINDING]: { connectionString: '' } });

    expect(messages).toHaveLength(3);
    for (const message of messages) {
      expect(message).toContain('DB_STAFF_ACCESS');
      expect(message).not.toContain('postgres://');
      expect(message).not.toContain('wrong-type');
    }
  });
});
