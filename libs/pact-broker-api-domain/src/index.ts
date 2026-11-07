/**
 * `@ecoma-io/pact-broker-api-domain` — HAL vocabulary, matrix semantics
 * (tri-state can-i-deploy) và input schemas của bounded context
 * `pact-broker` (deploy unit `pact-broker-api`, xem
 * `docs/applications/pact-broker/01-architecture.md`).
 *
 * Thư viện này **không** import Nx project khác, **không** SQL, **không**
 * Node builtin và **không** I/O. WebCrypto (`crypto.subtle`) được phép vì là
 * Web API nền tảng — cùng quy ước `libs/identity-auth-domain`.
 */

export type {
  HalLink,
  HalLinks,
  HalResource,
  PactContent,
  PactResponse,
  VerificationResultRequest,
  VerificationResultResponse,
  MatrixVersionData,
  MatrixTarget,
  MatrixRowData,
  MatrixVersion,
  MatrixRow,
  MatrixResponse,
  CanIDeployResponse,
  PacticipantResponse,
} from './types';

export { HalBuilder, getBaseUrl } from './hal';

export { toSummaryRows, summarizeMatrix } from './matrix-summary';
export type { SummaryTarget, SummaryRow, MatrixSummary, MatrixNotice } from './matrix-summary';

export { decorateMatrixRow } from './matrix-row';

export {
  nameSchema,
  versionSchema,
  tagSchema,
  branchSchema,
  shaSchema,
  idSchema,
  parseId,
  environmentNameSchema,
} from './validation';
export type { ZodType } from './validation';
