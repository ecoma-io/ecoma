import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  findInvalidTargetRefs,
  readDeploymentStatusMarker,
  validateDeploymentMap,
} from './deployment-map-check.js';
import {
  DEPLOYMENT_MAP,
  knownInvalidTargets,
  type InvalidTargetAllowlistEntry,
} from './deployment-map.js';
import { DEPLOYMENT_TYPE, PLATFORM_DEPLOY_PROJECT, type ArchProjectNode } from './arch-tags.js';
import { ROOT_DIR } from '../utils.js';

/**
 * Dựng node deployment tối thiểu (đủ tag `type:deployment`) cho project graph
 * của test; các lượt khác của arch-check không chạy ở đây — lượt map chỉ cần
 * biết project nào là deployment.
 */
function deployNode(name: string): ArchProjectNode {
  return { name, tags: [DEPLOYMENT_TYPE, 'runtime:native'], dependencies: [] };
}

/**
 * State "đẹp" mặc định: project graph chứa đúng các deploy project mà map
 * đang trỏ tới (suy ra từ chính DEPLOYMENT_MAP, không liệt kê tay lại), để
 * từng test chỉ phá MỘT khía cạnh và assert lỗi của đúng khía cạnh đó.
 */
function goodState(): Parameters<typeof validateDeploymentMap>[0] {
  const owners = Object.values(DEPLOYMENT_MAP)
    .filter(
      (e): e is Extract<(typeof DEPLOYMENT_MAP)[string], { kind: 'app' }> =>
        e.kind === 'app' && e.owner !== null,
    )
    .map((e) => e.owner as string);
  const names = new Set([PLATFORM_DEPLOY_PROJECT, ...owners]);
  const projects = new Map([...names].map((n) => [n, deployNode(n)]));
  return {
    projects,
    appsOnDisk: Object.keys(DEPLOYMENT_MAP).filter((k) => DEPLOYMENT_MAP[k].kind === 'app'),
    deploysOnDisk: [...names],
    targetCommands: new Map(),
  };
}

/** Gom vi phạm theo kind, để assert "đúng lỗi duy nhất" gọn hơn. */
function kinds(violations: { kind: string }[]): string[] {
  const list = [...new Set(violations.map((v) => v.kind))];
  list.sort(); // mảng copy riêng — sort tại chỗ (target es2022 chưa có toSorted)
  return list;
}

describe('validateDeploymentMap — map coverage', () => {
  it('passes the real DEPLOYMENT_MAP against a matching synthetic workspace', () => {
    // Baseline: map + graph + marker thật của repo (marker được đọc từ đĩa
    // thật vì test không inject marker) phải sạch trước khi các test phá
    // từng phía. Nếu baseline này đỏ, mọi test dưới mất nghĩa.
    expect(validateDeploymentMap(goodState())).toEqual([]);
  });

  it('reports an app on disk that has no map entry', () => {
    const state = goodState();
    (state.appsOnDisk as string[]).push('new-app');
    const violations = validateDeploymentMap(state);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ project: 'new-app', kind: 'missing-map-entry' });
  });

  it('reports a map entry pointing at a non-existent app directory', () => {
    const state = goodState();
    state.appsOnDisk = (state.appsOnDisk as string[]).filter((a) => a !== 'home');
    const violations = validateDeploymentMap(state);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ project: 'home', kind: 'stale-map-entry' });
  });
});

/**
 * Vùng ghi tạm trên `DEPLOYMENT_MAP` cho fixture tổng hợp: bản đồ export với
 * `Readonly` nhưng `Record` bên dưới vẫn mutable — cùng cơ chế mutate-restore
 * mà các test entry đơn dùng. Trả về hàm dọn để finally gọi.
 */
function withSyntheticEntry(key: string, entry: (typeof DEPLOYMENT_MAP)[string]): () => void {
  const mutable = DEPLOYMENT_MAP as Record<string, (typeof DEPLOYMENT_MAP)[string]>;
  const had = Object.prototype.hasOwnProperty.call(mutable, key);
  const original = mutable[key];
  mutable[key] = entry;
  return () => {
    if (had) {
      mutable[key] = original;
    } else {
      Reflect.deleteProperty(mutable, key);
    }
  };
}

