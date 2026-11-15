<script setup lang="ts">
/**
 * Nx onboarding — hướng dẫn kết nối workspace Nx với Remote Cache (R21/A33).
 *
 * Ba khối nội dung copy được: endpoint, credential guidance và first-use
 * workflow. ⚠️ Trang **không** hiển thị token nào — credential của developer
 * chỉ show-once ở lúc tạo; khối credential ở đây là hướng dẫn về nơi lấy token
 * và cách thay nó, không phải giá trị.
 *
 * Giá trị endpoint lấy từ runtime config public `remoteCacheCacheEndpoint` —
 * deploy layer ghim (origin `https://cache.<rootHostname>` local, URL Worker
 * ở các lane khác). Vắng ⇒ khối endpoint hiện placeholder, không đoán.
 */
import { computed, ref } from 'vue';
import { useI18n } from '#i18n';
import { Button, Input, Label } from '@ecoma-io/ui-app-shell';

const { t } = useI18n();

const runtimeConfig = useRuntimeConfig();
const cacheEndpoint = computed(() =>
  typeof runtimeConfig.public?.remoteCacheCacheEndpoint === 'string' &&
  runtimeConfig.public.remoteCacheCacheEndpoint.length > 0
    ? runtimeConfig.public.remoteCacheCacheEndpoint
    : 'https://cache.example.invalid',
);

const copied = ref<string | null>(null);

function copyables(): readonly { readonly key: string; readonly value: string }[] {
  return [
    {
      key: 'nx.remoteCacheServer',
      value: `NX_SELF_HOSTED_REMOTE_CACHE_SERVER=${cacheEndpoint.value}`,
    },
    {
      key: 'nx.remoteCacheAccessToken',
      value: 'NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN=<project-scoped-key>',
    },
    { key: 'nx.install', value: t('onboarding.installCommand') },
  ];
}

async function copy(key: string, value: string): Promise<void> {
  if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return;
  try {
    await navigator.clipboard.writeText(value);
    copied.value = key;
  } catch {
    // Clipboard bị từ chối (quyền hạn…) — giá trị vẫn hiển thị để copy tay.
  }
}
</script>

<template>
  <section class="flex flex-1 flex-col gap-6">
    <RemoteCacheAppPageHeader
      :title="t('onboarding.title')"
      :description="t('onboarding.description')"
    />

    <div
      class="max-w-2xl rounded-lg border border-border bg-card p-4"
      data-testid="remote-cache-app-onboarding"
    >
      <div class="flex flex-col gap-5">
        <div>
          <Label for="onboarding-endpoint">{{ t('onboarding.endpointLabel') }}</Label>
          <div class="mt-2 flex items-center gap-2">
            <Input
              id="onboarding-endpoint"
              readonly
              :model-value="cacheEndpoint"
              class="font-mono text-xs"
              data-testid="remote-cache-app-onboarding-endpoint"
            />
            <Button variant="outline" size="sm" @click="copy('endpoint', cacheEndpoint)">
              {{ copied === 'endpoint' ? t('showOnce.copied') : t('showOnce.copy') }}
            </Button>
          </div>
        </div>

        <div>
          <Label>{{ t('onboarding.credentialLabel') }}</Label>
          <p class="mt-1 text-sm text-muted-foreground">{{ t('onboarding.credentialHint') }}</p>
        </div>

        <div>
          <Label>{{ t('onboarding.installLabel') }}</Label>
          <div class="mt-2 flex items-center gap-2">
            <code
              class="min-w-0 flex-1 overflow-x-auto rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs"
              data-testid="remote-cache-app-onboarding-install"
              >{{ t('onboarding.installCommand') }}</code
            >
            <Button
              variant="outline"
              size="sm"
              @click="copy('nx.install', t('onboarding.installCommand'))"
            >
              {{ copied === 'nx.install' ? t('showOnce.copied') : t('showOnce.copy') }}
            </Button>
          </div>
        </div>

        <div>
          <Label>{{ t('onboarding.configureLabel') }}</Label>
          <div class="mt-2 flex flex-col gap-2">
            <div
              v-for="entry in copyables().filter((item) => item.key !== 'nx.install')"
              :key="entry.key"
              class="flex items-center gap-2"
            >
              <code
                class="min-w-0 flex-1 overflow-x-auto rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs"
                >{{ entry.value }}</code
              >
              <Button
                variant="outline"
                size="sm"
                :data-testid="`remote-cache-app-onboarding-copy-${entry.key}`"
                @click="copy(entry.key, entry.value)"
              >
                {{ copied === entry.key ? t('showOnce.copied') : t('showOnce.copy') }}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div
      class="max-w-2xl rounded-lg border border-border bg-muted/40 px-4 py-4"
      data-testid="remote-cache-app-onboarding-first-use"
    >
      <h2 class="text-sm font-semibold">{{ t('onboarding.firstUseTitle') }}</h2>
      <p class="mt-1 text-sm text-muted-foreground">{{ t('onboarding.firstUseBody') }}</p>
    </div>
  </section>
</template>
