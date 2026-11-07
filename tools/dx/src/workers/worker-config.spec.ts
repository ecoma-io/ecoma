/**
 * Spec của `worker-config.ts` — sinh config runtime theo worktree + cô lập
 * binding state local.
 *
 * Test dùng temp dirs, KHÔNG đụng repo state thật. Các case hai worktree chỉ
 * kiểm isolation ở mức config + data (persist dir, port) — process-level
 * isolation đã phủ ở `worker-process.spec.ts`.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { worktreeNamespace } from '@ecoma-io/deployment';
import {
  allocateWorkerPort,
  applyLocalD1Migrations,
  applyLocalD1Seeds,
  assertDatabaseNameInConfig,
  generatedConfigDir,
  generateWorkerConfig,
  parseJsonc,
  sanitizedWranglerEnv,
  stripJsonc,
} from './worker-config.js';
import { WORKER_STATE_DIR_NAME } from './worker-process.js';

const cleanup: string[] = [];

function makeWorktreeFixture(name: string): string {
  const dir = join(
    tmpdir(),
    `worker-config-spec-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  cleanup.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

/** Config committed tối thiểu hợp lệ — fixture viết ra đĩa dưới dạng JSONC. */
function writeCommittedConfig(dir: string, overrides: Record<string, unknown> = {}): string {
  const base: Record<string, unknown> = {
    name: 'ecoma-transactional-mail',
    main: 'dist/main.js',
    compatibility_date: '2026-10-05',
    d1_databases: [
      {
        binding: 'mail',
        database_name: 'mail',
      },
    ],
    queues: {
      producers: [{ queue: 'ecoma-mail-delivery', binding: 'QUEUE' }],
    },
  };
  const merged = { ...base, ...overrides };
  const path = join(dir, 'wrangler.jsonc');
  // Viết dưới dạng JSONC có comment để phủ cả đường parse comment.
  const lines: string[] = ['{ // fixture comment'];
  for (const [key, value] of Object.entries(merged)) {
    lines.push(`  "${key}": ${JSON.stringify(value).split('\n').join(' ')},`);
  }
  lines.push('}');
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
  return path;
}

describe('sanitizedWranglerEnv — Hyperdrive local connection string prefix rule', () => {
  /** Snapshot process.env keys liên quan, khôi phục sau mỗi ca — env là global. */
  const ENV_KEYS = [
    'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE',
    'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HD2',
    'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_',
    'SOME_SECRET_TOKEN',
  ];

  afterEach(() => {
    for (const key of ENV_KEYS) {
      // `no-dynamic-delete` chặn `delete process.env[key]` — khởi lại bằng
      // `undefined` là đường hợp lệ của Node: xoá key khỏi `process.env` và
      // không đụng chỉ mục động nào.
      process.env[key] = undefined;
    }
    vi.restoreAllMocks();
  });

  it('passes CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING> through to the wrangler env', () => {
    process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE =
      'postgresql://ecoma_auth_runtime:pw@ecoma-postgres:5432/db-auth?sslmode=disable';

    const env = sanitizedWranglerEnv(tmpdir());

    expect(env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE).toBe(
      'postgresql://ecoma_auth_runtime:pw@ecoma-postgres:5432/db-auth?sslmode=disable',
    );
  });

  it('matches ANY binding suffix — the tail is owned by each app config, not the allowlist', () => {
    process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HD2 = 'postgresql://u:p@h:5432/d';

    const env = sanitizedWranglerEnv(tmpdir());

    expect(env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HD2).toBe('postgresql://u:p@h:5432/d');
  });

  it('drops an empty-valued hyperdrive variable — empty is treated as not-provided (fail-closed boot)', () => {
    process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE = '';

    const env = sanitizedWranglerEnv(tmpdir());

    expect(env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE).toBeUndefined();
  });

  it('still blocks env vars outside the allowlist and the hyperdrive prefix', () => {
    process.env.SOME_SECRET_TOKEN = 'should-not-pass';
    process.env.CLOUDFLARE_HYPERDRIVE_UNRELATED_SUFFIX = 'not-this-prefix';

    const env = sanitizedWranglerEnv(tmpdir());

    expect(env.SOME_SECRET_TOKEN).toBeUndefined();
    expect(env.CLOUDFLARE_HYPERDRIVE_UNRELATED_SUFFIX).toBeUndefined();
  });
});

