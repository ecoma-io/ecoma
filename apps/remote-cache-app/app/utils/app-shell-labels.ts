import type { AppShellLabels } from '@ecoma-io/ui-app-shell';

/**
 * Hàm dịch mà mapper cần — đúng chữ ký `t` của `vue-i18n`.
 *
 * Khai thành một type riêng để hàm dưới đây là **hàm thuần**: nó không gọi
 * `useI18n()`, không đọc locale, không phụ thuộc Nuxt. Nhờ vậy test của app kiểm
 * được cả ba locale trên catalog thật mà không phải mount component, và
 * `app.vue` chỉ còn một dòng nối dây.
 */
export type Translate = (key: string) => string;

/**
 * Bản dịch các chuỗi hiển thị của shell — cầu nối duy nhất giữa catalog của app
 * và `AppShellLabels` của library.
 *
 * ⚠️ Vì sao là mapper ở app chứ không phải i18n bên trong library: shell dùng
 * chung nhiều app, trong đó một số app **không** có i18n. Nếu library tự dịch thì
 * nó phải biết locale nào tồn tại, phải có catalog riêng, và các app kia bị kéo
 * theo một cơ chế i18n họ không dùng. Prop `labels` của shell chỉ nhận chuỗi đã
 * dịch — chiều phụ thuộc là app → library, một chiều.
 *
 * ⚠️ **Mọi** field của `AppShellLabels` phải có mặt ở đây. Đây không phải quy ước
 * viết tay: kiểu trả về buộc nó, nên thêm một nhãn mới vào library làm **lỗi
 * compile** ở chính file này thay vì một chuỗi tiếng Anh lặng lẽ rơi vào giao
 * diện tiếng Việt.
 */
export function appShellLabels(translate: Translate): AppShellLabels {
  return {
    settings: {
      title: translate('shell.settings.title'),
      description: translate('shell.settings.description'),
      theming: translate('shell.settings.theming'),
      layout: translate('shell.settings.layout'),
      color: translate('shell.settings.color'),
      direction: translate('shell.settings.direction'),
      directionLtr: translate('shell.settings.directionLtr'),
      directionRtl: translate('shell.settings.directionRtl'),
    },
    search: {
      buttonLabel: translate('shell.search.button'),
      placeholder: translate('shell.search.placeholder'),
      emptyLabel: translate('shell.search.empty'),
      dialogTitle: translate('shell.search.dialogTitle'),
      dialogDescription: translate('shell.search.dialogDescription'),
    },
  };
}
