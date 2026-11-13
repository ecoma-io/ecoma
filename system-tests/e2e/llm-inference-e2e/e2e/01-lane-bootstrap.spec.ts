/**
 * Kịch bản (b)+(c)+(d) — lane đã bootstrap đúng như deploy unit tuyên bố:
 * superadmin sub là MỘT nguồn duy nhất cho hai tenant; Dronie seller bootstrap
 * đầy đủ (tenant, principal/profile/case approved, credential hash-only duy
 * nhất, offer active, pool healthy, pricing snapshot active); consumer tenant
 * ecoma với đúng-một api key hash-only và funding B1–B4 hội tụ với bảo toàn
 * escrow.
 *
 * Toàn bộ kiểm tra ĐỌC database qua psql (`docker exec`), KHÔNG seed, KHÔNG
 * migration — migration đã chạy bởi lane; suite verify trạng thái bền.
 */

import { describe, expect, it } from 'vitest';

import {
  CONSUMER_TENANT_ID,
  DRONIE_MODEL_ID,
  GATEWAY_DATABASE,
  MARKETPLACE_DATABASE,
  SELLER_TENANT_ID,
  SPONSOR_GRANT_AMOUNT_MINOR,
  SPONSOR_ID,
  TENANT_DATABASE,
  laneConsumerApiKey,
  laneTenantOwnerSub,
  psqlCount,
  psqlQuery,
  sha256Hex,
} from '../support/lane.mts';

