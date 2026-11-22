/**
 * Suy tập DNS record của zone staging theo scheme hostname MOD1
 * (`docs/architecture/02-delivery.md` hostname scheme) từ inventory
 * eligibility staging — module thuần (không import Pulumi/fs) để spec test
 * được độc lập runtime.
 *
 * Nguồn sự thật DUY NHẤT của tập unit là `tools/delivery/config/
 * deploy-eligibility.jsonc` (entry `staging: "releaseable"`) — cùng nguồn với
 * inventory GitHub Environments `staging-<slug>` (`stagingUnits` của
 * `tools/delivery/src/staging-environments.ts`, cùng pattern fail-closed).
 * Module này không nhân bản danh sách unit; nó chỉ bổ sung phân loại mà
 * eligibility không có: unit nào được cấp hostname public.
 *
 * Scheme MOD1 (`02-delivery.md`): staging public hostname là subdomain của
 * `ecoma.io.vn` (A13), mirror production scheme `01` §7; apex `ecoma.io.vn`
 * phục vụ public web (home); Worker internal-only (push, mail, relay, job)
 * giữ mô hình không hostname public (`workers_dev: false`, chỉ Service
 * Binding) nên không có record DNS nào.
 *
 * Record là placeholder originless theo đúng hướng dẫn Cloudflare ("Create
 * DNS records → Originless setups", fetch 2026-11-20): A record `192.0.2.0`
 * proxied — request proxied bị Cloudflare chặn ở edge trước khi chạm origin,
 * nên Router non-production (route `ecoma.io.vn/*`, cần record proxied theo
 * docs Workers Routes, fetch 2026-11-20) serve mà không cần origin thật.
 */

/** Zone non-production theo A13 — mọi hostname staging là subdomain của zone này. */
export const STAGING_ROOT_ZONE_NAME = 'ecoma.io.vn';

/** Placeholder originless theo docs Cloudflare (RFC 5737 TEST-NET-1), proxied. */
export const STAGING_RECORD_PLACEHOLDER_IPV4 = '192.0.2.0';

/**
 * Unit sở hữu apex theo scheme MOD1 — apex của zone non-production mirror
 * production apex `ecoma.io` (`01` §7: public web = home).
 */
const MOD1_APEX_UNIT_SLUG = 'home';

/**
 * Unit gắn hostname public bằng Wrangler Custom Domain trực tiếp
 * (`02-delivery.md` §4.2: unit persistent mirror production) — Wrangler own
 * record + certificate của attachment, Pulumi KHÔNG được khai record cùng
 * hostname (hai tool cùng own một object là vi phạm §9.1). Unit còn lại
 * (public, chưa có Custom Domain trong wrangler config) vẫn cần record
 * placeholder originless chờ route.
 */
const MOD1_CUSTOM_DOMAIN_UNIT_SLUGS = ['home'];

/**
 * Unit internal-only theo scheme MOD1 (`02-delivery.md`: "push, mail, relay,
 * job") — không hostname public, không record. Job bắt bằng suffix `-job`
 * (auth-nonce-prune-job, transactional-mailer-job, web-push-notification-job);
 * hai unit vai trò còn lại khai tường minh đúng liệt kê của scheme.
 */
const MOD1_INTERNAL_ONLY_UNIT_SLUGS = [
  'push-notification',
  'transactional-mail',
  'staff-access-relay',
];

/** Prefix org của Nx project trong workspace (mirror `staging-environments.ts`). */
const ORG_PREFIX = '@ecoma-io/';

/** Shape tối thiểu của `config/deploy-eligibility.jsonc` mà module này đọc. */
export interface StagingEligibilityConfig {
  projects?: Record<string, { staging?: string }>;
}

/** Một record DNS staging cần khai trên zone root. */
export interface StagingDnsRecordSpec {
  /** Tên resource Pulumi (một phần URN) — suy từ slug unit, dùng được làm id. */
  urnSlug: string;
  /** FQDN của record: apex là chính zone name, unit public là `<slug>.<zone>`. */
  hostname: string;
  /** TTL 1 = "auto" của Cloudflare (provider v6 bắt buộc khai `ttl` tường minh). */
  ttl: 1;
  /** Comment ghi vào record trên Cloudflare (giới hạn dashboard ~100 ký tự). */
  comment: string;
}

/** Unit internal-only theo scheme MOD1 → không hostname public, không record. */
export function isInternalOnlyUnit(slug: string): boolean {
  return slug.endsWith('-job') || MOD1_INTERNAL_ONLY_UNIT_SLUGS.includes(slug);
}

/**
 * Validate shape config eligibility đọc từ file JSONC trước khi dùng — thay
 * cast mù `as StagingEligibilityConfig`: dữ liệu sai shape là lỗi chặn với
 * danh sách đầy đủ vấn đề (không đoán, không im lặng bỏ qua). Chỉ các field
 * thực sự được tiêu thụ được kiểm: `projects` và `staging` của từng entry.
 */
