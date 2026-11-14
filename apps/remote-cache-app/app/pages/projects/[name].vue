<script setup lang="ts">
/**
 * Project detail — metadata API key của một project + hai mutation (R19/R20).
 *
 * Đọc: `GET /api/portal/tenants/:tenantName/projects/:projectName/api-keys` —
 * response mang `{project, api_keys}` với metadata **không secret** (hợp đồng
 * BFF bóc bất kỳ field credential nào trước khi trả browser).
 *
 * Mutation:
 * - Tạo key: `POST .../api-keys` — token trả về đi vào hộp thoại show-once.
 * - Revoke: `POST .../api-keys/:keyId/revoke` — hiệu lực ngay, qua dialog xác
 *   nhận; revoke là state change (không DELETE), key còn trong list với
 *   `revoked_at` có giá trị.
 *
 * Phân biệt developer vs trusted CI (R20): cột **Phân lớp** render badge khác
 * nhau — `developer` là key portal cấp (chỉ `read`), `trusted_ci` là key CI
 * (có thể mang `write`). Metadata list phải hiện cả hai phần lớp.
 */
import { computed, ref } from 'vue';
import { useI18n } from '#i18n';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@ecoma-io/ui-app-shell';

import RemoteCacheAppShowOnceDialog from '../../components/RemoteCacheAppShowOnceDialog.vue';
import { useAsyncState } from '../../composables/use-async-state';
import { portalFetch } from '../../utils/portal-fetch';

const { t } = useI18n();

const route = useRoute();
// Route param đã decode bởi vue-router; tên project chỉ là chuỗi hiển thị +
// path segment — encode lại khi ghép URL để tên lạ không đổi cấu trúc path.
const projectName = computed(() => String(route.params.name ?? ''));

const runtimeConfig = useRuntimeConfig();
const tenantName = computed(() =>
  typeof runtimeConfig.public?.remoteCacheTenantName === 'string'
    ? runtimeConfig.public.remoteCacheTenantName
    : '',
);

const keysBasePath = computed(
  () =>
    `/api/portal/tenants/${encodeURIComponent(tenantName.value)}/projects/${encodeURIComponent(projectName.value)}/api-keys`,
);

interface ProjectWire {
  readonly id: string;
  readonly name: string;
  readonly created_at: string;
}

interface KeyMetadataWire {
  readonly id: string;
  readonly scopes: readonly string[];
  readonly credential_class: string;
  readonly revoked_at: string | null;
  readonly created_at: string;
}

interface KeysPage {
  readonly project: ProjectWire;
  readonly api_keys: readonly KeyMetadataWire[];
}

const UNAVAILABLE = Symbol('unavailable');

const { state, reload } = useAsyncState(async (): Promise<KeysPage | typeof UNAVAILABLE> => {
  if (tenantName.value.length === 0 || projectName.value.length === 0) {
    return UNAVAILABLE;
  }
  const res = await portalFetch(keysBasePath.value);
  if (res.status === 404) {
    // Không có project này (hoặc không có tenant) — trạng thái not-found riêng.
    return UNAVAILABLE;
  }
  if (res.status === 503) {
    return UNAVAILABLE;
  }
  if (!res.ok) {
    throw new Error(`portal api ${String(res.status)}`);
  }
  const body: unknown = await res.json().catch(() => null);
  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray((body as { api_keys?: unknown }).api_keys)
  ) {
    throw new Error('unexpected api-keys response shape');
  }
  return body as KeysPage;
});

const isUnavailable = computed(
  () =>
    state.value.kind === 'ready' &&
    (state.value.value as unknown as KeysPage | typeof UNAVAILABLE) === UNAVAILABLE,
);

const keys = computed(() =>
  state.value.kind === 'ready' && Array.isArray((state.value.value as KeysPage).api_keys)
    ? (state.value.value as KeysPage).api_keys
    : [],
);

// ---------------------------------------------------------------- create key --
const creatingKey = ref(false);
const createKeyError = ref<string | null>(null);
const showOnceToken = ref<string | null>(null);

