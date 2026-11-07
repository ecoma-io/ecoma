/**
 * Capability của model/offer.
 *
 * Source of truth: `docs/domains/llm-marketplace/domain-model.md` §1, §3.8, §4;
 * `docs/domains/llm-marketplace/domain-model.md` §2, §6.
 *
 * Capability là **định danh mở** do caller cấp — không phải enum đóng của lib.
 * Lib validate hình dạng và bất biến của tập (không rỗng, không trùng, thứ tự
 * canonical), không liệt kê danh mục nghiệp vụ. Ngữ nghĩa từng value thuộc
 * consumer (routing, pricing); marketplace chỉ lưu và filter.
 */

import { llmMarketplaceFailure, llmMarketplaceOk, type LlmMarketplaceResult } from './shared';

/** Độ dài tối đa của một capability label. */
export const MAX_CAPABILITY_LENGTH = 64;

const CAPABILITY_PATTERN = /^[a-z][a-z0-9_]*$/u;

/**
 * Sắp xếp canonical một mảng string, không mutate input.
 *
 * Không dùng `Array#sort` (repo cấm vì mutate) cũng không dùng `toSorted`
 * (`lib` của package là `es2022`, và `toSorted` chỉ có từ `es2023`). Insertion
 * sort trên bản copy là đủ: tập capability nhỏ vài phần tử và chỉ sắp một lần
 * khi tạo.
 */
function canonicalSort(values: readonly string[]): string[] {
  const sorted: string[] = [];
  for (const value of values) {
    let index = 0;
    while (index < sorted.length && sorted[index] < value) {
      index += 1;
    }
    sorted.splice(index, 0, value);
  }
  return sorted;
}

/**
 * Type guard cho một capability.
 *
 * Hình dạng: lowercase snake_case, bắt đầu bằng chữ cái, ≤ 64 ký tự. Không
 * nhận chuỗi rỗng, dấu cách hay ký tự hoa: capability là khoá so khớp, không
 * phải text hiển thị.
 */
export function isCapability(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_CAPABILITY_LENGTH &&
    CAPABILITY_PATTERN.test(value)
  );
}

/**
 * Tập capability đã validate.
 *
 * Bất biến:
 * - Không rỗng: một offer không khai báo capability nào thì không filter được.
 * - Không trùng: trùng lặp không mang thêm thông tin và làm phép so tập mơ hồ.
 * - Thứ tự canonical (tăng dần theo code unit) để hai tập cùng nội dung luôn
 *   bằng nhau khi so sánh — domain không phụ thuộc thứ tự caller truyền.
 */
export interface CapabilitySet {
  readonly capabilities: readonly string[];
}

/**
 * Tạo `CapabilitySet` từ input của caller.
 *
 * Guard: `input` phải là mảng, mọi phần tử qua `isCapability`, không trùng.
 * Output được sort canonical và freeze; input không bị mutate.
 */
export function createCapabilitySet(input: unknown): LlmMarketplaceResult<CapabilitySet> {
  if (!Array.isArray(input)) {
    return llmMarketplaceFailure('invalid_capability_set');
  }
  if (input.length === 0) {
    return llmMarketplaceFailure('invalid_capability_set');
  }
  if (!input.every(isCapability)) {
    return llmMarketplaceFailure('invalid_capability');
  }
  if (new Set(input).size !== input.length) {
    return llmMarketplaceFailure('invalid_capability_set');
  }
  return llmMarketplaceOk(
    Object.freeze({ capabilities: Object.freeze(canonicalSort(input as string[])) }),
  );
}

/** Shape guard cho `CapabilitySet` đọc từ storage/contract. */
export function isCapabilitySet(value: unknown): value is CapabilitySet {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const capabilities = (value as { capabilities?: unknown }).capabilities;
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    return false;
  }
  if (!capabilities.every(isCapability)) {
    return false;
  }
  if (new Set(capabilities).size !== capabilities.length) {
    return false;
  }
  // Thứ tự canonical là một phần của shape: dữ liệu không canonical không được
  // coi là giá trị domain hợp lệ, nếu không hai tập bằng nhau có thể so sánh ra
  // khác nhau sau một vòng qua storage.
  const sorted = canonicalSort(capabilities as string[]);
  return sorted.every((capability, index) => capability === capabilities[index]);
}

/** Có capability được yêu cầu trong tập không. */
export function hasCapability(set: CapabilitySet, capability: string): boolean {
  return isCapabilitySet(set) && isCapability(capability) && set.capabilities.includes(capability);
}

/**
 * Offer có thoả **mọi** capability được yêu cầu không.
 *
 * `required` rỗng nghĩa là không lọc. `required` không hợp lệ trả `false`
 * (fail closed): một filter hỏng không được biến thành "khớp tất cả".
 */
export function satisfiesCapabilities(set: CapabilitySet, required: unknown): boolean {
  if (!isCapabilitySet(set)) {
    return false;
  }
  if (!Array.isArray(required) || !required.every(isCapability)) {
    return false;
  }
  return required.every((capability) => set.capabilities.includes(capability));
}