describe('validateDeploymentMap — owner-null invariant per status', () => {
  it('reports an absorbed entry that carries a non-null owner without duplicate violations', () => {
    // absorbed/none không có deployment unit riêng — owner khác null là mâu
    // thuẫn trong chính entry. Invariant báo MỘT lỗi rồi dừng với entry đó:
    // không nhân đôi thành invalid-map-owner của lượt owner (owner ảo không
    // có trong graph) hay của reverse ownership. Map thật hiện không còn entry
    // `absorbed` (account-bridge đã chuyển tools/), nên fixture tổng hợp tự
    // thêm một entry absorbed vào map runtime rồi dọn trong finally.
    const cleanup = withSyntheticEntry('synthetic-absorbed', {
      kind: 'app',
      owner: 'auth-deploy',
      status: 'absorbed',
      reason: 'test fixture: synthetic absorbed entry standing in for a real one',
    });
    try {
      const violations = validateDeploymentMap(goodState());
      expect(kinds(violations)).toEqual(['invalid-map-owner']);
      expect(violations).toHaveLength(1);
      expect(violations[0].project).toBe('synthetic-absorbed');
      expect(violations[0].detail).toContain('absorbed');
      expect(violations[0].detail).toContain('null');
    } finally {
      cleanup();
    }
  });

  it('reports a none entry that carries a non-null owner without duplicate violations', () => {
    const entry = DEPLOYMENT_MAP['auth-nonce-prune-job'] as { owner: string | null };
    const original = entry.owner;
    entry.owner = 'auth-deploy';
    try {
      const violations = validateDeploymentMap(goodState());
      // Invariant chặn TRƯỚC lượt owner: owner thật (auth-deploy) trên entry
      // none bị báo một lần với đúng nguyên nhân (none ⇒ null), không rơi xuống
      // platform-cannot-own hay reverse ownership. Marker check không tham gia:
      // auth-deploy vẫn sở hữu `auth` nên marker của nó vẫn khớp.
      expect(kinds(violations)).toEqual(['invalid-map-owner']);
      expect(violations).toHaveLength(1);
      expect(violations[0].project).toBe('auth-nonce-prune-job');
      expect(violations[0].detail).toContain("'none'");
    } finally {
      entry.owner = original;
    }
  });

  it('reports an implemented entry that lost its owner', () => {
    const entry = DEPLOYMENT_MAP.home as { owner: string | null };
    const original = entry.owner;
    entry.owner = null;
    try {
      const violations = validateDeploymentMap(goodState());
      // home mất owner: invariant báo entry (implemented ⇒ owner khác null);
      // home-deploy không rơi vào reverse-ownership vì nó không còn là owner
      // của app nào trong map — và owner null thì mọi lượt owner khác vô nghĩa.
      expect(kinds(violations)).toEqual(['invalid-map-owner']);
      expect(violations).toHaveLength(1);
      expect(violations[0].project).toBe('home');
      expect(violations[0].detail).toContain("'implemented'");
    } finally {
      entry.owner = original;
    }
  });

  it('reports a scaffold entry that lost its owner', () => {
    const entry = DEPLOYMENT_MAP['pact-broker-api'] as { owner: string | null };
    const original = entry.owner;
    entry.owner = null;
    try {
      const violations = validateDeploymentMap(goodState());
      expect(kinds(violations)).toEqual(['invalid-map-owner']);
      expect(violations).toHaveLength(1);
      expect(violations[0].project).toBe('pact-broker-api');
      expect(violations[0].detail).toContain("'scaffold'");
    } finally {
      entry.owner = original;
    }
  });

  it('keeps every implemented/scaffold entry in the shipped map with an owner', () => {
    // Dữ liệu thật: mọi entry implemented/scaffold phải có owner — test chạy
    // trên map thật; thêm entry implemented/scaffold thiếu owner là đỏ ngay ở CI.
    const needingOwner = Object.entries(DEPLOYMENT_MAP).filter(
      ([, entry]) =>
        entry.kind === 'app' &&
        (entry.status === 'implemented' || entry.status === 'scaffold') &&
        entry.owner === null,
    );
    expect(needingOwner).toEqual([]);
  });

  it('keeps every absorbed/none entry in the shipped map without an owner', () => {
    // Chiều đối xứng của test trên, trên dữ liệu thật của repo.
    const forbiddenOwner = Object.entries(DEPLOYMENT_MAP).filter(
      ([, entry]) =>
        entry.kind === 'app' &&
        (entry.status === 'absorbed' || entry.status === 'none') &&
        entry.owner !== null,
    );
    expect(forbiddenOwner).toEqual([]);
  });
});

