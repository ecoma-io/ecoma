import type { ToolSpec } from './tools.js';

/**
 * Docker, mà pre-commit secret scan chạy trên đó.
 *
 * Dùng `version` chứ không phải `--version` là cố ý: flag trần chỉ báo client
 * binary, nên một máy đã cài Docker nhưng daemon đang dừng sẽ qua được lệnh kiểm
 * tra này rồi fail mọi commit vì thiếu cái daemon nó chưa từng có. Hook cần một
 * daemon chạy được, nên đó là thứ được dò.
 */
export const docker: ToolSpec = {
  name: 'Docker',
  command: 'docker',
  versionArgs: ['version'],
  installUrl: 'https://docs.docker.com/engine/install/',
};

/** Helm, package manager của Kubernetes. In phiên bản client mà không cần cluster. */
export const helm: ToolSpec = {
  name: 'Helm',
  command: 'helm',
  versionArgs: ['version'],
  installUrl: 'https://helm.sh/docs/intro/install/',
};

/**
 * kustomize, dùng để render các manifest overlay.
 *
 * `kubectl kustomize` chạy được mà không cần binary riêng, nhưng standalone CLI
 * mới là thứ tooling delivery gọi tới, nên nó được kiểm tra riêng.
 */
export const kustomize: ToolSpec = {
  name: 'kustomize',
  command: 'kustomize',
  versionArgs: ['version'],
  installUrl: 'https://kubectl.docs.kubernetes.io/installation/kustomize/',
};

/**
 * kubeconform, dùng để validate manifest theo schema của Kubernetes.
 *
 * CLI viết flag này là `-v`; `--version` bị từ chối như một flag lạ, và nó in
 * usage rồi vẫn exit 0 — đó là lý do lệnh dò tìm một số phiên bản thay vì bất
 * kỳ output nào.
 */
export const kubeconform: ToolSpec = {
  name: 'kubeconform',
  command: 'kubeconform',
  versionArgs: ['-v'],
  installUrl: 'https://github.com/yannh/kubeconform#installation',
};

/** Mọi CLI mà công việc platform cần, theo thứ tự chúng được kiểm tra. */
export const TOOL_SPECS: readonly ToolSpec[] = [docker, helm, kustomize, kubeconform];
