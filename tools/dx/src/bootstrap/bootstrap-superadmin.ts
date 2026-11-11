/**
 * Orchestration của procedure bootstrap first-administrator — entry point duy
 * nhất của runbook [`docs/applications/staff-access/03-operations.md`] §2.
 *
 * Ranh giới (ADR-0020 Quyết định 12): runner này **không** sở hữu thao tác ghi
 * nào, **không** mở kết nối database, và **không** import code của service.
 * Mỗi bước là CLI offline của chính service sở hữu dữ liệu (`apps/account`,
 * `apps/staff-access`), chạy như tiến trình con; runner chỉ truyền `sub` và
 * `correlation_id` giữa các bước rồi dừng ở bước fail.
 *
 * Thứ tự bắt buộc: preflight → A1 → A2 → S1 → S2 → S3. Không có transaction
 * xuyên database — mỗi bước commit độc lập ở service của nó.
 *
 * Preflight là một lần **đọc** của `account` (A2, read-only). Nó tồn tại để
 * fail nhanh trước A1 khi database đã có Account khác, đúng ADR-0022 Quyết
 * định 7 — nhưng nó **không** thay lớp bảo vệ chính: phép đo `admins_before`/
 * `admins_ever` nằm trong critical section ghi của `staff-access`, nên gọi
 * thẳng CLI vẫn đi qua guard.
 *
 * ## Chế độ resolve-or-bootstrap
 *
 * Vòng lặp cục bộ của một môi trường đã bootstrapped (lane triển khai local,
 * ADR-0020 Quyết định 12 bề mặt (a)) không được gọi lại các bước ghi:
 * `mode: 'resolve-or-bootstrap'` chạy preflight chỉ đọc đầu tiên, và khi tài
 * khoản bootstrap đã có, tiếp tục với stage chỉ đọc `staff-verify` duy nhất —
 * kết quả `resolved`, không có lần ghi nào trên nhánh này, bất kỳ thất bại
 * nào fail-closed. Môi trường mới (`no_bootstrap_account`) ủy quyền cho toàn
 * bộ procedure dưới đây, không đổi: A1 → A2 → S1 → S2 → S3 với bộ điều khiển
 * đã đo lường giữ nguyên, `mode_mismatch` vẫn kết thúc bằng `guard_denied`.
 * `mode: 'bootstrap'` là procedure được ghi lại ở đây, từng byte một.
 */

/** Email canonical của Superadmin — hằng trong code, không phải cấu hình. */
export const BOOTSTRAP_EMAIL = 'superadmin@ecoma.io';

/** Tên service sở hữu từng bước. */
export type BootstrapService = 'account' | 'staff-access';

/** Action CLI của từng service. */
export type BootstrapAction =
  | 'provision'
  | 'verify'
  | 'staff-provision'
  | 'staff-assign'
  | 'staff-verify';

/** Một bước runner yêu cầu service thực hiện. */
export interface BootstrapStageRequest {
  readonly service: BootstrapService;
  readonly action: BootstrapAction;
  /** Payload đi qua **stdin** của tiến trình con — không bao giờ qua argv. */
  readonly input: Readonly<Record<string, string>>;
}

