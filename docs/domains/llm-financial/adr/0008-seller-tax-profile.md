# ADR-0008 — Seller tax profile, withholding policy, accounting evidence

Status: Accepted (rates/legal categories OPEN).

Context: Seller legal/tax profile và versioned policy. Ownership split: `llm-seller-governance` owns seller legal/tax profile, tax identity, declarations, evidence; `llm-financial` owns tax calculation theo policy đã phê duyệt, withholding liability, accounting entries; `payout` tiêu thụ net payable/payout eligibility qua contract; `llm-marketplace` không sở hữu tax profile.

Decision: Define seller legal/tax profile fields và ownership: seller legal type, tax residency, jurisdiction, effective period, taxable basis, tax rate, withholding amount, evidence và tax identifier, remittance/reconciliation status. Policy versioning theo seller legal type, tax residency, jurisdiction, effective period, taxable basis, tax rate, withholding amount, evidence/tax identifier, remittance/reconciliation status. Preserve distinction giữa individual resident, individual non-resident, business seller categories; không invent additional legal categories hay claim một rate legally confirmed mà không có evidence. Separate seller gross earnings, platform commission/take rate, tax withholding, FX spread, bank fees, net payable, net payout. Tax withholding có thể được recognize tại applicable taxable transaction event; không assume monthly day-20 availability date là automatically tax recognition date. Business entities với no withholding by Ecoma không nhất thiết exempt khỏi own tax obligations. Previously discussed tax assumptions là policy inputs requiring legal/accounting confirmation, không phải hardcoded universal truths.

OPEN: tax treatment, withholding rates, marketplace liability, revenue recognition timing yêu cầu professional approval.

Related: docs/domains/llm-financial/domain-model.md §3; docs/domains/llm-marketplace/README.md.
