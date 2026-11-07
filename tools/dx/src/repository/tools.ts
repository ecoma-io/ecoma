import { execFileSync } from 'node:child_process';

/**
 * Trả về phiên bản mà một lệnh báo cáo, hoặc null khi lệnh không dùng được.
 *
 * PATH là tín hiệu duy nhất. Một binary nằm trong thư mục cài đặt mà shell này
 * chưa nhận diện thì không chạy được, còn các bước thiết lập mà developer làm
 * theo thì giả định nó chạy được — nên thứ gì không chạy được ngay lúc này đều
 * tính là thiếu.
 */
export function probeVersion(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  try {
    const output = execFileSync(command, [...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    }).trim();

    // Một số CLI in usage rồi vẫn exit 0 khi gặp flag sai, nên đòi hỏi một
    // số phiên bản thay vì tin vào output khác rỗng.
    return output.match(/v?\d+\.\d+\.\d+/u)?.[0] ?? null;
  } catch {
    return null;
  }
}

export interface ToolSpec {
  /** Tên hiển thị trong cảnh báo, ví dụ `Pulumi`. */
  name: string;
  /** Executable bắt buộc phải chạy được. */
  command: string;
  /** Arguments in ra phiên bản. */
  versionArgs: readonly string[];
  /** Hướng dẫn cài đặt chính thức, để cảnh báo có thể hành động được. */
  installUrl: string;
}

export interface ToolReport {
  /** Mọi tool chạy được, kèm phiên bản nó báo. */
  available: { spec: ToolSpec; version: string }[];
  /** Mọi tool không chạy được. */
  missing: ToolSpec[];
}

/**
 * Kiểm tra mọi tool đã khai báo và báo cáo tool nào dùng được.
 *
 * Ở đây không cài đặt gì cả. Một máy không có root, không có TTY để trả lời
 * prompt sudo, hoặc đứng sau corporate proxy là một máy bình thường, và một
 * installer không hoàn tất được sẽ khiến repository chỉ chuẩn bị được một nửa
 * — nên caller in hướng dẫn chính thức rồi để developer tự cài.
 */
export function checkTools(specs: readonly ToolSpec[]): ToolReport {
  const available: ToolReport['available'] = [];
  const missing: ToolSpec[] = [];

  for (const spec of specs) {
    const version = probeVersion(spec.command, spec.versionArgs);

    if (version) {
      console.log(`${spec.name} ${version} is available`);
      available.push({ spec, version });
    } else {
      missing.push(spec);
    }
  }

  return { available, missing };
}

/**
 * In một cảnh báo cho mỗi tool bị thiếu, kèm hướng dẫn chính thức của nó.
 *
 * Tách khỏi `checkTools` để câu thông điệp được viết ở một chỗ và test được mà
 * không cần bắt output của chính lệnh kiểm tra.
 */
export function warnMissingTools(specs: readonly ToolSpec[]): void {
  if (specs.length === 0) return;

  console.log('');
  console.log(
    specs.length === 1
      ? '1 required tool is missing. Install it before working on this repository:'
      : `${specs.length} required tools are missing. Install them before working on this repository:`,
  );

  for (const spec of specs) {
    console.log(`  ${spec.name}: ${spec.installUrl}`);
  }
}
