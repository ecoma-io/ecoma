/**
 * Module marker của lane staging cho `remote-cache-api-deploy` — pre-warm
 * #350 (staging platform foundation), chờ #349 merge.
 *
 * #350 sẽ khai trong stack `staging` của project này đúng MỘT resource theo
 * bảng resource inventory `02-delivery.md` §7.4.1: **R2 bucket object storage
 * staging** của remote-cache (tương đương SeaweedFS bucket `remote-cache` của
 * lane local). Thân chương trình đó CHƯA thể viết hôm nay vì ba điều kiện
 * chưa có — mỗi điều kiện một TODO(349/blocking), không mục nào được đoán:
 *
 * 1. Tên bucket staging + account id + jurisdiction (quyết định tiền tố
 *    endpoint — `04-platform-facts.md` R22) chưa được chốt ở đâu cả;
 * 2. Lane guard + stack selection theo pattern #453 (`classifyPlatformStack`,
 *    engine `staging-run` của `platform-deploy`) chưa merge — tách thân local
 *    `index.ts` ra `local-program.ts` mà không có pattern đã merge là tự chế
 *    hình dạng riêng của một unit trong fleet;
 * 3. `ECOMA_PULUMI_STATE_URL_STAGING` chưa được bootstrap (một lần, NGOÀI mọi
 *    stack — hợp đồng bootstrap §7.4.1 cấm stack tự tạo state backend của
 *    chính nó), nên chưa có backend nào để chạy preview/up.
 *
 * Cho tới khi cả ba điều kiện đóng, mọi lời gọi vào lane staging của unit này
 * là **fail-closed**: từ chối tường minh, không khai resource nào, và KHÔNG
 * BAO GIỜ được nạp thân chương trình local (`index.ts`) — thân đó đọc config
 * `namespace` và StackReference platform của lane local, chạy trên backend R2
 * staging là khai Docker resource sai environment (đúng hazard mà guard #453
 * chặn cho `platform-deploy`).
 */

/**
 * Kết quả từ chối của marker staging — exit code và thông báo tiếng English
 * (chuỗi runtime). Hàm thuần để spec khoá hợp đồng mà không cần chạy entry.
 */
export interface StagingMarkerRefusal {
  readonly exitCode: 1;
  readonly message: string;
}

/**
 * Thông báo từ chối DUY NHẤT của lane staging hiện tại.
 *
 * Nhắc đúng ba điều kiện còn thiếu kèm issue, và cảnh báo tường minh việc
 * không được chạy thân local trên stack staging. Đổi nội dung thông báo phải
 * qua spec (`staging-run.spec.ts`) — hợp đồng marker là phần nhìn thấy được
 * của pre-warm này.
 */
export function stagingMarkerRefusal(): StagingMarkerRefusal {
  return {
    exitCode: 1,
    message:
      '[remote-cache-api-deploy] staging refused: this unit has no staging stack contents yet. ' +
      'The staging R2 object-storage bucket lands with issue #350, which waits for #349 (shared staging ' +
      'PostgreSQL host). Missing prerequisites: (1) staging state backend not bootstrapped — ' +
      'ECOMA_PULUMI_STATE_URL_STAGING is a one-time bootstrap outside any stack, never a Pulumi resource; ' +
      '(2) the staging lane guard/engine pattern (PR #453, platform-deploy) is not merged yet, so this project ' +
      'has no lane split and its local program (index.ts) must NEVER run on a staging stack — it declares ' +
      'namespace-scoped Docker resources for the local lane only; (3) bucket name/account/jurisdiction is an ' +
      'open decision. Refusing instead of guessing.',
  };
}
