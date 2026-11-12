/**
 * Model finding của readme-check và hai định dạng đầu ra của nó.
 *
 * Một finding = một vi phạm trên đúng một dòng của một README thuộc một project.
 * Mọi định danh (code) là hằng chuỗi tiếng Anh ổn định — CI gate ở tương lai
 * (Issue #135) và người sửa README đều đọc code, không đọc văn bản message, nên
 * code không được đổi tự do. Message và hint là chuỗi runtime: tiếng Anh theo
 * language policy.
 */

/** Một vi phạm contract README, gắn với project, file và dòng gây ra nó. */
export interface ReadmeFinding {
  /** Tên Nx project sở hữu README bị vi phạm. */
  project: string;
  /** Đường dẫn README tương đối so với repo root (luôn là README của project). */
  file: string;
  /**
   * Dòng 1-based gây ra vi phạm; `0` khi vi phạm ở cấp file (README vắng, rỗng,
   * không phải file thường) và không có dòng nào để chỉ vào.
   */
  line: number;
  /** Mã vi phạm ổn định (vd `missing-section`) — định danh máy đọc được. */
  code: string;
  /** Nguyên nhân, tiếng Anh, nêu đúng cái sai. */
  message: string;
  /** Gợi ý sửa cụ thể, tiếng Anh. */
  hint: string;
}

/** Tổng kết một lần chạy: số project, số finding và số link ngoài đã bỏ qua. */
export interface ReadmeCheckSummary {
  /** Số Nx project đã được kiểm (kể cả project chỉ có finding `missing-readme`). */
  projects: number;
  /** Tổng số finding. */
  findings: number;
  /** Số link ngoài (scheme `http:`, `mailto:`, ...) đã phát hiện và bỏ qua, KHÔNG fetch. */
  externalLinks: number;
}

/** Kết quả đầy đủ một lần chạy checker. */
export interface ReadmeCheckResult {
  findings: readonly ReadmeFinding[];
  summary: ReadmeCheckSummary;
}

/**
 * Thứ tự tất định: project → file → dòng → code → message.
 *
 * Hai khóa cuối chỉ dùng để phân định hai finding cùng dòng (vd hai link trên
 * một dòng); không có chúng, thứ tự phụ thuộc thứ tự duyệt Map — rò rỉ thứ tự
 * iterator vào output. Sort là total order nên hai lần chạy cùng input cho cùng
 * một chuỗi output.
 */
export function sortFindings(findings: readonly ReadmeFinding[]): ReadmeFinding[] {
  // Bản sao mình sở hữu → sort tại chỗ được phép (target es2022 chưa có
  // `toSorted`, cùng lý do như `deployment-map-check.ts` và
  // `worker-discovery.ts`). Mảng gốc của người gọi không bị mutate.
  const sorted = [...findings];
  sorted.sort(
    (a, b) =>
      a.project.localeCompare(b.project) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.code.localeCompare(b.code) ||
      a.message.localeCompare(b.message),
  );
  return sorted;
}

/** Một dòng văn bản cho finding — định dạng người đọc mặc định của `pnpm dx readme-check`. */
export function formatFinding(finding: ReadmeFinding): string {
  const location = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;
  return `${finding.project} ${location} [${finding.code}] ${finding.message} Fix: ${finding.hint}`;
}
