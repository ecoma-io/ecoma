/**
 * Bản đồ env object storage của container WIC — phần NON-SECRET.
 *
 * Một nguồn sự thật cho TÊN biến và HÌNH giá trị mà
 * `apps/remote-cache-api/src/config.ts` đọc (`S3_ENDPOINT`/`S3_BUCKET`/
 * `S3_ACCESS_KEY_ID` — thiếu bất kỳ field nào là data plane fail-closed 503,
 * `/ready` báo `storage: 'missing'`). Hai đường tiêu thụ cùng dùng helper này:
 * chương trình Pulumi (`index.ts`) interpolate vào `envs` của container, và
 * smoke ngoài host (`smoke.ts`) truyền cho container smoke qua `docker run -e`
 * — lệch một tên hay một hình endpoint là smoke đo một cấu hình khác với cấu
 * hình thật của container.
 *
 * `S3_SECRET_ACCESS_KEY` CỐ Ý KHÔNG nằm ở đây: secret đi qua kênh riêng của
 * từng đường (`pulumi.secret` trong `envs`; stdin của container smoke) — giá
 * trị secret không bao giờ đi qua return value thuần của helper này.
 */

/** Đầu vào non-secret của object storage, đọc từ outputs của platform stack. */
export interface ObjectStorageEnvInputs {
  readonly host: string;
  readonly port: number;
  readonly bucket: string;
  readonly accessKeyId: string;
}

/** Tên env object storage mà worker đọc — khớp `src/config.ts` của app. */
export type ObjectStorageEnvName = 'S3_ENDPOINT' | 'S3_BUCKET' | 'S3_ACCESS_KEY_ID';

/**
 * Dựng bản đồ env non-secret của data plane object storage.
 *
 * Endpoint là plain HTTP nội bộ (`http://<host>:<port>`): object store chỉ
 * phục vụ trong platform network, không có TLS giữa các container trong cùng
 * network — cùng hình với Hyperdrive connection string (`sslmode=disable`).
 */
export function buildObjectStorageEnvs(
  inputs: ObjectStorageEnvInputs,
): Readonly<Record<ObjectStorageEnvName, string>> {
  return {
    S3_ENDPOINT: `http://${inputs.host}:${inputs.port}`,
    S3_BUCKET: inputs.bucket,
    S3_ACCESS_KEY_ID: inputs.accessKeyId,
  };
}
