import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ROOT_DIR } from '../../utils.js';

const LANE_PROJECTS = [
  'platform-deploy',
  'home-deploy',
  'backoffice-deploy',
  'account-deploy',
  'auth-deploy',
  'pact-broker-api-deploy',
  'pact-broker-app-deploy',
  'transactional-mail-deploy',
  'push-notification-deploy',
  'staff-access-deploy',
  'remote-cache-deploy',
] as const;

/** Mọi project trong `deploys/` phải thuộc một trong hai loại: lane project (có local lane) hoặc job deploy (chỉ build image). */
const JOB_ONLY_PROJECTS = [
  'transactional-mailer-job-deploy',
  'web-push-notification-job-deploy',
] as const;

function packageJson(project: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(ROOT_DIR, 'deploys', project, 'package.json'), 'utf8'),
  ) as Record<string, unknown>;
}

function nxTargets(project: string): Record<string, Record<string, unknown>> {
  const pkg = packageJson(project);
  const nx = pkg['nx'] as { tags?: string[]; targets?: Record<string, Record<string, unknown>> };
  expect(nx['tags'], `${project} must be tagged type:deployment`).toContain('type:deployment');
  return nx['targets'] ?? {};
}

function readEntry(project: string): string {
  return readFileSync(join(ROOT_DIR, 'deploys', project, 'local.ts'), 'utf8');
}

