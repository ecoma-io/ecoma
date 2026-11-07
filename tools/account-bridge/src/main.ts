/**
 * Shim worker `ecoma-account-bridge` — mặt trước service-binding của container
 * account trên local platform (`docs/architecture/local-development/02-account-auth-topology.md`
 * §Service bindings).
 *
 * ## Vì sao shim tồn tại
 *
 * Contract thật của `auth` gọi `account` qua service binding: `env.ACCOUNT_SERVICE
 * .fetch(request)` (`apps/auth/src/account-client.ts`). Trên local platform,
 * `account` là container Node (Nitro `node-server`), mà dev registry của
 * `wrangler dev` CHỈ chứa entry do workerd process đăng ký (platform facts
 * PF7) — không thể đăng ký container Node thuần làm target binding. Worker
 * shim chuyển tiếp fetch qua HTTP thuần tới upstream bất kỳ là đường đã đo
 * chạy end-to-end (PF8), nên container account được "bọc" bằng shim này:
 *
 *   auth → binding ACCOUNT_SERVICE → shim (worker) → HTTP → container account
 *
 * Shape binding giữ nguyên 100% — `auth` không biết và không cần biết nó đang
 * nói chuyện với shim. Bên trong là HTTP plain, đúng ngữ nghĩa service binding
 * production (binding không cung cấp TLS); bảo mật lớp application là envelope
 * HMAC `ecoma-internal-v1` mà cả auth lẫn account tự ký/verify ở đầu hồi —
 * shim chuyển tiếp mù: không giữ khoá, không parse body có ý nghĩa.
 *
 * ## Fail-closed
 *
 * Upstream khai qua biến `BRIDGE_TARGET_ORIGIN` (đường `.dev.vars` của shim).
 * Thiếu biến ⇒ mọi request qua binding nhận `503 upstream_unconfigured` —
 * KHÔNG có default chỉ trỏ loopback hay chuỗi rỗng, vì một default sai là đúng
 * kiểu "chạy được nhưng sai nơi" mà thiết kế cấm. `auth` vẫn boot; `/ready`
 * của auth đỏ qua probe ACCOUNT_SERVICE (`02-account-auth.md` §Dependency graph —
 * bridge fail-closed, readiness đỏ khi account chết).
 */

/** Cấu hình runtime của shim — inject từ env (`wrangler dev` đọc `.dev.vars`). */
export interface BridgeEnv {
  /** Origin của upstream (vd `http://ecoma-wxxxxxxxxxxxx-account:3000`) — không path cuối. */
  readonly BRIDGE_TARGET_ORIGIN?: string;
}

/**
 * Các method được chuyển tiếp. Contract Account↔Auth dùng POST (`/internal/*`
 * hai chiều); GET được cho phép để probe reachability (`/ready` của auth gọi
 * một GET nhẹ tới account) mà không biến shim thành open proxy cho method khác.
 */
const FORWARDED_METHODS = new Set(['GET', 'POST']);

/**
 * Header hop-by-hop của HTTP — KHÔNG được sao chép sang request/response mới
 * (RFC 9110 §7.6.1). `fetch` của runtime tự dựng framing từ body; giữ lại
 * `transfer-encoding`/`connection` của request gốc là cách lệch framing.
 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

/**
 * Route liveness — path được poll bởi orchestration `local-worker-up` theo
 * marker `http-health`. Trả mà KHÔNG chạm upstream: trạng thái sống của shim
 * không được phụ thuộc trạng thái upstream, nếu không account chết là shim bị
 * coi chết và dev registry thu hồi entry — đúng vòng lỗi mà `/health` (liveness)
 * tách khỏi `/ready` (readiness) phải tránh.
 */
const HEALTH_PATH = '/health';

/** Ghi MỘT dòng log JSON với mã ổn định — không giá trị header, không origin. */
function logLine(payload: Record<string, unknown>): void {
  try {
    // Workers không có sink nào khác — `console.*` là đường log duy nhất
    // (override `tools/**` của .oxlintrc.json đã tắt rule `no-console`).
    console.log(JSON.stringify(payload));
  } catch {
    // Cố tình im lặng: observability không nằm trên serving path.
  }
}

export default {
  async fetch(request: Request, env: BridgeEnv): Promise<Response> {
    if (new URL(request.url).pathname === HEALTH_PATH && request.method === 'GET') {
      return Response.json({ service: 'account-bridge', status: 'ok' });
    }

    const origin = env.BRIDGE_TARGET_ORIGIN;
    if (origin === undefined || origin.trim() === '') {
      logLine({ event: 'bridge.rejected', status: 503, reason: 'upstream_unconfigured' });
      return Response.json({ error: 'upstream_unconfigured' }, { status: 503 });
    }
    if (!FORWARDED_METHODS.has(request.method)) {
      logLine({ event: 'bridge.rejected', status: 405, reason: 'method_not_allowed' });
      return Response.json({ error: 'method_not_allowed' }, { status: 405 });
    }

    // Chỉ đổi protocol + host; path, query giữ nguyên — shim trong suốt với
    // contract: auth ký envelope trên path thật (`/internal/...`), account
    // verify trên cùng path đó. Shim đổi path là phá chữ ký.
    let upstreamUrl: URL;
    try {
      upstreamUrl = new URL(request.url);
      const target = new URL(origin);
      upstreamUrl.protocol = target.protocol;
      upstreamUrl.host = target.host;
    } catch {
      // `BRIDGE_TARGET_ORIGIN` không parse được là cấu hình sai — cùng fail-closed
      // với thiếu biến, không "đoán" một origin gần đúng.
      logLine({ event: 'bridge.rejected', status: 503, reason: 'upstream_invalid' });
      return Response.json({ error: 'upstream_unconfigured' }, { status: 503 });
    }

    const headers = new Headers();
    for (const [name, value] of request.headers.entries()) {
      if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
        headers.set(name, value);
      }
    }
    // `Host` phải là host của upstream — HTTP/1.1 virtual-host routing của
    // server đích đọc Host; giữ Host của shim là request đến sai vhost.
    headers.set('host', upstreamUrl.host);

    try {
      // Body stream đi nguyên vẹn (`duplex: 'half'` là yêu cầu của undici khi
      // body là ReadableStream; không nằm trong type RequestInit của TS DOM lib
      // nên cast tường minh). Redirect KHÔNG theo: contract Account↔Auth không
      // dùng redirect, và theo redirect biến shim thành chuyển tiếp tới một
      // đích khác — trả nguyên status của upstream là fail-closed đúng nghĩa.
      const upstream = await fetch(upstreamUrl, {
        method: request.method,
        headers,
        body: request.body,
        redirect: 'manual',
        duplex: 'half',
      } as RequestInit);

      const responseHeaders = new Headers();
      for (const [name, value] of upstream.headers.entries()) {
        if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
          responseHeaders.set(name, value);
        }
      }
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    } catch {
      // Lỗi hạ tầng (connection refused, DNS, timeout) dịch thành 503 với mã
      // ổn định — KHÔNG nêu message của fetch (có thể chứa origin).
      logLine({ event: 'bridge.upstream_failed', status: 503 });
      return Response.json({ error: 'upstream_unreachable' }, { status: 503 });
    }
  },
};
