/**
 * Pricing version — một lần chốt bất biến của schedule cho một offer.
 *
 * Source of truth: `docs/domains/llm-seller-pricing/domain-model.md` §5–§6.
 *
 * Bất biến của history:
 * - số version **monotonic** trong cùng offer, bắt đầu từ 1, tăng đúng 1 mỗi
 *   lần — không downgrade, không bỏ số;
 * - `effectiveFrom` không giảm;
 * - version đã tạo không bị sửa hay xoá: thay đổi giá là append version mới.
 *
 * Lý do "tăng đúng 1" chứ không chỉ "tăng": bỏ số tạo ra một khoảng trống mà
 * không consumer nào phân biệt được với "một version đã bị xoá" — đúng thứ mà
 * bất biến history cấm. Một bước nhảy là tín hiệu history không đáng tin.
 */

import { isEpochMillis } from './instant';
import { isRecord } from './guards';
import { pricingFailure, pricingOk, type PricingResult } from './result';
import { isPricingSchedule, readPricingSchedule, type PricingSchedule } from './pricing-schedule';

/** Một pricing version đã validate và freeze. */
export interface PricingVersion {
  readonly offerId: string;
  /** Số version, bắt đầu từ 1. */
  readonly version: number;
  /** Epoch millis UTC — version có hiệu lực từ mốc này. */
  readonly effectiveFrom: number;
  readonly schedule: PricingSchedule;
}

/** Lịch sử version của một offer, bất biến. */
export type PricingVersionHistory = readonly PricingVersion[];

/** Type guard cho `PricingVersion` **chuẩn hoá** — không đi qua reader. */
export function isPricingVersion(value: unknown): value is PricingVersion {
  if (!isRecord(value)) {
    return false;
  }
  const offerId = value['offerId'];
  return (
    typeof offerId === 'string' &&
    offerId.trim().length > 0 &&
    isVersionNumber(value['version']) &&
    isEpochMillis(value['effectiveFrom']) &&
    isPricingSchedule(value['schedule'])
  );
}

/**
 * Validate một pricing version đọc từ dữ liệu ngoài.
 *
 * Không tự kiểm vị trí trong history — việc đó thuộc `readPricingVersionHistory`
 * hoặc `appendPricingVersion`, vì một version đứng một mình không có "version
 * trước" để so.
 */
export function readPricingVersion(value: unknown): PricingResult<PricingVersion> {
  if (!isRecord(value)) {
    return pricingFailure('invalid_version');
  }
  const offerId = value['offerId'];
  if (typeof offerId !== 'string' || offerId.trim().length === 0) {
    return pricingFailure('invalid_offer_id');
  }
  const version = value['version'];
  if (!isVersionNumber(version)) {
    return pricingFailure('invalid_version');
  }
  const effectiveFrom = value['effectiveFrom'];
  if (!isEpochMillis(effectiveFrom)) {
    return pricingFailure('invalid_effective_from');
  }
  const schedule = readPricingSchedule(value['schedule']);
  if (!schedule.ok) {
    return pricingFailure(schedule.error.code);
  }
  return pricingOk(
    Object.freeze({
      offerId,
      version,
      effectiveFrom,
      schedule: schedule.value,
    }),
  );
}

function isVersionNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/**
 * Validate toàn bộ history: trong **mỗi** offer, version `1..n` liên tiếp và
 * `effectiveFrom` không giảm.
 *
 * History đọc từ persistence có thể chứa version của nhiều offer (một bảng
 * `pricing_versions` lọc theo tập offer, không theo từng offer). Bất biến
 * monotonic của tài liệu §5 được phát biểu **trong cùng offer**, nên nó phải
 * được kiểm theo từng nhóm offer chứ không trên toàn mảng — kiểm trên toàn mảng
 * sẽ từ chối đúng dữ liệu mà `resolvePricingSnapshot` cần nhận.
 */
export function readPricingVersionHistory(value: unknown): PricingResult<PricingVersionHistory> {
  if (!Array.isArray(value)) {
    return pricingFailure('invalid_version_history');
  }
  const versions: PricingVersion[] = [];
  for (const entry of value) {
    const version = readPricingVersion(entry);
    if (!version.ok) {
      return pricingFailure(version.error.code);
    }
    versions.push(version.value);
  }
  const groups = new Map<string, PricingVersion[]>();
  for (const version of versions) {
    const group = groups.get(version.offerId);
    if (group === undefined) {
      groups.set(version.offerId, [version]);
    } else {
      group.push(version);
    }
  }
  for (const group of groups.values()) {
    const monotonic = validateHistoryOrder(group);
    if (monotonic !== null) {
      return pricingFailure(monotonic);
    }
  }
  return pricingOk(Object.freeze(versions));
}

/**
 * Kiểm thứ tự của history đã đọc: cùng offer, version `1..n` liên tiếp,
 * `effectiveFrom` không giảm. Trả mã lỗi nếu sai, `null` nếu hợp lệ.
 */
function validateHistoryOrder(
  versions: readonly PricingVersion[],
): 'invalid_version_history' | null {
  let previous: PricingVersion | null = null;
  for (const version of versions) {
    if (previous === null) {
      if (version.version !== 1) {
        return 'invalid_version_history';
      }
    } else {
      if (version.offerId !== previous.offerId) {
        return 'invalid_version_history';
      }
      if (version.version !== previous.version + 1) {
        return 'invalid_version_history';
      }
      if (version.effectiveFrom < previous.effectiveFrom) {
        return 'invalid_version_history';
      }
    }
    previous = version;
  }
  return null;
}

/**
 * Append một version mới vào history, kiểm đủ ba bất biến.
 *
 * Trả history mới (mảng mới, phần tử cũ giữ nguyên tham chiếu) thay vì mutate:
 * caller đang giữ history cũ cho một quyết định đã admit không được quan sát
 * thay đổi dưới chân mình (invariant 8).
 */
export function appendPricingVersion(
  history: PricingVersionHistory,
  next: PricingVersion,
): PricingResult<PricingVersionHistory> {
  if (history.length > 0) {
    const last = history[history.length - 1];
    if (next.offerId !== last.offerId) {
      return pricingFailure('invalid_version_transition');
    }
    if (next.version !== last.version + 1) {
      return pricingFailure('invalid_version_transition');
    }
    if (next.effectiveFrom < last.effectiveFrom) {
      return pricingFailure('invalid_version_transition');
    }
  } else if (next.version !== 1) {
    return pricingFailure('invalid_version_transition');
  }
  return pricingOk(Object.freeze([...history, next]));
}

/**
 * Chọn version áp dụng cho một admission instant: version có
 * `effectiveFrom <= admission` và số version lớn nhất.
 *
 * Không có version phù hợp → `no_applicable_version`. Không đoán, không "dùng
 * version đầu tiên", không dùng version mới nhất bất kể thời điểm — đó là hai
 * cách biến một cấu hình chưa hiệu lực thành giá đã áp dụng.
 */
export function selectApplicableVersion(
  history: PricingVersionHistory,
  admission: number,
): PricingResult<PricingVersion> {
  if (!isEpochMillis(admission)) {
    return pricingFailure('invalid_admission_time');
  }
  let selected: PricingVersion | null = null;
  for (const version of history) {
    if (version.effectiveFrom > admission) {
      continue;
    }
    if (selected === null || version.version > selected.version) {
      selected = version;
    }
  }
  if (selected === null) {
    return pricingFailure('no_applicable_version');
  }
  return pricingOk(selected);
}
