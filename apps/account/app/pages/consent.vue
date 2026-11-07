<script setup lang="ts">
/**
 * `/consent` — uỷ quyền OAuth.
 *
 * ⚠️ **Không có một quyết định protocol nào trong trang này.** Không dựng
 * `redirect_uri`, không đặt `code`, không đổi `state`, không gửi `client_id` hay
 * `scope` đi đâu. `auth` sở hữu authorization transaction và là bên duy nhất tạo
 * redirect cuối (`docs/applications/auth/01-architecture.md` §5.1.1, FR-006o,
 * FR-010). Đây là lý do `ConsentContext` cố ý **không có** trường `redirectUri`:
 * không có nó trong kiểu thì không có chỗ nào để dựng URL sai.
 *
 * ⚠️ Không tin `client_id`, scope hay danh tính người dùng từ browser. Mọi thứ
 * hiển thị ở đây — tên ứng dụng, danh sách quyền **đã được diễn giải sẵn**, cờ rủi
 * ro — đến từ adapter, tức là từ contract `POST /internal/consent/context` mà BFF
 * gọi dưới Service Binding đã xác thực (FR-006k, FR-011).
 *
 * ⚠️ Sau khi quyết định, trang **không** điều hướng và **không** `reload()`:
 * handle đã bị tiêu thụ sau quyết định, nên nạp lại sẽ trả `undefined` → nhánh
 * `empty` với câu "yêu cầu không còn hợp lệ" phủ lên chính thông báo vừa thành
 * công. Việc tiếp tục là một **nút relay**: URL do `auth` dựng trong kết quả
 * (`decideConsent` trả `continueUrl`), nút bấm điều hướng browser tới đó —
 * trang không tự ghép chuỗi, không thêm tham số, và không tự điều hướng.
 */
definePageMeta({ layout: 'auth' });

const i18n = useI18n();
const adapter = useAccountAdapter();
const route = useRoute();

/**
 * Handle consent `Y` từ `continue_url` (`?handle=Y`).
 *
 * Giữ nguyên chuỗi và **không** đưa vào log, storage, hay bất kỳ liên kết nào khác
 * (FR-006k2, FR-006k3). Adapter dùng nó để tra context; UI chỉ chuyển tiếp.
 */
const consentHandle = computed(() => {
  const value = route.query.handle;
  return typeof value === 'string' ? value : undefined;
});

const { state, reload } = useAsyncState(() =>
  consentHandle.value === undefined
    ? Promise.resolve(undefined)
    : adapter.getConsentContext(consentHandle.value),
);

/**
 * Context của consent, đã thu hẹp từ `AsyncState`.
 *
 * Cần một biến riêng vì `useAsyncState` giữ **một** union bốn nhánh, còn template
 * cần đúng hai: đang tải, hoặc đã có `ConsentContext` để render. Rút phần "rỗng"
 * và "lỗi" ra khỏi đây (`AccountEmptyState`/`AccountErrorState` ở template xử lý
 * riêng) để nhánh `ready` mang một giá trị không phải `undefined` — không thì
 * `state.value.clientName` là đọc thuộc tính của `undefined`.
 */
const context = computed(() => (state.value.kind === 'ready' ? state.value.value : undefined));

const deciding = ref(false);
const decided = ref<{ tone: 'success' | 'danger'; message: string } | undefined>(undefined);
/**
 * URL tiếp theo do `auth` cấp khi quyết định thành công.
 *
 * ⚠️ Có mặt **chỉ** khi kết quả thành công; điều hướng bằng nút relay bên
 * dưới (`continueToAuth`) — không tự động, không dựng URL khác.
 */
const continueUrlAfterDecision = ref<string | undefined>(undefined);
/**
 * Quyết định đã thành công — handle đã bị tiêu thụ, không thử lại được.
 *
 * ⚠️ Tách khỏi `decided`: lưu hỏng thì handle chưa bị tiêu thụ và người dùng
 * phải thử lại được, nên chỉ thành công mới khoá nút.
 */
const completed = ref(false);

async function decide(decision: 'approve' | 'deny'): Promise<void> {
  const handle = consentHandle.value;
  if (handle === undefined || deciding.value || completed.value) {
    return;
  }
  deciding.value = true;
  decided.value = undefined;
  continueUrlAfterDecision.value = undefined;
  try {
    const result = await adapter.decideConsent(handle, decision);
    decided.value = result.ok
      ? {
          tone: 'success',
          message: i18n.t(decision === 'approve' ? 'consent.approve' : 'consent.deny'),
        }
      : {
          tone: 'danger',
          message: `${i18n.t('states.saveFailed')}: ${result.reason}`,
        };
    completed.value = result.ok;
    continueUrlAfterDecision.value = result.ok ? result.value.continueUrl : undefined;
    // Không `reload()` sau quyết định: handle đã bị tiêu thụ, context cũ không còn
    // giá trị hiển thị và nhánh `empty` sẽ phủ đè lên thông báo kết quả. Nút bị
    // khoá sau khi thành công (`completed`) để không gửi lại một handle đã dùng —
    // `deciding` chỉ chặn được trong lúc promise còn chạy.
  } catch {
    // `decideConsent` có thể ném (fetch thô trong adapter thật) — lỗi ném cũng
    // là quyết định thất bại; handle chưa bị tiêu thụ nên vẫn retry được.
    decided.value = {
      tone: 'danger',
      message: `${i18n.t('states.saveFailed')}: network error`,
    };
    completed.value = false;
  } finally {
    deciding.value = false;
  }
}