/** Bước thành công. `payload` là JSON service in ra (đã bỏ `stage`/`status`). */
export interface BootstrapStageSuccess {
  readonly ok: true;
  readonly stage: string;
  readonly status: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Bước bị từ chối; `reason` là mã máy đọc của service. */
export interface BootstrapStageFailure {
  readonly ok: false;
  readonly stage: string;
  readonly reason: string;
}

export type BootstrapStageResult = BootstrapStageSuccess | BootstrapStageFailure;

/**
 * Cổng chạy một bước. Production dùng {@link createSpawnStageRunner}; test
 * truyền bản giả để kiểm thứ tự và các nhánh mà không cần Docker/Postgres.
 */
export type BootstrapStageRunner = (request: BootstrapStageRequest) => BootstrapStageResult;

/**
 * Kết quả cuối của một lần chạy procedure.
 *
 * `guard_denied` là trạng thái riêng, không gộp vào `failed`: guard đo được
 * `admins_before`/`admins_ever` khác 0 nên procedure từ chối ghi. Nó **không**
 * chứng minh bootstrap đã hoàn tất — một administrator do đường khác tạo cũng
 * cho cùng phép đo — nên kết quả không được đọc là "đã xong".
 *
 * `resolved` (chỉ có trong chế độ resolve-or-bootstrap) có nghĩa là tài khoản
 * bootstrap đã tồn tại và stage chỉ đọc `staff-verify` đã xác nhận quản trị
 * viên của chủ thể đó: môi trường đã hội tụ và lần chạy này không ghi gì.
 * Không giống `guard_denied`, đây là trạng thái hoàn tất — nó dựa trên bằng
 * chứng chỉ đọc như S3 của procedure dùng, gắn với `sub` của chính tài khoản
 * bootstrap.
 */
export interface BootstrapRunResult {
  readonly outcome: 'bootstrapped' | 'resolved' | 'guard_denied' | 'failed';
  readonly correlationId: string;
  readonly sub?: string;
  readonly staffId?: string;
  readonly assignmentId?: string;
  /** Bước fail — chỉ có khi `outcome = 'failed'`. */
  readonly failedStage?: string;
  /** Mã lý do service trả về — chỉ có khi `outcome = 'failed'`. */
  readonly reason?: string;
  /** Nhật ký từng bước, không chứa credential hay địa chỉ email. */
  readonly stages: readonly BootstrapStageLogEntry[];
}

/** Một dòng nhật ký của procedure. */
export interface BootstrapStageLogEntry {
  readonly stage: string;
  readonly outcome: string;
  readonly detail?: string;
}

/**
 * Chế độ của một lần chạy — quyết định giữa viết bootstrap mới và giải quyết
 * một môi trường đã có.
 *
 * - `'bootstrap'` — toàn bộ procedure, không đổi (có ghi xảy ra).
 * - `'resolve-or-bootstrap'` — giải quyết môi trường đã hội tụ chỉ đọc khi
 *   tài khoản bootstrap tồn tại; chỉ fallback sang toàn bộ procedure khi môi
 *   trường mới. Mọi ghi vẫn phải qua bộ điều khiển đã đo lường.
 */
export type BootstrapRunMode = 'bootstrap' | 'resolve-or-bootstrap';

/** Đầu vào của một lần chạy. */
export interface BootstrapRunOptions {
  readonly correlationId: string;
  /** Tham chiếu người thực thi (ticket/change id) — attribution tự khai. */
  readonly operatorRef: string;
  readonly runStage: BootstrapStageRunner;
  /**
   * Chế độ chạy rõ ràng — bắt buộc, không được suy luận từ môi trường, để caller
   * không vô tình trôi vào procedure ghi.
   *
   * Chỉ nhánh mới của `'resolve-or-bootstrap'` cần `operatorRef` (các bước ghi
   * mang nó vào audit); một lần chạy đã giải quyết không ghi gì và không bao
   * giờ bị từ chối vì thiếu tham chiếu.
   */
  readonly mode: BootstrapRunMode;
}

/**
 * Stage tổng hợp cho lỗi input, không phải một bước chạm database.
 *
 * Tên riêng để nhật ký không báo `account.verify` cho một lần chạy chưa hề mở
 * kết nối nào: người vận hành đọc log phải phân biệt được "input sai" với "bước
 * preflight thất bại".
 */
export const INPUT_STAGE = 'input';

/**
 * `operator_ref` phải là định danh ASCII trong tập chữ, số, `_` và `-`, bắt đầu
 * bằng chữ hoặc số: ADR-0021 Quyết định 6 bắt buộc audit mang một tham chiếu
 * người thực thi, và charset thu hẹp giữ audit row và stage log sạch.
 *
 * Kiểm **trước** preflight là bắt buộc, không phải thuận tiện: A1 commit trước
 * khi S1/S2 chạy, nên để `staff-access` từ chối `operator_ref_missing` ở S1 nghĩa
 * là procedure đã tạo một Account mà không có attribution nào trong audit. Cùng
 * luật phải đúng ở cả hai phía — `account` cũng từ chối `operator_ref` rỗng.
 */
export function assertOperatorRef(raw: string): string {
  const operatorRef = raw.trim();
  if (operatorRef === '') {
    throw new Error(
      'operator-ref is required: the audit trail must carry an operator reference (ADR-0021 decision 6). Pass --operator-ref <change/ticket id>.',
    );
  }
  // Chỉ mã máy đọc tới được nhật ký và audit row: một chuỗi có khoảng trắng,
  // xuống dòng hay ký tự điều khiển sẽ làm hỏng cả hai bề mặt đó.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(operatorRef)) {
    throw new Error(
      'operator-ref must be an ASCII identifier such as a ticket or change id (letters, digits, _ and - only, starting with a letter or digit).',
    );
  }
  return operatorRef;
}

