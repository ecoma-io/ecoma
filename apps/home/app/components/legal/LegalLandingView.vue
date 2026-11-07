<!--
  Landing của Legal Center — `/en/legal`, `/vi/legal`.

  Cùng mô hình layout với docs: **sidebar điều hướng + main content**, đúng
  convention responsive mà docs đã dựng và kiểm thử — disclosure `<details>` ở
  mobile, cột sticky ở desktop (`lg`).

  Landing vẫn giữ mục đích gốc là **tìm và lựa chọn văn bản**: tiêu đề, phần
  giới thiệu, và danh sách văn bản grouped theo category. Sidebar không thay
  thế danh sách đó — nó là đường điều hướng tới bất kỳ văn bản nào ngay từ đây,
  còn danh sách là nơi đọc mô tả và trạng thái của từng văn bản. Landing không
  bị biến thành trang tài liệu trống chỉ để giống docs.

  Shell dùng chung đảm bảo một landmark `<main>`, skip link và global nav có
  tên.

  Draft (chỉ tồn tại ở staging build) hiển thị kèm nhãn Draft + review status
  — reviewer thấy ngay cái nào chưa qua rà soát pháp lý; production không bao
  giờ có draft trong dữ liệu (gate ở tầng query của route) nên badge này, cũng
  như mọi mục draft trong sidebar, không thể xuất hiện ở đó.
-->
<script setup lang="ts">
// Import tường minh (không phụ thuộc auto-import): component test mount SFC
// này ngoài Nuxt runtime (`@vitejs/plugin-vue` thuần) — same pattern với
// PublicShell của app/layout.
import { computed } from 'vue';
import type { PublicLocale } from '../../i18n/index';
import type { LegalCategory, LegalDocumentRecord } from '../../domain/legal-collection';
import type { LegalBreadcrumb, LegalSidebarNav } from '../../domain/legal-navigation';
import type { LegalUiStrings } from '../../domain/legal-ui-strings';
import LegalLayout from '~/components/legal/LegalLayout.vue';

const { path, grouped, availableLocales, sidebar, breadcrumbs, ui } =
  // oxlint-disable-next-line vue/max-props
  defineProps<{
    /**
     * Pathname hiện tại (landing) — chỉ truyền xuống `LegalLayout` →
     * `PublicShell` (locale + global nav). Breadcrumb đến qua prop riêng
     * `breadcrumbs` vì route dựng, và active state của sidebar đã nằm sẵn trong
     * `sidebar` (`sidebar.overview.current` do route tính). View không suy lại
     * bất cứ thứ gì từ `path` — làm vậy sẽ nhân bản invariant "đúng một mắt
     * `aria-current`" của `buildLegalSidebar`.
     */
    readonly path: string;
    /** Documents đã group theo category và đã qua publication gate của build. */
    readonly grouped: Readonly<Record<LegalCategory, readonly LegalDocumentRecord[]>>;
    /** Locale thực sự có landing — landing là route tĩnh của mount. */
    readonly availableLocales: readonly PublicLocale[];
    /** Sidebar điều hướng — dùng chung với trang detail, dựng từ grouped listing. */
    readonly sidebar: LegalSidebarNav;
    /**
     * Breadcrumb của landing — **một mắt duy nhất** (`/en/legal` là bản thân mục
     * đầu của chuỗi, không có tổ tiên nào để hiển thị trước nó), đã resolve từ
     * route cùng với detail.
     */
    readonly breadcrumbs: readonly LegalBreadcrumb[];
    readonly ui: LegalUiStrings;
  }>();

/**
 * Nhóm đã đặt tên hiển thị, theo đúng thứ tự của sidebar — template chỉ vòng
 * lặp, không branch theo category.
 *
 * Tên nhóm lấy từ `sidebar.groups[].title` (route đã dựng sẵn từ
 * `ui.policies`/`ui.terms`) thay vì tự suy lại từ `ui` ở đây: dùng chung một
 * nguồn nghĩa là đổi nhãn thì landing và sidebar không thể lệch nhau, và không
 * cần `ui` cho phép map category → chuỗi.
 */
const sections = computed(() =>
  sidebar.groups.map((group) => ({
    category: group.category,
    heading: group.title,
    // Không `?? []`: `grouped` là `Record<LegalCategory, …>` nên key luôn tồn
    // tại — `groupLegalDocumentsByCategory` luôn trả đủ cả hai khoá. Fallback
    // ở đây chỉ che lỗi shape thật.
    documents: grouped[group.category],
  })),
);

/**
 * Dòng giới thiệu dưới `<h1>` — nối tên các nhóm bằng dấu chấm.
 *
 * Dựng từ `sidebar.groups` chứ không liệt kê `ui.policies`/`ui.terms` thủ
 * công: `LegalCategory` là union khép kín 2 giá trị nên typecheck không bắt
 * được, và nếu sau này có category thứ ba thì `legalCategoryOrder()` tự sinh
 * thêm nhóm ở sidebar còn dòng này vẫn in hai nhãn — tiêu đề lệch với danh sách
 * ngay bên dưới, đúng loại trôi lệch mà `sidebar.groups[].title` sinh ra để
 * tránh.
 */
const categoryNames = computed(() => sections.value.map((section) => section.heading).join(' · '));

/** Badge text cho publication status — draft chỉ khả dụng ở staging build. */
function statusLabel(status: LegalDocumentRecord['status']): string {
  return status === 'draft' ? ui.draft : ui.published;
}
</script>

<template>
  <LegalLayout
    :path="path"
    :breadcrumbs="breadcrumbs"
    :sidebar="sidebar"
    :ui="ui"
    :available-locales="availableLocales"
  >
    <header class="flex flex-col gap-3">
      <h1 class="text-3xl font-bold tracking-tight text-foam sm:text-4xl">
        {{ ui.legal }}
      </h1>
      <p class="max-w-2xl text-base leading-relaxed text-muted">
        {{ categoryNames }}
      </p>
    </header>

    <section v-for="section in sections" :key="section.category" class="mt-12 flex flex-col gap-4">
      <h2 class="text-xl font-semibold tracking-tight text-foam">
        {{ section.heading }}
      </h2>
      <!--
        Nhóm rỗng vẫn giữ `<h2>` (cấu trúc ổn định giữa các bản dịch) nhưng
        không render `<ul>`: `<ul>` có `border` + `bg-surface`, nên để rỗng sẽ
        dựng một khung hộp rỗng ngay dưới heading. Cùng guard với `LegalNav`
        — cùng dữ liệu rỗng phải render giống nhau ở sidebar và ở cột chính.
      -->
      <ul
        v-if="section.documents.length > 0"
        class="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface"
      >
        <li v-for="document in section.documents" :key="document.path">
          <NuxtLink
            :to="document.path"
            class="flex flex-col gap-1 px-5 py-4 transition-colors hover:bg-surface-raised focus-visible:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            <span class="flex flex-wrap items-center gap-2">
              <span class="text-base font-medium text-foam">{{ document.title }}</span>
              <span
                v-if="document.status === 'draft'"
                class="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800"
              >
                {{ statusLabel(document.status) }}
              </span>
              <span
                v-if="document.reviewStatus === 'unreviewed'"
                class="rounded-full border border-line bg-surface-raised px-2 py-0.5 text-xs text-muted"
              >
                {{ ui.unreviewed }}
              </span>
            </span>
            <span class="text-sm leading-relaxed text-muted">
              {{ document.description }}
            </span>
          </NuxtLink>
        </li>
      </ul>
    </section>
  </LegalLayout>
</template>
