/**
 * Hằng số và hằng số giới hạn của adapter Web Push — **không** phụ thuộc runtime nào.
 *
 * Nguồn: `docs/architecture/04-platform-facts.md` §2.15 (WP1–WP6) và
 * `docs/applications/web-push-notification-job/01-architecture.md` §15/§16/§18.
 */

/**
 * Trần **plaintext** của Web Push (số octet UTF-8 của `payloadJson`).
 *
 * RFC 8291 §4: "Absent header (86 octets), padding (minimum 1 octet), and expansion
 * for AEAD_AES_128_GCM (16 octets), this equates to, at most, 3993 octets of
 * plaintext" — trần này là **fact của protocol**, không phải lựa chọn của ta. Suy ra
 * từ WP5: push service không bắt buộc hỗ trợ body > 4096 octets.
 */
export const MAX_PLAINTEXT_OCTETS = 3993;

/**
 * Trần **body đã mã hoá** — tổng của header `aes128gcm` + record.
 *
 * RFC 8291 §4 dẫn RFC 8030 §7.2: push service không bắt buộc hỗ trợ payload body
 * lớn hơn 4096 octets. Đây là **bất biến phòng thủ thứ hai**: kể cả khi trần plaintext
 * được kiểm, adapter vẫn **MUST NOT** gửi body vượt trần (worker §15) — kiểm lại sau
 * khi mã hoá để bắt được sai sót ở chỗ khác thay vì tin phép tính.
 */
export const MAX_BODY_OCTETS = 4096;

/** Kích thước salt `aes128gcm` (RFC 8188 §2.1). */
export const SALT_OCTETS = 16;

/** Record size `rs` ghi trong header — RFC 8291 §4 chỉ dùng **một** record. */
export const RECORD_SIZE = 4096;

/**
 * Kích thước header `aes128gcm` khi có `keyid` là điểm EC uncompressed 65 octet
 * (RFC 8188 §2.1: salt 16 + rs 4 + idlen 1 + keyid 65).
 */
export const HEADER_OCTETS = 16 + 4 + 1 + 65;

/**
 * Hạn của JWT VAPID — **hằng số tài liệu**, không cấu hình được.
 *
 * RFC 8292 §2: `exp` "MUST NOT be more than 24 hours from the time of the request".
 * Ta chọn **12 giờ**: nằm giữa khoảng cho phép, đủ dài để một message bị retry vẫn dùng
 * được token đã ký nếu cache, ngắn hơn nhiều so với trần 24h để giảm blast radius khi
 * token lộ (worker §18: "thời hạn ngắn để giảm blast radius nếu lộ"). Việc chọn 12h là
 * quyết định của adapter, **MUST** giữ ≤ 24h nếu đổi.
 */
export const VAPID_EXPIRY_SECONDS = 12 * 60 * 60;

/** Số giây TTL tối thiểu hợp lệ (WP4: `TTL = 0` nghĩa là không giữ lại). */
export const MIN_TTL_SECONDS = 0;

/** Trần số giây TTL hợp lệ theo RFC 8030 §5.2 (uint32 ngày, thực tế chặn ở con số an toàn). */
export const MAX_TTL_SECONDS = 2 ** 32 - 1;

/**
 * `sub` của JWT VAPID — **OPTIONAL** theo RFC 8292 §2.1 ("An application server **MAY**
 * include a `sub` (Subject) claim"), nên `null` là hợp lệ và **không** chặn gửi. Hằng số
 * này tồn tại để test và comment tham chiếu cùng một quyết định.
 */
export const VAPID_SUB_IS_REQUIRED = false;
