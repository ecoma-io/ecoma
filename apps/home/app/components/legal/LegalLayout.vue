<!--
  Khung layout **dùng chung** cho cả hai bề mặt của Legal Center: landing
  `/en/legal` và trang văn bản `/en/legal/{slug}`.

  PR này ban đầu viết khung này hai lần (ở `LegalLandingView` và
  `LegalDocumentView`) và chỉ mới rút được phần `<details>` qua
  `PublicNavDisclosure`. Hai bề mặt chỉ khác nhau ở **nội dung cột phải**, nên
  toàn bộ phần còn lại — shell, breadcrumb, disclosure mobile, lưới
  `lg:grid-cols-[16rem_1fr]`, cột sticky — gom ở đây. Một khung, một nguồn: đổi
  class hoặc offset sau này không thể khiến hai bề mặt lệch pha.

  `PublicShell` đã render landmark `<main>` bọc slot nên ở đây chỉ dùng `<div>`:
  lồng `<main>` trong `<main>` là HTML không hợp lệ và làm hỏng landmark cho
  screen reader (hai vùng `main` cùng tồn tại).

  Cột nội dung là slot thuần — khung không biết landing với detail khác nhau ở
  đâu (landing có `<h1>` + danh sách nhóm; detail có banner draft + Markdown +
  related).
-->
<script setup lang="ts">
import type { PublicLocale } from '../../i18n/index';
import { PublicShell } from '../../layout/index';
import type { LegalBreadcrumb, LegalSidebarNav } from '../../domain/legal-navigation';
import type { LegalUiStrings } from '../../domain/legal-ui-strings';
import PublicBreadcrumbs from '~/components/PublicBreadcrumbs.vue';
import LegalNav from '~/components/legal/LegalNav.vue';
import LegalSidebarDisclosure from '~/components/legal/LegalSidebar.vue';

// oxlint-disable-next-line vue/max-props
const { path, breadcrumbs, sidebar, ui, availableLocales } = defineProps<{
  /** Pathname hiện tại — nguồn duy nhất cho shell (locale + global nav). */
  readonly path: string;
  /** Breadcrumb đã resolve của bề mặt (landing một mắt, detail hai mắt). */
  readonly breadcrumbs: readonly LegalBreadcrumb[];
  /** Sidebar dùng chung hai bề mặt, dựng từ grouped listing đã gate. */
  readonly sidebar: LegalSidebarNav;
  readonly ui: LegalUiStrings;
  /**
   * Locale nào resource hiện tại thực sự tồn tại, chuyển tiếp nguyên vẹn cho
   * locale switcher của `PublicShell`: landing thì **mọi** locale của registry
   * (landing là route tĩnh của mount), còn văn bản thì locale có bản dịch của
   * chính văn bản đang đọc — nên switcher ở detail có thể hẹp hơn landing.
   */
  readonly availableLocales: readonly PublicLocale[];
}>();
</script>

<template>
  <PublicShell :path="path" :available-locales="availableLocales">
    <div class="mx-auto w-full max-w-9xl px-4 py-6 lg:px-8 wide:px-12 ultrawide:px-16">
      <PublicBreadcrumbs :entries="breadcrumbs" :label="ui.breadcrumbs" />

      <div class="mt-4 lg:hidden">
        <LegalSidebarDisclosure :sidebar="sidebar" :label="ui.navigation" />
      </div>

      <div class="mt-6 grid gap-6 lg:mt-8 lg:grid-cols-[16rem_1fr]">
        <aside class="hidden lg:block">
          <!--
            `top-20` (5rem) đặt sidebar nằm **dưới** header sticky `h-16` của
            `PublicHeader` (4rem) chứ không neo ở `top-6` (1.5rem) — neo ở `top-6`
            khiến mép trên của sidebar nằm trong vùng header có nền và bị đè, nên
            mắt `Overview` cùng nhóm đầu tiên bị che khi cuộn. Cùng lý do với
            `scroll-mt-20`/`scroll-mt-24` mà content heading đã dùng trong
            `styles.css`.
          -->
          <div class="sticky top-20">
            <LegalNav :sidebar="sidebar" :label="ui.navigation" />
          </div>
        </aside>

        <div class="min-w-0">
          <!--
            Cột đọc giới hạn ở `max-w-3xl` và căn giữa cho **cả hai bề mặt**.
            Trước khi đặt ở đây, chỉ detail có giới hạn này nên ở `ultrawide`
            (1920px) landing trải tới ~1128px còn detail dừng ở 768px — hai bề
            mặt của cùng một Legal Center hiện ra với bề rộng khác nhau, đúng
            thứ PR này sinh ra `LegalLayout` để tránh. Ở landing, card liệt kê
            văn bản hẹp lại trong cột đọc là chấp nhận được: đó là một danh
            sách, không phải văn xuôi dài, và khớp với việc detail vẫn giữ
            cột đọc hẹp như trước PR này.
          -->
          <div class="mx-auto w-full max-w-3xl">
            <slot />
          </div>
        </div>
      </div>
    </div>
  </PublicShell>
</template>
