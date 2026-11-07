/**
 * Unit test cho `evaluateCanIDeploy` — các nhánh fail-closed trước đây chỉ
 * được chạm qua route integration tests. Matrix hàng đầy đủ delegate
 * `summarizeMatrix` của domain (đã spec ở domain lib); spec ở đây kiểm việc
 * delegate và shape data đi qua.
 */
import { describe, it, expect } from 'vitest';
import { evaluateCanIDeploy } from './can-i-deploy';
import type { MatrixRowData } from '@ecoma-io/pact-broker-api-domain';

const row = (overrides: Partial<MatrixRowData> = {}): MatrixRowData => ({
  consumer: { name: 'svc-c', version: { number: '1.0.0', branch: 'main', tags: [] } },
  provider: { name: 'svc-p', version: { number: '2.0.0', branch: 'main', tags: [] } },
  pact: { sha: 'sha-1', createdAt: '2026-01-01T00:00:00Z' },
  verification: { id: 'ver-1', success: true, verifiedAt: '2026-01-02T00:00:00Z' },
  ...overrides,
});

describe('evaluateCanIDeploy', () => {
  it('fails closed with deployable null when the version exists but has no published pacts', () => {
    const { summary, notices } = evaluateCanIDeploy({
      rows: [],
      pacticipant: 'orphan-svc',
      version: '2.0.0',
      consumerVersionExists: true,
    });
    expect(summary.deployable).toBeNull();
    expect(summary.reason).toBe(
      'Version 2.0.0 of orphan-svc exists but has no ' +
        'pacts published — no verification can exist, deployability is unknown',
    );
    expect(summary.success).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.unknown).toBe(1);
    expect(notices).toEqual([{ type: 'error', text: summary.reason }]);
  });

  it('fails closed with a distinct reason when the selector matches no version or pacticipant', () => {
    const { summary, notices } = evaluateCanIDeploy({
      rows: [],
      pacticipant: 'ghost-svc',
      version: '9.9.9',
      consumerVersionExists: false,
    });
    expect(summary.deployable).toBeNull();
    expect(summary.reason).toBe(
      'There is no version 9.9.9 of ghost-svc ' +
        '(or no pact published for it) — cannot determine deployability',
    );
    expect(summary.unknown).toBe(1);
    expect(notices).toEqual([{ type: 'error', text: summary.reason }]);
  });

  it('keeps the two empty cases distinguishable by the reason text alone', () => {
    const versionExists = evaluateCanIDeploy({
      rows: [],
      pacticipant: 'svc',
      version: '1.0.0',
      consumerVersionExists: true,
    });
    const nothingExists = evaluateCanIDeploy({
      rows: [],
      pacticipant: 'svc',
      version: '1.0.0',
      consumerVersionExists: false,
    });
    expect(versionExists.summary.reason).toContain('exists but has no');
    expect(nothingExists.summary.reason).not.toContain('exists but has no');
    expect(nothingExists.summary.reason).toContain('There is no version 1.0.0 of svc');
  });

  it('delegates non-empty matrices to the domain summarizer (successful verification is deployable)', () => {
    const { summary, notices } = evaluateCanIDeploy({
      rows: [row()],
      pacticipant: 'svc-c',
      version: '1.0.0',
      consumerVersionExists: true,
    });
    expect(summary.deployable).toBe(true);
    expect(summary.success).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.unknown).toBe(0);
    expect(summary.reason).toBe('All required verification results are published and successful');
    expect(notices).toEqual([{ type: 'info', text: summary.reason }]);
  });

  it('delegates a failed verification to the domain summarizer (deployable false)', () => {
    const { summary } = evaluateCanIDeploy({
      rows: [
        row({
          verification: { id: 'ver-2', success: false, verifiedAt: '2026-01-03T00:00:00Z' },
        }),
      ],
      pacticipant: 'svc-c',
      version: '1.0.0',
      consumerVersionExists: true,
    });
    expect(summary.deployable).toBe(false);
    expect(summary.failed).toBe(1);
  });

  it('delegates an unverified pact to the domain summarizer (deployable null)', () => {
    const { summary } = evaluateCanIDeploy({
      rows: [row({ verification: null })],
      pacticipant: 'svc-c',
      version: '1.0.0',
      consumerVersionExists: true,
    });
    expect(summary.deployable).toBeNull();
    expect(summary.unknown).toBe(1);
  });
});
