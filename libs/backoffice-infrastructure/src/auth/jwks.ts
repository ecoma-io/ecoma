/**
 * JWKS client của `backoffice` — fetch `GET {issuer}/jwks.json` và cache theo
 * TTL với re-fetch khi gặp `kid` lạ.
 *
 * ## Vì sao cache ở isolate memory mà không vi phạm invariant 12
 *
 * Invariant 12 (`docs/architecture/01-architecture.md` §9) cấm **correctness**
 * phụ thuộc isolate-global state: một isolate chết phải không làm mất dữ liệu
 * có nghĩa. Cache JWKS thỏa điều kiện đó theo cả hai hướng:
 * - Cache **đủ** thì không đổi kết quả — key public, verify bằng cache hay
 *   fetch mới cho cùng một chữ ký hợp lệ.
 * - Cache **thiếu** (isolate mới, TTL hết, `kid` lạ) thì fetch lại — đường
 *   duy nhất mà verify phụ thuộc là network fetch, không phải memory.
 *
 * Nói cách khác: đúng hay sai của một verify không bao giờ phụ thuộc việc
 * cache có còn hay không — chỉ latency phụ thuộc. Đó là biên giữa "cache"
 * (được phép) và "authority" (cấm ở Worker memory, invariant 6).
 *
 * ## Re-fetch khi `kid` lạ (kèm cửa sổ cooldown của `jose`)
 *
 * Key rotation của `auth` có thể thêm `kid` mới trước khi cache TTL hết. Một
 * verifier chỉ tra cache sẽ 401 một token hợp lệ ký bằng key mới. Vì vậy:
 * `kid` không thấy trong JWKS hiện có ⇒ fetch JWKS mới **một lần** rồi kết
 * luận; key vẫn không thấy ⇒ 401 (rotation gỡ `kid` khỏi JWKS là chính sách
 * công bố — ADR-0012 §2).
 *
 * ⚠️ `createRemoteJWKSet` có **cooldown** (`cooldownDuration`, dưới đây ghim
 * 30s): kể từ lần fetch cuối, trong cửa sổ cooldown một `kid` lạ **không**
 * trigger re-fetch — kết luận ngay `401`. Đây là van chống fetch-storm khi có
 * flood token với `kid` bịa: tối đa một fetch mỗi cửa sổ cooldown. Hệ quả chấp
 * nhận được: sau rotation, token ký bằng key mới bị 401 nhiều nhất một cửa sổ
 * cooldown (30s) — rotation chuẩn công bố key mới **trước** khi dùng key mới
 * ký, nên cửa sổ này không nằm trên đường correctness của rotation có chủ đích.
 *
 * ⚠️ Single-flight: hai request cùng gặp `kid` lạ phải chỉ tạo một fetch —
 * giữ promise đang chạy ở module scope và trả lại cho cả hai. Không có cơ chế
 * này thì mỗi request đúng lúc TTL hết là một fetch JWKS.
 */

import { createRemoteJWKSet } from 'jose';
import type { JWTVerifyGetKey } from 'jose';

/**
 * TTL của JWKS cache (giây) — 10 phút. Đồng bộ với `cacheMaxAge` mặc định của
 * `jose` (dưới đây); module này bọc TTL riêng vì kiến trúc cache theo issuer.
 *
 * Đủ ngắn để rotation key của `auth` lan tới `backoffice` trong một cửa sổ
 * nhỏ; đủ dài để tần suất fetch không thành serving-path load lên `auth`.
 * Rotation có chủ đích của `auth` đi kèm việc publish key mới **trước** gỡ
 * key cũ (chuẩn JWKS rotation), nên TTL này không nằm trên đường correctness
 * của rotation.
 */
export const JWKS_CACHE_TTL_SECONDS = 600;

/**
 * Cooldown của re-fetch-on-unknown-kid (ms) — mặc định 30s của `jose`, khai
 * tường minh để hành vi không phụ thuộc default ẩn của thư viện.
 */
const JOSE_COOLDOWN_MS = 30_000;

/**
 * Cache entry: JWKS resolver + mốc tạo. `createRemoteJWKSet` của `jose` tự
 * quản cooldown/coalesce bên trong cho re-fetch theo `kid`, nhưng KHÔNG có
 * TTL — vì vậy module này bọc thêm vòng đời TTL của chính nó.
 */
interface JwksCacheEntry {
  readonly resolver: JWTVerifyGetKey;
  readonly createdAtMs: number;
}