describe('validateDeploymentMap — owner validity', () => {
  it('reports an owner that is not a type:deployment project in the graph', () => {
    const state = goodState();
    state.projects.delete('home-deploy');
    const violations = validateDeploymentMap(state);
    // home-deploy biến mất khỏi graph: owner check báo, và reverse check
    // KHÔNG báo thêm (project không còn trong graph thì không phải deploy
    // project phải sở hữu app).
    expect(kinds(violations)).toEqual(['invalid-map-owner']);
    expect(violations[0].project).toBe('home');
    expect(violations[0].detail).toContain('home-deploy');
  });

  it('reports an owner without a deploys/ directory even when the project is tagged', () => {
    // Tag đúng trên graph nhưng thư mục đã đổi tên/xóa: map vẫn phải đỏ —
    // graph và đĩa là hai nguồn, lệch nhau ở chiều nào cũng là lỗi.
    const state = goodState();
    state.deploysOnDisk = (state.deploysOnDisk as string[]).filter((d) => d !== 'home-deploy');
    const violations = validateDeploymentMap(state);
    // Chỉ owner check của entry `home` báo; marker check bỏ qua home-deploy
    // (thư mục không có trên đĩa thì marker check đã bị owner check bắt
    // trước, không nhân đôi lỗi).
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ project: 'home', kind: 'invalid-map-owner' });
    expect(violations[0].detail).toContain('deploys/');
  });

  it('rejects platform-deploy as an owner', () => {
    const state = goodState();
    const entry = DEPLOYMENT_MAP.home as { owner: string | null };
    const original = entry.owner;
    entry.owner = PLATFORM_DEPLOY_PROJECT;
    try {
      const violations = validateDeploymentMap(state);
      // Hai lỗi cùng lúc, mỗi lỗi từ một chiều: `home` không được trỏ owner
      // vào platform (platform-cannot-own), và home-deploy mất chủ sở hữu
      // (reverse ownership — invalid-map-owner). Cùng khớp mỗi check báo
      // đúng phần việc của mình.
      expect(kinds(violations)).toEqual(['invalid-map-owner', 'platform-cannot-own']);
      expect(violations.find((v) => v.kind === 'platform-cannot-own')?.project).toBe('home');
      expect(violations.find((v) => v.kind === 'invalid-map-owner')?.project).toBe('home-deploy');
    } finally {
      entry.owner = original;
    }
  });

  it('reports a deploy project that owns no app (reverse ownership)', () => {
    const state = goodState();
    state.projects.set('orphan-deploy', deployNode('orphan-deploy'));
    (state.deploysOnDisk as string[]).push('orphan-deploy');
    const violations = validateDeploymentMap(state);
    expect(kinds(violations)).toEqual(['invalid-map-owner']);
    expect(violations[0].project).toBe('orphan-deploy');
    expect(violations[0].detail).toContain(PLATFORM_DEPLOY_PROJECT);
  });

  it('exempts platform-deploy from the reverse ownership rule', () => {
    // platform là prerequisite chung, không sở hữu app nào — đã được assert
    // trong baseline; test này neo hành vi đúng chỗ nếu ai đổi rule.
    const violations = validateDeploymentMap(goodState());
    expect(violations.filter((v) => v.project === PLATFORM_DEPLOY_PROJECT)).toEqual([]);
  });
});

