<script setup lang="ts">
/**
 * Layout của ba trang **chưa có** điều hướng tài khoản: `/login`,
 * `/login/continue`, `/consent`.
 *
 * ⚠️ Cố ý **không** có sidebar, **không** có `<nav>`, và **không** có đường dẫn
 * nào ra khỏi trang đăng nhập. Người đang ở `/login` hoặc `/consent` chưa có tài
 * khoản trong phiên này, nên đưa nav quản lý tài khoản vào đó sẽ dựng ra các
 * liên kết tới trang mà họ không tải được — và `/consent` đặc biệt là nơi tuyệt đối
 * không được có đường thoát: một người đang quyết định có cấp quyền cho ứng dụng
 * hay không không được gặp một đường lách khỏi màn hình quyết định đó.
 *
 * ⚠️ Language selector **vẫn có** ở đây: `/login` và `/consent` là ba trang duy
 * nhất người chưa đăng nhập vẫn đọc được, nên bỏ nó đi nghĩa là có những trang mà
 * không có cách nào đọc tiếng Việt hay tiếng Trung. Nó gọi với
 * `authenticated=false` → lựa chọn đi vào cookie app, không đụng preference của
 * tài khoản.
 *
 * Banner preview cũng có ở đây, với lý do giống: adapter thật chưa có, và cả ba
 * trang đều đang nói chuyện với dữ liệu preview. Không có nó thì `/consent` trông
 * như một màn hình uỷ quyền thật.
 *
 * Nền tối hơn layout tài khoản là chủ ý: các trang này là "cửa", và độ tương phản
 * với trang đích khiến người dùng hiểu mình đang ở đâu.
 */
const i18n = useI18n();
const adapter = useAccountAdapter();
</script>

<template>
  <!--
    Canvas tối là chủ ý (xem khối chú thích ở trên): text đặt thẳng lên nó phải
    sáng (`text-ink` — token cho chữ trên nền tối/brand), và language select giữ
    nguyên màu chữ của surface sáng bằng cách nằm trên một card, đúng như ba trang
    auth vẫn làm với `account-card`.
  -->
  <div class="flex min-h-screen flex-col items-center bg-canvas-deep px-4 py-10">
    <header class="w-full max-w-md">
      <p class="text-lg font-semibold text-ink">{{ i18n.t('shell.title') }}</p>
    </header>

    <p
      v-if="adapter.isPreview"
      class="mt-4 w-full max-w-md rounded-field border border-warning-line bg-warning-soft px-3 py-2 text-xs text-foam"
      role="note"
      data-testid="account-preview-banner"
    >
      <strong class="font-semibold">{{ i18n.t('shell.mockBadge') }}</strong> —
      {{ i18n.t('shell.mockNotice') }}
    </p>

    <div class="account-card mt-4 w-full max-w-md px-4 py-3">
      <AccountLanguageSelect :authenticated="false" />
    </div>

    <main id="account-main" class="mt-6 w-full max-w-md" data-testid="account-main">
      <slot />
    </main>
  </div>
</template>