async function createKey(): Promise<void> {
  if (creatingKey.value) return;
  creatingKey.value = true;
  createKeyError.value = null;
  try {
    const res = await portalFetch(keysBasePath.value, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (res.status === 201) {
      const body: unknown = await res.json().catch(() => null);
      const token = (body as { api_key?: { token?: unknown } } | null)?.api_key?.token;
      if (typeof token === 'string' && token.length > 0) {
        showOnceToken.value = token;
        await reload();
      } else {
        createKeyError.value = 'unexpected create-key response shape';
      }
      return;
    }
    createKeyError.value = `portal api ${String(res.status)}`;
  } catch (error) {
    createKeyError.value = error instanceof Error ? error.message : String(error);
  } finally {
    creatingKey.value = false;
  }
}

function closeShowOnce(): void {
  showOnceToken.value = null;
}

// ------------------------------------------------------------------- revoke --
const revokeTarget = ref<KeyMetadataWire | null>(null);
const revoking = ref(false);
const revokeError = ref<string | null>(null);

async function confirmRevoke(): Promise<void> {
  const target = revokeTarget.value;
  if (target === null || revoking.value) return;
  revoking.value = true;
  revokeError.value = null;
  try {
    const res = await portalFetch(`${keysBasePath.value}/${encodeURIComponent(target.id)}/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (res.ok) {
      revokeTarget.value = null;
      await reload();
      return;
    }
    revokeError.value = `portal api ${String(res.status)}`;
  } catch (error) {
    revokeError.value = error instanceof Error ? error.message : String(error);
  } finally {
    revoking.value = false;
  }
}

// ------------------------------------------------------------------ display --
const isoDateOf = (value: string | null): string => {
  if (value === null) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString().slice(0, 10);
};

const isDeveloper = (key: KeyMetadataWire): boolean => key.credential_class === 'developer';
</script>

<template>
  <section class="flex flex-1 flex-col gap-6">
    <RemoteCacheAppPageHeader
      :title="projectName"
      :description="t('projectDetail.keysDescription')"
    >
      <template #actions>
        <Button variant="outline" as-child data-testid="remote-cache-app-back-to-projects">
          <NuxtLink to="/">{{ t('projectDetail.backToProjects') }}</NuxtLink>
        </Button>
      </template>
    </RemoteCacheAppPageHeader>

    <RemoteCacheAppLoadingState v-if="state.kind === 'loading'" :label="t('states.loading')" />

    <RemoteCacheAppErrorState
      v-else-if="state.kind === 'error'"
      :title="t('states.errorTitle')"
      :body="t('states.errorBody')"
      :detail="state.message"
      :retry-label="t('states.retry')"
      :on-retry="reload"
    />

    <RemoteCacheAppUnavailableState
      v-else-if="isUnavailable"
      :title="t('states.unavailableTitle')"
      :body="t('projects.notFound')"
    />

    <template v-else>
      <div class="flex items-center justify-between gap-4">
        <h2 class="text-lg font-semibold" data-testid="remote-cache-app-keys-title">
          {{ t('projectDetail.keysTitle') }}
        </h2>
        <Button
          :disabled="creatingKey"
          data-testid="remote-cache-app-create-key"
          @click="createKey"
        >
          {{ creatingKey ? t('projectDetail.creatingKey') : t('projectDetail.createKey') }}
        </Button>
      </div>

      <p
        v-if="createKeyError"
        class="text-sm text-destructive"
        data-testid="remote-cache-app-create-key-error"
      >
        {{ createKeyError }}
      </p>
      <p
        v-if="revokeError"
        class="text-sm text-destructive"
        data-testid="remote-cache-app-revoke-error"
      >
        {{ revokeError }}
      </p>

      <RemoteCacheAppEmptyState
        v-if="keys.length === 0"
        :message="t('projectDetail.emptyTitle') + ' ' + t('projectDetail.emptyBody')"
      />

      <div
        v-else
        class="overflow-x-auto rounded-lg border border-border"
        data-testid="remote-cache-app-keys-table"
      >
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-border bg-muted/40 text-left text-muted-foreground">
              <th class="px-4 py-2 font-medium">{{ t('projectDetail.classHeader') }}</th>
              <th class="px-4 py-2 font-medium">{{ t('projectDetail.scopesHeader') }}</th>
              <th class="px-4 py-2 font-medium">{{ t('projectDetail.statusHeader') }}</th>
              <th class="px-4 py-2 font-medium">{{ t('projectDetail.createdAtHeader') }}</th>
              <th class="px-4 py-2 font-medium">{{ t('projectDetail.actionsHeader') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="key in keys"
              :key="key.id"
              class="border-b border-border last:border-0"
              :data-testid="`remote-cache-app-key-row-${key.id}`"
            >
              <td class="px-4 py-2">
                <Badge
                  v-if="isDeveloper(key)"
                  variant="secondary"
                  :title="t('projectDetail.developerClassHint')"
                  data-testid="remote-cache-app-key-class-developer"
                >
                  {{ t('projectDetail.developerClass') }}
                </Badge>
                <Badge
                  v-else
                  :title="t('projectDetail.trustedCiClassHint')"
                  data-testid="remote-cache-app-key-class-trusted-ci"
                >
                  {{ t('projectDetail.trustedCiClass') }}
                </Badge>
              </td>
              <td class="px-4 py-2 font-mono text-xs">
                {{ key.scopes.join(' ') }}
              </td>
              <td class="px-4 py-2">
                <span
                  v-if="key.revoked_at === null"
                  class="text-emerald-600 dark:text-emerald-400"
                  >{{ t('projectDetail.activeStatus') }}</span
                >
                <span v-else class="text-muted-foreground">
                  {{ t('projectDetail.revokedStatus') }}
                  ({{ isoDateOf(key.revoked_at) }})
                </span>
              </td>
              <td class="px-4 py-2 font-mono text-xs">{{ isoDateOf(key.created_at) }}</td>
              <td class="px-4 py-2">
                <Button
                  v-if="key.revoked_at === null"
                  variant="destructive"
                  size="sm"
                  :data-testid="`remote-cache-app-revoke-${key.id}`"
                  @click="revokeTarget = key"
                >
                  {{ t('projectDetail.revoke') }}
                </Button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- Revoke confirm: hành động không hoàn tác phải qua một bước xác nhận tường minh.
         data-testid nằm trên phần tử bên trong content — DialogContent là component
         teleport-root nên attribute ngoài KHÔNG kế thừa xuống DOM. -->
    <Dialog :open="revokeTarget !== null" @update:open="revokeTarget = null">
      <DialogContent>
        <DialogHeader>
          <DialogTitle data-testid="remote-cache-app-revoke-confirm">
            {{ t('projectDetail.revokeConfirmTitle') }}
          </DialogTitle>
          <DialogDescription>{{ t('projectDetail.revokeConfirmBody') }}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="revokeTarget = null">
            {{ t('projectDetail.cancel') }}
          </Button>
          <Button
            variant="destructive"
            :disabled="revoking"
            data-testid="remote-cache-app-revoke-confirm-submit"
            @click="confirmRevoke"
          >
            {{ revoking ? t('projectDetail.revoking') : t('projectDetail.revokeConfirmSubmit') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <RemoteCacheAppShowOnceDialog
      v-if="showOnceToken !== null"
      :token="showOnceToken"
      :open="true"
      @confirm="closeShowOnce"
    />
  </section>
</template>
