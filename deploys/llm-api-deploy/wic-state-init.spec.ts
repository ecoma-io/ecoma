/**
 * Contract theo NGUỒN cho container one-shot `wic-state-init` của
 * `deploys/llm-api-deploy/index.ts` (issue #119 — occurrence phát hiện sau khi
 * issue mở; cùng defect với push-notification-deploy).
 *
 * Vì sao đọc source mà không chạy chương trình: `index.ts` là chương trình
 * Pulumi dựng resource ở top-level — import vào test là provision thật, nên
 * contract khả dĩ duy nhất ở tầng này là ghim cấu trúc source (tiền lệ:
 * `object-store-config-init.spec.ts` của platform-deploy và `scripts.spec.ts`
 * cùng project cũng ghim theo nguồn).
 *
 * Ghim nguồn CHỨNG MINH được: container one-shot dùng đúng `docker.Container`
 * với `mustRun: false`; KHÔNG có property `rm: true` (AutoRemove xoá container
 * trước khi provider inspect sau create — "No such container" làm fail toàn bộ
 * create); KHÔNG có `retainOnDelete: true` (destroy phải xoá container vật lý,
 * nếu chỉ xoá state thì lần up sau bị Docker từ chối vì trùng tên); command
 * `chown`, mount `/state`, image, ownership labels nguyên vẹn; chuỗi phụ thuộc
 * volume → state-init và migrate/bootstrap → WIC (bao gồm state-init) không
 * trôi.
 *
 * Lệch có chủ ý so với push-notification: migration của unit này là
 * `command.local.Command` chạy `docker run --rm` vào PostgreSQL platform
 * (không đụng volume state WIC), phụ thuộc thật của nó là `provision` —
 * "migrate phụ thuộc state-init" không tồn tại ở đây từ trước, nên contract
 * ghim chuỗi thật: WIC phụ thuộc cả ba migrateCommands lẫn wicStateInit.
 *
 * Ghim nguồn KHÔNG chứng minh được: hành vi runtime lúc `pulumi up` thật
 * (container exit 0, không bị auto-remove trước inspect, WIC healthy) — được
 * chứng minh bằng `local-up` thật trên lane local, không phải bởi spec này.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'index.ts'), 'utf8');
/**
 * Cắt vùng source giữa hai marker (bao gồm cả marker kết thúc). Fail tường
 * minh khi marker biến mất thay vì để các assert sau đó chạy trên chuỗi rỗng
 * và pass một cách vô nghĩa.
 */
function sliceBetween(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `source marker not found: ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start);
  expect(end, `source marker not found: ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end + endMarker.length);
}
const stateInitBlock = sliceBetween('const wicStateInit = new docker.Container(', '\n);');
const wicBlock = sliceBetween('const wic = new docker.Container(', '\n);');

describe('llm-api wic-state-init source contract', () => {
  it('keeps the one-shot state-init as a docker.Container accepting an exited container', () => {
    expect(stateInitBlock).toContain("dockerResourceName(ns, 'llm-api-wic-state-init')");
    expect(stateInitBlock).toContain('image: NODE_IMAGE,');
    expect(stateInitBlock).toContain('mustRun: false');
  });
  it('never declares the AutoRemove race property rm true on the state-init', () => {
    // Neo theo dòng property (dòng lệnh muốn `rm: true` phải đứng một dòng
    // riêng theo format prettier) — comment lifecycle cố tình nhắc đúng chuỗi
    // `rm: true` nên không được khớp nó.
    expect(stateInitBlock).not.toMatch(/^\s+rm:\s*true/mu);
  });
  it('never retains the state-init container on delete', () => {
    expect(stateInitBlock).not.toContain('retainOnDelete: true');
    expect(stateInitBlock).not.toMatch(/^\s+retainOnDelete:\s*true/mu);
  });
  it('keeps the chown command, the /state volume mount and the ownership labels intact', () => {
    expect(stateInitBlock).toContain("command: ['chown', '1000:1000', '/state'],");
    expect(stateInitBlock).toContain('source: wicStateVolume.name,');
    expect(stateInitBlock).toContain("target: '/state',");
    expect(stateInitBlock).toContain("type: 'volume',");
    expect(stateInitBlock).toContain('labels: Object.entries(labels).map');
  });
  it('keeps the dependency chain volume -> state-init and migrate/bootstrap -> wic', () => {
    // Options của state-init: chỉ dependsOn volume — không retainOnDelete.
    expect(stateInitBlock).toContain('{ dependsOn: [wicStateVolume] },');
    // WIC chạy sau migrate + bootstrap và sau state-init: chuỗi thật của unit
    // này là WIC phụ thuộc trực tiếp cả hai nhóm (migrate không đụng volume
    // state nên không nằm sau state-init — xem JSDoc đầu file).
    expect(wicBlock).toContain('migrateCommands.gateway,');
    expect(wicBlock).toContain('migrateCommands.tenant,');
    expect(wicBlock).toContain('migrateCommands.marketplace,');
    expect(wicBlock).toContain('wicStateVolume,');
    expect(wicBlock).toContain('wicStateInit,');
  });
});
