<script setup lang="ts">
/**
 * Verifications — kết quả verification mới nhất cho các cặp consumer/provider
 * (issue #208), đọc qua BFF (`/api/broker/pacts`).
 *
 * BFF compose từ `/pacticipants` + `/matrix` (selector version cụ thể), nên
 * body trang nhận là **matrix HAL thật**: mỗi row có `consumer.name`,
 * `consumer.version.number`, `provider.name`, `verificationResult`
 * (`{success, verifiedAt}` hoặc null). Trang chọn cặp qua dropdown
 * pacticipant (từ chính các row) và hiện verification mới nhất của từng
 * provider.
 *
 * ⚠️ Chỉ đọc. Publish verification là việc của provider CI qua Pact CLI —
 * dashboard không có nút ghi nào (cùng tinh thần trang Pacts).
 */
import { computed, ref, watch } from 'vue';
import { useI18n } from '#i18n';

import { useAsyncState } from '../composables/use-async-state';
import { brokerFetch } from '../utils/broker-fetch';
import { arrayField } from '../utils/broker-body';

const { t } = useI18n();

interface MatrixRow {
  consumer?: { name?: unknown; version?: { number?: unknown } };
  provider?: { name?: unknown };
  verificationResult?: { success?: unknown; verifiedAt?: unknown } | null;
}

const { state, reload } = useAsyncState(async () => {
  const res = await brokerFetch('/api/broker/pacts');
  const body: unknown = await res.json().catch(() => null);
  if (res.status === 503) {
    return { kind: 'unavailable' as const };
  }
  if (!res.ok) {
    throw new Error(`broker api ${String(res.status)}`);
  }
  const rows = arrayField(body, 'matrix') as MatrixRow[];
  return { kind: 'rows' as const, rows };
});

const isUnavailable = computed(
  () => state.value.kind === 'ready' && state.value.value.kind === 'unavailable',
);

const rows = computed(() =>
  state.value.kind === 'ready' && state.value.value.kind === 'rows' ? state.value.value.rows : [],
);

const nameOf = (value: unknown): string => (typeof value === 'string' ? value : '—');

/** Danh sách consumer duy nhất từ các row — dropdown chọn cặp. */
const consumers = computed(() =>
  [...new Set(rows.value.map((row) => nameOf(row.consumer?.name)))].filter((name) => name !== '—'),
);

/** Consumer đang chọn — mặc định cái đầu. */
const selectedConsumer = ref('');
const effectiveConsumer = computed(() => {
  if (selectedConsumer.value !== '' && consumers.value.includes(selectedConsumer.value)) {
    return selectedConsumer.value;
  }
  return consumers.value[0] ?? '';
});

// Consumer đang chọn biến mất khỏi danh sách (reload sau khi broker đổi dữ
// liệu) ⇒ reset select: fallback của `effectiveConsumer` giữ dữ liệu đúng,
// còn select không được kẹt hiển thị giá trị đã không còn trong dropdown.
watch([selectedConsumer, consumers], ([value]) => {
  if (value !== '' && !consumers.value.includes(value)) {
    selectedConsumer.value = '';
  }
});

/**
 * Rows của consumer đang chọn, gộp theo provider: một provider có nhiều row
 * (nhiều version consumer) thì lấy row có verification mới nhất theo
 * `verifiedAt` — "lịch sử đủ để debug" ở mức API hỗ trợ là verification
 * mới nhất từng provider kèm timestamp.
 */
const providerRows = computed(() => {
  const byProvider = new Map<string, MatrixRow>();
  for (const row of rows.value) {
    if (nameOf(row.consumer?.name) !== effectiveConsumer.value) {
      continue;
    }
    const provider = nameOf(row.provider?.name);
    const existing = byProvider.get(provider);
    // `verifiedAt` là ISO-8601 UTC nên so sánh chuỗi (lexicographic) đúng thứ
    // tự thời gian; `''` (chưa verify) xếp cũ nhất — không bao giờ thắng một
    // row đã có timestamp.
    if (
      existing === undefined ||
      (verifiedAtOf(row) !== '' && verifiedAtOf(row) > verifiedAtOf(existing))
    ) {
      byProvider.set(provider, row);
    }
  }
  return [...byProvider.values()];
});

