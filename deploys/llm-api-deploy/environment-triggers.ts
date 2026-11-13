/**
 * Dựng trigger `k=v` cho từng entry của map environment bootstrap — BẮT BUỘC
 * qua `pulumi.interpolate`, KHÔNG dùng template literal thường: `${v}` với `v`
 * là `Output` gọi `Output.toString()` trả về chuỗi hằng (không resolve giá
 * trị, không tracking) nên entry trơ — credential/verdict đổi không bao giờ
 * kích hoạt rerun (issue #154). `pulumi.interpolate` resolve Output thật, giữ
 * dependency tracking và lan truyền tính secret: entry từ output bọc secret
 * là output secret, state Pulumi mã hoá thay vì lưu plaintext.
 *
 * Lý do tách module riêng (không nhét vào `scripts.ts` giữ bất biến "không cần
 * Pulumi", không nhét local vào `index.ts`): ĐÚNG hàm này được fixture test
 * engine-level (`tests/integrations/trigger-interpolation.spec.ts`) import —
 * một nguồn sự thật cho pattern dựng trigger; nếu ai đó reverted sang
 * stringification thì fixture tự ném dưới `PULUMI_ERROR_OUTPUT_STRING=true`
 * thay vì test một pattern production không còn dùng.
 */
import * as pulumi from '@pulumi/pulumi';

export function environmentTriggers(
  env: Record<string, pulumi.Output<string> | string>,
  excludeKeys: readonly string[] = [],
): pulumi.Output<string>[] {
  return Object.entries(env)
    .filter(([key]) => !excludeKeys.includes(key))
    .map(([key, value]) => pulumi.interpolate`${key}=${value}`);
}
