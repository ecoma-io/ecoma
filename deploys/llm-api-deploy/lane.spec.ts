/**
 * Unit test của module THUẦN TÚY lane E2E (`lane-invocation.ts` — builder argv
 * Docker + parser stdout ghi nhận; entry `lane.ts` tự chạy `main()` lúc load
 * nên spec chỉ import được module này, cùng hình `superadmin-resolver.spec`).
 * Mọi assertion về credential đi kèm FENCE: argv/script của builder không bao
 * giờ chứa GIÁ TRỊ, chỉ mang TÊN biến pass-through; message lỗi của parser
 * không bao giờ ghép raw output (chính nó là secret).
 *
 * Skip-guard (đối chứng skip-converged): hợp đồng "skip CHỈ khi stdout ghi
 * nhận còn plaintext VÀ probe chỉ đọc còn thấy row api_keys active của tenant
 * consumer" được chấm trên bộ ba thuần (`shouldSkipLaneUp`,
 * `consumerApiKeyRowProbeArgs`, `activeConsumerApiKeyRowCount`); dây nối trong
 * entry (`up()` gọi probe TRƯỚC khi skip) không import được nên được ghim theo
 * NGUỒN — cùng tiền lệ `wic-state-init.spec.ts` ghim `index.ts`. Ghim nguồn
 * KHÔNG chứng minh hành vi runtime lúc chạy thật: điều đó thuộc `test-lane-up`
 * trên lane local, không phải spec này.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  CONSUMER_HANDOFF_LINE_PREFIX,
  CONSUMER_TENANT_ID,
  MOCK_BIND_HOST,
  MOCK_KIND_SEGMENT,
  MOCK_UPSTREAM_PORT,
  activeConsumerApiKeyRowCount,
  buildLaneStateLine,
  buildMockContainerInvocation,
  buildMockHealthcheckCommand,
  buildMockWaiterInvocation,
  consumerApiKeyRowProbeArgs,
  extractConsumerApiKeyRecordedStdout,
  hasConsumerApiKeyLine,
  mockContainerName,
  mockUpstreamBaseUrl,
  mockUpstreamEndpointUrl,
  shouldSkipLaneUp,
} from './lane-invocation.js';

/** Giá trị header giả chỉ dùng trong test — không phải credential thật. */
const AUTH_HEADER = 'Bearer sk-test-lane-upstream-credential';
const NS = 'w000000000001';

describe('mockContainerName', () => {
  it('composes the ecoma-<ns>-<kind> name with the mock kind segment', () => {
    expect(mockContainerName(NS)).toBe(`ecoma-${NS}-${MOCK_KIND_SEGMENT}`);
  });

  it('rejects a namespace that is not a Docker-safe name', () => {
    expect(() => mockContainerName('W_UPPER')).toThrow(/invalid namespace/u);
    expect(() => mockContainerName('')).toThrow(/invalid namespace/u);
    expect(() => mockContainerName('has space')).toThrow(/invalid namespace/u);
  });
});

describe('mockUpstreamBaseUrl', () => {
  it('points at the mock container DNS name on the internal mock port', () => {
    expect(mockUpstreamBaseUrl(NS)).toBe(
      `http://ecoma-${NS}-${MOCK_KIND_SEGMENT}:${MOCK_UPSTREAM_PORT}`,
    );
  });
});

describe('mockUpstreamEndpointUrl', () => {
  it('carries the chat completions path the worker POSTs verbatim', () => {
    // Worker serving dùng endpoint URL đã đăng ký THẲNG (không ghép path —
    // `chat-completions.ts` của `apps/llm-api`), nên giá trị config lane phải
    // mang sẵn `/v1/chat/completions`, không phải root mock.
    expect(mockUpstreamEndpointUrl(NS)).toBe(`${mockUpstreamBaseUrl(NS)}/v1/chat/completions`);
  });
});

describe('buildMockHealthcheckCommand', () => {
  it('probes /v1/models on the mock port reading the header from the container env', () => {
    const command = buildMockHealthcheckCommand();
    expect(command).toContain(`http://127.0.0.1:${MOCK_UPSTREAM_PORT}/v1/models`);
    expect(command).toContain('process.env.MOCK_UPSTREAM_EXPECTED_AUTHORIZATION');
  });
});

