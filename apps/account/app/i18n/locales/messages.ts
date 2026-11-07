/**
 * Kiểu dùng chung cho ba catalog message của account.
 *
 * `en.ts` được khai `as const` để **key** là literal type (nhờ đó
 * `MessageKey` mới tồn tại và `t()` mới được gợi ý key thật). Nhưng `as const`
 * cũng biến mọi *value* thành literal `'Save changes'`, nên `typeof en` không
 * dùng trực tiếp làm kiểu cho `vi`/`zh-CN` được — nó sẽ đòi bản dịch phải
 * **trùng nguyên văn** tiếng Anh.
 *
 * `MessageTree<T>` giữ nguyên cấu trúc key và hạ mọi leaf về `string`: đó đúng
 * là hợp đồng cần có giữa các catalog — *cùng cây key*, *value tự do*.
 *
 * ⚠️ Kiểu này kiểm **chiều thiếu** (key nào của `en` bị thiếu trong `vi` thì
 * lỗi compile). Nó **không** kiểm được key **thừa** ở `vi`: một object literal
 * gán vào kiểu không có index signature vẫn bị excess-property check chặn, nên
 * key lạ ở **cùng cấp** bị bắt, nhưng key lạ trong một object lồng nhau thì
 * không. Vì vậy `catalogs.spec.ts` so **hai chiều** trên cả ba catalog — test
 * mới là chốt chặn đầy đủ, kiểu chỉ là lớp thứ nhất.
 */
export type MessageTree<T> = {
  readonly [K in keyof T]: T[K] extends string ? string : MessageTree<T[K]>;
};

/**
 * Cây key đã hợp lệ hoá của catalog tiếng Anh — dạng widening, dùng làm kiểu
 * cho `vi` và `zh-CN`.
 */
export type AccountMessages = MessageTree<typeof import('./en').default>;
