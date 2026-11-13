/**
 * Trạng thái phiên của shell — login/logout UI cho thanh header.
 *
 * ## Vì sao tách khỏi lớp dữ liệu (`backoffice-data`)
 *
 * Lớp dữ liệu là đường **dữ liệu** (staff/roles/…), còn phiên là đường **danh
 * tính**: login/logout không trả dữ liệu nào cho trang render, và bắt buộc chạy
 * thật trong **mọi** data mode (ADR-0012 — BFF dựng authorize URL; fixture/mock
 * không được phép mô phỏng xác thực). Gắn login vào adapter là gắn sai ranh giới.
 *
 * ## Nguồn sự thật của trạng thái
 *
 * `GET /api/auth/session` — route probe luôn-200 đặt **ngoài** boundary authn
 * (`server/middleware/authn.ts`), soi cookie + DB + token bằng cùng logic với
 * middleware nhưng **không bao giờ** trả 5xx: backend chết thì probe trả
 * `{ authenticated: false }` kèm log `session_probe.degraded`, không phải lỗi.
 * Shell chỉ render nút khi probe **thành công** trả lời; mọi kết cục khác (mạng
 * đứt, response phi hợp đồng) giữ `unknown` — "không có bằng chứng" render **không
 * gì**, không phải giả định "chưa đăng nhập" (giả định đó biến một người dùng đã
 * đăng nhập thành nút "Log in" — nói dối UI đúng kiểu mà fail-closed chặn).
 *
 * ⚠️ Probe chỉ chạy **client-side** (`onMounted` ở component gọi): SPA non-SSR
 * (issue #67) render skeleton đầu tiên trên client, và probe same-origin không có
 * gì để làm ở server. `unknown` ⇒ template render **không** có nút nào — không có
 * flash "Log in" nhấp nháy trước khi probe kịp trả lời.
 *
 * ## Logout: double-submit CSRF
 *
 * `POST /api/auth/logout` yêu cầu cookie `__Host-backoffice-csrf` echo trong
 * header `x-ecoma-csrf` (route `logout.post.ts`). Browser đọc được cookie đó vì
 * nó không HttpOnly — khác với session cookie (`__Host-backoffice-session`,
 * HttpOnly, token không bao giờ về JS). Sau `204`, điều hướng full-page về `/`:
 * mọi state in-memory (kể cả trạng thái lỗi "phiên hết hạn") chết cùng phiên.
 *
 * ## Vì sao nút là `<button>`, không phải `<a href>`
 *
 * Login/logout là **hành động** (kéo state server-side), không phải navigation
 * nội bộ của router. Nút `<button>` giữ riêng hai loại đó: bộ test browser
 * assert `internalHrefs()` (mọi link nội bộ trỏ đúng route nav) không phải nhìn
 * thấy href auth, và assert "mọi control có tên không phải thao tác ghi" vẫn
 * khớp — "Log in"/"Log out" không chứa từ khoá thao tác ghi nào.
 */
import { ref, type Ref } from 'vue';

import { useNuxtApp, type NuxtApp } from '#app';

/**
 * ⚠️ Tên cookie + header nằm **trùng** với `libs/backoffice-infrastructure`
 * (`session-store.ts`) — nguồn sự thật server. App layer không import package
 * infra (bundle client sẽ kéo theo pool/db), nên hai hằng này được khai lại ở
 * đây; nếu server đổi tên, bộ test browser của shell (double-submit thật) đỏ —
 * không có chế độ "sai im lặng".
 */
const CSRF_COOKIE_NAME = '__Host-backoffice-csrf';
/** Header double-submit tương ứng — cùng luật với `account`. */
const CSRF_HEADER_NAME = 'x-ecoma-csrf';

/**
 * Điểm đăng nhập duy nhất của UI: điều hướng tới kickoff của BFF. Export cho
 * `BackofficeErrorState` (CTA "Log in again" của trang lỗi 401): hai đường
 * đăng nhập của app phải chỉ vào **cùng một** path — một string literal thứ
 * hai là một drift chờ xảy ra.
 */
export const LOGIN_PATH = '/api/auth/login';
/** Route logout của BFF — idempotent, luôn 204 khi gọi tới được. */
const LOGOUT_PATH = '/api/auth/logout';

/**
 * Ba trạng thái của phiên từ góc nhìn shell.
 *
 * `unknown` là trạng thái **điểm bắt đầu**, không phải trạng thái lỗi: chưa có
 * bằng chứng nào về phiên (probe chưa chạy, hoặc probe không trả lời được).
 */
export type BackofficeSessionStatus = 'unknown' | 'authenticated' | 'unauthenticated';

