/**
 * Unit test tầng unit (fake ports) cho `admin-provider.ts` — FR-005/006/017/018/020.
 *
 * ⚠️ **Vì sao tầng unit cho một file đã có 27 it trên D1 thật.** Các route test chạy qua
 * `worker.fetch` phủ được happy-path và các reject qua HTTP, nhưng **không** quan sát được:
 * (1) audit record **không được ghi** cho một no-op idempotent (applyHold khi đã ở trạng thái
 * đích — một audit thừa là bằng chứng sai cho §15.7); (2) `claimProviderPrimary` với một
 * provider eligible còn lại trong scope (ambiguity gate — từ chối bằng hàm `selectPrimaryProvider`
 * của routing, tức "ambiguous ở đây" và "ambiguous lúc route" phải cùng định nghĩa);
 * (3) TOCTOU sau retire của `rotateCredential` (đếm lại sau khi ghi — cửa sổ giữa count và
 * write không dựng được tuần tự trên D1 thật); (4) thứ tự resolve credential của
 * `runProviderTest` (compromised phải bị chặn **trước** khi decrypt). Fake ports cho phép
 * quan sát từng lệnh gọi — đây là những hồi quy mà tier integration không bắt được.
 */

import { describe, expect, it } from 'vitest';

import {
  claimProviderPrimary,
  createProvider,
  holdProvider,
  readVapidSubject,
  rotateCredential,
  runProviderTest,
  validateConfigurationForProviderType,
  validateWebPushConfiguration,
  type AdminResult,
  type ProviderProbe,
} from './admin-provider';
import {
  adminFixture,
  APP,
  credentialRecord,
  mappingRecord,
  providerRecord,
  subscriptionRecord,
  T0,
  unused,
} from './fixture-ports';
import type { ProviderTestResult } from './records';

/* -------------------------------------------------------------------------------------- */
/* Helpers kiểu — `expect().toBe()` không thu hẹp union, nên mọi truy cập `.value`/`.reason`  */
/* đi qua hai assert helper này (vitest/no-conditional-expect cấm `if (result.ok)`).          */
/* -------------------------------------------------------------------------------------- */

/** Assert thành công và trả `value` với kiểu đã thu hẹp — cùng mẫu với create-notification.spec. */
function expectOk<T>(result: AdminResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error('mong đợi kết quả thành công');
  }
  return result.value;
}

/* -------------------------------------------------------------------------------------- */
/* Cặp khoá VAPID thật cho test — sinh lúc chạy bằng WebCrypto (cùng hai format material     */
/* với `apps/push-notification/tests/vapid-test-keys.ts`; lib không import được file ở app). */
/* -------------------------------------------------------------------------------------- */

const P256_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * Cặp khoá P-256 hợp lệ — private ở dạng DER PKCS#8 base64url, public ở dạng điểm EC
 * uncompressed 65 octet base64url, đúng hai format mà `verifyVapidKeyPair` import.
 *
 * Cặp chỉ cần **khớp nhau trong cùng một lần chạy** (một command rotation dùng đúng một
 * cặp), nên `generateKey` là đủ — fixture này không cần tất định giữa các lần chạy.
 */
