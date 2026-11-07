<script setup lang="ts">
/**
 * `/login` — đăng nhập passwordless.
 *
 * ⚠️ **Không có ô mật khẩu, không có liên kết "quên mật khẩu", không có trang đặt
 * lại.** Ecoma là passwordless và sẽ giữ nguyên như vậy. `login.noPasswordNote`
 * nói thẳng để người dùng không phải tìm chỗ đó, và không có markup nào trên trang
 * này chứa `type="password"` hay từ khoá `password` trong `href`.
 *
 * ⚠️ **Không có nút đăng nhập bằng passkey.** Tài liệu chưa chốt passkey là đường
 * đăng nhập chính, nên trang không đề nghị nó.
 *
 * ⚠️ **Bước nhập mã chỉ render khi adapter nói `'code'`.** Tài liệu chưa chốt cơ
 * chế challenge (`01-architecture.md` §10), nên UI không đoán: `LoginChallenge.mode`
 * là đầu vào, và mặc định của bản mock là `email-link` — chế độ không có bước nhập
 * mã. `login-flow.spec.ts` chạy cả hai chế độ để chứng minh điều đó.
 *
 * ⚠️ **Continuation handle không bị đụng.** `?handle=X` do `auth` đưa tới và được
 * chuyển tiếp nguyên vẹn trong `requestLoginChallenge`, không đọc, không diễn
 * giải, không log, không đưa vào storage, không dán vào link khác.
 *
 * ⚠️ **Hop `/authorize/confirm` sau khi mã được chấp nhận (§5.1.2 hàng 7).** Khi
 * verify thành công và có `?handle=`, response verify của BFF mang `confirmUrl`
 * — URL do **server** dựng tới `GET {authIssuer}/authorize/confirm?handle=X`.
 * Trang chỉ relay nó bằng điều hướng browser (`window.location.assign`), KHÔNG
 * tự ghép chuỗi, KHÔNG thêm tham số. Hop này là bắt buộc của protocol: cookie
 * `__Host-auth-browser` của browser được xác nhận ở đó rồi auth mới chấp nhận
 * push `session/verified` (điều kiện 2 §5.1.0 — chốt chặn handle-theft).
 * `completeHandoff` (push back-channel) là việc của `/login/continue`, trang này
 * KHÔNG gọi nó. Khi server không cấp URL (chưa cấu hình issuer, handle lệch
 * binding…), người dùng thấy trạng thái "không tiếp tục được" — đăng nhập vẫn
 * thành công, không có đường fallback tự chế. Không handle ⇒ đăng nhập account
 * thuần, giữ nguyên accepted.
 */
import type { LoginChallenge } from '../../account-data/types';

definePageMeta({ layout: 'auth' });

const i18n = useI18n();
const adapter = useAccountAdapter();
const route = useRoute();

const email = ref('');
const submitting = ref(false);
const requestFailed = ref(false);
const challenge = ref<LoginChallenge | undefined>(undefined);
const code = ref('');
const codeFailed = ref(false);

/**
 * Continuation không cấp được sau verify — server từ chối hoặc chưa cấu hình.
 * Người dùng thấy dòng giải thích (cùng câu chữ của `/login/continue`) mà không
 * hứa một URL tiếp theo nào; đăng nhập vẫn thành công.
 */
const continuationUnavailable = ref(false);

/**
 * Mã đã được chấp nhận hay chưa.
 *
 * ⚠️ Tách khỏi `codeFailed`: `codeFailed = false` không phân biệt được "mã đúng"
 * với "chưa bấm". Trước khi có trạng thái này, `verifyLoginCode` trả `ok: true`
 * không đổi gì trên màn hình — người dùng bấm "Đăng nhập" rồi im lặng, và không
 * có cách nào biết bước này đã xong. Điều hướng sang `confirmUrl` xảy ra **sau**
 * khi trạng thái này render — phản hồi verify phải được nhìn thấy trước khi rời
 * trang.
 */
const codeAccepted = ref(false);

/**
 * Đã gửi lại email thành công hay chưa.
 *
 * ⚠️ Phải là trạng thái **riêng**, không dùng lại `challenge`: gửi lại thành công
 * làm `challenge` được ghi giá trị mới, nhưng người dùng cần thấy một câu xác nhận
 * "đã gửi lại" — im lặng sau khi bấm nút khiến họ bấm lần nữa. Reset ở cả ba chỗ:
 * bắt đầu gửi mới, gửi lại thành công, và `startOver`.
 */
