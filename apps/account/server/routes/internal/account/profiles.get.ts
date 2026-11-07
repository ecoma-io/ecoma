/**
 * `GET /internal/account/profiles?subs=<sub1,sub2,...>` — contract mà `account`
 * **phục vụ**, `backoffice` là consumer (issue #325, giai đoạn 1;
 * `docs/applications/account/01-architecture.md` §5).
 *
 * ## Đây là INTERNAL endpoint, không phải BFF
 *
 * Giống `internal/account/status`: xác thực bằng envelope HMAC qua
 * `server/middleware/internal-auth.ts` (chạy trước handler khi route nằm dưới
 * `/internal/`), **không** đọc cookie, **không** đọc session. `subs` là **tham số
 * tra cứu** do service gọi thẳng, không phải thuộc tính của người gọi.
 *
 * ## Ý nghĩa dữ liệu trả về
 *
 * `displayName: null` là giá trị hợp lệ ("chưa đặt tên"), không phải lỗi — giống
 * cách `not_found` của contract `status` là giá trị trong body chứ không phải 404.
 * Endpoint **không** phân biệt "chưa có row profile" với "row có display_name NULL":
 * cả hai đều là null, vì với consumer hai thứ đó như nhau.
 *
 * ## Ràng buộc batch
 *
 * Trần 100 `sub` sau khi dedupe. Vượt trần hoặc `subs` sai định dạng là **lỗi của
 * caller** (400), không phải dữ liệu không tìm thấy — hai sự kiện khác nhau, cùng
 * cách phân biệt với `status` khi `isSubject` trả `false`.
 */
import { createError, defineEventHandler, getQuery, setResponseHeader } from 'h3';

import {
  ACCOUNT_PROFILES_MAX_SUBS,
  accountProfilesResponse,
  dedupeProfileSubs,
  validateAccountProfilesResponse,
} from '@ecoma-io/account-contracts';
import { isSubject } from '@ecoma-io/account-domain';

import { accountHyperdrive } from '../../../utils/bindings';
import { selectDisplayNames, withRequestPool } from '../../../utils/db';
import { writeLog } from '../../../utils/logger';

export default defineEventHandler(async (event) => {
  // Response mang hồ sơ người dùng qua mọi proxy trung gian — không tầng cache nào
  // được giữ lại (same reasoning as `internal/account/status`).
  setResponseHeader(event, 'Cache-Control', 'no-store');

  const query = getQuery(event);
  const rawSubs = query.subs;

  // `getQuery` trả `string | string[]` — param lặp lại cho ra mảng. Contract nhận
  // đúng một giá trị `subs` (danh sách phân tách bằng dấu phẩy); mảng không phải
  // hình dạng hợp lệ.
  const raw = Array.isArray(rawSubs) ? undefined : rawSubs;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw createError({
      statusCode: 400,
      statusMessage: 'Bad Request',
    });
  }

  const requestedSubs = dedupeProfileSubs(raw.split(',').map((sub) => sub.trim()));

  // Định dạng sai là lỗi của caller (400), không phải account không tồn tại — cùng
  // phân biệt với `internal/account/status`.
  if (requestedSubs.length === 0 || !requestedSubs.every((sub) => isSubject(sub))) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Bad Request',
    });
  }

  if (requestedSubs.length > ACCOUNT_PROFILES_MAX_SUBS) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Bad Request',
    });
  }

  const hyperdrive = accountHyperdrive(useRuntimeConfig(event));
  if (!hyperdrive) {
    // Contract này phục vụ hiển thị, không phải control point lúc phát hành token,
    // nhưng endpoint vẫn fail closed (503) chứ không trả batch rỗng: rỗng là dữ liệu
    // thật, 503 là "chưa kiểm tra được" — hai thứ đó khác nhau về hành vi, và để
    // consumer tự quyết định degrade từ tín hiệu đúng thay vì ăn dữ liệu giả.
    writeLog({
      event: 'account_profiles.failed',
      status: 503,
      reason: 'binding_missing',
    });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  let displayNames: Map<string, string | null>;
  try {
    displayNames = await withRequestPool(hyperdrive, (pool) =>
      selectDisplayNames(pool, requestedSubs),
    );
  } catch {
    // Không nối `error` vào log: message của driver có thể chứa connection string.
    writeLog({
      event: 'account_profiles.failed',
      status: 503,
      reason: 'db_unreachable',
    });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  // Chỉ trả đúng các sub được hỏi, theo đúng thứ tự request; sub vắng mặt trong map
  // (không có row profile) là displayName null.
  const payload = accountProfilesResponse(
    requestedSubs.map((sub) => ({
      sub,
      displayName: displayNames.get(sub) ?? null,
    })),
  );

  // Lưới an toàn trước khi response rời Worker — cùng vai trò với
  // `validateAccountStatusResponse` ở `internal/account/status`.
  const validation = validateAccountProfilesResponse(payload);
  if (!validation.ok) {
    writeLog({
      event: 'account_profiles.invalid_response',
      status: 500,
      reason: validation.reason,
    });
    throw createError({ statusCode: 500, statusMessage: 'Internal Server Error' });
  }

  // Audit mỗi lần đọc: `sub` là opaque identifier, được phép trong log; không log
  // giá trị displayName (dữ liệu hồ sơ, không cần thiết cho điều tra).
  writeLog({
    event: 'account_profiles.read',
    status: 200,
  });

  return validation.payload;
});
