/**
 * Schema validate input của API — port từ upstream `src/lib/validation.ts`
 * (ADAPT): tách phần pure (schema zod) khỏi helper gắn Hono Context. Phần
 * helper `validateParam`/`validateParams`/`validateOptionalQuery` nằm ở
 * `src/middleware/validate.ts` vì chúng cần `Context`.
 *
 * Named imports, chủ ý — KHÔNG `import { z } from "zod"`. Namespace import
 * khiến `z.locales` với tới được, ghim ~279 KiB locale file (mọi ngôn ngữ zod
 * ship) vào Worker bundle.
 */
import { string, type ZodType } from 'zod';

// Tên pacticipant/consumer/provider: chữ số, dấu chấm, gạch nối, gạch dưới
export const nameSchema = string()
  .min(1, 'Name cannot be empty')
  .max(255, 'Name exceeds 255 characters')
  .regex(
    /^[a-zA-Z0-9._-]+$/u,
    'Name can only contain letters, numbers, dots, hyphens, and underscores',
  );

// Chuỗi version: định dạng linh hoạt (semver, git SHA, ngày, v.v.), nhưng
// KHÔNG được chứa dot-segment `..` — version là định danh, và mọi giá trị
// param mà một bên khác ghép vào URL (HAL href, client) không được mang
// segment điều hướng. `.` đơn lẻ vẫn hợp lệ (semver build, ngày "1.2.3").
export const versionSchema = string()
  .min(1, 'Version cannot be empty')
  .max(255, 'Version exceeds 255 characters')
  .refine((v) => !v.includes('..'), 'Version cannot contain dot-segments');

// Tên tag: giống name nhưng nới hơn chút
export const tagSchema = string()
  .min(1, 'Tag cannot be empty')
  .max(255, 'Tag exceeds 255 characters')
  .regex(
    /^[a-zA-Z0-9._-]+$/u,
    'Tag can only contain letters, numbers, dots, hyphens, and underscores',
  );

// Tên branch: giống tag
export const branchSchema = string()
  .min(1, 'Branch cannot be empty')
  .max(255, 'Branch exceeds 255 characters')
  .regex(
    /^[a-zA-Z0-9._/-]+$/u,
    'Branch can only contain letters, numbers, dots, hyphens, underscores, and slashes',
  );

// Content hash SHA-256: đúng 64 ký tự hex
export const shaSchema = string()
  .length(64, 'SHA must be exactly 64 characters')
  .regex(/^[a-f0-9]+$/iu, 'SHA must be a valid hexadecimal string');

// ID số nguyên dương (string vào, string ra để đồng nhất)
export const idSchema = string()
  .regex(/^\d+$/u, 'ID must be a positive integer')
  .refine((val) => parseInt(val, 10) > 0, 'ID must be greater than 0');

/**
 * Parse chuỗi ID thành number.
 * Gọi sau khi validate bằng idSchema.
 */
export function parseId(idString: string): number {
  return parseInt(idString, 10);
}

// Tên environment
export const environmentNameSchema = string()
  .min(1, 'Environment name cannot be empty')
  .max(100, 'Environment name exceeds 100 characters')
  .regex(
    /^[a-zA-Z0-9_-]+$/u,
    'Environment name can only contain letters, numbers, hyphens, and underscores',
  );

export type { ZodType };
