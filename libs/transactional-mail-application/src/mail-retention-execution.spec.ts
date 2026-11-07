import { describe, expect, it } from 'vitest';

import type {
  MailContentRetentionCandidate,
  MailRetentionQueries,
  MailStaleNonTerminalCandidate,
} from './mail-retention-queries';
import { runRetentionCycle } from './mail-retention-execution';
import type { MailRetentionAlert, RunRetentionCycleConfig } from './mail-retention-execution';

/**
 * Test của chu kỳ retention với fake port.
 *
 * Trọng tâm là **thứ tự và ranh giới của hai nhánh**: redact chỉ chạm terminal quá hạn, còn
 * alert thì bao cả `blocked` và **không** xoá gì. Cả hai đều là quyết định của application
 * layer, đọc được bằng cách quan sát lệnh gọi.
 */

const NOW = 1_800_000_000_000;
const CONTENT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const STALE_TTL_MS = 60 * 60 * 1_000;

function makeCandidate(
  overrides: Partial<MailContentRetentionCandidate> = {},
): MailContentRetentionCandidate {
  return {
    messageId: 'msg_01',
    deliveryId: 'dlv_01',
    terminalAtMs: NOW - CONTENT_TTL_MS - 1_000,
    ...overrides,
  };
}

function makeStale(
  overrides: Partial<MailStaleNonTerminalCandidate> = {},
): MailStaleNonTerminalCandidate {
  return {
    messageId: 'msg_01',
    deliveryId: 'dlv_01',
    status: 'queued',
    updatedAtMs: NOW - STALE_TTL_MS - 1_000,
    ...overrides,
  };
}

/** Harness: hai list method + `redactContent`, và call log của cả ba. */
function makeHarness(
  candidates: readonly MailContentRetentionCandidate[],
  stale: readonly MailStaleNonTerminalCandidate[],
  redactedCount = candidates.length,
): {
  readonly deps: {
    readonly retention: MailRetentionQueries;
    readonly logAlert: (e: MailRetentionAlert) => void;
  };
  readonly alerts: MailRetentionAlert[];
  readonly contentScans: { terminalBeforeMs: number; limit: number }[];
  readonly staleScans: { updatedBeforeMs: number; limit: number }[];
  readonly redactions: { messageIds: readonly string[]; nowMs: number }[];
} {
  const alerts: MailRetentionAlert[] = [];
  const contentScans: { terminalBeforeMs: number; limit: number }[] = [];
  const staleScans: { updatedBeforeMs: number; limit: number }[] = [];
  const redactions: { messageIds: readonly string[]; nowMs: number }[] = [];

  const retention: MailRetentionQueries = {
    listContentRetentionCandidates: (input) => {
      contentScans.push(input);
      return Promise.resolve(candidates);
    },
    listStaleNonTerminalMessages: (input) => {
      staleScans.push(input);
      return Promise.resolve(stale);
    },
    redactContent: (input) => {
      redactions.push(input);
      return Promise.resolve({ redacted: redactedCount });
    },
  };

  return {
    deps: {
      retention,
      logAlert: (event: MailRetentionAlert) => {
        alerts.push(event);
      },
    },
    alerts,
    contentScans,
    staleScans,
    redactions,
  };
}

function makeConfig(overrides: Partial<RunRetentionCycleConfig> = {}): RunRetentionCycleConfig {
  return {
    contentOlderThanMs: CONTENT_TTL_MS,
    staleOlderThanMs: STALE_TTL_MS,
    batchLimit: 50,
    nowMs: NOW,
    ...overrides,
  };
}