describe('stripJsonc', () => {
  it('removes line comments and block comments while preserving strings', () => {
    const raw = '{\n  // line\n  "a": "x // not a comment", /* block */ "b": 1,\n}';
    const cleaned = stripJsonc(raw);
    expect(() => JSON.parse(cleaned)).not.toThrow();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    expect(parsed['a']).toBe('x // not a comment');
    expect(parsed['b']).toBe(1);
  });

  it('removes trailing commas before closing braces and brackets', () => {
    const raw = '{"a": [1, 2,], "b": {"c": 1,},}';
    expect(() => JSON.parse(stripJsonc(raw))).not.toThrow();
  });

  it('keeps escaped quotes inside strings intact', () => {
    const raw = '{"a": "he said \\"hi\\"", "b": "back\\\\slash"}';
    const parsed = JSON.parse(stripJsonc(raw)) as Record<string, string>;
    expect(parsed['a']).toBe('he said "hi"');
    expect(parsed['b']).toBe('back\\slash');
  });

  it('drops a trailing comma followed by a comment before the closing brace', () => {
    // Repro thật của OCR high finding: `apps/account/wrangler.jsonc` khai
    // `"binding": "ASSETS",` rồi comment rồi `}` — scan-ahead thuần whitespace
    // coi `/` của comment là ký tự có nghĩa và giữ dấu phẩy → JSON.parse fail.
    const lineVariant = '{\n  "a": "ASSETS",\n  // trailing comment\n}';
    expect(() => JSON.parse(stripJsonc(lineVariant))).not.toThrow();
    const blockVariant = '{"a": 1, /* block comment */}';
    expect(() => JSON.parse(stripJsonc(blockVariant))).not.toThrow();
  });
});

describe('parseJsonc', () => {
  it('parses a committed-style wrangler.jsonc with comments and trailing commas', () => {
    const raw = [
      '{',
      '  // control plane comment',
      '  "name": "ecoma-transactional-mail",',
      '  "d1_databases": [',
      '    {',
      '      "binding": "mail",',
      '      "database_name": "mail",',
      '    },',
      '  ],',
      '}',
    ].join('\n');
    const parsed = parseJsonc(raw) as { name: string; d1_databases: unknown[] };
    expect(parsed.name).toBe('ecoma-transactional-mail');
    expect(parsed.d1_databases).toHaveLength(1);
  });

  it('throws a clear error for malformed JSONC instead of returning garbage', () => {
    expect(() => parseJsonc('{ name: broken')).toThrow(/failed to parse JSONC/u);
  });

  it('fails loud with the specific state for an unterminated block comment', () => {
    // Block comment không đóng nuốt phần còn lại của file — không được fail
    // mô hồ "không parse được JSONC" mà phải báo đúng loại lỗi.
    expect(() => parseJsonc('{"a": 1, /* unterminated')).toThrow(/block comment .*unterminated/u);
  });

  it('fails loud with the specific state for an unterminated string', () => {
    expect(() => parseJsonc('{"a": "unterminated')).toThrow(/string .*unterminated/u);
    // Chuỗi newline escape cuối file — cùng state 'string' ở EOF.
    expect(() => parseJsonc('{"a": "dangling escape \\')).toThrow(/string .*unterminated/u);
  });
});