/**
 * Assert địa chỉ bootstrap canonical.
 *
 * Cấu hình environment chỉ được **assert** lại hằng, không bao giờ thay nó
 * (ADR-0021 Quyết định 1). Hàm này chỉ `trim()` + `toLowerCase()` — cùng phép
 * chuẩn hoá của `normalizeEmailAddress`, viết lại tại đây vì runner `type:
 * tooling` không được import code của service; nó là lớp fail-fast, không phải
 * đường ghi.
 */
export function assertCanonicalBootstrapEmail(raw: string | undefined): void {
  if (raw === undefined) return;
  const normalized = raw.trim().toLowerCase();
  if (normalized !== BOOTSTRAP_EMAIL) {
    throw new Error(
      `ECOMA_BOOTSTRAP_EMAIL must assert the canonical address ${BOOTSTRAP_EMAIL}; refusing to run with a different address.`,
    );
  }
}

/**
 * Chạy procedure theo đúng thứ tự, truyền `sub` giữa các bước và dừng ở bước
 * fail. Không có nhánh sửa chữa, xoá hay cấp lại quyền.
 *
 * Giao theo chế độ chạy rõ ràng: `'resolve-or-bootstrap'` nhận lần giải quyết
 * chỉ đọc trước (xem {@link runResolveOrBootstrap}); `'bootstrap'` chạy
 * {@link runBootstrapProcedure} — phần body lịch sử giữ nguyên từng byte một,
 * nên hợp đồng guard đã đo lường (#17/#22) không thể trôi qua refactor này.
 */
export function runBootstrapSuperadmin(options: BootstrapRunOptions): BootstrapRunResult {
  if (options.mode === 'resolve-or-bootstrap') {
    return runResolveOrBootstrap(options);
  }
  return runBootstrapProcedure(options);
}

/**
 * Chế độ resolve-or-bootstrap: một lần preflight chỉ đọc quyết định nhánh.
 *
 * - Tài khoản bootstrap CÓ MẶT (`account.verify` ok với `sub`): chỉ chạy stage
 *   `staff-verify` chỉ đọc duy nhất của chủ thể đó. Xác thực → `'resolved'`.
 *   Bất kỳ thất bại nào của lần đọc → `'failed'`, fail-closed — nhánh này
 *   không chứa bước ghi nào, thậm chí cả khi thất bại.
 * - Mới (`no_bootstrap_account`): ủy quyền cho {@link runBootstrapProcedure}
 *   không đổi — bao gồm cả preflight đọc lại của chính nó, nên đường ghi có
 *   guard là đúng cùng đoạn mã với chế độ `'bootstrap'` (lần preflight thêm
 *   vào chỉ đọc và idempotent). Procedure được ủy quyền tự xác thực
 *   `operatorRef` trước khi chạm bất cứ gì: một môi trường mới không được
 *   bootstrap nếu thiếu tham chiếu ghi nhận (ADR-0021 Quyết định 6).
 * - Bất kỳ thất bại preflight khác (`account_database_not_empty`, lỗi hạ
 *   tầng): `'failed'`, một bước đã chạm.
 */
