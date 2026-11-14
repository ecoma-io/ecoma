<script setup lang="ts">
/**
 * Matrix / compatibility — verdict `can-i-deploy` cho một pacticipant version
 * nhắm tới một environment (issue #208), đọc qua BFF (`/api/broker/matrix`,
 * `POST /api/broker/can-i-deploy` — truy vấn, không ghi).
 *
 * Tri-state là ý nghĩa sản phẩm cốt lõi (domain-model §2.3):
 * - `true`  → "được deploy" (mọi verification pass);
 * - `false` → có ít nhất một verification fail;
 * - `null`  → **chưa rõ** (thiếu verification) — KHÔNG được hiện như pass.
 * Trang hiển thị cả ba trạng thái bằng văn bản catalog riêng, và unknown
 * dùng màu trung tính (không xanh).
 */
import { computed, ref } from 'vue';
import { useI18n } from '#i18n';

import { useAsyncState } from '../composables/use-async-state';
import { brokerFetch } from '../utils/broker-fetch';

const { t } = useI18n();

const CSRF_COOKIE_NAME = '__Host-pact-broker-csrf';
const CSRF_HEADER_NAME = 'x-ecoma-csrf';

interface MatrixRow {
  consumer?: { name?: unknown; version?: { number?: unknown } };
  provider?: { name?: unknown };
  verificationResult?: { success?: unknown; verifiedAt?: unknown } | null;
}

interface Summary {
  deployable?: unknown;
  reason?: unknown;
}

/** Tải danh sách pacticipant cho dropdown truy vấn. */
const { state: pacticipantsState, reload: reloadPacticipants } = useAsyncState(async () => {
  const res = await brokerFetch('/api/broker/pacticipants');
  const body: unknown = await res.json().catch(() => null);
  if (res.status === 503) {
    return { kind: 'unavailable' as const };
  }
  if (!res.ok) {
    throw new Error(`broker api ${String(res.status)}`);
  }
  const embedded = (body as { _embedded?: { pacticipants?: unknown } })['_embedded'];
  const rows = Array.isArray(embedded?.pacticipants) ? embedded.pacticipants : [];
  const names = rows
    .map((row) => (row as { name?: unknown } | null)?.name)
    .filter((name): name is string => typeof name === 'string' && name !== '');
  return { kind: 'names' as const, names };
});

const isUnavailable = computed(
  () =>
    pacticipantsState.value.kind === 'ready' &&
    pacticipantsState.value.value.kind === 'unavailable',
);

const names = computed(() =>
  pacticipantsState.value.kind === 'ready' && pacticipantsState.value.value.kind === 'names'
    ? pacticipantsState.value.value.names
    : [],
);

const selectedPacticipant = ref('');
const versionInput = ref('');
const environmentInput = ref('');
const asked = ref(false);

/**
 * Kết quả truy vấn can-i-deploy: tri-state nguyên văn của API
 * (`summary.deployable: boolean | null`) + matrix rows kèm reason.
 */
const verdict = ref<
  | { kind: 'deployable'; rows: MatrixRow[] }
  | { kind: 'not-deployable'; rows: MatrixRow[] }
  | { kind: 'unknown'; rows: MatrixRow[] }
  | { kind: 'error'; message: string }
  | { kind: 'unavailable' }
  | null
>(null);

const busy = ref(false);

/** Cookie CSRF vắng mặt — lỗi fail-closed hiển thị thay vì gửi request 401. */
const csrfMissing = ref(false);

/** Đọc cookie CSRF cho double-submit (ADR-0031 §3). Base64url thuần, không encode. */
function readCsrfToken(): string | undefined {
  if (typeof document === 'undefined') {
    return undefined;
  }
  for (const part of document.cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === CSRF_COOKIE_NAME) {
      return rest.join('=');
    }
  }
  return undefined;
}

const kindOf = (value: unknown): 'deployable' | 'not-deployable' | 'unknown' => {
  if (value === true) {
    return 'deployable';
  }
  if (value === false) {
    return 'not-deployable';
  }
  return 'unknown';
};