describe('validateCommittedWranglerConfig (qua generateWorkerConfig)', () => {
  it('rejects a committed config that sets remote: true on a D1 binding', () => {
    const dir = makeWorktreeFixture('remote-d1');
    const configPath = writeCommittedConfig(dir, {
      d1_databases: [{ binding: 'mail', database_name: 'mail', remote: true }],
    });
    expect(() =>
      generateWorkerConfig({ worktreeRoot: dir, committedConfigPath: configPath }),
    ).toThrow(/remote: true/u);
  });

  it('rejects a committed config that sets remote: true anywhere nested (queue producer)', () => {
    const dir = makeWorktreeFixture('remote-queue');
    const configPath = writeCommittedConfig(dir, {
      queues: { producers: [{ queue: 'ecoma-mail-delivery', binding: 'QUEUE', remote: true }] },
    });
    expect(() =>
      generateWorkerConfig({ worktreeRoot: dir, committedConfigPath: configPath }),
    ).toThrow(/remote: true/u);
  });

  it('rejects a committed config that declares account_id', () => {
    const dir = makeWorktreeFixture('account-id');
    const configPath = writeCommittedConfig(dir, { account_id: '0123456789abcdef' });
    expect(() =>
      generateWorkerConfig({ worktreeRoot: dir, committedConfigPath: configPath }),
    ).toThrow(/account_id/u);
  });

  it('rejects a committed config missing name, main or compatibility_date', () => {
    const dir = makeWorktreeFixture('missing-fields');
    for (const key of ['name', 'main', 'compatibility_date']) {
      const obj: Record<string, unknown> = { name: 'x', main: 'y', compatibility_date: 'z' };
      const omitKey = key;
      const without: Record<string, unknown> = {};
      for (const entryKey of Object.keys(obj)) {
        if (entryKey !== omitKey) without[entryKey] = obj[entryKey];
      }
      const path = join(dir, `${key}.jsonc`);
      writeFileSync(path, `${JSON.stringify(without)}\n`, 'utf8');
      expect(() => generateWorkerConfig({ worktreeRoot: dir, committedConfigPath: path })).toThrow(
        new RegExp(key, 'u'),
      );
    }
  });

  it('rejects remote: true passed explicitly to generateWorkerConfig', () => {
    const dir = makeWorktreeFixture('remote-flag');
    const configPath = writeCommittedConfig(dir);
    expect(() =>
      generateWorkerConfig({ worktreeRoot: dir, committedConfigPath: configPath, remote: true }),
    ).toThrow(/remote mode is not allowed/u);
  });

  it('fails closed when the committed config file does not exist', () => {
    const dir = makeWorktreeFixture('missing-config');
    expect(() =>
      generateWorkerConfig({
        worktreeRoot: dir,
        committedConfigPath: join(dir, 'nope.jsonc'),
      }),
    ).toThrow(/does not exist/u);
  });

  it('rejects remote: "true" boolean-like string anywhere in the config', () => {
    const dir = makeWorktreeFixture('remote-string');
    const configPath = writeCommittedConfig(dir, {
      vars: { ENV_FLAG: 'true', remote: 'true' },
    });
    expect(() =>
      generateWorkerConfig({ worktreeRoot: dir, committedConfigPath: configPath }),
    ).toThrow(/remote: true/u);
  });

  it('rejects provisioned resource identifiers (database_id, preview_database_id, hyperdrive id)', () => {
    // `database_id` do hạ tầng cấp — local runtime không được resolve tới
    // resource thật (OCR finding, config thật của apps/account có Hyperdrive id).
    const dir = makeWorktreeFixture('resource-id');
    const configPath = writeCommittedConfig(dir, {
      d1_databases: [{ binding: 'mail', database_name: 'mail', database_id: 'some-uuid-remote' }],
    });
    expect(() =>
      generateWorkerConfig({ worktreeRoot: dir, committedConfigPath: configPath }),
    ).toThrow(/database_id/u);
    const dir2 = makeWorktreeFixture('hyperdrive-id');
    const configPath2 = writeCommittedConfig(dir2, {
      hyperdrive: [{ binding: 'HD', id: 'hyperdrive-uuid' }],
    });
    expect(() =>
      generateWorkerConfig({ worktreeRoot: dir2, committedConfigPath: configPath2 }),
    ).toThrow(/resollute|resource identifier|remote/u);
  });

  it('allows services[].service pointing at a local worker in the same topology', () => {
    // `service` của service binding là tên Worker local (spike §2) — cố ý
    // KHÔNG bị chặn blanket, config thật của transactional-mailer-job dùng nó.
    const dir = makeWorktreeFixture('service-bind');
    const configPath = writeCommittedConfig(dir, {
      services: [{ binding: 'TRANSACTIONAL_MAIL_SERVICE', service: 'ecoma-transactional-mail' }],
    });
    expect(() =>
      generateWorkerConfig({ worktreeRoot: dir, committedConfigPath: configPath }),
    ).not.toThrow();
  });

  it('resolves assets.directory and $schema to absolute paths relative to configDir', () => {
    const dir = makeWorktreeFixture('assets-abs');
    const schemaRelative = '../../node_modules/wrangler/config-schema.json';
    const configPath = writeCommittedConfig(dir, {
      $schema: schemaRelative,
      assets: { directory: '.output/public' },
    });
    const result = generateWorkerConfig({ worktreeRoot: dir, committedConfigPath: configPath });
    const assets = result.config.assets as { directory: string };
    expect(assets.directory).toBe(join(dir, '.output/public'));
    // Kỳ vọng theo đúng ngữ nghĩa resolve của implementation: path tương đối
    // trong committed config được giải theo configDir (thư mục chứa config),
    // giữ nguyên đích mà committed config mô tả.
    expect(result.config.$schema).toBe(resolve(dir, schemaRelative));
  });

  it('rejects an out-of-range or non-integer explicit port', () => {
    const dir = makeWorktreeFixture('port-invalid');
    const configPath = writeCommittedConfig(dir);
    for (const port of [0, 80, 22, 65536, 99999, Number.NaN, 8080.5]) {
      expect(() =>
        generateWorkerConfig({ worktreeRoot: dir, committedConfigPath: configPath, port }),
      ).toThrow(/invalid port/u);
    }
  });
});

