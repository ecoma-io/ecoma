/**
 * Audit binding resource của wrangler theo từng lane (issue #362 slice A;
 * hợp đồng `02-delivery.md` §9.1 qua §4.1 — hai lớp enforce, lớp audit là
 * lớp này):
 *
 * - `checkTopLevelReDeclaration`: Wrangler KHÔNG inherit binding vào named
 *   environment (đo trên wrangler 4.151.0), nên binding khai ở top level mà
 *   `env.<lane>` không khai lại là `problem` — Worker deploy ra sẽ thiếu
 *   binding dù file trông như đã cấu hình.
 * - Placeholder: định danh resource khai trong scope lane (và cả top level)
 *   phải là giá trị thật — rỗng hoặc toàn số 0 là violation (đo được trên
 *   `apps/account`: `hyperdrive` top level với `id` toàn 0). Wrangler tự tạo
 *   được resource khi định danh thiếu, nên thiếu id là fail-open nếu audit
 *   không chặn.
 * - Định danh kiểm theo nhóm: `d1_databases.database_id`, `kv_namespaces.id`,
 *   `r2_buckets.bucket_name`, `queues.producers[].queue`, `hyperdrive.id`.
 * - File hỏng / entry sai hình dạng đều là problem (fail closed), không nuốt
 *   entry hỏng rồi kiểm phần còn lại như thể mọi thứ ổn.
 *
 * Hàm thuần, nhận config ĐÃ parse (caller dùng `parseWranglerConfig`); giá
 * trị giữ `unknown` và được validate ở đây — không `as` mù. Report rỗng
 * nghĩa là đạt; caller (slice B/C) chặn deploy khi report khác rỗng.
 */

/** Lane được audit — audit chạy riêng cho từng lane, không gộp. */
export type LaneName = 'staging' | 'production';

/**
 * Slice binding của wrangler config. Giá trị `unknown` có chủ đích: shape
 * thật do audit validate, parser không gán kiểu mù cho config có thể hỏng.
 */
export interface ResourceBindingGroups {
  d1_databases?: unknown;
  kv_namespaces?: unknown;
  hyperdrive?: unknown;
  r2_buckets?: unknown;
  queues?: unknown;
}

/** Toàn bộ config wrangler liên quan audit: nhóm top level + khối `env.<lane>`. */
export interface ResourceBindingConfig extends ResourceBindingGroups {
  env?: Record<string, ResourceBindingGroups>;
}

/** Một violation/problem machine-readable của audit. */
export interface BindingAuditProblem {
  kind:
    | 'lane-env-missing'
    | 'top-level-not-redeclared'
    | 'identifier-placeholder'
    | 'entry-shape-invalid';
  /** Nhóm resource (`d1_databases`, `kv_namespaces`, ...) hoặc `(root)`. */
  resource: string;
  /** Tên binding khi đọc được — còn thiếu thì bỏ trống. */
  binding?: string;
  /** Thông điệp tiếng Anh — tooling phát verbatim vào log (language policy). */
  message: string;
}

/** Field định danh bắt buộc của từng nhóm resource (§9.1 qua §4.1). */
const IDENTIFIER_FIELDS: Readonly<Record<string, string>> = {
  d1_databases: 'database_id',
  kv_namespaces: 'id',
  hyperdrive: 'id',
  r2_buckets: 'bucket_name',
};

/** Thứ tự nhóm cố định để report deterministic giữa hai lần chạy. */
const RESOURCE_GROUPS = ['d1_databases', 'kv_namespaces', 'hyperdrive', 'r2_buckets'] as const;

/**
 * Định danh placeholder/vô nghĩa: không phải string, trim rỗng, hoặc sau khi
 * bỏ `-` và whitespace chỉ còn toàn số `0` (đúng hình dạng placeholder
 * UUID/all-zero đo được trên `apps/account`).
 */
export function isPlaceholderIdentifier(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  const digits = value.replace(/[\s-]/gu, '');
  return digits.length === 0 || /^0+$/u.test(digits);
}

/** Đọc một nhóm resource từ scope; không khai báo → `undefined` (hợp lệ). */
function readGroup(scope: ResourceBindingGroups, group: keyof ResourceBindingGroups): unknown {
  return scope[group];
}

/** Đọc entry `queues` — nhóm đặc biệt với mảng `producers` thay vì trực tiếp. */
function readQueueProducers(scope: ResourceBindingGroups): unknown {
  const queues = readGroup(scope, 'queues');
  if (queues === undefined) return undefined;
  if (typeof queues !== 'object' || queues === null || Array.isArray(queues)) return queues;
  return (queues as { producers?: unknown }).producers;
}

/**
 * Kiểm một mảng entry của một nhóm resource trong MỘT scope: shape entry hợp
 * lệ, định danh bắt buộc có và không placeholder. Trả danh sách binding tên
 * đọc được (phục vụ so khớp re-declaration).
 */
