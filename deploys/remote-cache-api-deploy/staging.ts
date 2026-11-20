/**
 * Entry marker của lane staging cho `remote-cache-api-deploy` — mọi lời gọi
 * là từ chối fail-closed (`staging-run.ts` giữ hợp đồng marker và lý do).
 *
 * Tái sử dụng cấu trúc entry của `platform-deploy/staging.ts` (PR #453):
 * entry chỉ là vỏ CLI — hàm thuần nằm ở module `staging-run.ts` để spec import
 * được mà không kích hoạt `process.exit` của entry. KHÔNG có nx target nào
 * trỏ vào entry này hôm nay: target `staging-preview`/`staging-up` được nối
 * cùng lúc với engine thật (targetDefaults lane staging trong `nx.json` cũng
 * thuộc PR #453) — target trỏ vào marker fail-closed là bề mặt chết, không
 * thêm từ đây. Chạy tay: `npx tsx staging.ts` (exit 1, thông báo từ chối).
 */

// oxlint-disable no-console -- entry CLI chạy trên Node; console là kênh
// báo cáo duy nhất của operator (như `local.ts`, `platform-deploy/staging.ts`).

import { stagingMarkerRefusal } from './staging-run.js';

function main(): number {
  const refusal = stagingMarkerRefusal();
  console.error(refusal.message);
  return refusal.exitCode;
}

process.exit(main());
