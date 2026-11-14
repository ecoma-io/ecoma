<script setup lang="ts">
/**
 * API tokens — self-service machine credential (issue #207, ADR-0032).
 *
 * ⚠️ **Token bản rõ không bao giờ được lưu lại** (SR-002): plaintext chỉ
 * xuất hiện ĐÚNG MỘT LẦN trong response của POST tạo/rotate — giữ trong state
 * component thuần (bộ nhớ tab), không cookie, không localStorage, không URL;
 * reload mất vĩnh viễn. Bất kỳ route nào của BFF cũng không có đường đọc lại.
 *
 * Ma trận quyền (ADR-0032 §1) enforce ở API side; UI mirror để disable control
 * trước khi gọi — server từ chối 403 là ranh giới thật, ẩn UI không phải.
 * Thao tác destructive (rotate/revoke) đòi confirmation tường minh (ADR-0032
 * §1g) — không step-up re-auth ở M1.
 */
import { computed, ref } from 'vue';

import { useI18n } from '#i18n';

import { useAsyncState } from '../composables/use-async-state';
import { brokerFetch } from '../utils/broker-fetch';

const { t } = useI18n();

const CSRF_COOKIE_NAME = '__Host-pact-broker-csrf';
const CSRF_HEADER_NAME = 'x-ecoma-csrf';

interface TokenRow {
  id?: unknown;
  name?: unknown;
  scopes?: unknown;
  purpose?: unknown;
  createdBy?: unknown;
  createdAt?: unknown;
  revokedAt?: unknown;
}

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

