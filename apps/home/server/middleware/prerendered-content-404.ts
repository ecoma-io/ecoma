import { createError, defineEventHandler, type EventHandler } from 'h3';
import { PRERENDERED_CONTENT_PATHS } from 'virtual:prerendered-content-paths';

/**
 * Gate content path cho Worker production — chặn request tới path content
 * (`/<locale>/docs/**`, `/<locale>/blog/**`, `/<locale>/legal/**`) không tồn
 * tại trong manifest prerender **trước khi** bất kỳ query `@nuxt/content` nào
 * chạy. Đây cũng là chốt **access control của draft legal**: văn bản draft
 * không bao giờ vào manifest (production build loại trước prerender), nên
 * direct route tới draft bị 404 ngay tại đây — không dựa vào UI filter hay
 * noindex.
 *
 * Ranh giới mà file này giữ (chi tiết đầy đủ ở `nitro.config.ts`, phần
 * "Ranh giới `@nuxt/content` / Cloudflare runtime"): trên preset
 * `cloudflare-module`, `@nuxt/content` resolve database sang D1 khi request
 * chạm adapter. Content thật thì không bao giờ chạm — Cloudflare phục vụ
 * trực tiếp HTML + `_payload.json` prerendered từ static assets **trước**
 * Worker (`run_worker_first` không bật), nên Worker chỉ nhận những request
 * KHÔNG khớp asset. Với path content lạ, đó chính là dấu hiệu "content không
 * tồn tại": middleware 404 ngay tại đây, không có câu query nào chạy, không
 * bao giờ chạm `loadDatabaseAdapter`.
 *
 * File này nằm trong `server/**` thay vì `validate` của route (khác với dự
 * kiến ban đầu) vì lý do cơ học build: app code bị Vite bundle TRƯỚC
 * prerender, nên import dữ liệu sau-prerender từ app code không thể thấy
 * manifest thật (chi tiết ở `modules/prerendered-content-manifest.ts`).
 * Middleware do rollup của Nitro bundle sau prerender — thời điểm duy nhất
 * dữ liệu đã sẵn sàng. Hệ quả hành vi (giữ nguyên so với thiết kế ban đầu):
 *
 * - Path content lạ → 404 với trang lỗi SSR thật (`error.vue` + trang 404
   dùng chung), cùng status 404 với cơ chế của bản docs/blogs static cũ (nơi
 *   wrangler app tĩnh đặt `not_found_handling: "404-page"`; config hiện tại
 *   không đặt — request không khớp asset được invoke Worker) — semantics
 *   không đổi.
 * - Path lạ ngoài các mount content (vd `/fr/docs`, `/api/...`) không khớp regex
 *   mount → đi tiếp renderer, `validate` topology của route từ chối → 404
 *   như cũ, manifest không can thiệp.
 *
 * Ba môi trường, ba hành vi:
 *
 * - **Worker production**: manifest đầy đủ (virtual module lấp bởi hook
 *   `prerender:done` — cùng tiến trình build, xem module app-local) → gate
 *   áp dụng.
 * - **Prerender nội bộ** (`import.meta.prerender` được replace tĩnh thành
 *   `true` — plugin `replace` của Nitro rollup, `staticFlags.prerender`):
 *   skip. Prerenderer con render content path TRƯỚC khi manifest hoàn tất,
 *   gate phải nhường hết cho pha này.
 * - **Dev / manifest rỗng**: skip. Trong `nuxt dev` hook `prerender:done`
 *   không chạy, manifest luôn rỗng — content query chạy sqlite local, sửa
 *   file thấy ngay. (Worker production với manifest rỗng là bug build và bị
 *   chặn ở test `tests/static-output.spec.ts` — manifest phải non-empty.)
 */
const KNOWN_PATHS: ReadonlySet<string> = new Set(PRERENDERED_CONTENT_PATHS);

/** Regex mount content — phải khớp filter của hook `prerender:done` trong `nitro.config.ts` (nguồn của manifest). */
const CONTENT_MOUNT_RE = /^\/(en|vi)\/(docs|blog|legal)(\/|$)/u;

/**
 * Tạo handler gate từ một tập path prerendered cho trước. Đây là seam duy
 * nhất để test hành vi với manifest **non-empty**: bundle production không
 * truyền tham số (factory mặc định dùng `KNOWN_PATHS` build từ virtual
 * module — nguồn dữ liệu thật sau prerender), còn unit test inject manifest
 * đóng băng thay vì mutate state module.
 *
 * So khớp trên `event.path` **sau khi tách query** — không dùng
 * `getRequestURL().pathname`: h3 dựng URL đó từ raw request URL qua
 * `new URL()`, pathname giữ nguyên percent-encoding (`/vi/blog/t%E1%BA%ADm`)
 * và dot-segment đã bị resolve — trong khi khoá manifest là path đã decode
 * (route prerender của Nitro) và tầng route (`parsePublicLayoutPath`) cố ý
 * giữ byte thô. `event.path` là dạng h3 `_decodePath` đã decode — đúng
 * dạng khoá manifest; query string nằm kèm trong nó nên phải cắt trước khi
 * tra cứu (manifest chỉ chứa path, query không thuộc identity của trang).
 */
export function createPrerenderedContent404Gate(
  knownPaths: ReadonlySet<string> = KNOWN_PATHS,
): EventHandler {
  return defineEventHandler((event) => {
    if (import.meta.prerender || knownPaths.size === 0) {
      return;
    }
    const rawPath = event.path;
    const queryIndex = rawPath.indexOf('?');
    const pathname = queryIndex === -1 ? rawPath : rawPath.slice(0, queryIndex);
    if (CONTENT_MOUNT_RE.test(pathname) && !knownPaths.has(pathname)) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Content Not Found',
        /**
         * Không `fatal` (mặc định `true` cho lỗi ngoài app): lỗi non-fatal đi
         * qua Nuxt error renderer → `error.vue` SSR thật. `fatal: true` sẽ
         * rơi vào trang lỗi thô của Nitro, mất shell dùng chung.
         */
        fatal: false,
      });
    }
  });
}

export default createPrerenderedContent404Gate();
