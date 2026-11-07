<script setup lang="ts">
/**
 * Pacts — quan hệ consumer/provider đang có pact, đọc qua BFF (`/api/broker/pacts`
 * → `/matrix` của API).
 *
 * ⚠️ **Chỉ đọc.** Publish pact là việc của Pact CLI/CI qua machine token riêng —
 * dashboard không có nút publish nào: với machine token tĩnh chung cho cả
 * dashboard, một nút ghi là ghi với quyền của deploy unit chứ không phải quyền
 * của người dùng (SR-004 theo tinh thần). Thao tác ghi thêm sau khi OIDC session
 * cấp quyền per-user.
 *
 * Matrix trả về HAL-shaped body; `_embedded` chứa row. Trang tự giới hạn hiển
 * thị (MAX_ROWS) thay vì giả định phân trang — API chưa công bố contract phân
 * trang nào cho dashboard.
 */
import { computed } from 'vue';
import { useI18n } from '#i18n';

import { useAsyncState } from '../composables/use-async-state';

const { t } = useI18n();

interface MatrixRow {
  consumer?: { name?: unknown };
  provider?: { name?: unknown };
  consumerVersion?: { number?: unknown };
  pactSha?: unknown;
}

/** Giới hạn hiển thị — trang là quan sát, không phải xuất toàn bộ dữ liệu. */
const MAX_ROWS = 100;

const { state, reload } = useAsyncState(async () => {
  const res = await fetch('/api/broker/pacts');
  const body: unknown = await res.json().catch(() => null);
  if (res.status === 503) {
    // BFF chưa cấu hình — trạng thái unavailable, không phải lỗi lần tải.
    return { kind: 'unavailable' as const };
  }
  if (!res.ok) {
    throw new Error(`broker api ${String(res.status)}`);
  }
  const embedded = (body as { _embedded?: { matrix?: unknown } })['_embedded'];
  const rows = Array.isArray(embedded?.matrix) ? (embedded.matrix as MatrixRow[]) : [];
  return { kind: 'rows' as const, rows: rows.slice(0, MAX_ROWS), total: rows.length };
});

const rows = computed(() =>
  state.value.kind === 'ready' && state.value.value.kind === 'rows' ? state.value.value.rows : [],
);

const isUnavailable = computed(
  () => state.value.kind === 'ready' && state.value.value.kind === 'unavailable',
);

const nameOf = (value: unknown): string => (typeof value === 'string' ? value : '—');
</script>

<template>
  <section>
    <PactBrokerPageHeader :title="t('pacts.title')" :description="t('pacts.description')" />

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

    <PactBrokerEmptyState
      v-else-if="state.kind === 'empty' || rows.length === 0"
      :message="t('pacts.description')"
    />

    <div
      v-else
      class="overflow-x-auto rounded-lg border border-border"
      data-testid="pact-broker-pacts-table"
    >
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-border bg-muted/40 text-left text-muted-foreground">
            <th class="px-4 py-2 font-medium">{{ t('pacts.consumer') }}</th>
            <th class="px-4 py-2 font-medium">{{ t('pacts.provider') }}</th>
            <th class="px-4 py-2 font-medium">{{ t('pacts.latestVersion') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(row, index) in rows"
            :key="index"
            class="border-b border-border last:border-0"
          >
            <td class="px-4 py-2 font-medium">{{ nameOf(row.consumer?.name) }}</td>
            <td class="px-4 py-2">{{ nameOf(row.provider?.name) }}</td>
            <td class="px-4 py-2 font-mono text-xs">
              {{ nameOf(row.consumerVersion?.number) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
