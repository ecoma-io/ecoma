<!--
  Trang văn bản pháp lý — `/en/legal/<slug>`, `/vi/legal/<slug>`.

  Cùng mô hình layout với landing và với docs: **sidebar điều hướng + main
  content**, disclosure ở mobile, cột sticky ở desktop, breadcrumbs trên đầu.
  Nhờ vậy người đọc thấy văn bản đang đọc và chuyển sang văn bản khác ngay từ
  sidebar, không phải cuộn xuống đáy trang.

  Cột đọc vẫn hẹp (`max-w-3xl`) như trước — nội dung pháp lý là văn xuôi dày
  đặc cần một cột đọc, nhưng nó **không còn chiếm cả bề rộng trang**: bề rộng do
  sidebar dành ra không kéo giãn vùng đọc.

  Không TOC — văn bản pháp lý ngắn hơn docs leaf và policy cũ cũng không có TOC;
  nếu sau này cần TOC, tái sử dụng cơ chế của docs thay vì tự dựng.

  Draft (staging build) có banner "DRAFT" nổi bật phía trên nội dung để người
  review không nhầm với văn bản đã xuất bản. Production không bao giờ có draft
  trong dữ liệu nên banner không thể xuất hiện ở đó.
-->
<script setup lang="ts">
// Import tường minh (không phụ thuộc auto-import): component test mount SFC
// này ngoài Nuxt runtime — same pattern với PublicShell của app/layout.
import { computed } from 'vue';
import type { LegalCollectionItem } from '@nuxt/content';
import { ContentRenderer } from '#components';
import type { PublicLocale } from '../../i18n/index';
import type { LegalDocumentRecord } from '../../domain/legal-collection';
import type { LegalBreadcrumb, LegalSidebarNav } from '../../domain/legal-navigation';
import type { LegalUiStrings } from '../../domain/legal-ui-strings';
import LegalLayout from '~/components/legal/LegalLayout.vue';

const { path, page, summary, related, availableLocales, sidebar, breadcrumbs, ui } =
  // oxlint-disable-next-line vue/max-props
  defineProps<{
    /**
     * Pathname hiện tại — chỉ truyền xuống `LegalLayout` → `PublicShell`
     * (locale + global nav). Active state của sidebar đã được route tính sẵn
     * trong `sidebar` (`current` trên từng link), view không tự suy lại từ
     * `path` — làm vậy sẽ nhân bản invariant "đúng một mắt `aria-current`" của
     * `buildLegalSidebar`.
     */
    readonly path: string;
    /** Document đầy đủ đã query từ collection `legal` (body Markdown rendered). */
    readonly page: LegalCollectionItem;
    /** Record metadata đã qua publication gate — nguồn cho badges, related. */
    readonly summary: LegalDocumentRecord;
    /** Related documents đã resolve sang record, giữ thứ tự khai báo. */
    readonly related: readonly LegalDocumentRecord[];
    /** Locale thực sự có bản dịch của văn bản — input cho locale switcher. */
    readonly availableLocales: readonly PublicLocale[];
    /** Sidebar điều hướng — dùng chung với landing, dựng từ grouped listing. */
    readonly sidebar: LegalSidebarNav;
    /** Chuỗi breadcrumb `Legal Center → Document`, đã resolve từ route. */
    readonly breadcrumbs: readonly LegalBreadcrumb[];
    readonly ui: LegalUiStrings;
  }>();

/**
 * Metadata line — "Version 1.0 · Effective 2026-01-01"; effective date thiếu
 * (draft chưa chốt) thì không render đoạn đó thay vì render "—" trống.
 */
const metaParts = computed(() => {
  const parts: string[] = [`${ui.version} ${summary.version}`];
  if (summary.effectiveDate !== null) {
    parts.push(`${ui.effective} ${summary.effectiveDate}`);
  }
  return parts;
});
</script>

<template>
  <LegalLayout
    :path="path"
    :breadcrumbs="breadcrumbs"
    :sidebar="sidebar"
    :ui="ui"
    :available-locales="availableLocales"
  >
    <div>
      <!--
        Banner draft — chỉ staging build có dữ liệu draft nên banner này chỉ
        tồn tại trên staging; nổi bật bằng màu amber để người review không nhầm
        với văn bản đã công bố.

        Nằm trong cùng cột đọc với phần nội dung (giới hạn do `LegalLayout`):
        đặt ngoài nó thì banner trải hết bề rộng cột `1fr` (~872px ở `lg`) trong
        khi mọi thứ bên dưới dừng ở 768px và căn giữa, khiến mép banner lệch mỗi
        bên ~52px so với cột đọc.
      -->
      <aside
        v-if="summary.status === 'draft'"
        class="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3"
      >
        <p class="text-sm font-medium text-amber-900">{{ ui.draft }} · {{ ui.unreviewed }}</p>
      </aside>

      <article class="flex flex-col gap-8 py-6">
        <header class="flex flex-col gap-3">
          <!--
            Title văn bản do Markdown sở hữu (`# Heading` đầu mỗi document),
            nên view không render `<h1>` nữa — hai `<h1>` cùng nội dung vừa lặp
            chữ vừa phá heading hierarchy (same contract với BlogArticleView).
            `summary.title` vẫn dùng cho SEO và `<title>`.
          -->
          <p class="flex flex-wrap items-center gap-2 text-sm text-faint">
            <span
              v-if="summary.status === 'draft'"
              class="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800"
            >
              {{ ui.draft }}
            </span>
            <span
              v-else
              class="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-800"
            >
              {{ ui.published }}
            </span>
            <span aria-hidden="true"> · </span>
            <span>{{ metaParts.join(' · ') }}</span>
          </p>
          <p class="text-base leading-relaxed text-muted">{{ summary.description }}</p>
        </header>

        <div class="legal-content text-muted">
          <ContentRenderer :value="page" />
        </div>

        <section v-if="related.length > 0" class="mt-4 border-t border-line pt-6">
          <h2 class="text-lg font-semibold tracking-tight text-foam">{{ ui.related }}</h2>
          <ul class="mt-3 flex flex-col gap-2">
            <li v-for="document in related" :key="document.path">
              <NuxtLink
                :to="document.path"
                class="text-sm font-medium text-foam hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                {{ document.title }}
              </NuxtLink>
              <span class="text-faint"> — {{ document.description }}</span>
            </li>
          </ul>
        </section>

        <!--
          Link cuối trang về tổng quan. Sidebar đã có link này ở mọi trang, nên
          dòng này là đường về **ngay dưới nội dung vừa đọc** cho bản in / đọc
          dài, không phải đường điều hướng chính. `v-if` là guard thật:
          `overview` là `null` khi route không resolve được landing path.
        -->
        <p v-if="sidebar.overview" class="mt-2">
          <NuxtLink
            :to="sidebar.overview.path"
            class="text-sm font-medium text-muted hover:text-foam hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            ← {{ ui.legal }}
          </NuxtLink>
        </p>
      </article>
    </div>
  </LegalLayout>
</template>
