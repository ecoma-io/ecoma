// PHẢI là import đầu tiên: module side-effect set `PULUMI_ERROR_OUTPUT_STRING`
// trước khi bất kỳ import nào nạp `@pulumi/pulumi` — cơ chế và lý do xem trong
// module đó. Side-effect import CHỦ ĐÍCH (không có gì để gán) — tắt rule cho
// đúng dòng này thay vì set flag ở tầng config cho cả suite.
// oxlint-disable-next-line import/no-unassigned-import
import './pulumi-error-output-string-env.js';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalWorkspace, type Stack } from '@pulumi/pulumi/automation';
import * as pulumi from '@pulumi/pulumi';
import { specialSecretSig } from '@pulumi/pulumi/runtime/rpc';
import * as command from '@pulumi/command';

import { environmentTriggers } from '../../environment-triggers.js';

/**
 * Regression engine-level cho Issue #154: trigger `k=v` của bootstrap được dựng
 * bằng template literal thường (`${k}=${v}`) — với giá trị là `Output`,
 * `Output.toString()` trả chuỗi HẰNG nên entry trơ: credential/verdict đổi
 * không bao giờ kích hoạt rerun. Bản sửa dùng `pulumi.interpolate`.
 *
 * Suite này chạy qua **Pulumi engine thật + `@pulumi/command` 1.2.1 thật**
 * (provider gRPC `pulumi-resource-command` từ plugin cache, Automation API,
 * state backend `file://` cô lập trong tmpdir) — KHÔNG phải static source
 * assertion, và KHÔNG phải mock (`pulumi.runtime.setMocks` không chứng minh
 * được diff/replace của engine). Fixture mô phỏng ĐÚNG shape construction của
 * `deploys/llm-api-deploy/index.ts`: trigger KIỂU 'provision' (secret output
 * trực tiếp — đã hoạt động), 'migrate' (secret output trực tiếp), và bootstrap
 * 'governance'/'marketplace' ĐÃ SỬA (`pulumi.interpolate` trên map
 * environment + exclude key credential + explicit secret trigger).
 *
 * Fixture KHÔNG import `index.ts` (import sẽ execute cả deploy program — module
 * side effect); nó dựng lại shape như `failure-path.spec.ts` của account-deploy
 * đã làm cho Issue #42 — cùng tiền lệ harness.
 *
 * Bằng chứng "command CHẠY THẬT": mỗi script ghi một dòng vào runs-log (đếm số
 * lần execute) và ghi GIÁ TRỊ env nhận được vào marker file — chứng minh
 * command chạy lại VÀ nhận giá trị mới, không chỉ "trigger array đổi".
 *
 * Quy ước chống tự-lộ (như failure-path): sentinel chỉ assert qua
 * `includes()` boolean — không bao giờ in ra terminal; marker file nằm trong
 * tmpdir, xoá sạch ở afterAll.
 */

const PROJECT_NAME = 'issue154_trigger_outputs';

const runId = Math.random().toString(36).slice(2, 10);

/**
 * Credential tổng hợp chứa ký tự đặc biệt (quote, double-quote, backslash,
 * `$`, `;`, backtick) — kiểm thêm rằng kênh environment đưa nguyên giá trị đến
 * tiến trình. KHÔNG BAO GIỜ credential thật; unique mỗi lần chạy.
 */
const syntheticCredential = (name: string): string =>
  `t154-${name}-${runId}-P@ss'Quo"te\\$B4th;\`tick\``;

const credentials = {
  pwProvision: [syntheticCredential('provision-v1'), syntheticCredential('provision-v2')],
  pwGateway: [syntheticCredential('gateway-v1'), syntheticCredential('gateway-v2')],
  pwMarketplace: [syntheticCredential('marketplace-v1'), syntheticCredential('marketplace-v2')],
  upstreamCredential: [syntheticCredential('credential-v1'), syntheticCredential('credential-v2')],
};

const verdicts = [`verdict-v1-${runId}`, `verdict-v2-${runId}`];
const plainCfg = `plain-${runId}`;