async function vapidPair(): Promise<{
  readonly privateKeyBase64Url: string;
  readonly publicKeyBase64Url: string;
}> {
  const pair = await crypto.subtle.generateKey(P256_ALGORITHM, true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as {
    x?: string;
    y?: string;
  };
  const x = base64ToBytes(jwk.x ?? '');
  const y = base64ToBytes(jwk.y ?? '');
  if (x.length === 0 || y.length === 0) {
    throw new Error('vapid fixture: JWK thiếu toạ độ public key.');
  }
  const point = new Uint8Array(65);
  point[0] = 0x04;
  point.set(x, 1);
  point.set(y, 33);
  return {
    privateKeyBase64Url: base64Url(pkcs8),
    publicKeyBase64Url: base64Url(point),
  };
}

/** Command đầy đủ cho `rotateCredential` — cặp khoá mới sinh mỗi lần gọi. */
async function baseCommand(): Promise<{
  app: string;
  providerId: string;
  credentialId: string;
  vapidKeyId: string;
  publicKey: string;
  privateKey: string;
  retireVapidKeyId: string | null;
  actor: string;
}> {
  const pair = await vapidPair();
  return {
    app: APP,
    providerId: 'prov-1',
    credentialId: 'cred-new',
    vapidKeyId: 'vapid-k2',
    publicKey: pair.publicKeyBase64Url,
    privateKey: pair.privateKeyBase64Url,
    retireVapidKeyId: 'vapid-k1',
    actor: 'admin-1',
  };
}

function providerFixture(): ReturnType<typeof adminFixture> {
  return adminFixture((ports) => ({
    providers: {
      ...ports.providers,
      findById: async () => providerRecord({}),
    },
    providerCredentials: {
      ...ports.providerCredentials,
      findByVapidKeyId: async (_app, _providerId, vapidKeyId) => credentialRecord({ vapidKeyId }),
      insert: async () => credentialRecord({ vapidKeyId: 'vapid-k2' }),
    },
  }));
}

function materialFixture(): ReturnType<typeof adminFixture> {
  return adminFixture((ports) => ({
    providers: { ...ports.providers, findById: async () => providerRecord({}) },
    subscriptions: {
      ...ports.subscriptions,
      findById: async () => subscriptionRecord({ subscriptionId: 'sub-1', status: 'active' }),
    },
    providerCredentials: {
      ...ports.providerCredentials,
      findByVapidKeyId: async () => credentialRecord({ vapidKeyId: 'vapid-k1' }),
    },
  }));
}

function okProbe(): ProviderProbe & { calls: number } {
  const probe: ProviderProbe & { calls: number } = {
    calls: 0,
    sendTestDelivery: async () => {
      probe.calls += 1;
      return { ok: true as const };
    },
  };
  return probe;
}

function failingProbe(
  classification: ProviderTestResult,
  detail: string,
): ProviderProbe & { calls: number } {
  const probe: ProviderProbe & { calls: number } = {
    calls: 0,
    sendTestDelivery: async () => {
      probe.calls += 1;
      return { ok: false as const, classification, detail };
    },
  };
  return probe;
}

describe('validateWebPushConfiguration — the WB-2 configuration schema', () => {
  it('accepts a configuration carrying a non-empty vapidSubject', () => {
    const result = validateWebPushConfiguration({ vapidSubject: 'mailto:ops@ecoma.io' });
    expect(result.ok).toBe(true);
  });

  it('accepts the snake_case alias when the camelCase key is absent', () => {
    // Worker `buildSendRequest` thử cả ba tên theo đúng thứ tự — validator phải nhận cùng
    // tập đó, nếu không một configuration mà worker ký được lại bị chặn ở create.
    expect(validateWebPushConfiguration({ vapid_subject: 'mailto:ops@ecoma.io' }).ok).toBe(true);
    expect(validateWebPushConfiguration({ subject: 'mailto:ops@ecoma.io' }).ok).toBe(true);
  });

  it('rejects a configuration whose only subject key is an empty string', () => {
    // `''` đi qua `typeof === 'string'` nhưng JWT VAPID thiếu claim `sub` — chặn sớm ở
    // create thay vì để mọi delivery bị provider từ chối.
    const result = validateWebPushConfiguration({ vapidSubject: '' });
    expect(result.ok).toBe(false);
  });

  it('rejects a configuration with no subject key at all', () => {
    expect(validateWebPushConfiguration({}).ok).toBe(false);
  });

  it('rejects a secret-named key even with an empty value', () => {
    // Chỉ riêng TÊN khoá đã là bằng chứng mô hình hoá sai: secret thuộc bảng credential.
    for (const forbidden of ['private_key', 'privateKey', 'secret', 'auth', 'p256dh']) {
      const result = validateWebPushConfiguration({ [forbidden]: '', vapidSubject: 'mailto:x' });
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error('mong đợi một rejection');
      }
      expect(result.reason).toBe('configuration_invalid');
    }
  });

  it('fails closed for a provider type that v1 does not define a schema for', () => {
    // `updateProvider` có thể nhận một record DB có type lạ (ghi bằng đường khác) — record
    // đó KHÔNG được phép cập nhật configuration như thể nó hợp lệ.
    const result = validateConfigurationForProviderType('fcm', { vapidSubject: 'mailto:x' });
    expect(result.ok).toBe(false);
  });
});

