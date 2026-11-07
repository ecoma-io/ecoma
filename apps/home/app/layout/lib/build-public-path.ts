/**
 * `buildPublicPath` — canonical constructor cho public URL.
 *
 * Mọi public URL dựng qua hàm này; caller **không** bao giờ tự concatenate
 * `/${locale}/${mount}${path}`.
 *
 * Không có logic ghép path riêng: hàm ghép resource path rồi ủy quyền cho
 * `localizePath` (kiểu cấu trúc, chống double-localize) của `app/i18n` và
 * `parsePublicLayoutPath` (mount topology) của chính thư viện này — nên với
 * input hợp lệ, kết quả build **là đúng** kết quả parse của URL vừa dựng và
 * invariant `parse(build(x)) ≡ build(x)` đúng by construction; input bị
 * reject trả `invalid` kèm typed reason.
 */

import { isPublicLocale, localizePath, type PublicLocale } from '../../i18n/index';
import { isPublicMount } from './mount-registry';
import {
  invalidLayoutPath,
  type PublicLayoutPathInput,
  type PublicLayoutPathResult,
} from './public-layout-path';
import { parsePublicLayoutPath } from './parse-public-layout-path';

/**
 * Dựng public path từ `{ locale }` (locale-root) hoặc `{ locale, mount,
 * path? }` (mounted surface) dưới dạng kết quả phân biệt — không string trần,
 * không throw.
 *
 * Thứ tự kiểm tra (precedence, match đầu tiên thắng):
 *
 * 0. `input` là `null`/`undefined` (`unsupported_locale`) — guard runtime cho
 *    JS caller; contract "không throw" áp cho mọi input class;
 * 1. `locale` không có trong registry (`unsupported_locale`) — guard runtime
 *    cho caller đi qua cast;
 * 2. `mount === undefined` mà `path` khác rỗng (`unknown_mount`) — contract:
 *    `path` chỉ tồn tại kèm `mount`;
 * 3. `mount` không có trong registry (`unknown_mount`) — guard runtime cho
 *    caller đi qua cast;
 * 4. `path` khác rỗng mà không bắt đầu bằng `/` (`not_a_pathname`) —
 *    kiểm tra trước khi ghép để `/${mount}` + `foo` không bao giờ thành
 *    `/blogfoo`;
 * 5. ghép resource path rồi qua `localizePath` — cấu trúc còn lại
 *    (`//`, trailing slash, `?`/`#`) được kiểm tra ở đó, đúng thứ tự của
 *    `parsePublicPath`;
 * 6. qua `parsePublicLayoutPath` để trả kết quả canonical — với input hợp
 *    lệ, kết quả build **là đúng** kết quả parse của URL vừa dựng, nên
 *    invariant `parse(build(x)) ≡ build(x)` đúng by construction (input
 *    bị reject trả `invalid`, không thuộc invariant này);
 * 7. kết quả parse phải resolve **đúng mount đã yêu cầu**, nếu không trả
 *    `unknown_mount` (topology boundary — xem dưới).
 *
 * `path: '/'` bị từ chối với `trailing_slash` (ghép vào `/blog/`): bề mặt
 * mount canonical là `path` rỗng hoặc thiếu, không bao giờ kết thúc bằng
 * `/`.
 *
 * `build` không bao giờ trả `root` — input luôn mang locale.
 *
 * **Topology boundary** — `PublicMount` là ranh giới topology, không phải
 * tiền tố string: sau khi ghép mount + path, nếu pathname kết quả được
 * `parsePublicLayoutPath` resolve thành một mount **khác** mount caller yêu
 * cầu, builder trả `unknown_mount` thay vì âm thầm reinterpret. Rule tổng
 * quát, không hard-code segment nào — bất kỳ mount lồng nhau nào trong
 * registry cũng được bảo vệ:
 *
 * - `{ mount: 'docs', path: '/api' }` → topology `docs/api` ≠ `docs` →
 *   **reject**. Đường dẫn đó thuộc mount `docs/api`; caller phải dựng
 *   `{ mount: 'docs/api' }`;
 * - `{ mount: 'docs', path: '/guide' }` → topology vẫn `docs` → accept;
 * - `{ mount: 'docs/api', path: '/guide' }` → topology vẫn `docs/api` →
 *   accept.
 *
 * Pathname hỏng cấu trúc (`//`, trailing slash, `?`/`#`) vẫn do
 * `localizePath`/`parsePublicPath` xử lý với reason của chúng trước khi
 * topology check chạy — builder không kiểm tra cấu trúc lần hai.
 */
export function buildPublicPath(input: PublicLayoutPathInput): PublicLayoutPathResult {
  if (input === null || input === undefined) {
    return invalidLayoutPath('unsupported_locale');
  }

  if (!isPublicLocale(input.locale)) {
    return invalidLayoutPath('unsupported_locale');
  }

  const { mount, path } = input;

  if (mount === undefined) {
    if (path !== undefined && path !== '') {
      return invalidLayoutPath('unknown_mount');
    }
    return buildLocalized(input.locale, '/');
  }

  if (!isPublicMount(mount)) {
    return invalidLayoutPath('unknown_mount');
  }

  if (path !== undefined && path !== '') {
    if (typeof path !== 'string' || !path.startsWith('/')) {
      return invalidLayoutPath('not_a_pathname');
    }
  }

  const built = buildLocalized(input.locale, `/${mount}${path ?? ''}`);

  // Topology boundary check: pathname vừa dựng mà parse ra mount khác mount
  // caller yêu cầu nghĩa là resource path đã đi vào một mount lồng nhau khác
  // (deepest-first) — từ chối thay vì trả kết quả với topology bị đổi ngầm.
  if (built.kind === 'localized' && built.mount !== mount) {
    return invalidLayoutPath('unknown_mount');
  }
  return built;
}

/** Ghép resource path hợp lệ vào locale qua `localizePath` rồi parse kết quả. */
function buildLocalized(locale: PublicLocale, resourcePath: string): PublicLayoutPathResult {
  const localized = localizePath(locale, resourcePath);
  if (localized.kind === 'invalid') {
    return invalidLayoutPath(localized.reason);
  }
  return parsePublicLayoutPath(localized.path);
}