function runResolveOrBootstrap(options: BootstrapRunOptions): BootstrapRunResult {
  const { correlationId, runStage } = options;
  const stages: BootstrapStageLogEntry[] = [];

  const fail = (stage: string, reason: string): BootstrapRunResult => {
    stages.push({ stage, outcome: 'failed', detail: reason });
    return { outcome: 'failed', correlationId, failedStage: stage, reason, stages };
  };

  const preflight = runStage({
    service: 'account',
    action: 'verify',
    input: { correlation_id: correlationId },
  });

  if (preflight.ok) {
    const sub = asString(preflight.payload['sub']);
    if (sub === undefined) {
      // Verify ok mà không có chủ thể là vi phạm hợp đồng của CLI service,
      // không phải trạng thái giải quyết được: fail-closed mà không ghi.
      return fail(preflight.stage, 'missing_sub_in_response');
    }
    stages.push({
      stage: preflight.stage,
      outcome: 'converged',
      detail: 'bootstrap account present',
    });

    // Bằng chứng chỉ đọc, cùng hình dạng với S3 của procedure trừ audit-row:
    // đúng chủ thể này, xác thực qua staff-access. KHÔNG truyền `correlation_id`:
    // kiểm 5 của `staff.verify` đòi audit row `staff.provision`/`staff.assign`
    // của chính lần chạy mang correlation id đó — một lần resolve không có lần
    // ghi nào của mình, nên correlation id mới luôn thiếu audit row và mọi môi
    // trường đã hội tụ sẽ fail `audit_trail_missing` vĩnh viễn. Vắng
    // `correlation_id`, S3 bỏ kiểm 5 theo hợp đồng của service và vẫn xác thực
    // staff/assignment/role/permissions (kiểm 1–4). Không có provision/assign
    // trên nhánh này — một môi trường đã hội tụ không bao giờ được cấp lại.
    const verification = runStage({
      service: 'staff-access',
      action: 'staff-verify',
      input: { sub },
    });
    if (!verification.ok) return fail(verification.stage, verification.reason);
    stages.push({ stage: verification.stage, outcome: 'verified' });

    const staffId = asString(verification.payload['staff_id']);
    return {
      outcome: 'resolved',
      correlationId,
      sub,
      ...(staffId === undefined ? {} : { staffId }),
      stages,
    };
  }

  if (preflight.reason !== 'no_bootstrap_account') {
    // Fail-fast giống preflight của chế độ bootstrap: một tài khoản khác hoặc
    // lỗi hạ tầng dừng lần chạy trước khi có ghi nào.
    return fail(preflight.stage, preflight.reason);
  }

  stages.push({ stage: preflight.stage, outcome: 'fresh', detail: 'no bootstrap account yet' });
  return runBootstrapProcedure(options);
}

/**
 * Toàn bộ procedure bootstrap — phần body lịch sử của
 * {@link runBootstrapSuperadmin}, không đổi, được dùng chung bởi chế độ
 * `'bootstrap'` và nhánh mới của `'resolve-or-bootstrap'` nên bộ điều khiển đã
 * đo lường (ADR-0022) chỉ có một cách triển khai.
 */
