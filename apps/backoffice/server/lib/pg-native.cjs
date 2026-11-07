/**
 * Stub cho `pg-native` — optional native binding của `pg`.
 *
 * ## Vì sao cần stub này
 *
 * `pg/lib/index.js` định nghĩa getter `native` gọi `require('./native')`, và
 * `pg/lib/native/client.js` lại `require('pg-native')`. Trên Node, lỗi
 * `MODULE_NOT_FOUND` ở đó bị getter nuốt nên `pg` vẫn chạy bình thường — đó là
 * lý do `pg-native` là optional dependency.
 *
 * Rollup của Nitro không hiểu try/catch đó: nó coi mọi `require()` là static và
 * fail build với `Cannot resolve "pg-native" ... and externals are not allowed`.
 * Đường thoát duy nhất mà preset cho phép là `nitro.alias` (`noExternals: true`
 * khiến `nitro.externals` không được đọc, và preset `cloudflare-module` cố ý bật nó).
 *
 * ## Vì sao `.cjs` và nằm trong `server/lib/`
 *
 * `.cjs` để `require()` của CommonJS trong `pg` nạp được trực tiếp mà không cần
 * interop. `server/lib/` vì `server/utils/` là thư mục Nitro **auto-import** — đặt
 * stub ở đó sẽ biến nó thành auto-import của app.
 *
 * ⚠️ Stub **phải** ném lỗi khi được dựng. Nếu nó trả về object rỗng thì code gọi
 * `pg.native` sẽ chạy tiếp với client giả và hỏng im lặng ở production. Ném ở đây
 * biến một cấu hình sai thành lỗi ngay tại chỗ gọi.
 *
 * Khai bằng function thay vì `class` vì `.oxlintrc.json` bật
 * `typescript(no-extraneous-class)` — class chỉ có constructor là mẫu mà rule này
 * cấm, và function constructor cho hành vi giống hệt.
 */
module.exports = function PgNativeUnavailable() {
  throw new Error(
    'pg-native không dùng được trên Workers: binding native không tồn tại trong ' +
      'isolate của Cloudflare. App phải dùng client JS của pg.',
  );
};