describe('readVapidSubject — the key order contract with buildSendRequest', () => {
  it('returns the first non-empty subject in the exact worker key order', () => {
    // Thứ tự `vapidSubject → vapid_subject → subject` phải khớp `buildSendRequest`: hai nơi
    // đọc hai thứ tự khác nhau cho hai JWT khác nhau cho cùng một provider.
    expect(
      readVapidSubject({
        vapidSubject: 'mailto:first@ecoma.io',
        vapid_subject: 'mailto:second@ecoma.io',
        subject: 'mailto:third@ecoma.io',
      }),
    ).toBe('mailto:first@ecoma.io');
    expect(
      readVapidSubject({ vapid_subject: 'mailto:second@ecoma.io', subject: 'mailto:third' }),
    ).toBe('mailto:second@ecoma.io');
  });

  it('returns null instead of inventing a default subject', () => {
    // RFC 8292 §2.1: `sub` OPTIONAL — không có thì JWT không mang claim, KHÔNG bịa
    // `mailto:example@example.com` kiểu web-push lib.
    expect(readVapidSubject({})).toBeNull();
    expect(readVapidSubject({ vapidSubject: 42 })).toBeNull();
    expect(readVapidSubject({ vapidSubject: '' })).toBeNull();
  });
});

describe('createProvider — the makePrimary gate of WB-5', () => {
  it('rejects make_primary before any insert so no provider row and no audit exist', async () => {
    const fixtureBuilt = adminFixture();
    const result = await createProvider(fixtureBuilt, {
      app: APP,
      providerId: 'prov-new',
      transport: 'web',
      type: 'web-push',
      name: 'new',
      configuration: { vapidSubject: 'mailto:ops@ecoma.io' },
      makePrimary: true,
      actor: 'admin-1',
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('mong đợi một rejection');
    }
    expect(result.reason).toBe('state_mismatch');
    // Không insert, không audit: một provider row + audit `provider_created` cho một lệnh bị
    // từ chối là bằng chứng của hai thao tác khi chỉ một được chấp nhận.
    expect(fixtureBuilt.audit.records).toHaveLength(0);
  });

  it('rejects a provider outside the v1 executable scope before inserting', async () => {
    const fixtureBuilt = adminFixture((ports) => ({
      providers: {
        ...ports.providers,
        insert: async () => unused('providers.insert — fcm phải bị chặn trước insert'),
      },
    }));
    const result = await createProvider(fixtureBuilt, {
      app: APP,
      providerId: 'prov-fcm',
      transport: 'web',
      type: 'fcm',
      name: 'fcm',
      configuration: {},
      makePrimary: false,
      actor: 'admin-1',
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('mong đợi một rejection');
    }
    expect(result.reason).toBe('unsupported_provider_scope');
    expect(fixtureBuilt.audit.records).toHaveLength(0);
  });

  it('creates a web-push provider disabled with a provider_created audit', async () => {
    const created = providerRecord({ providerId: 'prov-new', status: 'disabled' });
    const fixtureBuilt = adminFixture((ports) => ({
      providers: { ...ports.providers, insert: async () => created },
    }));
    const result = await createProvider(fixtureBuilt, {
      app: APP,
      providerId: 'prov-new',
      transport: 'web',
      type: 'web-push',
      name: 'new',
      configuration: { vapidSubject: 'mailto:ops@ecoma.io' },
      makePrimary: false,
      actor: 'admin-1',
    });

    expect(result.ok).toBe(true);
    // Provider mới sinh DISABLED: enable là operation riêng với preconditions (§6.1). Sinh
    // enabled cho một provider chưa credential là đưa nó vào routing production.
    if (!result.ok) {
      throw new Error('mong đợi kết quả thành công');
    }
    expect(result.value.status).toBe('disabled');
    expect(fixtureBuilt.audit.records).toHaveLength(1);
    expect(fixtureBuilt.audit.records[0]?.event).toBe('provider_created');
  });
});

describe('holdProvider — idempotent hold must not fabricate audit evidence (§6.5)', () => {
  it('returns the current record without an audit when the provider is already held', async () => {
    const held = providerRecord({ emergencyHold: true });
    const fixtureBuilt = adminFixture((ports) => ({
      providers: {
        ...ports.providers,
        findById: async () => held,
        setEmergencyHold: async () => unused('providers.setEmergencyHold — đã hold thì không ghi'),
      },
    }));
    const result = await holdProvider(fixtureBuilt, {
      app: APP,
      providerId: 'prov-1',
      actor: 'admin-1',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('mong đợi kết quả thành công');
    }
    expect(result.value.emergencyHold).toBe(true);
    // Một audit record cho một thay đổi KHÔNG xảy ra là bằng chứng sai — §15.7 đọc audit để
    // biết đúng những lần hold THẬT.
    expect(fixtureBuilt.audit.records).toHaveLength(0);
  });

  it('audits provider_held exactly once when the hold actually flips the flag', async () => {
    const current = providerRecord({ emergencyHold: false });
    const held = providerRecord({ emergencyHold: true });
    const fixtureBuilt = adminFixture((ports) => ({
      providers: {
        ...ports.providers,
        findById: async () => current,
        setEmergencyHold: async () => held,
      },
    }));
    const result = await holdProvider(fixtureBuilt, {
      app: APP,
      providerId: 'prov-1',
      actor: 'admin-1',
    });

    expect(result.ok).toBe(true);
    expect(fixtureBuilt.audit.records).toHaveLength(1);
    expect(fixtureBuilt.audit.records[0]?.event).toBe('provider_held');
    expect(fixtureBuilt.audit.records[0]?.entityId).toBe('prov-1');
  });
});

describe('claimProviderPrimary — the ambiguity and eligibility gates of §6.1', () => {
  it('refuses to claim primary for a held provider', async () => {
    const held = providerRecord({ emergencyHold: true });
    const fixtureBuilt = adminFixture((ports) => ({
      providers: {
        ...ports.providers,
        findById: async () => held,
        setPrimaryMapping: async () =>
          unused('providers.setPrimaryMapping — provider held phải bị chặn trước'),
      },
    }));
    const result = await claimProviderPrimary(fixtureBuilt, {
      app: APP,
      providerId: 'prov-1',
      actor: 'admin-1',
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('mong đợi một rejection');
    }
    expect(result.reason).toBe('provider_held');
  });

  it('refuses to claim primary for a disabled provider', async () => {
    const disabled = providerRecord({ status: 'disabled' });
    const fixtureBuilt = adminFixture((ports) => ({
      providers: {
        ...ports.providers,
        findById: async () => disabled,
        setPrimaryMapping: async () => unused('providers.setPrimaryMapping — disabled bị chặn'),
      },
    }));
    const result = await claimProviderPrimary(fixtureBuilt, {
      app: APP,
      providerId: 'prov-1',
      actor: 'admin-1',
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('mong đợi một rejection');
    }
    expect(result.reason).toBe('state_mismatch');
  });

  it('refuses a claim that would leave two eligible providers in the scope (ambiguity)', async () => {
    const target = providerRecord({ providerId: 'prov-a' });
    const otherEligible = {
      providerId: 'prov-b',
      app: APP,
      transport: 'web' as const,
      type: 'web-push' as const,
      status: 'enabled' as const,
      emergencyHold: false,
    };
    const fixtureBuilt = adminFixture((ports) => ({
      providers: {
        ...ports.providers,
        findById: async () => target,
        listByScope: async () => [otherEligible],
        setPrimaryMapping: async () =>
          unused('providers.setPrimaryMapping — ambiguity phải chặn trước khi ghi'),
      },
    }));
    const result = await claimProviderPrimary(fixtureBuilt, {
      app: APP,
      providerId: 'prov-a',
      actor: 'admin-1',
    });

    // Cấu hình tạo ambiguity là thứ §6.1 MUST từ chối: routing fail-safe sẽ DỪNG giao thông
    // cho một scope vốn đang phục vụ tốt.
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('mong đợi một rejection');
    }
    expect(result.reason).toBe('state_mismatch');
  });

  it('refuses a claim when the scope is already ambiguous without this provider', async () => {
    const target = providerRecord({ providerId: 'prov-a' });
    const ambiguousPair = [
      {
        providerId: 'prov-b',
        app: APP,
        transport: 'web' as const,
        type: 'web-push' as const,
        status: 'enabled' as const,
        emergencyHold: false,
      },
      {
        providerId: 'prov-c',
        app: APP,
        transport: 'web' as const,
        type: 'web-push' as const,
        status: 'enabled' as const,
        emergencyHold: false,
      },
    ];
    const fixtureBuilt = adminFixture((ports) => ({
      providers: {
        ...ports.providers,
        findById: async () => target,
        listByScope: async () => ambiguousPair,
        setPrimaryMapping: async () => unused('providers.setPrimaryMapping'),
      },
    }));
    const result = await claimProviderPrimary(fixtureBuilt, {
      app: APP,
      providerId: 'prov-a',
      actor: 'admin-1',
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('mong đợi một rejection');
    }
    expect(result.reason).toBe('state_mismatch');
  });

  it('writes the replacement mapping and audits when the scope has no other eligible provider', async () => {
    const target = providerRecord({ providerId: 'prov-a' });
    const mapping = mappingRecord({ providerId: 'prov-a' });
    const fixtureBuilt = adminFixture((ports) => ({
      providers: {
        ...ports.providers,
        findById: async () => target,
        listByScope: async () => [], // không còn ai eligible khác
        setPrimaryMapping: async () => mapping,
      },
    }));
    const result = await claimProviderPrimary(fixtureBuilt, {
      app: APP,
      providerId: 'prov-a',
      actor: 'admin-1',
    });

    const value = expectOk(result);
    expect(value.providerId).toBe('prov-a');
    expect(fixtureBuilt.audit.records).toHaveLength(1);
    expect(fixtureBuilt.audit.records[0]?.detail['change']).toBe('primary_mapping');
  });

  it('reports a lost unique-index race as state_mismatch instead of silent success', async () => {
    const target = providerRecord({ providerId: 'prov-a' });
    const fixtureBuilt = adminFixture((ports) => ({
      providers: {
        ...ports.providers,
        findById: async () => target,
        listByScope: async () => [],
        setPrimaryMapping: async () => null, // partial unique index chặn
      },
    }));
    const result = await claimProviderPrimary(fixtureBuilt, {
      app: APP,
      providerId: 'prov-a',
      actor: 'admin-1',
    });

    // Index chặn = một admin khác tuyên bố trước. Đây là race hợp lệ, KHÔNG phải lỗi — nhưng
    // KHÔNG được coi là thành công im lặng.
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('mong đợi một rejection');
    }
    expect(result.reason).toBe('state_mismatch');
    expect(fixtureBuilt.audit.records).toHaveLength(0);
  });
});

describe('rotateCredential — the retire gate and its TOCTOU close of §7.2', () => {
  it('keeps the old credential active when active subscriptions still reference it', async () => {
    const fixtureBuilt = providerFixture();
    (
      fixtureBuilt.ports.providerCredentials as { countActiveSubscriptionReferences: unknown }
    ).countActiveSubscriptionReferences = async () => 3;

    const result = await rotateCredential(fixtureBuilt, await baseCommand());

    const value = expectOk(result);
    // Rotation vẫn thành công (key mới phục vụ subscription mới) — chỉ là KHÔNG retire.
    expect(value.retiredVapidKeyId).toBeNull();
    // Audit phân biệt "chưa retire vì còn tham chiếu" với "đã retire" bằng giá trị detail.
    expect(fixtureBuilt.audit.records[0]?.detail['retired_vapid_key_id']).toBe(
      'skipped_still_referenced',
    );
  });

  it('retires the old credential when no active subscription references it', async () => {
    const fixtureBuilt = providerFixture();
    let countCalls = 0;
    (
      fixtureBuilt.ports.providerCredentials as { countActiveSubscriptionReferences: unknown }
    ).countActiveSubscriptionReferences = async () => {
      countCalls += 1;
      return 0;
    };
    let retiredCredentialId: string | null = null;
    (fixtureBuilt.ports.providerCredentials as { setStatus: unknown }).setStatus = async (input: {
      credentialId: string;
    }) => {
      retiredCredentialId = input.credentialId;
      return credentialRecord({ vapidKeyId: 'vapid-k1', status: 'retired' });
    };

    const result = await rotateCredential(fixtureBuilt, await baseCommand());

    const value = expectOk(result);
    expect(value.retiredVapidKeyId).toBe('vapid-k1');
    expect(retiredCredentialId).toBe('cred-vapid-k1');
    // Đếm reference đúng HAI lần: trước retire (gate) và sau retire (TOCTOU re-check).
    expect(countCalls).toBe(2);
    expect(fixtureBuilt.audit.records[0]?.detail['retired_vapid_key_id']).toBe('vapid-k1');
  });

  it('reports skipped_still_referenced when a subscription appears between count and retire', async () => {
    // TOCTOU: đếm trước = 0 (được phép retire), đếm sau = 1 (vừa có subscription active
    // mới). Retire ĐÃ xảy ra nhưng kết quả phải được báo là skipped — không phải success
    // im lặng.
    const fixtureBuilt = providerFixture();
    let countCalls = 0;
    (
      fixtureBuilt.ports.providerCredentials as { countActiveSubscriptionReferences: unknown }
    ).countActiveSubscriptionReferences = async () => {
      countCalls += 1;
      return countCalls === 1 ? 0 : 1;
    };
    (fixtureBuilt.ports.providerCredentials as { setStatus: unknown }).setStatus = async () =>
      credentialRecord({ vapidKeyId: 'vapid-k1', status: 'retired' });

    const result = await rotateCredential(fixtureBuilt, await baseCommand());

    const value = expectOk(result);
    expect(value.retiredVapidKeyId).toBeNull();
    expect(fixtureBuilt.audit.records[0]?.detail['retired_vapid_key_id']).toBe(
      'skipped_still_referenced',
    );
  });

  it('does not retire when the old credential row is already gone', async () => {
    const fixtureBuilt = adminFixture((ports) => ({
      providers: { ...ports.providers, findById: async () => providerRecord({}) },
      providerCredentials: {
        ...ports.providerCredentials,
        findByVapidKeyId: async () => null,
        countActiveSubscriptionReferences: async () => 0,
        insert: async () => credentialRecord({ vapidKeyId: 'vapid-k2' }),
        setStatus: async () => unused('providerCredentials.setStatus — không có row để retire'),
      },
    }));

    const result = await rotateCredential(fixtureBuilt, await baseCommand());

    const value = expectOk(result);
    expect(value.retiredVapidKeyId).toBeNull();
  });

  it('encrypts the private key before insert so a cipher failure leaves no credential row', async () => {
    // Mã hoá TRƯỚC khi ghi: một lỗi cipher giữa chừng không được để lại credential `active`
    // mà không có ciphertext.
    const order: string[] = [];
    const fixtureBuilt = adminFixture((ports) => ({
      providers: { ...ports.providers, findById: async () => providerRecord({}) },
      credentialCipher: {
        ...ports.credentialCipher,
        encrypt: async (plaintext) => {
          order.push('encrypt');
          return { ciphertext: new TextEncoder().encode(plaintext), version: 'K1' };
        },
      },
      providerCredentials: {
        ...ports.providerCredentials,
        countActiveSubscriptionReferences: async () => 0,
        findByVapidKeyId: async () => credentialRecord({ vapidKeyId: 'vapid-k1' }),
        insert: async () => {
          order.push('insert');
          return credentialRecord({ vapidKeyId: 'vapid-k2' });
        },
        setStatus: async () => credentialRecord({ vapidKeyId: 'vapid-k1', status: 'retired' }),
      },
    }));

    await rotateCredential(fixtureBuilt, await baseCommand());
    expect(order).toEqual(['encrypt', 'insert']);
  });
});

describe('runProviderTest — the FR-018 classification order', () => {
  const command = {
    app: APP,
    providerId: 'prov-1',
    subscriptionId: 'sub-1',
    actor: 'admin-1',
    payloadJson: JSON.stringify({ title: 'title', body: 'body' }),
  };

  it('blocks a transport-mismatched subscription before resolving any credential', async () => {
    let credentialLookups = 0;
    const fixtureBuilt = adminFixture((ports) => ({
      providers: { ...ports.providers, findById: async () => providerRecord({}) },
      subscriptions: {
        ...ports.subscriptions,
        findById: async () =>
          subscriptionRecord({ subscriptionId: 'sub-1', status: 'active', transport: 'app' }),
      },
      providerCredentials: {
        ...ports.providerCredentials,
        findByVapidKeyId: async () => {
          credentialLookups += 1;
          return credentialRecord({});
        },
      },
    }));
    const result = await runProviderTest(fixtureBuilt, okProbe(), command);

    const value = expectOk(result);
    expect(value.result).toBe('subscription_invalid');
    // Test một subscription khác transport là đo một đường routing không bao giờ chọn —
    // một `delivery_accepted` ở đó là test xanh giả.
    expect(credentialLookups).toBe(0);
    expect(fixtureBuilt.audit.records[0]?.detail['test_result']).toBe('subscription_invalid');
  });

  it('classifies a missing or compromised credential as configuration_invalid without decrypting', async () => {
    let decryptCalls = 0;
    const missing = adminFixture((ports) => ({
      providers: { ...ports.providers, findById: async () => providerRecord({}) },
      subscriptions: {
        ...ports.subscriptions,
        findById: async () => subscriptionRecord({ subscriptionId: 'sub-1', status: 'active' }),
      },
      providerCredentials: {
        ...ports.providerCredentials,
        findByVapidKeyId: async () => null,
        setStatus: async () => unused('setStatus'),
        insert: async () => unused('insert'),
        listByProvider: async () => unused('listByProvider'),
        listEncryptionVersionsInUse: async () => unused('listEncryptionVersionsInUse'),
        countActiveSubscriptionReferences: async () => unused('countActive'),
      },
      credentialCipher: {
        ...ports.credentialCipher,
        decrypt: async () => {
          decryptCalls += 1;
          return 'key';
        },
      },
    }));
    const missingResult = await runProviderTest(missing, okProbe(), command);
    const missingValue = expectOk(missingResult);
    expect(missingValue.result).toBe('configuration_invalid');
    expect(decryptCalls).toBe(0);

    const compromised = adminFixture((ports) => ({
      providers: { ...ports.providers, findById: async () => providerRecord({}) },
      subscriptions: {
        ...ports.subscriptions,
        findById: async () => subscriptionRecord({ subscriptionId: 'sub-1', status: 'active' }),
      },
      providerCredentials: {
        ...ports.providerCredentials,
        findByVapidKeyId: async () => credentialRecord({ status: 'compromised' }),
      },
      credentialCipher: {
        ...ports.credentialCipher,
        decrypt: async () => {
          decryptCalls += 1;
          return 'key';
        },
      },
    }));
    const compromisedResult = await runProviderTest(compromised, okProbe(), command);
    const compromisedValue = expectOk(compromisedResult);
    expect(compromisedValue.result).toBe('configuration_invalid');
    expect(decryptCalls).toBe(0);
  });

  it('classifies a decrypt failure as configuration_invalid instead of a 500', async () => {
    const fixtureBuilt = adminFixture((ports) => ({
      providers: { ...ports.providers, findById: async () => providerRecord({}) },
      subscriptions: {
        ...ports.subscriptions,
        findById: async () => subscriptionRecord({ subscriptionId: 'sub-1', status: 'active' }),
      },
      providerCredentials: {
        ...ports.providerCredentials,
        findByVapidKeyId: async () => credentialRecord({ vapidKeyId: 'vapid-k1' }),
      },
      credentialCipher: {
        ...ports.credentialCipher,
        decrypt: async () => {
          throw new Error('AES-GCM tag mismatch');
        },
      },
    }));
    const result = await runProviderTest(fixtureBuilt, okProbe(), command);

    // Credential hỏng là KẾT QUẢ của test (FR-018), không phải lỗi HTTP: trả 500 kèm message
    // library làm mất cả phân loại lẫn việc không rò secret.
    const value = expectOk(result);
    expect(value.result).toBe('configuration_invalid');
    expect(fixtureBuilt.audit.records[0]?.detail['test_result']).toBe('configuration_invalid');
  });

  it('measures duration from two real clock reads and audits delivery_accepted on success', async () => {
    let nowCalls = 0;
    const fixtureBuilt = adminFixture((ports) => ({
      clock: {
        now: () => {
          nowCalls += 1;
          return T0 + nowCalls * 100;
        },
      },
      providers: { ...ports.providers, findById: async () => providerRecord({}) },
      subscriptions: {
        ...ports.subscriptions,
        findById: async () => subscriptionRecord({ subscriptionId: 'sub-1', status: 'active' }),
      },
      providerCredentials: {
        ...ports.providerCredentials,
        findByVapidKeyId: async () => credentialRecord({ vapidKeyId: 'vapid-k1' }),
      },
    }));
    const result = await runProviderTest(fixtureBuilt, okProbe(), command);

    const value = expectOk(result);
    expect(value.result).toBe('delivery_accepted');
    // durationMs đo bằng HAI lần đọc clock thật (trước + sau probe), không phải `nowOverride`
    // — một mốc cố định cho durationMs = 0 cho mọi lần chạy và làm metric §10.2 vô nghĩa.
    expect(value.durationMs).toBe(100);
    expect(nowCalls).toBeGreaterThanOrEqual(3); // 1 mốc logic + 2 mốc đo
    expect(fixtureBuilt.audit.records[0]?.detail['test_result']).toBe('delivery_accepted');
  });

  it('propagates the adapter classification and detail, and always audits the result', async () => {
    const fixtureBuilt = materialFixture();
    const probe = failingProbe('authentication_failed', 'provider returned 401');
    const result = await runProviderTest(fixtureBuilt, probe, command);

    const value = expectOk(result);
    expect(value.result).toBe('authentication_failed');
    expect(value.detail).toBe('provider returned 401');
    // Test fail LẶP lại là bằng chứng cho incident §15.3 — audit ghi CẢ khi test fail.
    expect(fixtureBuilt.audit.records[0]?.detail['test_result']).toBe('authentication_failed');
  });
});