/** Chữ ký property "secret" của Pulumi — hằng ổn định, xuất hiện trong state cho giá trị bọc secret. Lấy từ export của SDK pin thay vì hardcode hex: cùng giá trị SDK dùng khi bọc secret, và tránh dính entropy rule `generic-api-key` của gitleaks CI (false positive trên hex dài) — gate CI quét toàn bộ range commit của PR bằng rule mặc định, không có allowlist. */
const SECRET_PROPERTY_SIGNATURE = specialSecretSig;

/**
 * Provider escape `\` khi nhúng giá trị vào Diagnostics, nên kiểm rò rỉ chạy
 * trên cả haystack thô lẫn đã bỏ backslash hai phía (tiền lệ failure-path).
 */
const deBackslash = (s: string): string => s.replaceAll('\\', '');

const allCredentials = Object.values(credentials).flat();
const credentialLeaked = (haystack: string): boolean =>
  allCredentials.some(
    (c) => haystack.includes(c) || deBackslash(haystack).includes(deBackslash(c)),
  );

/** Tất cả credential ở dạng URL-encoded (DATABASE_URL embeds encodeURIComponent(password)). */
const allCredentialVariants = allCredentials.flatMap((c) => [c, encodeURIComponent(c)]);

/** Liệt kê mọi file thường dưới một thư mục (đệ quy) — dùng cho scan state at-rest. */
const listFilesRecursive = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFilesRecursive(full) : [full];
  });

/** Toàn bộ kênh text thu được từ engine (preview/up/destroy + error) — scan rò rỉ cuối suite. */
const engineText: string[] = [];

// ---------------------------------------------------------------------------
// Fixture program — mirror đúng shape construction của deploys/llm-api-deploy.
// ---------------------------------------------------------------------------

/**
 * Dựng script `/bin/sh` cho một command fixture: ghi một dòng vào runs-log
 * (đếm execute) + ghi GIÁ TRỊ env vào marker (chứng minh command nhận giá trị
 * mới qua kênh environment). Giá trị credential chỉ đến qua TÊN biến — script
 * không chứa sentinel nào dưới dạng literal.
 */
function buildFixtureScript(opts: {
  runsLogPath: string;
  markerPath: string;
  envVarNames: readonly string[];
  stdoutCommand?: string;
}): string {
  const markerLine = opts.envVarNames.length
    ? `printf '%s\\n' ${opts.envVarNames.map((n) => `"${n}=$${n}"`).join(' ')} > '${opts.markerPath}'`
    : `: > '${opts.markerPath}'`;
  return [
    '#!/bin/sh',
    `echo run >> '${opts.runsLogPath}'`,
    markerLine,
    ...(opts.stdoutCommand ? [opts.stdoutCommand] : []),
  ].join('\n');
}

/**
 * Fixture program — bốn `command.local.Command` mirror `provision`/`migrate`/
 * bootstrap 8a/8b. Async vì `PulumiFn` của Automation API yêu cầu trả
 * `Promise<void | Record<string, any>>` — hàm sync `() => void` KHÔNG nằm trong
 * hợp đồng type đó (TS2769, đo được).
 */
