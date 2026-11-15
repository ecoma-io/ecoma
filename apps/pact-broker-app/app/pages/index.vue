<script setup lang="ts">
/**
 * Overview — landing page với **dữ liệu thật**, không metric bịa (issue #208:
 * overview có dữ liệu thật, không placeholder giả là dữ liệu thật).
 *
 * Số liệu hiển thị chỉ là những gì BFF trả về thật: số pacticipant, số quan
 * hệ consumer/provider (từ ma trận compose của `/api/broker/pacts`) và số
 * verification đã ghi. Không có dữ liệu ⇒ trạng thái rỗng trung thực, KHÔNG
 * hiển thị số 0 giả như thật.
 *
 * Giữ đúng **một** `<h1>` localized; ba link khu vực là điều khiển thật.
 */
import { computed } from 'vue';
import { useI18n } from '#i18n';

import { useAsyncState } from '../composables/use-async-state';
import { brokerFetch } from '../utils/broker-fetch';
import { arrayField } from '../utils/broker-body';

const { t } = useI18n();

interface MatrixRow {
  consumer?: { name?: unknown };
  provider?: { name?: unknown };
  verificationResult?: unknown;
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

const nameOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Số liệu thật đếm từ ma trận: pacticipant, quan hệ cặp, verification có kết quả. */
const stats = computed(() => {
  const participants = new Set<string>();
  const pairs = new Set<string>();
  let verifications = 0;
  for (const row of rows.value) {
    const consumer = nameOf(row.consumer?.name);
    const provider = nameOf(row.provider?.name);
    if (consumer !== '') participants.add(consumer);
    if (provider !== '') participants.add(provider);
    if (consumer !== '' && provider !== '') pairs.add(`${consumer}->${provider}`);
    if (row.verificationResult !== null && row.verificationResult !== undefined) {
      verifications += 1;
    }
  }
  return { participants: participants.size, pairs: pairs.size, verifications };
});

const statCards = computed(
  () =>
    [
      { label: t('overview.statParticipants'), value: stats.value.participants },
      { label: t('overview.statIntegrations'), value: stats.value.pairs },
      { label: t('overview.statVerifications'), value: stats.value.verifications },
    ] as const,
);

/** Khu vực dashboard — link nhanh; matrix + onboarding là trang mới của #208. */
const areas = [
  { titleKey: 'nav.pacts', href: '/pacts' },
  { titleKey: 'nav.verifications', href: '/verifications' },
  { titleKey: 'nav.matrix', href: '/matrix' },
  { titleKey: 'nav.environments', href: '/environments' },
  { titleKey: 'nav.tokens', href: '/tokens' },
  { titleKey: 'nav.onboarding', href: '/onboarding' },
] as const;
</script>

<template>
  <section class="flex flex-1 flex-col gap-6">
    <PactBrokerPageHeader :title="t('overview.title')" :description="t('overview.description')" />

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

    <PactBrokerEmptyState v-else-if="rows.length === 0" :message="t('overview.empty')" />

    <template v-else>
      <dl class="grid gap-3 sm:grid-cols-3" data-testid="pact-broker-overview-stats">
        <div class="rounded-lg border border-border bg-card px-4 py-3">
          <dt class="text-xs text-muted-foreground">{{ statCards[0].label }}</dt>
          <dd class="text-2xl font-semibold">{{ statCards[0].value }}</dd>
        </div>
        <div class="rounded-lg border border-border bg-card px-4 py-3">
          <dt class="text-xs text-muted-foreground">{{ statCards[1].label }}</dt>
          <dd class="text-2xl font-semibold">{{ statCards[1].value }}</dd>
        </div>
        <div class="rounded-lg border border-border bg-card px-4 py-3">
          <dt class="text-xs text-muted-foreground">{{ statCards[2].label }}</dt>
          <dd class="text-2xl font-semibold">{{ statCards[2].value }}</dd>
        </div>
      </dl>

      <nav :aria-label="t('overview.title')">
        <ul class="grid gap-3 sm:grid-cols-3">
          <li v-for="area in areas" :key="area.href">
            <NuxtLink
              :to="area.href"
              class="flex h-full flex-col gap-1 rounded-lg border border-border bg-card px-4 py-3 text-sm transition-colors hover:bg-accent focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] outline-none"
              :data-testid="`overview-area-${area.href.slice(1)}`"
            >
              <span class="font-medium">{{ t(area.titleKey) }}</span>
            </NuxtLink>
          </li>
        </ul>
      </nav>
    </template>
  </section>
</template>