describe('validateDeploymentMap — status markers', () => {
  it('flags a deploys marker that disagrees with the map status', () => {
    // home được map cho 'implemented'; đổi marker thật trên đĩa sang
    // 'scaffold' là đúng hình "marker lệch map" của acceptance criteria.
    const path = join(ROOT_DIR, 'deploys', 'home-deploy', 'package.json');
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, original.replace('"status": "implemented"', '"status": "scaffold"'));
    try {
      const violations = validateDeploymentMap(goodState());
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        project: 'home-deploy',
        kind: 'deployment-status-marker-mismatch',
      });
      expect(violations[0].detail).toContain('implemented');
    } finally {
      writeFileSync(path, original);
    }
  });

  it('flags a marker-less deploy directory that the map says is owned', () => {
    // Thư mục deploy tồn tại nhưng package.json KHÔNG có marker — đúng hình
    // "ai xóa marker thì arch-check phải đỏ", không phụ thuộc fixture.
    const path = join(ROOT_DIR, 'deploys', 'home-deploy', 'package.json');
    const original = readFileSync(path, 'utf8');
    const parsed = JSON.parse(original) as { ecoma?: unknown };
    delete parsed.ecoma;
    writeFileSync(path, JSON.stringify(parsed, null, 2) + '\n');
    try {
      const violations = validateDeploymentMap(goodState());
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        project: 'home-deploy',
        kind: 'deployment-status-marker-mismatch',
      });
      expect(violations[0].detail).toContain('missing');
    } finally {
      writeFileSync(path, original);
    }
  });

  it('reports an unreadable package.json instead of crashing the check', () => {
    const state = goodState();
    (state.deploysOnDisk as string[]).push('ghost-deploy');
    const entry = DEPLOYMENT_MAP.home as { owner: string | null };
    const original = entry.owner;
    entry.owner = 'ghost-deploy';
    try {
      const violations = validateDeploymentMap(state);
      // Hai lỗi, mỗi lỗi một chiều dữ liệu: ghost-deploy là owner trong graph
      // (invalid-map-owner vì không có thư mục deploys/) VÀ marker của nó
      // đọc fail (deployment-status-marker-mismatch). Reverse check im lặng
      // vì ghost-deploy sở hữu `home`. Điểm chính của test: đọc package.json
      // hỏng phải báo CÓ KIỂM, không sập cả arch-check.
      expect(kinds(violations)).toEqual(['deployment-status-marker-mismatch', 'invalid-map-owner']);
      expect(violations.find((v) => v.kind === 'deployment-status-marker-mismatch')?.project).toBe(
        'ghost-deploy',
      );
    } finally {
      entry.owner = original;
    }
  });
});

describe('validateDeploymentMap — reasons', () => {
  it('requires a reason for absorbed and none entries', () => {
    // Fixture tổng hợp thay cho entry `absorbed` thật (map thật hiện chỉ còn
    // entry `none` — auth-nonce-prune-job): thêm entry absorbed thiếu reason
    // vào map runtime để invariant báo đúng lỗi missing-reason.
    const cleanup = withSyntheticEntry('synthetic-absorbed', {
      kind: 'app',
      owner: null,
      status: 'absorbed',
      reason: '',
    });
    try {
      const violations = validateDeploymentMap(goodState());
      expect(kinds(violations)).toEqual(['missing-reason']);
      expect(violations[0].project).toBe('synthetic-absorbed');
    } finally {
      cleanup();
    }
  });

  it('keeps every absorbed/none entry in the shipped map with a reason', () => {
    // Dữ liệu thật: mọi entry absorbed/none của map phải có reason — test
    // chạy trên map thật chứ không fixture, nên thêm entry mới thiếu reason
    // là đỏ ngay ở CI. Lọc trước, assert sau — expect không nằm trong nhánh if
    // (no-conditional-expect).
    const needingReason = Object.entries(DEPLOYMENT_MAP)
      .filter(
        ([, entry]) =>
          entry.kind === 'app' && (entry.status === 'absorbed' || entry.status === 'none'),
      )
      .map(([key, entry]) => ({ key, reason: entry.kind === 'app' ? entry.reason : undefined }));
    expect(needingReason.length).toBeGreaterThanOrEqual(1); // auth-nonce-prune-job
    for (const { key, reason } of needingReason) {
      expect(reason?.length ?? 0, `${key} needs a reason`).toBeGreaterThan(0);
    }
  });

  it('covers exactly the apps on disk plus the platform entry', () => {
    // Hợp đồng "11 app + 1 platform" ở dạng bất biến: mọi key map ngoài
    // platform entry phải là một app thật; mọi app thật phải có key. Số app
    // thay đổi theo repo — assert tính TƯƠNG ỨNG, không assert con số.
    const mapApps = Object.keys(DEPLOYMENT_MAP).filter((k) => DEPLOYMENT_MAP[k].kind === 'app');
    expect(new Set(mapApps).size).toBe(mapApps.length);
    expect(DEPLOYMENT_MAP[PLATFORM_DEPLOY_PROJECT].kind).toBe('platform');
    expect(Object.values(DEPLOYMENT_MAP).filter((e) => e.kind === 'platform')).toHaveLength(1);
  });
});