describe('runRetentionCycle — content redaction', () => {
  it('redacts exactly the overdue terminal candidates the port listed', async () => {
    const harness = makeHarness(
      [
        makeCandidate({ messageId: 'msg_01', deliveryId: 'dlv_01' }),
        makeCandidate({ messageId: 'msg_02', deliveryId: 'dlv_02' }),
      ],
      [],
    );

    const result = await runRetentionCycle(harness.deps, makeConfig());

    expect(result).toEqual({ redacted: 2, staleAlerts: 0 });
    // Danh sách ứng viên đến từ `listContentRetentionCandidates` — reconciler không tự dò id
    // bằng một câu riêng, nên không có đường nào redact nhầm một row ngoài lô.
    expect(harness.redactions).toEqual([{ messageIds: ['msg_01', 'msg_02'], nowMs: NOW }]);
  });

  it('scans content by the retention window, not by the stale window', async () => {
    const harness = makeHarness([makeCandidate()], [makeStale()]);

    await runRetentionCycle(harness.deps, makeConfig());

    // Hai retention tách biệt (FR-007): một là xoá content của thư đã xong, một là cảnh báo
    // về một delivery còn dở. Trộn hai ngưỡng sẽ hoặc xoá sớm, hoặc giữ content vô thời hạn.
    expect(harness.contentScans).toEqual([{ terminalBeforeMs: NOW - CONTENT_TTL_MS, limit: 50 }]);
    expect(harness.staleScans).toEqual([{ updatedBeforeMs: NOW - STALE_TTL_MS, limit: 50 }]);
  });

  it('reports the count the port returned rather than the candidate list length', async () => {
    // Một row vừa terminal giữa lúc đọc và lúc ghi bị guard `terminal_at < nowMs` chặn, nên
    // số thực sự redact nhỏ hơn số ứng viên — và `redacted` phải nói đúng số đó.
    const harness = makeHarness(
      [makeCandidate({ messageId: 'msg_01' }), makeCandidate({ messageId: 'msg_02' })],
      [],
      1,
    );

    const result = await runRetentionCycle(harness.deps, makeConfig());

    expect(result.redacted).toBe(1);
    expect(harness.alerts).toEqual([{ event: 'retention-content-redacted', count: 1 }]);
  });

  it('stays silent when nothing was actually redacted', async () => {
    const harness = makeHarness([makeCandidate()], [], 0);

    const result = await runRetentionCycle(harness.deps, makeConfig());

    expect(result.redacted).toBe(0);
    // `count = 0` sau một danh sách ứng viên khác 0 là chuyện bình thường (race terminal).
    // Alert mỗi chu kỳ vì thế sẽ biến thành tiếng ồn mất hết giá trị cảnh báo.
    expect(harness.alerts).toEqual([]);
  });

  it('does not call redactContent at all when there is no candidate', async () => {
    // `WHERE id IN (…)` với danh sách rỗng là một câu không có nghĩa; no-op là hợp đồng mà
    // port đã cam kết, và nó giữ chu kỳ không chạm database cho một nhịp trống.
    const harness = makeHarness([], [makeStale()]);

    const result = await runRetentionCycle(harness.deps, makeConfig());

    expect(result.redacted).toBe(0);
    expect(harness.redactions).toEqual([]);
  });

  it('never passes content of any kind into the retention write', async () => {
    const harness = makeHarness([makeCandidate()], []);

    await runRetentionCycle(harness.deps, makeConfig());

    // Input của `redactContent` chỉ mang **id** và mốc thời gian: recipient và nội dung
    // render vẫn nằm trong database và chỉ bị xoá bởi chính câu `UPDATE` của port.
    expect(Object.keys(harness.redactions[0] ?? {}).toSorted()).toEqual(['messageIds', 'nowMs']);
  });
});

