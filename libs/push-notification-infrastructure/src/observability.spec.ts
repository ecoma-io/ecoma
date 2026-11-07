/**
 * Unit test cho `observability.ts` — logger JSON một dòng và phân loại lỗi D1.
 *
 * ⚠️ **Observability không được trở thành phụ thuộc của đường serving** — đây là bất biến
 * được test trực tiếp: một field không serialize được, một sink ném, đều không được phép
 * làm logger ném. Một log line hỏng là mất quan sát; một request 500 vì log là mất dữ liệu.
 *
 * ⚠️ **`isRetryableStorageError` được kiểm theo HƯỚNG SO KHỚP THẬT của implementation**
 * (`pattern.includes(message)` — toàn bộ message phải nằm trong một pattern), theo đúng
 * nguyên tắc "test mô tả hành vi hiện tại, không mô tả comment". Chiều lệch giữa comment
 * ("tiền tố thông điệp") và implementation được nêu trong phần Findings của PR, không được
 * "sửa" âm thầm trong test.
 */

import { describe, expect, it } from 'vitest';

import { createLogger, isRetryableStorageError, type Logger } from './observability';

/** Sink thu thập dòng JSON để assert từng field. */
function collectingSink(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line: string) => void lines.push(line) };
}

function loggerWith(
  level: Logger extends never ? never : Parameters<typeof createLogger>[0]['level'],
  overrides: Partial<Parameters<typeof createLogger>[0]> = {},
): { logger: Logger; lines: string[] } {
  const { lines, sink } = collectingSink();
  return {
    logger: createLogger({
      service: 'push-notification',
      environment: 'test',
      level,
      sink,
      now: () => 1_800_000_000_000,
      ...overrides,
    }),
    lines,
  };
}

describe('createLogger — level threshold', () => {
  it('emits a message at the configured level and suppresses everything below it', () => {
    const { logger, lines } = loggerWith('warn');

    logger.debug('debug line');
    logger.info('info line');
    logger.warn('warn line');
    logger.error('error line');

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ level: 'warn', message: 'warn line' });
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ level: 'error', message: 'error line' });
  });

  it('emits everything at debug level', () => {
    const { logger, lines } = loggerWith('debug');

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(lines).toHaveLength(4);
  });
});

describe('createLogger — one JSON line with mandatory correlation fields', () => {
  it('stamps ts, level, service and environment on every line', () => {
    const { logger, lines } = loggerWith('info');

    logger.info('request handled');

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(parsed.ts).toBe('2027-01-15T08:00:00.000Z'); // 1_800_000_000_000 epoch millis, UTC
    expect(parsed.level).toBe('info');
    expect(parsed.service).toBe('push-notification');
    expect(parsed.environment).toBe('test');
    expect(parsed.message).toBe('request handled');
  });

  it('merges fields at the top level, not nested', () => {
    const { logger, lines } = loggerWith('info');

    logger.info('delivery published', { app: 'ecoma-io', attempts: 2, queued: true });

    const parsed = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(parsed.app).toBe('ecoma-io');
    expect(parsed.attempts).toBe(2);
    expect(parsed.queued).toBe(true);
  });

  it('lets a caller field override a built-in field so a mistake is visible, not hidden', () => {
    // Caller truyền `level` sai là lỗi của caller và phải lộ ra trong dòng log — không bị
    // báo là hợp lệ. Merge giữ giá trị của caller.
    const { logger, lines } = loggerWith('info');

    logger.info('message', { service: 'caller-overridden' });

    const parsed = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(parsed.service).toBe('caller-overridden');
  });

  it('swallows a sinking error instead of throwing into the request path', () => {
    // Một log line hỏng là mất quan sát; một request 500 vì log là mất dữ liệu.
    const logger = createLogger({
      service: 'push-notification',
      environment: 'test',
      level: 'info',
      sink: () => {
        throw new Error('sink exploded');
      },
    });

    expect(() => logger.info('anything')).not.toThrow();
  });

  it('swallows a stringify failure from a circular field value', () => {
    let sinkCalled = false;
    const logger = createLogger({
      service: 'push-notification',
      environment: 'test',
      level: 'info',
      sink: () => {
        sinkCalled = true;
      },
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    // Vi phạm kiểu LogFields ở đây là có chủ đích: một giá trị không serialize được phải bị
    // nuốt ở runtime, không được làm logger ném.
    expect(() =>
      logger.info('circular', circular as unknown as Parameters<Logger['info']>[1]),
    ).not.toThrow();
    expect(sinkCalled).toBe(false);
  });
});

describe('isRetryableStorageError — the closed pattern list', () => {
  it('classifies non-Error values as permanent', () => {
    expect(isRetryableStorageError('d1 is overloaded')).toBe(false);
    expect(isRetryableStorageError(null)).toBe(false);
    expect(isRetryableStorageError(undefined)).toBe(false);
  });

  it('accepts a message that equals one of the closed patterns', () => {
    for (const pattern of [
      'd1_database_error',
      'd1 is overloaded',
      'too many requests',
      'request timeout',
      'timed out',
      'connection',
      'network',
      'temporarily unavailable',
      'internal error',
    ]) {
      expect(isRetryableStorageError(new Error(pattern))).toBe(true);
    }
  });

  it('matches case-insensitively against the message', () => {
    expect(isRetryableStorageError(new Error('TOO MANY REQUESTS'))).toBe(true);
    expect(isRetryableStorageError(new Error('Internal Error'))).toBe(true);
  });

  it('classifies a longer D1-shaped message as NOT retryable (documented direction gap)', () => {
    // ⚠️ Hướng so khớp thật là `pattern.includes(message)`: toàn bộ message phải nằm trọn
    // trong một pattern, nên một message D1 thực tế có tiền tố/hậu tố bổ sung **không**
    // khớp. Test này ghi đúng hành vi đó — xem phần Findings của PR về sự lệch giữa hướng
    // này và comment "tiền tố thông điệp" của implementation.
    expect(isRetryableStorageError(new Error('D1_ERROR: too many requests: (code: 429)'))).toBe(
      false,
    );
    expect(isRetryableStorageError(new Error('failed to connect: connection refused'))).toBe(false);
  });

  it('classifies an unrelated SQL error as permanent (no retry benefit)', () => {
    expect(
      isRetryableStorageError(new Error('UNIQUE constraint failed: push_outbox.outbox_id')),
    ).toBe(false);
    expect(isRetryableStorageError(new Error('no such table: push_deliveries'))).toBe(false);
  });
});