describe('local lane colocated entry contract', () => {
  it('every tagged deployment project has a local.ts entry and local-up/local-down targets (fail-closed on new lanes)', () => {
    // Ghim CẤU TRÚC: project `tag:type:deployment` mà thiếu entry/target local là
    // lỗi contract — lane mới phải được thêm đầy đủ, không được nửa vời.
    const deploysDir = join(ROOT_DIR, 'deploys');
    const allProjects = readdirSync(deploysDir).filter((name) =>
      existsSync(join(deploysDir, name, 'package.json')),
    );
    const laneProjects = allProjects.filter(
      (project) => !(JOB_ONLY_PROJECTS as readonly string[]).includes(project),
    );
    expect(new Set(laneProjects)).toEqual(new Set(LANE_PROJECTS));
    for (const project of laneProjects) {
      expect(
        existsSync(join(deploysDir, project, 'local.ts')),
        `${project} must have a colocated local.ts entry`,
      ).toBe(true);
      const targets = nxTargets(project);
      expect(targets['local-up'], `${project} must declare a local-up target`).toBeDefined();
      expect(targets['local-down'], `${project} must declare a local-down target`).toBeDefined();
    }
  });

  it('every local-up runs the colocated entry, not a DX command', () => {
    // Entry colocated là biên duy nhất — `npx tsx local.ts up` từ cwd project.
    // Trỏ về lệnh DX đã xoá (`pnpm dx local-deploy`) hoặc bất kỳ command DX
    // nào khác là hồi quy kiến trúc; đường E2E hợp lệ là `nx affected -t
    // system-test -c local` (CI tự kéo `local-up` qua `dependsOn` của suite).
    const commands = LANE_PROJECTS.map((project) => {
      const target = nxTargets(project)['local-up'] as {
        options?: { command?: string; cwd?: string };
        configurations?: Record<string, unknown>;
      };
      return {
        project,
        command: target.options?.command,
        cwd: target.options?.cwd,
        configurations: target.configurations,
      };
    });
    expect(commands).toEqual(
      LANE_PROJECTS.map((project) => ({
        project,
        command: 'npx tsx local.ts up',
        cwd: `deploys/${project}`,
        configurations: expect.objectContaining({ local: {} }),
      })),
    );
  });

  it('every local-down runs the colocated entry with no dependsOn (teardown needs no global ordering)', () => {
    // Hợp đồng down: entry colocated + KHÔNG `dependsOn` — mỗi project tự xoá
    // resource của mình trong namespace của worktree, không có teardown
    // orchestrator và không có cạnh chỉ-tạo-thứ-tự giữa các project.
    const violations: string[] = [];
    for (const project of LANE_PROJECTS) {
      const target = nxTargets(project)['local-down'] as {
        options?: { command?: string; cwd?: string };
        configurations?: Record<string, unknown>;
        dependsOn?: { target?: string }[];
      };
      if (target.options?.command !== 'npx tsx local.ts down') {
        violations.push(`${project}: local-down must run the colocated down entry`);
      }
      if (target.options?.cwd !== `deploys/${project}`) {
        violations.push(`${project}: local-down must run from the project directory`);
      }
      if ((target.dependsOn ?? []).length !== 0) {
        violations.push(
          `${project}: local-down must declare no dependsOn (teardown needs no global ordering; found ${(
            target.dependsOn ?? []
          )
            .map((d) => d.target ?? '?')
            .join(', ')})`,
        );
      }
    }
    expect(violations, 'local-down contract').toEqual([]);
  });

  it('entries never call DX commands — grep the colocated local.ts sources', () => {
    // Contract "entry không gọi lệnh DX": kiểm theo nguồn, không phải theo intent.
    // `local-status`/`local-cleanup` là lệnh DX hợp lệ trong *output* (thông báo
    // remediation), không phải lệnh được entry invoke.
    const forbidden = /['"](?:pnpm +dx|tools\/dx)[ '"]/u;
    for (const project of LANE_PROJECTS) {
      const source = readEntry(project);
      expect(forbidden.test(source), `${project} local.ts must not invoke DX commands`).toBe(false);
    }
  });

  it('no deploy source imports tools/dx — the ownership boundary has no exception left', () => {
    // PR #424 xoá nốt ngoại lệ `deploys/* → tools/dx`: helper/contract dùng
    // chung chỉ được đi qua `@ecoma-io/deployment` (libs/deployment). Import
    // nguồn dx (`tools/dx/src/...`, `@ecoma-io/dx`) từ bất kỳ file nào của
    // deploy unit là hồi quy kiến trúc — kể cả qua oxlint-disable cũ. Fail
    // -closed: quét TOÀN bộ `deploys/`, không chỉ entry lane.
    const forbidden = /from\s+['"](?:tools\/dx|@ecoma-io\/dx)/u;
    const offenders: string[] = [];
    const scan = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const stat = statSync(path);
        if (stat.isDirectory()) {
          if (name === 'node_modules' || name === 'bin') continue;
          scan(path);
          continue;
        }
        if (!name.endsWith('.ts') && !name.endsWith('.mjs')) continue;
        const source = readFileSync(path, 'utf8');
        if (forbidden.test(source)) offenders.push(path);
      }
    };
    scan(join(ROOT_DIR, 'deploys'));
    expect(offenders).toEqual([]);
  });

  it('no orphan lease machinery remains — LANE_LEASE_ENV and assertLaneLease are gone from the codebase', () => {
    // Lease assertion từng là cơ chế fencing của orchestrator đã xoá; sự tồn tại
    // của nó giờ chỉ là dead code gây hiểu nhầm. Fail-closed: tái xuất hiện là đỏ.
    const forbidden = /LANE_LEASE_ENV|assertLaneLease|ECOMA_LANE_LEASE/u;
    const offenders: string[] = [];
    const scan = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const stat = statSync(path);
        if (stat.isDirectory()) {
          scan(path);
          continue;
        }
        if (!name.endsWith('.ts') || name.endsWith('.spec.ts') || name.endsWith('.d.ts')) continue;
        const source = readFileSync(path, 'utf8');
        if (forbidden.test(source)) offenders.push(path);
      }
    };
    scan(join(ROOT_DIR, 'tools', 'dx', 'src'));
    scan(join(ROOT_DIR, 'deploys'));
    expect(offenders).toEqual([]);
  });
});

