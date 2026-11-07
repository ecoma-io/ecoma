import {
  assertKid,
  DEFAULT_SKEW_SECONDS,
  MAX_SKEW_SECONDS,
  resolveSkewSeconds,
} from '@ecoma-io/internal-auth-contracts';

export interface StaffAccessEnv {
  DB_STAFF_ACCESS?: { connectionString: string };
  AUTH_INTERNAL_SECRET?: string;
  AUTH_INTERNAL_KID?: string;
  AUTH_INTERNAL_PREVIOUS_SECRET?: string;
  AUTH_INTERNAL_PREVIOUS_KID?: string;
  AUTH_INTERNAL_SKEW_SECONDS?: string;
}

export interface StaffAccessConfig {
  readonly hyperdrive: { connectionString: string };
  readonly internalSecret: string;
  readonly internalKid: string | undefined;
  readonly internalSecretsByKid: ReadonlyMap<string, string>;
  readonly internalAuthSkewSeconds: number;
}

export class StaffAccessAppConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaffAccessAppConfigurationError';
  }
}

function requireSecret(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '' || value !== value.trim()) {
    throw new StaffAccessAppConfigurationError(`Worker Secret ${name} is missing or malformed`);
  }
  return value;
}

function requireHyperdrive(value: unknown): { connectionString: string } {
  if (value === undefined || value === null || typeof value !== 'object') {
    throw new StaffAccessAppConfigurationError(
      'Hyperdrive binding DB_STAFF_ACCESS has not been attached; staff-access fails closed',
    );
  }
  const connectionString = (value as { connectionString?: unknown }).connectionString;
  if (typeof connectionString !== 'string' || connectionString === '') {
    throw new StaffAccessAppConfigurationError(
      'Hyperdrive binding DB_STAFF_ACCESS has no connectionString; staff-access fails closed',
    );
  }
  return { connectionString };
}

function optionalKid(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  try {
    assertKid(value);
    return value;
  } catch {
    throw new StaffAccessAppConfigurationError(`Worker Secret ${name} is invalid`);
  }
}

function parseSkew(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_SKEW_SECONDS;
  // Strict decimal integer: reject whitespace, exponent, hex, fractional,
  // plus/minus signs beyond a leading optional minus (none allowed here),
  // and any other non-digit. Zero/negative/out-of-range rejected below.
  if (!/^[0-9]+$/u.test(value)) {
    throw new StaffAccessAppConfigurationError('AUTH_INTERNAL_SKEW_SECONDS is invalid');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_SKEW_SECONDS) {
    throw new StaffAccessAppConfigurationError('AUTH_INTERNAL_SKEW_SECONDS is invalid');
  }
  return resolveSkewSeconds(parsed);
}

export function loadStaffAccessConfig(
  envInput: StaffAccessEnv | undefined | null,
): StaffAccessConfig {
  const env = envInput ?? {};
  const hyperdrive = requireHyperdrive(env.DB_STAFF_ACCESS);
  const internalSecret = requireSecret(env.AUTH_INTERNAL_SECRET, 'AUTH_INTERNAL_SECRET');
  const internalKid = optionalKid(env.AUTH_INTERNAL_KID, 'AUTH_INTERNAL_KID');
  const previousSecret = env.AUTH_INTERNAL_PREVIOUS_SECRET;
  const previousKid = optionalKid(env.AUTH_INTERNAL_PREVIOUS_KID, 'AUTH_INTERNAL_PREVIOUS_KID');
  if (previousSecret !== undefined) requireSecret(previousSecret, 'AUTH_INTERNAL_PREVIOUS_SECRET');
  if ((previousSecret === undefined) !== (previousKid === undefined)) {
    throw new StaffAccessAppConfigurationError(
      'AUTH_INTERNAL_PREVIOUS_SECRET and AUTH_INTERNAL_PREVIOUS_KID must be configured together',
    );
  }
  if (internalKid !== undefined && previousKid === internalKid) {
    throw new StaffAccessAppConfigurationError(
      'AUTH_INTERNAL_KID must differ from AUTH_INTERNAL_PREVIOUS_KID',
    );
  }
  const internalSecretsByKid = new Map<string, string>();
  if (internalKid !== undefined) internalSecretsByKid.set(internalKid, internalSecret);
  if (previousKid !== undefined && previousSecret !== undefined) {
    internalSecretsByKid.set(previousKid, previousSecret);
  }
  return {
    hyperdrive,
    internalSecret,
    internalKid,
    internalSecretsByKid,
    internalAuthSkewSeconds: parseSkew(env.AUTH_INTERNAL_SKEW_SECONDS),
  };
}

export function resolveInternalSecret(config: StaffAccessConfig): (kid: string) => Promise<string> {
  return async (kid) => {
    const secret = config.internalSecretsByKid.get(kid);
    if (secret === undefined) {
      throw new Error(`unknown internal kid '${kid}'`);
    }
    return secret;
  };
}
