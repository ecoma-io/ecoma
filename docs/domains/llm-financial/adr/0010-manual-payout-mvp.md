# ADR-0010 — Manual payout MVP và operator controls

Status: Accepted.

Context: MVP không yêu cầu automated payout provider.

Decision: Design backoffice workflow cho accounting staff để inspect payout requests, verify beneficiary và quote, approve/reject, execute bank transfer manually, record bank reference và evidence/receipt, mark paid chỉ sau khi evidence available, reconcile payout against LLM Financial reservation. Recommend maker/checker dual control cho high-risk financial operations. Operator không bao giờ trực tiếp edit EC balance để mark payout complete. Manual-disbursement deadline sau quote confirmation; nếu delay beyond approved validity window, yêu cầu new quote và seller reconfirmation; không silently thay đổi amount/rate sau confirmation.

Related: docs/domains/payout/domain-model.md §4.
