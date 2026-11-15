import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Resolve network platform của stack local từ port Traefik publish.
 *
 * Cùng phép map namespace với `resolvePostgresContainer` (`stack-fixtures.ts`)
 * nhưng trả tên network — hai spec của suite (`portal-journey.spec.ts` chạy
 * curl/fetch trong network, `nx-cli-journey.spec.ts` chạy container Nx) cùng
 * gọi helper này thay vì giữ hai bản copy.
 */

const execFileAsync = promisify(execFile);

/** Tên network platform của stack mà `origin` đang chạy. */
export async function resolvePlatformNetwork(origin: string): Promise<string> {
  const port = new URL(origin).port;
  const { stdout } = await execFileAsync('docker', ['ps', '--format', '{{.Names}}\t{{.Ports}}']);
  for (const line of stdout.split('\n')) {
    const [name, ports] = line.split('\t');
    if (name === undefined || ports === undefined || !name.includes('traefik')) {
      continue;
    }
    // Cột Ports dạng `80/tcp, 127.0.0.1:32768->443/tcp` — match `->443/tcp`.
    if (new RegExp(`127\\.0\\.0\\.1:${port}->443/tcp`, 'u').test(ports)) {
      const namespace = name.replace(/^ecoma-(.+)-traefik$/u, '$1');
      return `ecoma-${namespace}-network`;
    }
  }
  throw new Error(
    `no traefik container publishes host port ${port} — the local stack is not running`,
  );
}