function runBootstrapProcedure(options: BootstrapRunOptions): BootstrapRunResult {
  const { correlationId, operatorRef, runStage } = options;
  const stages: BootstrapStageLogEntry[] = [];
  const log = (entry: BootstrapStageLogEntry): void => {
    stages.push(entry);
  };

  // `failed` là lỗi thực thi, khác `denied` của guard: nhật ký phải giữ đúng
  // phân biệt đó, nếu không người vận hành đọc log sẽ nhầm một lỗi hạ tầng với
  // một lần guard từ chối có chủ đích.
  const fail = (stage: string, reason: string): BootstrapRunResult => {
    log({ stage, outcome: 'failed', detail: reason });
    return { outcome: 'failed', correlationId, failedStage: stage, reason, stages };
  };

  // Input được kiểm trước mọi lần chạm database: A1 commit trước S1/S2, nên một
  // `operator_ref` rỗng bị phát hiện muộn sẽ để lại Account không attribution.
  let validatedOperatorRef: string;
  try {
    validatedOperatorRef = assertOperatorRef(operatorRef);
  } catch {
    return fail(
      INPUT_STAGE,
      operatorRef.trim() === '' ? 'operator_ref_missing' : 'operator_ref_invalid',
    );
  }

  // Preflight — A2 read-only trước A1. Database đã có Account khác thì dừng
  // ngay, để không tạo thêm một Account mồ côi rồi mới bị guard từ chối.
  const preflight = runStage({
    service: 'account',
    action: 'verify',
    input: { correlation_id: correlationId },
  });
  if (preflight.ok) {
    log({
      stage: preflight.stage,
      outcome: 'converged',
      detail:
        typeof preflight.payload['sub'] === 'string' ? 'bootstrap account present' : undefined,
    });
  } else if (preflight.reason === 'no_bootstrap_account') {
    log({ stage: preflight.stage, outcome: 'fresh', detail: 'no bootstrap account yet' });
  } else {
    // Gồm `account_database_not_empty`: một Account khác đã tồn tại, nên
    // procedure không được bắt đầu. Đây là fail-fast, không phải guard chính.
    return fail(preflight.stage, preflight.reason);
  }

  // A1 — create-or-resolve. Hội tụ trên Account do bootstrap trước tạo, hoặc
  // tạo mới khi database còn trống.
  const provision = runStage({
    service: 'account',
    action: 'provision',
    input: { correlation_id: correlationId, operator_ref: validatedOperatorRef },
  });
  if (!provision.ok) return fail(provision.stage, provision.reason);
  const provisionedSub = asString(provision.payload['sub']);
  if (provisionedSub === undefined) {
    return fail(provision.stage, 'missing_sub_in_response');
  }
  log({ stage: provision.stage, outcome: provision.status });

  // A2 — đọc lại và xác nhận đúng `sub` vừa tạo/hội tụ.
  const verify = runStage({
    service: 'account',
    action: 'verify',
    input: { correlation_id: correlationId },
  });
  if (!verify.ok) return fail(verify.stage, verify.reason);
  const verifiedSub = asString(verify.payload['sub']);
  if (verifiedSub !== provisionedSub) {
    return fail(verify.stage, 'sub_mismatch');
  }
  log({ stage: verify.stage, outcome: 'verified' });

  // S1 — staff identity. Guard đo `admins_before`/`admins_ever` trong chính
  // transaction này; `mode_mismatch` nghĩa là bootstrap đã hoàn tất từ trước.
  const staff = runStage({
    service: 'staff-access',
    action: 'staff-provision',
    input: {
      correlation_id: correlationId,
      operator_ref: validatedOperatorRef,
      sub: verifiedSub,
    },
  });
  if (!staff.ok) {
    if (staff.reason === 'mode_mismatch') {
      return finishGuardDenied(stages, correlationId, verifiedSub, runStage, staff.stage);
    }
    return fail(staff.stage, staff.reason);
  }
  const staffId = asString(staff.payload['staff_id']);
  if (staffId === undefined) {
    return fail(staff.stage, 'missing_staff_id_in_response');
  }
  log({ stage: staff.stage, outcome: staff.status });

  // S2 — assignment của role canonical. Đo lại từ đầu: đây là bước chặn hai
  // lần chạy đồng thời cùng trở thành administrator.
  const assign = runStage({
    service: 'staff-access',
    action: 'staff-assign',
    input: {
      correlation_id: correlationId,
      operator_ref: validatedOperatorRef,
      sub: verifiedSub,
    },
  });
  if (!assign.ok) {
    if (assign.reason === 'mode_mismatch') {
      return finishGuardDenied(stages, correlationId, verifiedSub, runStage, assign.stage);
    }
    return fail(assign.stage, assign.reason);
  }
  const assignmentId = asString(assign.payload['assignment_id']);
  if (assignmentId === undefined) {
    return fail(assign.stage, 'missing_assignment_id_in_response');
  }
  log({ stage: assign.stage, outcome: assign.status });

  // S3 — chỉ đọc, sau khi đã ghi xong.
  const verification = runStage({
    service: 'staff-access',
    action: 'staff-verify',
    input: { correlation_id: correlationId, sub: verifiedSub },
  });
  if (!verification.ok) return fail(verification.stage, verification.reason);
  log({ stage: verification.stage, outcome: 'verified' });

  return {
    outcome: 'bootstrapped',
    correlationId,
    sub: verifiedSub,
    staffId,
    assignmentId,
    stages,
  };
}

