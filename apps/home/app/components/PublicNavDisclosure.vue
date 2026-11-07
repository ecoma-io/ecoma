<!--
  Disclosure gốc của HTML (`<details>`/`<summary>`) cho cột điều hướng tài liệu
  của mọi bề mặt public (docs, legal). Đóng/mở không cần JavaScript nên SSR và
  hydrate cho ra cùng một HTML, không có state client nào để lệch.

  **Chỉ dùng ở mobile, và component không mang `lg:*` nào.** Cả ba call site
  (`DocsPageView`, `DocsLandingView`, `LegalLayout`) bọc nó trong `mt-4 lg:hidden`
  rồi render lại cây nav riêng trong `<aside class="hidden lg:block">`. Nên từ
  `lg` trở lên `<details>` đã nằm trong cây `display:none` của cha: `lg:block` ở
  đây không bao giờ có tác dụng, `lg:hidden` trên `<summary>` thừa. Ẩn/hiện theo
  breakpoint là việc của caller, không phải của khung này — trước đây khung
  *tuyên bố* lo việc đó bằng class rồi không làm được, dễ khiến người đọc tin
  rằng bỏ `lg:hidden` ở caller là an toàn.

  Slot là **cây điều hưởng do caller render** (`DocsNavTree`, `LegalNav`): mỗi
  bề mặt có cấu trúc dữ liệu khác nhau (docs là tree, legal là danh sách phẳng
  có nhóm) nên phần render thuộc về caller. Cùng pattern với
  `PublicShell`/`PublicHeader` của `app/layout`.
-->
<script setup lang="ts">
// `label` chỉ được dùng để in ra `<summary>`. Khung này **không** render
// `<nav>` nào: cây điều hướng nằm trong slot và caller tự render
// `<nav>` + truyền `label` riêng cho nó (xem `DocsSidebar`, `LegalSidebar`).
// Trước đây khung nhận hai prop (`summaryLabel` + `label`) chỉ để truyền *cùng
// một* chuỗi tới hai chỗ, và PR này đã gỡ `summaryLabel`; đoạn này được viết lại
// theo hợp đồng còn lại để không dấu vết của cách cũ. Nếu sau này một bề mặt thật
// sự cần tiêu đề disclosure khác accessible name thì thêm prop lúc đó.
const { label } = defineProps<{
  /**
   * Tiêu đề hiển thị trên `<summary>`, cũng là nguồn accessible name của
   * disclosure. **Không** phải nhãn của `<nav>`: caller tự chịu trách nhiệm
   * đặt accessible name cho `<nav>` trong slot.
   *
   * Dùng **cùng chuỗi** cho cả hai là quyết định chủ ý, không phải ràng buộc a11y:
   * `<summary>` không phải landmark, và hai `<nav>` (bản disclosure và bản
   * `<aside>`) luôn nằm ở hai nhánh `lg:hidden` / `hidden lg:block` đối nghịch
   * nên tại mỗi breakpoint chỉ một cái có mặt trong accessibility tree — hai
   * landmark trùng tên không thể xảy ra ở đây. Giữ cùng chuỗi vì đó là tên bề mặt
   * đã localized sẵn; đổi một chỗ thì phải đổi cả hai, còn prop không gì kiểm
   * (kiểu chỉ là `string`) nên tương quan đó là điều kỷ luật, không phải thứ
   * compiler canh.
   */
  readonly label: string;
}>();
</script>

<template>
  <details open>
    <summary
      class="cursor-pointer rounded border border-line px-3 py-2 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft"
    >
      {{ label }}
    </summary>
    <div class="mt-3">
      <slot />
    </div>
  </details>
</template>
