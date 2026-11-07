<script setup lang="ts">
/**
 * Màn onboarding (issue #325, giai đoạn 1).
 *
 * Hiển thị khi `GET /api/onboarding-status` trả `{ needsDisplayName: true }`:
 * người dùng chưa đặt displayName ở `account`, nên sổ staff chưa có tên để
 * hiện. Màn này **không chặn cứng** (issue #325 ghi rõ): người dùng luôn có
 * đường đi tiếp — link sang trang profile của `account` để tự đặt tên, và nút
 * "tiếp tục" để vào thẳng app mà không đặt tên.
 *
 * ## Chỗ gắn gate 2FA (giai đoạn 2 — ngoài phạm vi)
 *
 * Mục "Xác thực hai yếu tố" dưới đây là placeholder **Sắp có**, không tương
 * tác. Giai đoạn 2 sẽ thay nó bằng trạng thái thật của enrolment TOTP và — khi
 * bật gate cứng — một checkpoint chặn ở đây (xem
 * `docs/applications/backoffice/01-architecture.md` §Two-factor).
 *
 * ## Vì sao URL profile là cấu hình, không phải hằng
 *
 * Backoffice không biết `account` sống ở đâu: đó là thuộc tính deployment
 * (origin khác nhau giữa local/staging/production). Key
 * `backofficeAccountProfileUrl` (public runtimeConfig, `NUXT_PUBLIC_*` ở Node
 * container, `vars` ở Workers) rỗng ⇒ chưa cấu hình ⇒ **ẩn link** thay vì
 * render link chết. Fail-soft có chủ đích cho một liên kết tiện ích; gate
 * thật (route `/api/onboarding-status`) vẫn fail-closed.
 */
import { computed, ref } from 'vue';
import { useI18n } from '#i18n';
import { useAsyncState } from '../composables/use-async-state';

const i18n = useI18n();

const config = useRuntimeConfig();
/** Origin + path trang profile của `account` — rỗng khi deployment chưa cấu hình. */
const accountProfileUrl = computed(
  () => (config.public.backofficeAccountProfileUrl as string | undefined) ?? '',
);

const { state, reload } = useAsyncState(
  async () => {
    const response = await fetch('/api/onboarding-status', {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`onboarding-status ${response.status}`);
    }
    return (await response.json()) as { needsDisplayName: boolean };
  },
  () => false,
);

/** Link chỉ render khi cấu hình có URL thật — không render link chết. */
const hasProfileLink = computed(() => accountProfileUrl.value !== '');

/**
 * Người dùng chủ động bỏ qua onboarding — về trang chủ backoffice. Không xoá
 * trạng thái nào server-side: gate được tính lại ở mỗi lần đọc
 * `/api/onboarding-status`, nên lần vào app sau vẫn thấy onboarding nếu tên
 * vẫn chưa được đặt.
 */
const dismissed = ref(false);
</script>

<template>
  <section class="flex flex-1 flex-col items-center justify-center gap-6 py-16">
    <BackofficeLoadingState v-if="state.kind === 'loading'" :label="i18n.t('states.loading')" />

    <BackofficeErrorState
      v-else-if="state.kind === 'error'"
      :title="i18n.t('states.errorTitle')"
      :body="i18n.t('states.errorBody')"
      :detail="state.message"
      :retry-label="i18n.t('states.retry')"
      :on-retry="reload"
    />

    <template v-else-if="state.kind === 'ready' && state.value.needsDisplayName">
      <div
        v-if="!dismissed"
        class="w-full max-w-md rounded-lg border border-border bg-card p-6"
        data-testid="onboarding-card"
      >
        <h1 class="text-lg font-semibold">{{ i18n.t('onboarding.title') }}</h1>
        <p class="mt-2 text-sm text-muted-foreground">{{ i18n.t('onboarding.body') }}</p>

        <div class="mt-6 flex flex-col gap-2">
          <a
            v-if="hasProfileLink"
            :href="accountProfileUrl"
            class="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            data-testid="onboarding-profile-link"
          >
            {{ i18n.t('onboarding.setDisplayName') }}
          </a>
          <button
            type="button"
            class="inline-flex h-9 items-center justify-center rounded-md border border-border bg-transparent px-4 text-sm font-medium transition-colors hover:bg-accent"
            data-testid="onboarding-continue"
            @click="dismissed = true"
          >
            {{ i18n.t('onboarding.continue') }}
          </button>
        </div>

        <!--
          Chỗ gắn gate 2FA (giai đoạn 2): trạng thái enrolment thật thay mục
          placeholder này, và khi gate cứng bật thì nút "tiếp tục" bị thay bằng
          checkpoint bắt buộc. Xem docs/applications/backoffice/01-architecture.md §Two-factor.
        -->
        <div
          class="mt-6 rounded-md border border-dashed border-border p-4"
          data-testid="onboarding-mfa"
        >
          <p class="text-sm font-medium">{{ i18n.t('onboarding.twoFactor.title') }}</p>
          <p class="mt-1 text-xs text-muted-foreground">
            {{ i18n.t('onboarding.twoFactor.comingSoon') }}
          </p>
        </div>
      </div>

      <slot v-else />
    </template>
  </section>
</template>
