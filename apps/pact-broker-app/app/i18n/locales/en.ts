/**
 * Message catalog tiếng Anh — **nguồn sự thật cho tập key** của toàn bộ UI
 * dashboard.
 *
 * Catalog này định nghĩa *key*, không phải *nội dung*: `vi` và `zh-CN` phải có
 * đúng tập key này. Tính đồng nhất được kiểm bằng `tests/catalogs.spec.ts`, không
 * dựa vào kỷ luật khi viết — một key thừa ở đây là một key mà hai catalog còn lại
 * không dịch, và nó fallback về tiếng Anh ở giữa một giao diện tiếng Việt.
 *
 * Quy ước: `zh-CN` là locale code, còn BCP-47 cho `<html lang>` là `zh-Hans` —
 * hai giá trị khác nhau, khai ở `nuxt.config.ts` (`i18n.locales[].language`).
 *
 * Nhóm `shell`, `shell.search` và `shell.colorMode` dịch **đúng** chuỗi mà
 * library sinh mặc định (`DEFAULT_APP_SHELL_LABELS`): app này chỉ thêm khả năng
 * dịch, không đổi nội dung tiếng Anh mà các app khác vẫn thấy.
 */
export default {
  app: {
    // Tên sản phẩm: là thương hiệu, giữ nguyên trong cả ba locale (không dịch
    // "Ecoma"). Dùng cho accessible name của logo và cho metadata.
    name: 'Ecoma Pact Broker',
  },

  shell: {
    home: 'Home',

    search: {
      button: 'Search',
      placeholder: 'Type a command or search...',
      empty: 'No results found.',
      dialogTitle: 'Command Palette',
      dialogDescription: 'Search for a command to run...',
    },

    colorMode: {
      label: 'Color mode',
      light: 'Light',
      dark: 'Dark',
      system: 'System',
    },

    language: {
      label: 'Language',
      hint: 'Changes the language of the whole dashboard.',
    },
  },

  states: {
    loading: 'Loading…',
    errorTitle: 'Could not load this data',
    // Bổ sung thông tin thay vì lặp lại `errorTitle`, và **không** giả định dòng
    // detail luôn có mặt: state lỗi render detail theo `v-if`, mà `message` có
    // thể rỗng.
    errorBody: 'If a technical detail appears below, it can be shared with support.',
    retry: 'Try again',
    // Broker chưa cấu hình (BFF thiếu base URL / token): trạng thái unavailable
    // fail-closed, trung tâm theo chế độ — không giả định nguyên nhân cụ thể.
    unavailableTitle: 'Pact Broker is not available',
    unavailableBody:
      'The dashboard cannot reach the broker API right now. Ask your administrator to check the deployment configuration.',
  },

  nav: {
    broker: 'Pact Broker',
    overview: 'Overview',
    pacts: 'Pacts',
    verifications: 'Verifications',
    matrix: 'Matrix',
    environments: 'Environments',
    tokens: 'API tokens',
    onboarding: 'CLI onboarding',
  },

  overview: {
    title: 'Overview',
    description: 'Consumer-driven contracts between the services of this workspace.',
    empty: 'No pacts published yet. See CLI onboarding to publish the first contract.',
    statParticipants: 'Pacticipants',
    statIntegrations: 'Integrations',
    statVerifications: 'Verification results',
  },

  verifications: {
    title: 'Verifications',
    description: 'Latest verification results per consumer/provider pair.',
    consumer: 'Consumer',
    consumerVersion: 'Consumer version',
    provider: 'Provider',
    outcome: 'Outcome',
    verifiedAt: 'Verified at',
  },

  matrix: {
    title: 'Matrix',
    description:
      'Can-I-deploy verdict for a pacticipant version against an environment. Unknown means not verified — not safe.',
    pacticipant: 'Pacticipant',
    choosePacticipant: 'Choose a pacticipant',
    version: 'Version',
    environment: 'Target environment',
    environmentPlaceholder: 'e.g. test',
    ask: 'Check',
    verdict: {
      deployable: 'Deployable: all verifications for this version pass.',
      'not-deployable': 'Not deployable: at least one verification failed.',
      unknown: 'Unknown: missing verification results. Do not deploy without evidence.',
    },
  },

  onboarding: {
    title: 'CLI onboarding',
    description: 'Configure the Pact CLI for local development and CI/CD against this broker.',
    pinPrefix: 'All commands are verified with the pinned CLI version:',
    localTitle: 'Local development',
    ciTitle: 'CI/CD pipeline',
    copy: 'Copy',
    credentialsTitle: 'Credentials and rotation',
    credentialsBody:
      'Machine tokens are created by your administrator (or via the API with an admin-scope credential). The token value is shown only once at creation — store it in your CI secret store. To rotate: create a new token, update the CI secret, then revoke the old one. Never commit tokens to the repository.',
  },

  pacts: {
    title: 'Pacts',
    description: 'Pacts published between consumers and providers.',
    consumer: 'Consumer',
    provider: 'Provider',
    consumerVersion: 'Consumer version',
    verification: 'Verification',
    verificationSuccess: 'Verified',
    verificationFailed: 'Failed',
    verificationNone: 'Not verified',
    updatedAt: 'Updated at',
  },

  environments: {
    title: 'Environments',
    description: 'Deployment environments known to the broker.',
    name: 'Name',
    displayName: 'Display name',
    production: 'Production',
    productionTrue: 'Production',
    productionFalse: 'Non-production',
    createdAt: 'Created at',
    deploymentsTitle: 'Deployments (latest version per pacticipant)',
    deploymentsEmpty: 'No deployments recorded yet.',
    deploymentsUnavailable: 'Deployment records are not available right now.',
    deployedPacticipant: 'Pacticipant',
    deployedVersion: 'Version',
    deployedEnvironment: 'Environment',
    deployedAt: 'Deployed at',
    undeployedAt: 'Undeployed at',
  },

  tokens: {
    title: 'API tokens',
    description:
      'Machine credentials for CI and the Pact CLI. Values are shown only once at creation.',
    name: 'Name',
    scopes: 'Scopes',
    purpose: 'Purpose',
    purposeDeveloper: 'Developer (CLI workflows, publish/verify)',
    purposeCi: 'CI (pipelines)',
    creator: 'Created by',
    createdAt: 'Created at',
    status: 'Status',
    revoked: 'Revoked',
    active: 'Active',
    copy: 'Copy token',
    copied: 'Copied',
    dismiss: 'Saved — hide',
    rotate: 'Rotate',
    revoke: 'Revoke',
    createFailed: 'Credential creation was rejected — check your permissions or the input.',
    mutateFailed: 'The operation was rejected — the credential may have just changed state.',
    csrfMissing:
      'Your session is missing its security token — reload the page and sign in again if it persists.',
    revealed: {
      title: 'The token is shown only this once',
      hint: 'Store it now — "{name}" will never be shown again. Reloading the page loses it permanently.',
    },
    create: {
      title: 'Create a new credential',
      submit: 'Create credential',
    },
    confirm: {
      rotateTitle: 'Rotate this credential?',
      revokeTitle: 'Revoke this credential?',
      hint: 'Type the exact name "{name}" to confirm. Rotation kills the old secret immediately; revocation cannot be undone.',
      cancel: 'Cancel',
    },
    forbidden: "You do not have permission to view this tenant's credentials.",
  },
} as const;