function auditGroupEntries(
  entries: unknown,
  resource: string,
  scopeLabel: string,
  problems: BindingAuditProblem[],
): Set<string> {
  const bindings = new Set<string>();
  if (!Array.isArray(entries)) {
    problems.push({
      kind: 'entry-shape-invalid',
      resource,
      message: `${scopeLabel}.${resource} is declared but is not an array — refusing to audit a shape it cannot read (fail closed)`,
    });
    return bindings;
  }
  const identifierField = IDENTIFIER_FIELDS[resource] ?? 'queue';
  for (const [index, entry] of entries.entries()) {
    const where = `${scopeLabel}.${resource}[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      problems.push({
        kind: 'entry-shape-invalid',
        resource,
        message: `${where} is not an object — refusing to skip a malformed entry silently (fail closed)`,
      });
      continue;
    }
    const record = entry as Record<string, unknown>;
    const binding = record.binding;
    if (typeof binding !== 'string' || binding.trim().length === 0) {
      problems.push({
        kind: 'entry-shape-invalid',
        resource,
        message: `${where} has no readable "binding" name — the entry cannot be matched or audited (fail closed)`,
      });
    } else {
      bindings.add(binding);
    }
    if (isPlaceholderIdentifier(record[identifierField])) {
      problems.push({
        kind: 'identifier-placeholder',
        resource,
        binding: typeof binding === 'string' ? binding : undefined,
        message: `${where} has a missing or placeholder "${identifierField}" — the lane would deploy without a real resource bound (§9.1)`,
      });
    }
  }
  return bindings;
}

/**
 * Quy tắc §9.1: mọi binding khai ở top level phải được `env.<lane>` khai lại
 * theo cùng nhóm resource — Wrangler không inherit, nên thiếu khai lại nghĩa
 * là lane deploy ra không có binding đó. Trả các problem tìm thấy (hàm chính
 * `auditResourceBindings` gộp chung).
 */
export function checkTopLevelReDeclaration(
  top: ResourceBindingGroups,
  lane: ResourceBindingGroups,
  laneName: LaneName,
): BindingAuditProblem[] {
  const problems: BindingAuditProblem[] = [];
  for (const resource of RESOURCE_GROUPS) {
    const laneEntries = readGroup(lane, resource);
    const laneBindings =
      laneEntries === undefined
        ? new Set<string>()
        : auditGroupEntries(laneEntries, resource, `env.${laneName}`, problems);
    const topEntries = readGroup(top, resource);
    if (topEntries === undefined) continue;
    // Top level khai: shape vẫn phải đọc được (fail closed) và từng binding
    // phải xuất hiện lại trong lane.
    const topBindings = auditGroupEntries(topEntries, resource, 'top level', problems);
    for (const binding of topBindings) {
      if (!laneBindings.has(binding)) {
        problems.push({
          kind: 'top-level-not-redeclared',
          resource,
          binding,
          message: `top-level binding "${binding}" (${resource}) is not re-declared in env.${laneName} — wrangler does not inherit bindings into named environments, so the ${laneName} deploy would run without it (§9.1)`,
        });
      }
    }
  }
  // `queues.producers`: so khớp theo binding giống các nhóm khác.
  const laneProducers = readQueueProducers(lane);
  const laneProducerBindings =
    laneProducers === undefined
      ? new Set<string>()
      : auditGroupEntries(laneProducers, 'queues', `env.${laneName}.producers`, problems);
  const topProducers = readQueueProducers(top);
  if (topProducers !== undefined) {
    const topProducerBindings = auditGroupEntries(
      topProducers,
      'queues',
      'top level producers',
      problems,
    );
    for (const binding of topProducerBindings) {
      if (!laneProducerBindings.has(binding)) {
        problems.push({
          kind: 'top-level-not-redeclared',
          resource: 'queues',
          binding,
          message: `top-level queue producer binding "${binding}" is not re-declared in env.${laneName} — wrangler does not inherit bindings into named environments, so the ${laneName} deploy would run without it (§9.1)`,
        });
      }
    }
  }
  return problems;
}

/**
 * Audit toàn bộ config cho MỘT lane. Config root phải là object (file hỏng
 * là lỗi ném ra, không phải report); `env.<lane>` thiếu là problem — unit
 * releaseable bắt buộc khai lane tường minh, không kế thừa top level (§9.1).
 * Trả report; rỗng nghĩa là đạt.
 */
export function auditResourceBindings(
  config: ResourceBindingConfig,
  lane: LaneName,
): BindingAuditProblem[] {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error(
      'wrangler binding config is not an object — the file is unreadable or wrong; blocking (fail closed)',
    );
  }
  const problems: BindingAuditProblem[] = [];
  const env = config.env;
  const laneRaw =
    env !== undefined && typeof env === 'object' && env !== null && env[lane] !== undefined
      ? env[lane]
      : undefined;
  if (
    laneRaw !== undefined &&
    (typeof laneRaw !== 'object' || laneRaw === null || Array.isArray(laneRaw))
  ) {
    problems.push({
      kind: 'entry-shape-invalid',
      resource: '(root)',
      message: `env.${lane} is declared but is not an object — refusing to audit a shape it cannot read (fail closed)`,
    });
  }
  if (laneRaw === undefined) {
    problems.push({
      kind: 'lane-env-missing',
      resource: '(root)',
      message: `wrangler config declares no env.${lane} block — a releaseable unit must declare the lane explicitly; nothing may be inherited from the top level (§9.1)`,
    });
    // Vẫn audit định danh top level ở dưới: placeholder top level là vi phạm
    // báo được dù khối lane thiếu.
  }
  // `null` khai cho khối lane cũng là hình dạng hỏng (problem đã push ở trên)
  // — loại ra khỏi scope để audit không đọc property trên null rồi crash.
  const laneScope: ResourceBindingGroups =
    laneRaw !== undefined &&
    laneRaw !== null &&
    typeof laneRaw === 'object' &&
    !Array.isArray(laneRaw)
      ? (laneRaw as ResourceBindingGroups)
      : {};
  problems.push(...checkTopLevelReDeclaration(config, laneScope, lane));
  return problems;
}
