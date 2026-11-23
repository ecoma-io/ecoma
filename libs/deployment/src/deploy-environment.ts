/**
 * Adapter seam môi trường deployment dùng chung Local ↔ Staging — contracts
 * lifecycle + state isolation/stack selection theo `02-delivery.md` §4.2 và
 * §7.4.1 (quyết định Modelling #345, delivery #367).
 *
 * Hai environment dùng chung MỘT lifecycle contract (`up`/`preview`/`down`) và
 * KHÁC BIỆT tường minh ở bốn chiều của môi trường, thay vì hai đường chạy song
 * song không liên quan:
 *
 * | Chiều            | Local                                | Staging                                        |
 * | ---------------- | ------------------------------------ | ---------------------------------------------- |
 * | `runtime`        | Docker + Wrangler-in-Container (WIC) | Cloudflare Workers + Hyperdrive                |
 * | `routing`        | Traefik (tunnel nội bộ máy dev)      | Cloudflare trên zone `ecoma.io.vn` (§4.2 — Custom Domain trực tiếp hoặc Router cho slot ephemeral) |
 * | `namespaceMode`  | per-worktree (xxHash64 của root)     | `fixed` — staging cố định, không theo worktree |
 * | `passphraseSource` | file tự sinh trong worktree        | GitHub Environment secret per-stack (§7.4.1)   |
 *
 * State isolation (`§7.4.1`, ba hệ cách ly không bao giờ chia sẻ): backend
 * local là `file://<worktree>/.pulumi-local-state`, backend staging là `s3://`
 * R2 qua `ECOMA_PULUMI_STATE_URL_STAGING` (bucket per-environment, passphrase
 * per-stack). Hợp đồng TỪ CHỐI tổ hợp stack↔backend sai: `local` chỉ đi với
 * `file://`, `staging`/`staging-candidate` chỉ đi với `s3://` staging — một
 * stack không bao giờ "mượn" backend của hệ kia. Candidate slot là stack
 * `staging-candidate` trên CÙNG backend R2 — isolation bằng state key, không
 * phải environment thứ tư.
 *
 * Stack mapping: một stack staging cho MỖI Pulumi project trong `deploys/`
 * (`organization/<project>/staging`, per-stack passphrase) — layout theo deploy
 * unit giữ nguyên như lane local.
 *
 * ⚠️ Seam này KHÔNG định nghĩa migration semantics: schema migration thuộc các
 * migration project `databases/*-db` (#373/#374) — coordinator invoke migration
 * targets qua contract của issue đó, không qua đây. Việc provision resource
 * staging thật (#350) cũng nằm ngoài seam: adapter staging chỉ chốt cách chọn
 * backend + stack, chưa chạy Pulumi nào.
 *
 * Việc đọc `ECOMA_PULUMI_STATE_URL_STAGING` fail-closed: biến chưa được khai
 * báo ở bất kỳ đâu trong repo và phải được bổ sung làm bootstrap prerequisite
 * trước khi apply stack staging đầu tiên — thiếu biến là dừng, không đoán.
 */

import { resolveContext, fullStackRef, stackRef } from './pulumi-context.js';

/** Các environment thuộc seam. Lane production theo cùng contract khi delivery của nó đến — không mô hình hóa ở đây (non-goal #367). */
export const DEPLOYMENT_ENVIRONMENT_IDS = ['local', 'staging'] as const;

export type DeploymentEnvironmentId = (typeof DEPLOYMENT_ENVIRONMENT_IDS)[number];

/**
 * Pha lifecycle dùng chung mà mọi environment đi qua — MỘT bản duy nhất, cả
 * hai adapter cùng tham chiếu (không phải mỗi bên tự khai một bản để trôi lệch).
 * `preview` trước `up` theo execution contract §7.4.1 (inspect plan trước apply);
 * `down` là teardown. Việc pha nào đã hiện thực bên nào là trạng thái delivery
 * của từng lane (#350/#362 cho staging), không phải thuộc contract.
 */
export const DEPLOYMENT_LIFECYCLE_PHASES = ['preview', 'up', 'down'] as const;

export type DeploymentLifecyclePhase = (typeof DEPLOYMENT_LIFECYCLE_PHASES)[number];

/** Runtime thực thi resource: Docker/WIC local ↔ Workers/Hyperdrive staging. */
export type DeploymentRuntimeKind = 'docker-wic' | 'cloudflare-workers';

/** Routing công khai: Traefik local ↔ Workers Router routes trên zone non-production. */
export type DeploymentRoutingKind = 'traefik' | 'workers-router';

