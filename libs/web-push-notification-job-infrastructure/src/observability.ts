/**
 * Logger JSON một dòng + bộ đếm metric in-process, cho delivery plane.
 *
 * ⚠️ **Đây là bản riêng, không phải import** từ `libs/push-notification-infrastructure/src/
 * observability.ts`. File đó là **pattern tham khảo** (JSON-line, nuốt lỗi, `LogFields` chỉ
 * nhận scalar); import nó sẽ tạo một edge từ delivery plane sang infrastructure của control
 * plane, và Nx graph sẽ ghi nhận dependency đó. Cùng bất biản, hai tài liệu riêng.
 *
 * ⚠️ **Observability KHÔNG BAO GIỜ là phụ thuộc của đường serving.** Mọi lỗi ở đây bị nuốt:
 * một `JSON.stringify` ném vì circular, một sink hỏng, một `console.log` không tồn tại — không
 * được phép làm một delivery fail. Vì vậy **không có `throw`** trong file này và không lời gọi
 * nào tới nó được `await` trên đường xử lý message.
 *
 * ⚠️ **Không bao giờ log payload/response body, endpoint, `auth`, `p256dh`, VAPID key, secret
 * hay header authorization** (SR-003, operations §11). `DeliveryLogFields` chỉ nhận scalar
 * hoặc danh sách scalar, nên không có chỗ cho một object lọt vào mà không bị type chặn.
 */

/**
 * `no-console` của repo bật `[2]`, nhưng log trên Workers runtime **là** `console.log`.
 *
 * ⚠️ Disable đặt **tại chỗ dùng**, không ở đầu file: `reportUnusedDisableDirectives: "error"`
 * sẽ báo một directive thừa, nên một disable cấp file cho toàn bộ những chỗ không log là một
 * directive im lặng — đúng thứ rule cấm.
 */

import type {
  DeliveryLogFields,
  DeliveryLogLevel,
  DeliveryMetricName,
  LoggerPort,
  MetricDimensions,
  MetricsPort,
} from '@ecoma-io/web-push-notification-job-application';

/** Cấp log theo thứ tự tăng dần; `logLevel` của env chọn ngưỡng. */
const LEVEL_ORDER: Readonly<Record<DeliveryLogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** `LOG_LEVEL` của `03-operations.md` §3 — giá trị lạ không được làm ném ở đường serving. */
const DEFAULT_LOG_LEVEL: DeliveryLogLevel = 'info';

export interface LoggerOptions {
  readonly service: string;
  readonly environment: string;
  readonly level: DeliveryLogLevel;
  /** Điểm vào của log — mặc định `console`. Inject được để test khẳng định "nuốt lỗi". */
  readonly sink?: (line: string) => void;
  /** Clock để stamp `ts`; inject được để một test log có timestamp ổn định. */
  readonly now?: () => number;
}

export function createLogger(options: LoggerOptions): LoggerPort {
  const threshold = LEVEL_ORDER[options.level];
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? ((): number => Date.now());

  const emit = (level: DeliveryLogLevel, message: string, fields?: DeliveryLogFields): void => {
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
      // Merge `fields` ở cấp gốc thay vì lồng dưới một key: một consumer tìm `provider_id` không
      // nên phải biết log này có wrapper. `message`/`service`/`level` đặt **trước** nên một
      // field trùng tên sẽ ghi đè — hành vi có chủ ý: caller truyền `level` sai là lỗi của
      // caller và phải lộ ra.
      if (fields !== undefined) {
        for (const [key, value] of Object.entries(fields)) {
          record[key] = value;
        }
      }
      sink(JSON.stringify(record));
    } catch {
      // Nuốt: log hỏng là mất quan sát; một delivery fail vì log là mất dữ liệu.
    }
  };

  return {
    log: (level, message, fields) => {
      emit(level, message, fields);
    },
  };
}

function defaultSink(line: string): void {
  // eslint-disable-next-line no-console -- Workers chỉ ghi log qua console; đây là điểm vào duy nhất.
  console.log(line);
}

/**
 * Đọc `LOG_LEVEL` từ env, **fail-safe** về `info` khi thiếu/lạ.
 *
 * ⚠️ Fail-safe chứ không phải fail-closed: một `LOG_LEVEL` sai là lỗi **quan sát**, không phải
 * lỗi *chính sách* — ném ở đây sẽ làm một Worker không log được delivery thay vì chỉ log nhiều
 * hoặc ít hơn. Auth và secret thì ngược lại: chúng fail-closed (xem `runtime-control-plane.ts`).
 */