async function ask(): Promise<void> {
  const pacticipant = selectedPacticipant.value;
  const version = versionInput.value.trim();
  if (pacticipant === '' || version === '') {
    return;
  }
  busy.value = true;
  asked.value = true;
  verdict.value = null;
  csrfMissing.value = false;
  try {
    const csrf = readCsrfToken();
    // CSRF cookie vắng mặt ⇒ middleware authn chắc chắn từ chối POST fail-closed
    // — báo lỗi ngay thay vì gửi request 401 mà brokerFetch dịch thành redirect
    // login (kicks người dùng ra login khi bấm Check).
    if (csrf === undefined || csrf === '') {
      csrfMissing.value = true;
      return;
    }
    const res = await brokerFetch('/api/broker/can-i-deploy', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CSRF_HEADER_NAME]: csrf },
      body: JSON.stringify(
        environmentInput.value.trim() === ''
          ? { pacticipant, version }
          : { pacticipant, version, to: environmentInput.value.trim() },
      ),
    });
    const body: unknown = await res.json().catch(() => null);
    if (res.status === 503) {
      verdict.value = { kind: 'unavailable' };
      return;
    }
    if (!res.ok) {
      const detail =
        (body as { message?: unknown } | null)?.message ?? `broker api ${String(res.status)}`;
      verdict.value = { kind: 'error', message: String(detail) };
      return;
    }
    const summary = (body as { summary?: unknown })?.summary as Summary | undefined;
    const rows = Array.isArray((body as { matrix?: unknown }).matrix)
      ? ((body as { matrix: unknown[] }).matrix as MatrixRow[])
      : [];
    verdict.value = { kind: kindOf(summary?.deployable), rows };
  } catch (error) {
    verdict.value = {
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    busy.value = false;
  }
}

const verdictKey = computed(() =>
  verdict.value === null || verdict.value.kind === 'error' || verdict.value.kind === 'unavailable'
    ? ''
    : `matrix.verdict.${verdict.value.kind}`,
);

const nameOf = (value: unknown): string => (typeof value === 'string' ? value : '—');

const verificationKind = (row: MatrixRow): 'success' | 'failed' | 'none' => {
  const result = row.verificationResult;
  if (result !== null && typeof result === 'object' && typeof result.success === 'boolean') {
    return result.success ? 'success' : 'failed';
  }
  return 'none';
};
</script>