/** Không gian định danh: namespace hash theo worktree ↔ cố định của staging. */
export type DeploymentNamespaceMode = 'per-worktree' | 'fixed';

/** Nguồn passphrase Pulumi: file worktree ↔ secret per-stack ngoài repo. */
export type DeploymentPassphraseSource = 'worktree-file' | 'environment-secret-per-stack';

/**
 * Tên biến môi trường state backend staging — MỘT biến cho MỘT environment,
 * giá trị là `s3://` R2 có `endpoint`/`region`/`s3ForcePathStyle=true` (§7.4.1).
 * Chưa khai báo ở đâu trong repo; #350 bổ sung làm bootstrap prerequisite.
 */
export const STAGING_STATE_URL_ENV_KEY = 'ECOMA_PULUMI_STATE_URL_STAGING';

/**
 * Slot stack của environment staging: continuous lane (`staging`) và candidate
 * slot Release Validation (#381, `staging-candidate`) — cả hai là stack của
 * staging trên cùng backend, passphrase riêng theo quy tắc per-stack.
 */
export const STAGING_SLOTS = ['staging', 'staging-candidate'] as const;

export type StagingSlot = (typeof STAGING_SLOTS)[number];

/**
 * Kết quả chọn stack cho một deploy project trên một environment: mọi lệnh
 * Pulumi của project đó suy từ bốn giá trị này, không suy từ selected-stack
 * toàn cục.
 */
export interface StackSelection {
  readonly environment: DeploymentEnvironmentId;
  /** Tên stack ngắn dùng cho `stack init`/`select`. */
  readonly stackName: string;
  /** Ref đầy đủ `organization/<project>/<stack>` dùng cho `--stack` trên mọi lệnh. */
  readonly fullStackRef: string;
  /** Backend URL đã qua kiểm tra tổ hợp stack↔backend. */
  readonly backendUrl: string;
}

/** Tuỳ chọn chọn stack, khác nhau theo adapter — mỗi adapter chỉ đọc phần của mình. */
export interface DeploymentStackSelectionOptions {
  /** local: worktree root; mặc định là workspace root suy từ vị trí lib. */
  readonly worktreeRoot?: string;
  /** staging: slot stack; mặc định `staging` (continuous lane). */
  readonly slot?: StagingSlot;
  /** staging: backend URL đã biết; mặc định đọc `STAGING_STATE_URL_ENV_KEY`. */
  readonly backendUrl?: string;
}

/**
 * Adapter của MỘT environment: khai bốn chiều môi trường + cách chọn stack
 * Pulumi cho một deploy project. Contract lifecycle dùng chung nằm ở
 * `DEPLOYMENT_LIFECYCLE_PHASES` — adapter không tự định nghĩa lại.
 */
export interface DeploymentEnvironmentAdapter {
  readonly environment: DeploymentEnvironmentId;
  readonly runtime: DeploymentRuntimeKind;
  readonly routing: DeploymentRoutingKind;
  readonly namespaceMode: DeploymentNamespaceMode;
  readonly passphraseSource: DeploymentPassphraseSource;
  readonly lifecycle: readonly DeploymentLifecyclePhase[];
  stackSelection(project: string, options?: DeploymentStackSelectionOptions): StackSelection;
}

/**
 * Kiểm tra tổ hợp stack↔backend theo §7.4.1 — sai tổ hợp là TỪ CHỐI, không đoán:
 *
 * - `local` chỉ đi với `file://` (backend state per-worktree).
 * - `staging` chỉ đi với `s3://` R2 của staging: URL phải có bucket, và query
 *   phải đủ `endpoint` (R2 chỉ công bố endpoint path-style), `region`, và
 *   `s3ForcePathStyle=true` (Pulumi mặc định virtual-hosted, R2 không hỗ trợ —
 *   `04` R22/PU9).
 */
export function validateStackBackendPairing(
  environment: DeploymentEnvironmentId,
  backendUrl: string,
): void {
  let parsed: URL;
  try {
    parsed = new URL(backendUrl);
  } catch {
    throw new Error(`${backendUrl} is not a valid backend URL`);
  }
  if (environment === 'local') {
    if (parsed.protocol !== 'file:') {
      throw new Error(
        `stack environment "local" requires a file:// backend, got "${parsed.protocol}" — ` +
          'a local stack never borrows the staging backend',
      );
    }
    return;
  }
  if (parsed.protocol !== 's3:') {
    throw new Error(
      `stack environment "staging" requires an s3:// backend (R2), got "${parsed.protocol}" — ` +
        'a staging stack never borrows the local file:// backend',
    );
  }
  if (parsed.host.length === 0) {
    throw new Error(`staging backend URL ${backendUrl} has no bucket in the authority position`);
  }
  for (const key of ['endpoint', 'region'] as const) {
    const value = parsed.searchParams.get(key);
    if (value === null || value.trim().length === 0) {
      throw new Error(
        `staging backend URL ${backendUrl} is missing the "${key}" query parameter — ` +
          'an s3:// R2 URL must carry endpoint, region and s3ForcePathStyle=true',
      );
    }
  }
  if (parsed.searchParams.get('s3ForcePathStyle') !== 'true') {
    throw new Error(
      `staging backend URL ${backendUrl} must set s3ForcePathStyle=true — ` +
        'R2 only exposes a path-style endpoint',
    );
  }
}

