<script setup lang="ts">
/**
 * `/login/continue` — bàn giao sang dịch vụ uỷ quyền.
 *
 * ⚠️ Trang này **không** phải phần protocol. Nó không đọc `code`, không đổi
 * `state`, không biết `redirect_uri`, và không dựng URL nào. `auth` sở hữu
 * authorization transaction và là bên duy nhất tạo redirect cuối
 * (`01-architecture.md` §5.1.1). Trang gọi `adapter.completeHandoff(handle)`
 * (BFF push `/internal/session/verified` về `auth`) và relay URL do `auth`
 * cấp bằng điều hướng browser — không tự ghép chuỗi, không thêm tham số.
 *
 * ⚠️ Handle continuation **không được render** vào DOM và không dán vào liên
 * kết nào (FR-006k3): nó đi vào lời gọi adapter với **một** call-site duy nhất
 * (chuỗi `?handle=` của URL hiện tại), rồi dừng ở đó.
 */
definePageMeta({ layout: 'auth' });

const i18n = useI18n();
const adapter = useAccountAdapter();
const route = useRoute();

/**
 * Handle continuation từ URL — được chuyển tiếp nguyên vẹn vào lời gọi bàn
 * giao **và không bao giờ** được render. Trạng thái và thông báo trên trang
 * cố ý không nhắc lại handle: chúng nói "bàn giao đã xong/thất bại" chứ không
 * gì hơn.
 */
const continuationHandle = computed(() => {
  const value = route.query.handle;
  return typeof value === 'string' ? value : undefined;
});

/**
 * Chưa hoàn tất ⇒ người dùng thấy trạng thái lỗi; gọi `completeHandoff`
 * ngay từ mount để hoàn tất nếu session đã verify. Không có handle ⇒ không
 * có gì để bàn giao — dùng chung nhánh `error`.
 */
const { state, reload } = useAsyncState(() =>
  continuationHandle.value === undefined
    ? Promise.resolve(undefined)
    : adapter.completeHandoff(continuationHandle.value),
);

const result = computed(() => (state.value?.kind === 'ready' ? state.value.value : undefined));
const handoffResult = computed(() =>
  result.value !== undefined && result.value.ok ? result.value.value : undefined,
);

/**
 * URL do `auth` cấp và việc điều hướng chỉ xảy ra ở **nút của người dùng**
 * (không tự động): người dùng thấy thông báo bàn giao xong trước, và bấm nút
 * mới đi tiếp. Đích do `auth` quyết định — relay nguyên vẹn. Một kết quả `ok`
 * vắng URL (`already_processed`) rơi vào nhánh template dưới — không điều hướng.
 */
function continueToTarget(): void {
  const url = handoffResult.value?.continueUrl;
  if (typeof url !== 'string') {
    return;
  }
  window.location.assign(url);
}
</script>

<template>
  <section class="account-card space-y-5 p-6 text-center" data-testid="login-continue-card">
    <!--
      Bàn giao thành công và `auth` đã cấp URL: hiện thông báo hoàn tất và một
      nút duy nhất điều hướng. Không tự động điều hướng — thành công phải được
      nhìn thấy trước khi rời trang.
    -->
    <template v-if="handoffResult?.continueUrl !== undefined">
      <h1 class="text-xl font-semibold tracking-tight text-foam">
        {{ i18n.t('loginContinue.title') }}
      </h1>
      <p class="text-sm text-muted">{{ i18n.t('loginContinue.body') }}</p>
      <button
        type="button"
        class="account-button-primary"
        data-testid="login-continue-target"
        @click="continueToTarget"
      >
        {{ i18n.t('common.continue') }}
      </button>
    </template>

    <!--
      Bàn giao thành công nhưng không có URL (`already_processed`): hợp đồng vắng
      URL — hiển thị kết thúc mà không hứa một đích nào.
    -->
    <template v-else-if="handoffResult">
      <h1 class="text-xl font-semibold tracking-tight text-foam">
        {{ i18n.t('loginContinue.title') }}
      </h1>
      <p class="text-sm text-muted">{{ i18n.t('loginContinue.body') }}</p>
    </template>

    <!--
      Đang bàn giao: nhánh loading tách riêng, không hiện "thất bại" trước khi
      request kịp chạy xong (cùng khung bốn trạng thái mà các trang khác dùng).
    -->
    <AccountLoadingState v-else-if="state.kind === 'loading'" :label="i18n.t('common.loading')" />

    <!--
      Chưa thử / thất bại: hiện trạng lỗi với retry. Retry gọi lại cùng handle —
      push idempotent (`event_id` từ `session_ref`), nên thử lại an toàn; một
      lần push đã thành công sẽ được auth trả `already_processed` ở lần retry.
      Trang thiếu handle rơi vào đây nhưng **không có nút retry**: không có gì
      để retry — bấm lại chỉ lặp đúng đường `undefined → lỗi`, một vòng không
      bao giờ thành công được.
    -->
    <template v-else>
      <h1 class="text-xl font-semibold tracking-tight text-foam">
        {{ i18n.t('loginContinue.errorTitle') }}
      </h1>
      <p class="text-sm text-muted">{{ i18n.t('loginContinue.errorBody') }}</p>
      <button
        v-if="continuationHandle !== undefined"
        type="button"
        class="account-button-primary"
        data-testid="login-continue-retry"
        @click="() => void reload()"
      >
        {{ i18n.t('loginContinue.retry') }}
      </button>
    </template>
  </section>
</template>
