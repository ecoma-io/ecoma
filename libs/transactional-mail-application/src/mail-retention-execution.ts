import type { MailRetentionQueries } from './mail-retention-queries';

/**
 * Chu kỳ retention của control plane — FR-007 (`02-requirements.md`).
 *
 * Chạy trong scheduled handler của chính `transactional-mail` (pha 4 của bốn pha —
 * `src/main.ts` của app; cùng cron với publish/reconciler). Lần deploy đầu chưa chạy được
 * vì chưa provisioning D1/Queue và app nằm ngoài deploy matrix — việc "đã xác minh trên
 * runtime" là gate vận hành, không phải việc của module này.
 */

/** Dependency của {@link runRetentionCycle}. */
export type MailRetentionDeps = {
  /** Hai list method + {@link MailRetentionQueries.redactContent}. */
  readonly retention: MailRetentionQueries;
  /**
   * Nơi phát alert — inject để test quan sát được, composition root wire `console`.
   *
   * ⚠️ `MailRetentionAlert` không mang subject/body/recipient. `retention-content-redacted`
   * chỉ mang **số lượng** row đã xoá content — đó là thứ duy nhất operator cần để biết
   * chính sách retention có đang chạy không.
   */
  readonly logAlert: (event: MailRetentionAlert) => void;
};

/**
 * Alert của chu kỳ retention.
 *
 * `retention-stale-non-terminal` mang `deliveryId` + `status` + `ageMs` — đều là metadata
 * đã whitelist (`03-operations.md` §6). **Không** có content: một delivery non-terminal
 * tồn đọng còn giữ content để điều tra, và alert không được làm lộ nó.
 */
export type MailRetentionAlert =
  | { readonly event: 'retention-content-redacted'; readonly count: number }
  | {
      readonly event: 'retention-stale-non-terminal';
      readonly deliveryId: string;
      readonly status: string;
      readonly ageMs: number;
    };

/**
 * Ngưỡng retention — **giá trị truyền vào**, không hằng trong module.
 *
 * ⚠️ Giá trị "7 ngày" trong `02-requirements.md` FR-007 là **đề xuất cần validate**, không
 * phải cam kết compliance — tài liệu ghi rõ phải đối chiếu yêu cầu privacy/business của Ecoma
 * trước khi chốt. Vì vậy module này **không** hằng hoá 7 ngày ở đâu cả: composition root đọc
 * từ env và truyền vào, đổi thì đổi config chứ không phải sửa code.
 *
 * `contentOlderThanMs` và `staleOlderThanMs` là hai ngưỡng **tách biệt** vì chúng phục vụ hai
 * chính sách khác nhau: một là xoá content của thư đã xong, một là cảnh báo về một delivery
 * còn dở (FR-007 nói rõ retention của content và của delivery đang dở là hai đường).
 */
export type RunRetentionCycleConfig = {
  /** Giữ content của một message terminal bao lâu kể từ `terminal_at`. */
  readonly contentOlderThanMs: number;
  /** Một delivery non-terminal cũ hơn ngưỡng này thì phải sinh alert. */
  readonly staleOlderThanMs: number;
  /** Số ứng viên tối đa mỗi list method — đường quét theo lô, không bao giờ quét cả bảng. */
  readonly batchLimit: number;
  /** Epoch ms — mốc của cả hai ngưỡng và của `updated_at` sau redaction. */
  readonly nowMs: number;
};

/** Tổng kết quả một chu kỳ retention. */
export type RunRetentionCycleResult = {
  /** Số row đã bị xoá content. */
  readonly redacted: number;
  /** Số alert stale đã phát — bằng số candidate, kể cả khi đã phát alert cho cùng một row. */
  readonly staleAlerts: number;
};

/**
 * Chạy **một** chu kỳ retention: redact content quá hạn, rồi alert về delivery dở quá tuổi.
 *
 * Thứ tự hai nhánh là cố ý: redact chạy trước, nên một message vừa kết thúc và đủ tuổi được
 * xử lý content ngay trong chính chu kỳ đó.
 *
 * ⚠️ Chu kỳ này **không xoá row**. Không có `DELETE` nào ở đây và không có ở port: operational
 * metadata là thứ operator còn dùng để điều tra một delivery đã `sent`/`failed`, và FR-007
 * yêu cầu "content bị xoá/redact, **metadata còn**".
 */
export async function runRetentionCycle(
  deps: MailRetentionDeps,
  config: RunRetentionCycleConfig,
): Promise<RunRetentionCycleResult> {
  const redacted = await redactOverdueContent(deps, config);
  const staleAlerts = await alertStaleNonTerminal(deps, config);
  return { redacted, staleAlerts };
}

/**
 * Nhánh 1 — redact content của message terminal đã quá hạn.
 *
 * Hai lệnh **tách riêng**, không dồn vào một `WHERE` khổng lồ: danh sách ứng viên được đọc
 * trước rồi mới redact, đúng như mọi đường quét theo lô khác. Đổi lại, guard chống race nằm
 * trong chính statement redact (`terminal_at < nowMs`) chứ không dựa vào việc danh sách đọc
 * được còn đúng — xem JSDoc của `redactContent`.
 */
async function redactOverdueContent(
  deps: MailRetentionDeps,
  config: RunRetentionCycleConfig,
): Promise<number> {
  const candidates = await deps.retention.listContentRetentionCandidates({
    terminalBeforeMs: config.nowMs - config.contentOlderThanMs,
    limit: config.batchLimit,
  });

  // Không có ứng viên → không gọi `redactContent` với danh sách rỗng. Không chỉ tiết kiệm
  // một câu: câu `WHERE id IN ()` là cú pháp không hợp lệ, và việc "no-op khi rỗng" là hợp
  // đồng mà port đã cam kết.
  if (candidates.length === 0) {
    return 0;
  }

  const result = await deps.retention.redactContent({
    messageIds: candidates.map((candidate) => candidate.messageId),
    nowMs: config.nowMs,
  });

  // Chỉ alert khi có gì **thực sự** bị redact. `count = 0` sau một danh sách ứng viên khác 0
  // là dấu hiệu một row vừa terminal giữa lúc đọc và lúc ghi (guard race) — chuyện bình thường,
  // và alert mỗi chu kỳ vì nó sẽ biến thành tiếng ồn mà mất hết giá trị cảnh báo.
  if (result.redacted > 0) {
    deps.logAlert({ event: 'retention-content-redacted', count: result.redacted });
  }

  return result.redacted;
}

/**
 * Nhánh 2 — alert về mọi delivery non-terminal quá tuổi.
 *
 * `blocked` **có** mặt trong danh sách này và đúng như vậy: FR-007 yêu cầu "delivery dở quá
 * tuổi tối đa → sinh alert (không im lặng)", và `blocked` là một trong ba trạng thái
 * non-terminal. Nhưng nhánh này **chỉ alert** — không redact content của `blocked`, vì một
 * delivery còn redrive được thì giữ content là hành động đúng (xem JSDoc
 * `listContentRetentionCandidates`).
 */
async function alertStaleNonTerminal(
  deps: MailRetentionDeps,
  config: RunRetentionCycleConfig,
): Promise<number> {
  const stale = await deps.retention.listStaleNonTerminalMessages({
    updatedBeforeMs: config.nowMs - config.staleOlderThanMs,
    limit: config.batchLimit,
  });

  for (const candidate of stale) {
    deps.logAlert({
      event: 'retention-stale-non-terminal',
      deliveryId: candidate.deliveryId,
      status: candidate.status,
      ageMs: config.nowMs - candidate.updatedAtMs,
    });
  }

  return stale.length;
}