/**
 * Đọc state backend staging từ môi trường — fail-closed khi thiếu: backend phải
 * tồn tại TRƯỚC ordinary stacks (bootstrap contract §7.4.1) và việc khai biến
 * này là bootstrap prerequisite của #350; thiếu biến nghĩa là staging chưa được
 * bootstrap, không phải "dùng local tạm".
 */
export function resolveStagingStateUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[STAGING_STATE_URL_ENV_KEY];
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(
      `${STAGING_STATE_URL_ENV_KEY} is not set — the staging state backend must be bootstrapped ` +
        'before the first staging stack apply; refusing to fall back to another backend',
    );
  }
  return raw;
}

/**
 * Adapter local: lane hiện hành M1 — Docker/WIC trên máy developer, mọi tên
 * resource và stack mang namespace worktree (xem `deploy-namespace.ts`).
 *
 * Tên stack `local-<namespace>` (không phải `local` thuần của hợp đồng §7.4.1)
 * là lệch có chủ đích của lane local, ghi ở `architecture/local-development/README.md`:
 * backend `file://` theo worktree, nhiều worktree cùng host không dùng chung stack.
 * `stackSelection` bọc đúng cơ chế đó (`resolveContext` + `fullStackRef`), giữ
 * nguyên hành vi hiện hành.
 */
export const localDeploymentAdapter: DeploymentEnvironmentAdapter = {
  environment: 'local',
  runtime: 'docker-wic',
  routing: 'traefik',
  namespaceMode: 'per-worktree',
  passphraseSource: 'worktree-file',
  lifecycle: DEPLOYMENT_LIFECYCLE_PHASES,
  stackSelection(project, options = {}) {
    const ctx = resolveContext(options.worktreeRoot);
    return {
      environment: 'local',
      stackName: ctx.stackName,
      fullStackRef: fullStackRef(project, ctx),
      backendUrl: ctx.stateUrl,
    };
  },
};

/**
 * Adapter staging: Workers/Hyperdrive trên infra cố định, routing qua Workers
 * Router (§4.2). Backend R2 đọc từ `ECOMA_PULUMI_STATE_URL_STAGING` (hoặc giá
 * trị truyền tường minh cho đường đã resolve sẵn), passphrase per-stack nằm ở
 * GitHub Environment secret của stack — không tái sử dụng passphrase local.
 *
 * Org literal `organization` trong ref đầy đủ giữ giả định backend DIY (như
 * `file://` local); verify lần đầu apply stack staging thật ở #350.
 */
export const stagingDeploymentAdapter: DeploymentEnvironmentAdapter = {
  environment: 'staging',
  runtime: 'cloudflare-workers',
  routing: 'workers-router',
  namespaceMode: 'fixed',
  passphraseSource: 'environment-secret-per-stack',
  lifecycle: DEPLOYMENT_LIFECYCLE_PHASES,
  stackSelection(project, options = {}) {
    const slot = options.slot ?? 'staging';
    const backendUrl = options.backendUrl ?? resolveStagingStateUrl();
    validateStackBackendPairing('staging', backendUrl);
    return {
      environment: 'staging',
      stackName: slot,
      fullStackRef: stackRef(project, slot),
      backendUrl,
    };
  },
};

/** Adapter của một environment theo id — điểm vào duy nhất cho caller đa-lane. */
export function deploymentEnvironmentAdapter(
  environment: DeploymentEnvironmentId,
): DeploymentEnvironmentAdapter {
  switch (environment) {
    case 'local':
      return localDeploymentAdapter;
    case 'staging':
      return stagingDeploymentAdapter;
    default:
      // Fail-closed: id ngoài seam (JS caller không qua typecheck, hay lane
      // production chưa mô hình hóa) phải chết ngay, không trả adapter nào đó.
      throw new Error(`unknown deployment environment: ${String(environment)}`);
  }
}