describe('shared entry infrastructure', () => {
  it('no lifecycle entry or shared module acquires the global lane lock (PR #424 decision)', () => {
    // Khóa lane `.ecoma-lane.lock` đã bị XOÁ hoàn toàn khỏi lifecycle (PR #424):
    // serialization thật của cùng một stack Pulumi là state lock của chính
    // Pulumi, hai stack khác nhau độc lập — khóa toàn cục chỉ còn là serialization
    // giả giữa các project độc lập. Fail-closed: tái xuất hiện API khóa lane ở
    // bất kỳ đâu trong lifecycle là đỏ (worker runtime giữ `safeUnlinkIfSame`
    // riêng trong worker-process.ts — không phải API khóa lane).
    const forbidden = /acquireLaneLock|stealLaneLock|withLaneLock|LANE_LOCK_FILE_NAME/u;
    const offenders: string[] = [];
    const scan = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const stat = statSync(path);
        if (stat.isDirectory()) {
          scan(path);
          continue;
        }
        if (!name.endsWith('.ts') || name.endsWith('.spec.ts') || name.endsWith('.d.ts')) continue;
        const source = readFileSync(path, 'utf8');
        if (forbidden.test(source)) offenders.push(path);
      }
    };
    scan(join(ROOT_DIR, 'tools', 'dx', 'src'));
    scan(join(ROOT_DIR, 'deploys'));
    expect(offenders).toEqual([]);
  });

  it('deletes the platform PostgreSQL volume unconditionally on down (no opt-out flag)', () => {
    // Volume deletion là hành vi MẶC ĐỊNH của down — cờ opt-in cũ
    // `--remove-data` đã bị xoá hoàn toàn và không được thay bằng cờ/config
    // tương đương. Fail-closed theo nguồn: tái xuất hiện chuỗi cờ trong entry
    // (parsing, tham số, tài liệu runtime) là đỏ.
    const source = readEntry('platform-deploy');
    expect(source).not.toContain('--remove-data');
    expect(source).not.toContain('removeData');
  });

  it('every long-running container owns its readiness via wait:true (DX never polls Docker health)', () => {
    // Readiness thuộc resource Pulumi, không thuộc DX: provider chờ healthcheck
    // Docker chuyển `healthy` trước khi Container báo thành công, nên `pulumi up`
    // xanh là bằng chứng serving. Ghim theo nguồn: MỌI `new docker.Container`
    // long-running trong `deploys/*/index.ts` phải khai `wait: true` kèm
    // `waitTimeout` — container init/one-shot (`rm: true`, `mustRun: false`)
    // được miễn vì chúng không có healthcheck và Pulumi chỉ chờ chúng thoát.
    // Tái xuất hiện health polling trong DX (`docker inspect`health, budget/poll
    // loop) là đỏ — entry không còn biết Docker health tồn tại.
    const offenders: string[] = [];
    for (const project of LANE_PROJECTS) {
      const source = readFileSync(join(ROOT_DIR, 'deploys', project, 'index.ts'), 'utf8');
      for (const block of source.split('new docker.Container(').slice(1)) {
        const isOneShot = /rm:\s*true/u.test(block);
        const hasWait = /wait:\s*true/u.test(block);
        const hasWaitTimeout = /waitTimeout:\s*\d+/u.test(block);
        if (isOneShot) {
          // One-shot init: `wait` là lỗi provider (không healthcheck) — cấm cả hai.
          if (hasWait || hasWaitTimeout) offenders.push(`${project}: one-shot container sets wait`);
          continue;
        }
        if (!hasWait) offenders.push(`${project}: long-running container misses wait:true`);
        if (!hasWaitTimeout)
          offenders.push(`${project}: long-running container misses waitTimeout`);
      }
    }
    expect(offenders).toEqual([]);
    const entrySources = LANE_PROJECTS.map((project) => readEntry(project));
    expect(
      entrySources.some((source) => /docker\s+inspect|Health\.Status|health gate/u.test(source)),
      'lane entries must not inspect Docker health themselves',
    ).toBe(false);
  });

  it('every E2E suite gate retries the shared cold-start status window (404/502/503/504)', () => {
    // Cửa sổ cold-start của Traefik trả 404/502/503/504 (503 = upstream chưa có,
    // không body JSON). Suite backoffice phân biệt 503 CỦA APP (body Nitro
    // "authorization unavailable" — fail tức thời ở nhánh riêng trước khi chạm
    // set) nên set 503-retry của nó không nuốt fail-closed của app; thiếu 503
    // trong set là đỏ router cold-start ngay khi Traefik còn đang lên.
    for (const suite of [
      'home-public-e2e',
      'identity-oidc-e2e',
      'identity-login-e2e',
      'backoffice-access-control-e2e',
    ]) {
      const source = readFileSync(
        join(ROOT_DIR, 'system-tests', 'e2e', suite, 'global-setup.ts'),
        'utf8',
      );
      const match = /RETRYABLE_STATUSES = new Set\(\[([^\]]+)\]\)/u.exec(source);
      expect(match, `${suite} must declare RETRYABLE_STATUSES`).not.toBeNull();
      const statuses = match?.[1]?.split(',').map((s) => Number(s.trim())) ?? [];
      expect(statuses, `${suite} cold-start window must include 404/502/503/504`).toEqual(
        expect.arrayContaining([404, 502, 503, 504]),
      );
    }
  });
});
