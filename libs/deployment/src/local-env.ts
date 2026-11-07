/**
 * Helper dữ liệu dùng chung của lane local — kỹ thuật thuần, KHÔNG orchestration.
 *
 * Entry lifecycle colocated của từng deploy project (`deploys/<p>/local.ts`)
 * import từ đây: các hàm chỉ là MỘT biến đổi dữ liệu có kiểm fail-closed (sinh
 * secret theo hình đúng, phân loại "chưa có key" của `pulumi config get`, đọc
 * `ROOT_HOST` từ `.env`). Module này cố ý KHÔNG biết thứ tự giữa các project
 * và KHÔNG gọi lệnh DX nào.
 *
 * Các secret generator giữ nguyên ngữ nghĩa từng hàm (khối comment của mỗi
 * generator giải thích vì sao hình giá trị là CONTRACT của consumer phía app).
 * Generator chỉ có MỘT deploy project dùng sống ở entry của chính project đó —
 * không đưa vào đây chỉ để import compile được là sai ranh giới sở hữu.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Import module NGUỒN cụ thể, không qua barrel `./index.js` (index re-export
// lại module này — import ngược barrel là module cycle ESM, xem local-entry.ts).
import type { ExecResult } from './pulumi-context.js';
import { ROOT_HOST_ENV_KEY } from './platform-outputs-contract.js';

/**
 * "Chưa có key" của `pulumi config get` — CHỈ khi CLI báo đúng vậy.
 *
 * Exit != 0 không phân biệt được: sai passphrase (không giải được secret),
 * state lock, backend hỏng... đều exit != 0. Regen secret trên các lỗi đó sẽ
 * ĐÈ giá trị đang tồn tại trong state (`config set` chỉ cần salt để mã hoá
 * giá trị mới là thành công trên DIY backend) → container bị khoá khỏi dữ
 * liệu đã init bằng giá trị cũ. Export để spec phủ trực tiếp.
 */
export function isConfigKeyMissing(result: ExecResult): boolean {
  const output = `${result.stdout}\n${result.stderr}`;
  // So khớp chuỗi con bằng indexOf thay vì regex `.*`: pattern
  // `/configuration key .* not found/` trên input lặp nhiều lần
  // 'configuration key ' là quadratic theo CodeQL (js/polynomial-redos). Hai
  // phép indexOf là tuyến tính, cùng ngữ nghĩa với pattern cũ trên mọi input.
  const lower = output.toLowerCase();
  const marker = lower.indexOf('configuration key ');
  return (
    lower.includes('no value for the key') || (marker !== -1 && lower.includes('not found', marker))
  );
}

/**
 * Sinh mật khẩu PostgreSQL cho stack local mới.
 *
 * `randomBytes` của `node:crypto` — nguồn ngẫu nhiên mật mã an toàn. KHÔNG
 * dùng `Math.random`, timestamp, hard-code hay giá trị đoán được: mật khẩu này
 * là superuser credential của database local, và tài liệu yêu cầu sinh ngẫu
 * nhiên bằng API mật mã an toàn.
 *
 * `base64url` → chỉ ký tự `A-Za-z0-9-_`, nên an toàn khi đặt trong file `.env`
 * (không cần quote) và khi truyền làm argument cho `pulumi config set`.
 */
export function generatePostgresPassword(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Sinh secret HMAC cho envelope internal `ecoma-internal-v1` hai chiều
 * auth <-> account.
 *
 * Một secret ứng dụng dùng {@link generateAppSecret} (32 byte): cùng hình
 * base64url, nhưng đủ entropy chuẩn HMAC-SHA-256 thay vì đoán theo ngưỡng ký
 * tự. Tách tên riêng vì NGHĨA khác với `generatePostgresPassword`: đây là
 * secret HMAC ứng dụng (không phải credential database), và entry up của
 * account là nơi giữ bất biến "auth và account nhận CÙNG giá trị" — sinh hai
 * lần độc lập là mọi envelope internal chết `bad_signature` lúc runtime.
 */
export function generateInternalHmacSecret(): string {
  return generateAppSecret();
}

/**
 * Sinh secret ỨNG DỤNG 32 byte base64url — hình chuẩn cho mọi secret mà
 * contract phía consumer kiểm theo byte (không phải credential database).
 *
 * 32 byte = 256 bit là kích thước chuẩn HMAC-SHA-256: contract của
 * `auth-domain` (`importKey`) bắt ĐÚNG 32 byte từ `AUTH_HANDLE_KEY`,
 * và cookie keyring của oidc-provider cũng là key ký ứng dụng — dùng mật
 * khẩu 24 byte của database cho secret ứng dụng là che giấu hai NGHĨA khác
 * nhau sau một hình dạng giá trị chung (#284). `base64url` giữ tính an toàn
 * khi nhúng: chỉ ký tự `A-Za-z0-9-_`, an toàn trong `.env`, argv của
 * `pulumi config set` và container env không cần quote.
 */
export function generateAppSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Đọc `ROOT_HOST` từ `.env` của worktree — artifact mà up của platform ghi sau
 * khi `pulumi up` xanh.
 *
 * `.env` không trở thành nguồn sự thật của resource vì hàm này chỉ đọc: giá trị
 * sai chỉ làm issuer/audience của auth lệch hostname và luồng fail ở smoke.
 */
export function readRootHostFromEnv(worktreeRoot: string): string | undefined {
  const envPath = join(worktreeRoot, '.env');
  if (!existsSync(envPath)) return undefined;
  const line = readFileSync(envPath, 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith(`${ROOT_HOST_ENV_KEY}=`));
  const value = line?.split('=').slice(1).join('=');
  return value !== undefined && value.length > 0 ? value : undefined;
}
