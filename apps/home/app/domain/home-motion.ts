/**
 * Motion của homepage — hero timeline (GSAP) + scroll reveal, client-only.
 *
 * Nguyên tắc (đúng contract của task #104):
 * - **SSR render đầy đủ không JS**: mọi nội dung hiển thị nằm trong HTML
 *   server; motion chỉ là cải tiến tiến dần. Composable KHÔNG ẩn nội dung khi
 *   chưa có JS — và cũng không ẩn nội dung đã hiển thị rồi mới fade lại: hero
 *   dùng `fromTo` (đặt trạng thái đích lúc tween chạy) chứ không `gsap.set`
 *   trạng thái ẩn trước, vì dynamic import xảy ra sau khi trình duyệt đã paint
 *   HTML nên `set` sẽ tạo nhấp nháy. Scroll reveal tương tự: trạng thái ẩn chỉ
 *   set cho phần tử **đang dưới fold** tại thời điểm init.
 * - **Không nhấp nháy khi scroll**: trạng thái ẩn của phần tử `data-reveal` chỉ
 *   được set cho phần tử **đang dưới fold** tại thời điểm init, và animation
 *   dùng `gsap.to` (không phải `fromTo`) nên phần tử đã nằm trong viewport lúc
 *   init không bao giờ bị đẩy về ẩn rồi fade lại.
 * - **`prefers-reduced-motion: reduce`**: không init timeline nào, không set
 *   bất kỳ style inline nào — trang đứng yên hoàn toàn. Thiếu `matchMedia`
 *   được xử lý tương tự; thiếu riêng `IntersectionObserver` thì bỏ phần
 *   scroll-reveal nhưng hero vẫn animate (GSAP đã tải thành công).
 * - **Cleanup**: `gsap.context()` scope mọi animation vào root element; hàm
 *   cleanup được composable tự đăng ký qua `onBeforeUnmount` để revert toàn
 *   bộ inline style — một client-side navigate rời homepage không để lại
 *   style sót. Init gãy giữa chừng (API vắng ngoài guard, DOM bất ngờ) cũng
 *   được hoàn tác ngay trong `catch` — hero không bao giờ kẹt trong trạng
 *   thái ẩn chỉ vì nửa sau của init ném lỗi. Dynamic import của GSAP cũng
 *   được bọc `try` riêng — lỗi tải chunk bị nuốt và bỏ motion, vì lỗi đó xảy
 *   ra trước khi `gsap.context` tồn tại nên `catch` bên trong không bắt được.
 * - Không WebGL, không framework UI mới — duy nhất `gsap` (dependency đã pin
 *   ở workspace root).
 *
 * Composable tự đăng ký lifecycle (`onMounted` init, `onBeforeUnmount`
 * cleanup) — caller chỉ truyền root ref; cả hai hook là no-op trên server.
 */

import { onBeforeUnmount, onMounted } from 'vue';
import type { Ref } from 'vue';
// Type-only: bị xoá khi compile nên không kéo GSAP vào bundle của main chunk —
// import runtime vẫn là dynamic import bên dưới (xem guard reduced-motion).
// `Tween` không phải named export của `gsap` (nó nằm trong namespace
// `gsap.core`), nên suy ra type từ chính `gsap.fromTo` thay vì import tên.
import type { gsap as GsapStatic } from 'gsap';

/** Kết quả của composable — hàm cleanup, được đăng ký tự động ở unmount. */
export type HomeMotionCleanup = () => void;

/**
 * Chạy hero timeline + scroll reveal trên root element.
 *
 * Gọi trong `onMounted` (chỉ client). Root là phần tử bọc toàn bộ trang —
 * timeline thao tác trên selector con của nó, không đụng DOM ngoài scope.
 */
