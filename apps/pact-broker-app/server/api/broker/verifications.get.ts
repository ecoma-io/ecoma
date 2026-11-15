import { defineEventHandler, getQuery, setResponseStatus } from 'h3';

import { brokerCall } from '../../utils/broker-client';
import { pactBrokerBffConfig } from '../../utils/broker-config';
import { requirePrincipal } from '../../principal';

/**
 * `GET /api/broker/verifications` — **lịch sử verification** của một cặp
 * consumer/provider cho trang Verifications (issue #208).
 *
 * API không có endpoint "liệt kê verification theo cặp" (kết luận #205 quyết
 * định 17 — không tạo API read endpoint mới trong M1). Lịch sử được compose
 * từ những gì HAL hiện có công bố:
 *
 * 1. `GET /pacts/provider/<p>/consumer/<c>/latest` — pact mới nhất của cặp;
 *    body mang `contentSha` + link `pb:pact-version` (pact theo SHA).
 * 2. `GET /pacts/provider/<p>/consumer/<c>/pact-version/<sha>` không cần gọi
 *    riêng: response của hop 1 đã mang đủ (cùng builder `buildPactResponse`).
 *    Verification results không có route list nào — duy nhất record đơn lẻ
 *    `GET .../verification-results/:id`, id chỉ có trong link HAL của matrix
 *    row. Nên "lịch sử" ở đây lấy từ **matrix** (`GET /matrix` với selector
 *    version cụ thể của cặp): mỗi row mang `verificationResult` mới nhất
 *    (`success`, `verifiedAt`).
 *
 * Cụ thể: BFF gọi `/matrix?q[][pacticipant]=<consumer>&q[][version]=<v>` khi
 * caller cung cấp consumer + version; thiếu version thì lấy từ latest pact
 * trước (hop 1). Kết quả là các row matrix của consumer đó — mỗi row một
 * provider, kèm verification mới nhất. Caller (trang) lọc theo provider.
 *
 * Query bắt buộc: `consumer`; tuỳ chọn: `provider`, `version`.
 */
export default defineEventHandler(async (event) => {
  const principal = requirePrincipal(event);

  const config = pactBrokerBffConfig(useRuntimeConfig(event));
  if (config === null) {
    setResponseStatus(event, 503);
    return { error: 'Service Unavailable', code: 'broker_not_configured' };
  }

  const query = getQuery(event);
  const consumer = typeof query.consumer === 'string' ? query.consumer : '';
  if (consumer === '') {
    setResponseStatus(event, 400);
    return { error: 'Bad Request', code: 'consumer_required' };
  }
  const provider = typeof query.provider === 'string' ? query.provider : '';

  // Version: từ query, hoặc resolve từ latest pact của cặp (hop 1).
  let version = typeof query.version === 'string' && query.version !== '' ? query.version : '';
  if (version === '' && provider !== '') {
    const latest = await brokerCall(
      config,
      principal.accessToken,
      `/pacts/provider/${encodeURIComponent(provider)}/consumer/${encodeURIComponent(consumer)}/latest`,
    );
    if (latest.errorCode !== null || latest.status !== 200) {
      setResponseStatus(event, latest.errorCode !== null ? 502 : latest.status);
      return latest.body ?? { error: 'broker_unreachable' };
    }
    // `consumerVersion` nằm ở top-level của pact response (buildPactResponse).
    const latestBody = latest.body as { consumerVersion?: unknown } | null;
    version = typeof latestBody?.consumerVersion === 'string' ? latestBody.consumerVersion : '';
  }
  if (version === '') {
    setResponseStatus(event, 400);
    return { error: 'Bad Request', code: 'version_required' };
  }

  // Hop cuối — matrix với selector cụ thể: mỗi row mang verification mới nhất
  // của cặp (consumer version × provider), kèm `verifiedAt`.
  const params = new URLSearchParams({ 'q[][pacticipant]': consumer });
  params.append('q[][version]', version);
  const result = await brokerCall(config, principal.accessToken, `/matrix?${params.toString()}`);
  setResponseStatus(event, result.errorCode !== null ? 502 : result.status);
  return result.body ?? { error: 'broker_unreachable' };
});
