/**
 * Barrel exports cho `@ecoma-io/transactional-mail-contracts`.
 *
 * Contract boundary: chỉ export **public entrypoints** (theo `exports["."]` trong
 * package.json). Không khuyến khích import deep-path — consumer chỉ phụ thuộc vào
 * package root.
 *
 * Tài liệu tham chiếu:
 * - `docs/applications/transactional-mail/01-architecture.md` §5, §7.2
 * - `docs/applications/transactional-mail/02-requirements.md` FR-001–FR-005
 * - `docs/applications/transactional-mailer-job/02-requirements.md`, `03-operations.md`
 */

export {
  MAIL_MESSAGE_STATUS_VALUES,
  MAIL_OUTCOME_VALUES,
  MAIL_ERROR_CLASS_VALUES,
  OUTCOME_RESULT_VALUES,
  MAIL_CONTENT_TYPE,
  isNonEmptyString,
  isPositiveSafeInteger,
  type MailMessageStatus,
  type MailOutcome,
  type MailErrorClass,
  type OutcomeResult,
  type MailContentType,
} from './shared';

export {
  MAIL_COMMAND_VERSION,
  ALLOWED_MAIL_SEND_COMMAND_FIELDS,
  REQUIRED_MAIL_SEND_COMMAND_FIELDS,
  validateMailSendCommand,
  isMailSendCommand,
  type MailSendCommand,
  type MailCommandVersion,
  type MailSendCommandValidationReason,
  type MailSendCommandValidationOk,
  type MailSendCommandValidationFail,
  type MailSendCommandValidation,
} from './mail-command';

export {
  DELIVERY_MESSAGE_FIELDS,
  REQUIRED_DELIVERY_MESSAGE_FIELDS,
  GET_DELIVERY_RESPONSE_FIELDS,
  REQUIRED_GET_DELIVERY_RESPONSE_FIELDS,
  POST_DELIVERY_OUTCOME_REQUEST_FIELDS,
  REQUIRED_POST_DELIVERY_OUTCOME_REQUEST_FIELDS,
  POST_DELIVERY_OUTCOME_RESPONSE_FIELDS,
  POST_DELIVERY_OUTCOME_RESPONSE_STALE_FIELDS,
  validateDeliveryMessage,
  validateGetDeliveryResponse,
  validatePostDeliveryOutcomeRequest,
  validatePostDeliveryOutcomeResponse,
  isDeliveryMessage,
  type DeliveryMessage,
  type GetDeliveryResponse,
  type PostDeliveryOutcomeRequest,
  type PostDeliveryOutcomeResponse,
  type PostDeliveryOutcomeApplied,
  type PostDeliveryOutcomeStale,
  type DeliveryInterfaceValidation,
  type DeliveryInterfaceValidationOk,
  type DeliveryInterfaceValidationFail,
  type DeliveryInterfaceValidationReason,
} from './delivery-interface';

export {
  REQUIRED_POST_MESSAGES_REQUEST_FIELDS,
  ALLOWED_POST_MESSAGES_REQUEST_FIELDS,
  POST_MESSAGES_RESPONSE_FIELDS,
  validatePostMessagesRequest,
  validatePostMessagesResponse,
  isPostMessagesResponse,
  isPostMessagesErrorBody,
  POST_MESSAGES_ERROR_CODE_VALUES,
  type MailMessageTemplate,
  type PostMessagesRequest,
  type PostMessagesResponse,
  type PostMessagesResponseValidation,
  type PostMessagesResponseValidationReason,
  type PostMessagesErrorCode,
  type PostMessagesErrorBody,
  type PostMessagesValidation,
  type PostMessagesValidationOk,
  type PostMessagesValidationFail,
  type PostMessagesValidationReason,
} from './public-messages';