describe('buildMockContainerInvocation', () => {
  const invocation = buildMockContainerInvocation({
    namespace: NS,
    networkName: 'ecoma-platform-network',
    worktreeRoot: '/worktrees/drum',
    expectedAuthorization: AUTH_HEADER,
  });

  it('starts a detached named container on the platform network', () => {
    expect(invocation.args[0]).toBe('run');
    expect(invocation.args).toContain('-d');
    const nameIndex = invocation.args.indexOf('--name');
    expect(invocation.args[nameIndex + 1]).toBe(mockContainerName(NS));
    const netIndex = invocation.args.indexOf('--network');
    expect(invocation.args[netIndex + 1]).toBe('ecoma-platform-network');
  });

  it('mounts the repo read-only with the workspace node_modules on top', () => {
    expect(invocation.args).toContain('/worktrees/drum:/repo:ro');
    expect(invocation.args).toContain('/worktrees/drum/node_modules:/repo/node_modules');
    const workdirIndex = invocation.args.indexOf('-w');
    expect(invocation.args[workdirIndex + 1]).toBe('/repo');
  });

  it('runs the pinned node image with the mock entrypoint of the repo tree', () => {
    const imageIndex = invocation.args.findIndex((arg) =>
      arg.startsWith('node:24-bookworm-slim@sha256:'),
    );
    expect(imageIndex).toBeGreaterThan(0);
    expect(invocation.args.slice(imageIndex + 1)).toEqual([
      'npx',
      'tsx',
      'tools/llm-upstream-mock/src/main.ts',
    ]);
  });

  it('passes the non-secret mock envs inline so the argv documents the mode', () => {
    expect(invocation.args).toContain(`MOCK_UPSTREAM_PORT=${MOCK_UPSTREAM_PORT}`);
    expect(invocation.args).toContain(`MOCK_UPSTREAM_HOST=${MOCK_BIND_HOST}`);
    expect(MOCK_BIND_HOST).toBe('0.0.0.0');
  });

  it('carries the authorization value ONLY in the docker CLI process env, never argv', () => {
    const envNameIndex = invocation.args.indexOf('MOCK_UPSTREAM_EXPECTED_AUTHORIZATION');
    // `-e TÊN` name-only: phần tử SAU tên là flag/label khác, không phải `=giá trị`.
    expect(envNameIndex).toBeGreaterThan(0);
    expect(invocation.args[envNameIndex - 1]).toBe('-e');
    expect(invocation.args[envNameIndex + 1]).not.toContain('=');
    // Fence: giá trị header không xuất hiện trong argv dưới bất kỳ hình nào.
    expect(invocation.args.join(' ')).not.toContain(AUTH_HEADER);
    expect(invocation.env['MOCK_UPSTREAM_EXPECTED_AUTHORIZATION']).toBe(AUTH_HEADER);
  });

  it('attaches the four ownership labels of the worktree', () => {
    const labels = invocation.args.filter((arg, index) => invocation.args[index - 1] === '--label');
    expect(labels).toHaveLength(4);
    expect(labels.some((label) => label.startsWith('io.ecoma.managed-by='))).toBe(true);
    expect(labels).toContain('io.ecoma.worktree-path=/worktrees/drum');
    expect(labels).toContain(`io.ecoma.worktree-id=${NS}`);
    expect(labels.some((label) => label.startsWith('io.ecoma.deployment='))).toBe(true);
  });

  it('configures the healthcheck without leaking the authorization value into argv', () => {
    const cmdIndex = invocation.args.indexOf('--health-cmd');
    const healthCmd = invocation.args[cmdIndex + 1];
    expect(healthCmd).toBe(buildMockHealthcheckCommand());
    expect(healthCmd).not.toContain(AUTH_HEADER);
    expect(invocation.args).toContain('--health-interval=10s');
    expect(invocation.args).toContain('--health-retries=30');
    expect(invocation.args).toContain('--health-start-period=60s');
  });
});