describe('generateWorkerConfig', () => {
  it('writes a generated config under <worktreeRoot>/.worker-local-state/generated/', () => {
    const dir = makeWorktreeFixture('write');
    const configPath = writeCommittedConfig(dir);
    const result = generateWorkerConfig({ worktreeRoot: dir, committedConfigPath: configPath });
    const expectedDir = join(dir, WORKER_STATE_DIR_NAME, 'generated');
    expect(result.configPath.startsWith(expectedDir)).toBe(true);
    expect(existsSync(result.configPath)).toBe(true);
    expect(generatedConfigDir(dir)).toBe(expectedDir);
  });

  it('generates config idempotently — second run overwrites the same path with the same content', () => {
    const dir = makeWorktreeFixture('idempotent');
    const configPath = writeCommittedConfig(dir);
    const first = generateWorkerConfig({ worktreeRoot: dir, committedConfigPath: configPath });
    const contentAfterFirst = readFileSync(first.configPath, 'utf8');
    const second = generateWorkerConfig({ worktreeRoot: dir, committedConfigPath: configPath });
    expect(second.configPath).toBe(first.configPath);
    expect(readFileSync(second.configPath, 'utf8')).toBe(contentAfterFirst);
  });

  it('resolves migrations_dir to an absolute path relative to the committed config directory', () => {
    const dir = makeWorktreeFixture('migrations-abs');
    const configPath = writeCommittedConfig(dir, {
      d1_databases: [{ binding: 'mail', database_name: 'mail', migrations_dir: 'migrations' }],
    });
    const result = generateWorkerConfig({ worktreeRoot: dir, committedConfigPath: configPath });
    const db = result.config.d1_databases?.[0] as { migrations_dir?: string };
    expect(db.migrations_dir).toBe(join(dir, 'migrations'));
  });

  it('resolves a relative main to an absolute path relative to the committed config directory', () => {
    // Wrangler resolve `main` theo thư mục chứa config file — generated config
    // nằm ở `<root>/.worker-local-state/generated/`, nên `main` tương đối
    // không được tuyệt đối hoá sẽ trỏ sai chỗ (OCR high finding).
    const dir = makeWorktreeFixture('main-abs');
    const configPath = writeCommittedConfig(dir);
    const result = generateWorkerConfig({ worktreeRoot: dir, committedConfigPath: configPath });
    expect(result.config.main).toBe(join(dir, 'dist/main.js'));
  });

  it('keeps an already-absolute main untouched', () => {
    const dir = makeWorktreeFixture('main-absolute');
    const absolute = join(dir, 'dist/main.js');
    const configPath = writeCommittedConfig(dir, { main: absolute });
    const result = generateWorkerConfig({ worktreeRoot: dir, committedConfigPath: configPath });
    expect(result.config.main).toBe(absolute);
  });

  it('defaults migrations_dir to <configDir>/migrations when the committed config omits it', () => {
    const dir = makeWorktreeFixture('migrations-default');
    const configPath = writeCommittedConfig(dir);
    const result = generateWorkerConfig({ worktreeRoot: dir, committedConfigPath: configPath });
    const db = result.config.d1_databases?.[0] as { migrations_dir?: string };
    expect(db.migrations_dir).toBe(join(dir, 'migrations'));
  });

  it('sets a per-worktree dev port deterministically from namespace and worker name', () => {
    const dir = makeWorktreeFixture('port');
    const configPath = writeCommittedConfig(dir);
    const result = generateWorkerConfig({ worktreeRoot: dir, committedConfigPath: configPath });
    const ns = worktreeNamespace(dir);
    expect(result.config.dev).toEqual({ port: allocateWorkerPort(ns, 'ecoma-transactional-mail') });
  });

  it('keeps committed dev keys other than port (e.g. upstream_protocol for secure cookies)', () => {
    // `dev.upstream_protocol: "https"` (#285) là nguồn của scheme mà workerd
    // thấy (`MF-Original-URL`) — glue của auth ghi `x-forwarded-proto` từ đó
    // và oidc-provider suy `secure` cookie. Generated config GHI ĐÈ `port`
    // nhưng PHẢI giữ nguyên các key `dev` committed còn lại.
    const dir = makeWorktreeFixture('dev-upstream-protocol');
    const configPath = writeCommittedConfig(dir, {
      dev: { port: 4203, upstream_protocol: 'https' },
    });
    const result = generateWorkerConfig({ worktreeRoot: dir, committedConfigPath: configPath });
    const ns = worktreeNamespace(dir);
    expect(result.config.dev).toEqual({
      port: allocateWorkerPort(ns, 'ecoma-transactional-mail'),
      upstream_protocol: 'https',
    });
  });

  it('never leaks remote: true into the generated config', () => {
    const dir = makeWorktreeFixture('no-remote-out');
    const configPath = writeCommittedConfig(dir);
    const result = generateWorkerConfig({ worktreeRoot: dir, committedConfigPath: configPath });
    expect(JSON.stringify(result.config)).not.toMatch(/"remote"\s*:\s*true/u);
  });
});

