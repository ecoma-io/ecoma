/**
 * Release PR automation (issue #361 — hợp đồng Phase B ở 02-delivery.md §7.2/§7.3).
 *
 * Một file duy nhất cho cả ba vai trò, chọn bằng đối số CLI đầu tiên:
 *   plan      — job không secret: audit membership (nx.json release.projects ≡
 *               staging releaseable của deploy-eligibility.jsonc), dry-run
 *               `nx release` per project để phân loại batch, xuất outputs cho
 *               job kế tiếp. Không credential nào được dùng trước khi audit pass.
 *   prepare   — job có secret: chạy `nx release` thật trên đúng base SHA đã
 *               plan, kiểm allowlist metadata-only (fail-closed), tạo commit
 *               qua git-database REST bằng GitHub App installation token (đường
 *               DISC3 đã đo: GitHub tự ký server-side, verification.reason ===
 *               "valid"), trỏ branch `release/*` qua REST với re-read trước và
 *               sau PATCH, rồi tạo hoặc cập nhật Release PR kèm manifest.
 *   verify-pr — job CI trên pull_request_target cho PR đầu `release/*`: kiểm
 *               lại file-shape metadata-only và manifest (base SHA + head SHA +
 *               artifact digests — thiếu field nào là evidence invalid). Script
 *               chạy trên checkout BASE ref; không thực thi nội dung nào từ PR
 *               head, dữ liệu PR (files, body) chỉ đi qua REST API.
 *
 * Script đọc cấu hình (nx.json, deploy-eligibility.jsonc) từ working tree của
 * checkout — với verify-pr, checkout đó được trỏ tường minh vào base SHA của
 * event, không bao giờ từ PR head.
 */

import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/* --- Hằng số hợp đồng ----------------------------------------------------- */

const MANIFEST_FENCE = 'release-manifest';
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DEFAULT_BRANCH = 'main';
const VALID_BUMPS = ['patch', 'minor', 'major'];

/* --- Pure logic (export để spec chấm trực tiếp) --------------------------- */

/**
 * Parse JSONC: bỏ comment dòng (hai dấu gạch chéo), comment khối, và dấu phẩy
 * cuối object/array trước khi JSON.parse. State machine thay vì regex vì file
 * chứa URL trong string (`https://…` sẽ bị regex cắt gãy ở dấu gạch chéo kép)
 * và deploy-eligibility.jsonc thật có trailing comma.
 */
export function parseJsonc(text) {
  const noComments = stripJsoncComments(text);
  return JSON.parse(stripTrailingCommas(noComments));
}

function stripJsoncComments(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      i -= 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new Error('Unterminated block comment in JSONC input');
      i = end + 1;
      continue;
    }
    out += ch;
  }
  if (inString) throw new Error('Unterminated string in JSONC input');
  return out;
}

