/**
 * Model assurance xác thực bằng **ACR URN** (`urn:ecoma:acr:*`) — thay thế thang
 * bậc tuyến tính `anonymous < password < totp < passkey` đã bị loại bỏ.
 *
 * ## Vì sao bỏ ladder, và model mới là gì
 *
 * Thang bậc cũ ngầm định một thứ không đúng nữa: rằng các phương thức xếp được
 * trên một trục "yếu → mạnh" và mức cao hơn bao hàm mọi mức thấp hơn. Với bộ
 * phương thức đã chốt (email-OTP là phương thức đăng nhập DUY NHẤT; MFA tuỳ
 * chọn gồm TOTP và Passkey/WebAuthn; **không có password, không có email-link**),
 * quan hệ đúng là **thuộc tập**, không phải so hạng:
 *
 * - Một session xác thực bằng email-OTP mang ACR `email-otp` — và KHÔNG mang
 *   `mfa`: đăng nhập bằng OTP một yếu tố không đột nhiên thành MFA.
 * - `mfa` chỉ có khi session đã vượt qua thêm một yếu tố thứ hai (TOTP hoặc
 *   Passkey) sau OTP.
 * - `phishing-resistant` chỉ có khi yếu tố thứ hai là Passkey (WebAuthn) — TOTP
 *   shareable-secret không chống phishing được, nên nó KHÔNG kéo theo URN này.
 *
 * Kiểm tra "session có đủ assurance cho hành động X" trở thành: tập ACR của
 * session **chứa** ACR yêu cầu. Không suy diễn ngược, không suy diễn xuôi.
 *
 * ⚠️ Phần quyết định này nằm ở `docs/applications/account/01-architecture.md` (mục
 * assurance); file này chỉ giữ hằng số và phép kiểm tập hợp — không giữ policy
 * "hành động nào đòi ACR nào".
 */

/** Các ACR URN mà hệ thống cấp và kiểm. Khai báo ĐẦY ĐỦ tại đây. */
export const ACR = {
  /** Đã xác thực bằng email-OTP (phương thức đăng nhập duy nhất). */
  EmailOtp: 'urn:ecoma:acr:email-otp',
  /** Đã vượt qua MFA: OTP + (TOTP hoặc Passkey). */
  Mfa: 'urn:ecoma:acr:mfa',
  /** Yếu tố thứ hai là Passkey/WebAuthn (chống phishing). */
  PhishingResistant: 'urn:ecoma:acr:phishing-resistant',
} as const;

/** Union các ACR URN. */
export type Acr = (typeof ACR)[keyof typeof ACR];

/** Mảng phục vụ kiểm membership và danh sách khai báo trên wire. */
export const ACR_VALUES = [ACR.EmailOtp, ACR.Mfa, ACR.PhishingResistant] as const;

/** Type guard cho một ACR URN hợp lệ. */
export function isAcr(value: unknown): value is Acr {
  return typeof value === 'string' && (ACR_VALUES as readonly string[]).includes(value);
}

/**
 * Kiểm một giá trị trên wire có hình dạng ACR URN của Ecoma không.
 *
 * ⚠️ Khác `isAcr`: hàm này kiểm **cấu trúc** (`urn:ecoma:acr:` + token), dùng
 * cho chỗ từ chối payload trước khi tra whitelist — thông báo lỗi có thể nêu
 * giá trị nhận được, còn `isAcr` chỉ trả boolean. Hai hàm cùng tồn tại vì
 * contract validator cần phân biệt "sai hình dạng" với "không thuộc tập đã biết".
 */
export function isAcrShape(value: unknown): value is string {
  return typeof value === 'string' && /^urn:ecoma:acr:[a-z0-9-]+$/u.test(value);
}

/**
 * Quan hệ kéo theo giữa các ACR — dùng để tính **tập ACR của một session** từ
 * các bằng chứng nó đã vượt qua, KHÔNG phải để suy giảm yêu cầu.
 *
 * - Hoàn thành email-OTP ⇒ tập chứa `email-otp`.
 * - Thêm yếu tố thứ hai (TOTP hoặc Passkey) ⇒ tập thêm `mfa`.
 * - Yếu tố thứ hai là Passkey ⇒ tập thêm `phishing-resistant`.
 *
 * Hàm trả về tập đầy đủ từ bằng chứng; nơi gọi KHÔNG tự ghép URN tay.
 */
export function acrSetFor(params: {
  emailOtp?: boolean;
  secondFactor?: 'totp' | 'passkey' | null;
}): ReadonlySet<Acr> {
  const acrs = new Set<Acr>();
  if (params.emailOtp === true) {
    acrs.add(ACR.EmailOtp);
  }
  if (
    params.emailOtp === true &&
    params.secondFactor !== null &&
    params.secondFactor !== undefined
  ) {
    acrs.add(ACR.Mfa);
    if (params.secondFactor === 'passkey') {
      acrs.add(ACR.PhishingResistant);
    }
  }
  return acrs;
}

/**
 * Kiểm ACR của session có đáp ứng yêu cầu hay không — phép **membership** trên
 * tập ACR của session.
 *
 * ⚠️ Cố ý KHÔNG có hàm "rank" hay "so mạnh yếu": model này không có thứ tự
 * tổng quát. Muốn đòi `mfa` thì tập session phải chứa `urn:ecoma:acr:mfa`;
 * chứa `email-otp` không đủ, và không có đường suy diễn nào khác.
 */
export function acrSatisfies(sessionAcrs: Iterable<Acr>, required: Acr): boolean {
  for (const acr of sessionAcrs) {
    if (acr === required) {
      return true;
    }
  }
  return false;
}