describe('lane bootstrap state (b/c/d)', () => {
  it('(b) carries one owner sub from the lane into both the consumer tenant and the dronie seller tenant', () => {
    // MỘT superadmin sub từ luồng provisioning chính thức (lane state) phải là
    // owner của CẢ tenant consumer `ecoma` (bước 9) LẪN seller tenant `dronie`
    // (bước 8a) — hai đường provisioning riêng nhưng một danh tính owner.
    const sub = laneTenantOwnerSub();
    const consumerOwner = psqlQuery(
      TENANT_DATABASE,
      `SELECT owner_sub FROM llm_tenant.tenants WHERE id = '${CONSUMER_TENANT_ID}'`,
    );
    expect(consumerOwner).toBe(sub);
    const sellerOwner = psqlQuery(
      GATEWAY_DATABASE,
      `SELECT owner_sub FROM llm_seller.seller_tenants WHERE id = '${SELLER_TENANT_ID}'`,
    );
    expect(sellerOwner).toBe(sub);
    // Membership owner active của tenant consumer trỏ đúng sub đó.
    const membership = psqlQuery(
      TENANT_DATABASE,
      `SELECT actor, status FROM llm_tenant.memberships WHERE tenant_id = '${CONSUMER_TENANT_ID}' AND revoked_at IS NULL`,
    );
    expect(membership).toBe(`${sub}|active`);
  });

  it('(c) bootstraps the dronie seller as first_party with an approved principal, profile and case', () => {
    const classification = psqlQuery(
      GATEWAY_DATABASE,
      `SELECT classification FROM llm_seller.seller_tenants WHERE id = '${SELLER_TENANT_ID}'`,
    );
    expect(classification).toBe('first_party');

    // Principal của seller tenant ở trạng thái HẬU duyệt — vocabulary của
    // `legal_principals.status` là ('active','reverification_required','blocked')
    // và "active chỉ với tới qua quyết định duyệt thật" (comment migration
    // 0002_seller_governance: reverification_required → active on real
    // approval). Liên kết tenant↔principal nằm ở `principal_associations`
    // (bảng không mang status — eligibility là dẫn xuất từ accepted versions).
    const principalStatus = psqlQuery(
      GATEWAY_DATABASE,
      `SELECT pr.status FROM llm_seller.principal_associations a JOIN llm_seller.legal_principals pr ON pr.principal_id = a.principal_id WHERE a.tenant_id = '${SELLER_TENANT_ID}'`,
    );
    expect(principalStatus).toBe('active');

    // Verification cases approved VỚI attribution: reviewer + decider được ghi
    // trên MỌI case của principal. Case là principal-scoped (tenant_id NULL,
    // subject XOR theo migration) — truy qua liên kết association, không phải
    // `c.tenant_id`. Bootstrap dựng đúng HAI case, một cho mỗi axis legal/tax.
    const principalCases = psqlQuery(
      GATEWAY_DATABASE,
      `SELECT count(*), count(*) FILTER (WHERE c.status = 'approved' AND c.reviewed_by IS NOT NULL AND c.decided_by IS NOT NULL) ` +
        `FROM llm_seller.verification_cases c JOIN llm_seller.principal_associations a ON a.principal_id = c.principal_id ` +
        `WHERE a.tenant_id = '${SELLER_TENANT_ID}'`,
    );
    expect(principalCases).toBe('2|2');
    // Attribution neo profile → case: mỗi axis có ĐÚNG MỘT case approved mà
    // verified_profile_versions phủ đúng profile version association đã accept.
    const legalAttributed = psqlCount(
      GATEWAY_DATABASE,
      `SELECT count(*) FROM llm_seller.verification_cases c ` +
        `JOIN llm_seller.principal_associations a ON a.principal_id = c.principal_id ` +
        `WHERE a.tenant_id = '${SELLER_TENANT_ID}' AND c.status = 'approved' ` +
        `AND c.verified_profile_versions @> jsonb_build_array(jsonb_build_object('axis', 'legal', 'version', a.accepted_legal_profile_version))`,
    );
    expect(legalAttributed).toBe(1);
    const taxAttributed = psqlCount(
      GATEWAY_DATABASE,
      `SELECT count(*) FROM llm_seller.verification_cases c ` +
        `JOIN llm_seller.principal_associations a ON a.principal_id = c.principal_id ` +
        `WHERE a.tenant_id = '${SELLER_TENANT_ID}' AND c.status = 'approved' ` +
        `AND c.verified_profile_versions @> jsonb_build_array(jsonb_build_object('axis', 'tax', 'version', a.accepted_tax_profile_version))`,
    );
    expect(taxAttributed).toBe(1);
  });

  it('(c) keeps exactly one hash-only provider credential and an active offer on a healthy pool', () => {
    // ĐÚNG MỘT credential chưa revoke cho seller tenant — hash-only: SHA-256
    // hex (64 ký tự in thường), không bao giờ plaintext.
    const credentialCount = psqlCount(
      MARKETPLACE_DATABASE,
      `SELECT count(*) FROM llm_marketplace.provider_credentials WHERE seller_tenant_id = '${SELLER_TENANT_ID}' AND revoked_at IS NULL`,
    );
    expect(credentialCount).toBe(1);
    const credentialHash = psqlQuery(
      MARKETPLACE_DATABASE,
      `SELECT credential_hash FROM llm_marketplace.provider_credentials WHERE seller_tenant_id = '${SELLER_TENANT_ID}' AND revoked_at IS NULL`,
    );
    expect(credentialHash).toMatch(/^[0-9a-f]{64}$/u);

    // Offer active cho model Dronie, pool có endpoint healthy (probe 8b).
    const offer = psqlQuery(
      MARKETPLACE_DATABASE,
      `SELECT normalized_model_id, status FROM llm_marketplace.model_offers WHERE seller_tenant_id = '${SELLER_TENANT_ID}' AND status = 'active'`,
    );
    expect(offer).toBe(`${DRONIE_MODEL_ID}|active`);
    const endpointHealth = psqlQuery(
      MARKETPLACE_DATABASE,
      `SELECT e.health, e.url FROM llm_marketplace.upstream_endpoints e JOIN llm_marketplace.endpoint_pools p ON p.id = e.pool_id JOIN llm_marketplace.model_offers o ON o.id = p.offer_id WHERE o.seller_tenant_id = '${SELLER_TENANT_ID}' AND o.status = 'active'`,
    );
    expect(endpointHealth).toContain('healthy');

    // Pricing snapshot active duy nhất cho model — giá serving tồn tại.
    const snapshot = psqlQuery(
      GATEWAY_DATABASE,
      `SELECT model, status, currency FROM llm_seller.pricing_snapshots WHERE model = '${DRONIE_MODEL_ID}' AND status = 'active'`,
    );
    expect(snapshot).toBe(`${DRONIE_MODEL_ID}|active|VND`);
  });

  it('(d) seeds the consumer tenant with exactly one active hash-only api key matching the lane key', () => {
    const keyCount = psqlCount(
      GATEWAY_DATABASE,
      `SELECT count(*) FROM llm_gateway.api_keys WHERE tenant_id = '${CONSUMER_TENANT_ID}' AND revoked_at IS NULL`,
    );
    expect(keyCount).toBe(1);

    // Hash-only deterministic: SHA-256 hex của plaintext key suite đang giữ
    // phải trùng đúng key_hash của row duy nhất — plaintext không nằm trong DB.
    const keyHash = psqlQuery(
      GATEWAY_DATABASE,
      `SELECT key_hash FROM llm_gateway.api_keys WHERE tenant_id = '${CONSUMER_TENANT_ID}' AND revoked_at IS NULL`,
    );
    expect(keyHash).toBe(sha256Hex(laneConsumerApiKey()));
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('(d) converges sponsor funding B1-B4 with the grant credited at the granted amount', () => {
    // B1 — sponsor định danh tồn tại.
    const sponsor = psqlCount(
      GATEWAY_DATABASE,
      `SELECT count(*) FROM llm_financial.sponsors WHERE sponsor_id = '${SPONSOR_ID}'`,
    );
    expect(sponsor).toBe(1);
    // B2 — billing account của tenant consumer.
    const billingAccount = psqlQuery(
      GATEWAY_DATABASE,
      `SELECT billing_account_id FROM llm_financial.billing_accounts WHERE tenant_ref = '${CONSUMER_TENANT_ID}'`,
    );
    expect(billingAccount).not.toBe('');
    // B3 — funding authorization của sponsor cho account đó.
    const authorizationCount = psqlCount(
      GATEWAY_DATABASE,
      `SELECT count(*) FROM llm_financial.sponsor_funding_authorizations a JOIN llm_financial.billing_accounts b ON b.billing_account_id = a.billing_account_id WHERE b.tenant_ref = '${CONSUMER_TENANT_ID}'`,
    );
    expect(authorizationCount).toBeGreaterThanOrEqual(1);
    // B4 — grant khởi tạo kết thúc `credited` với đúng amount minor UC.
    const grant = psqlQuery(
      GATEWAY_DATABASE,
      `SELECT state, amount_minor, amount_denomination FROM llm_financial.sponsor_grants WHERE sponsor_id = '${SPONSOR_ID}' AND billing_account_id = '${billingAccount}'`,
    );
    expect(grant).toBe(`credited|${SPONSOR_GRANT_AMOUNT_MINOR}|UC`);
    // CỐT Ý chỉ ghim hàng aggregate ở đây: projection wallet + ledger
    // (`llm_financial.wallets`, `ledger_entries`) materialize LƯỜI ở request
    // serving ĐẦU TIÊN — `ensureWalletRow` chỉ được gọi từ serving phase
    // (`chat-completions.ts`), bootstrap chỉ ghi aggregate (docblock
    // `bootstrap-financial.mts`: bút toán chạy in-memory trên aggregate). Suite
    // trên lane TRÍNH KIẾN chạy (d) trước mọi serving nên KHÔNG được đòi row
    // wallet tại đây; escrow bảo toàn (net ba leg wallet = grant, global net =
    // 0) được ghim ở spec serving (g) SAU kịch bản (f) — nơi projection chắc
    // chắn đã có theo đúng contract này.
  });
});
