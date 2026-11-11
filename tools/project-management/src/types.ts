/**
 * Kiểu dữ liệu dùng chung của pipeline reconcile Project membership.
 *
 * Pipeline gồm các stage: discover → audit → plan → apply → verify → report.
 * Các stage thuần (classify, audit, plan, diff) chỉ tiêu thụ các type này nên
 * mọi quyết định đều test được mà không chạm GitHub.
 */

/** Trạng thái lifecycle của một GitHub issue, đúng giá trị GraphQL API trả về. */
export type IssueState = 'OPEN' | 'CLOSED';

/** Một issue của repository đã chuẩn hóa cho pipeline reconcile. */
export interface NormalizedIssue {
  number: number;
  nodeId: string;
  title: string;
  state: IssueState;
  authorLogin: string;
  /**
   * Luôn `false` cho dữ liệu do port này thu thập: port chỉ discover issue
   * (chỉ mục tiêu policy là issue); PR chỉ xuất hiện ở bước audit khi nó có
   * mặt trong Project với tư cách item.
   */
  isPullRequest: boolean;
  /** Số issue cha khi đây là sub-issue, ngược lại `null`. */
  parentNumber: number | null;
  /**
   * Số các sub-issue trực tiếp. Port thật không query sub-issues nên luôn để
   * mảng rỗng — field này giữ chỗ cho policy/future use, xem README hạn chế.
   */
  subIssueNumbers: number[];
  labels: string[];
  milestoneNumber: number | null;
}

/** Loại content của một item trong GitHub Project V2. */
export type ProjectItemContentType = 'ISSUE' | 'PULL_REQUEST' | 'DRAFT_ISSUE';

/** Một item trong snapshot của GitHub Project. */
export interface ProjectItemRecord {
  itemId: string;
  contentType: ProjectItemContentType;
  /** Số của content khi nó có số (Issue/PullRequest), ngược lại `null` (DraftIssue). */
  contentNumber: number | null;
  isArchived: boolean;
}

/** Nhóm rule loại trừ: issue vi phạm nhóm nào thì không được là member. */
export interface PolicyExclusions {
  issueNumbers: number[];
  botAuthorSuffix: string;
  titlePrefixes: string[];
}

/** Membership policy nạp từ `config/membership-policy.json`. */
export interface PolicyConfig {
  projectNumber: number;
  exclusions: PolicyExclusions;
}

/** Chế độ reconcile: `audit` không bao giờ mutation, `apply` mutation rồi verify. */
export type ReconciliationMode = 'audit' | 'apply';
