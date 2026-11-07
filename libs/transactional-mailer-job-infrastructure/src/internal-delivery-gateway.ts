/* -------------------------------------------------------------------------------------------- */
/* Gateway adapter — MailDeliveryGateway over InternalDeliveryClient                             */
/* -------------------------------------------------------------------------------------------- */

/**
 * Adapter bọc `InternalDeliveryClient` thành port `MailDeliveryGateway` của application.
 *
 * Quy tắc phân loại (FR-004, §9.2.2): `401`/`403` là auth-rejected (lỗi của chính worker,
 * không phải provider); `404` là not-found; `400` là contract-rejected; `429`/`5xx` và mọi
 * lỗi network/timeout là transient. Body của response **phải** qua contract validator —
 * một body parse được nhưng sai shape cũng là contract-rejected, không phải found/applied.
 */

import type {
  DeliveryLookupResult,
  MailDeliveryGateway,
  OutcomeReportResult,
} from '@ecoma-io/transactional-mailer-job-application';
import {
  validateGetDeliveryResponse,
  validatePostDeliveryOutcomeResponse,
} from '@ecoma-io/transactional-mail-contracts';

import type { InternalDeliveryClient } from './internal-delivery-client';

/**
 * Vị trí của factory này là **infrastructure**, không phải application hay composition
 * root, vì nó là composition cục bộ của một **port application** với một **adapter
 * infrastructure**: tham số vào là `InternalDeliveryClient` (adapter HTTP cụ thể của tầng
 * này) và kết quả trả về là `MailDeliveryGateway` (port của application). Đặt factory ở
 * application sẽ buộc application import infrastructure — đảo ngược hướng phụ thuộc mà
 * `@nx/enforce-module-boundaries` chặn (`type:application` không được depend
 * `type:infrastructure`); đặt ở composition root (`main.ts`) thì phải nhường chỗ cho wiring
 * cả hai tầng trong entry module, trong khi quy mô wiring của worker chỉ là "gọi factory →
 * truyền use case". Application chỉ biết port; infrastructure biết cả hai đầu và ghim cách
 * ghép chúng — chính là vai trò của tầng này.
 */
export function createGateway(client: InternalDeliveryClient): MailDeliveryGateway {
  return {
    async getDelivery(deliveryId): Promise<DeliveryLookupResult> {
      let response: Response;
      try {
        response = await client.getDelivery(deliveryId);
      } catch {
        // Network/timeout của Service Binding call — transient, message của exception
        // không được ra log nên nuốt ở đây, classification là đủ.
        return { kind: 'transient' };
      }
      if (response.status === 404) {
        return { kind: 'not-found' };
      }
      if (response.status === 401 || response.status === 403) {
        return { kind: 'auth-rejected' };
      }
      if (response.status === 429 || response.status >= 500) {
        return { kind: 'transient' };
      }
      if (response.status !== 200) {
        return { kind: 'contract-rejected' };
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { kind: 'contract-rejected' };
      }
      const validated = validateGetDeliveryResponse(body);
      if (!validated.ok) {
        return { kind: 'contract-rejected' };
      }
      const message = validated.value.message;
      return {
        kind: 'found',
        delivery: {
          deliveryId: message.delivery_id,
          messageId: message.message_id,
          app: message.app,
          status: message.status,
          recipient: message.recipient,
          subject: message.subject,
          body: message.body,
          contentType: message.content_type,
          dispatchGeneration: validated.value.dispatch_generation,
        },
      };
    },

    async reportOutcome(deliveryId, report): Promise<OutcomeReportResult> {
      let response: Response;
      try {
        response = await client.postDeliveryOutcome(deliveryId, {
          outcome: report.outcome,
          ...(report.errorClass === undefined ? {} : { error_class: report.errorClass }),
          dispatch_generation: report.dispatchGeneration,
        });
      } catch {
        return { kind: 'transient' };
      }
      if (response.status === 404) {
        return { kind: 'not-found' };
      }
      if (response.status === 401 || response.status === 403) {
        return { kind: 'auth-rejected' };
      }
      if (response.status === 429 || response.status >= 500) {
        return { kind: 'transient' };
      }
      if (response.status !== 200) {
        return { kind: 'contract-rejected' };
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { kind: 'contract-rejected' };
      }
      const validated = validatePostDeliveryOutcomeResponse(body);
      if (!validated.ok) {
        return { kind: 'contract-rejected' };
      }
      if (validated.value.result === 'stale') {
        return {
          kind: 'stale',
          status: validated.value.status,
          currentDispatchGeneration: validated.value.current_dispatch_generation,
        };
      }
      return { kind: validated.value.result, status: validated.value.status };
    },
  };
}