export function parseStagingEligibilityConfig(value: unknown): StagingEligibilityConfig {
  const problems: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      `deploy-eligibility.jsonc must parse to a JSON object, got: ${describeValue(value)}`,
    );
  }
  const projects = (value as { projects?: unknown }).projects;
  if (projects !== undefined) {
    if (typeof projects !== 'object' || projects === null || Array.isArray(projects)) {
      problems.push(
        `projects must be an object of project entries, got: ${describeValue(projects)}`,
      );
    } else {
      for (const [project, entry] of Object.entries(projects)) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          problems.push(`projects["${project}"] must be an object, got: ${describeValue(entry)}`);
          continue;
        }
        const staging = (entry as { staging?: unknown }).staging;
        if (staging !== undefined && typeof staging !== 'string') {
          problems.push(
            `projects["${project}"].staging must be a string, got: ${describeValue(staging)}`,
          );
        }
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`deploy-eligibility.jsonc has an invalid shape: ${problems.join('; ')}`);
  }
  return value as StagingEligibilityConfig;
}

/** Mô tả ngắn kiểu giá trị đọc được cho thông điệp lỗi fail-closed. */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Inventory fail-closed từ eligibility config — mirror pattern `stagingUnits`
 * của `tools/delivery/src/staging-environments.ts`: slug suy từ tên project
 * (không suy được an toàn là lỗi chặn, không đoán), inventory rỗng cũng là
 * lỗi chặn (phân loại eligibility hỏng, không phải "không cần record nào").
 */
export function stagingReleaseableSlugs(config: StagingEligibilityConfig): string[] {
  const errors: string[] = [];
  const slugs: string[] = [];
  const projects = Object.entries(config.projects ?? {})
    .filter(([, entry]) => entry.staging === 'releaseable')
    .map(([project]) => project)
    .toSorted();
  for (const project of projects) {
    const slug = project.startsWith(ORG_PREFIX) ? project.slice(ORG_PREFIX.length) : '';
    if (!/^[a-z0-9-]+$/u.test(slug)) {
      errors.push(`project ${project}: cannot derive a safe slug from "${slug}"`);
      continue;
    }
    slugs.push(slug);
  }
  if (errors.length > 0) {
    throw new Error(`staging DNS inventory is unsafe: ${errors.join('; ')}`);
  }
  if (slugs.length === 0) {
    throw new Error(
      'staging DNS inventory is empty — deploy-eligibility.jsonc declares no ' +
        'staging-releaseable project; refusing to guess the record set',
    );
  }
  return slugs;
}

/**
 * Record set theo scheme MOD1 từ eligibility config: mỗi unit public
 * releaseable đúng MỘT record — apex cho home, `<slug>.ecoma.io.vn` cho unit
 * public còn lại; unit internal-only bị loại khỏi record set; unit gắn
 * Custom Domain qua Wrangler (`MOD1_CUSTOM_DOMAIN_UNIT_SLUGS`) cũng bị loại —
 * record của unit đó do Wrangler own khi attach, Pulumi không chạm.
 */
export function stagingDnsRecordSpecs(config: StagingEligibilityConfig): StagingDnsRecordSpec[] {
  return stagingReleaseableSlugs(config)
    .filter((slug) => !isInternalOnlyUnit(slug))
    .filter((slug) => !MOD1_CUSTOM_DOMAIN_UNIT_SLUGS.includes(slug))
    .map((slug) => ({
      urnSlug: slug,
      hostname:
        slug === MOD1_APEX_UNIT_SLUG ? STAGING_ROOT_ZONE_NAME : `${slug}.${STAGING_ROOT_ZONE_NAME}`,
      ttl: 1 as const,
      // Comment cố ý không mang số Issue: provenance thuộc PR/Issue, record
      // DNS chỉ mô tả mục đích vận hành của hostname.
      comment:
        'MOD1 staging hostname; originless placeholder 192.0.2.0 for the non-production Router',
    }));
}

/**
 * Bỏ JSONC thật của eligibility file trước khi `JSON.parse`: comment dòng
 * `//`, comment khối và trailing comma. String-aware: dấu `//` hay `,`
 * trong chuỗi không bị đụng — mirror ngữ nghĩa `stripJsoncComments` của
 * `tools/delivery` (file dùng trailing comma trong khối `"//"` nên
 * `JSON.parse` thuần không đọc được).
 */
export function stripEligibilityJsonc(text: string): string {
  let out = '';
  let index = 0;
  let inString = false;
  while (index < text.length) {
    const char = text[index] as string;
    if (inString) {
      out += char;
      if (char === '\\' && index + 1 < text.length) {
        out += text[index + 1] as string;
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      index += 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      if (end < 0) throw new Error('unterminated block comment in JSONC config');
      index = end + 2;
      continue;
    }
    if (char === ',') {
      let lookahead = index + 1;
      while (lookahead < text.length && /\s/u.test(text[lookahead] as string)) lookahead += 1;
      const next = text[lookahead];
      if (next === '}' || next === ']') {
        index += 1;
        continue;
      }
    }
    out += char;
    index += 1;
  }
  return out;
}
