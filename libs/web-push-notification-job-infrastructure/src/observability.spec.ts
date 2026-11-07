/**
 * Test cho {@link resolveLogLevel} và {@link createLogger}.
 *
 * ⚠️ Vì sao file này **quan sát JSON thật** thay vì spy `console.log`: logger là thứ mà §11
 * yêu cầu "một dòng JSON", và một test khẳng định "đã gọi sink" mà không parse dòng đó thì
 * xanh kể cả khi output là `[object Object]`. `sink` được inject nên các dòng ở đây là **byte
 * thật** mà production sẽ viết ra.
 *
 * ⚠️ Ngưỡng level được kiểm bằng **hiệu ứng quan sát được** (`sink` có dòng hay không), không
 * bằng cách đọc lại hằng `LEVEL_ORDER`.
 */

import { describe, expect, it } from 'vitest';

import type { DeliveryLogFields } from '@ecoma-io/web-push-notification-job-application';

import { createLogger, resolveLogLevel } from './observability';

describe('resolveLogLevel', () => {
  it('falls back to info when LOG_LEVEL is absent', () => {
    expect(resolveLogLevel({})).toBe('info');
  });

  it('falls back to info when LOG_LEVEL is not a string', () => {
    expect(resolveLogLevel({ LOG_LEVEL: 7 })).toBe('info');
  });

  it('falls back to info for an unknown level instead of throwing', () => {
    // ⚠️ Một `LOG_LEVEL` sai là lỗi *quan sát*, không phải lỗi *chính sách* — ném ở đây sẽ làm
    // Worker không log được delivery thay vì chỉ log nhiều/ít hơn.
    expect(resolveLogLevel({ LOG_LEVEL: 'trace' })).toBe('info');
  });

  it('accepts the four documented levels, case-insensitively', () => {
    expect(resolveLogLevel({ LOG_LEVEL: 'debug' })).toBe('debug');
    expect(resolveLogLevel({ LOG_LEVEL: ' WARN ' })).toBe('warn');
    expect(resolveLogLevel({ LOG_LEVEL: 'Error' })).toBe('error');
    expect(resolveLogLevel({ LOG_LEVEL: 'info' })).toBe('info');
  });
});

describe('createLogger', () => {
  const base = { service: 'web-push-notification-job', environment: 'test' };

  function capture(level: 'debug' | 'info' | 'warn' | 'error'): {
    readonly lines: string[];
    readonly logger: ReturnType<typeof createLogger>;
  } {
    const lines: string[] = [];
    const logger = createLogger({
      ...base,
      level,
      sink: (line: string) => lines.push(line),
      now: () => 0,
    });
    return { lines, logger };
  }

  it('writes one JSON object per line with the documented envelope', () => {
    const { lines, logger } = capture('info');
    logger.log('info', 'delivery.delivered', { delivery_id: 'd-1', attempts: 1 });

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(record).toMatchObject({
      // Mốc thời gian cố định nhờ `now: () => 0` — test này kiểm hình dạng, không kiểm đồng hồ.
      ts: '1970-01-01T00:00:00.000Z',
      level: 'info',
      service: 'web-push-notification-job',
      environment: 'test',
      message: 'delivery.delivered',
      delivery_id: 'd-1',
      attempts: 1,
    });
  });

  it('merges fields at the root so a consumer does not need a wrapper key', () => {
    const { lines, logger } = capture('info');
    logger.log('info', 'm', { provider_id: 'web-push-eu' });

    const record = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(record['provider_id']).toBe('web-push-eu');
    expect(record['fields']).toBeUndefined();
  });

  it('drops records below the configured level', () => {
    const { lines, logger } = capture('warn');
    logger.log('debug', 'a');
    logger.log('info', 'b');
    logger.log('warn', 'c');
    logger.log('error', 'd');

    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0] ?? '') as { message: string }).message).toBe('c');
    expect((JSON.parse(lines[1] ?? '') as { message: string }).message).toBe('d');
  });

  it('swallows a sink that throws, because observability is not a serving dependency', () => {
    // ⚠️ Đây là bất biản quan trọng nhất của file: một log hỏng KHÔNG được làm một delivery
    // fail. Sink ném ở mọi mức → logger vẫn trả về bình thường.
    const logger = createLogger({
      ...base,
      level: 'debug',
      sink: () => {
        throw new Error('sink exploded');
      },
    });

    expect(() => {
      logger.log('error', 'delivery.failed', { delivery_id: 'd-1' });
    }).not.toThrow();
  });

  it('swallows fields that cannot be serialized, for the same reason', () => {
    const lines: string[] = [];
    const logger = createLogger({
      ...base,
      level: 'debug',
      sink: (line: string) => lines.push(line),
    });
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    // Circular reference không thể đi qua type scalar của `DeliveryLogFields`; test này ép
    // kiểu để chứng minh hành vi runtime (serialize hỏng → bỏ dòng, không ném) với dữ liệu
    // bất ngờ ngoài contract.
    const hostileFields = circular as unknown as DeliveryLogFields;

    expect(() => {
      logger.log('info', 'm', hostileFields);
    }).not.toThrow();
    expect(lines).toHaveLength(0);
  });

  it('keeps scalar lists intact so a correlation chain stays one value', () => {
    const { lines, logger } = capture('info');
    logger.log('info', 'm', { chain: ['req-1', 'ntf-2', 'dlv-3'] });

    const record = JSON.parse(lines[0] ?? '') as { chain: string[] };
    expect(record.chain).toEqual(['req-1', 'ntf-2', 'dlv-3']);
  });
});