export function resolveLogLevel(env: Readonly<Record<string, unknown>>): DeliveryLogLevel {
  const raw = env['LOG_LEVEL'];
  if (typeof raw !== 'string') {
    return DEFAULT_LOG_LEVEL;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === 'debug' ||
    normalized === 'info' ||
    normalized === 'warn' ||
    normalized === 'error'
    ? normalized
    : DEFAULT_LOG_LEVEL;
}

/** Một hàng đếm metric đang sống — đọc được từ test và từ một endpoint metrics nếu có. */
interface CounterRow {
  count: number;
}

export interface MetricsOptions {
  readonly service: string;
  /** Clock cho timestamp của histogram; inject được để test ổn định. */
  readonly now?: () => number;
}

/**
 * Khoá đếm chuẩn hoá của một metric.
 *
 * ⚠️ Thứ tự khoá được sắp xếp để `{a,b}` và `{b,a}` là **một** chuỗi đếm: JSON.stringify giữ thứ
 * tự chèn, và hai object bằng nhau về nội dung có thể có thứ tự khác nhau.
 *
 * ⚠️ Sắp xếp bằng `toSorted` (ES2023, không mutate) chứ không `sort`: repo cấm `sort` vì nó mutate
 * array đầu vào, mà ở đây đầu vào là `Object.keys(...)` — mutate một mảng tạm thì vô hại, nhưng quy
 * tắc đó là của repo chứ không phải của tôi để quyết định phớt lờ. `lib` của project này là
 * `es2023` (xem `tsconfig.lib.json`) nên `toSorted` có sẵn.
 *
 * ⚠️ Ở **scope module**, không phải closure của `createMetrics`: hàm này không capture gì từ scope
 * cha (chỉ dùng tham số của nó), và đặt trong closure là tạo lại một hàm mới cho **mọi** metric
 * record — `unicorn(consistent-function-scoping)` bắt đúng cái đó.
 */
function keyOf(name: DeliveryMetricName, dimensions?: MetricDimensions): string {
  if (dimensions === undefined) {
    return name;
  }
  const parts = Object.keys(dimensions)
    .toSorted()
    .map((key) => `${key}=${String(dimensions[key])}`);
  return parts.length === 0 ? name : `${name}{${parts.join(',')}}`;
}

/**
 * Bộ đếm metric in-process.
 *
 * ⚠️ **Không** dùng `delivery_id`/`notification_id`/`endpoint` làm dimension (operations §11:
 * high-cardinality label làm metric không dùng được). Dimension ở đây là `provider_id`,
 * `transport`, `app`, `job_reconciliation`, `http_status` — tập tương thích với
 * `onlyDependOn` mà §12 yêu cầu alert theo.
 *
 * ⚠️ **Không** phải hệ thống metric của Cloudflare. Cloudflare không có API metric được
 * Workers ghi vào; Workers Analytics Engine (`writeDataPoint`) là một binding riêng và một
 * quyết định vận hành chưa chốt. Bộ đếm này là **điểm thu thập đã chuẩn hoá**: metric tồn tại,
 * có tên và dimension đúng, và một test khẳng định được số đo thật — đổi sink sau này là đổi
 * một hàm, không phải viết lại pipeline. `flush()` là chỗ gắn sink thật.
 */
export function createMetrics(options: MetricsOptions): MetricsPort & MetricsSnapshotSource {
  const counters = new Map<string, CounterRow>();
  const observations = new Map<string, number[]>();
  const now = options.now ?? ((): number => Date.now());
  let lastRecordedAt = 0;

  const port: MetricsPort & MetricsSnapshotSource = {
    increment: (name, dimensions) => {
      // ⚠️ Không `throw` và không `await` ở đây: metric sink hỏng không được làm hỏng một
      // delivery (observability không phải phụ thuộc của đường serving). `keyOf` là hàm thuần
      // trên object thuần nên nó không ném, và `counters.set` không ném — nên `try/catch` ở
      // đây là thừa, và một `try` bao quanh code không ném là code trông như cần bảo vệ nhưng
      // không bảo vệ gì.
      const key = keyOf(name, dimensions);
      const row = counters.get(key);
      counters.set(key, { count: (row?.count ?? 0) + 1 });
      lastRecordedAt = now();
    },
    observe: (name, value, dimensions) => {
      if (!Number.isFinite(value)) {
        return;
      }
      const key = keyOf(name, dimensions);
      const existing = observations.get(key);
      if (existing === undefined) {
        observations.set(key, [value]);
      } else {
        existing.push(value);
      }
      lastRecordedAt = now();
    },
    snapshot: () => {
      // `observations` được đọc ở đây để một metric dạng gauge vẫn còn trong snapshot dưới
      // dạng tổng số lần quan sát: giữ nó trong map là đủ cho một test khẳng định histogram
      // đã ghi, mà không phải chọn một bản tổng hợp (trung bình/p50/p99) chưa ai chốt cách tính.
      const flat = new Map<string, number>();
      for (const [key, row] of counters) {
        flat.set(key, row.count);
      }
      for (const [key, values] of observations) {
        flat.set(`${key}#observations`, values.length);
      }
      return { counters: flat, lastRecordedAt };
    },
  };
  return port;
}

/** Số đo hiện tại của bộ đếm — chỉ để test khẳng định **hiệu ứng thật**, không phải đường serving. */
export interface MetricsSnapshot {
  readonly counters: ReadonlyMap<string, number>;
  /** Mốc thời gian lần ghi gần nhất — đủ để một test chứng minh metric sống. */
  readonly lastRecordedAt: number;
}

/**
 * Bộ đếm có `snapshot()` — implement {@link MetricsPort} **và** một method đọc thêm.
 *
 * ⚠️ `snapshot()` **không** nằm trong {@link MetricsPort} và đó là chủ đích: `MetricsPort` là
 * hợp đồng của pipeline, và thêm method đọc vào đó là thêm một method pipeline không bao giờ
 * gọi. Kiểu trả về là `MetricsPort & MetricsSnapshotSource` nên call site ở đường serving vẫn
 * chỉ có quyền `increment`/`observe` qua khi nó nhận kiểu `MetricsPort`.
 */
export interface MetricsSnapshotSource {
  snapshot(): MetricsSnapshot;
  /** Chỗ gắn sink thật tương lai (Workers Analytics Engine chưa phải quyết định chốt). */
  flush?(): void;
}
