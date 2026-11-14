import { chromium, request, type FullConfig, type Page } from '@playwright/test';

import {
  describeBrowserSession,
  emptyBrowserSessionLog,
  summarizeBrowserSession,
  watchBrowserSession,
  type BrowserSessionLog,
} from './support/diagnostics';
import { PROTOTYPE_ROUTES, waitForRouteReady } from './support/prototype';
import { gotoWithReloadRetry, remainingWarmUpMs, warmUpCapMs } from './support/warm-up';

/**
 * Nóng năm route prototype **trước** khi chạy test, theo hai vế khác nhau.
 *
 * Việc này không phải để "che" lỗi: nó tách "app còn đang khởi động" khỏi "app
 * thật sự có lỗi". Setup fail-loud: server không lên, hoặc route trả sai mã, là
 * **mọi** test dừng với lý do rõ ràng thay vì 100+ lần timeout mơ hồ.
 *
 * Hai vế là hai cách khác nhau để `nuxt dev` làm đỏ một test vô can:
 *
 * 1. `assertRoutesRespond` — lần GET đầu tiên của mỗi route phải chịu JIT compile
 *    server bundle, có thể mất hàng chục giây.
 * 2. `warmUpBrowserClient` — Vite pre-bundle dependency **theo lượt tải đầu tiên
 *    của browser**, không theo HTTP request. Khi phát hiện dependency mới lúc
 *    runtime, dev server gửi `full-reload` để client tự tải lại trang; lần reload
 *    đó huỷ navigation đang bay. Đã đo được trên CI: `page.goto('/staff')` đỏ với
 *    `net::ERR_ABORTED`, và 116 ms sau browser tự GET lại `/` — đúng trang đang
 *    mở, tức dev server thay trang chứ app không trả lỗi.
 *
 * Vế 1 không chạm tới cơ chế của vế 2: request context không tải module client nên
 * không kích hoạt pre-bundle. Đo lại ở local với cache dependency nguội (xoá
 * `apps/backoffice/node_modules/.cache/vite/client/deps`): không warm-up browser
 * thì reload buộc rơi vào **giữa** giai đoạn test — bản ghi document là `/`, `/`
 * (cái đầu `net::ERR_ABORTED`) rồi `/staff`; có warm-up browser thì nó rơi hết vào
 * giai đoạn warm-up và giai đoạn test chỉ còn đúng năm lần điều hướng (mỗi route
 * một lần, khớp `PROTOTYPE_ROUTES`), không lần nào bị huỷ.
 *
 * ⚠️ Reload có thể rơi **giữa một lần `page.goto` của chính warm-up** — đúng race
 * mà vế 2 tồn tại để "ăn", nhưng chưa từng được bảo vệ: CI đỏ thật với
 * `net::ERR_ABORTED` tại `warmUpBrowserClient` (issue #224, run 40100840085).
 * Vì vậy navigation ở đây đi qua `gotoWithReloadRetry`: bắt abort do reload rồi
 * thử lại, giới hạn bởi cùng trần warm-up (`warmUpCapMs`) với `waitForDevServerToSettle`.
 * Chỉ lỗi abort-due-to-reload được nuốt; lỗi thật (server sập, mất mạng) vẫn
 * được đẩy lên ngay.
 *
 * Giới hạn, nói thẳng: đây là **dời** một sự kiện của dev server ra trước khi test
 * chạy, không phải làm cho race đó thành bất khả. Cache dependency đã nóng thì
 * không có reload nào cả, nên vế 2 gần như miễn phí.
 */

/**
 * Bao lâu không có document request mới thì coi như dev server đã thôi thay trang.
 *
 * Đo được: reload buộc tới khoảng 0.4s sau lần tải đầu ở local và ~2.6s trên CI,
 * nên warm-up năm route (vài giây) thường đã "ăn" luôn nó; con số này chỉ là
 * khoảng lặng xác nhận ở cuối.
 */
const QUIET_MS = 3_000;

/**
 * Trần chờ của vế warm-up browser.
 *
 * Nguồn chân lý của con số là `warmUpCapMs` trong `support/warm-up.ts` (kèm số đo
 * local lẫn CI); `globalSetup` chỉ quyết định **môi trường nào** (`process.env.CI`
 * — cùng công tắc mà `playwright.config.ts` dùng cho `reuseExistingServer`) rồi
 * truyền phần trần còn lại qua tham số cho từng chỗ chờ. Không nhân bản hằng số ở
 * đây nữa: hai bản sao (trong `global-setup.ts` và `support/warm-up.ts`) phải đổi
 * tay với nhau nhưng không có gì buộc chúng khớp.
 */

/**
 * Vế 1 — kiểm server đã lên và mọi route trả 200.
 *
 * Chạy trước vế 2 để lỗi "server chưa lên / route 500" đọc được ngay, thay vì đội
 * lốt thành một lần timeout của locator trong vế browser.
 */