/**
 * Cache theo issuer — mỗi issuer một entry, vì hai môi trường `auth` (staging
 * `auth.staging…` và local) có key khác nhau; cache chung một entry là verify
 * token của issuer A bằng key của issuer B (luôn fail, nhưng fail vì lý do
 * sai).
 */
const cacheByIssuer = new Map<string, JwksCacheEntry>();

/** In-flight fetch theo issuer — single-flight của {@link jwksResolver}. */
const inflightByIssuer = new Map<string, Promise<JWTVerifyGetKey>>();

function cachedResolver(issuer: string, nowMs: number): JWTVerifyGetKey | null {
  const entry = cacheByIssuer.get(issuer);
  if (entry === undefined) {
    return null;
  }
  if (nowMs - entry.createdAtMs >= JWKS_CACHE_TTL_SECONDS * 1000) {
    cacheByIssuer.delete(issuer);
    return null;
  }
  return entry.resolver;
}

/**
 * Fetch JWKS của issuer và dựng resolver — ném khi `auth` không trả lời được
 * (caller phân loại `503`).
 *
 * URL JWKS được dựng từ `fetchOrigin` — **không phải** issuer — vì trên local
 * container Node không đi ra được origin công khai của issuer (hostname không
 * resolve, host port bind loopback); issuer chỉ còn vai trò danh tính, còn
 * fetch đi qua origin nội bộ do deploy layer cấp. Production truyền
 * `undefined` (mặc định) và URL rơi về issuer như cũ.
 *
 * `createRemoteJWKSet` fetch **lazy** ở lần verify đầu, không phải lúc gọi
 * hàm — vì vậy cả timeout lẫn lỗi network nằm ở `jwtVerify`, và việc này
 * thuộc về phân loại lỗi của caller (`503` theo ADR-0011), không phải ở đây.
 */
async function fetchResolver(issuer: string, fetchOrigin?: string): Promise<JWTVerifyGetKey> {
  const jwksUrl = new URL('/jwks.json', fetchOrigin ?? issuer).toString();
  return createRemoteJWKSet(new URL(jwksUrl), { cooldownDuration: JOSE_COOLDOWN_MS });
}

/**
 * Trả resolver JWKS cho issuer — cache-hit thì trả ngay, cache-miss thì fetch
 * (single-flight) rồi cache.
 *
 * ⚠️ Hàm này **không bao giờ** trả resolver của issuer khác: khoá cache là
 * issuer, và `fetchResolver` dựng URL từ chính issuer được truyền vào.
 *
 * @param issuer Issuer của `auth` — khóa cache và là base URL JWKS mặc định.
 * @param fetchOrigin Tuỳ chọn: origin dựng URL fetch thay cho issuer (không
 *   path cuối). KHÔNG tham gia khóa cache — cache vẫn theo issuer, nên hai lần
 *   gọi cùng issuer với origin khác nhau nhận cùng resolver và origin hiệu
 *   lực là origin của lần dựng đầu. Caller thật không bao giờ rơi vào trường
 *   hợp đó: origin là cấu hình deployment ổn định suốt tiến trình (production
 *   không đặt — luôn `undefined`; local đặt từ lúc container boot).
 */
export function jwksResolver(issuer: string, fetchOrigin?: string): Promise<JWTVerifyGetKey> {
  const nowMs = Date.now();
  const cached = cachedResolver(issuer, nowMs);
  if (cached !== null) {
    return Promise.resolve(cached);
  }

  const inflight = inflightByIssuer.get(issuer);
  if (inflight !== undefined) {
    return inflight;
  }

  const fetchPromise = fetchResolver(issuer, fetchOrigin)
    .then((resolver) => {
      cacheByIssuer.set(issuer, { resolver, createdAtMs: Date.now() });
      return resolver;
    })
    .finally(() => {
      inflightByIssuer.delete(issuer);
    });
  inflightByIssuer.set(issuer, fetchPromise);
  return fetchPromise;
}

/**
 * Xoá sạch cache — chỉ test dùng, production không có caller nào.
 *
 * ⚠️ Không export dưới dạng "refresh": đường refresh đúng của production là
 * re-fetch-on-unknown-kid đã cài ở verify, không phải một hàm caller chủ đích
 * gọi — caller không bao giờ đủ thông tin để quyết định "key đã đổi", JWKS
 * mới mới là nguồn quyết định.
 */
export function resetJwksCacheForTests(): void {
  cacheByIssuer.clear();
  inflightByIssuer.clear();
}