const { state, reload } = useAsyncState(async () => {
  const res = await brokerFetch('/api/broker/machine-tokens');
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

// ============ Tạo credential ============

const createName = ref('');
const createPurpose = ref<'developer' | 'ci'>('developer');
const createScopes = ref<string[]>(['read']);
const creating = ref(false);
const createRejected = ref(false);
const createCsrfMissing = ref(false);

/** Secret show-once đang hiển thị — chỉ sống trong bộ nhớ tab này. */
const revealed = ref<{ name: string; secret: string } | null>(null);

const SCOPE_OPTIONS = ['read', 'write', 'admin'] as const;

function toggleScope(scope: string): void {
  const next = createScopes.value.includes(scope)
    ? createScopes.value.filter((s) => s !== scope)
    : [...createScopes.value, scope];
  createScopes.value = next;
}

async function submitCreate(): Promise<void> {
  if (creating.value || createName.value.trim() === '' || createScopes.value.length === 0) return;
  creating.value = true;
  createRejected.value = false;
  createCsrfMissing.value = false;
  try {
    const csrf = readCsrfToken();
    // CSRF cookie vắng mặt ⇒ request chắc chắn bị từ chối fail-closed — báo lỗi
    // ngay thay vì gửi request 401/403 im lặng.
    if (csrf === undefined || csrf === '') {
      createCsrfMissing.value = true;
      createRejected.value = true;
      return;
    }
    const res = await brokerFetch('/api/broker/machine-tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CSRF_HEADER_NAME]: csrf },
      body: JSON.stringify({
        name: createName.value.trim(),
        scopes: createScopes.value,
        purpose: createPurpose.value,
      }),
    });
    const body: unknown = await res.json().catch(() => null);
    if (res.ok) {
      const secret = (body as { secret?: unknown }).secret;
      if (typeof secret === 'string' && secret !== '') {
        revealed.value = { name: createName.value.trim(), secret };
      }
      createName.value = '';
      createScopes.value = ['read'];
      await reload();
    } else {
      createRejected.value = true;
    }
  } catch {
    createRejected.value = true;
  } finally {
    creating.value = false;
  }
}

/** Copy secret một lần — không giữ giá trị trong clipboard state nào khác. */
const copied = ref(false);
async function copySecret(): Promise<void> {
  if (revealed.value === null) return;
  try {
    await navigator.clipboard.writeText(revealed.value.secret);
    copied.value = true;
  } catch {
    // Clipboard bị từ chối (permission/HTTP không secure) — giữ nút "Copy",
    // người dùng vẫn đọc plaintext trực tiếp.
  }
}

/** Snippet CLI copy-được kèm token vừa tạo (issue #207). */
const cliSnippet = computed(() =>
  revealed.value === null
    ? ''
    : `pact-broker publish --broker-base-url $PACT_BROKER_BASE_URL \\\n  --token '${revealed.value.secret}' …`,
);

// ============ Rotate / revoke — destructive, confirmation tường minh ============

const confirmTarget = ref<{ id: string; name: string; action: 'rotate' | 'revoke' } | null>(null);
const confirmName = ref('');
const mutating = ref(false);
const mutateError = ref(false);
const mutateCsrfMissing = ref(false);

function askConfirm(id: string, name: string, action: 'rotate' | 'revoke'): void {
  confirmTarget.value = { id, name, action };
  confirmName.value = '';
  mutateError.value = false;
}

const confirmReady = computed(
  () => confirmTarget.value !== null && confirmName.value === confirmTarget.value.name,
);

async function runConfirm(): Promise<void> {
  const target = confirmTarget.value;
  if (target === null || !confirmReady.value || mutating.value) return;
  mutating.value = true;
  mutateError.value = false;
  mutateCsrfMissing.value = false;
  try {
    const csrf = readCsrfToken();
    // CSRF cookie vắng mặt ⇒ request chắc chắn bị từ chối fail-closed — báo lỗi
    // ngay thay vì gửi request 401/403 im lặng.
    if (csrf === undefined || csrf === '') {
      mutateCsrfMissing.value = true;
      mutateError.value = true;
      return;
    }
    const res =
      target.action === 'rotate'
        ? await brokerFetch(`/api/broker/machine-tokens/${target.id}/rotate`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              [CSRF_HEADER_NAME]: csrf,
            },
            body: '{}',
          })
        : await brokerFetch(`/api/broker/machine-tokens/${target.id}`, {
            method: 'DELETE',
            headers: { [CSRF_HEADER_NAME]: csrf },
          });
    if (res.ok) {
      if (target.action === 'rotate') {
        const body: unknown = await res.json().catch(() => null);
        const secret = (body as { secret?: unknown }).secret;
        if (typeof secret === 'string' && secret !== '') {
          revealed.value = { name: target.name, secret };
        }
      }
      confirmTarget.value = null;
      await reload();
    } else {
      mutateError.value = true;
    }
  } catch {
    mutateError.value = true;
  } finally {
    mutating.value = false;
  }
}
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
      :message="t('tokens.forbidden')"
    />

    <template v-else>
      <!-- Show-once secret — khối duy nhất chứa plaintext, mất khi reload -->
      <div
        v-if="revealed !== null"
        class="mb-4 rounded-lg border border-warning bg-warning/10 p-4"
        data-testid="pact-broker-token-revealed"
      >
        <p class="mb-1 font-medium">{{ t('tokens.revealed.title') }}</p>
        <p class="mb-2 text-sm text-muted-foreground">
          {{ t('tokens.revealed.hint', { name: revealed.name }) }}
        </p>
        <code
          class="block overflow-x-auto rounded bg-muted/60 p-2 font-mono text-xs"
          data-testid="pact-broker-token-secret"
          >{{ revealed.secret }}</code
        >
        <pre class="mt-2 overflow-x-auto rounded bg-muted/40 p-2 font-mono text-xs">{{
          cliSnippet
        }}</pre>
        <div class="mt-2 flex gap-2">
          <button
            type="button"
            class="rounded border border-border px-2 py-1 text-sm"
            data-testid="pact-broker-token-copy"
            @click="copySecret"
          >
            {{ copied ? t('tokens.copied') : t('tokens.copy') }}
          </button>
          <button
            type="button"
            class="rounded border border-border px-2 py-1 text-sm"
            @click="
              revealed = null;
              copied = false;
            "
          >
            {{ t('tokens.dismiss') }}
          </button>
        </div>
      </div>

      <!-- Tạo credential -->
      <form
        class="mb-6 rounded-lg border border-border p-4"
        data-testid="pact-broker-token-create"
        @submit.prevent="submitCreate"
      >
        <p class="mb-3 font-medium">{{ t('tokens.create.title') }}</p>
        <div class="mb-3 grid gap-3 sm:grid-cols-2">
          <label class="text-sm">
            <span class="mb-1 block text-muted-foreground">{{ t('tokens.name') }}</span>
            <input
              v-model="createName"
              type="text"
              maxlength="255"
              required
              class="w-full rounded border border-border bg-background px-2 py-1"
              data-testid="pact-broker-token-name"
            />
          </label>
          <fieldset class="text-sm">
            <legend class="mb-1 text-muted-foreground">{{ t('tokens.purpose') }}</legend>
            <label class="mr-3">
              <input v-model="createPurpose" type="radio" value="developer" />
              {{ t('tokens.purposeDeveloper') }}
            </label>
            <label>
              <input v-model="createPurpose" type="radio" value="ci" />
              {{ t('tokens.purposeCi') }}
            </label>
          </fieldset>
        </div>
        <fieldset class="mb-3 text-sm">
          <legend class="mb-1 text-muted-foreground">{{ t('tokens.scopes') }}</legend>
          <label v-for="scope in SCOPE_OPTIONS" :key="scope" class="mr-3">
            <input
              type="checkbox"
              :checked="createScopes.includes(scope)"
              @change="toggleScope(scope)"
            />
            {{ scope }}
          </label>
        </fieldset>
        <p v-if="createRejected" class="mb-2 text-sm text-destructive">
          {{ createCsrfMissing ? t('tokens.csrfMissing') : t('tokens.createFailed') }}
        </p>
        <button
          type="submit"
          :disabled="creating || createName.trim() === '' || createScopes.length === 0"
          class="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
          data-testid="pact-broker-token-submit"
        >
          {{ t('tokens.create.submit') }}
        </button>
      </form>

      <!-- Danh sách credential -->
      <div
        class="overflow-x-auto rounded-lg border border-border"
        data-testid="pact-broker-tokens-table"
      >
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-border bg-muted/40 text-left text-muted-foreground">
              <th class="px-4 py-2 font-medium">{{ t('tokens.name') }}</th>
              <th class="px-4 py-2 font-medium">{{ t('tokens.purpose') }}</th>
              <th class="px-4 py-2 font-medium">{{ t('tokens.scopes') }}</th>
              <th class="px-4 py-2 font-medium">{{ t('tokens.creator') }}</th>
              <th class="px-4 py-2 font-medium">{{ t('tokens.createdAt') }}</th>
              <th class="px-4 py-2 font-medium">{{ t('tokens.status') }}</th>
              <th class="px-4 py-2 font-medium"></th>
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
              <td class="px-4 py-2">{{ typeof row.purpose === 'string' ? row.purpose : '—' }}</td>
              <td class="px-4 py-2">
                <span
                  v-for="scope in scopesOf(row.scopes)"
                  :key="scope"
                  class="mr-1 inline-block rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-xs"
                >
                  {{ scope }}
                </span>
              </td>
              <td class="px-4 py-2 font-mono text-xs text-muted-foreground">
                {{ textOf(row.createdBy) }}
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
              <td class="px-4 py-2 text-right">
                <template v-if="row.revokedAt === null || row.revokedAt === undefined">
                  <button
                    type="button"
                    class="mr-2 rounded border border-border px-2 py-1 text-xs"
                    data-testid="pact-broker-token-rotate"
                    @click="askConfirm(String(row.id), String(row.name ?? ''), 'rotate')"
                  >
                    {{ t('tokens.rotate') }}
                  </button>
                  <button
                    type="button"
                    class="rounded border border-destructive px-2 py-1 text-xs text-destructive"
                    data-testid="pact-broker-token-revoke"
                    @click="askConfirm(String(row.id), String(row.name ?? ''), 'revoke')"
                  >
                    {{ t('tokens.revoke') }}
                  </button>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Confirmation destructive — gõ đúng tên credential để mở nút chạy -->
      <div
        v-if="confirmTarget !== null"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        data-testid="pact-broker-token-confirm"
      >
        <div class="w-full max-w-md rounded-lg border border-border bg-background p-4">
          <p class="mb-2 font-medium">
            {{
              confirmTarget.action === 'rotate'
                ? t('tokens.confirm.rotateTitle')
                : t('tokens.confirm.revokeTitle')
            }}
          </p>
          <p class="mb-3 text-sm text-muted-foreground">
            {{ t('tokens.confirm.hint', { name: confirmTarget.name }) }}
          </p>
          <input
            v-model="confirmName"
            type="text"
            class="mb-3 w-full rounded border border-border bg-background px-2 py-1"
            :placeholder="confirmTarget.name"
            data-testid="pact-broker-token-confirm-input"
          />
          <p v-if="mutateError" class="mb-2 text-sm text-destructive">
            {{ mutateCsrfMissing ? t('tokens.csrfMissing') : t('tokens.mutateFailed') }}
          </p>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="rounded border border-border px-3 py-1.5 text-sm"
              @click="confirmTarget = null"
            >
              {{ t('tokens.confirm.cancel') }}
            </button>
            <button
              type="button"
              :disabled="!confirmReady || mutating"
              class="rounded bg-destructive px-3 py-1.5 text-sm text-destructive-foreground disabled:opacity-50"
              data-testid="pact-broker-token-confirm-run"
              @click="runConfirm"
            >
              {{ confirmTarget.action === 'rotate' ? t('tokens.rotate') : t('tokens.revoke') }}
            </button>
          </div>
        </div>
      </div>
    </template>
  </section>
</template>