export type BackofficeSession = {
  readonly status: Ref<BackofficeSessionStatus>;
  /** Đang chờ logout hoàn tất — nút đổi nhãn và khoá, chặn double-click. */
  readonly loggingOut: Ref<boolean>;
  /** Hỏi lại server về phiên. Client-side; an toàn gọi lại nhiều lần. */
  readonly refresh: () => Promise<void>;
  /** Kéo người dùng vào đường đăng nhập của BFF (full navigation). */
  readonly login: () => void;
  /** Hủy phiên server-side rồi quay về trang chủ (full navigation). */
  readonly logout: () => Promise<void>;
};

type SessionNuxtApp = NuxtApp & {
  $backofficeSession?: BackofficeSession;
};

/** Hình dạng route probe trả về — luôn 200 theo hợp đồng. */
type SessionProbeResponse = {
  readonly authenticated: boolean;
};

/**
 * Đọc cookie CSRF bằng semantics của `document.cookie`.
 *
 * Cookie nhiều cặp `name=value; name=value`; giá trị bị encode khi set, nên phải
 * `decodeURIComponent` (và `value` có thể tự chứa `=` — chỉ cắt cặp đầu).
 */
function readCsrfToken(): string | undefined {
  if (typeof document === 'undefined') {
    return undefined;
  }
  for (const part of document.cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === CSRF_COOKIE_NAME) {
      return decodeURIComponent(rest.join('='));
    }
  }
  return undefined;
}

/**
 * Ở **module scope** (không trong `createBackofficeSession`): hàm không đọc
 * ref nào của phiên, và một hàm thuần túy tái tạo mỗi lần gọi là nhiễu không
 * cần thiết (oxlint `unicorn/consistent-function-scoping` — cùng chiều).
 *
 * ⚠️ Chỉ gọi từ **event handler client-side** (nút của shell, CTA của trang
 * lỗi): SSR render không bao giờ gọi nó. Một guard `typeof window` ở đây sẽ
 * biến lỗi "gọi sai thời điểm" thành no-op im lặng — để nó ném ngay thì rõ
 * hơn, nên hàm cố ý không có guard.
 */
function login(): void {
  window.location.assign(LOGIN_PATH);
}

function createBackofficeSession(): BackofficeSession {
  const status = ref<BackofficeSessionStatus>('unknown');
  const loggingOut = ref(false);

  /**
   * Probe phiên. Chỉ một kết quả 200 có body đúng hợp đồng được tin: bất kỳ
   * kết cục khác (mạng lỗi, status lạ, body lạ) đều giữ `unknown` — xem JSDoc
   * "Nguồn sự thật của trạng thái".
   */
  async function refresh(): Promise<void> {
    let response: Response;
    try {
      response = await fetch('/api/auth/session', { credentials: 'same-origin' });
    } catch {
      return;
    }
    if (!response.ok) {
      return;
    }
    let body: SessionProbeResponse;
    try {
      body = (await response.json()) as SessionProbeResponse;
    } catch {
      return;
    }
    status.value = body.authenticated === true ? 'authenticated' : 'unauthenticated';
  }

  async function logout(): Promise<void> {
    if (loggingOut.value) {
      return;
    }
    loggingOut.value = true;
    try {
      const headers: Record<string, string> = {};
      const csrf = readCsrfToken();
      // Thiếu cookie CSRF ⇒ gửi không header, để server 403 theo hợp đồng của nó:
      // client không tự đoán thay server được.
      if (csrf !== undefined) {
        headers[CSRF_HEADER_NAME] = csrf;
      }
      const response = await fetch(LOGOUT_PATH, {
        method: 'POST',
        headers,
        credentials: 'same-origin',
      });
      // Chỉ kết cục hợp đồng (204) mới điều hướng: lỗi CSRF/session server từ chối
      // thì phiên còn nguyên — hỏi lại probe thay vì đá người dùng về trang chủ.
      if (response.status === 204) {
        status.value = 'unauthenticated';
        window.location.assign('/');
        return;
      }
      await refresh();
    } catch {
      await refresh();
    } finally {
      loggingOut.value = false;
    }
  }

  return { status, loggingOut, refresh, login, logout };
}

/**
 * Composable phiên — singleton trên `nuxtApp` (cùng pattern với
 * `use-backoffice-adapter.ts`): một probe cho cả app, mọi call-site thấy cùng
 * một `status`. SSR tạo app riêng mỗi request nên không rò state giữa requests.
 */
export function useBackofficeSession(): BackofficeSession {
  const nuxtApp = useNuxtApp() as SessionNuxtApp;
  nuxtApp.$backofficeSession ??= createBackofficeSession();
  return nuxtApp.$backofficeSession;
}
