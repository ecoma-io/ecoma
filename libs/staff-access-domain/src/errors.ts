/**
 * Taxonomy loi cua tang domain `staff-access`.
 *
 * Pattern: `libs/account-domain/src/errors.ts` va
 * `libs/backoffice-domain/src/errors.ts` — mot domain error chi mang `code`
 * on dinh + `message` ngan gon, khong field nao cho identifier/token/secret
 * hay payload tuy y.
 *
 * Rang buoc nguon o phia `staff-access`:
 * - invariant 7 (`docs/domains/staff-access/domain-model.md` §9): audit
 *   record KHONG chua token/secret/PII.
 * - invariant 35 (`docs/architecture/01-architecture.md` §9): khong bi mat
 *   dung canh actor/target/action.
 *
 * Mot error object di thang ra log, ra response BFF va ra authorization
 * audit — no la noi de ro nhat vi no mang theo "ngu canh" cua loi. Cho phep
 * mang `sub` hay payload trong error message la bien log thanh kenh thu thap
 * identifier khong co kiem soat.
 *
 * Vi vay type `StaffAccessDomainErrorCode` la union dong va
 * `StaffAccessDomainError` khong co cho cho payload. Muon them ngu canh cho
 * viec chan doan thi them ma moi vao taxonomy, khong gan du lieu vao ma cu.
 */

/** Ma loi on dinh — contract voi consumer, khong doi nghia theo thoi gian. */
export type StaffAccessDomainErrorCode =
  | 'invalid_staff_id'
  | 'invalid_staff_status'
  | 'staff_terminated'
  | 'staff_suspended'
  | 'staff_not_found'
  | 'role_not_found'
  | 'permission_not_in_catalog'
  | 'invalid_assignment_window'
  | 'invalid_entitlement_revision'
  | 'invalid_transition';

/**
 * Message cua tung ma — bang doc nguon duy nhat cua factory. Message la
 * ENGLISH theo language policy cua repo (runtime string khong viet Vietnamese;
 * ruling 2026-10-25 ap dung cho DOMAIN_ERROR_MESSAGES cua moi domain).
 */
export const STAFF_ACCESS_DOMAIN_ERROR_MESSAGES: Record<StaffAccessDomainErrorCode, string> = {
  invalid_staff_id: 'Staff ID is not valid.',
  invalid_staff_status: 'Staff status is not valid.',
  staff_terminated: 'Staff membership has been terminated.',
  staff_suspended: 'Staff membership is suspended.',
  staff_not_found: 'Staff entry not found.',
  role_not_found: 'Role not found.',
  permission_not_in_catalog: 'Permission is not in the catalog.',
  invalid_assignment_window: 'The validity window of the assignment is not valid.',
  invalid_entitlement_revision: 'The entitlement revision is not valid.',
  invalid_transition: 'The state transition is not valid.',
};

/** Error domain: `code` on dinh + `message` ngan gon. */
export interface StaffAccessDomainError {
  readonly code: StaffAccessDomainErrorCode;
  readonly message: string;
}

/**
 * Dung domain error. Constructor duy nhat cua taxonomy: chi ghep `code` voi
 * message lay tu `STAFF_ACCESS_DOMAIN_ERROR_MESSAGES`, khong co cho nao lot
 * du lieu call site.
 * @throws TypeError neu `code` khong co trong taxonomy.
 */
export function staffAccessDomainError(code: StaffAccessDomainErrorCode): StaffAccessDomainError {
  // `Object.hasOwn` thay vi chi so mang thang: lookup ke thua tu
  // `Object.prototype` (`'toString'`) tra ve mot function thay vi `undefined`,
  // khi do factory se discard `code` thay vi nem. Guard o duoi
  // (`isStaffAccessDomainError`) cung dung `Object.hasOwn`; factory phai an
  // khop cac huong do de cung mot `code` la bi tu choi tu ca hai phia.
  const message = Object.hasOwn(STAFF_ACCESS_DOMAIN_ERROR_MESSAGES, code)
    ? STAFF_ACCESS_DOMAIN_ERROR_MESSAGES[code]
    : undefined;
  if (message === undefined) {
    throw new TypeError(`Staff Access domain error code is not valid: ${String(code)}`);
  }
  return { code, message };
}

/**
 * Type guard: co phai object mang `code` thuoc taxonomy khong.
 *
 * Dung `Object.hasOwn`, khong dung `in`: `in` di ca prototype chain, nen
 * `'toString' in STAFF_ACCESS_DOMAIN_ERROR_MESSAGES` la `true` (ke thua tu
 * `Object.prototype`) va guard se nhan `{ code: 'toString' }` la domain error
 * hop le — trong khi `staffAccessDomainError('toString')` lai nem `TypeError`.
 * Hai huong nguoc nhau tren cung taxonomy la cua lach kiem dau vao.
 */
export function isStaffAccessDomainError(value: unknown): value is StaffAccessDomainError {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  // Shape khung: chi dung hai field `code` + `message` — object co them field
  // (payload don vao tu call site) khong phai domain error, giong ket qua ma
  // factory tao ra (khong co cho cho payload).
  const ownKeys = Object.keys(value);
  if (ownKeys.length !== 2 || !ownKeys.includes('code') || !ownKeys.includes('message')) {
    return false;
  }
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' && Object.hasOwn(STAFF_ACCESS_DOMAIN_ERROR_MESSAGES, code);
}
