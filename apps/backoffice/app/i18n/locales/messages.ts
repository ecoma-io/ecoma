/**
 * Kiểu dùng chung cho ba catalog message của `backoffice`.
 *
 * `en.ts` được khai `as const` để **key** là literal type (nhờ đó `t()` gợi ý
 * key thật). Nhưng `as const` cũng biến mọi *value* thành literal `'Overview'`,
 * nên `typeof en` không dùng trực tiếp làm kiểu cho `vi`/`zh-CN` — nó đòi bản
 * dịch phải **trùng nguyên văn** tiếng Anh.
 *
 * `MessageTree<T>` giữ nguyên cấu trúc key và hạ mọi leaf về `string`: đó đúng
 * là hợp đồng cần có giữa các catalog — *cùng cây key*, *value tự do*.
 *
 * ⚠️ Kiểu này kiểm **chiều thiếu** (key nào của `en` bị thiếu trong `vi` thì lỗi
 * compile). Nó **không** kiểm được key **thừa** ở `vi`: object literal gán vào
 * kiểu không có index signature vẫn bị excess-property check chặn ở **cùng cấp**,
 * nhưng key lạ trong object lồng nhau thì không. Vì vậy `catalogs.spec.ts` (colocated cạnh file này)
 * so **hai chiều** trên cả ba catalog — test mới là chốt chặn đầy đủ, kiểu chỉ là
 * lớp thứ nhất. Lý do đầy đủ nằm trong file tương ứng của `apps/account` — cùng
 * một thiết kế, hai app không cần hai lời giải thích.
 */
export type MessageTree<T> = {
  readonly [K in keyof T]: T[K] extends string ? string : MessageTree<T[K]>;
};

/**
 * Cây key đã hợp lệ hoá của catalog tiếng Anh — dạng widening, dùng làm kiểu
 * cho `vi` và `zh-CN`.
 */
export type BackofficeMessages = MessageTree<typeof import('./en').default>;