describe('buildMockWaiterInvocation', () => {
  const invocation = buildMockWaiterInvocation({
    networkName: 'ecoma-platform-network',
    mockUrl: mockUpstreamBaseUrl(NS),
    budgetMs: 60_000,
    expectedAuthorization: AUTH_HEADER,
  });

  it('runs one ephemeral probe container inside the network', () => {
    expect(invocation.args).toContain('--rm');
    const netIndex = invocation.args.indexOf('--network');
    expect(invocation.args[netIndex + 1]).toBe('ecoma-platform-network');
    expect(invocation.args).toContain('node');
    expect(invocation.args).toContain('-e');
  });

  it('retries against the mock models route with the header passed by env', () => {
    const script = invocation.args[invocation.args.lastIndexOf('-e') + 1];
    expect(script).toContain(mockUpstreamBaseUrl(NS));
    expect(script).toContain('60000');
    expect(script).toContain('process.env.MOCK_AUTH');
    // Fence: giá trị header không nằm trong script (argv của node -e).
    expect(script).not.toContain(AUTH_HEADER);
    expect(invocation.args.join(' ')).not.toContain(AUTH_HEADER);
    expect(invocation.env['MOCK_AUTH']).toBe(AUTH_HEADER);
  });
});

describe('hasConsumerApiKeyLine', () => {
  it('detects the machine line among bootstrap runner stdout', () => {
    const recorded = [
      '[bootstrap] step 9a committed',
      `${CONSUMER_HANDOFF_LINE_PREFIX}sk-test-lane-consumer-key`,
      'CONSUMER_TENANT_RESULT={"outcome":"created"}',
      '',
    ].join('\n');
    expect(hasConsumerApiKeyLine(recorded)).toBe(true);
  });

  it('returns false when only the result envelope line exists (converged rerun)', () => {
    expect(hasConsumerApiKeyLine('CONSUMER_TENANT_RESULT={"outcome":"no-op"}\n')).toBe(false);
  });
});

