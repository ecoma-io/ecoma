<script setup lang="ts">
/**
 * Nút đăng nhập / đăng xuất của shell — đặt trong slot `actions` cùng
 * `BackofficeLanguageSelect`.
 *
 * ## Ba trạng thái, ba hành vi khác nhau
 *
 * - `unknown` → **không render gì**. Chưa có bằng chứng về phiên thì không
 *   được bịa một affordance: một nút "Log in" hiện lên trong khoảnh 50ms trước
 *   khi probe trả lời là một cái nháy nói dối người dùng đã đăng nhập rồi mất
 *   phiên (xem `use-backoffice-session.ts`).
 * - `unauthenticated` → nút "Log in" dẫn tới `GET /api/auth/login` (BFF dựng
 *   authorize URL — UI không tự dựng, cùng luật với nút của `BackofficeErrorState`).
 * - `authenticated` → nút "Log out" gọi `POST /api/auth/logout` (double-submit
 *   CSRF).
 *
 * ⚠️ Nút là `<button>`, không phải `<a href="/api/auth/login">`: login/logout là
 * hành động server-side, không phải navigation nội bộ. Xem JSDoc của
 * `use-backoffice-session.ts` ("Vì sao nút là `<button>`").
 *
 * ⚠️ Nhãn "Log in"/"Log out" **không** chứa từ khoá thao tác ghi mà bộ test
 * browser (`readonly-boundary.spec.ts`) dò trong accessible name: đăng nhập
 * không ghi dữ liệu nghiệp vụ, và "Log out" là đóng phiên — một control tên sai
 * sẽ làm bộ test đó đỏ vì lý do không liên quan.
 */
import { onMounted } from 'vue';
import { Button } from '@ecoma-io/ui-app-shell';
import { useI18n } from '#i18n';

import { useBackofficeSession } from '../composables/use-backoffice-session';

const { t } = useI18n();
const session = useBackofficeSession();

// Probe chạy ở mount của component (client-only): `unknown` render không nút gì,
// nên khoảnh khắc trước khi probe trả lời không có flash sai. Component nằm ở
// `app.vue` — mount một lần mỗi trang đầy đủ, đúng tần suất cần hỏi lại phiên
// (phiên không đổi giữa các navigation trong tab).
onMounted(() => {
  void session.refresh();
});
</script>

<template>
  <Button
    v-if="session.status.value === 'unauthenticated'"
    variant="outline"
    size="sm"
    data-testid="backoffice-login"
    @click="session.login"
  >
    {{ t('shell.auth.login') }}
  </Button>
  <Button
    v-else-if="session.status.value === 'authenticated'"
    variant="outline"
    size="sm"
    :disabled="session.loggingOut.value"
    data-testid="backoffice-logout"
    @click="session.logout"
  >
    {{ session.loggingOut.value ? t('shell.auth.loggingOut') : t('shell.auth.logout') }}
  </Button>
</template>
