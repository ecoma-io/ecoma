/**
 * Quyết định gate onboarding của BFF (issue #325, giai đoạn 1) — logic thuần,
 * tách khỏi route để unit test không cần h3.
 *
 * ## Quy tắc (giai đoạn 1)
 *
 * `needsDisplayName = true` ⇔ sub của phiên **chưa có** displayName.
 *
 * - "Chưa có" gộp cả hai hình dạng dữ liệu: entry `displayName: null` lẫn sub
 *   không có trong batch response (không có row profile). Từ góc nhìn của gate,
 *   hai thứ đó như nhau — người dùng chưa đặt tên.
 * - Gate **không** đọc trạng thái nào khác: không staff status, không role, không
 *   2FA. Giai đoạn 2 sẽ thêm nhánh 2FA vào cùng hàm này (chỗ gắn đã ghi ở
 *   `docs/applications/backoffice/01-architecture.md`).
 * - Gate **không** cứng (không chặn route khác): kết quả chỉ điều hướng UI tới
 *   màn onboarding. `GET /api/staff` và mọi `/api/**` khác không đọc hàm này.
 */

/**
 * Sub cần kiểm tra onboarding — lấy từ principal đã verify của phiên
 * (`VerifiedPrincipal.actorSub`), không bao giờ từ query param hay body.
 */
export function needsDisplayName(
  profiles: ReadonlyArray<{ readonly sub: string; readonly displayName: string | null }>,
  sub: string,
): boolean {
  const own = profiles.find((entry) => entry.sub === sub);
  return own === undefined || own.displayName === null;
}