describe('runRetentionCycle — stale non-terminal deliveries alert only', () => {
  it('alerts once per stale candidate with its status and age', async () => {
    const harness = makeHarness(
      [],
      [
        makeStale({ messageId: 'msg_01', deliveryId: 'dlv_01', status: 'queued' }),
        makeStale({ messageId: 'msg_02', deliveryId: 'dlv_02', status: 'blocked' }),
      ],
    );

    const result = await runRetentionCycle(harness.deps, makeConfig());

    expect(result).toEqual({ redacted: 0, staleAlerts: 2 });
    expect(harness.alerts).toEqual([
      {
        event: 'retention-stale-non-terminal',
        deliveryId: 'dlv_01',
        status: 'queued',
        ageMs: STALE_TTL_MS + 1_000,
      },
      {
        event: 'retention-stale-non-terminal',
        deliveryId: 'dlv_02',
        status: 'blocked',
        ageMs: STALE_TTL_MS + 1_000,
      },
    ]);
  });

  it('alerts a blocked delivery without redacting it', async () => {
    // `blocked` là non-terminal nên `terminal_at IS NULL` và không bao giờ lọt vào danh sách
    // content. Giữ content của một delivery còn redrive được là hành động đúng; điều kiện
    // "không được im lặng" được đáp ứng bằng alert, không phải bằng xoá.
    const harness = makeHarness([], [makeStale({ status: 'blocked' })]);

    const result = await runRetentionCycle(harness.deps, makeConfig());

    expect(result).toEqual({ redacted: 0, staleAlerts: 1 });
    expect(harness.redactions).toEqual([]);
    expect(harness.alerts).toHaveLength(1);
  });

  it('carries no subject, body or recipient in any alert', async () => {
    const harness = makeHarness([makeCandidate()], [makeStale()]);

    await runRetentionCycle(harness.deps, makeConfig());

    // NFR-001: log chỉ mang field whitelist. `retention-content-redacted` mang **số lượng**,
    // và alert stale mang delivery_id + status + age — không có content nào.
    for (const alert of harness.alerts) {
      expect(Object.keys(alert).toSorted()).not.toContain('recipient');
      expect(Object.keys(alert).toSorted()).not.toContain('subjectRendered');
      expect(JSON.stringify(alert)).not.toContain('victim@example.test');
    }
    expect(harness.alerts[0]).toEqual({ event: 'retention-content-redacted', count: 1 });
  });
});

describe('runRetentionCycle — an empty cycle changes nothing', () => {
  it('is a pure no-op with no candidate on either side', async () => {
    const harness = makeHarness([], []);

    const result = await runRetentionCycle(harness.deps, makeConfig());

    expect(result).toEqual({ redacted: 0, staleAlerts: 0 });
    expect(harness.alerts).toEqual([]);
    expect(harness.redactions).toEqual([]);
    // Cả hai nhánh vẫn **quét** — chu kỳ không bỏ qua việc kiểm tra chỉ vì lần trước không có gì.
    expect(harness.contentScans).toHaveLength(1);
    expect(harness.staleScans).toHaveLength(1);
  });

  it('redacts before it alerts, so a just-finished message is handled in this same cycle', async () => {
    const order: string[] = [];

    await runRetentionCycle(
      {
        retention: {
          listContentRetentionCandidates: () => {
            order.push('scan-content');
            return Promise.resolve([makeCandidate()]);
          },
          listStaleNonTerminalMessages: () => {
            order.push('scan-stale');
            return Promise.resolve([makeStale()]);
          },
          redactContent: () => {
            order.push('redact');
            return Promise.resolve({ redacted: 1 });
          },
        },
        logAlert: (event) => {
          order.push(`alert-${event.event}`);
        },
      },
      makeConfig(),
    );

    // Alert redaction phát **ngay sau** lần ghi của nó (nó là kết quả của lô redact), rồi mới
    // sang nhánh alert stale — nên một message vừa kết thúc được xử lý content ngay trong
    // chính chu kỳ đó, trước khi ta sang việc khác.
    expect(order).toEqual([
      'scan-content',
      'redact',
      'alert-retention-content-redacted',
      'scan-stale',
      'alert-retention-stale-non-terminal',
    ]);
  });

  it('honours the batch limit of the run on both scans', async () => {
    const harness = makeHarness([], []);

    await runRetentionCycle(harness.deps, makeConfig({ batchLimit: 10 }));

    expect(harness.contentScans[0]?.limit).toBe(10);
    expect(harness.staleScans[0]?.limit).toBe(10);
  });
});
