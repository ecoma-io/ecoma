<!--
  Cây điều hướng của Legal Center — phần render dùng chung cho disclosure trên
  mobile (`LegalSidebar`) và cột sticky trên desktop.

  Tách khỏi `LegalSidebar` vì hai bề mặt đó cần hai khối DOM khác nhau
  (`<details>` cho mobile, `<nav>` luôn hiện cho desktop) nhưng **cùng một cây**:
  render hai lần từ cùng một nguồn dữ liệu thì rẻ hơn việc dùng JS để chuyển
  đổi, và quan trọng hơn là SSR và hydrate cho ra HTML giống nhau. Bề mặt bị
  ẩn bằng `display:none` nên không xuất hiện trong accessibility tree — không có
  link trùng cho screen reader. Cùng lập luận và cùng pattern với
  `DocsNavTree`/`DocsSidebar` của docs.

  Khác docs ở **hình dạng dữ liệu**: docs là tree (section → page con), legal là
  danh sách phẳng có nhóm (`Overview` → nhóm category → văn bản). Không dựng
  cây lồng nhau cho legal: đó là cấu trúc tài liệu pháp lý, không phải cây thư
  mục — một mục heading + một danh sách phẳng là hình dạng đúng.

  Không tự query content: `sidebar` là dữ liệu route đã resolve (đã qua
  publication gate của build — draft không thể lọt vào đây ở production).
-->
<script setup lang="ts">
import type { LegalSidebarNav } from '../../domain/legal-navigation';

// Cây cần hai input độc lập: `sidebar` (dữ liệu đã gate) và `label` (tên truy
// cập được của `<nav>`) — cùng cách tách input như `PublicShell`/`PublicHeader`
// của `app/layout`.
// oxlint-disable-next-line vue/max-props
const { sidebar, label } = defineProps<{
  /** Sidebar đã dựng từ grouped listing của route. */
  readonly sidebar: LegalSidebarNav;
  /** Tên truy cập được của `<nav>` — phải khác breadcrumb và global nav. */
  readonly label: string;
}>();
</script>

<template>
  <nav :aria-label="label">
    <ul class="space-y-1 text-sm">
      <!--
        Mắt `Overview` là link nội bộ của cùng app nên dùng `NuxtLink` (client-side
        routing) như mọi link chính của bề mặt legal — `<a href>` sẽ tải lại
        trang, mất prefetch payload và reset scroll. Cùng quy ước với
        `BlogArticleCard.vue`.
        `overview` là `null` khi route không resolve được landing path: khi đó bỏ
        hẳn mắt này thay vì trỏ về URL không tin được.
      -->
      <li v-if="sidebar.overview">
        <!--
          Không đặt `text-foam` trong cả hai nhánh của ternary: cả hai đều ra
          cùng một kết quả nên nhánh `false` là class chết, và dạng viết đó dễ
          khiến người sau thêm một class vào một nhánh rồi tưởng áp dụng cho cả
          hai trạng thái. Mắt current phân biệt bằng nền, giống hệt cách mắt văn
          bản phân biệt bằng `bg-surface-raised` bên dưới.
        -->
        <NuxtLink
          :to="sidebar.overview.path"
          class="block rounded px-2 py-1 font-semibold text-foam hover:bg-surface hover:underline focus-visible:bg-surface"
          :class="sidebar.overview.current ? 'bg-surface-raised' : undefined"
          :aria-current="sidebar.overview.current ? 'page' : undefined"
          >{{ sidebar.overview.title }}</NuxtLink
        >
      </li>

      <li v-for="group in sidebar.groups" :key="group.category">
        <!--
          Nhóm là **mục trong `<ul>`** chứ không phải heading. Lý do **khác nhau theo
          bề mặt**: landing có một `<h2>` riêng cho từng nhóm, còn detail chỉ có
          một `<h2>` `Related documents` gộp cả các nhóm — nên một `<h2>`/`<h3>`
          thứ hai trong nav sẽ lặp heading ở bề mặt này và vỡ bậc ở bề mặt kia:
          reader screen reader nghe tên nhóm hai lần ở hai vị trí không liên quan.
          Nav không cần heading: nó được đặt tên đầy đủ bằng `aria-label` ở `<nav>`.
        -->
        <p class="px-2 pt-4 pb-1 text-xs font-semibold uppercase tracking-wide text-faint">
          {{ group.title }}
        </p>
        <!--
          Nhóm rỗng vẫn giữ nhãn `<p>` (người đọc cần biết nhóm tồn tại) nhưng không
          render `<ul>` rỗng — một list không có `<li>` chỉ thêm nhiễu vào
          accessibility tree. Cùng guard với `DocsNavTree.vue`.
        -->
        <ul v-if="group.documents.length > 0" class="space-y-1">
          <li v-for="document in group.documents" :key="document.path">
            <NuxtLink
              :to="document.path"
              class="block rounded px-2 py-1 hover:bg-surface hover:underline focus-visible:bg-surface"
              :class="document.current ? 'bg-surface-raised font-semibold text-foam' : 'text-muted'"
              :aria-current="document.current ? 'page' : undefined"
              >{{ document.title }}</NuxtLink
            >
          </li>
        </ul>
      </li>
    </ul>
  </nav>
</template>