const resendSent = ref(false);

/**
 * Handle continuation do `auth` cấp trong `continue_url`
 * (`docs/applications/auth/01-architecture.md` §5.1.1).
 *
 * Đọc bằng `route.query.handle` và giữ nguyên **chuỗi** — không parse, không kiểm
 * tra định dạng, không so với bất kỳ danh sách nào. Handle là giá trị opaque; mọi
 * kiểm tra cục bộ về nó đều là giả định sai về nội dung của một thứ không được
 * phép đoán.
 *
 * ⚠️ Nó **chỉ** được đưa vào `requestLoginChallenge` — đúng một call-site, đúng
 * luồng đã được thiết lập. Không log, không `useState`, không `localStorage`, không
 * analytics, và không dán vào bất kỳ liên kết nào khác: mọi đường đi thêm đều là
 * một lần rò handle ra ngoài luồng mà sinh ra nó (FR-006k3).
 */
const continuationHandle = computed(() => {
  const value = route.query.handle;
  return typeof value === 'string' ? value : undefined;
});

const challengeNeedsCode = computed(() => challenge.value?.mode === 'code');

async function requestChallenge(): Promise<void> {
  if (email.value.trim() === '') {
    return;
  }
  // Gửi lại hay gửi lần đầu đều qua đây; chỉ ghi nhận "đã gửi lại" khi thử lại
  // từ một challenge đang mở, để không hiện câu xác nhận ở lần gửi đầu.
  const isResend = challenge.value !== undefined;
  submitting.value = true;
  requestFailed.value = false;
  resendSent.value = false;
  codeFailed.value = false;
  codeAccepted.value = false;
  continuationUnavailable.value = false;
  try {
    // Handle đi kèm đây và **chỉ** ở đây — xem khối chú thích của
    // `continuationHandle` ở trên.
    const requested = await adapter.requestLoginChallenge(
      email.value.trim(),
      continuationHandle.value,
    );
    if (requested.ok) {
      challenge.value = requested.value;
      resendSent.value = isResend;
    } else {
      requestFailed.value = true;
    }
  } catch {
    // `postJson` dùng fetch thô — lỗi mạng/DNS ném thay vì trả `Result`; bỏ
    // catch là một vòng retry im lặng (unhandled rejection, không trạng thái).
    requestFailed.value = true;
  } finally {
    submitting.value = false;
  }
}

async function submitCode(): Promise<void> {
  submitting.value = true;
  codeFailed.value = false;
  codeAccepted.value = false;
  continuationUnavailable.value = false;
  // URL confirm giữ **local** trong hàm này — không bao giờ vào state của trang
  // hay bất kỳ biến nào sống lâu hơn một tick (FR-006k3: không log, không render,
  // không storage; duy nhất một đường điều hướng tiêu thụ nó).
  let confirmUrl: string | undefined;
  try {
    const verified = await adapter.verifyLoginCode(code.value.trim());
    codeFailed.value = !verified.ok;
    if (verified.ok) {
      codeAccepted.value = true;
      confirmUrl = verified.value.confirmUrl;
    }
  } catch {
    // Lỗi ném (network/transport) cũng là verify thất bại — không để unhandled
    // rejection; người dùng phải thấy trạng thái lỗi để có thể retry.
    codeFailed.value = true;
    codeAccepted.value = false;
  } finally {
    submitting.value = false;
  }

  // Điều hướng chạy SAU khi `submitting` đã về `false`: màn hình phản hồi verify
  // ("Code accepted") được render trước khi rời trang — thành công phải nhìn
  // thấy được, đúng nguyên tắc relay của `/login/continue`.
  if (codeAccepted.value && continuationHandle.value !== undefined) {
    if (typeof confirmUrl === 'string') {
      // Đích do server quyết định: relay nguyên vẹn — không tự ghép chuỗi, không
      // thêm tham số. Điều hướng client-side SPA không dùng được vì URL là origin
      // của `auth`; `window.location.assign` là trung thực nhất.
      window.location.assign(confirmUrl);
      return;
    }
    continuationUnavailable.value = true;
  }
}

function startOver(): void {
  challenge.value = undefined;
  code.value = '';
  codeFailed.value = false;
  codeAccepted.value = false;
  requestFailed.value = false;
  resendSent.value = false;
  continuationUnavailable.value = false;
}
</script>