describe('persist dir theo worktree', () => {
  it('uses .worker-local-state as the persist root inside each worktree', () => {
    const dir = makeWorktreeFixture('persist');
    const configPath = writeCommittedConfig(dir);
    const result = generateWorkerConfig({ worktreeRoot: dir, committedConfigPath: configPath });
    expect(result.persistTo).toBe(join(dir, WORKER_STATE_DIR_NAME));
  });

  it('keeps persistTo identical across workers of the same worktree (shared D1/Queue state)', () => {
    const dir = makeWorktreeFixture('persist-shared');
    const mailConfig = writeCommittedConfig(dir);
    const jobConfig = writeCommittedConfig(dir, {
      name: 'ecoma-transactional-mailer-job',
      d1_databases: [{ binding: 'mail-job', database_name: 'mail-job' }],
      queues: { consumers: [{ queue: 'ecoma-mail-delivery', max_retries: 3 }] },
    });
    const mail = generateWorkerConfig({ worktreeRoot: dir, committedConfigPath: mailConfig });
    const job = generateWorkerConfig({ worktreeRoot: dir, committedConfigPath: jobConfig });
    expect(mail.persistTo).toBe(job.persistTo);
  });
});

describe('two-worktree isolation (config + data level)', () => {
  it('two worktrees generate distinct config paths, distinct ports, distinct persist dirs', () => {
    const dirA = makeWorktreeFixture('iso-a');
    const dirB = makeWorktreeFixture('iso-b');
    const committedA = writeCommittedConfig(dirA);
    const committedB = writeCommittedConfig(dirB);

    const a = generateWorkerConfig({ worktreeRoot: dirA, committedConfigPath: committedA });
    const b = generateWorkerConfig({ worktreeRoot: dirB, committedConfigPath: committedB });

    expect(a.configPath).not.toBe(b.configPath);
    expect(a.persistTo).not.toBe(b.persistTo);
    expect(a.namespace).not.toBe(b.namespace);
    const portA = (a.config.dev as { port?: number }).port;
    const portB = (b.config.dev as { port?: number }).port;
    expect(portA).not.toBe(portB);

    // Generated config của A không nằm trong state dir của B và ngược lại.
    expect(a.configPath.startsWith(join(dirB, WORKER_STATE_DIR_NAME))).toBe(false);
    expect(b.configPath.startsWith(join(dirA, WORKER_STATE_DIR_NAME))).toBe(false);
  });

  it('two worktrees with the same worker name still get distinct ports', () => {
    const dirA = makeWorktreeFixture('same-name-a');
    const dirB = makeWorktreeFixture('same-name-b');
    const committedA = writeCommittedConfig(dirA);
    const committedB = writeCommittedConfig(dirB);
    const a = generateWorkerConfig({ worktreeRoot: dirA, committedConfigPath: committedA });
    const b = generateWorkerConfig({ worktreeRoot: dirB, committedConfigPath: committedB });
    const portA = (a.config.dev as { port?: number }).port as number;
    const portB = (b.config.dev as { port?: number }).port as number;
    expect(portA).not.toBe(portB);
  });
});

