# LLM Seller Governance Domain

Thư viện domain thuần của bounded context `llm-seller-governance` (`@ecoma-io/llm-seller-governance-domain`): restriction record + evaluation, appeal lifecycle, verification/onboarding, legal/tax profile versioned, evidence reference, `FirstPartyLegalPrincipal` + principal association, và operational eligibility suy ra. Ngữ nghĩa nghiệp vụ của context là nội dung canonical của `docs/domains/llm-seller-governance/` — thư viện hiện thực một phần tri thức đó bằng code, không định nghĩa lại ranh giới.

Nx project `@ecoma-io/llm-seller-governance-domain`, tags `type:domain`, `scope:llm-seller`, `runtime:universal`; dependency duy nhất là `@ecoma-io/llm-seller-tenant-domain` — cạnh liên-context duy nhất được allowlist công nhận (`tools/dx/src/architecture/llm-boundaries.ts`), chiều ngược lại bị chặn theo [ADR-0018](../../docs/domains/llm-seller-governance/adr/0018-seller-bounded-context-split.md).

## Purpose

- Tập trung invariant của các quyết định **platform reviewer** về một Seller vào một thư viện thuần TypeScript, tái sử dụng mà không kéo persistence hay transport.
- Là owner duy nhất của operational eligibility verdict: các phần tiêu thụ kết luận (restriction, eligibility) nhận nó như giá trị hợp đồng, không tự đọc evidence pháp lý hay diễn giải restriction record.

## Responsibilities

- **Restriction** (`restriction.ts`): `createRestrictionRecord`, `evaluateRestrictions`, `isRestrictionEffective`, `liftRestriction`, `toPublicRestriction` — "đang bị hạn chế" là giá trị suy ra từ tập record tại thời điểm caller cấp; `publicReason` đi vào projection, `internalReason` thì không ở bất kỳ hình thức nào.
- **Appeal** (`appeal.ts`): `submitAppeal`, `startAppealReview`, `decideAppeal`, `withdrawAppeal`, `toPublicAppeal` với deadline và trạng thái tường minh.
- **Verification và onboarding** (`verification.ts`): `createVerificationCase`, `submitVerificationCase`, `submitPrincipalVerificationCase`, `decideVerification`, `expireVerificationCase`, `deriveOnboardingState`, `deriveOperationalEligibility` — hai subject tách biệt là tenant-scoped và principal-scoped.
- **Legal/tax profile versioned** (`legal-profile.ts`, `tax-profile.ts`): append-only version, kỳ hiệu lực suy ra từ thứ tự version.
- **Evidence reference** (`evidence.ts`): `createEvidenceReference`, `assertEvidenceInTenant`, `assertEvidenceInPrincipal` — tham chiếu bất biến, nội dung tài liệu không nằm ở đây.
- **Principal pháp lý first-party** (`principal.ts`, `principal-association.ts`): `createFirstPartyLegalPrincipal`, `establishFirstPartyPrincipalAssociation`, `acceptPrincipalRevision`, block/unblock.
- **Nhận dạng và lỗi** (`shared.ts`, `errors.ts`): các guard `is*`, `create*Id`, hằng độ dài, `LlmGovernanceResult` (`llmGovernanceOk`/`llmGovernanceFailure`) và catalog `LLM_GOVERNANCE_DOMAIN_ERROR_MESSAGES` — bộ result/error là của riêng governance, không tái dùng mã của tenant.

## Boundaries

- Thuần TypeScript: không database/ORM, không HTTP/network, không Cloudflare Workers API, không filesystem, không đọc clock, không randomness, không global mutable state; thời gian và định danh do caller cấp.
- Phụ thuộc `llm-seller-tenant-domain` **một chiều** và chỉ cho identity/value primitive (`SellerTenantId`, `SellerActorId`, `MembershipId`, `isEpochMillis`, `MAX_OPAQUE_ID_LENGTH`); tenant không phụ thuộc ngược lại — cạnh này được kiểm trên project graph bởi `tools/dx/src/architecture/llm-boundaries.ts`.
- Không sở hữu Seller tenant/ownership/membership/permission grant (thuộc `llm-seller-tenant`) và không sở hữu thuế suất/withholding/treaty (thuộc `llm-financial`); các quyết định còn mở của context được ghi tại [domain model](../../docs/domains/llm-seller-governance/domain-model.md) §8, thư viện không tự chốt thay.

## Development

```bash
pnpm nx run @ecoma-io/llm-seller-governance-domain:lint
pnpm nx run @ecoma-io/llm-seller-governance-domain:typecheck   # tsc --build --emitDeclarationOnly
```

Entry công khai duy nhất là `src/index.ts` (`main` của package); thêm module mới đi kèm spec colocated và export tường minh qua `src/index.ts`.

## Testing

```bash
pnpm nx run @ecoma-io/llm-seller-governance-domain:test        # vitest — spec colocated trong src/
```

Spec colocated cạnh subject — ví dụ `restriction.spec.ts`, `verification.spec.ts`, `principal-association.spec.ts`; `restriction-verdict-boundary.spec.ts` ghim ranh giới không import governance từ phía tenant.

## Related Documentation

- [`docs/domains/llm-seller-governance/README.md`](../../docs/domains/llm-seller-governance/README.md) — bounded context `llm-seller-governance`.
- [`docs/domains/llm-seller-governance/domain-model.md`](../../docs/domains/llm-seller-governance/domain-model.md) — khái niệm, vòng đời, invariant và các quyết định chưa chốt (§8).
- [`docs/domains/llm-seller-governance/adr/`](../../docs/domains/llm-seller-governance/adr/) — index ADR của context (restriction/appeal, verification, tách Seller, data lifecycle).
- [`docs/applications/llm-api/README.md`](../../docs/applications/llm-api/README.md) — application tiêu thụ context này theo catalog Applications.
- [`libs/llm-seller-tenant-domain/`](../llm-seller-tenant-domain/) — dependency một chiều cho identity/value primitive.
- [`docs/architecture/05-code-architecture.md`](../../docs/architecture/05-code-architecture.md) — schema Nx tag và dependency rule (§6, §7).
