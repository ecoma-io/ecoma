/**
 * Image Node pin (theo DIGEST) dùng chung trong unit này: migration, init
 * volume state WIC (trong `index.ts`) và container smoke (`smoke.ts`) đều chạy
 * trên CÙNG một image — cùng digest mà `deploys/auth-deploy/Dockerfile` ghim.
 * Nguồn DUY NHẤT của chuỗi này: hai entry cùng import từ đây thì không bao giờ
 * trôi lệch digest.
 *
 * Vì sao container mà không chạy runner trên host: platform PostgreSQL KHÔNG
 * publish host port (invariant platform) và host không route được tới IP
 * container (platform facts PF5); object store cũng chỉ phục vụ trong platform
 * network — container ephemeral chạy tsx binary của repo vẫn là đúng một đường
 * code canonical.
 */
export const NODE_IMAGE =
  'node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';