export function useHomeMotion(root: Ref<HTMLElement | undefined>): HomeMotionCleanup {
  let dispose: HomeMotionCleanup | undefined;
  // True từ khi component unmount — mọi init bất đồng bộ phải dừng lại sau
  // `await`: nếu người dùng navigate rời homepage trong lúc chunk GSAP đang
  // tải, callback vẫn chạy tiếp trên `element` đã detach và tạo observer +
  // context mà không bao giờ có ai dọn (dispose chỉ được gán SAU khi await
  // hoàn tất, nên unmount chạy trước đó không thấy nó). Cờ độc lập với
  // `dispose` vì `dispose` có thể undefined vì lý do khác (guard return sớm).
  let disposed = false;

  onMounted(async () => {
    const element = root.value;
    if (element === undefined) {
      return;
    }
    // Guard kép: môi trường không có `matchMedia` (jsdom, trình duyệt cũ) được
    // xử lý như reduce-motion — không JS motion thay vì throw trong mounted
    // hook. Browser thật luôn có API nên nhánh này không ảnh hưởng UX.
    if (typeof window.matchMedia !== 'function') {
      return;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }

    // Dynamic import sau guard reduced-motion: người dùng reduce-motion không
    // tải bundle GSAP (network .shift() không đổi; chỉ lazy-load chunk).
    //
    // Bọc try/catch RIÊNG quanh dynamic import: chunk GSAP có thể tải lỗi
    // (offline, hashed asset cũ sau deploy, CDN hiccup) và lời gọi này là
    // async — không có `try` bao ngoài thì rejection nổi lên thành unhandled
    // rejection, đúng thứ contract của module nêu là không được phép. Không
    // thể để `catch` của `gsap.context` xử lý vì lỗi này xảy ra TRƯỚC khi
    // context tồn tại. Nuốt lỗi ở đây và bỏ motion: trang tĩnh SSR vẫn đầy đủ.
    let gsapModule: typeof import('gsap');
    try {
      gsapModule = await import('gsap');
    } catch {
      return;
    }
    if (disposed) {
      return;
    }
    const { gsap } = gsapModule;

    gsap.context((self) => {
      // Toàn bộ thao tác trong callback dùng `self` (tham số của
      // `gsap.context`), không dùng biến nhận kết quả bên ngoài — khi callback
      // đang chạy, biến đó còn ở TDZ.
      let observer: IntersectionObserver | undefined;
      try {
        // Hero timeline: eyebrow → heading → description → CTAs → proofs, stagger
        // nhẹ theo thứ tự đọc. Chỉ transform + opacity (compositor-friendly).
        const heroTargets = [
          '[data-hero="eyebrow"]',
          '[data-hero="heading"]',
          '[data-hero="description"]',
          '[data-hero="actions"]',
          '[data-hero="proofs"]',
        ].map((selector) => element.querySelector(selector));
        if (heroTargets.every((target) => target !== null)) {
          // Hero dùng `fromTo`, KHÔNG `gsap.set` trạng thái ẩn rồi `to`.
          // Lý do: dynamic import xảy ra SAU khi trình duyệt đã paint HTML SSR,
          // nên `gsap.set(autoAlpha: 0)` sẽ làm hero bật biến mất đột ngột rồi
          // fade lại — nhấp nháy đúng trên mọi lần tải trang, tệ nhất khi mạng
          // chậm (chunk về sau vài trăm ms). `fromTo` đặt trạng thái đích ngay
          // khi tween khởi chạy nên không có khoảng thời gian nào hero ở trạng
          // thái ẩn trước khi bắt đầu fade.
          //
          // `immediateRender: false` là bắt buộc: `fromTo` mặc định render
          // ngay trạng thái `from` lúc khởi tạo tween, và với timeline có
          // nhiều tween chạy trễ (`'-=0.25'`…) các tween sau sẽ render
          // `from` đè lên tween trước đã bắt đầu. Tắt nó để tween chỉ set
          // trạng thái ẩn tại thời điểm thực sự bắt đầu.
          const fadeIn = (
            selector: string,
            duration: number,
            position?: string,
          ): ReturnType<typeof GsapStatic.fromTo> =>
            gsap.fromTo(
              selector,
              { autoAlpha: 0, y: 18 },
              {
                autoAlpha: 1,
                y: 0,
                duration,
                ease: 'power2.out',
                immediateRender: false,
                ...(position === undefined ? {} : { position }),
              },
            );
          gsap
            .timeline({ defaults: { ease: 'power2.out' } })
            .add(fadeIn('[data-hero="eyebrow"]', 0.5), 0)
            .add(fadeIn('[data-hero="heading"]', 0.6), '-=0.25')
            .add(fadeIn('[data-hero="description"]', 0.5), '-=0.3')
            .add(fadeIn('[data-hero="actions"]', 0.5), '-=0.3')
            .add(fadeIn('[data-hero="proofs"]', 0.5), '-=0.3');
        }

        // Scroll reveal: các section dưới hero trượt nhẹ lên lần đầu xuất hiện
        // trong viewport. IntersectionObserver một lần (unobserve sau khi
        // reveal) nên không có work lặp khi scroll ngược. Guard riêng cho API:
        // môi trường thiếu `IntersectionObserver` (jsdom, webview cũ) bỏ phần
        // reveal nhưng giữ hero animate — các section giữ trạng thái SSR nhìn
        // thấy được, thay vì ném giữa chừng sau khi gsap.set đã ẩn hero.
        const revealables = Array.from(element.querySelectorAll('[data-reveal]'));
        if (revealables.length > 0 && typeof IntersectionObserver === 'function') {
          // Trạng thái ẩn được set **ngay lúc init**, chỉ cho phần tử đang nằm
          // dưới fold — phần tử đã ở trong viewport giữ nguyên nội dung SSR đang
          // hiện. Nếu chờ tới lúc observer bắn mới ẩn, người đọc sẽ thấy section
          // hiện rồi mới biến mất rồi fade lại: đó là nhấp nháy, không phải
          // "cải tiến tiến dần" như contract của module nêu.
          const belowFold = revealables.filter(
            (target) => target.getBoundingClientRect().top > window.innerHeight,
          );
          if (belowFold.length > 0) {
            gsap.set(belowFold, { autoAlpha: 0, y: 24 });
          }
          observer = new IntersectionObserver(
            (entries) => {
              for (const entry of entries) {
                if (!entry.isIntersecting) {
                  continue;
                }
                observer?.unobserve(entry.target);
                // `to` chứ không `fromTo`: phần tử dưới fold đã bị ẩn sẵn ở
                // trên nên chỉ cần tăng dần lên visible. `fromTo` sẽ ghi đè
                // `autoAlpha: 0` lên phần tử đang hiện (nằm sẵn trong viewport
                // lúc init, không bị ẩn) rồi fade lại — đúng cái nhấp nháy cần
                // tránh.
                gsap.to(entry.target, { autoAlpha: 1, y: 0, duration: 0.6, ease: 'power2.out' });
              }
            },
            { threshold: 0.15 },
          );
          for (const target of revealables) {
            observer.observe(target);
          }
        }
        dispose = (): void => {
          observer?.disconnect();
          self.revert();
        };
      } catch {
        // Lớp phòng thủ cuối cho mọi lỗi ngoài dự tính giữa chừng init:
        // gsap.set ở trên có thể đã ẩn hero nhưng `dispose` chưa được gán, nên
        // không ai khác hoàn tác được — phải revert ngay tại đây để trang quay
        // về trạng thái SSR nhìn thấy được. Lỗi được nuốt CÓ CHỦ ĐÍCH: motion
        // chỉ là cải tiến nên không được nổi lên thành unhandled rejection làm
        // hỏng trang, app không có hạ tầng log client-side để báo, và fallback
        // (trang tĩnh hoàn chỉnh) là kết quả đúng theo contract phía trên.
        observer?.disconnect();
        self.revert();
      }
    }, element);
  });

  // Tự đăng ký cleanup trong composable — đúng contract JSDoc phía trên.
  // Caller trước đây bỏ qua giá trị trả về, nên nếu chỉ trả hàm mà không đăng
  // ký thì IntersectionObserver giữ strong reference tới subtree đã detach và
  // inline style của GSAP sót lại sau client-side navigate rời homepage.
  onBeforeUnmount(() => {
    disposed = true;
    dispose?.();
    dispose = undefined;
  });

  return (): void => dispose?.();
}
