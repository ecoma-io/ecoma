<!--
  `ErrorPageStage` — visual primitive dùng chung của các error page.

  Đây là component **private** của library: consumer không import trực tiếp;
  hai page công khai (`NotFoundPage`, `ForbiddenPage`) compose nó. Tách stage
  khỏi các page để:
  - structure/a11y chỉ được viết một lần (một `<h1>`, role `alert`);
  - hai page giữ danh tính riêng về **mã lỗi hiển thị** — điểm khác biệt duy
    nhất của chúng là ngữ nghĩa lỗi, không phải layout (task cấm gộp hai page
    thành một component điều khiển bằng status prop);
  - không render **mã số** status ở đây: mã lỗi nằm ở page gọi (slot
    `status`), vì việc lộ sốstatus ra UI là quyết định copy của từng page.

  A11y: `role="alert"` lên container nội dung để screen reader đọc ngay khi
  error page được render thay cho nội dung thật (Nuxt mount `error.vue` cùng
  cây DOM cũ đã biến mất, nhưng robot/crawler đọc HTML phẳng vẫn cần thứ tự
  heading hợp lý). Component **không** render landmark `<main>`: consumer
  bọc page trong shell đã sở hữu sẵn `<main>` (`PublicShell` render
  `<main id="public-main">`), hai landmark lồng nhau vi phạm
  `landmark-main-is-top-level`. Consumer đứng độc lập (không shell) tự bọc
  `<main>` bên ngoài component này.
-->
<script setup lang="ts">
import { computed } from 'vue';
import type { ErrorPageContent } from '../error-page-content';

// Destructure `content` (rule `vue/define-props-destructuring`): Vue 3.5
// rewrite thành accessor trên `props.*` nên mọi field truy cập dưới đây
// recompute khi prop đổi — consumer có thể render động.
const { content } = defineProps<{
  readonly content: ErrorPageContent;
}>();

/** Danh sách action hiển thị theo thứ tự: primary trước, secondary sau. */
const actions = computed(
  (): readonly {
    readonly kind: 'primary' | 'secondary';
    readonly label: string;
    readonly href: string;
  }[] => {
    const list: { kind: 'primary' | 'secondary'; label: string; href: string }[] = [
      { kind: 'primary', label: content.primaryAction.label, href: content.primaryAction.href },
    ];
    if (content.secondaryAction !== undefined) {
      list.push({
        kind: 'secondary',
        label: content.secondaryAction.label,
        href: content.secondaryAction.href,
      });
    }
    return list;
  },
);
</script>

<template>
  <!--
    `min-h-dvh`: khi consumer render page trần (không shell), stage thay nguyên
    viewport — `dvh` (dynamic viewport) đúng hơn `vh` trên mobile có address
    bar thu/đẩy. Khi bọc trong shell (PublicShell), `min-h-dvh` dư nhưng vô
    hại: content cao hơn viewport thì vẫn scroll bình thường, thấp hơn thì
    wrapper cao bằng viewport bên trong `<main>` của shell, footer vẫn chạm
    đáy mà không bị đẩy xuống. Grid căn giữa nội dung.
  -->
  <div class="grid min-h-dvh place-items-center bg-ink px-4 py-16 sm:px-6">
    <div role="alert" class="w-full max-w-xl text-center">
      <!--
        Slot `status` là chỗ page đặt mã lỗi hiển thị (vd "404") — visual
        token của con số được cố định ở đây để mọi page dùng chung một cỡ.
      -->
      <p class="text-8xl font-bold tracking-tight text-surface-raised select-none sm:text-9xl">
        <slot name="status" />
      </p>
      <h1 class="mt-6 text-3xl font-bold tracking-tight text-foam sm:text-4xl">
        {{ content.title }}
      </h1>
      <p class="mt-4 text-lg leading-relaxed text-muted">
        {{ content.description }}
      </p>
      <div class="mt-10 flex flex-wrap items-center justify-center gap-3">
        <template v-for="action in actions" :key="action.kind">
          <a
            v-if="action.kind === 'primary'"
            :href="action.href"
            class="rounded-md bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft motion-safe:transition-colors"
            >{{ action.label }}</a
          >
          <a
            v-else
            :href="action.href"
            class="rounded-md border border-line px-5 py-2.5 text-sm font-semibold text-muted hover:border-brand hover:bg-surface hover:text-foam focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft motion-safe:transition-colors"
            >{{ action.label }}</a
          >
        </template>
      </div>
    </div>
  </div>
</template>