function fixtureProgram(workDir: string): () => Promise<void> {
  const marker = (name: string): string => path.join(workDir, 'markers', name);
  const runsLog = (name: string): string => path.join(workDir, 'runs', `${name}.log`);

  const provisionScript = buildFixtureScript({
    runsLogPath: runsLog('provision'),
    markerPath: marker('provision'),
    envVarNames: ['PW_PROVISION', 'PW_GATEWAY', 'PW_MARKETPLACE'],
  });
  const migrateScript = buildFixtureScript({
    runsLogPath: runsLog('migrate'),
    markerPath: marker('migrate'),
    envVarNames: ['DATABASE_URL'],
  });
  const governanceScript = buildFixtureScript({
    runsLogPath: runsLog('governance'),
    markerPath: marker('governance'),
    envVarNames: ['DATABASE_URL', 'SEED_VERDICT', 'PLAIN_CFG'],
    // Hợp đồng stdout kiểu 8a: dòng máy đọc duy nhất = verdict (extraction
    // thật của production là `extractEligibilityVerdict` — fixture dùng trim).
    stdoutCommand: 'echo "$SEED_VERDICT"',
  });
  const marketplaceScript = buildFixtureScript({
    runsLogPath: runsLog('marketplace'),
    markerPath: marker('marketplace'),
    envVarNames: [
      'DATABASE_URL',
      'SELLER_ELIGIBILITY_VERDICT',
      'LLM_UPSTREAM_CREDENTIAL_PLAINTEXT',
    ],
  });

  return async () => {
    const conf = new pulumi.Config();
    const pwProvision = conf.requireSecret('pwProvision');
    // pwGateway DÙNG CHUNG cho migrate-shape và governance DATABASE_URL —
    // mirror `migratorUrls.gateway` của production (một password, hai consumer).
    const pwGateway = conf.requireSecret('pwGateway');
    const pwMarketplace = conf.requireSecret('pwMarketplace');
    const upstreamCredential = conf.requireSecret('upstreamCredential');
    const seedVerdict = conf.require('seedVerdict');
    const worktreeRoot = 'fixture-worktree-root';

    const provision = new command.local.Command('provision-shape', {
      create: provisionScript,
      update: provisionScript,
      // Trigger secret-output TRỰC TIẾP (đã hoạt động — không đổi bởi fix).
      triggers: [
        pulumi.secret(pwProvision),
        pulumi.secret(pwGateway),
        pulumi.secret(pwMarketplace),
        worktreeRoot,
      ],
      environment: {
        PW_PROVISION: pwProvision,
        PW_GATEWAY: pwGateway,
        PW_MARKETPLACE: pwMarketplace,
      },
    });

    // Mirror index.ts:250-255 — password percent-encode qua apply trước khi
    // ghép userinfo; apply giữ tính secret nên URL là secret output.
    const gatewayUrl = pulumi.interpolate`postgresql://migrator:${pwGateway.apply((v) => encodeURIComponent(v))}@ecoma-postgres:5432/db-llm-gateway`;
    const marketplaceUrl = pulumi.interpolate`postgresql://migrator:${pwMarketplace.apply((v) => encodeURIComponent(v))}@ecoma-postgres:5432/db-llm-marketplace`;

    const migrate = new command.local.Command(
      'migrate-shape',
      {
        create: migrateScript,
        update: migrateScript,
        triggers: [pulumi.secret(pwGateway), worktreeRoot],
        environment: { DATABASE_URL: gatewayUrl },
      },
      { dependsOn: [provision] },
    );

    const governanceEnvironment: Record<string, pulumi.Output<string> | string> = {
      DATABASE_URL: gatewayUrl,
      SEED_VERDICT: seedVerdict,
      PLAIN_CFG: plainCfg,
    };
    const governance = new command.local.Command(
      'bootstrap-governance-shape',
      {
        create: governanceScript,
        update: governanceScript,
        // PATTERN ĐÃ SỬA (issue #154): k=v qua helper production thật — Output
        // resolve thật, entry từ secret output giữ tính secret.
        triggers: [worktreeRoot, ...environmentTriggers(governanceEnvironment)],
        environment: governanceEnvironment,
      },
      { dependsOn: [migrate] },
    );

    const marketplaceEnvironment: Record<string, pulumi.Output<string> | string> = {
      DATABASE_URL: marketplaceUrl,
      SELLER_ELIGIBILITY_VERDICT: governance.stdout.apply((s) => s.trim()),
      LLM_UPSTREAM_CREDENTIAL_PLAINTEXT: upstreamCredential,
    };
    // `void` (không `return`): PulumiFn yêu cầu Promise<void> — cùng hình với
    // failure-path precedent.
    void new command.local.Command(
      'bootstrap-marketplace-shape',
      {
        create: marketplaceScript,
        update: marketplaceScript,
        triggers: [
          worktreeRoot,
          // Explicit secret trigger (mirror upstreamCredentialPlaintext) —
          // credential bị exclude khỏi map k=v (tránh trùng plaintext).
          upstreamCredential,
          ...environmentTriggers(marketplaceEnvironment, ['LLM_UPSTREAM_CREDENTIAL_PLAINTEXT']),
        ],
        environment: marketplaceEnvironment,
      },
      { dependsOn: [governance] },
    );
  };
}