describe('applyLocalD1Seeds / applyLocalD1Migrations', () => {
  it('fails closed when remote: true is requested explicitly', () => {
    const dir = makeWorktreeFixture('seeds-remote');
    expect(() =>
      applyLocalD1Seeds({
        configPath: join(dir, 'cfg.jsonc'),
        databaseName: 'mail',
        persistTo: join(dir, 'persist'),
        seedFiles: ['non-empty.sql'],
        remote: true,
      }),
    ).toThrow(/remote mode is not allowed/u);
    expect(() =>
      applyLocalD1Migrations({
        configPath: join(dir, 'cfg.jsonc'),
        databaseName: 'mail',
        persistTo: join(dir, 'persist'),
        remote: true,
      }),
    ).toThrow(/remote mode is not allowed/u);
  });

  it('rejects an empty seedFiles list fail-loud instead of a silent no-op', () => {
    const dir = makeWorktreeFixture('seeds-empty');
    expect(() =>
      applyLocalD1Seeds({
        configPath: join(dir, 'cfg.jsonc'),
        databaseName: 'mail',
        persistTo: join(dir, 'persist'),
        seedFiles: [],
      }),
    ).toThrow(/seedFiles is empty/u);
  });

  it('rejects a flag-smuggling databaseName before building the wrangler argv', () => {
    // OCR security finding: `--remote` trượt qua positional arg của wrangler
    // (yargs parse flag ở mọi vị trí) sẽ đổi đường --local thành remote thật.
    const dir = makeWorktreeFixture('flag-smuggle');
    const configPath = writeCommittedConfig(dir);
    const result = generateWorkerConfig({ worktreeRoot: dir, committedConfigPath: configPath });
    expect(() =>
      applyLocalD1Migrations({
        configPath: result.configPath,
        databaseName: '--remote',
        persistTo: result.persistTo,
      }),
    ).toThrow(/invalid database identifier/u);
    expect(() =>
      applyLocalD1Seeds({
        configPath: result.configPath,
        databaseName: '../evil',
        persistTo: result.persistTo,
        seedFiles: ['some.sql'],
      }),
    ).toThrow(/invalid database identifier/u);
  });

  it('rejects a databaseName that matches no d1_databases binding or database_name', () => {
    // OCR high finding: tên gõ sai (hoặc identifier resource thật) đi thẳng
    // vào subprocess — phải đối chiếu config và fail-closed trước. So khớp
    // trực tiếp qua assertDatabaseNameInConfig, không qua wrangler thật.
    const dir = makeWorktreeFixture('binding-mismatch');
    const configPath = writeCommittedConfig(dir);
    expect(() => assertDatabaseNameInConfig(configPath, 'mail-typo')).toThrow(
      /matches no binding\/database_name/u,
    );
    // Cả `binding` và `database_name` đều được chấp nhận.
    expect(() => assertDatabaseNameInConfig(configPath, 'mail')).not.toThrow();
  });

  it('fails closed when the config file or a seed file is missing', () => {
    const dir = makeWorktreeFixture('seeds-missing');
    // Missing config với seedFiles rỗng giờ bị chặn bởi empty-seed check
    // (fail-loud mới) — missing config vẫn được phủ bởi applyLocalD1Migrations
    // bên dưới và bởi case seedFiles non-empty ở cuối test.
    expect(() =>
      applyLocalD1Seeds({
        configPath: join(dir, 'absent.jsonc'),
        databaseName: 'mail',
        persistTo: join(dir, 'persist'),
        seedFiles: [],
      }),
    ).toThrow(/seedFiles is empty/u);
    expect(() =>
      applyLocalD1Migrations({
        configPath: join(dir, 'absent.jsonc'),
        databaseName: 'mail',
        persistTo: join(dir, 'persist'),
      }),
    ).toThrow(/does not exist/u);
    const configPath = writeCommittedConfig(dir);
    const result = generateWorkerConfig({ worktreeRoot: dir, committedConfigPath: configPath });
    expect(() =>
      applyLocalD1Seeds({
        configPath: result.configPath,
        databaseName: 'mail',
        persistTo: result.persistTo,
        seedFiles: [join(dir, 'absent-seed.sql')],
      }),
    ).toThrow(/seed file does not exist/u);
  });
});
