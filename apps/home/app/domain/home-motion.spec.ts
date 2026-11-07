// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { gsap as realGsap } from 'gsap';
import { useHomeMotion } from './home-motion';

/**
 * Test composable motion của homepage — chạy trong jsdom (client lifecycle).
 *
 * Phạm vi: hai guard cốt lõi (reduced-motion và matchMedia thiếu) KHÔNG được
 * để lại bất kỳ inline style nào trên DOM — đây là contract "SSR render đầy
 * đủ, motion chỉ cải tiến": trình duyệt reduce-motion phải thấy trang tĩnh
 * hoàn chỉnh. Đường GSAP thật (timeline chạy) KHÔNG được chờ qua playback:
 * trong jsdom, ticker GSAP chạy trên rAF mà runner CI starve - lagSmoothing
 * giới hạn mỗi frame trễ advances 33ms, nên một timeline 0.25s có thể cần
 * hơn 1000ms wall-time (vượt mặc định `vi.waitFor`) mà không đỏ do logic.
 * Lúc cần trạng thái "timeline đã render tới t": chờ tín hiệu đồng bộ của
 * init (lời gọi `gsap.context` - callback của nó chạy trọn vẹn trong cùng
 * khối đồng bộ), rồi render **đồng bộ** bằng `gsap.updateRoot(time)`.
 */

/** Số giây GSAP-time mà test render tới - đủ để mọi hero tween đã bắt đầu. */
const RENDER_TIME_SECONDS = 0.5;

/**
 * Chờ init của composable chạy xong qua tín hiệu ĐỒNG BỘ: `gsap.context`
 * được gọi ngay sau `await import('gsap')`, và callback bên trong nó (nơi
 * timeline được tạo) chạy trọn vẹn trong cùng khối đồng bộ - nên khi spy thấy
 * lời gọi thì timeline chắc chắn đã tồn tại. Không phụ thuộc rAF/ticker.
 *
 * Cần `vi.waitFor` (không phải một lần check) vì composable đạt tới lời gọi
 * đó SAU `await import('gsap')` - một macrotask mà thời lượng không bị chặn
 * bởi số vòng setTimeout khi runner đầy tải. Waiter này vẫn nhanh: chỉ chờ
 * microtask/module-loader, không chờ playback.
 */
function waitForContextCall(spy: ReturnType<typeof vi.spyOn>): Promise<void> {
  return vi.waitFor(() => {
    expect(spy).toHaveBeenCalled();
  });
}

function mountWithMotion(): {
  wrapper: ReturnType<typeof mount>;
  root: HTMLElement;
  host: HTMLElement;
} {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const TestComponent = defineComponent({
    setup() {
      const root = ref<HTMLElement>();
      useHomeMotion(root);
      return { root };
    },
    template: `<div ref="root" data-testid="motion-root">
      <p data-hero="heading">H</p>
      <section data-reveal>R</section>
    </div>`,
  });
  const wrapper = mount(TestComponent, { attachTo: host });
  const root = wrapper.get('[data-testid="motion-root"]').element as HTMLElement;
  return { wrapper, root, host };
}