/** Guard stack: pattern CŨ `${k}=${v}` trên một entry Output — phải NÉM dưới flag. */
function oldPatternProgram(): () => Promise<void> {
  return async () => {
    const conf = new pulumi.Config();
    const pwGateway = conf.requireSecret('pwGateway');
    const url = pulumi.interpolate`postgresql://migrator:${pwGateway.apply((v) => encodeURIComponent(v))}@ecoma-postgres:5432/db-llm-gateway`;
    const env: Record<string, pulumi.Output<string> | string> = {
      DATABASE_URL: url,
      PLAIN_CFG: 'fixture-plain',
    };
    void new command.local.Command('old-pattern-probe', {
      create: 'echo probe',
      // PATTERN CŨ — trong process có flag, dòng dưới ném OutputToStringError
      // ngay lúc dựng trigger (chưa cần engine diff gì cả).
      triggers: ['worktree-root', ...Object.entries(env).map(([k, v]) => `${k}=${v}`)],
      environment: env,
    });
  };
}

async function createFixtureStack(
  workDir: string,
  stackName: string,
  program: () => Promise<void>,
): Promise<Stack> {
  return LocalWorkspace.createOrSelectStack(
    { stackName, projectName: PROJECT_NAME, program },
    {
      workDir,
      envVars: {
        // Backend `file://` cô lập hoàn toàn trong tmpdir — không chạm backend
        // mặc định của máy, không stack thật nào có thể bị chạm tới.
        PULUMI_CONFIG_PASSPHRASE: 'issue154-fixture-passphrase',
        PULUMI_BACKEND_URL: `file://${workDir}/state`,
        PULUMI_SKIP_UPDATE_CHECK: 'true',
        // CI (npm `pulumi` shim) thỉnh thoảng in thêm dòng ngoài stdout khiến
        // Automation API không parse được version — tiền lệ failure-path.
        PULUMI_AUTOMATION_API_SKIP_VERSION_CHECK: 'true',
      },
    },
  );
}

/** Tổng số resource BỊ THAY ĐỔI của một lần up/preview — `same` không tính (op 0 thay đổi). */
const MUTATION_OPS = ['create', 'update', 'delete', 'replace', 'replace_recreated'] as const;

const totalChanges = (resourceChanges: unknown): number => {
  if (!resourceChanges || typeof resourceChanges !== 'object') return 0;
  const record = resourceChanges as Record<string, number>;
  return MUTATION_OPS.reduce((acc, op) => acc + (record[op] ?? 0), 0);
};

const readRuns = (workDir: string, name: string): number =>
  fs
    .readFileSync(path.join(workDir, 'runs', `${name}.log`), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '').length;