<template>
  <section class="account-card space-y-5 p-6" data-testid="login-card">
    <div>
      <h1 class="text-xl font-semibold tracking-tight text-foam">
        {{ i18n.t('login.title') }}
      </h1>
      <p class="mt-2 text-sm text-muted">{{ i18n.t('login.description') }}</p>
    </div>

    <form
      v-if="!challenge"
      class="space-y-4"
      data-testid="login-email-form"
      @submit.prevent="requestChallenge"
    >
      <div>
        <label class="account-label" for="login-email">{{ i18n.t('login.email') }}</label>
        <input
          id="login-email"
          v-model="email"
          class="account-field mt-1"
          type="email"
          autocomplete="email"
          required
          data-testid="login-email"
        />
      </div>
      <button
        type="submit"
        class="account-button-primary w-full"
        :disabled="submitting"
        data-testid="login-submit"
      >
        {{ submitting ? i18n.t('login.submitting') : i18n.t('login.submit') }}
      </button>
    </form>

    <div v-else class="space-y-4" data-testid="login-challenge">
      <div>
        <h2 class="text-base font-semibold text-foam">
          {{ i18n.t('login.checkTitle') }}
        </h2>
        <p class="mt-1 text-sm text-muted">
          {{ i18n.t('login.checkBody', { email: challenge.email }) }}
        </p>
      </div>

      <form
        v-if="challengeNeedsCode"
        class="space-y-4"
        data-testid="login-code-form"
        @submit.prevent="submitCode"
      >
        <div>
          <label class="account-label" for="login-code">{{ i18n.t('login.codeLabel') }}</label>
          <input
            id="login-code"
            v-model="code"
            class="account-field mt-1"
            type="text"
            inputmode="numeric"
            autocomplete="one-time-code"
            required
            data-testid="login-code"
          />
          <p class="account-hint">
            {{ i18n.t('login.codeBody', { email: challenge.email }) }}
          </p>
        </div>
        <button
          type="submit"
          class="account-button-primary w-full"
          :disabled="submitting"
          data-testid="login-code-submit"
        >
          {{ i18n.t('login.codeSubmit') }}
        </button>
        <p
          v-if="codeFailed"
          class="text-sm text-danger"
          role="alert"
          data-testid="login-code-invalid"
        >
          {{ i18n.t('login.codeInvalid') }}
        </p>
        <p
          v-else-if="codeAccepted"
          class="text-sm text-success"
          role="status"
          data-testid="login-code-accepted"
        >
          {{ i18n.t('login.codeAccepted') }}
        </p>
      </form>

      <!--
        Trạng thái "không tiếp tục được" nằm NGOÀI form nhập mã: nó là kết quả
        của nhánh không cấp `confirmUrl` (chưa cấu hình issuer, handle lệch
        binding), không thuộc về vòng đời của form. Không có retry — đăng nhập
        đã thành công và không có đường điều hướng nào để thử lại; câu chữ dùng
        chung catalog với `/login/continue`.
      -->
      <p
        v-if="continuationUnavailable"
        class="text-sm text-muted"
        role="status"
        data-testid="login-handoff-unavailable"
      >
        {{ i18n.t('loginContinue.body') }}
      </p>

      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          class="account-button-secondary"
          data-testid="login-resend"
          @click="requestChallenge"
        >
          {{ i18n.t('login.resend') }}
        </button>
        <button
          type="button"
          class="account-button-secondary"
          data-testid="login-change-email"
          @click="startOver"
        >
          {{ i18n.t('login.changeEmail') }}
        </button>
      </div>
    </div>

    <!--
      Hai thông báo này nằm NGOÀI cả `form` lẫn nhánh challenge, vì cả hai đều
      đến từ `requestChallenge` — hàm chạy ở cả hai nhánh. Để trong `form`
      (nhánh `v-if="!challenge"`) nghĩa là gửi lại thất bại không hiện gì cả:
      người dùng bấm "Gửi lại" rồi im lặng, và `login.resendSent` có trong cả
      ba catalog mà không nơi nào dùng.
    -->
    <p
      v-if="requestFailed"
      class="text-sm text-danger"
      role="alert"
      data-testid="login-request-failed"
    >
      {{ i18n.t('login.errorTitle') }} — {{ i18n.t('login.errorBody') }}
    </p>
    <p
      v-else-if="resendSent"
      class="text-sm text-success"
      role="status"
      data-testid="login-resend-sent"
    >
      {{ i18n.t('login.resendSent') }}
    </p>

    <p class="border-t border-line pt-4 text-xs text-muted" data-testid="login-no-password">
      {{ i18n.t('login.noPasswordNote') }}
    </p>
  </section>
</template>
