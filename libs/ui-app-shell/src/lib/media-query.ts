import { onMounted, onScopeDispose, ref, type Ref } from 'vue';

/**
 * `window.matchMedia` với giá trị **xác định cho SSR và lần render đầu ở
 * client**.
 *
 * `useMediaQuery` của VueUse trả `false` khi không có `window`, tức là trên
 * SSR mọi query đều "không khớp". Với `useMediaQuery('(max-width: 768px)')`
 * trong `SidebarProvider`, hệ quả là SSR render sidebar desktop còn client ở
 * viewport hẹp render mobile drawer — hai cây DOM khác nhau cho cùng một
 * request, Vue báo hydration mismatch và phải patch lại. Nguồn upstream xử lý
 * bằng plugin `provideSSRWidth(1024)`; ở đây làm cùng ý tưởng đó nhưng không
 * cần plugin của Nuxt: giá trị mặc định là tham số tường minh, và giá trị thật
 * chỉ được đọc trong `onMounted` — sau hydration.
 *
 * @param query media query, ví dụ `(max-width: 768px)`
 * @param ssrMatches giá trị dùng cho SSR và lần render đầu ở client; phải là
 *   giá trị mà media query trả về ở breakpoint tham chiếu (nguồn dùng 1024px).
 */
export function useAppShellMediaQuery(query: string, ssrMatches: boolean): Ref<boolean> {
  const matches = ref(ssrMatches);

  let media: MediaQueryList | undefined;
  const onChange = (event: MediaQueryListEvent): void => {
    matches.value = event.matches;
  };

  onMounted(() => {
    media = window.matchMedia(query);
    matches.value = media.matches;
    media.addEventListener('change', onChange);
  });

  onScopeDispose(() => {
    media?.removeEventListener('change', onChange);
  });

  return matches;
}
