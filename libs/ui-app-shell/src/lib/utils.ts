// Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
// Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md.

import type { ClassValue } from 'clsx';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Nối class Tailwind, để class sau thắng class trước khi hai class đụng cùng
 * một thuộc tính (`px-2` vs `px-4`). `clsx` xử lý input dạng mảng/object có
 * điều kiện, `twMerge` giải quyết xung đột utility.
 *
 * Bản nguồn còn export `valueUpdater` cho `@tanstack/vue-table`; library này
 * không port data table nên không mang theo dependency đó.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
