/**
 * `GET /internal/account/status?sub=` — contract mà `account` **phục vụ**, `auth` là
 * consumer (FR-011a, `01-architecture.md` §5).
 *
 * ## Hướng gọi
 *
 * `account` là **provider** của contract này, không phải consumer. Ba contract
 * back-channel mà `account` đẩy đi thuộc hướng ngược lại; route này tồn tại ở đây
 * vì `account` là bên sở hữu trạng thái account.
 *
 * ## Đây là INTERNAL endpoint, không phải BFF
 *
 * ⚠️ Đây là chỗ dễ sai nhất của contract, nên nói rõ:
 * - **Không** đọc subject từ session — `sub` là **tham số tra cứu** (FR-011c).
 * - **Không** đọc cookie. Endpoint này xác thực bằng envelope HMAC, không bằng cookie
 *   browser (SR-010). Middleware `server/middleware/internal-auth.ts` đã kiểm trước
 *   khi handler này chạy; đọc cookie ở đây sẽ mở đúng lớp lỗi mà §5.1 của
 *   `01-architecture.md` cảnh báo.
 * - Endpoint này **không** xác nhận "phiên trình `sub` này có thật" (FR-011f). Nó
 *   chỉ trả trạng thái của một account; suy ra phiên từ đây là đường xác thực giả và
 *   bị review chặn.
 *
 * ## Vì sao chỉ trả một trường
 *
 * FR-011b: không email, không tên, không profile, không trường định danh nào. Response
 * đi qua mọi access log và proxy giữa `auth` và `account`, và `account` không kiểm
 * soát được chúng. `accountStatusResponse` là hàm **dựng** response nên không có cách
 * nào dựng tay kèm hồ sơ; `validateAccountStatusResponse` là lớp phòng thủ thứ hai cho
 * payload đã đi qua `JSON.parse`.
 */
import { createError, defineEventHandler, getQuery, setResponseHeader } from 'h3';

import {
  accountStatusResponse,
  validateAccountStatusResponse,
  type AccountStatusResponseValue,
} from '@ecoma-io/account-contracts';
import { isAccountStatus, isSubject } from '@ecoma-io/account-domain';

import { accountHyperdrive } from '../../../utils/bindings';
import { selectAccountStatus, withRequestPool } from '../../../utils/db';
import { writeLog } from '../../../utils/logger';

/**
 * Ánh xạ trạng thái trong DB sang giá trị contract.
 *
 * `not_found` **không phải** lỗi: nó là một trong bốn giá trị hợp lệ của contract
 * (`account-status-contract.ts`). Trả `not_found` như lỗi riêng (404, body khác)
 * sẽ tạo thêm một oracle đo sự tồn tại của account — đúng cái mà FR-011b cấm.
 *
 * ⚠️ FR-011d: `not_found` và `deleted` đều dẫn tới cùng một kết quả phát hành ở phía
 * `auth` (không cấp token). Phân biệt chúng **không mang lại giá trị** cho consumer, và
 * giữ cả hai là quyết định có chủ đích — không phải sơ suất.
 *
 * @param rowStatus Giá trị `status` đọc từ `users`, hoặc `null` khi không có row.
 */
export function toContractStatus(rowStatus: string | null): AccountStatusResponseValue {
  if (rowStatus === null) {
    return 'not_found';
  }
  // Trạng thái lạ trong DB (viết bởi một migration sai, hoặc tay) không được đi
  // thẳng vào response: contract chỉ có bốn giá trị, nên giá trị lạ trả về
  // `not_found` — fail closed, cùng kết quả phát hành với `deleted`.
  return isAccountStatus(rowStatus) ? rowStatus : 'not_found';
}

export default defineEventHandler(async (event) => {
  // FR-011e: response này là authority, không được bất kỳ tầng cache nào giữ lại.
  setResponseHeader(event, 'Cache-Control', 'no-store');

  const query = getQuery(event);
  const rawSub = query.sub;

  // `getQuery` trả `string | string[]` — param lặp lại cho ra mảng. Mảng không phải
  // `sub` hợp lệ, và việc chấp nhận phần tử đầu sẽ tạo đường né kiểm tra: caller ký
  // một `sub` nhưng đọc được một `sub` khác.
  const sub = Array.isArray(rawSub) ? undefined : rawSub;

  // `isSubject` kiểm đúng định dạng `sub_` + 32 ký tự base32. Trả 400 chứ không trả
  // `not_found`: đây là **lỗi của caller**, không phải một account không tồn tại, và
  // hai thứ đó là hai sự kiện khác nhau.
  if (typeof sub !== 'string' || !isSubject(sub)) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request' });
  }

  // `useRuntimeConfig(event)` — truyền `event` như middleware: trên Workers,
  // binding của request đến từ env của Worker và Nitro nối nó vào runtime config
  // theo event; bỏ `event` là đọc một config không gắn với request hiện tại.
  const hyperdrive = accountHyperdrive(useRuntimeConfig(event));
  if (!hyperdrive) {
    // Fail closed: contract này là control point lúc `auth` phát hành, nên không trả
    // lời thì `auth` không phát hành (đúng failure mode §8). Trả `not_found` ở đây
    // sẽ **không** fail closed — nó biến "không kiểm tra được" thành "không có
    // account", và hai thứ đó khác nhau về hành vi.
    writeLog({ event: 'account_status.failed', status: 503, reason: 'binding_missing', sub });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  // FR-011e: đọc trực tiếp từ `db-account` ở **mỗi** lần gọi — không projection
  // cache, không stale read. Một account bị suspend phải phản ánh ngay ở lần gọi kế
  // tiếp, vì `auth` hỏi đúng lúc phát hành token.
  //
  // `withRequestPool` `end()` pool trong `finally`, kể cả khi `selectAccountStatus`
  // ném — bỏ điều đó là rò connection tới khi pool cạn, và pool cạn là toàn bộ
  // endpoint DB chết.
  let rowStatus: string | null;
  try {
    rowStatus = await withRequestPool(hyperdrive, (pool) => selectAccountStatus(pool, sub));
  } catch {
    // Không nối `error` vào log: message của driver có thể chứa connection string.
    writeLog({ event: 'account_status.failed', status: 503, reason: 'db_unreachable', sub });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  const payload = accountStatusResponse(toContractStatus(rowStatus));

  // FR-011b ở tầng trước khi response rời Worker. `validateAccountStatusResponse` trả
  // `{ ok: false }` khi có trường định danh lọt vào, và khi đó response phải **không**
  // được gửi — chứ ta vừa dựng bằng hàm an toàn nên đây là lưới an toàn, và trả 500
  // đúng hơn là gửi một payload đã vi phạm contract.
  const validation = validateAccountStatusResponse(payload);
  if (!validation.ok) {
    // `reason` là mã ổn định để điều tra; không nối `detail` vì đó là thông báo hướng
    // người đọc trong lúc runtime.
    writeLog({
      event: 'account_status.invalid_response',
      status: 500,
      reason: validation.reason,
      sub,
    });
    throw createError({ statusCode: 500, statusMessage: 'Internal Server Error' });
  }

  // SR-010: audit **mỗi** lần đọc theo `sub`. `sub` là opaque identifier, không phải
  // bí mật (`account-domain/src/subject.ts`), nên nó được phép trong log — nó chính là
  // thứ nối dòng log này với một account.
  writeLog({ event: 'account_status.read', status: 200, sub });

  return validation.payload;
});
