import { test as base } from '@playwright/test';
import {
  TENANT_NAME,
  mailWicContainerOf,
  readOtpFromMailSink,
  resolvePostgresContainer,
  seedAccountIdentity,
  seedRemoteCacheMembership,
  seedSecondTenantMembership,
} from './stack-fixtures';
import { resolveStackOrigin } from './local-origin';

/**
 * Fixture dùng chung của suite — mỗi TEST nhận một định danh IDENTITY riêng.
 *
 * Lý do mỗi test một identity thay vì một identity cho cả file: challenge OTP
 * bị rate limit 3 challenge/15 phút THEO ĐỊA CHỈ — một identity dùng cho nhiều
 * test login liên tiếp sẽ cạn budget giữa file. Các test không cần chia sẻ
 * phiên (state journey đi qua module scope), nên identity riêng per test là
 * rẻ hơn và an toàn với rate limit.
 *
 * Identity KHÔNG bị xoá sau run: rerun tái dùng `account.users` + grant OIDC
 * (login lượt sau đi path `granted` — không consent), còn membership là INSERT
 * idempotent.
 */

/** Sub của identity — base32 lowercase 32 ký tự sau prefix. */
function makeSub(seed: string): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let sub = 'sub_';
  for (let i = 0; i < 32; i += 1) {
    const char = seed.charCodeAt(i % seed.length);
    sub += alphabet[(char * (i + 7)) % alphabet.length];
  }
  return sub;
}

/** Email fixture — duy nhất theo seed, routed về domain test của stack. */
function makeEmail(seed: string): string {
  return `remote-cache-portal-e2e.${seed}@test.ecoma.local`;
}

export interface Identity {
  readonly sub: string;
  readonly email: string;
  /** Đọc OTP của identity này từ mail sink — poll sau mốc `sinceMs` truyền vào. */
  readonly readOtp: (sinceMs: number) => Promise<string>;
}

/** Slug hoá tiêu đề test thành seed filesystem-safe cho identity. */
function testToken(file: string, title: string): string {
  const fileName = file.split('/').pop() ?? 'spec';
  const raw = `${fileName.replace(/\.spec\.ts$/u, '')}-${title}`;
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 60);
}

interface Fixtures {
  readonly identity: Identity;
}

export const test = base.extend<Fixtures>({
  // Scope mặc định per test: seed idempotent, mỗi test tự sở hữu challenge OTP.
  identity: async ({ page: _unusedPage }, use, testInfo) => {
    const seed = testToken(testInfo.file, testInfo.title);
    const sub = makeSub(seed);
    const email = makeEmail(seed);

    const postgresContainer = await resolvePostgresContainer(resolveStackOrigin());
    await seedAccountIdentity(postgresContainer, { sub, email });
    await seedRemoteCacheMembership(postgresContainer, { sub });

    await use({
      sub,
      email,
      readOtp: (sinceMs: number) =>
        readOtpFromMailSink(mailWicContainerOf(postgresContainer), {
          recipient: email,
          sinceMs,
        }),
    });
  },
});

export { expect } from '@playwright/test';

// -------------------------------------------------------------------------------------------
// Identity cross-tenant (negative A32) — seed theo yêu cầu của test, không qua fixture
// -------------------------------------------------------------------------------------------

/** Tên tenant thứ hai dùng cho test negative — phải KHÁC `ecoma` (UNIQUE tên). */
export const SECOND_TENANT_NAME = 'outsider-tenant';
/** Owner giả của tenant thứ hai — KHÔNG trùng sub của bất kỳ identity nào của suite. */
export const SECOND_TENANT_OWNER_SUB = 'sub_owner_of_outsider_tenant_fixture_000000000000';

/**
 * Seed identity + membership trong tenant thứ hai cho negative cross-tenant.
 * Actor này KHÔNG phải member của `ecoma` — mọi request portal lên
 * `/tenants/ecoma/...` bằng phiên của nó phải bị từ chối (403), còn tenant của
 * chính nó được resolve riêng. Đây là định nghĩa "người ngoài tenant" mà A32 đòi.
 */
export async function seedOutsiderIdentity(origin: string, seed: string): Promise<Identity> {
  const sub = makeSub(seed);
  const email = makeEmail(seed);
  const postgresContainer = await resolvePostgresContainer(origin);
  await seedAccountIdentity(postgresContainer, { sub, email });
  await seedSecondTenantMembership(postgresContainer, {
    sub,
    tenantName: SECOND_TENANT_NAME,
    ownerSub: SECOND_TENANT_OWNER_SUB,
  });
  return {
    sub,
    email,
    readOtp: (sinceMs: number) =>
      readOtpFromMailSink(mailWicContainerOf(postgresContainer), {
        recipient: email,
        sinceMs,
      }),
  };
}

export { TENANT_NAME };