describe('extractConsumerApiKeyRecordedStdout', () => {
  it('extracts the plaintext from the recorded create-run stdout', () => {
    const recorded = [
      `${CONSUMER_HANDOFF_LINE_PREFIX}sk-test-lane-consumer-key`,
      'CONSUMER_TENANT_RESULT={"outcome":"created"}',
      '',
    ].join('\n');
    expect(extractConsumerApiKeyRecordedStdout(recorded)).toBe('sk-test-lane-consumer-key');
  });

  it('rejects an empty value after the prefix', () => {
    expect(() => extractConsumerApiKeyRecordedStdout(`${CONSUMER_HANDOFF_LINE_PREFIX}\n`)).toThrow(
      /empty ECOMA_CONSUMER_API_KEY/u,
    );
  });

  it('fails without echoing any part of the raw secret output into the message', () => {
    // Raw stdout là secret: message lỗi phải mô tả hợp đồng, không ghép nội dung.
    const recorded = 'CONSUMER_TENANT_RESULT={"detail":{"marker":"SECRET-MARKER-VALUE"}}\n';
    let message = '';
    try {
      extractConsumerApiKeyRecordedStdout(recorded);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('no ECOMA_CONSUMER_API_KEY line');
    expect(message).not.toContain('SECRET-MARKER-VALUE');
    expect(message).not.toContain(recorded);
  });
});

describe('buildLaneStateLine', () => {
  it('prints one LANE_STATE= line whose JSON round-trips every field', () => {
    const line = buildLaneStateLine({
      namespace: NS,
      networkName: 'ecoma-platform-network',
      tenantOwnerSub: 'auth0|66f super admin',
      consumerApiKey: 'sk-test-lane-consumer-key',
    });
    expect(line.startsWith('LANE_STATE=')).toBe(true);
    expect(line).not.toContain('\n');
    const parsed: unknown = JSON.parse(line.slice('LANE_STATE='.length));
    expect(parsed).toEqual({
      namespace: NS,
      networkName: 'ecoma-platform-network',
      tenantOwnerSub: 'auth0|66f super admin',
      consumerApiKey: 'sk-test-lane-consumer-key',
    });
  });
});

describe('shouldSkipLaneUp', () => {
  /** Stdout ghi nhận kiểu create-run: mang dòng plaintext (giá trị giả). */
  const recordedWithKey = `${CONSUMER_HANDOFF_LINE_PREFIX}sk-test-lane-consumer-key\n`;

  it('honors the skip when the recorded stdout carries the key line and an active row exists', () => {
    expect(shouldSkipLaneUp(recordedWithKey, 1)).toBe(true);
  });

  it('does NOT honor the skip when the recorded stdout carries the key line but no active row exists', () => {
    // Nghịch "output còn — row mất" (database reset ngoài vòng đời lane): phải
    // đi đường converge đầy đủ để bootstrap phát key mới, không skip trên key
    // đã chết.
    expect(shouldSkipLaneUp(recordedWithKey, 0)).toBe(false);
  });

  it('does not skip on the first run before any recorded stdout exists', () => {
    expect(shouldSkipLaneUp(undefined, 1)).toBe(false);
    expect(shouldSkipLaneUp(undefined, 0)).toBe(false);
  });

  it('does not skip when the recorded stdout lost the plaintext line (replaced stdout)', () => {
    // Stdout ghi nhận bị thay mà không còn plaintext (runner hội tụ `existing`)
    // — skip phải không diễn ra kể cả khi row vẫn sống.
    expect(shouldSkipLaneUp('CONSUMER_TENANT_RESULT={"outcome":"no-op"}\n', 1)).toBe(false);
  });
});

describe('consumerApiKeyRowProbeArgs', () => {
  const args = consumerApiKeyRowProbeArgs(NS);

  it('execs a read-only psql probe inside the namespace postgres container', () => {
    expect(args[0]).toBe('exec');
    expect(args[1]).toBe(`ecoma-${NS}-postgres`);
    expect(args.slice(2)).toEqual([
      'psql',
      '-U',
      'ecoma_local',
      '-d',
      'db-llm-gateway',
      '-tAc',
      expect.stringContaining('SELECT count(*)'),
    ]);
  });

  it('counts active api_keys rows of the canonical consumer tenant only', () => {
    const sql = args[args.indexOf('-tAc') + 1];
    expect(sql).toBe(
      `SELECT count(*) FROM llm_gateway.api_keys WHERE tenant_id = '${CONSUMER_TENANT_ID}' AND revoked_at IS NULL`,
    );
    expect(sql).not.toMatch(/INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE/iu);
  });

  it('rejects a namespace that is not a Docker-safe name', () => {
    expect(() => consumerApiKeyRowProbeArgs('W_UPPER')).toThrow(/invalid namespace/u);
  });
});

describe('activeConsumerApiKeyRowCount', () => {
  it('parses the single count cell of a psql -tAc output', () => {
    expect(activeConsumerApiKeyRowCount('1\n')).toBe(1);
    expect(activeConsumerApiKeyRowCount('0\n')).toBe(0);
    expect(activeConsumerApiKeyRowCount('42')).toBe(42);
  });

  it('fails closed on a non-integer cell without echoing the raw output', () => {
    // Ô count không phải secret nhưng luật parser là MỘT: message mô tả hợp
    // đồng, không ghép raw output (raw có thể là stderr chen vào stdout).
    let message = '';
    try {
      activeConsumerApiKeyRowCount('not-a-count SECRET-MARKER-VALUE\n');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('non-integer');
    expect(message).not.toContain('SECRET-MARKER-VALUE');
  });
});

describe('lane entry source contract (skip guard wiring)', () => {
  // Entry `lane.ts` tự chạy `main()` lúc load nên spec không import được — dây
  // nối guard được ghim theo NGUỒN (tiền lệ `wic-state-init.spec.ts`). Marker
  // fail tường minh khi biến mất thay vì để assert sau chạy trên chuỗi rỗng.
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, 'lane.ts'), 'utf8');

  function sliceBetween(startMarker: string, endMarker: string): string {
    const start = source.indexOf(startMarker);
    expect(start, `source marker not found: ${startMarker}`).toBeGreaterThanOrEqual(0);
    const end = source.indexOf(endMarker, start);
    expect(end, `source marker not found: ${endMarker}`).toBeGreaterThan(start);
    return source.slice(start, end + endMarker.length);
  }

  it('runs the api key row probe before honoring the skip in up()', () => {
    // Đoạn skip-converged của `up()`: từ lần đọc output ĐẦU TIÊN tới `return 0`
    // ĐẦU TIÊN (đường skip). `state()` cũng chứa marker mở nhưng `indexOf`
    // chạm phần `up()` trước — thứ tự khai báo của file ghim điều đó.
    const skipBlock = sliceBetween(
      'const recorded = readConsumerApiKeyStackOutput(foundation);',
      'return 0;',
    );
    expect(skipBlock).toContain('hasConsumerApiKeyLine(recorded)');
    expect(skipBlock).toContain('probeConsumerApiKeyRowCount(foundation)');
    expect(skipBlock).toContain('shouldSkipLaneUp(recorded, activeRowCount)');
  });
});
