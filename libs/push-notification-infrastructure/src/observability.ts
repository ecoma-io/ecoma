/**
 * Structured log một dòng JSON (`03-operations.md` §23).
 *
 * ⚠️ **Observability không được trở thành phụ thuộc của đường serving** (kiến trúc không đổi).
 * Mọi lỗi ở đây đều bị nuốt: một `console.warn` hỏng, một `JSON.stringify` ném vì circular,
 * một logger không tồn tại — không được phép làm một request thành `500`. Vì vậy không có
 * `throw` trong file này và không có lời gọi nào tới nó được await trong một đường serving
 * quan trọng.
 *
 * ⚠️ **Không bao giờ log payload/response body** (kiến trúc: never log prompt/response
 * bodies). `LogFields` chỉ nhận scalar, nên không có chỗ cho một object lọt vào mà không bị
 * type chặn — cùng lý do `AuditRecordInput.detail` cũng là `Record<string, string | number |
 * boolean>`.
 */

/**
 * `no-console` của repo bật `[2]`, nhưng log **là** `console.log` ở Workers runtime.
 *
 * ⚠️ Disable đặt **tại chỗ dùng**, không ở đầu file: `reportUnusedDisableDirectives: "error"`
 * sẽ báo một directive thừa, nên một disable ở cấp file cho toàn bộ những chỗ không log là một
 * directive im lặng đúng thứ rule cấm.
 */

/** Trường của một dòng log — scalar hoặc danh sách scalar. */
export type LogFields = Readonly<
  Record<string, string | number | boolean | readonly (string | number | boolean)[]>
>;

/** Cấp log theo thứ tự tăng dần; `logLevel` của env chọn ngưỡng. */
const LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 } as const;

export type LogLevel = keyof typeof LEVEL_ORDER;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  readonly service: string;
  readonly environment: string;
  readonly level: LogLevel;
  /** Điểm vào của log — mặc định `console`. Inject được để test chứng minh "nuốt lỗi". */
  readonly sink?: (line: string) => void;
  /** Clock để stamp `ts`; inject được để một test log có timestamp ổn định. */
  readonly now?: () => number;
}

/**
 * Logger JSON một dòng.
 *
 * ⚠️ `service`/`environment` nằm trên **mọi** dòng: §23 yêu cầu log phải phân biệt được môi
 * trường mà không cần đọc lại nơi nó phát sinh — một log không có môi trường thì không phân
 * biệt được staging với production khi chúng ghi vào cùng một aggregator.
 */
export function createLogger(options: LoggerOptions): Logger {
  const threshold = LEVEL_ORDER[options.level];
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? ((): number => Date.now());

  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[level] < threshold) {
      return;
    }
    try {
      const record: Record<string, unknown> = {
        ts: new Date(now()).toISOString(),
        level,
        service: options.service,
        environment: options.environment,
        message,
      };
      // Merge `fields` ở cấp gốc thay vì lồng dưới một key: một consumer tìm `app` không nên
      // phải biết log này có wrapper. `message`/`service`/`level` được đặt **trước**, nên
      // một field trùng tên sẽ ghi đè — đó là hành vi có chủ ý: caller truyền `level` sai là
      // lỗi của caller và phải lộ ra, không phải bị báo là hợp lệ.
      if (fields !== undefined) {
        for (const [key, value] of Object.entries(fields)) {
          record[key] = value;
        }
      }
      sink(JSON.stringify(record));
    } catch {
      // Nuốt: log không được làm hỏng request. Một log line hỏng là mất quan sát; một
      // request 500 vì log là mất dữ liệu. Thứ này phải đặt đúng như vậy.
    }
  };

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}

function defaultSink(line: string): void {
  // eslint-disable-next-line no-console -- Workers chỉ ghi log qua console; đây là điểm vào duy nhất.
  console.log(line);
}

/**
 * Phân loại lỗi D1 để error handler trả `503` + `Retry-After` thay vì `500`.
 *
 * ⚠️ **Fail theo hướng có thể phục hồi.** Một lỗi D1 (mạng, timeout, D1 tạm unavailable) là
 * lỗi hạ tầng tạm thời — client nên thử lại. Một `422` từ SQL là lỗi dữ liệu vĩnh viễn, thử
 * lại vô ích và chỉ đẩy tải thêm lên D1.
 *
 * ⚠️ Nhận diện theo **thông điệp** vì D1 không có mã lỗi ổn định để phân loại. Vì vậy danh sách
 * này **phải** là danh sách đóng và thay đổi nó phải đi kèm một test — xem `d1-errors.spec.ts`.
 */
export function isRetryableStorageError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return RETRYABLE_STORAGE_PATTERNS.some((pattern) => pattern.includes(message));
}

/**
 * Tiền tố thông điệp lỗi D1 mà coi là **hạ tầng tạm thời**.
 *
 * ⚠️ `too many requests` nằm trong đây: D1 bị throttle là một sự kiện bình thường, và trả `500`
 * khiến một client không có chiến lược retry lại mất notification thay vì thử lại sau vài giây.
 */
const RETRYABLE_STORAGE_PATTERNS: readonly string[] = [
  'd1_database_error',
  'd1 is overloaded',
  'too many requests',
  'request timeout',
  'timed out',
  'connection',
  'network',
  'temporarily unavailable',
  'internal error',
];
