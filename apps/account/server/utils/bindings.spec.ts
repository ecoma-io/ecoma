import { describe, expect, it } from 'vitest';

import { accountHyperdrive, DB_ACCOUNT_BINDING } from './bindings';

/**
 * `accountHyperdrive` là ranh giới nơi dữ liệu **hạ tầng** (binding từ
 * `wrangler.jsonc` qua Nitro preset) đi vào ứng dụng — không có gì đảm bảo
 * config và code deploy cùng nhau, nên hàm kiểm hình dạng thay vì tin kiểu.
 * Trước đây không có test nào chạm hàm này: một mutation vô hiệu hoá shape
 * check (`if (false)`) vẫn xanh toàn bộ suite và `/ready` + contract status
 * sẽ nhận một object không có `connectionString` làm "binding hợp lệ".
 */
describe('accountHyperdrive', () => {
  it('returns null when runtimeConfig itself is missing', () => {
    expect(accountHyperdrive(undefined)).toBeNull();
  });

  it('returns null when the cloudflare section is absent', () => {
    expect(accountHyperdrive({})).toBeNull();
    expect(accountHyperdrive({ cloudflare: {} })).toBeNull();
  });

  it('returns null when the env map is absent', () => {
    expect(accountHyperdrive({ cloudflare: {} })).toBeNull();
    expect(accountHyperdrive({ cloudflare: { env: undefined } })).toBeNull();
  });

  it('returns null when the DB_ACCOUNT binding is absent', () => {
    expect(accountHyperdrive({ cloudflare: { env: {} } })).toBeNull();
    expect(
      accountHyperdrive({ cloudflare: { env: { SOME_OTHER_BINDING: { connectionString: 'x' } } } }),
    ).toBeNull();
  });

  it('returns null when connectionString is not a string', () => {
    // Hình dạng hỏng đa dạng: number, null, object, mảng — không chỉ `undefined`.
    // Bỏ qua kiểm hình dạng là nhận một binding không kết nối được như "đã cấu
    // hình", trái với hợp đồng fail-closed (`/ready` 503, status 503).
    for (const bad of [undefined, null, 42, {}, [], true]) {
      expect(accountHyperdrive({ cloudflare: { env: { [DB_ACCOUNT_BINDING]: bad } } })).toBeNull();
    }
  });

  it('returns the binding unchanged when connectionString is a string', () => {
    const binding = { connectionString: 'postgres://user:pw@host:5432/db-account' };
    const runtimeConfig = { cloudflare: { env: { [DB_ACCOUNT_BINDING]: binding } } };
    // Trả về **chính** object binding (không copy): caller (middleware, /ready)
    // truyền nó vào `withRequestPool` và mọi thay đổi sau này của binding type
    // phải tới được caller mà không cần sửa chỗ này.
    expect(accountHyperdrive(runtimeConfig)).toBe(binding);
  });
});
