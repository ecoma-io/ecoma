import type { StaffAccessConfig } from './config';

/**
 * Context Hono cua Worker — bien do composition root set vao context sau khi
 * config da duoc kiem (middleware config). Route cua Milestone B doc tu day
 * thay vi doc `env` truc tiep, de duong config khong ro lech giua cac route.
 */
export interface AppEnv {
  readonly Variables: {
    config: StaffAccessConfig;
    requestId: string;
    actorSub: string | null;
    actorStaffId: string | null;
  };
  readonly Bindings: {
    DB_STAFF_ACCESS?: { connectionString: string };
    AUTH_INTERNAL_SECRET?: string;
    AUTH_INTERNAL_KID?: string;
    AUTH_INTERNAL_PREVIOUS_SECRET?: string;
    AUTH_INTERNAL_PREVIOUS_KID?: string;
    AUTH_INTERNAL_SKEW_SECONDS?: string;
  };
}
