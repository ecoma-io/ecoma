/**
 * `GET /ready` — readiness, **có** kiểm phụ thuộc.
 *
 * ## Phân biệt với `/health` — đây là điểm cốt lõi của cả hai route
 *
 * | Route      | Hỏi gì                                      | Hỏi DB không | Khi hỏng thì ai hành xử     |
 * | ---------- | ------------------------------------------- | ------------ | -------------------------- |
 * | `/health`  | Worker có sống không                         | **Không**    | Orchestrator restart Worker |
 * | `/ready`   | Worker có phục vụ **request thật** được không | **Có**       | Orchestrator ngừng traffic mới |
 *
 * ⚠️ **Vì sao `/health` không query DB.** Nếu liveness phụ thuộc DB thì DB chết ⇒
 * `/health` lỗi ⇒ orchestrator restart Worker ⇒ Worker mới lại hỏi DB vẫn chết ⇒
 * **restart loop vô ích**, vừa tăng tải lên database đang chết vừa che mất nguyên nhân
 * thật. Nguyên nhân thật theo `03-operations.md` §8 là `db-account` hỏng, và restart
 * Worker không sửa được cái đó. Vì vậy `/health` chỉ chứng minh Worker đã khởi động
 * và config đã hợp lệ (`server/plugins/config.ts` fail-closed lúc boot).
 *
 * ⚠️ **Vì sao `/ready` thì fail closed.** Đây là control point của identity: khi
 * `db-account` không trả lời được thì `auth` **không phát hành** token mới
 * (`03-operations.md` §8, failure mode đầu tiên). `account` phải báo "không sẵn
 * sàng" chứ không báo "sẵn sàng rồi nhưng có thể lỗi" — một readiness trả về đúng
 * trong khi DB chết là đẩy failure xuống thành lỗi 503 rải rác ở từng request, và
 * lúc đó `auth` đã hỏi status rồi mới biết. Fail closed ở readiness rút sự kiện đó
 * về đúng chỗ nó thuộc về.
 *
 * ⚠️ Readiness **không** log chi tiết lỗi DB ra response: response đi qua mạng công
 * cộng, còn log đi qua đường nội bộ có kiểm soát. Response chỉ nói "không sẵn sàng";
 * nguyên nhân nằm ở log với mã ổn định.
 */
import type { Hyperdrive } from '@cloudflare/workers-types';
import { createError, defineEventHandler } from 'h3';

import { accountHyperdrive } from '../utils/bindings';
import { createPool, selectAccountStatus } from '../utils/db';
import {
  DATA_MODE_MOCK_IN_ARTIFACT_REASON,
  resolveServerDataMode,
} from '../utils/data-mode-server';
import { writeLog } from '../utils/logger';

/**
 * Pool dùng cho **một** lần kiểm readiness.
 *
 * ⚠️ Không giữ pool ở module scope: đó là state sống lâu hơn một request và phụ thuộc
 * vòng đời isolate — loại state mà non-negotiable architecture cấm. Một lần kiểm là
 * một pool, đóng lại ngay: chi phí kết nối là đổi lại không giữ state.
 *
 * Pool dựng qua {@link createPool} — factory duy nhất của `utils/db` — nên luôn
 * có listener `error` cho idle client. Dựng tay `new Pool(...)` ở đây là bỏ qua
 * listener đó: pg-pool phát `error` khi Hyperdrive đóng idle connection (HD10),
 * và không có listener là crash isolate — đúng lúc `/ready` đang chạy, tức lúc
 * origin đang flapping.
 */
async function probeDatabase(hyperdrive: Hyperdrive): Promise<void> {
  const pool = createPool(hyperdrive);
  try {
    // Truy vấn rẻ nhất vẫn phải chạm DB. Dùng lại `selectAccountStatus` với một
    // `sub` không thể là subject thật (`isSubject` yêu cầu `sub_` + 32 ký tự) nên
    // nó luôn trả `null` — probe chỉ cần chứng minh bảng tồn tại và đọc được, không
    // cần một round-trip `SELECT 1` riêng. `users` không tồn tại thì probe **phải**
    // thất bại, vì lúc đó app không phục vụ được request nào.
    await selectAccountStatus(pool, 'probe-readiness');
  } finally {
    await pool.end();
  }
}

export default defineEventHandler(async (event) => {
  // `useRuntimeConfig(event)` — truyền `event` như middleware và route status: trên
  // Workers, binding của request đến từ env của Worker và Nitro nối nó vào runtime
  // config theo event; bỏ `event` là đọc một config không gắn với request hiện tại.
  const runtimeConfig = useRuntimeConfig(event);
  const hyperdrive = accountHyperdrive(runtimeConfig);

  // Gate DATA_MODE — lớp readiness của fail-closed: artifact bị cấu hình `mock`
  // là không phục vụ được request nào với nguồn dữ liệu người đặt biến mong muốn
  // (mock), nên báo "không sẵn sàng" chứ không chạy thật dưới danh mock. Cùng
  // cấu trúc với nhánh `binding_missing`: log reason ổn định, response không
  // lộ chi tiết. Dưới `nuxt dev` mode mock là hợp lệ — nhánh không chạy.
  const serverMode = resolveServerDataMode(
    (runtimeConfig.public as Record<string, unknown> | undefined)?.accountDataMode,
    import.meta.dev,
  );
  if (serverMode.kind === 'real' && serverMode.mockInArtifact) {
    writeLog({
      event: 'ready.failed',
      status: 503,
      reason: DATA_MODE_MOCK_IN_ARTIFACT_REASON,
    });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  if (!hyperdrive) {
    // Thiếu binding ⇒ fail closed, giống hệt DB chết: app không phục vụ được request
    // nào chứ không phải "chạy được một phần".
    writeLog({ event: 'ready.failed', status: 503, reason: 'binding_missing' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  try {
    await probeDatabase(hyperdrive);
  } catch {
    // KHÔNG nối `error` vào log: message của lỗi driver có thể chứa connection string.
    // Chỉ ghi mã ổn định, đủ để phân loại sự cố.
    writeLog({ event: 'ready.failed', status: 503, reason: 'db_unreachable' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  writeLog({ event: 'ready.ok', status: 200 });
  return { status: 'ready' };
});