/** Bỏ dấu phẩy đứng ngay trước `}` hoặc `]` — string-aware, không đụng nội dung string. */
function stripTrailingCommas(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let next = text[i + 1];
      while (next !== undefined && /\s/u.test(next)) {
        i += 1;
        next = text[i + 1];
      }
      if (next !== '}' && next !== ']') out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Đánh giá classification theo schema của deploy-eligibility.jsonc (schema v1):
 * explicit entry thắng mọi rule; rule đầu tiên khớp áp dụng (`*` khớp substring
 * nào đó); khớp không gì cả → unclassified → lỗi chặn, không phải cảnh báo.
 * Trả về map project → entry (`{staging, reason?}`).
 */
export function classifyEligibility(projectNames, config) {
  if (config.schemaVersion !== 1) {
    throw new Error(`Unsupported deploy-eligibility schemaVersion: ${config.schemaVersion}`);
  }
  const result = new Map();
  for (const name of projectNames) {
    const explicit = config.projects?.[name];
    if (explicit !== undefined) {
      result.set(name, explicit);
      continue;
    }
    const rule = (config.rules ?? []).find((candidate) => {
      const parts = String(candidate.match)
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
      return new RegExp(`^${parts.join('.*')}$`, 'u').test(name);
    });
    if (rule !== undefined) {
      result.set(name, { staging: rule.staging, reason: rule.reason });
      continue;
    }
    throw new Error(
      `Deploy eligibility is not classified for project ${name}; refusing to continue`,
    );
  }
  return result;
}

/**
 * Bảng chọn batch của §7.2 — `requested` là mảng tên đã split/trim:
 *   - requested rỗng → batch = project CÓ thay đổi; project không có gì bị loại
 *     kèm lý do cụ thể (không phải run đỏ).
 *   - requested tường minh → project được chọn mà không có gì để release là mâu
 *     thuẫn: fail closed, nêu đúng tên.
 *   - tên lạ, tên lặp → fail closed nêu tên.
 * `changesByProject` map tên → lý do "không có gì để release".
 */
export function resolveBatch({ requested, candidates, changesByProject }) {
  const invalid = requested.filter((name) => !candidates.includes(name));
  if (invalid.length > 0) {
    throw new Error(
      `Requested project(s) are not in release.projects: ${invalid.join(', ')}` +
        ` (known: ${candidates.join(', ')})`,
    );
  }
  const seen = new Set();
  for (const name of requested) {
    if (seen.has(name)) throw new Error(`Duplicate project in request: ${name}`);
    seen.add(name);
  }

  const effective = requested.length > 0 ? requested : candidates;
  const batch = [];
  const excluded = [];
  for (const name of effective) {
    const reason = changesByProject[name];
    if (reason === undefined) {
      batch.push(name);
      continue;
    }
    if (requested.length > 0) {
      throw new Error(
        `Explicitly requested project ${name} has nothing to release, which is a contradiction ` +
          `in an explicit request, not a valid no-op: ${reason}`,
      );
    }
    excluded.push({ project: name, reason });
  }
  return { batch, excluded, noOp: requested.length === 0 && batch.length === 0 };
}

/** Subject của release commit — một batch, một commit, scope `release`. */
export function buildReleaseSubject(units) {
  return `chore(release): release ${units.map((unit) => `${unit.project} ${unit.version}`).join(', ')}`;
}

/** Slug an toàn cho tên project (`@ecoma-io/home` → `home`). */
export function projectSlug(projectName) {
  const slug = projectName.replace(/^@[^/]+\//u, '');
  if (!/^[a-z0-9][a-z0-9-_.]*$/u.test(slug)) {
    throw new Error(`Cannot derive a safe slug from project name ${projectName}`);
  }
  return slug;
}

/** Tên branch release: batch slug sorted + join `+` — cùng batch, cùng branch. */
export function releaseBranchName(batchProjects) {
  return `release/${[...batchProjects].map(projectSlug).toSorted().join('+')}`;
}

/**
 * Allowlist metadata-only của §7.3 (bản sửa 2026-11-19): từ danh sách project
 * của batch, tính danh sách file dự kiến — package.json + CHANGELOG.md của
 * đúng những project đó. Đường dẫn tính từ repo root.
 */
export function computeAllowlist(batchProjectRoots) {
  const files = new Set();
  for (const root of batchProjectRoots) {
    files.add(`${root}/package.json`);
    files.add(`${root}/CHANGELOG.md`);
  }
  return files;
}

/**
 * Phân loại danh sách file thay đổi chống allowlist:
 *   violations       — file ngoài allowlist → fail closed (không phải bộ lọc).
 *   missingManifest  — project trong batch KHÔNG đổi package.json → release
 *                      không đổi version là không phải release → fail closed.
 *   missingChangelog — chỉ là warning: `nx release` có lý do chính đáng bỏ qua.
 */
export function classifyChangedFiles(changedFiles, allowlist, batchRoots) {
  const violations = changedFiles.filter((file) => !allowlist.has(file));
  const changed = new Set(changedFiles);
  const missingManifest = batchRoots.filter((root) => !changed.has(`${root}/package.json`));
  const missingChangelog = batchRoots.filter((root) => !changed.has(`${root}/CHANGELOG.md`));
  return { violations, missingManifest, missingChangelog };
}

/**
 * Đọc version của từng project trong batch từ package.json trên working tree.
 * `batch` và `batchRoots` là hai mảng song song cùng thứ tự (outputs của job
 * plan); `readFile` là tham số inject để spec chấm logic mà không chạm đĩa.
 */
export function readBatchUnits(batch, batchRoots, readFile = (path) => readFileSync(path, 'utf8')) {
  if (batch.length !== batchRoots.length) {
    throw new Error(
      `batch (${batch.length}) and batchRoots (${batchRoots.length}) length mismatch; refusing to map versions onto the wrong projects`,
    );
  }
  return batch.map((project, index) => {
    const manifest = JSON.parse(readFile(`${batchRoots[index]}/package.json`));
    // Fail-fast thay vì truyền version undefined xuống commit/PR body: một
    // package.json thiếu version là hỏng repo, không phải bản release hợp lệ.
    if (typeof manifest.version !== 'string' || manifest.version === '') {
      throw new Error(
        `${project}: package.json at ${batchRoots[index]} has no valid version field`,
      );
    }
    return { project, version: manifest.version };
  });
}

/**
 * Manifest identity của batch (bản sửa 2026-11-19): release base/source SHA +
 * Release PR head SHA + artifact digests per unit. Ở Phase B artifact chưa
 * được build nên `artifact_digest` là `null` tường minh — field PHẢI có mặt;
 * Phase C (build/promotion) điền giá trị thật và mọi evidence downstream
 * (#379/#380/#363) chỉ hợp lệ khi khớp đúng bộ identity này.
 */
export function buildManifest({ baseSha, headSha, batchRoots, units, sourceRunUrl }) {
  return {
    spec: 1,
    release_base_sha: baseSha,
    head_sha: headSha,
    units: units.map((unit) => ({
      project: unit.project,
      version: unit.version,
      artifact_digest: null,
    })),
    batch_roots: batchRoots,
    source_run_url: sourceRunUrl ?? null,
  };
}

/** Trích manifest từ PR body — fenced block ```release-manifest. */
export function extractManifest(prBody) {
  const match = new RegExp(`\`\`\`${MANIFEST_FENCE}\\s*\\n([\\s\\S]*?)\\n\`\`\``, 'u').exec(
    prBody ?? '',
  );
  if (match === null) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/**
 * Kiểm shape manifest — thiếu field nào là evidence invalid (fail closed).
 * `artifact_digest` phải CÓ MẶT trên mọi unit; giá trị `null` hợp lệ ở Phase B.
 */
export function validateManifestShape(manifest) {
  if (manifest === null || typeof manifest !== 'object') {
    return { ok: false, missing: ['manifest'] };
  }
  const missing = [];
  if (manifest.spec !== 1) missing.push('spec === 1');
  if (
    typeof manifest.release_base_sha !== 'string' ||
    !SHA_PATTERN.test(manifest.release_base_sha)
  ) {
    missing.push('release_base_sha (40-hex)');
  }
  if (typeof manifest.head_sha !== 'string' || !SHA_PATTERN.test(manifest.head_sha)) {
    missing.push('head_sha (40-hex)');
  }
  if (!Array.isArray(manifest.units) || manifest.units.length === 0) {
    missing.push('units (non-empty array)');
  } else {
    manifest.units.forEach((unit, index) => {
      if (typeof unit?.project !== 'string' || unit.project === '')
        missing.push(`units[${index}].project`);
      if (typeof unit?.version !== 'string' || unit.version === '')
        missing.push(`units[${index}].version`);
      // `in` ném TypeError trên primitive thay vì thêm vào missing — kiểm kiểu
      // object tường minh để mọi manifest hỏng đều trả về danh sách, không crash.
      if (unit === null || typeof unit !== 'object' || !('artifact_digest' in unit)) {
        missing.push(`units[${index}].artifact_digest (key must exist; null until Phase C)`);
      }
    });
  }
  if (!Array.isArray(manifest.batch_roots) || manifest.batch_roots.length === 0) {
    missing.push('batch_roots (non-empty array of project roots)');
  } else if (manifest.batch_roots.some((root) => typeof root !== 'string' || root === '')) {
    missing.push('batch_roots (every entry must be a non-empty string)');
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Bằng chứng chữ ký của đường DISC3: commit tạo qua git-database REST bằng App
 * installation token được GitHub ký server-side. Response phải mang
 * `verified === true` và `reason === "valid"` — lệch một vế là throw, run dừng
 * TRƯỚC khi trỏ branch (fail-closed §7.3).
 */
export function assertCommitVerification(commit) {
  const verification = commit?.verification;
  if (verification?.verified !== true || verification?.reason !== 'valid') {
    throw new Error(
      `Release commit signature check failed: verified=${JSON.stringify(verification?.verified)} ` +
        `reason=${JSON.stringify(verification?.reason)}; refusing to move the release branch. ` +
        'Expected verified=true and reason="valid" (GitHub-side signing of App-token REST commits).',
    );
  }
}

/**
 * Parse stdout của `nx release --dry-run`: dòng `UPDATE <path> [dry-run]` là
 * danh sách file plan sẽ đổi. Không dòng nào + thông báo "no changes" → project
 * không có gì để release; trả lý do cụ thể theo đúng hợp đồng §7.2.
 */
export function parseDryRun(stdout) {
  const files = new Set();
  for (const match of stdout.matchAll(/^UPDATE\s+(\S+)\s+\[dry-run\]$/gmu)) {
    files.add(match[1]);
  }
  if (files.size > 0) return { changed: [...files] };
  if (/No changes were detected/iu.test(stdout)) {
    return {
      changed: [],
      reason: 'no version plan change reached this project since its last release',
    };
  }
  return { changed: [], reason: 'nx release reported no file changes for this project' };
}

/* --- GitHub REST (git-database + pulls) ----------------------------------- */

async function ghApi(token, path, { method = 'GET', body } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text();
    const error = new Error(
      `GitHub API ${method} ${path} failed with ${response.status}: ${detail.slice(0, 2000)}`,
    );
    error.status = response.status;
    throw error;
  }
  return response.json();
}

/**
 * Chuỗi tạo commit git-database (§7.3): tree dựng TRÊN base_tree của base SHA,
 * blob per file, rồi POST /git/commits KHÔNG truyền author/committer — GitHub
 * ký server-side (đường App-token đã đo ở #347/DISC3). Chữ ký được kiểm ngay
 * trên response; fail thì throw trước khi bất kỳ ref nào bị chạm tới.
 */
export async function createSignedCommit({ token, repo, baseSha, files, message }) {
  const baseCommit = await ghApi(token, `/repos/${repo}/git/commits/${baseSha}`);
  const tree = [];
  for (const file of files) {
    const blob = await ghApi(token, `/repos/${repo}/git/blobs`, {
      method: 'POST',
      body: { content: file.content, encoding: 'utf-8' },
    });
    tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const newTree = await ghApi(token, `/repos/${repo}/git/trees`, {
    method: 'POST',
    body: { base_tree: baseCommit.tree.sha, tree },
  });
  const commit = await ghApi(token, `/repos/${repo}/git/commits`, {
    method: 'POST',
    body: { message, tree: newTree.sha, parents: [baseSha] },
  });
  assertCommitVerification(commit);
  return { sha: commit.sha, verification: commit.verification };
}

/** Đọc ref head branch; 404 là "chưa tồn tại", lỗi API khác phải nổi lên. */
export async function readBranchRef(token, repo, branch) {
  try {
    const ref = await ghApi(token, `/repos/${repo}/git/refs/heads/${branch}`);
    return ref.object.sha;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

/**
 * Trỏ branch release bằng REST — không có race nào ghi đè branch mù (§7.3):
 * PATCH /git/refs với force:true (commit luôn dựng lại từ base nên luôn
 * non-fast-forward), và endpoint không có compare-and-swap. Chốt chặn thật:
 * `expectedCurrentSha` là lần đọc đầu của run (trước khi tạo commit, có thể
 * chậm), bên dưới đọc lại ref NGAY TRƯỚC khi ghi và so với lần đọc đầu; lệch
 * thì throw, PR cũ giữ nguyên, không có đường ghi đè mù. Sau khi ghi, đọc lại
 * lần nữa và bắt buộc trỏ đúng commit mới. Branch chưa tồn tại ở CẢ HAI lần
 * đọc mới được tạo; xuất hiện giữa chừng là trạng thái không rõ nguồn → throw.
 */
export async function pointReleaseBranch({ token, repo, branch, expectedCurrentSha, newSha }) {
  const current = await readBranchRef(token, repo, branch);
  if (current !== expectedCurrentSha) {
    throw new Error(
      `Release branch ${branch} moved during the run (first read ${expectedCurrentSha ?? '<absent>'}, ` +
        `immediate re-read ${current ?? '<absent>'}); refusing to overwrite blind. Re-run release-prepare.`,
    );
  }
  if (current === null) {
    await ghApi(token, `/repos/${repo}/git/refs`, {
      method: 'POST',
      body: { ref: `refs/heads/${branch}`, sha: newSha },
    });
  } else {
    await ghApi(token, `/repos/${repo}/git/refs/heads/${branch}`, {
      method: 'PATCH',
      body: { sha: newSha, force: true },
    });
  }
  const after = await readBranchRef(token, repo, branch);
  if (after !== newSha) {
    throw new Error(
      `Release branch ${branch} does not point at the new commit after the ref write (${after} ≠ ${newSha}).`,
    );
  }
  return { previous: current };
}

/** Danh sách PR mở với đúng head branch; nhiều hơn một là trạng thái mơ hồ. */
async function listOpenPrs(token, repo, branch) {
  const [owner] = repo.split('/');
  return ghApi(token, `/repos/${repo}/pulls?head=${owner}:${branch}&state=open&per_page=100`);
}

/**
 * Idempotency của §7.3: 0 PR mở → tạo mới; đúng 1 → cập nhật (body/title);
 * nhiều hơn 1 → fail closed.
 */
export async function upsertReleasePr({ token, repo, branch, base, title, body }) {
  const open = await listOpenPrs(token, repo, branch);
  if (open.length > 1) {
    throw new Error(
      `Found ${open.length} open PRs with head ${branch}; refusing to guess which one to update.`,
    );
  }
  if (open.length === 1) {
    const updated = await ghApi(token, `/repos/${repo}/pulls/${open[0].number}`, {
      method: 'PATCH',
      body: { title, body },
    });
    return { action: 'updated', number: updated.number, url: updated.html_url };
  }
  const created = await ghApi(token, `/repos/${repo}/pulls`, {
    method: 'POST',
    body: { title, head: branch, base, body, draft: false },
  });
  return { action: 'created', number: created.number, url: created.html_url };
}

/* --- Cấu hình từ working tree (checkout của ref tin cậy) ------------------- */

function nxJsonOutput(args) {
  return execFileSync('pnpm', ['nx', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Đọc cấu hình release: release.projects từ nx.json, classification từ
 * deploy-eligibility.jsonc, và projectRoot của từng project từ Nx graph.
 */
export function readReleaseConfig(root = process.cwd()) {
  const nxJson = JSON.parse(readFileSync(`${root}/nx.json`, 'utf8'));
  const projects = nxJson.release?.projects;
  if (!Array.isArray(projects) || projects.length === 0) {
    throw new Error('nx.json has no release.projects list; refusing to continue');
  }
  const eligibility = parseJsonc(
    readFileSync(`${root}/tools/delivery/config/deploy-eligibility.jsonc`, 'utf8'),
  );
  const projectRoots = new Map();
  for (const project of projects) {
    const info = JSON.parse(nxJsonOutput(['show', 'project', project, '--json']));
    projectRoots.set(project, info.root);
  }
  return { projects, eligibility, projectRoots };
}

/** Audit membership (#360, §7.2): staging releaseable ≡ nx.json release.projects. */
export function auditMembership({ projects, eligibility, projectNames }) {
  const classified = classifyEligibility(projectNames, eligibility);
  const releaseable = [...classified.entries()]
    .filter(([, entry]) => entry.staging === 'releaseable')
    .map(([name]) => name)
    .toSorted();
  const declared = [...projects].toSorted();
  const same =
    releaseable.length === declared.length &&
    releaseable.every((name, index) => name === declared[index]);
  if (!same) {
    throw new Error(
      'Deploy eligibility drift: staging releaseable set does not equal nx.json release.projects ' +
        `(releaseable: [${releaseable.join(', ')}] vs release.projects: [${declared.join(', ')}]). ` +
        'Add/remove the unit in BOTH places.',
    );
  }
}

/* --- CLI modes ------------------------------------------------------------ */

function requireEnv(names) {
  const values = {};
  for (const name of names) {
    const value = process.env[name];
    if (value === undefined || value === '') {
      throw new Error(`Missing required environment variable ${name}`);
    }
    values[name] = value;
  }
  return values;
}

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function writeOutput(key, value) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

function writeSummary(lines) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

function splitProjects(input) {
  const requested = input
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  if (input.trim() !== '' && requested.length === 0) {
    throw new Error(`Invalid projects input: ${JSON.stringify(input)} splits to an empty list`);
  }
  return requested;
}

/** Chế độ plan: audit + phân loại batch, không secret nào được dùng. */
async function modePlan() {
  const env = requireEnv(['INPUT_PROJECTS', 'INPUT_BUMP']);
  const { projects, eligibility, projectRoots } = readReleaseConfig();
  auditMembership({
    projects,
    eligibility,
    projectNames: JSON.parse(run('pnpm', ['nx', 'show', 'projects', '--json'])).toSorted(),
  });

  const requested = splitProjects(env.INPUT_PROJECTS);
  const hasExplicitBump = VALID_BUMPS.includes(env.INPUT_BUMP);
  if (env.INPUT_BUMP !== '' && !hasExplicitBump) {
    throw new Error(
      `Invalid bump input: ${JSON.stringify(env.INPUT_BUMP)} (expected empty, patch, minor or major)`,
    );
  }

  // Mỗi project một dry-run riêng: `--first-release` là cờ toàn cục nên gọi
  // batch là sai các project còn lại (§7.2); phân loại cũng cần per-project.
  // Với bump tường minh thì version đổi chắc chắn → bỏ qua phân loại.
  const changesByProject = {};
  if (!hasExplicitBump) {
    for (const project of projects) {
      const parsed = parseDryRun(run('pnpm', ['nx', 'release', '--dry-run', '-p', project]));
      if (parsed.changed.length > 0) continue;
      changesByProject[project] = parsed.reason;
    }
  }

  const { batch, excluded, noOp } = resolveBatch({
    requested,
    candidates: projects,
    changesByProject,
  });

  if (noOp) {
    writeOutput('has_batch', 'false');
    writeSummary([
      '## Release prepare: nothing to release (valid no-op)',
      ...excluded.map((entry) => `- ${entry.project}: ${entry.reason}`),
    ]);
    return;
  }

  const baseSha = run('git', ['rev-parse', 'HEAD']).trim();
  if (!SHA_PATTERN.test(baseSha)) throw new Error(`Checked-out base is not a full SHA: ${baseSha}`);

  writeOutput('has_batch', 'true');
  writeOutput('base_sha', baseSha);
  writeOutput('branch', releaseBranchName(batch));
  writeOutput('batch_json', JSON.stringify(batch));
  writeOutput('excluded_json', JSON.stringify(excluded));
  writeOutput(
    'project_roots_json',
    JSON.stringify(batch.map((project) => projectRoots.get(project))),
  );
}

/** Chế độ prepare: nx release thật → allowlist → commit có chữ ký → ref → PR. */
async function modePrepare() {
  const env = requireEnv([
    'APP_TOKEN',
    'REPO',
    'BASE_SHA',
    'BRANCH',
    'BATCH_JSON',
    'PROJECT_ROOTS_JSON',
  ]);
  const batch = JSON.parse(env.BATCH_JSON);
  const batchRoots = JSON.parse(env.PROJECT_ROOTS_JSON);
  if (!Array.isArray(batch) || batch.length === 0)
    throw new Error('BATCH_JSON must be a non-empty array');

  const releaseArgs = ['nx', 'release'];
  if (VALID_BUMPS.includes(env.BUMP)) releaseArgs.push(env.BUMP);
  for (const project of batch) releaseArgs.push('-p', project);
  run('pnpm', releaseArgs);

  const changedFiles = run('git', ['status', '--porcelain=v1'])
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.slice(3).trim());

  const allowlist = computeAllowlist(batchRoots);
  const { violations, missingManifest, missingChangelog } = classifyChangedFiles(
    changedFiles,
    allowlist,
    batchRoots,
  );
  if (violations.length > 0) {
    throw new Error(
      `Metadata-only violation: changed file(s) outside the release allowlist: ${violations.join(', ')}. ` +
        `Allowed: ${[...allowlist].join(', ')}. The run stops here; nothing was committed and no branch was touched.`,
    );
  }
  if (missingManifest.length > 0) {
    throw new Error(
      `Metadata-only violation: no package.json change for batch project(s): ${missingManifest.join(', ')} ` +
        '— a release that does not change the version is not a release.',
    );
  }
  if (missingChangelog.length > 0) {
    // Warning thôi (§7.3): `nx release` có lý do chính đáng bỏ qua changelog;
    // PR body vẫn có đường dự phòng cho reader.
    process.stderr.write(
      `[release-pr] warning: no CHANGELOG.md change for ${missingChangelog.join(', ')}; the PR body carries the batch description instead.\n`,
    );
  }

  const units = readBatchUnits(batch, batchRoots);
  const files = changedFiles.map((path) => ({ path, content: readFileSync(path, 'utf8') }));
  const subject = buildReleaseSubject(units);

  // Lần đọc đầu của branch (T1) — trước khi tạo commit; pointReleaseBranch đọc
  // lại (T2) ngay trước ghi và so với T1 (hợp đồng §7.3).
  const branchShaBefore = await readBranchRef(env.APP_TOKEN, env.REPO, env.BRANCH);

  const commit = await createSignedCommit({
    token: env.APP_TOKEN,
    repo: env.REPO,
    baseSha: env.BASE_SHA,
    files,
    message: subject,
  });

  await pointReleaseBranch({
    token: env.APP_TOKEN,
    repo: env.REPO,
    branch: env.BRANCH,
    expectedCurrentSha: branchShaBefore,
    newSha: commit.sha,
  });

  const manifest = buildManifest({
    baseSha: env.BASE_SHA,
    headSha: commit.sha,
    batchRoots,
    units,
    sourceRunUrl: process.env.RUN_URL ?? null,
  });
  const excluded = JSON.parse(process.env.EXCLUDED_JSON ?? '[]');
  const body = [
    `## Release batch — ${batch.length} project(s)`,
    '',
    `Release commit **${commit.sha}** trên branch \`${env.BRANCH}\`, base \`${env.BASE_SHA}\`.`,
    'Chữ ký: `verified=true, reason="valid"` (GitHub-side signing, đường App-token REST — DISC3 #347).',
    '',
    '| Project | Version |',
    '| ------- | ------- |',
    ...units.map((unit) => `| ${unit.project} | ${unit.version} |`),
    '',
    ...(excluded.length > 0
      ? [
          '### Loại khỏi batch',
          '',
          '| Project | Lý do |',
          '| ------- | ----- |',
          ...excluded.map((entry) => `| ${entry.project} | ${entry.reason} |`),
          '',
        ]
      : []),
    '### Allowlist metadata-only',
    '',
    'Mọi file trong commit nằm trong allowlist (package.json + CHANGELOG.md của batch).',
    'Check `Release PR check / metadata-only` re-verify shape + manifest trên CI; evidence downstream',
    '(#379 baseline/migration, #380 compat, #363 gate) chỉ hợp lệ khi khớp identity trong manifest.',
    '',
    '```release-manifest',
    JSON.stringify(manifest, null, 2),
    '```',
  ].join('\n');

  const pr = await upsertReleasePr({
    token: env.APP_TOKEN,
    repo: env.REPO,
    branch: env.BRANCH,
    base: DEFAULT_BRANCH,
    title: subject,
    body,
  });

  writeSummary([
    '## Release PR prepared',
    '',
    `- Batch: ${units.map((unit) => `${unit.project}@${unit.version}`).join(', ')}`,
    `- Release commit: ${commit.sha} (verification ${commit.verification.reason})`,
    `- Branch: ${env.BRANCH} (base ${env.BASE_SHA})`,
    `- PR: ${pr.action} #${pr.number} — ${pr.url}`,
  ]);
}

/** Chế độ verify-pr: file-shape re-verify + manifest check cho PR release/*. */
async function modeVerifyPr() {
  const env = requireEnv(['GH_TOKEN', 'PR_NUMBER', 'BASE_SHA', 'HEAD_SHA', 'REPO']);
  const { projects, projectRoots } = readReleaseConfig();
  // Tập roots hợp lệ = projectRoot của MỌI project trong release.projects: bộ
  // batch_roots khai trong manifest phải nằm TRONG tập này — khai roots ngoài
  // tập là manifest bị chế tạo ngoài đường chuẩn.
  const allowedRoots = new Set(projects.map((project) => projectRoots.get(project)));

  const files = [];
  let page = 1;
  for (;;) {
    const chunk = await ghApi(
      env.GH_TOKEN,
      `/repos/${env.REPO}/pulls/${env.PR_NUMBER}/files?per_page=100&page=${page}`,
    );
    files.push(...chunk.map((file) => file.filename));
    if (chunk.length < 100) break;
    page += 1;
  }

  const failures = [];
  const pr = await ghApi(env.GH_TOKEN, `/repos/${env.REPO}/pulls/${env.PR_NUMBER}`);
  const manifest = extractManifest(pr.body);
  if (manifest === null) {
    failures.push(
      'PR body has no release-manifest fenced block; the release evidence chain is unprovable',
    );
  } else {
    const shape = validateManifestShape(manifest);
    if (!shape.ok)
      failures.push(`Manifest is missing required field(s): ${shape.missing.join('; ')}`);
    if (shape.ok && manifest.release_base_sha !== env.BASE_SHA) {
      failures.push(
        `Manifest base ${manifest.release_base_sha} is stale (current base ${env.BASE_SHA}); re-run release-prepare`,
      );
    }
    if (shape.ok && manifest.head_sha !== env.HEAD_SHA) {
      failures.push(
        `Manifest head ${manifest.head_sha} does not match PR head ${env.HEAD_SHA}; the commit may have been created outside the standard path`,
      );
    }
    // Allowlist của check CI tính từ BATCH trong manifest (bản sửa 2026-11-19:
    // "từ version plan của batch, tính danh sách file dự kiến") — không phải
    // hợp của mọi project releaseable. Batch roots khai ngoài release.projects
    // là fail closed; manifest không hợp lệ thì không có allowlist đáng tin để
    // so, file-shape check bị bỏ qua vì mọi failure khác đã làm check đỏ.
    if (shape.ok) {
      const batchRootsOk = manifest.batch_roots.every((root) => allowedRoots.has(root));
      if (!batchRootsOk) {
        failures.push(
          `Manifest batch_roots contains root(s) outside release.projects: ${manifest.batch_roots
            .filter((root) => !allowedRoots.has(root))
            .join(', ')}`,
        );
      } else {
        const allowlist = computeAllowlist(manifest.batch_roots);
        const { violations } = classifyChangedFiles(files, allowlist, manifest.batch_roots);
        if (violations.length > 0) {
          failures.push(`Changed file(s) outside the batch allowlist: ${violations.join(', ')}`);
        }
      }
    }
  }

  if (failures.length > 0) {
    writeSummary([
      '## Release PR metadata check FAILED',
      ...failures.map((failure) => `- ${failure}`),
    ]);
    throw new Error(`Release PR metadata check failed:\n- ${failures.join('\n- ')}`);
  }

  writeSummary([
    '## Release PR metadata check',
    '',
    `- File shape: ${files.length} changed file(s), all inside the release allowlist`,
    `- Manifest: base ${manifest.release_base_sha} ≡ PR base, head ${manifest.head_sha} ≡ PR head, ${manifest.units.length} unit(s)`,
    '- Phase C must bind artifact digests into this identity before any downstream evidence is valid',
  ]);
}

// CLI dispatch chỉ chạy khi file được thực thi trực tiếp, không khi bị import
// (spec chấm pure function bằng import — exit giữa chừng sẽ giết test runner).
const isMain =
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const runner = { plan: modePlan, prepare: modePrepare, 'verify-pr': modeVerifyPr }[
    process.argv[2]
  ];
  if (runner === undefined) {
    process.stderr.write(
      `Usage: node release-pr.mjs <plan|prepare|verify-pr>; got ${JSON.stringify(process.argv[2])}\n`,
    );
    process.exit(2);
  }
  runner().catch((error) => {
    process.stderr.write(`[release-pr] ${error.message}\n`);
    process.exit(1);
  });
}
