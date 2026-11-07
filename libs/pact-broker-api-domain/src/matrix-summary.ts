/**
 * Matrix / can-i-deploy summary, hình dạng theo reference Pact Broker.
 *
 * Wording lấy nguyên từ reference implementation để client đọc
 * `summary.reason` thấy cùng câu như Ruby broker:
 *   - reasons              lib/pact_broker/api/decorators/reason_decorator.rb
 *   - selector descriptions lib/pact_broker/matrix/resolved_selector.rb
 *
 * Reference nối mọi reason áp dụng bằng "\n" (matrix_decorator.rb); không bao
 * giờ báo một cái rồi bỏ các cái còn lại.
 *
 * Port gần nguyên xi từ upstream `src/services/matrix-summary.ts` (REUSE).
 */

/** Cách một mũi nhọn `to` được resolve, khi có yêu cầu. */
export interface SummaryTarget {
  type: 'tag' | 'branch' | 'environment';
  value: string;
  resolved: boolean;
}

/** Một integration, dẹt xuống những gì summary cần mô tả. */
export interface SummaryRow {
  consumer: { name: string; version: string | null };
  provider: { name: string; version: string | null; target?: SummaryTarget };
  /** `null` nghĩa là "không có kết quả verify" — i.e. chưa biết — không phải "thất bại". */
  success: boolean | null;
}

export interface MatrixSummary {
  /**
   * Tri-state, theo deployment_status_summary.rb#deployable?: `false` chỉ khi
   * có thứ gì đó chắc chắn sai, `null` khi còn gì chưa biết, `true` trong
   * trường hợp còn lại. "Chưa được verify" và "verify thất bại" là hai fact
   * khác nhau.
   */
  deployable: boolean | null;
  reason: string;
  /** Tên key phản chiếu deployment_status_summary.rb#counts. */
  success: number;
  failed: number;
  unknown: number;
}

/** `version 1.0.0 of foo` / `any version of foo` — resolved_selector.rb#description */
function describeSelector(selector: { name: string; version: string | null }): string {
  if (selector.version) {
    return `version ${selector.version} of ${selector.name}`;
  }
  return `any version of ${selector.name}`;
}

/**
 * Mô tả phía provider của truy vấn, kể cả việc target `to` có resolve không.
 * Đuôi "(no such version exists)" là thứ bảo người đọc rằng target không khớp
 * gì cả, thay vì "chưa ai verify pact này" — sự phân biệt từng khiến một
 * verification thất bại bị đọc như một cái vắng mặt.
 */
function describeProvider(provider: SummaryRow['provider']): string {
  const { name, version, target } = provider;
  if (!target) return describeSelector({ name, version: null });

  switch (target.type) {
    case 'environment':
      return target.resolved
        ? `the version of ${name} currently in ${target.value} (${version})`
        : `a version of ${name} currently in ${target.value} ` +
            `(no version is currently recorded as deployed/released in this environment)`;
    case 'branch':
      return target.resolved
        ? `the latest version of ${name} from branch ${target.value} (${version})`
        : `the latest version of ${name} from branch ${target.value} (no such version exists)`;
    default:
      return target.resolved
        ? `the latest version of ${name} with tag ${target.value} (${version})`
        : `the latest version of ${name} with tag ${target.value} (no such version exists)`;
  }
}

/**
 * Dẹt matrix rows xuống những gì summary cần. Type theo cấu trúc thay vì
 * chống lại `MatrixRowData` để module này không tạo import cycle với
 * `types.ts`.
 */
export function toSummaryRows(
  rows: Array<{
    consumer: { name: string; version: { number: string } };
    provider: { name: string; version: { number: string } | null; target?: SummaryTarget };
    verification?: { success: boolean } | null;
  }>,
): SummaryRow[] {
  return rows.map((row) => ({
    consumer: { name: row.consumer.name, version: row.consumer.version.number },
    provider: {
      name: row.provider.name,
      version: row.provider.version?.number ?? null,
      ...(row.provider.target ? { target: row.provider.target } : {}),
    },
    success: row.verification ? row.verification.success : null,
  }));
}

/** matrix_decorator.rb#notices — reason.type là `error` cho ErrorReason, không thì `info`. */
export interface MatrixNotice {
  type: 'error' | 'info';
  text: string;
}

export function summarizeMatrix(rows: SummaryRow[]): {
  summary: MatrixSummary;
  notices: MatrixNotice[];
} {
  const reasons: MatrixNotice[] = [];
  const counts = {
    success: rows.filter((r) => r.success === true).length,
    failed: rows.filter((r) => r.success === false).length,
    unknown: rows.filter((r) => r.success === null).length,
  };

  for (const row of rows.filter((r) => r.success === false)) {
    reasons.push({
      type: 'error',
      text:
        `The verification for the pact between ${describeSelector(row.consumer)} and ` +
        `${describeProvider(row.provider)} failed`,
    });
  }

  for (const row of rows.filter((r) => r.success === null)) {
    reasons.push({
      type: 'error',
      text:
        `There is no verified pact between ${describeSelector(row.consumer)} and ` +
        describeProvider(row.provider),
    });
  }

  if (reasons.length === 0) {
    reasons.push({
      type: 'info',
      text:
        rows.length === 0
          ? 'There are no missing dependencies'
          : 'All required verification results are published and successful',
    });
  }

  const deployable = counts.failed > 0 ? false : counts.unknown > 0 ? null : true;

  return {
    summary: { deployable, reason: reasons.map((r) => r.text).join('\n'), ...counts },
    notices: reasons,
  };
}
