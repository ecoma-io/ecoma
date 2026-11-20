/**
 * Unit tests của sự suy DNS record staging (`staging-dns.ts`) — pure
 * functions, không chạy Pulumi thật và không đụng API nào. Một test đọc file
 * `deploy-eligibility.jsonc` THẬT trong repo để ghim record set
 * hiện hành: eligibility đổi tập releaseable là test đỏ — đúng chủ đích,
 * vì thay đổi DNS surface phải được review tường minh.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  STAGING_RECORD_PLACEHOLDER_IPV4,
  STAGING_ROOT_ZONE_NAME,
  isInternalOnlyUnit,
  parseStagingEligibilityConfig,
  stagingDnsRecordSpecs,
  stagingReleaseableSlugs,
  stripEligibilityJsonc,
  type StagingEligibilityConfig,
} from './staging-dns.js';

function eligibilityConfig(
  projects: Record<string, { staging?: string }>,
): StagingEligibilityConfig {
  return { projects };
}

describe('stripEligibilityJsonc', () => {
  it('keeps plain JSON untouched', () => {
    const text = '{"a":1,"b":["x"]}';
    expect(stripEligibilityJsonc(text)).toBe(text);
  });

  it('strips line comments and trailing commas so JSON.parse reads the file', () => {
    const text = [
      '{',
      '  // line comment',
      '  "projects": {',
      '    "@ecoma-io/home": {',
      '      "staging": "releaseable",', // trailing comma
      '    },',
      '  },',
      '}',
    ].join('\n');
    expect(JSON.parse(stripEligibilityJsonc(text))).toEqual({
      projects: { '@ecoma-io/home': { staging: 'releaseable' } },
    });
  });

  it('strips block comments and keeps comment markers inside strings', () => {
    const text = '{ "a": "http://x , stays", /* block */ "b": "*/ also stays" }';
    expect(JSON.parse(stripEligibilityJsonc(text))).toEqual({
      a: 'http://x , stays',
      b: '*/ also stays',
    });
  });

  it('throws on an unterminated block comment', () => {
    expect(() => stripEligibilityJsonc('{ "a": /* open')).toThrow(
      'unterminated block comment in JSONC config',
    );
  });
});

describe('stagingReleaseableSlugs', () => {
  it('derives sorted slugs from releaseable entries only', () => {
    const slugs = stagingReleaseableSlugs(
      eligibilityConfig({
        '@ecoma-io/auth-nonce-prune-job': { staging: 'releaseable' },
        '@ecoma-io/home': { staging: 'releaseable' },
        '@ecoma-io/account': { staging: 'excluded' },
        '@ecoma-io/deployment': {},
      }),
    );
    expect(slugs).toEqual(['auth-nonce-prune-job', 'home']);
  });

  it('throws with every unsafe slug listed at once', () => {
    expect(() =>
      stagingReleaseableSlugs(
        eligibilityConfig({
          'bare-slug': { staging: 'releaseable' },
          '@ecoma-io/has.dots': { staging: 'releaseable' },
        }),
      ),
    ).toThrow(/cannot derive a safe slug.*has\.dots.*bare-slug/su);
  });

  it('throws on an empty releaseable inventory instead of guessing', () => {
    expect(() =>
      stagingReleaseableSlugs(eligibilityConfig({ '@ecoma-io/account': { staging: 'excluded' } })),
    ).toThrow(/inventory is empty.*refusing to guess/su);
  });
});

describe('isInternalOnlyUnit', () => {
  it('classifies job and the MOD1 internal-only roles as internal-only', () => {
    for (const slug of [
      'auth-nonce-prune-job',
      'transactional-mailer-job',
      'web-push-notification-job',
      'push-notification',
      'transactional-mail',
      'staff-access-relay',
    ]) {
      expect(isInternalOnlyUnit(slug)).toBe(true);
    }
  });

  it('classifies public surface units as not internal-only', () => {
    for (const slug of ['home', 'account', 'backoffice', 'remote-cache-app']) {
      expect(isInternalOnlyUnit(slug)).toBe(false);
    }
  });
});

