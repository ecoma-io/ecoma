/**
 * Nap cau hinh cua Worker `remote-cache-api` tu binding (ADR-0015, P4.1).
 *
 * Nguyen tac giong `apps/staff-access/src/config.ts`: **thieu cau hinh la
 * loi, khong phai ly do doan**. Moi `require` nem
 * `RemoteCacheAppConfigurationError` lam request fail-closed thay vi chay
 * bang default doan duoc. Message neu TEN bien trong loi — KHONG BAO GIO
 * neu gia tri.
 */
import {
  assertKid,
  DEFAULT_SKEW_SECONDS,
  MAX_SKEW_SECONDS,
  MIN_SKEW_SECONDS,
} from '@ecoma-io/internal-auth-contracts';

/** Shape cua `env` ma Worker nhan tu binding + secrets. */
export interface RemoteCacheEnv {
  /** Hyperdrive binding toi `db-remote-cache`. Khong phai connection string. */
  DB_REMOTE_CACHE?: { connectionString: string };
  /** Storage config — tat ca optional; thieu thi data plane fail-closed 503. */
  S3_ENDPOINT?: string;
  S3_BUCKET?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  /** Gioi han kich thuoc artifact (byte). Mac dinh 512 MiB neu khong cau hinh. */
  MAX_ARTIFACT_SIZE?: string;
  /** Quota mac dinh (byte) cho project chua co hang quota_limits. 0 = khong han che. */
  DEFAULT_MAX_STORAGE_BYTES?: string;
  /** Quota mac dinh (so luong entry) cho project chua co hang quota_limits. 0 = khong han che. */
  DEFAULT_MAX_ENTRY_COUNT?: string;
  /** Retention TTL mac dinh (giay) cho entry moi; rong/0 = khong co TTL (dung storage lifecycle). */
  DEFAULT_RETENTION_TTL_SECONDS?: string;
  /**
   * Secret HMAC cho envelope noi bo `ecoma-internal-v2` (`@ecoma-io/internal-auth-contracts`)
   * — portal BFF (#180) dung de ky call control plane mang human principal
   * (issue #202). Thieu thi control-plane portal fail-closed 503, con lai app
   * van chay (machine routes + data plane khong phu thuoc).
   */
  INTERNAL_AUTH_SECRET?: string;
  /** `kid` tuy chon cua secret hien hanh — chi dan chon khoa cho phase rotation. */
  INTERNAL_AUTH_KID?: string;
  /** Skew (giay) chap nhan cho envelope noi bo; rong = mac dinh cua contract. */
  INTERNAL_AUTH_SKEW_SECONDS?: string;
}

/** Cau hinh da kiem, dung boi composition root. */
export interface RemoteCacheConfig {
  readonly hyperdrive: { connectionString: string };
  readonly storage: {
    readonly endpoint: string;
    readonly bucket: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
  } | null;
  readonly maxArtifactSize: number;
  /** Quota mac dinh ap dung cho project chua co hang quota_limits (0 = khong han che). */
  readonly quota: {
    readonly defaultMaxStorageBytes: number;
    readonly defaultMaxEntryCount: number;
  };
  /** Retention TTL mac dinh (giay) cho entry moi; null = dung storage lifecycle. */
  readonly retention: {
    readonly defaultTtlSeconds: number | null;
  };
  /**
   * Cau hinh envelope noi bo cho control-plane portal (issue #202). `null` khi
   * `INTERNAL_AUTH_SECRET` chua duoc cap — portal routes fail-closed 503 tren
   * tung request, machine routes + data plane khong anh huong (expand-friendly:
   * environment cu chua cap secret van boot duoc).
   */
  readonly internalAuth: {
    readonly secret: string;
    readonly kid: string | null;
    readonly skewSeconds: number;
  } | null;
}

/**
 * Nem khi thieu/gia cau hinh. Thong bao neu TEN bien de nguoi van hanh biet
 * cap cai gi — nhung khong bao gio neu gia tri.
 */
export class RemoteCacheAppConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteCacheAppConfigurationError';
  }
}

function requireHyperdrive(value: unknown): { connectionString: string } {
  if (value === undefined || value === null || typeof value !== 'object') {
    throw new RemoteCacheAppConfigurationError(
      'Hyperdrive binding DB_REMOTE_CACHE has not been attached; remote-cache fails closed',
    );
  }
  const cs = (value as { connectionString?: unknown }).connectionString;
  if (typeof cs !== 'string' || cs === '') {
    throw new RemoteCacheAppConfigurationError(
      'Hyperdrive binding DB_REMOTE_CACHE has no connectionString; remote-cache fails closed',
    );
  }
  return { connectionString: cs };
}

/** Nap va xac thuc mot so nguyen khong am tu env; neu invalid thi nem RemoteCacheAppConfigurationError (fail-closed). */
function requireNonNegativeNumber(
  env: RemoteCacheEnv,
  key: 'DEFAULT_MAX_STORAGE_BYTES' | 'DEFAULT_MAX_ENTRY_COUNT',
  defaultValue: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new RemoteCacheAppConfigurationError(
      `Invalid ${key}: ${raw}. Must be a non-negative integer.`,
    );
  }
  return n;
}