/**
 * Nhánh "guard từ chối". Guard từ chối (`mode_mismatch`) là hành vi đúng khi
 * environment đã từng có administrator (ADR-0022 Quyết định 3): procedure
 * không có nhánh cấp lại quyền. Bước bị từ chối không ghi dữ liệu nghiệp vụ,
 * nên procedure chạy S3 để trả bằng chứng đọc được rồi báo `guard_denied` —
 * không báo `bootstrapped`, vì không có bước ghi nào đã thành công.
 *
 * S3 ở đây chỉ là **chẩn đoán**: sau một lần bị từ chối, phép đọc lại có thể
 * thấy trạng thái administrator hiện có, hoặc cũng có thể fail. Fail vì lần chạy
 * của chúng ta chưa từng ghi gì là kết quả *bình thường* của nhánh này; fail vì
 * lỗi thực thi (`database_unreachable`, `stage_timeout`) thì **không** phải một
 * lần từ chối — nhật ký phải ghi `failed`, nếu không người vận hành đọc log sẽ
 * nhầm lỗi hạ tầng với kết luận của guard (cùng lý do với `failed` ở trên).
 * Cả hai trường hợp đều không đổi kết luận `guard_denied`, vì từ chối của guard
 * mới là lý do dừng.
 */
function finishGuardDenied(
  stages: BootstrapStageLogEntry[],
  correlationId: string,
  sub: string,
  runStage: BootstrapStageRunner,
  deniedStage: string,
): BootstrapRunResult {
  stages.push({
    stage: deniedStage,
    outcome: 'denied',
    detail: 'mode_mismatch: measured administrators are non-zero; this step wrote nothing',
  });
  const verification = runStage({
    service: 'staff-access',
    action: 'staff-verify',
    input: { correlation_id: correlationId, sub },
  });
  if (verification.ok) {
    stages.push({ stage: verification.stage, outcome: verification.status });
  } else {
    // Chẩn đoán chạy được nhưng không xác nhận được trạng thái (ví dụ lần chạy
    // này chưa từng ghi gì) — đó là quan sát, không phải lỗi thực thi. Tách hai
    // trường hợp bằng những mã chỉ lỗi hạ tầng mới sinh ra.
    const infrastructureFailure = isInfrastructureFailure(verification.reason);
    stages.push({
      stage: verification.stage,
      outcome: infrastructureFailure ? 'failed' : 'denied',
      detail: verification.reason,
    });
  }
  return { outcome: 'guard_denied', correlationId, sub, stages };
}

/**
 * Mã lý do chỉ xuất hiện khi bước không chạy được, không phải khi bước chạy và
 * kết luận "không có gì để xác nhận". `database_url_missing`/`spawn_failed` mang
 * hậu tố nên được so bằng tiền tố.
 */
const DIAGNOSTIC_INFRASTRUCTURE_FAILURES: ReadonlySet<string> = new Set([
  'database_unreachable',
  'stage_timeout',
  'output_limit_exceeded',
  'missing_json_response',
  'malformed_json_response',
  'service_failed',
  'internal_error',
]);

function isInfrastructureFailure(reason: string): boolean {
  return (
    reason.startsWith('spawn_failed') ||
    reason.startsWith('database_url_missing') ||
    DIAGNOSTIC_INFRASTRUCTURE_FAILURES.has(reason)
  );
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