/** relay `continueUrl` do `auth` cấp — điều hướng browser, không tự dựng URL. */
function continueToAuth(): void {
  const url = continueUrlAfterDecision.value;
  if (typeof url !== 'string') {
    return;
  }
  window.location.assign(url);
}

/**
 * Handle là tham số của **cả** màn hình này.
 *
 * `NuxtPage` tái sử dụng instance của page component khi chỉ đổi query, còn
 * `useAsyncState` chỉ nạp một lần ở `onMounted`. Không có watch này thì điều
 * hướng SPA `/consent?handle=A` → `/consent?handle=B` để nguyên quyền của A trên
 * màn hình trong khi `decide()` đọc handle B lúc bấm — cấp quyền nhầm ứng dụng,
 * và `completed` giữ khóa nút cho một handle hợp lệ mới.
 */
watch(consentHandle, () => {
  decided.value = undefined;
  completed.value = false;
  deciding.value = false;
  continueUrlAfterDecision.value = undefined;
  void reload();
});
</script>

<template>
  <section class="account-card space-y-5 p-6" data-testid="consent-card">
    <AccountLoadingState v-if="state.kind === 'loading'" :label="i18n.t('common.loading')" />

    <template v-else-if="state.kind === 'error'">
      <h1 class="text-xl font-semibold tracking-tight text-foam">
        {{ i18n.t('consent.loadFailed') }}
      </h1>
      <p class="text-sm text-muted">{{ state.message }}</p>
      <NuxtLink to="/login" class="account-button-secondary" data-testid="consent-retry">
        {{ i18n.t('loginContinue.retry') }}
      </NuxtLink>
    </template>

    <!--
      Nhánh `empty` tách khỏi `error` bằng testid riêng: "không có context" và
      "tải thất bại" là hai câu chuyện khác nhau với người dùng, và test cần
      phân biệt được chúng — trước đây nhánh này là dead code (`isEmpty` mặc định
      không bắt `undefined`) nên không ai từng thấy nó render.
    -->
    <div v-else-if="state.kind === 'empty'" class="space-y-5" data-testid="consent-empty">
      <h1 class="text-xl font-semibold tracking-tight text-foam">
        {{ i18n.t('consent.noClient') }}
      </h1>
      <p class="text-sm text-muted">{{ i18n.t('consent.noClientBody') }}</p>
      <NuxtLink to="/login" class="account-button-secondary" data-testid="consent-retry">
        {{ i18n.t('loginContinue.retry') }}
      </NuxtLink>
    </div>

    <template v-else-if="context">
      <div>
        <h1 class="text-xl font-semibold tracking-tight text-foam">
          {{ i18n.t('consent.title', { client: context.clientName }) }}
        </h1>
        <p class="mt-2 text-sm text-muted">
          {{ i18n.t('consent.description') }}
        </p>
      </div>

      <div
        v-if="context.highRisk"
        class="rounded-card border border-danger bg-danger-soft px-4 py-3"
        role="note"
        data-testid="consent-high-risk"
      >
        <p class="text-sm font-semibold text-danger">
          {{ i18n.t('consent.riskTitle') }}
        </p>
        <p class="mt-1 text-sm text-foam">{{ i18n.t('consent.risk') }}</p>
      </div>

      <div>
        <h2 class="text-sm font-semibold text-foam">
          {{ i18n.t('consent.requests') }}
        </h2>
        <ul class="mt-2 divide-y divide-line" data-testid="consent-permissions">
          <li v-for="permission in context.permissions" :key="permission.label" class="py-2">
            <p class="text-sm font-medium text-foam">{{ permission.label }}</p>
            <p class="text-sm text-muted">{{ permission.description }}</p>
          </li>
        </ul>
      </div>

      <div class="flex flex-wrap gap-3 border-t border-line pt-4">
        <button
          type="button"
          class="account-button-primary"
          :disabled="deciding || completed"
          data-testid="consent-approve"
          @click="decide('approve')"
        >
          {{ deciding ? i18n.t('consent.approving') : i18n.t('consent.approve') }}
        </button>
        <button
          type="button"
          class="account-button-secondary"
          :disabled="deciding || completed"
          data-testid="consent-deny"
          @click="decide('deny')"
        >
          {{ deciding ? i18n.t('consent.denying') : i18n.t('consent.deny') }}
        </button>
      </div>
    </template>

    <!--
      Kết quả quyết định nằm NGOÀI mọi nhánh của `state`: nó không thuộc về
      "đang tải / lỗi / rỗng / có context" nào cả, và nếu nằm trong nhánh
      `context` thì một lần nạp lại (hoặc handle bị tiêu thụ) sẽ làm nó biến mất
      đúng lúc người dùng cần thấy nhất.
    -->
    <AccountStatusMessage v-if="decided" :tone="decided.tone" :message="decided.message" />

    <!--
      Nút relay xuất hiện dưới thông báo quyết định, chỉ khi `auth` cấp URL.
      Nút cũng nằm NGOÀI nhánh `context` — cùng lý do như `AccountStatusMessage`.
      Trong preview (mock), `continueUrl` cố ý vắng mặt: nút không render và
      không có redirect nào được dựng từ mock.
    -->
    <button
      v-if="continueUrlAfterDecision !== undefined"
      type="button"
      class="account-button-primary"
      data-testid="consent-continue"
      @click="continueToAuth"
    >
      {{ i18n.t('common.continue') }}
    </button>
  </section>
</template>