describe('bootstrap trigger rotation via real Pulumi engine (issue #154)', () => {
  let workDir: string;
  let fixedStack: Stack;

  beforeAll(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue154-trigger-'));
    fs.writeFileSync(
      path.join(workDir, 'Pulumi.yaml'),
      [
        `name: ${PROJECT_NAME}`,
        'runtime: nodejs',
        'description: Issue #154 trigger interpolation fixture',
        '',
      ].join('\n'),
    );
    // Backend `file://` yêu cầu thư mục state tồn tại sẵn.
    fs.mkdirSync(path.join(workDir, 'state'));
    fs.mkdirSync(path.join(workDir, 'markers'));
    fs.mkdirSync(path.join(workDir, 'runs'));

    fixedStack = await createFixtureStack(workDir, 'fixed', fixtureProgram(workDir));

    // Cấu hình ban đầu: ba credential secret + verdict plain + destructuring
    // không cần — setConfig từng key (namespace mặc định = project name).
    await fixedStack.setConfig('pwProvision', { value: credentials.pwProvision[0], secret: true });
    await fixedStack.setConfig('pwGateway', { value: credentials.pwGateway[0], secret: true });
    await fixedStack.setConfig('pwMarketplace', {
      value: credentials.pwMarketplace[0],
      secret: true,
    });
    await fixedStack.setConfig('upstreamCredential', {
      value: credentials.upstreamCredential[0],
      secret: true,
    });
    await fixedStack.setConfig('seedVerdict', { value: verdicts[0], secret: false });
  }, 300_000);

  afterAll(async () => {
    // Best-effort destroy — stack fixture trong backend file:// riêng, không
    // tài nguyên thật nào bị chạm; command.local.Command không có delete
    // script nên destroy chỉ dọn state.
    try {
      if (fixedStack)
        await fixedStack.destroy({ onOutput: (chunk) => void engineText.push(chunk) });
    } catch {
      // Stack chưa lên resource nào là bình thường.
    }
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('preview and initial deployment execute each command exactly once, with initial values delivered', async () => {
    // Preview trước up (row "Pulumi preview không lộ plaintext" — text được
    // scan ở test leak cuối file). Automation API của SDK 3.274.1 không trả
    // `summary` cho preview (đo thực nghiệm — undefined), nên số liệu assert
    // ở phần `up` bên dưới.
    await fixedStack.preview({ onOutput: (chunk) => void engineText.push(chunk) });

    const up = await fixedStack.up({ onOutput: (chunk) => void engineText.push(chunk) });
    engineText.push(JSON.stringify(up.summary.resourceChanges ?? {}));
    // 4 command + 1 resource root stack (đếm thực nghiệm: root stack được tính
    // vào resourceChanges của lần đầu `up`).
    expect(
      up.summary.resourceChanges?.create,
      'initial up must create the stack + exactly 4 commands',
    ).toBe(5);

    expect(readRuns(workDir, 'provision')).toBe(1);
    expect(readRuns(workDir, 'migrate')).toBe(1);
    expect(readRuns(workDir, 'governance')).toBe(1);
    expect(readRuns(workDir, 'marketplace')).toBe(1);

    // Command CHẠY THẬT nhận đúng giá trị ban đầu (row "nhận env mới, không
    // chỉ trigger đổi") — assert boolean để sentinel không bao giờ in ra.
    const govMarker = fs.readFileSync(path.join(workDir, 'markers', 'governance'), 'utf8');
    expect(
      govMarker.includes(
        `DATABASE_URL=postgresql://migrator:${encodeURIComponent(credentials.pwGateway[0])}`,
      ),
      'governance marker must carry the initial gateway DATABASE_URL',
    ).toBe(true);
    expect(
      govMarker.includes(`SEED_VERDICT=${verdicts[0]}`),
      'governance marker must carry the initial verdict',
    ).toBe(true);

    const mkMarker = fs.readFileSync(path.join(workDir, 'markers', 'marketplace'), 'utf8');
    expect(
      mkMarker.includes(`SELLER_ELIGIBILITY_VERDICT=${verdicts[0]}`),
      'marketplace marker must carry the verdict from governance stdout',
    ).toBe(true);
    expect(
      mkMarker.includes(`LLM_UPSTREAM_CREDENTIAL_PLAINTEXT=${credentials.upstreamCredential[0]}`),
      'marketplace marker must carry the upstream credential via the environment channel',
    ).toBe(true);
  }, 300_000);

  it('unchanged second deployment executes no command again', async () => {
    const before = ['provision', 'migrate', 'governance', 'marketplace'].map((n) =>
      readRuns(workDir, n),
    );
    const up = await fixedStack.up({ onOutput: (chunk) => void engineText.push(chunk) });
    engineText.push(JSON.stringify(up.summary.resourceChanges ?? {}));
    // Message đính kèm op-count JSON (chỉ số liệu, không chứa credential) để
    // chẩn đoán được nếu assert hỏng.
    expect(
      totalChanges(up.summary.resourceChanges),
      `no-op up must change nothing (ops: ${JSON.stringify(up.summary.resourceChanges ?? {})})`,
    ).toBe(0);

    const after = ['provision', 'migrate', 'governance', 'marketplace'].map((n) =>
      readRuns(workDir, n),
    );
    expect(after, 'run counts must be unchanged across a no-op up').toEqual(before);
  }, 300_000);

  it('rotating the gateway migrator credential reruns migrate AND governance (previously inert), not marketplace', async () => {
    await fixedStack.setConfig('pwGateway', { value: credentials.pwGateway[1], secret: true });
    const up = await fixedStack.up({ onOutput: (chunk) => void engineText.push(chunk) });
    engineText.push(JSON.stringify(up.summary.resourceChanges ?? {}));

    expect(
      readRuns(workDir, 'provision'),
      'provision carries all passwords as direct secret triggers',
    ).toBe(2);
    expect(readRuns(workDir, 'migrate'), 'migrate trigger includes the gateway password').toBe(2);
    expect(
      readRuns(workDir, 'governance'),
      'governance DATABASE_URL trigger entry must react to credential rotation (issue #154)',
    ).toBe(2);
    expect(
      readRuns(workDir, 'marketplace'),
      'marketplace must NOT rerun: its own triggers are untouched by a gateway rotation',
    ).toBe(1);

    // Command rerun NHẬN GIÁ TRỊ MỚI (không chỉ "đã chạy lại").
    const govMarker = fs.readFileSync(path.join(workDir, 'markers', 'governance'), 'utf8');
    expect(
      govMarker.includes(
        `DATABASE_URL=postgresql://migrator:${encodeURIComponent(credentials.pwGateway[1])}`,
      ),
      'governance rerun must receive the NEW gateway credential',
    ).toBe(true);
    expect(
      govMarker.includes(credentials.pwGateway[0]),
      'governance marker must no longer contain the OLD credential',
    ).toBe(false);
  }, 300_000);

  it('rotating the marketplace database credential reruns marketplace bootstrap only', async () => {
    await fixedStack.setConfig('pwMarketplace', {
      value: credentials.pwMarketplace[1],
      secret: true,
    });
    const up = await fixedStack.up({ onOutput: (chunk) => void engineText.push(chunk) });
    engineText.push(JSON.stringify(up.summary.resourceChanges ?? {}));

    expect(
      readRuns(workDir, 'marketplace'),
      'marketplace DATABASE_URL trigger entry must react to credential rotation (inert before the fix)',
    ).toBe(2);
    expect(
      readRuns(workDir, 'governance'),
      'governance is untouched by a marketplace rotation',
    ).toBe(2);

    const mkMarker = fs.readFileSync(path.join(workDir, 'markers', 'marketplace'), 'utf8');
    expect(
      mkMarker.includes(
        `DATABASE_URL=postgresql://migrator:${encodeURIComponent(credentials.pwMarketplace[1])}`,
      ),
      'marketplace rerun must receive the NEW marketplace credential',
    ).toBe(true);
  }, 300_000);

  it('rotating the seller eligibility verdict reruns marketplace via the governance stdout chain', async () => {
    await fixedStack.setConfig('seedVerdict', { value: verdicts[1], secret: false });
    const up = await fixedStack.up({ onOutput: (chunk) => void engineText.push(chunk) });
    engineText.push(JSON.stringify(up.summary.resourceChanges ?? {}));

    expect(
      readRuns(workDir, 'governance'),
      'governance SEED_VERDICT trigger entry must react',
    ).toBe(3);
    expect(
      readRuns(workDir, 'marketplace'),
      'marketplace SELLER_ELIGIBILITY_VERDICT (stdout→apply→trigger) must react to the new verdict',
    ).toBe(3);
    expect(readRuns(workDir, 'provision'), 'provision is untouched by a verdict rotation').toBe(3);

    const mkMarker = fs.readFileSync(path.join(workDir, 'markers', 'marketplace'), 'utf8');
    expect(
      mkMarker.includes(`SELLER_ELIGIBILITY_VERDICT=${verdicts[1]}`),
      'marketplace rerun must receive the NEW verdict extracted from governance stdout',
    ).toBe(true);
  }, 300_000);

  it('rotating the upstream credential reruns marketplace via the explicit secret trigger', async () => {
    await fixedStack.setConfig('upstreamCredential', {
      value: credentials.upstreamCredential[1],
      secret: true,
    });
    const up = await fixedStack.up({ onOutput: (chunk) => void engineText.push(chunk) });
    engineText.push(JSON.stringify(up.summary.resourceChanges ?? {}));

    expect(
      readRuns(workDir, 'marketplace'),
      'explicit upstreamCredentialPlaintext trigger (regression guard: already worked before the fix)',
    ).toBe(4);
    expect(readRuns(workDir, 'governance'), 'governance is untouched by an upstream rotation').toBe(
      3,
    );
  }, 300_000);

  it('rotating the provision-only credential reruns provision only — direct secret triggers unchanged', async () => {
    await fixedStack.setConfig('pwProvision', { value: credentials.pwProvision[1], secret: true });
    const up = await fixedStack.up({ onOutput: (chunk) => void engineText.push(chunk) });
    engineText.push(JSON.stringify(up.summary.resourceChanges ?? {}));

    expect(readRuns(workDir, 'provision'), 'provision-only password rotates provision only').toBe(
      4,
    );
    expect(
      readRuns(workDir, 'migrate'),
      'migrate trigger excludes the provision-only password',
    ).toBe(2);
    expect(readRuns(workDir, 'governance'), 'governance is untouched').toBe(3);
    expect(readRuns(workDir, 'marketplace'), 'marketplace is untouched').toBe(4);
  }, 300_000);

  it('state at rest encrypts credentials and secret envelopes mark the trigger entries', async () => {
    // `exportStack()` là view ĐÃ GIẢI MÃ: đo thực nghiệm với SDK/CLI combo này,
    // giá trị secret xuất hiện trong export dưới trường `plaintext` (đã
    // percent-encode) kèm chữ ký secret — export là kênh admin có passphrase,
    // KHÔNG phải oracle "không có plaintext". Nên export chỉ được assert CẤU
    // TRÚC: envelope chữ ký secret phải hiện diện — chứng minh tính secret
    // sống sót qua construction trigger/environment (đúng thuộc tính #154).
    const deployment = await fixedStack.exportStack();
    const json = JSON.stringify(deployment);
    expect(
      json.includes(SECRET_PROPERTY_SIGNATURE),
      'exported state must carry the Pulumi secret envelope for secret trigger/environment values',
    ).toBe(true);

    // State at-rest trên đĩa (backend file://, passphrase secrets provider)
    // phải là ciphertext: không sentinel thô hay URL-encoded nào được phép
    // xuất hiện trong bất kỳ file state nào.
    const stateBytes = listFilesRecursive(path.join(workDir, 'state'))
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');
    for (const variant of allCredentialVariants) {
      expect(
        stateBytes.includes(variant),
        'state at rest must not contain a plaintext (raw or URL-encoded) credential sentinel',
      ).toBe(false);
    }
  }, 300_000);

  it('accumulated preview/up/destroy engine output never exposes a credential', async () => {
    const haystack = engineText.join('\n');
    expect(
      credentialLeaked(haystack),
      'engine text (stdout, diagnostics, diffs) leaked a credential sentinel',
    ).toBe(false);
  }, 300_000);

  it('old pattern throws under PULUMI_ERROR_OUTPUT_STRING instead of producing a placeholder', async () => {
    const guardStack = await createFixtureStack(workDir, 'old-pattern-guard', oldPatternProgram());
    // Guard stack đọc `pwGateway` qua requireSecret — thiếu config là ném
    // trước khi tới dòng pattern cũ, và test sẽ "pass assert threw" vì LÝ DO
    // SAI. Đặt config trước để lỗi duy nhất có thể ném là OutputToStringError.
    await guardStack.setConfig('pwGateway', { value: credentials.pwGateway[0], secret: true });
    let guardErrText = '';
    let threw = false;
    try {
      await guardStack.up({ onOutput: (chunk) => void engineText.push(chunk) });
    } catch (e) {
      threw = true;
      // Automation bọc lỗi program vào CommandError — stderr/stdout của quá
      // trình `pulumi up` mới mang text OutputToStringError. Gom mọi kênh
      // text để assert, KHÔNG in ra (quy ước chống tự-lộ).
      const eAny = e as { name?: string; message?: string; stderr?: unknown; stdout?: unknown };
      const stderr = typeof eAny.stderr === 'string' ? eAny.stderr : '';
      const stdout = typeof eAny.stdout === 'string' ? eAny.stdout : '';
      guardErrText += [eAny.name, eAny.message, stderr, stdout].filter(Boolean).join('\n');
      engineText.push(guardErrText);
    }
    expect(
      threw,
      'old `${k}=${v}` pattern must throw under PULUMI_ERROR_OUTPUT_STRING (flag ineffective or pattern escaped)',
    ).toBe(true);
    expect(
      guardErrText.includes('toString'),
      'the rejection must originate from Output.toString() coercion',
    ).toBe(true);
    expect(
      credentialLeaked(guardErrText),
      'guard-stack error text must not leak a credential',
    ).toBe(false);
  }, 300_000);
});