async function assertRoutesRespond(baseURL: string): Promise<void> {
  const context = await request.newContext({
    baseURL,
    // Chờ server `nuxt dev` JIT-compile mỗi route trong lần GET đầu tiên.
    // CI có thể chậm hơn đáng kể so với local; 120s đủ bảo vệ khỏi timeout không
    // liên quan đến hành vi UI, nhưng vẫn hạn chế hơn webServer.timeout (180s).
    timeout: 120_000,
  });

  try {
    for (const route of PROTOTYPE_ROUTES) {
      const response = await context.get(route.path);

      if (response.status() !== 200) {
        throw new Error(
          `Route ${route.path} trả HTTP ${response.status()} khi khởi động server test (mong đợi 200).`,
        );
      }
    }
  } finally {
    await context.dispose();
  }
}

/**
 * Vế 2 — tải đủ năm route bằng browser thật để Vite pre-bundle xong dependency
 * client, rồi chờ dev server thôi thay trang.
 *
 * `page.goto` bọc bởi `gotoWithReloadRetry`: reload của dev server có thể huỷ
 * đúng navigation đang bay (đo được trên CI, issue #224), và warm-up là nơi cần
 * chịu lỗi đó thay vì để nó đỏ cả `globalSetup`.
 *
 * Viewport mặc định (1280×720, bằng `Desktop Chrome`) là nhánh desktop của shell —
 * đúng nhánh mà suite chạy.
 */
async function warmUpBrowserClient(baseURL: string): Promise<void> {
  const browser = await chromium.launch();

  // Một trần tổng cho cả vế browser: mỗi chỗ chờ nhận phần trần **còn lại** của
  // vế, chứ không phải một trần riêng full — nếu mỗi chờ có trần độc lập thì tổng
  // thời gian warm-up không có biên biết trước (đó là một trong hai lỗ hổng của
  // #239: `waitForRouteReady` không truyền timeout nên rơi về 30s mặc định của
  // Playwright, ngoài tầm với của trần warm-up).
  // Dùng đúng công tắc truthiness của `playwright.config.ts` (`!!process.env.CI`,
  // `!process.env.CI`): `CI=false` **không** phải cờ tắt CI được hỗ trợ trong repo
  // — GitHub Actions đặt `CI=true`, local để trống. Một predicate `=== 'true'` sẽ
  // tách trần warm-up khỏi phần còn lại của cấu hình (`forbidOnly`, `reporter`,
  // `reuseExistingServer` vẫn coi `'false'` là CI), đúng loại lệch cấu hình mà
  // #239 gây ra.
  const capMs = warmUpCapMs(Boolean(process.env.CI));
  const phaseStart = Date.now();
  const elapsedMs = (): number => Date.now() - phaseStart;
  const remainingMs = (stage: string): number => remainingWarmUpMs({ capMs, phaseStart, stage });

  // Khai ngoài `try` để nhánh `catch` còn đọc được trang lúc fail: chẩn đoán
  // #253 chỉ có giá trị nếu nó chạy trên **chính** page đã hỏng.
  let page: Page | undefined;
  let session: BrowserSessionLog | undefined;

  try {
    page = await browser.newPage({ baseURL });
    // Gắn listener **trước** navigation đầu tiên: Playwright chỉ phát sự kiện
    // phát sinh sau thời điểm đăng ký, và toàn bộ bằng chứng cần cho #253 nằm ở
    // giai đoạn mount đầu tiên của `/`.
    session = watchBrowserSession(page, phaseStart);

    // Log đo theo route: bằng chứng trần đủ/chưa đủ nằm ngay trong output của job
    // CI (điều kiện hoàn thành của issue #239), không phải phải chạy lại có đo.
    console.log(
      `[warm-up] browser phase cap: ${String(capMs)} ms (${process.env.CI ? 'CI' : 'local'} cap)`,
    );

    for (const route of PROTOTYPE_ROUTES) {
      const routeStart = Date.now();
      await gotoWithReloadRetry(page, route.path, {
        capMs: remainingMs(`navigation to ${route.path}`),
      });
      const gotoMs = Date.now() - routeStart;

      // Tính timeout **trước** `try`: hết ngân sách phải nổi lên đúng lỗi
      // "budget exhausted" của `remainingWarmUpMs`, không bị catch bên dưới
      // bọc lại thành "route không sẵn sàng" — hai nguyên nhân khác nhau.
      const readyTimeoutMs = remainingMs(`ready signal of ${route.path}`);

      try {
        await waitForRouteReady(page, route.path, readyTimeoutMs);
      } catch (cause) {
        // Đo được trên merge queue: cấu hình thiếu làm route **không** sẵn sàng,
        // và lỗi gốc (`waiting for getByTestId('backoffice-sample-notice')`) không
        // nói lý do — đọc như một flake của `nuxt dev` thay vì một gate bị tắt.
        // Nói thêm phần trần còn lại: một lượt chờ hết trần phải đọc ra là "hết
        // ngân sách warm-up", không phải "route hỏng" — hai nguyên nhân khác nhau.
        throw new Error(
          `${route.path} không sẵn sàng sau khi warm-up (đã dùng ${String(Date.now() - phaseStart)} ms / trần ${String(capMs)} ms). Bộ test này chỉ kiểm bề mặt prototype, còn dev server phải chạy với NITRO_PUBLIC_BACKOFFICE_DATA_MODE=prototype (đặt trong playwright.config.ts). Nếu chế độ đó tắt, app render trạng thái unavailable: không fixture và không banner backoffice-sample-notice — đây là cấu hình, không phải app.`,
          { cause },
        );
      }

      // Không dùng `remainingMs()` ở đây: chỉ để **log** phần còn lại, không được
      // ném "budget exhausted" sau khi route vừa sẵn sàng thành công. Lượt chờ kế
      // tiếp vẫn sẽ ném đúng lỗi đó nếu trần đã cạn.
      console.log(
        `[warm-up] ${route.path} ready in ${String(Date.now() - routeStart)} ms (goto ${String(gotoMs)} ms, ${String(Math.max(capMs - elapsedMs(), 0))} ms of cap left)`,
      );
    }

    await waitForDevServerToSettle(page, remainingMs('dev server settle'));
    // Một dòng chứng minh instrumentation đã chạy; không in chi tiết khi xanh.
    console.log(summarizeBrowserSession(session));
    console.log(`[warm-up] browser phase finished in ${String(Date.now() - phaseStart)} ms`);
  } catch (cause) {
    // Chẩn đoán chỉ in ở đường thất bại (issue #253): lần đỏ kế tiếp phải tự nói
    // ra document có phải app ở mode prototype không, data mode client đọc được
    // là gì, và client có mount hay không — thay vì một dòng timeout mơ hồ.
    // Lỗi gốc luôn được ném tiếp: chẩn đoán không được che nguyên nhân.
    if (page !== undefined) {
      try {
        // `session === undefined` nghĩa là chính `watchBrowserSession` đã hỏng;
        // dùng log rỗng để phần đọc trang vẫn in ra, thay vì mất toàn bộ chẩn
        // đoán đúng lúc instrumentation là thứ cần chẩn đoán.
        const diagnosticsSession = session ?? emptyBrowserSessionLog(phaseStart);
        console.error(await describeBrowserSession(page, diagnosticsSession, { capMs }));
      } catch {
        // Chẩn đoán tự lỗi (trang đã đóng, unresponsive) thì bỏ qua phần chẩn
        // đoán, không thay thế lỗi warm-up gốc bằng lỗi của chính nó.
      }
    }

    throw cause;
  } finally {
    await browser.close();
  }
}