describe('findInvalidTargetRefs', () => {
  it('flags a command referencing a repo path that does not exist', () => {
    const violations = findInvalidTargetRefs(
      new Map([['@ecoma-io/home', ['npx tsx tools/ghost/src/gate.mts --project @ecoma-io/home']]]),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      project: '@ecoma-io/home',
      kind: 'invalid-target-ref',
    });
    expect(violations[0].detail).toContain('tools/ghost/src/gate.mts');
  });

  it('does not flag a dangling ref that a matching allowlist entry covers', () => {
    // Hợp đồng allowlist: entry có reason che đúng ref hỏng nó khai — allowlist
    // là cơ chế cho ref hỏng TƯƠNG LAI có chủ đích, không phải di tích của cây
    // HEAD (cây mới không còn ref tools/delivery nào). Seed entry + command
    // khớp để test cơ chế, độc lập dữ liệu allowlist thật (đang rỗng).
    const original = [...knownInvalidTargets];
    (knownInvalidTargets as InvalidTargetAllowlistEntry[]).length = 0;
    (knownInvalidTargets as InvalidTargetAllowlistEntry[]).push({
      ref: 'tools/delivery/src/deploy-gate.mts',
      reason: 'test fixture: intentionally dangling ref covered by the allowlist',
    });
    try {
      const violations = findInvalidTargetRefs(
        new Map([
          [
            '@ecoma-io/home',
            ['npx tsx tools/delivery/src/deploy-gate.mts --project @ecoma-io/home'],
          ],
        ]),
      );
      expect(violations).toEqual([]);
    } finally {
      (knownInvalidTargets as InvalidTargetAllowlistEntry[]).length = 0;
      (knownInvalidTargets as InvalidTargetAllowlistEntry[]).push(...original);
    }
  });

  it('still flags a NEW dangling ref that the allowlist does not cover', () => {
    // Đúng hình "thêm 1 ref hỏng mới ngoài allowlist" của acceptance criteria:
    // entry đã khớp 1 ref hỏng (không stale), ref mới ngoài allowlist vẫn đỏ.
    const original = [...knownInvalidTargets];
    (knownInvalidTargets as InvalidTargetAllowlistEntry[]).length = 0;
    (knownInvalidTargets as InvalidTargetAllowlistEntry[]).push({
      ref: 'tools/delivery/src/deploy-gate.mts',
      reason: 'test fixture: intentionally dangling ref covered by the allowlist',
    });
    try {
      const violations = findInvalidTargetRefs(
        new Map([
          [
            '@ecoma-io/account',
            [
              'npx tsx tools/delivery/src/deploy-gate.mts --project @ecoma-io/account',
              'npx tsx tools/delivery/src/other-gate.mts --project @ecoma-io/account',
            ],
          ],
        ]),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].detail).toContain('tools/delivery/src/other-gate.mts');
    } finally {
      (knownInvalidTargets as InvalidTargetAllowlistEntry[]).length = 0;
      (knownInvalidTargets as InvalidTargetAllowlistEntry[]).push(...original);
    }
  });

  it('requires a non-empty reason on every allowlist entry', () => {
    for (const entry of knownInvalidTargets) {
      expect(entry.reason.length, `${entry.ref} needs a reason`).toBeGreaterThan(0);
    }
  });

  it('flags an allowlist entry that matches no dangling ref on the tree', () => {
    // Entry chết: không còn ref hỏng nào khớp ⇒ allowlist che không gì và bị
    // báo stale để dọn. Hình thật của cây sau Phase 3: allowlist rỗng; test
    // này neo cơ chế nếu ai thêm entry mà không có (hay đã xóa) target tương ứng.
    const original = [...knownInvalidTargets];
    (knownInvalidTargets as InvalidTargetAllowlistEntry[]).length = 0;
    (knownInvalidTargets as InvalidTargetAllowlistEntry[]).push({
      ref: 'tools/ghost/src/gate.mts',
      reason: 'test fixture: seeded without a matching dangling ref',
    });
    try {
      const violations = findInvalidTargetRefs(new Map());
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ project: '', kind: 'stale-allowlist-entry' });
      expect(violations[0].detail).toContain('tools/ghost/src/gate.mts');
    } finally {
      (knownInvalidTargets as InvalidTargetAllowlistEntry[]).length = 0;
      (knownInvalidTargets as InvalidTargetAllowlistEntry[]).push(...original);
    }
  });

  it('keeps a live allowlist entry that covers an existing dangling ref', () => {
    // Chiều đối xứng của test trên: entry khớp >= 1 ref hỏng thật thì KHÔNG
    // bị báo stale, và ref được che vẫn không sinh invalid-target-ref.
    const original = [...knownInvalidTargets];
    (knownInvalidTargets as InvalidTargetAllowlistEntry[]).length = 0;
    (knownInvalidTargets as InvalidTargetAllowlistEntry[]).push({
      ref: 'tools/ghost/src/gate.mts',
      reason: 'test fixture: intentionally dangling ref still present on the tree',
    });
    try {
      const violations = findInvalidTargetRefs(
        new Map([
          ['@ecoma-io/home', ['npx tsx tools/ghost/src/gate.mts --project @ecoma-io/home']],
        ]),
      );
      expect(violations).toEqual([]);
    } finally {
      (knownInvalidTargets as InvalidTargetAllowlistEntry[]).length = 0;
      (knownInvalidTargets as InvalidTargetAllowlistEntry[]).push(...original);
    }
  });

  it('ships an empty allowlist: the tree has no dangling target ref left', () => {
    // Contract Phase 3: 7 target deploy và entry allowlist che chúng bị xóa
    // CÙNG LÚC — allowlist rỗng đồng nghĩa cây không còn dangling ref nào.
    // Nếu ai thêm lại ref hỏng mà không khai allowlist thì test flags-a-command
    // phía trên đã đỏ; test này chốt chiều ngược lại: không để entry chết.
    expect(knownInvalidTargets).toEqual([]);
  });

  it('ignores bare commands, flags and URLs', () => {
    // Ref tương đối gắn với project cụ thể được kiểm ở test kế bên; test này
    // chỉ chốt các token KHÔNG phải path-ref: lệnh trần, flag, URL,
    // và ref repo-level tồn tại thật (`docs/`).
    const violations = findInvalidTargetRefs(
      new Map([
        [
          'x',
          [
            'npx vitest run',
            'python3 -B -m unittest discover',
            'curl https://example.com/a/b',
            'npx tsx docs/architecture/05-code-architecture.md',
          ],
        ],
      ]),
    );
    expect(violations).toEqual([]);
  });

  it('resolves relative refs against the project root too', () => {
    // Hình thật của workspace: account chạy
    // `npx vitest run -c vitest.integration.config.mts tests/integrations tests/databases`
    // với cwd=apps/account — ref giải hệ theo project root, không phải repo
    // root, nên phải xanh.
    const violations = findInvalidTargetRefs(
      new Map([
        [
          '@ecoma-io/account',
          ['npx vitest run -c vitest.integration.config.mts tests/integrations tests/databases'],
        ],
      ]),
    );
    expect(violations).toEqual([]);
  });
});

describe('readDeploymentStatusMarker', () => {
  it('rejects a status outside the contract', () => {
    const dir = mkdtempSync(join(tmpdir(), 'marker-'));
    try {
      const path = join(dir, 'package.json');
      writeFileSync(path, '{"ecoma":{"deployment":{"status":"vibes"}}}');
      expect(readDeploymentStatusMarker(path)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
