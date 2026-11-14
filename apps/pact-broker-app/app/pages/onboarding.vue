<script setup lang="ts">
/**
 * Onboarding — cấu hình Pact CLI cho local dev và CI/CD (issue #208).
 *
 * ⚠️ **Mọi lệnh dưới đây được chạy thật với CLI pin** `@pact-foundation/
 * pact-cli@18.10.9` (kết luận #205 quyết định 12; bằng chứng chạy thật trong
 * PR của #208 — syntax lấy từ `--help` và lần chạy thật của từng lệnh, không
 * chế flag). Token KHÔNG BAO GIỜ hiển thị giá trị thật: mọi chỗ token xuất
 * hiện là placeholder `$PACT_BROKER_TOKEN` (SR-002 — secret không bao giờ
 * được render lại ở bất kỳ trang nào).
 */
import { useI18n } from '#i18n';

const { t } = useI18n();

/** CLI version pin — nguồn: PR bằng chứng của #208 (npm view, cài và chạy). */
const CLI_VERSION = '18.10.9';

/** Một khối lệnh copy-được: `code` là nội dung text thuần của `<pre><code>`. */
interface CommandBlock {
  readonly testid: string;
  readonly code: string;
}

const localBlocks: readonly CommandBlock[] = [
  {
    testid: 'pact-broker-onboarding-install',
    code: `npm install --save-dev @pact-foundation/pact-cli@${CLI_VERSION}`,
  },
  {
    testid: 'pact-broker-onboarding-env',
    code: `export PACT_BROKER_BASE_URL=https://api.${'$'}{ROOT_HOST}:${'$'}{TRAEFIK_HOST_PORT}
export PACT_BROKER_TOKEN=<machine-token-from-your-admin>`,
  },
  {
    testid: 'pact-broker-onboarding-publish',
    code: `npx pact-broker publish pact/my-consumer-my-provider.json \\
  --consumer-app-version 1.0.0 \\
  --broker-base-url "$PACT_BROKER_BASE_URL" \\
  --broker-token "$PACT_BROKER_TOKEN"`,
  },
  {
    testid: 'pact-broker-onboarding-verify',
    code: `PACT_BROKER_TOKEN="$PACT_BROKER_TOKEN" npx pact-verifier \\
  --provider-name my-provider \\
  --hostname localhost --port 3000 \\
  --broker-url "$PACT_BROKER_BASE_URL"`,
  },
  {
    testid: 'pact-broker-onboarding-can-i-deploy',
    code: `npx pact-broker can-i-deploy \\
  --pacticipant my-consumer --version 1.0.0 \\
  --to-environment test \\
  --broker-base-url "$PACT_BROKER_BASE_URL" \\
  --broker-token "$PACT_BROKER_TOKEN"`,
  },
];

const ciBlocks: readonly CommandBlock[] = [
  {
    testid: 'pact-broker-onboarding-ci-publish',
    code: `npx pact-broker publish pacts/ \\
  --consumer-app-version "$CI_COMMIT_SHA" \\
  --branch "$CI_COMMIT_BRANCH" \\
  --build-url "$CI_JOB_URL" \\
  --broker-base-url "$PACT_BROKER_BASE_URL" \\
  --broker-token "$PACT_BROKER_TOKEN"`,
  },
  {
    testid: 'pact-broker-onboarding-ci-verify',
    code: `PACT_BROKER_TOKEN="$PACT_BROKER_TOKEN" npx pact-verifier \\
  --provider-name my-provider \\
  --hostname localhost --port "$PORT" \\
  --broker-url "$PACT_BROKER_BASE_URL"`,
  },
  {
    testid: 'pact-broker-onboarding-ci-record-deployment',
    code: `npx pact-broker record-deployment \\
  --pacticipant my-consumer --version "$CI_COMMIT_SHA" \\
  --environment test \\
  --broker-base-url "$PACT_BROKER_BASE_URL" \\
  --broker-token "$PACT_BROKER_TOKEN"`,
  },
];

/** Copy một khối lệnh vào clipboard — điều khiển thật, không phải trang trí. */
async function copyCode(event: MouseEvent): Promise<void> {
  const button = event.currentTarget as HTMLElement | null;
  const block = button?.closest('[data-onboarding-block]');
  const code = block?.querySelector('code')?.textContent ?? '';
  if (code !== '') {
    await navigator.clipboard.writeText(code);
  }
}
</script>

<template>
  <section>
    <PactBrokerPageHeader
      :title="t('onboarding.title')"
      :description="t('onboarding.description')"
    />

    <p class="mb-6 text-sm text-muted-foreground" data-testid="pact-broker-onboarding-pin">
      {{ t('onboarding.pinPrefix') }}
      <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs"
        >@pact-foundation/pact-cli@{{ CLI_VERSION }}</code
      >
    </p>

    <div class="flex flex-col gap-8">
      <div>
        <h2 class="mb-3 text-lg font-semibold">{{ t('onboarding.localTitle') }}</h2>
        <ol class="flex flex-col gap-4">
          <li v-for="block in localBlocks" :key="block.testid" data-onboarding-block>
            <pre
              class="overflow-x-auto rounded-lg border border-border bg-muted/40 p-3 text-xs"
            ><code :data-testid="block.testid">{{ block.code }}</code></pre>
            <button
              type="button"
              class="mt-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
              :data-testid="`${block.testid}-copy`"
              @click="copyCode"
            >
              {{ t('onboarding.copy') }}
            </button>
          </li>
        </ol>
      </div>

      <div>
        <h2 class="mb-3 text-lg font-semibold">{{ t('onboarding.ciTitle') }}</h2>
        <ol class="flex flex-col gap-4">
          <li v-for="block in ciBlocks" :key="block.testid" data-onboarding-block>
            <pre
              class="overflow-x-auto rounded-lg border border-border bg-muted/40 p-3 text-xs"
            ><code :data-testid="block.testid">{{ block.code }}</code></pre>
            <button
              type="button"
              class="mt-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
              :data-testid="`${block.testid}-copy`"
              @click="copyCode"
            >
              {{ t('onboarding.copy') }}
            </button>
          </li>
        </ol>
      </div>

      <div>
        <h2 class="mb-3 text-lg font-semibold">{{ t('onboarding.credentialsTitle') }}</h2>
        <p class="text-sm text-muted-foreground">
          {{ t('onboarding.credentialsBody') }}
        </p>
      </div>
    </div>
  </section>
</template>
