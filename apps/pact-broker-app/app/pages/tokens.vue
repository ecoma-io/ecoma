<script setup lang="ts">
/**
 * API tokens — metadata machine token của tenant, chỉ đọc qua BFF.
 *
 * ⚠️ **Token bản rõ không bao giờ hiện ở trang này** (SR-002): API chỉ trả
 * metadata cho list; giá trị bản rõ chỉ xuất hiện ĐÚNG MỘT LẦN trong response
 * của POST tạo token — đường đó nằm ở Pact CLI/CI (đúng chủ thể dùng token),
 * không ở dashboard. Nếu sau này dashboard có nút tạo token (cần OIDC per-user),
 * response show-once của POST vẫn là hình dạng hợp đồng, không có đường đọc lại.
 *
 * Trang 403 khi token BFF không đủ scope `admin` — truyền nguyên văn để người
 * dùng thấy "không đủ quyền", không biến thành lỗi hệ thống.
 */
import { useI18n } from '#i18n';

import { useAsyncState } from '../composables/use-async-state';

const { t } = useI18n();

interface TokenRow {
  id?: unknown;
  name?: unknown;
  scopes?: unknown;
  createdAt?: unknown;
  revokedAt?: unknown;
}

const { state, reload } = useAsyncState(async () => {
  const res = await fetch('/api/broker/machine-tokens');
  const body: unknown = await res.json().catch(() => null);
  if (res.status === 503) {
    return { kind: 'unavailable' as const };
  }
  if (res.status === 403) {
    return { kind: 'forbidden' as const };
  }
  if (!res.ok) {
    throw new Error(`broker api ${String(res.status)}`);
  }
  const embedded = (body as { _embedded?: { tokens?: unknown } })['_embedded'];
  const rows = Array.isArray(embedded?.tokens) ? (embedded.tokens as TokenRow[]) : [];
  return { kind: 'rows' as const, rows };
});

const stateKind = (s: typeof state.value): string => (s.kind === 'ready' ? s.value.kind : s.kind);

const textOf = (value: unknown): string =>
  typeof value === 'string' && value !== '' ? value : '—';

const scopesOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : [];
</script>

<template>
  <section>
    <PactBrokerPageHeader :title="t('tokens.title')" :description="t('tokens.description')" />

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
      v-else-if="stateKind(state) === 'unavailable'"
      :title="t('states.unavailableTitle')"
      :body="t('states.unavailableBody')"
    />

    <PactBrokerEmptyState
      v-else-if="stateKind(state) === 'forbidden'"
      :message="t('states.errorBody')"
    />

    <PactBrokerEmptyState
      v-else-if="
        state.kind === 'empty' ||
        (state.kind === 'ready' && state.value.kind === 'rows' && state.value.rows.length === 0)
      "
      :message="t('tokens.description')"
    />

    <div
      v-else
      class="overflow-x-auto rounded-lg border border-border"
      data-testid="pact-broker-tokens-table"
    >
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-border bg-muted/40 text-left text-muted-foreground">
            <th class="px-4 py-2 font-medium">{{ t('tokens.name') }}</th>
            <th class="px-4 py-2 font-medium">{{ t('tokens.scopes') }}</th>
            <th class="px-4 py-2 font-medium">{{ t('tokens.createdAt') }}</th>
            <th class="px-4 py-2 font-medium">{{ t('tokens.active') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(row, index) in state.kind === 'ready' && state.value.kind === 'rows'
              ? state.value.rows
              : []"
            :key="typeof row.id === 'string' ? row.id : index"
            class="border-b border-border last:border-0"
          >
            <td class="px-4 py-2 font-medium">{{ textOf(row.name) }}</td>
            <td class="px-4 py-2">
              <span
                v-for="scope in scopesOf(row.scopes)"
                :key="scope"
                class="mr-1 inline-block rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-xs"
              >
                {{ scope }}
              </span>
            </td>
            <td class="px-4 py-2 text-muted-foreground">{{ textOf(row.createdAt) }}</td>
            <td class="px-4 py-2">
              <span
                :class="
                  row.revokedAt === null || row.revokedAt === undefined
                    ? 'text-muted-foreground'
                    : 'text-destructive'
                "
              >
                {{
                  row.revokedAt === null || row.revokedAt === undefined
                    ? t('tokens.active')
                    : t('tokens.revoked')
                }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
