# @ecoma-io/ui-app-shell

Shell dashboard dùng chung cho `apps/backoffice`, `apps/pact-broker-app`, `apps/llm-console` và
`apps/llm-seller`, port từ
[dianprata/nuxt-shadcn-dashboard](https://github.com/dianprata/nuxt-shadcn-dashboard)
(commit `54988681e50feaa4935828882da93faff06cf042`, MIT). Repository nguồn là bản tham chiếu —
giao diện, bố cục và tương tác của shell gốc được giữ nguyên, chỉ thích nghi với kiến trúc Nx và
ràng buộc runtime của Ecoma.

## Hợp đồng cấu hình

Chỉ hai thứ người dùng cấu hình được:

- `themeColor` — màu chủ đạo, một trong `APP_SHELL_THEME_COLORS`.
- `direction` — `'ltr'` hoặc `'rtl'`.

Mọi thứ khác là **bất biến** của shell, không có control và không có logic đổi trạng thái:

- Luôn **dark mode** (class `dark` là hằng số trên `<html>`).
- Sidebar luôn là biến thể **`sidebar`** cố định (không có `floating`/`inset`).
- Typography luôn là **`default`** (không có `mono`/`scaled`).

Cấu hình cũ của nguồn (`theme.type`, `sidebar.variant`, `sidebar.side`…) khi gặp sẽ bị bỏ qua;
xem mục Migration.

## Public API

`src/index.ts` export bốn nhóm:

- `./lib/preferences` — kiểu và helper cấu hình: `AppShellPreferences`, `AppShellDirection`,
  `AppShellThemeColor`, `APP_SHELL_THEME_COLORS`, `DEFAULT_APP_SHELL_PREFERENCES`,
  `APP_SHELL_PREFERENCES_COOKIE`, `LEGACY_APP_SETTINGS_KEY`, `parseAppShellPreferences()`,
  `isAppShellPreferences()`, `migrateLegacyAppSettings()`, `appShellHeadAttributes()`,
  `appShellColorClass()`.
- `./lib/shell` — component và kiểu của shell: `AppShell` cùng các mảnh con
  (`AppShellSidebar`, `AppShellHeader`, `AppShellNav`, `AppShellBreadcrumb`, `AppShellSearch`,
  `AppShellSettingsPanel`, `AppShellSidebarNavGroup`, `AppShellSidebarNavLink`), các kiểu nav
  (`AppShellNavSection`, `AppShellNavGroup`, `AppShellNavItem`, `AppShellNavEntry`,
  `AppShellCommandGroup`, `AppShellCommandItem`, `AppShellBreadcrumbLink`) và helper
  (`appShellBreadcrumbLinks`, `humanize`, `useAppShell`, `useAppShellMetaSymbol`,
  `useAppShellCommandPaletteShortcut`).
- `./lib/ui` — primitive shadcn-vue (avatar, badge, breadcrumb, button, collapsible, command,
  dialog, drawer, dropdown-menu, input, kbd, label, scroll-area, separator, sheet, sidebar,
  skeleton, tooltip). Dùng trực tiếp khi dựng nội dung trang.
- `cn` — helper ghép class.

## Dùng trong app

### 1. Kiểu

Đăng ký alias cho `@ecoma-io/ui-app-shell` trong `nuxt.config.ts` (xem ghi chú trong
`nuxt.config.ts` của app) và import stylesheet một lần trong CSS entry của app:

```css
@import 'tailwindcss';
/* Đường dẫn TƯƠNG ĐỐI, không qua specifier của package — xem lý do ngay dưới. */
@import '../../../../../libs/ui-app-shell/src/styles/app-shell.css';
@source "../../../../../libs/ui-app-shell/src/**/*.{vue,ts}";
```

**`@import` phải là đường dẫn tương đối, không được dùng specifier của package.** Vite áp
`alias` của app cho **cả** resolver stylesheet của Tailwind, nên `@import` kèm subpath qua
specifier của package bị ghép thành `<entrypoint TS>/styles/app-shell.css` (entrypoint TS là
`libs/ui-app-shell/src/index.ts` do alias trỏ tới) và build đỏ `ENOTDIR`. Đây là lỗi đã xảy ra
thật khi tích hợp ba app, và chỉ lộ ra ở `nuxt build` — typecheck, lint và `nx lint` đều xanh.

**`@nuxt/fonts` của app phải khai đủ `fonts.defaults.weights`**. `@nuxt/fonts` dùng `fontless`
và khi quét `@font-face` từ CSS sẽ chỉ lấy weight 400 nếu app không khai `defaults.weights`; dù
`shell` đặt `font-synthesis-weight: none` để không tự bù độ đậm, việc không khai đủ weight dẫn đến
face weight cần thiết không được tải (đo trên build thật: chỉ còn 15 face toàn 400). Khai giống
upstream `[300, 400, 500, 600, 700, 800]` để các lớp `font-medium`/`font-semibold` của shell được
tải đúng weight. Chưa app consumer nào có test ghim `fonts.defaults.weights` (pattern mục tiêu
là một test per-app, đặt cạnh stylesheet của app); đến khi có, khai liệt kê sáu weight là
việc phải làm thủ công mỗi lần tích hợp.

`@source` cũng là đường dẫn tương đối tính từ chính file CSS này; số cấp `..` tuỳ vị trí, phải
kiểm tra lại khi đổi chỗ stylesheet. Đếm sai một cấp là lỗi **im lặng** của Tailwind (không lỗi
build, chỉ mất utility), nên mỗi app consumer của library này giữ một test ghim số cấp:
`apps/backoffice/app/assets/css/styles.spec.ts` (đặt cạnh stylesheet),
`apps/pact-broker-app/tests/tailwind-source.spec.ts` và
`apps/llm-console/tests/tailwind-source.spec.ts` cùng
`apps/llm-seller/tests/tailwind-source.spec.ts`.

Về `@source`, đo bằng A/B build thật trên `apps/backoffice` (bỏ từng dòng rồi build lại):

| `@source` của lib | `@source` của app | byte CSS production | xuất hiện `.peer-hover\/menu-button\:…` |
| ----------------- | ----------------- | ------------------- | --------------------------------------- |
| có                | có (đang dùng)    | 84.200              | có                                      |
| bỏ                | có                | 84.200              | có                                      |
| có                | bỏ                | 84.200              | có                                      |
| bỏ                | bỏ                | 41.112              | không                                   |

Ba biến thể còn ít nhất một dòng cho **đúng cùng một class set** (265 class; so bằng tập class chứ
không chỉ bằng số byte), còn biến thể bỏ **cả hai** chỉ còn 24 class — mất 241 class chỉ có khi source
của library được đăng ký. Con số tuyệt đối đã tăng so với lần đo đầu (66.459 → 84.200 byte;
23.371 → 41.112 byte) vì bản port khai đủ sáu weight Geist trong `@nuxt/fonts`, nên CSS có thêm các
`@font-face` và utility độ đậm.

`peer-hover/menu-button:text-sidebar-accent-foreground` là utility chỉ có trong `SidebarMenuButton`
của library; nó không xuất hiện ở bất kỳ source nào của app, nên dùng làm probe không thể xanh giả.

Hai dòng trỏ cùng một cây source của library, và **mỗi dòng một mình đã đủ**: `app-shell.css`
tự đăng ký `@source '../**/*.{vue,ts}'` ở cuối file, còn CSS entry của app khai thêm một dòng
nữa tới cùng thư mục. Không có dòng nào là "lớp chịu tải" khi dòng kia còn sống — chúng dư thừa
lẫn nhau, và chỉ khi thiếu **cả hai** thì class của lib mới bị loại khỏi CSS production. Cả hai
vẫn được khai vì app nên tự chịu trách nhiệm CSS của mình: một consumer chỉ dùng component mà
không `@import` `app-shell.css` thì dòng của app là registration duy nhất, và CSS production của
app không phụ thuộc vào việc library có nhớ tự đăng ký hay không.

### 2. Layout gốc

`AppShell` là một component thuần: nó **không** đọc/ghi cookie, không đọc route, không giữ bản
sao cấu hình. App là nơi duy nhất biết cấu hình, truyền vào bằng prop và nhận lại qua
`update:preferences`. Nhờ vậy cả SSR và client hydration đọc đúng cùng một giá trị đã persist.

```vue
<script setup lang="ts">
import {
  APP_SHELL_PREFERENCES_COOKIE,
  AppShell,
  DEFAULT_APP_SHELL_PREFERENCES,
  appShellHeadAttributes,
  parseAppShellPreferences,
  type AppShellNavSection,
  type AppShellPreferences,
} from '@ecoma-io/ui-app-shell';

// `parseAppShellPreferences` luôn trả về cấu hình hợp lệ: cookie hỏng, thiếu trường hay
// chứa giá trị lạ đều rơi về mặc định, nên không cần nhánh `if` nào ở nơi gọi.
const cookie = useCookie<AppShellPreferences>(APP_SHELL_PREFERENCES_COOKIE, {
  default: () => DEFAULT_APP_SHELL_PREFERENCES,
});
const preferences = computed(() => parseAppShellPreferences(cookie.value));
const updatePreferences = (next: AppShellPreferences) => {
  cookie.value = next;
};

// `dir` trên <html> và class `dark`/`color-*` suy ra từ cùng một cấu hình, không đọc
// `window`/`localStorage`/`matchMedia` — đây là điều kiện để hydration không lệch.
useHead(() => appShellHeadAttributes(preferences.value));

const nav: AppShellNavSection[] = [/* điều hướng của app này */];
</script>

<template>
  <AppShell
    :preferences="preferences"
    :nav="nav"
    :current-path="route.path"
    @update:preferences="updatePreferences"
  >
    <template #brand><!-- logo/thương hiệu của app --></template>
    <template #actions><!-- menu tài khoản, thông báo… của app --></template>
    <template #footer><!-- chân sidebar --></template>

    <NuxtPage />
  </AppShell>
</template>
```

### Props và slots của `AppShell`

| Prop          | Kiểu                                | Bắt buộc | Mặc định |
| ------------- | ----------------------------------- | -------- | -------- |
| `preferences` | `AppShellPreferences`               | có       | —        |
| `nav`         | `readonly AppShellNavSection[]`     | có       | —        |
| `bottomItems` | `readonly AppShellNavEntry[]`       | không    | —        |
| `commands`    | `readonly AppShellCommandGroup[]`   | không    | —        |
| `links`       | `readonly AppShellBreadcrumbLink[]` | không    | —        |
| `currentPath` | `string`                            | không    | `'/'`    |
| `homeLabel`   | `string`                            | không    | `'Home'` |

Emit: `update:preferences` với `AppShellPreferences` mới.

Slots: `brand` (đầu sidebar), `actions` (góc phải header), `footer` (chân sidebar), và slot mặc
định (nội dung trang).

## Migration từ cấu hình cũ

Nguồn lưu cấu hình trong `localStorage` dưới khoá `app_settings`
(`LEGACY_APP_SETTINGS_KEY`), gồm cả những trường shell này không còn hỗ trợ. Dùng
`migrateLegacyAppSettings(legacy)` một lần để suy ra `AppShellPreferences`:

- Trường không hỗ trợ (`theme.type`, `sidebar.variant`) bị bỏ qua.
- Màu chủ đạo không nằm trong bảng hỗ trợ (ví dụ `amber`, `purple` của nguồn) cũng bị bỏ qua:
  nếu `sidebar.side` đọc được thì chỉ `themeColor` rơi về mặc định, còn nếu đó là trường duy
  nhất thì hàm trả `undefined` (không ghi cookie vô nghĩa).
- `sidebar.side` được đọc như tín hiệu chiều văn bản **một lần**, chỉ để suy `direction`. Sau
  đó `direction` được persist độc lập với vị trí sidebar.

## Tailwind v4

Class của shell chỉ vào được CSS production nếu Tailwind **quét** tới source của lib, và có hai
lớp đăng ký (xem mục 1):

1. `@source '../**/*.{vue,ts}'` ở cuối `src/styles/app-shell.css`. Mọi consumer `@import` file
   này nên nó luôn chạy.
2. `@source` trong CSS entry của app consumer, trỏ tới cùng thư mục source.

Hai lớp này **dư thừa lẫn nhau**: bỏ lớp (2) cho cùng class set như (1), và bỏ lớp (1) cũng vậy
khi (2) còn — đo bằng A/B build, xem bảng ở mục 1. Chỉ khi thiếu **cả hai** thì class của lib bị
loại khỏi CSS production **một cách im lặng** — build vẫn xanh, typecheck/lint vẫn xanh, chỉ bản
production thiếu utility.

Cách kiểm tra đã dùng để đo bảng trên (lặp lại được):

```sh
# bỏ @source ở một phía (hoặc cả hai), rồi:
npx nx build @ecoma-io/backoffice
ls -l apps/backoffice/.output/public/_nuxt/*.css          # ~84.2 KB vs ~41.1 KB
# probe: một utility CHỈ có trong lib, không xuất hiện ở app source
grep -c 'peer-hover\\/menu-button\\:text-sidebar-accent-foreground' apps/backoffice/.output/public/_nuxt/*.css
```

Cột `class set` (265 / 24) so bằng **tập** class, không bằng số byte: giữ lại file CSS của hai
biến thể rồi lấy hiệu tập class giữa chúng. So bằng số byte là chưa đủ — hai lần build có thể cùng
số byte mà khác class, và ngược lại (đã gặp thật: `@font-face` trỏ asset font content-addressed
khác tên nhưng cùng độ dài, tổng byte không đổi).

```sh
python3 - <<'PY'
import re, sys
def classes(p):
    return set(re.findall(r'\.([a-zA-Z][a-zA-Z0-9_-]*)', open(p, encoding='utf-8').read()))
a, d = classes(sys.argv[1]), classes(sys.argv[2])   # A (còn @source) và D (bỏ cả hai)
print(f'A={len(a)} D={len(d)} chi-co-khi-lib-dang-ky={len(a - d)}')
PY
# A.css D.css
```

Đừng grep một class mà app cũng nhắc tới (kể cả trong comment hay assertion): Tailwind quét cả
những file đó nên phép kiểm sẽ xanh giả. Các app consumer của library này giữ test ghim số cấp
của `@source` và của `@import`: `apps/backoffice/app/assets/css/styles.spec.ts`,
`apps/pact-broker-app/tests/tailwind-source.spec.ts`,
`apps/llm-console/tests/tailwind-source.spec.ts` và
`apps/llm-seller/tests/tailwind-source.spec.ts`. (`apps/home` dùng `ui-ecoma-logo`, không
phải consumer của library này; test `apps/home/app/assets/css/styles.spec.ts` ghim riêng thư mục
nguồn `libs/ui-ecoma-logo/src`.)

## Runtime

- Tag `runtime:universal`: chạy được cả server và browser. Không dùng Node built-ins trong code
  runtime; không truy cập `window`/`localStorage` để xác định theme/direction lần render đầu.
- Truy vấn media (`useAppShellMediaQuery`) chỉ đọc `matchMedia` trong `onMounted`; giá trị SSR
  được truyền vào tường minh, nên cây DOM của lần render đầu ở client khớp HTML server gửi.
- RTL được thiết lập ở ba tầng cùng lúc: `dir` trên `<html>`, `ConfigProvider :dir` của reka cho
  các primitive (dropdown, sheet, tooltip), và `data-side` của sidebar — không chỉ đổi phía
  sidebar.

## Giấy phép

Bản quyền MIT của repository nguồn được giữ nguyên; mọi file chứa mã port/adapt từ nguồn đều
mang banner nguồn (136/149 file `.vue`/`.ts` trong `src/`, cộng `styles/app-shell.css`; 13 file
còn lại là mã Ecoma viết mới — barrel `index.ts`, kiểu nav, helper, harness test, `shims.d.ts`).
Giấy phép của các dependency, icon, font và asset bên thứ ba được xác minh riêng — xem
[`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md).