<template>
  <section>
    <PactBrokerPageHeader :title="t('matrix.title')" :description="t('matrix.description')" />

    <PactBrokerLoadingState
      v-if="pacticipantsState.kind === 'loading'"
      :label="t('states.loading')"
    />

    <PactBrokerErrorState
      v-else-if="pacticipantsState.kind === 'error'"
      :title="t('states.errorTitle')"
      :body="t('states.errorBody')"
      :detail="pacticipantsState.message"
      :retry-label="t('states.retry')"
      :on-retry="reloadPacticipants"
    />

    <PactBrokerUnavailableState
      v-else-if="isUnavailable"
      :title="t('states.unavailableTitle')"
      :body="t('states.unavailableBody')"
    />

    <PactBrokerEmptyState v-else-if="names.length === 0" :message="t('matrix.description')" />

    <template v-else>
      <form
        class="mb-6 flex flex-wrap items-end gap-3"
        data-testid="pact-broker-matrix-form"
        @submit.prevent="ask"
      >
        <div>
          <label class="mb-1 block text-sm font-medium" for="matrix-pacticipant">
            {{ t('matrix.pacticipant') }}
          </label>
          <select
            id="matrix-pacticipant"
            v-model="selectedPacticipant"
            data-testid="pact-broker-matrix-pacticipant"
            class="rounded-md border border-border bg-card px-3 py-2 text-sm"
          >
            <option value="" disabled>{{ t('matrix.choosePacticipant') }}</option>
            <option v-for="name in names" :key="name" :value="name">{{ name }}</option>
          </select>
        </div>
        <div>
          <label class="mb-1 block text-sm font-medium" for="matrix-version">
            {{ t('matrix.version') }}
          </label>
          <input
            id="matrix-version"
            v-model="versionInput"
            type="text"
            data-testid="pact-broker-matrix-version"
            class="rounded-md border border-border bg-card px-3 py-2 font-mono text-xs"
          />
        </div>
        <div>
          <label class="mb-1 block text-sm font-medium" for="matrix-environment">
            {{ t('matrix.environment') }}
          </label>
          <input
            id="matrix-environment"
            v-model="environmentInput"
            type="text"
            data-testid="pact-broker-matrix-environment"
            class="rounded-md border border-border bg-card px-3 py-2 font-mono text-xs"
            :placeholder="t('matrix.environmentPlaceholder')"
          />
        </div>
        <button
          type="submit"
          :disabled="busy || selectedPacticipant === '' || versionInput.trim() === ''"
          data-testid="pact-broker-matrix-ask"
          class="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {{ t('matrix.ask') }}
        </button>
      </form>

      <div
        v-if="verdict !== null && verdict.kind === 'unavailable'"
        data-testid="pact-broker-matrix-unavailable"
      >
        <PactBrokerUnavailableState
          :title="t('states.unavailableTitle')"
          :body="t('states.unavailableBody')"
        />
      </div>

      <div
        v-else-if="csrfMissing || (verdict !== null && verdict.kind === 'error')"
        data-testid="pact-broker-matrix-error"
      >
        <PactBrokerErrorState
          :title="t('states.errorTitle')"
          :body="csrfMissing ? t('tokens.csrfMissing') : t('states.errorBody')"
          :detail="verdict !== null && verdict.kind === 'error' ? verdict.message : ''"
          :retry-label="t('matrix.ask')"
          :on-retry="ask"
        />
      </div>

      <template v-else-if="verdict !== null">
        <div
          class="mb-4 rounded-lg border border-border p-4"
          data-testid="pact-broker-matrix-verdict"
        >
          <p
            class="font-medium"
            :class="{
              'text-emerald-600 dark:text-emerald-400': verdict.kind === 'deployable',
              'text-red-600 dark:text-red-400': verdict.kind === 'not-deployable',
              'text-muted-foreground': verdict.kind === 'unknown',
            }"
          >
            {{ t(verdictKey) }}
          </p>
        </div>

        <div
          v-if="verdict.rows.length > 0"
          class="overflow-x-auto rounded-lg border border-border"
          data-testid="pact-broker-matrix-table"
        >
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-border bg-muted/40 text-left text-muted-foreground">
                <th class="px-4 py-2 font-medium">{{ t('pacts.consumer') }}</th>
                <th class="px-4 py-2 font-medium">{{ t('pacts.provider') }}</th>
                <th class="px-4 py-2 font-medium">{{ t('pacts.consumerVersion') }}</th>
                <th class="px-4 py-2 font-medium">{{ t('pacts.verification') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(row, index) in verdict.rows"
                :key="index"
                class="border-b border-border last:border-0"
              >
                <td class="px-4 py-2 font-medium">{{ nameOf(row.consumer?.name) }}</td>
                <td class="px-4 py-2">{{ nameOf(row.provider?.name) }}</td>
                <td class="px-4 py-2 font-mono text-xs">
                  {{ nameOf(row.consumer?.version?.number) }}
                </td>
                <td class="px-4 py-2">
                  <span
                    v-if="verificationKind(row) === 'success'"
                    class="text-emerald-600 dark:text-emerald-400"
                    >{{ t('pacts.verificationSuccess') }}</span
                  >
                  <span
                    v-else-if="verificationKind(row) === 'failed'"
                    class="text-red-600 dark:text-red-400"
                    >{{ t('pacts.verificationFailed') }}</span
                  >
                  <span v-else class="text-muted-foreground">{{
                    t('pacts.verificationNone')
                  }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </template>
  </section>
</template>