/**
 * Chờ tới khi hết document request mới trong `QUIET_MS`.
 *
 * Không có cờ nào trên trang nói "đã reload xong": lần reload thay cả document nên
 * mọi tín hiệu của trang cũ đều biến mất. Bằng chứng duy nhất còn lại là **im
 * lặng** — không document request nào nữa. Khi cache dependency đã nóng, lần chờ
 * duy nhất này là toàn bộ chi phí của vế warm-up browser.
 *
 * Trần của vòng chờ là **phần còn lại** của trần warm-up (`capMs` từ caller),
 * không phải một trần độc lập: tổng thời gian vế browser giữ nguyên một biên.
 *
 * Vượt trần thì báo lỗi thay vì đi tiếp: server thay trang liên tục là
 * bất thường, và chạy test trên server như vậy chỉ tạo ra đỏ khó đọc.
 */
async function waitForDevServerToSettle(page: Page, capMs: number): Promise<void> {
  const deadline = Date.now() + capMs;

  while (Date.now() < deadline) {
    // `waitForRequest` là event-driven: không có sleep cố định ở đường đi thường,
    // `QUIET_MS` chỉ là ngưỡng để kết luận "không còn gì tới nữa".
    const reload = await page
      .waitForRequest((req) => req.resourceType() === 'document', { timeout: QUIET_MS })
      .catch(() => null);

    if (reload === null) {
      return;
    }

    await page.waitForLoadState('load');
  }

  throw new Error(
    `Dev server vẫn thay trang sau ${String(capMs)} ms warm-up — dừng suite thay vì chạy test trên server không ổn định.`,
  );
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use?.baseURL;

  if (baseURL === undefined) {
    throw new Error(
      'Không tìm thấy baseURL trên project Playwright đầu tiên — webServer chưa khởi động được.',
    );
  }

  await assertRoutesRespond(baseURL);
  await warmUpBrowserClient(baseURL);
}