describe('parseStagingEligibilityConfig', () => {
  it('accepts a valid config unchanged', () => {
    const config = eligibilityConfig({ '@ecoma-io/home': { staging: 'releaseable' } });
    expect(parseStagingEligibilityConfig(config)).toEqual(config);
  });

  it('throws listing every problem for a non-object root and wrong entry shapes', () => {
    expect(() => parseStagingEligibilityConfig(null)).toThrow(
      /must parse to a JSON object.*null/su,
    );
    expect(() => parseStagingEligibilityConfig([1])).toThrow(
      /must parse to a JSON object.*array/su,
    );
  });

  it('throws for a non-object projects block', () => {
    expect(() => parseStagingEligibilityConfig({ projects: 'nope' })).toThrow(
      /projects must be an object.*string/su,
    );
  });

  it('throws for non-object entries and non-string staging values, all listed at once', () => {
    const bad = {
      projects: {
        '@ecoma-io/home': { staging: 'releaseable' },
        '@ecoma-io/broken-entry': 'not-an-object',
        '@ecoma-io/broken-type': { staging: 42 },
      },
    };
    expect(() => parseStagingEligibilityConfig(bad)).toThrow(
      /broken-entry.*must be an object.*broken-type.*must be a string.*number/su,
    );
  });
});

describe('stagingDnsRecordSpecs', () => {
  it('maps the apex unit home to the zone apex hostname', () => {
    const specs = stagingDnsRecordSpecs(
      eligibilityConfig({ '@ecoma-io/home': { staging: 'releaseable' } }),
    );
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ urnSlug: 'home', hostname: STAGING_ROOT_ZONE_NAME });
  });

  it('drops internal-only units from the record set', () => {
    const specs = stagingDnsRecordSpecs(
      eligibilityConfig({
        '@ecoma-io/home': { staging: 'releaseable' },
        '@ecoma-io/auth-nonce-prune-job': { staging: 'releaseable' },
      }),
    );
    expect(specs.map((spec) => spec.urnSlug)).toEqual(['home']);
  });

  it('maps a future public unit to its subdomain per the MOD1 mirror scheme', () => {
    const specs = stagingDnsRecordSpecs(
      eligibilityConfig({ '@ecoma-io/account': { staging: 'releaseable' } }),
    );
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      urnSlug: 'account',
      hostname: `account.${STAGING_ROOT_ZONE_NAME}`,
    });
  });

  it('keeps every record a proxied originless A placeholder with a bounded comment', () => {
    const specs = stagingDnsRecordSpecs(
      eligibilityConfig({
        '@ecoma-io/home': { staging: 'releaseable' },
        '@ecoma-io/account': { staging: 'releaseable' },
      }),
    );
    for (const spec of specs) {
      expect(spec.ttl).toBe(1);
      expect(spec.comment).toMatch(/MOD1 staging hostname/su);
      expect(spec.comment.length).toBeLessThanOrEqual(100);
      // Comment phải nhắc placeholder để dashboard đọc được gốc giá trị.
      expect(spec.comment).toContain(STAGING_RECORD_PLACEHOLDER_IPV4);
    }
  });

  it('keeps issue provenance out of the record comments', () => {
    const specs = stagingDnsRecordSpecs(
      eligibilityConfig({ '@ecoma-io/home': { staging: 'releaseable' } }),
    );
    for (const spec of specs) {
      expect(spec.comment).not.toMatch(/#\d+/u);
    }
  });
});

describe('real deploy-eligibility.jsonc', () => {
  // Cùng đường dẫn suy tương đối mà `staging-program.ts` dùng — file là nguồn
  // sự thật duy nhất, spec ghim kết quả hiện hành.
  const realConfig = JSON.parse(
    stripEligibilityJsonc(
      readFileSync(
        new URL('../../tools/delivery/config/deploy-eligibility.jsonc', import.meta.url),
        'utf8',
      ),
    ),
  ) as StagingEligibilityConfig;

  it('derives exactly the apex record from the current releaseable inventory', () => {
    const slugs = stagingReleaseableSlugs(realConfig);
    const specs = stagingDnsRecordSpecs(realConfig);
    expect(slugs).toContain('home');
    expect(slugs).toContain('auth-nonce-prune-job');
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ urnSlug: 'home', hostname: STAGING_ROOT_ZONE_NAME });
  });
});