describe('useHomeMotion', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // KHÔNG gọi `resetModules`: nó tách module registry, khiến
    // `await import('gsap')` bên trong `home-motion` nhận instance KHÁC với
    // instance đã spy ở top-level của file này — spy sẽ không bao giờ thấy
    // lời gọi nào và assert rỗng, fail ngẫu nhiên theo thứ tự test.
    vi.doUnmock('gsap');
  });

  it('applies no inline style when prefers-reduced-motion is reduce', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn<() => { matches: boolean }>().mockReturnValue({ matches: true }),
    );
    const importSpy = vi.fn<() => unknown>();
    vi.doMock('gsap', () => ({ gsap: importSpy }));

    const { wrapper, root, host } = mountWithMotion();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    // Không style inline nào trên root và con — reduce-motion đứng yên tuyệt đối.
    expect(root.getAttribute('style')).toBeNull();
    expect(root.innerHTML).not.toContain('style=');
    wrapper.unmount();
    document.body.removeChild(host);
  });

  it('applies no inline style when matchMedia is unavailable', async () => {
    // Môi trường không có matchMedia (jsdom thuần) phải được xử lý như
    // reduce-motion — mounted hook không được throw.
    const { wrapper, root, host } = mountWithMotion();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(root.getAttribute('style')).toBeNull();
    expect(root.innerHTML).not.toContain('style=');
    wrapper.unmount();
    document.body.removeChild(host);
  });

  it('disconnects the IntersectionObserver on unmount without the caller calling the return value', async () => {
    // Cleanup phải tự chạy trong composable (onBeforeUnmount), không phụ thuộc
    // caller nhớ gọi giá trị trả về — nếu không, observer giữ strong reference
    // tới subtree đã detach và inline style của GSAP sót lại sau navigate.
    //
    // Dùng GSAP thật (dynamic import của composable không bị vi.doMock chặn)
    // với đầy đủ 5 hero targets như trang thật: composable chỉ tạo observer
    // khi có ít nhất một `[data-reveal]`, nên bỏ hẳn `data-reveal` thì đường
    // dispose không bao giờ chạy và test rỗng. IntersectionObserver được thay
    // bằng fake để đếm `disconnect`.
    vi.stubGlobal(
      'matchMedia',
      vi.fn<() => { matches: boolean }>().mockReturnValue({ matches: false }),
    );
    const disconnect = vi.fn<() => void>();
    const observe = vi.fn<(...args: unknown[]) => void>();
    class FakeIntersectionObserver {
      observe = observe;
      unobserve = vi.fn<(...args: unknown[]) => void>();
      disconnect = disconnect;
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const FullHero = defineComponent({
      setup() {
        const root = ref<HTMLElement>();
        useHomeMotion(root);
        return { root };
      },
      template: `<div ref="root">
        <p data-hero="eyebrow">e</p>
        <h1 data-hero="heading">H</h1>
        <p data-hero="description">d</p>
        <div data-hero="actions">a</div>
        <ul data-hero="proofs">p</ul>
        <section data-reveal>R</section>
      </div>`,
    });
    const wrapper = mount(FullHero, { attachTo: host });
    // Chờ init chạy xong bằng tín hiệu ĐỒNG BỘ, không phải playback của timeline:
    // `observe` được gọi ngay trong init callback, ở cùng khối đồng bộ với lệnh
    // gán `dispose` — khối đó chạy trọn vẹn trước khi mounted hook hoàn tất, nên
    // khi `observe` đã được gọi thì init chắc chắn xong. Đó đúng là mốc mà test
    // này cần ("dispose đã được gán") mà không phụ thuộc ticker của timeline.
    //
    // Trước đây precondition chờ inline style của hero heading trong
    // `vi.waitFor` (mặc định 1000ms). Style đó KHÔNG được set lúc khởi tạo:
    // `home-motion` dùng `fromTo` + `immediateRender: false` (tránh nhấp nháy
    // khi chunk GSAP về sau khi trình duyệt đã paint HTML SSR), nên heading chỉ
    // nhận style khi tween bắt đầu chạy (t≈0.25s trên ticker GSAP). Ticker chạy
    // qua rAF của jsdom và bị lagSmoothing giới hạn còn 33ms mỗi frame khi trễ
    // hơn 500ms — trên runner CI (4 vCPU, `nx affected` chạy song song 19 test
    // task) rAF bị starve và precondition vượt 1000ms, làm test đỏ ngẫu nhiên
    // dù logic không đổi (Issue #189).
    await vi.waitFor(() => {
      expect(observe).toHaveBeenCalled();
    });

    // Caller bỏ qua giá trị trả về — chỉ unmount.
    wrapper.unmount();

    expect(disconnect).toHaveBeenCalled();
    document.body.removeChild(host);
  });

  it('drops async init when unmount happens while GSAP is still importing', async () => {
    // Race unmount ↔ `await import('gsap')`: navigate rời homepage giữa chừng
    // chunk đang tải thì callback mounted vẫn tiếp tục sau await trên element
    // đã detach — nếu không có cờ `disposed` kiểm tra sau await, observer được
    // tạo trên subtree rời DOM và không bao giờ được dọn (dispose chỉ được gán
    // sau đó). Regression: unmount TRƯỚC khi GSAP kịp init → không một
    // IntersectionObserver nào được tạo sau unmount.
    vi.stubGlobal(
      'matchMedia',
      vi.fn<() => { matches: boolean }>().mockReturnValue({ matches: false }),
    );
    let constructed = 0;
    class FakeIntersectionObserver {
      observe = vi.fn<() => void>();
      unobserve = vi.fn<() => void>();
      disconnect = vi.fn<() => void>();
      constructor() {
        constructed += 1;
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const FullHero = defineComponent({
      setup() {
        const root = ref<HTMLElement>();
        useHomeMotion(root);
        return { root };
      },
      template: `<div ref="root">
        <p data-hero="eyebrow">e</p>
        <h1 data-hero="heading">H</h1>
        <p data-hero="description">d</p>
        <div data-hero="actions">a</div>
        <ul data-hero="proofs">p</ul>
        <section data-reveal>R</section>
      </div>`,
    });
    const wrapper = mount(FullHero, { attachTo: host });

    // Unmount NGAY khi mounted hook vừa chạy — dynamic import chưa resolve.
    wrapper.unmount();
    document.body.removeChild(host);

    // Chờ mọi macrotask (kể cả import + callback sau await) chạy hết.
    for (let i = 0; i < 10; i += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }

    expect(constructed).toBe(0);
  });

  it('keeps hero animated and skips reveal when IntersectionObserver is missing', async () => {
    // Môi trường không có IntersectionObserver (webview cũ): nếu không guard,
    // `new IntersectionObserver` ném ngay sau khi gsap.set đã ẩn hero ->
    // dispose chưa gán, revert không chạy, hero kẹt ẩn + unhandled rejection.
    // Regression: guard `typeof === 'function'` phải tồn tại — phần reveal bị
    // bỏ qua, hero vẫn animate, mounted hook không throw.
    vi.stubGlobal(
      'matchMedia',
      vi.fn<() => { matches: boolean }>().mockReturnValue({ matches: false }),
    );
    // Stub `undefined` thay vì tin môi trường: giá trị `undefined` bắt buộc
    // `typeof !== 'function'` — nếu guard bị xóa, dòng `new IntersectionObserver`
    // ném TypeError, catch chạy, console.error vang lên — assertion dưới đây bắt.
    vi.stubGlobal('IntersectionObserver', undefined);
    const errorSpy5 = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    const host = document.createElement('div');
    document.body.appendChild(host);
    // Spy `gsap.context` (bọc nguyên bản): lời gọi nó là tín hiệu init chạy
    // tới phần tạo timeline - callback của `gsap.context` thực thi trọn vẹn
    // trong cùng khối đồng bộ, đúng mẫu tín hiệu đồng bộ mà PR #190 dùng.
    const contextSpy = vi.spyOn(realGsap, 'context');
    const FullHero = defineComponent({
      setup() {
        const root = ref<HTMLElement>();
        useHomeMotion(root);
        return { root };
      },
      template: `<div ref="root">
        <p data-hero="eyebrow">e</p>
        <h1 data-hero="heading">H</h1>
        <p data-hero="description">d</p>
        <div data-hero="actions">a</div>
        <ul data-hero="proofs">p</ul>
        <section data-reveal>R</section>
      </div>`,
    });
    const wrapper = mount(FullHero, { attachTo: host });
    const heading = wrapper.get('[data-hero="heading"]');

    // GSAP vẫn tải và animate hero: inline style phải chứa thuộc tính motion
    // (autoAlpha -> visibility/opacity, timeline -> transform). Neo này phân
    // biệt với nhánh catch: nếu guard bị gỡ, TypeError rơi vào catch và
    // revert() xóa sạch style -> attribute chỉ còn chuỗi rỗng.
    //
    // Chờ INIT xong bằng tín hiệu xác định, không chờ playback của timeline
    // (Issue #339, cùng cơ chế flaky với #189 mà PR #190 đã sửa cho test anh
    // em): style của heading chỉ xuất hiện khi tween bắt đầu (t≈0.25s,
    // `immediateRender: false`), mà ticker rAF của jsdom bị lagSmoothing kẹp
    // còn 33ms/frame khi runner CI đầy tải - một `vi.waitFor` mặc định 1000ms
    // có thể hết giờ trước khi tiến trình GSAP tới 0.25s, đỏ dù logic đúng.
    // Thay vào đó: chờ lời gọi `gsap.context` (đồng bộ với việc tạo timeline),
    // rồi render timeline ĐỒNG BỘ qua `gsap.updateRoot(heroStart + 0.5)` - thời
    // điểm mọi hero tween chắc chắn đã bắt đầu, không phụ thuộc rAF.
    await waitForContextCall(contextSpy);
    // Render tới (thời điểm bắt đầu của timeline hero + 0.5s) trong hệ quy
    // chiếu globalTimeline: `gsap.timeline()` được auto-add vào globalTimeline
    // tại thời điểm HIỆN TẠI của ticker (không phải 0), nên render tới t tuyệt
    // đối cố định (0.5s) sẽ TRƯỚC cả khi tween heading bắt đầu (heroStart +
    // 0.25s) nếu ticker tiến triển trong lúc init. Giá trị heroStart đọc trực
    // tiếp từ timeline vừa tạo - không đoán, không phụ thuộc tốc độ runner.
    const heroTimeline = realGsap.globalTimeline.getChildren(false, false, true)[0];
    expect(
      heroTimeline,
      'hero timeline must be registered on the global timeline once gsap.context ran',
    ).toBeDefined();
    const heroStart = (heroTimeline as unknown as { startTime: () => number }).startTime();
    realGsap.updateRoot(heroStart + RENDER_TIME_SECONDS);
    expect(
      heading.attributes('style') ?? '',
      `${
        'hero heading must carry motion inline style after a synchronous render; ' +
        'an empty string means the init never ran (import or init swallowed) or ' +
        'the catch path reverted it - check the IntersectionObserver guard ' +
        'below, which must turn this assertion red if removed'
      }`,
    ).toMatch(/opacity|visibility|transform/u);
    // Guard đúng nghĩa là "phần reveal được bỏ qua" — không có lỗi nào được
    // ghi: nếu guard bị gỡ, `new IntersectionObserver` trên `undefined` ném
    // TypeError, catch chạy và console.error vang lên ở đây.
    expect(errorSpy5).not.toHaveBeenCalledWith(
      'home motion init failed; reverted',
      expect.anything(),
    );
    // Đủ macrotask để một rejection nào đó (nếu có) kịp nổi.
    for (let i = 0; i < 5; i += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
    expect(unhandled).toEqual([]);

    wrapper.unmount();
    document.body.removeChild(host);
    process.off('unhandledRejection', onUnhandled);
  });

  it('reverts inline style when the observer constructor throws after gsap.set', async () => {
    // Lớp phòng thủ cuối: constructor ném lỗi GIỮA CHỪNG callback (typeof đã
    // pass) — gsap.set đã ẩn hero, timeline đã tạo, dispose chưa gán. Không có
    // catch thì exception nổi khỏi gsap.context thành unhandled rejection và
    // không ai revert: hero kẹt visibility: hidden vĩnh viễn. Regression: neo
    // tại catch — revert phải chạy ngay để hero trở lại trạng thái SSR nhìn
    // thấy được, và lỗi phải được nuốt có chủ đích (không rejection nào nổi).
    vi.stubGlobal(
      'matchMedia',
      vi.fn<() => { matches: boolean }>().mockReturnValue({ matches: false }),
    );
    const boom = new Error('observer constructor exploded');
    // Function throwing khi được `new` — mô phỏng constructor ném lỗi giữa
    // chừng callback (typeof đã pass vì đây là function, không phải undefined).
    const ThrowingIntersectionObserver = function ThrowingIntersectionObserver(): void {
      throw boom;
    };
    vi.stubGlobal('IntersectionObserver', ThrowingIntersectionObserver);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const FullHero = defineComponent({
      setup() {
        const root = ref<HTMLElement>();
        useHomeMotion(root);
        return { root };
      },
      template: `<div ref="root">
        <p data-hero="eyebrow">e</p>
        <h1 data-hero="heading">H</h1>
        <p data-hero="description">d</p>
        <div data-hero="actions">a</div>
        <ul data-hero="proofs">p</ul>
        <section data-reveal>R</section>
      </div>`,
    });
    const wrapper = mount(FullHero, { attachTo: host });
    const heading = wrapper.get('[data-hero="heading"]');

    await vi.waitFor(() => {
      // Catch đã chạy: revert hoàn tác inline style của hero — không còn
      // visibility ẩn nào (thuộc tính style có thể rỗng hoặc bị gỡ hẳn).
      expect(heading.attributes('style') ?? '').not.toContain('visibility');
    });
    // Lỗi được nuốt có chủ đích trong catch — không rejection nào nổi ra ngoài.
    for (let i = 0; i < 5; i += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
    expect(unhandled).toEqual([]);

    wrapper.unmount();
    document.body.removeChild(host);
    process.off('unhandledRejection', onUnhandled);
  });

  it('hides only the revealables that start below the fold', async () => {
    // Nhấp nháy khi scroll: nếu trạng thái ẩn chỉ được set lúc observer bắn,
    // phần tử **đã nằm trong viewport** lúc init sẽ hiện → biến mất → fade lại.
    // Regression: chỉ phần tử dưới fold mới bị ẩn sớm; phần tử trong viewport
    // giữ nguyên nội dung SSR đang hiển thị.
    vi.stubGlobal(
      'matchMedia',
      vi.fn<() => { matches: boolean }>().mockReturnValue({ matches: false }),
    );
    // jsdom không có layout engine: `getBoundingClientRect` trả 0 cho mọi phần
    // tử và `innerHeight` = 768, nên cần stub để dựng "trong viewport" (top
    // nhỏ hơn innerHeight) và "dưới fold" (top lớn hơn). Stub đọc `id` nên
    // dùng được cả trước lúc mount (init chạy trong `onMounted` + await GSAP).
    vi.stubGlobal('innerHeight', 768);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function getRect(
      this: Element,
    ) {
      const top = this.id === 'below-fold' ? 5000 : 100;
      return { top, bottom: top + 50, left: 0, right: 0, width: 0, height: 50 } as DOMRect;
    });
    // Cả hai phần tử đều được quan sát.
    const observed: Element[] = [];
    class FakeIntersectionObserver {
      observe = vi.fn<(target: Element) => void>((target: Element) => {
        observed.push(target);
      });
      unobserve = vi.fn<() => void>();
      disconnect = vi.fn<() => void>();
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const TwoRevealables = defineComponent({
      setup() {
        const root = ref<HTMLElement>();
        useHomeMotion(root);
        return { root };
      },
      template: `<div ref="root">
        <p data-hero="eyebrow">e</p>
        <h1 data-hero="heading">H</h1>
        <p data-hero="description">d</p>
        <div data-hero="actions">a</div>
        <ul data-hero="proofs">p</ul>
        <section data-reveal id="in-view">R1</section>
        <section data-reveal id="below-fold">R2</section>
      </div>`,
    });
    const wrapper = mount(TwoRevealables, { attachTo: host });
    const inView = wrapper.get('#in-view').element as Element;
    const below = wrapper.get('#below-fold').element as Element;

    await vi.waitFor(() => {
      expect(observed).toHaveLength(2);
    });

    // Phần tử dưới fold bị ẩn sớm (đã set autoAlpha 0 lúc init) — đó là điều
    // kiện để observer bắn lần đầu sẽ chỉ tăng dần lên, không nhấp nháy.
    expect(below.getAttribute('style') ?? '').toContain('opacity');
    // Phần tử đã nằm trong viewport lúc init giữ nguyên nội dung SSR đang
    // hiện — không có inline style nào bị set.
    expect(inView.getAttribute('style')).toBeNull();
    wrapper.unmount();
    document.body.removeChild(host);
  });

  it('keeps the hero visible when the GSAP chunk fails to load', async () => {
    // `await import('gsap')` là async: chunk tải lỗi (offline, hashed asset cũ
    // sau deploy) thì promise reject NGAY TẠI DÒNG ĐÓ. Trước fix, lỗi này
    // nằm ngoài mọi try/catch nên nổi thành unhandled rejection — trái với
    // contract của module ("motion chỉ là cải tiến, không được hỏng trang").
    // Regression: import lỗi phải bị nuốt, không motion, trang vẫn đọc được.
    vi.stubGlobal(
      'matchMedia',
      vi.fn<() => { matches: boolean }>().mockReturnValue({ matches: false }),
    );
    vi.doMock('gsap', () => {
      throw new Error('chunk load failed');
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const TestComponent = defineComponent({
      setup() {
        const root = ref<HTMLElement>();
        useHomeMotion(root);
        return { root };
      },
      template: `<div ref="root">
        <p data-hero="eyebrow">e</p>
        <h1 data-hero="heading">H</h1>
        <p data-hero="description">d</p>
        <div data-hero="actions">a</div>
        <ul data-hero="proofs">p</ul>
      </div>`,
    });
    const wrapper = mount(TestComponent, { attachTo: host });
    const heading = wrapper.get('[data-hero="heading"]');

    // Cho mọi promise settle rồi đảm bảo không có rejection nào nổi ra ngoài.
    for (let i = 0; i < 5; i += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
    expect(unhandled).toEqual([]);
    // Nội dung SSR của hero phải còn nguyên, không bị ẩn: chunk lỗi thì bỏ
    // motion, KHÔNG được để trang trắng.
    expect(heading.text()).toBe('H');
    expect(heading.attributes('style') ?? '').not.toContain('visibility');
    expect(wrapper.get('[data-hero="proofs"]').text()).toBe('p');

    wrapper.unmount();
    document.body.removeChild(host);
    process.off('unhandledRejection', onUnhandled);
  });

  it('never sets the hero hidden outside the fade-in tween', async () => {
    // Nhấp nháy khi tải trang: dynamic import xảy ra SAU khi trình duyệt đã paint
    // HTML SSR. Nếu init gọi `gsap.set(hero, { autoAlpha: 0 })` thì hero bật
    // biến mất đột ngột rồi fade lại — tệ nhất khi mạng chậm. Regression: KHÔNG
    // có call `gsap.set` nào chạm hero; hero chỉ được ẩn bởi chính tween
    // `fromTo` lúc nó bắt đầu chạy.
    //
    // Spy trực tiếp lên instance `gsap` thật đã import ở top-level — KHÔNG
    // dùng `vi.doMock`: đăng ký mock là state dùng chung của cả file, nên
    // factory ném lỗi của test "chunk fails to load" có thể còn hiệu lực và
    // làm `await import('gsap')` throw — code catch rồi return sớm, spy rỗng
    // mà không có lỗi nào lộ ra (flake). Instance thật không bị registry đụng.
    vi.stubGlobal(
      'matchMedia',
      vi.fn<() => { matches: boolean }>().mockReturnValue({ matches: false }),
    );
    const setCalls: { target: unknown; vars: Record<string, unknown> }[] = [];
    const fromToCalls: { vars: Record<string, unknown> }[] = [];
    const setSpy = vi
      .spyOn(realGsap, 'set')
      .mockImplementation((target: unknown, vars: Record<string, unknown>) => {
        setCalls.push({ target, vars });
        // `gsap.set` trả về Tween; jsdom không có layout engine nên tween trả
        // về không được dùng ở đây — trả tween rỗng để thoả kiểu.
        return {} as ReturnType<typeof realGsap.set>;
      });
    // Trả về object rỗng: `home-motion` đưa kết quả `fromTo` vào
    // `timeline.add(...)`, và timeline thật chỉ giữ tween đầu tiên nên các
    // tween sau không được giữ lại — nhưng ở đây ta chỉ cần `fromTo` được
    // GỌI, không cần timeline thật chạy (jsdom không có layout engine).
    const fromToSpy = vi
      .spyOn(realGsap, 'fromTo')
      .mockImplementation((_t: unknown, _f: unknown, to: Record<string, unknown>) => {
        fromToCalls.push({ vars: to });
        return {} as ReturnType<typeof realGsap.fromTo>;
      });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const TestComponent = defineComponent({
      setup() {
        const root = ref<HTMLElement>();
        useHomeMotion(root);
        return { root };
      },
      template: `<div ref="root">
        <p data-hero="eyebrow">e</p>
        <h1 data-hero="heading">H</h1>
        <p data-hero="description">d</p>
        <div data-hero="actions">a</div>
        <ul data-hero="proofs">p</ul>
        <section data-reveal>R</section>
      </div>`,
    });
    const wrapper = mount(TestComponent, { attachTo: host });

    await vi.waitFor(() => {
      expect(fromToCalls.length).toBeGreaterThan(0);
    });

    // `gsap.set` chỉ được phép dùng cho phần tử `data-reveal` dưới fold, và
    // phải là mảng Element thật — không được nhắm vào hero. Trước fix, hero bị
    // ẩn bằng chính `gsap.set(heroTargets, { autoAlpha: 0 })`.
    const heroHiddenBySet = setCalls.filter(
      (call) => String(call.vars['autoAlpha']) === '0' && Array.isArray(call.target),
    );
    expect(heroHiddenBySet).toEqual([]);
    // Mọi tween hero phải là `fromTo` với `immediateRender: false` — nếu
    // không, `fromTo` mặc định render trạng thái `from` ngay lúc khởi tạo và
    // tween trễ sau sẽ đè lên tween trước đã chạy.
    expect(fromToCalls).toHaveLength(5);
    for (const call of fromToCalls) {
      expect(call.vars['immediateRender']).toBe(false);
    }

    setSpy.mockRestore();
    fromToSpy.mockRestore();
    wrapper.unmount();
    document.body.removeChild(host);
  });
});