/** Nap va kiem toan bo cau hinh. `undefined`/`null` coi nhu env rong. */
export function loadRemoteCacheConfig(
  envInput: RemoteCacheEnv | undefined | null,
): RemoteCacheConfig {
  const env: RemoteCacheEnv = envInput ?? {};
  const hyperdrive = requireHyperdrive(env.DB_REMOTE_CACHE);

  // Storage: tat ca optional — thieu bat ky field thi data plane fail-closed 503
  // (khong co default storage). Khong nem khi thieu; route tra 503 khi storage null.
  const storage =
    env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
      ? {
          endpoint: env.S3_ENDPOINT,
          bucket: env.S3_BUCKET,
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        }
      : null;

  const maxArtifactSize =
    env.MAX_ARTIFACT_SIZE &&
    Number.isFinite(Number(env.MAX_ARTIFACT_SIZE)) &&
    Number(env.MAX_ARTIFACT_SIZE) > 0
      ? Number(env.MAX_ARTIFACT_SIZE)
      : 512 * 1024 * 1024;

  const defaultMaxStorageBytes = requireNonNegativeNumber(env, 'DEFAULT_MAX_STORAGE_BYTES', 0);
  const defaultMaxEntryCount = requireNonNegativeNumber(env, 'DEFAULT_MAX_ENTRY_COUNT', 0);

  const defaultTtlSecondsRaw =
    env.DEFAULT_RETENTION_TTL_SECONDS &&
    Number.isFinite(Number(env.DEFAULT_RETENTION_TTL_SECONDS)) &&
    Number(env.DEFAULT_RETENTION_TTL_SECONDS) > 0
      ? Number(env.DEFAULT_RETENTION_TTL_SECONDS)
      : null;

  const internalAuth = loadInternalAuth(env);

  return {
    hyperdrive,
    storage,
    maxArtifactSize,
    quota: { defaultMaxStorageBytes, defaultMaxEntryCount },
    retention: { defaultTtlSeconds: defaultTtlSecondsRaw },
    internalAuth,
  };
}

/**
 * Nap cau hinh envelope noi bo cho control-plane portal (issue #202).
 *
 * Thieu secret → `null`: portal routes fail-closed 503 theo tung request,
 * phan con lai cua app khong doi (khong bat boot environment cu phai cap
 * secret). Co secret mà `kid` sai định dạng hay skew ngoài khoảng hợp lệ của
 * contract (`MIN_SKEW_SECONDS`/`MAX_SKEW_SECONDS`) thì NÉM — một cấu hình sai
 * của đường xác thực phải chết lúc boot, không im lặng chạy với mặc định
 * (cùng nguyên tắc `apps/staff-access/src/config.ts`).
 */
function loadInternalAuth(env: RemoteCacheEnv): RemoteCacheConfig['internalAuth'] {
  const secret = env.INTERNAL_AUTH_SECRET;
  if (secret === undefined || secret === '') {
    return null;
  }
  let kid: string | null = null;
  if (env.INTERNAL_AUTH_KID !== undefined && env.INTERNAL_AUTH_KID !== '') {
    try {
      assertKid(env.INTERNAL_AUTH_KID);
      kid = env.INTERNAL_AUTH_KID;
    } catch (error) {
      // Message chi gom TEN bien + nguyen nhan goc cua `assertKid`: contract da
      // noi dung quy tac hien hanh (do dai, bang chu, chu hoa/thuong), nen mot
      // ban mo ta hardcode o day se lech khi contract doi ma khong ai phat
      // hien. An toan ve mat secret — InvalidKidError chi neu TEN truong,
      // khong bao gio gia tri (JSDoc cua no).
      throw new RemoteCacheAppConfigurationError(
        `Invalid INTERNAL_AUTH_KID: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const rawSkew = env.INTERNAL_AUTH_SKEW_SECONDS;
  if (rawSkew !== undefined && rawSkew !== '') {
    // Parse chat: CHUOI chu so thap phan nguyen. `Number()` cham ngoai so chu so
    // van tra so hop le (`' 5 '` = 5, `'0x10'` = 16, `'1e2'` = 100, `'+5'` = 5)
    // — khong gia tri nao trong so do la y nghia giay skew ma nguoi van hanh
    // muon; mot cau hinh xac thuc sai hinh phai chet luc boot theo doctrine
    // cua ham nay, khong im lang doan mot gia tri "gan dung".
    if (!/^\d+$/u.test(rawSkew)) {
      throw new RemoteCacheAppConfigurationError(
        `Invalid INTERNAL_AUTH_SKEW_SECONDS: must be an integer in [${MIN_SKEW_SECONDS}, ${MAX_SKEW_SECONDS}].`,
      );
    }
    const parsed = Number(rawSkew);
    if (parsed < MIN_SKEW_SECONDS || parsed > MAX_SKEW_SECONDS) {
      throw new RemoteCacheAppConfigurationError(
        `Invalid INTERNAL_AUTH_SKEW_SECONDS: must be an integer in [${MIN_SKEW_SECONDS}, ${MAX_SKEW_SECONDS}].`,
      );
    }
    return { secret, kid, skewSeconds: parsed };
  }
  return { secret, kid, skewSeconds: DEFAULT_SKEW_SECONDS };
}
