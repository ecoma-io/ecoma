/**
 * Use case can-i-deploy — verdict fail-closed (DOM-02) cho matrix rỗng.
 *
 * Fail-closed bổ sung so với upstream: upstream để matrix rỗng đi qua
 * summarizeMatrix([]) → deployable true ("no missing dependencies"). Hai
 * tình huống rỗng đều fail-OPEN theo §6 (unknown không bao giờ là safe):
 *  * selector không khớp version/pacticipant nào — version gõ sai thấy xanh;
 *  * version tồn tại nhưng chưa publish pact nào — version chưa từng được
 *    contract-test vẫn thấy xanh.
 * Cả hai ép deployable null kèm reason nói rõ tình huống.
 *
 * Route HTTP chỉ truyền data thô từ repo (`rows`, `consumerVersionExists`) và
 * selector đã validate vào đây, rồi map kết quả ra HAL — quyết định
 * deployability thuộc application layer, không thuộc HTTP mapping.
 */
import type { MatrixNotice, MatrixRowData, MatrixSummary } from '@ecoma-io/pact-broker-api-domain';
import { summarizeMatrix, toSummaryRows } from '@ecoma-io/pact-broker-api-domain';

/** Input của `evaluateCanIDeploy` — data repo + selector đã qua validation. */
export interface CanIDeployInput {
  /** Matrix rows repo trả về cho selector của request. */
  rows: MatrixRowData[];
  /** Tên pacticipant đã qua `nameSchema`. */
  pacticipant: string;
  /** Version number đã qua `versionSchema`. */
  version: string;
  /** Repo xác nhận selector khớp một version/pacticipant thật dù matrix rỗng. */
  consumerVersionExists: boolean;
}

/** Kết quả evaluation — route map thẳng ra body `{summary, notices}`. */
export interface CanIDeployEvaluation {
  summary: MatrixSummary;
  notices: MatrixNotice[];
}

/**
 * Quyết định verdict can-i-deploy: matrix rỗng fail-closed thành
 * `deployable: null` với reason phân biệt "version không tồn tại" khỏi
 * "version tồn tại nhưng chưa publish pact nào"; matrix có hàng thì delegate
 * `summarizeMatrix` của domain (tri-state chuẩn upstream).
 */
export function evaluateCanIDeploy(input: CanIDeployInput): CanIDeployEvaluation {
  const { rows, pacticipant, version, consumerVersionExists } = input;

  const noVerifications =
    rows.length === 0
      ? consumerVersionExists
        ? `Version ${version} of ${pacticipant} exists but has no ` +
          `pacts published — no verification can exist, deployability is unknown`
        : `There is no version ${version} of ${pacticipant} ` +
          `(or no pact published for it) — cannot determine deployability`
      : null;

  return noVerifications !== null
    ? {
        summary: {
          deployable: null,
          reason: noVerifications,
          success: 0,
          failed: 0,
          unknown: 1,
        },
        notices: [{ type: 'error' as const, text: noVerifications }],
      }
    : summarizeMatrix(toSummaryRows(rows));
}
