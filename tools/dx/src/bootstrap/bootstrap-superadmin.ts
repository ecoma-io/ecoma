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
 */
export interface BootstrapRunResult {
  readonly outcome: 'bootstrapped' | 'guard_denied' | 'failed';
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

/** Đầu vào của một lần chạy. */
export interface BootstrapRunOptions {
  readonly correlationId: string;
  /** Tham chiếu người thực thi (ticket/change id) — attribution tự khai. */
  readonly operatorRef: string;
  readonly runStage: BootstrapStageRunner;
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
 */
export function runBootstrapSuperadmin(options: BootstrapRunOptions): BootstrapRunResult {
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
    input: { correlation_id: correlationId, operator_ref: operatorRef },
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
    input: { correlation_id: correlationId, operator_ref: operatorRef, sub: verifiedSub },
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
    input: { correlation_id: correlationId, operator_ref: operatorRef, sub: verifiedSub },
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
    input: { correlation_id: correlationId },
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
 * không có nhánh cấp lại quyền. Lần chạy này không ghi dữ liệu nghiệp vụ, nên
 * nó chạy S3 để trả bằng chứng đọc được rồi báo `guard_denied` — không báo
 * `bootstrapped`, vì không có bước ghi nào đã thành công.
 *
 * S3 ở đây chỉ là **chẩn đoán**: sau một lần bị từ chối, phép đọc lại có thể
 * thấy trạng thái administrator hiện có, hoặc cũng có thể fail vì lần chạy của
 * chúng ta chưa từng ghi gì. Cả hai trường hợp đều không đổi kết luận — từ chối
 * của guard mới là lý do dừng, và exit code vẫn khác 0 — nên kết quả vẫn là
 * `guard_denied` và kết quả S3 chỉ đi vào nhật ký.
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
    detail: 'mode_mismatch: measured administrators are non-zero; no writes performed',
  });
  const verification = runStage({
    service: 'staff-access',
    action: 'staff-verify',
    input: { correlation_id: correlationId },
  });
  stages.push(
    verification.ok
      ? { stage: verification.stage, outcome: verification.status }
      : { stage: verification.stage, outcome: 'denied', detail: verification.reason },
  );
  return { outcome: 'guard_denied', correlationId, sub, stages };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
