/**
 * Validate chế độ dữ liệu ở **phía server** — lớp gate thứ hai của seam.
 *
 * ## Vì sao cần gate riêng khi resolver phía app đã fail-closed
 *
 * `resolveAccountDataMode` không bao giờ trả `mock` trong artifact — nhưng đó
 * là **âm thầm rơi về `real`**. Một biến `NITRO_PUBLIC_ACCOUNT_DATA_MODE=mock`
 * đặt nhầm ở deployment của artifact là một lỗi cấu hình thật: người đặt nó
 * đang mong mock mà chạy thật (hoặc ngược lại, tùy kỳ vọng). Nuốt lỗi đó im
 * lặng là chính xác kiểu "fail vào một trạng thái khác" mà fail-closed cấm —
 * config sai phải **lộ ra**, không được diễn giải lại thành config đúng.
 *
 * Vì vậy luật chia hai lớp:
 *
 * - Phía app (composable): chọn adapter theo mode đã phân giải — `mock` ở
 *   artifact không thể xảy ra, không cần nhánh nào cho nó.
 * - Phía server (file này): khi artifact resolve ra `mock` ⇒ **chặn** —
 *   boot gate (`server/plugins/config.ts` hook request đầu) trả 503 và
 *   `/ready` trả 503 với reason ổn định `data_mode_mock_in_artifact`. Dưới
 *   `nuxt dev`, `mock` là giá trị hợp lệ và gate no-op.
 *
 * ## Vì sao validate ở request đầu, không ở module-init
 *
 * Cùng lý do với `validateAccountConfig` (`config-validation.ts`): trên preset
 * `cloudflare-module`, Nitro chạy top-level `index.mjs` lúc module Worker load,
 * còn biến env của deployment chỉ được nối vào runtime config ở request.
 * Validate ở init đọc một config chưa có env và ném ⇒ module không load được ⇒
 * kể cả deployment **đúng** cũng chết. File này nhận config đã đọc sẵn làm tham
 * số — thuần, test trực tiếp, không cần stub Nitro.
 */

import { ACCOUNT_DATA_MODE_MOCK, resolveAccountDataMode } from '../../app/account-data/data-mode';

/**
 * Chế độ dữ liệu đã phân giải cho **runtime server**, kèm trạng thái chặn.
 *
 * `mockInArtifact` chỉ `true` khi giá trị cấu hình **chủ động** yêu cầu `mock`
 * (hoặc được đặt chuỗi nào đó — kể cả sai chính tả — trong artifact, vì mọi
 * giá trị sai đều là cấu hình sai cần lộ) **và** runtime không phải dev. Phân
 * biệt này quan trọng: dev đặt `mock` là hợp lệ, còn artifact có biến đặt
 * `"mock"` phải chết 503 chứ không rơi về `real` trong im lặng.
 */
export type ServerDataMode =
  | { readonly kind: 'mock'; readonly devOnly: true }
  | { readonly kind: 'real'; readonly mockInArtifact: boolean };

/**
 * Phân giải giá trị thô của `runtimeConfig.public.accountDataMode` cho server.
 *
 * @param raw Giá trị đọc từ `runtimeConfig.public.accountDataMode`.
 * @param isDev Cờ `nuxt dev` — phía Nitro server, `import.meta.dev` được Nitro
 *              thay tĩnh theo `nitro.options.dev`, cùng cơ chế với phía app.
 * @returns `{ kind: 'mock' }` chỉ dưới dev với chuỗi đúng `'mock'`;
 *          `{ kind: 'real' }` cho mọi tổ hợp khác, kèm cờ `mockInArtifact`
 *          đánh dấu "artifact bị đặt **đúng chuỗi** `'mock'` — lỗi cấu hình
 *          phải bị chặn, không được nuốt". Chuỗi gần đúng (`'Mock'`,
 *          `'mock '`) không bao giờ resolve ra mock ở bất kỳ môi trường nào,
 *          nên chúng không phải request mock — chúng rơi về `real` cùng nhóm
 *          với mọi giá trị sai khác, đúng luật fail-closed của resolver.
 */
export function resolveServerDataMode(raw: unknown, isDev: boolean): ServerDataMode {
  if (resolveAccountDataMode(raw, isDev) === ACCOUNT_DATA_MODE_MOCK) {
    return { kind: 'mock', devOnly: true };
  }

  return {
    kind: 'real',
    mockInArtifact: !isDev && raw === ACCOUNT_DATA_MODE_MOCK,
  };
}

/** Reason code ổn định ghi vào log khi `/ready` chặn mock-in-artifact. */
export const DATA_MODE_MOCK_IN_ARTIFACT_REASON = 'data_mode_mock_in_artifact' as const;