const verifiedAtOf = (row: MatrixRow): string => {
  const result = row.verificationResult;
  if (result !== null && typeof result === 'object' && typeof result.verifiedAt === 'string') {
    return result.verifiedAt;
  }
  return '';
};

const verificationKind = (row: MatrixRow): 'success' | 'failed' | 'none' => {
  const result = row.verificationResult;
  if (result !== null && typeof result === 'object' && typeof result.success === 'boolean') {
    return result.success ? 'success' : 'failed';
  }
  return 'none';
};

const displayRows = computed(() =>
  providerRows.value.map((row) => ({ row, kind: verificationKind(row) })),
);
</script>

<template>
  <section>
    <PactBrokerPageHeader
      :title="t('verifications.title')"
      :description="t('verifications.description')"
    />

    <PactBrokerLoadingState v-if="state.kind === 'loading'" :label="t('states.loading')" />

    <PactBrokerErrorState
      v-else-if="state.kind === 'error'"
      :title="t('states.errorTitle')"
      :body="t('states.errorBody')"
      :detail="state.message"
      :retry-label="t('states.retry')"
      :on-retry="reload"
    />

    <PactBrokerUnavailableState
      v-else-if="isUnavailable"
      :title="t('states.unavailableTitle')"
      :body="t('states.unavailableBody')"
    />

    <PactBrokerEmptyState v-else-if="rows.length === 0" :message="t('verifications.description')" />

    <template v-else>
      <div v-if="consumers.length > 1" class="mb-4">
        <label class="mb-1 block text-sm font-medium" for="verifications-consumer">
          {{ t('verifications.consumer') }}
        </label>
        <select
          id="verifications-consumer"
          v-model="selectedConsumer"
          data-testid="pact-broker-verifications-consumer-select"
          class="rounded-md border border-border bg-card px-3 py-2 text-sm"
        >
          <option v-for="consumer in consumers" :key="consumer" :value="consumer">
            {{ consumer }}
          </option>
        </select>
      </div>

      <div
        class="overflow-x-auto rounded-lg border border-border"
        data-testid="pact-broker-verifications-table"
      >
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-border bg-muted/40 text-left text-muted-foreground">
              <th class="px-4 py-2 font-medium">{{ t('verifications.consumer') }}</th>
              <th class="px-4 py-2 font-medium">{{ t('verifications.consumerVersion') }}</th>
              <th class="px-4 py-2 font-medium">{{ t('verifications.provider') }}</th>
              <th class="px-4 py-2 font-medium">{{ t('verifications.outcome') }}</th>
              <th class="px-4 py-2 font-medium">{{ t('verifications.verifiedAt') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(entry, index) in displayRows"
              :key="index"
              class="border-b border-border last:border-0"
            >
              <td class="px-4 py-2 font-medium">{{ nameOf(entry.row.consumer?.name) }}</td>
              <td class="px-4 py-2 font-mono text-xs">
                {{ nameOf(entry.row.consumer?.version?.number) }}
              </td>
              <td class="px-4 py-2">{{ nameOf(entry.row.provider?.name) }}</td>
              <td class="px-4 py-2">
                <span
                  v-if="entry.kind === 'success'"
                  class="text-emerald-600 dark:text-emerald-400"
                  >{{ t('pacts.verificationSuccess') }}</span
                >
                <span v-else-if="entry.kind === 'failed'" class="text-red-600 dark:text-red-400">{{
                  t('pacts.verificationFailed')
                }}</span>
                <span v-else class="text-muted-foreground">{{ t('pacts.verificationNone') }}</span>
              </td>
              <td class="px-4 py-2 text-muted-foreground">
                {{ verifiedAtOf(entry.row) || '—' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </section>
</template>
