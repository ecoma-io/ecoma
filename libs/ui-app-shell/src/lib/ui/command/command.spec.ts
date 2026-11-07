import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import { Command, CommandGroup, CommandItem, CommandList, useCommand } from '.';

/**
 * Bất biến của bộ lọc command palette khi danh sách item **động**.
 *
 * Palette của shell dựng item từ dữ liệu app truyền vào, nên item có thể mount
 * sau khi người dùng đã gõ từ khoá. Đây là chỗ đã vỡ một lần trong lúc port:
 * `filterItems` chỉ chạy lại khi `filterState.search` đổi, mà item/group đăng
 * ký bằng `Map.set`/`Map.delete` — gán vào `Map` không làm `ref` phát thay đổi.
 * Hệ quả: item mount trong lúc đang search không bao giờ được lọc, và
 * `filtered.count`/`filtered.groups` đứng nguyên giá trị cũ, nên `CommandEmpty`
 * và trạng thái ẩn của group (đọc chính các giá trị đó) nói sai về kết quả.
 *
 * Test phải đọc qua đúng những giá trị mà component tiêu thụ (`filtered.count`,
 * `filtered.items`, `filtered.groups`) chứ không chỉ đếm DOM: `isRender` của
 * `CommandItem` cố tình cho item chưa có trong map render một lần, nên nếu chỉ
 * đếm phần tử còn lại có thể vẫn xanh trong khi bảng `filtered` đã cũ.
 */

/**
 * Lấy khoá duy nhất của một registry. Cả `allItems` lẫn `allGroups` chỉ có đúng
 * một phần tử ở các test dưới, và `.at(0)` trả `string | undefined` nên phải có
 * `?? ''` — không dùng non-null assertion vì lint cấm.
 */
function onlyId(registry: ReadonlyMap<string, unknown>): string {
  const keys = [...registry.keys()];

  if (keys.length !== 1) {
    throw new Error(`Cần đúng một khoá trong registry, đang có ${String(keys.length)}`);
  }

  return keys.at(0) ?? '';
}

/** Id mà `CommandItem` đã đăng ký cho item mang đúng đoạn text này. */
function idOfText(command: NonNullable<ReturnType<typeof useCommand>>, text: string): string {
  for (const [id, value] of command.allItems.value) {
    if (value === text) return id;
  }

  throw new Error(`Không có item nào đăng ký text "${text}" trong allItems`);
}

/** Host render `items` từ một `ref` để điều khiển được lúc item mount. */
function mountCommand(initial: string[]) {
  const items = ref(initial);
  let api: ReturnType<typeof useCommand> | null = null;

  const Capture = defineComponent({
    setup() {
      api = useCommand();

      return () => null;
    },
  });

  const Host = defineComponent({
    setup: () => () =>
      h(Command, null, {
        default: () => [
          h(Capture),
          h(CommandList, null, {
            default: () =>
              h(CommandGroup, null, {
                default: () =>
                  items.value.map((text) =>
                    h(CommandItem, { key: text, value: text }, { default: () => text }),
                  ),
              }),
          }),
        ],
      }),
  });

  const wrapper = mount(Host, { attachTo: document.body });

  const itemTexts = () => wrapper.findAll('[data-slot="command-item"]').map((item) => item.text());

  /**
   * `Capture` nằm trong cây nên `useCommand()` chạy lúc mount và gán `api`. Gọi
   * qua getter này thay vì `api!`: nếu `Capture` mất khỏi cây, lỗi là
   * `api is null` rõ ràng, không phải `Cannot read properties of null` ở chỗ
   * dùng — và không cần non-null assertion (lint cấm).
   */
  const command = (): NonNullable<ReturnType<typeof useCommand>> => {
    if (api === null) {
      throw new Error('useCommand() chưa chạy — Capture không nằm trong cây Command');
    }

    return api;
  };

  return { items, itemTexts, command, wrapper };
}

const mountedWrappers: ReturnType<typeof mount>[] = [];

afterEach(() => {
  for (const wrapper of mountedWrappers.toReversed()) {
    wrapper.unmount();
  }
  mountedWrappers.length = 0;
  document.body.innerHTML = '';
});

describe('Command re-filters when the item list changes during an active search', () => {
  it('filters an item that mounts after the keyword is active, and updates filtered.count', async () => {
    const { items, itemTexts, command, wrapper } = mountCommand(['apple']);

    mountedWrappers.push(wrapper);
    await flushPromises();

    command().filterState.search = 'app';
    await flushPromises();
    await nextTick();

    // Item mới mount trong lúc search đang bật: nó không khớp 'app' nên phải bị
    // lọc ngay, không được nằm lại trong DOM.
    items.value = ['apple', 'zzz-no-match'];
    await flushPromises();
    await nextTick();

    expect(itemTexts()).toContain('apple');
    expect(itemTexts()).not.toContain('zzz-no-match');
    expect(command().filterState.filtered.count).toBe(1);
  });

  it('clears the previous filter results when every keyword is removed', async () => {
    const { command, wrapper } = mountCommand(['apple', 'banana']);

    mountedWrappers.push(wrapper);
    await flushPromises();

    command().filterState.search = 'app';
    await flushPromises();
    await nextTick();
    expect(command().filterState.filtered.items.size).toBeGreaterThan(0);

    command().filterState.search = '';
    await flushPromises();
    await nextTick();

    // Không lọc gì khi không có từ khoá, nhưng bảng của lần search trước phải
    // được xoá: để lại thì lần search sau đọc nhầm item không còn tồn tại và
    // `count` cũ vẫn nói về kết quả đã bỏ.
    expect(command().filterState.filtered.items.size).toBe(0);
    expect(command().filterState.filtered.groups.size).toBe(0);
    expect(command().filterState.filtered.count).toBe(2);
  });
});

describe('Command re-filters on registry changes that keep the item count', () => {
  /**
   * Một lượt thay thế trọn trong cùng tick: bỏ `banana`, thêm `blueberry`. Hai
   * item đăng ký bằng `Map.set`/`Map.delete`, nên `.size` cuối cùng bằng đúng
   * `.size` ban đầu. Watcher cũ chỉ so `.size` nên không chạy lần nào, và bảng
   * `filtered` ở lại trạng thái trước khi thay: id cũ còn nguyên, item mới chưa
   * được chấm điểm nên `CommandItem.isRender` trả `true` cho nó ở lần render đầu
   * (id chưa có trong bảng nghĩa là "chưa biết", không phải "không khớp").
   */
  it('drops the replaced id and filters the new item in the same tick', async () => {
    const { items, itemTexts, command, wrapper } = mountCommand(['banana', 'apple']);

    mountedWrappers.push(wrapper);
    await flushPromises();

    command().filterState.search = 'app';
    await flushPromises();
    await nextTick();

    const removedId = idOfText(command(), 'banana');

    expect(command().filterState.filtered.items.has(removedId)).toBe(true);

    // Không `await` giữa hai lần gán: cả lượt thay thế nằm trong một tick, nên
    // watcher chỉ thấy giá trị cuối — đúng ca mà phép so `.size` bỏ sót.
    items.value = ['blueberry', 'apple'];
    await flushPromises();
    await nextTick();

    // `blueberry` không khớp 'app' nên không được hiện, dù nó vừa mount trong
    // lúc search đang bật.
    expect(itemTexts()).toContain('apple');
    expect(itemTexts()).not.toContain('blueberry');
    expect(command().filterState.filtered.count).toBe(1);

    // Khẳng định trên registry và bảng lọc, không chỉ trên DOM: id của item đã
    // rời đi phải mất ở **cả hai** nơi. Chỉ đếm phần tử còn lại thì test vẫn
    // xanh khi bảng `filtered` đã cũ.
    expect(command().allItems.value.has(removedId)).toBe(false);
    expect(command().filterState.filtered.items.has(removedId)).toBe(false);
    expect(command().filterState.filtered.items.get(idOfText(command(), 'blueberry'))).toBe(0);
    expect(command().filterState.filtered.items.get(idOfText(command(), 'apple'))).toBe(1);
  });

  it('hides the group once its last matching item is replaced, without a size change', async () => {
    const { items, command, wrapper } = mountCommand(['apple']);

    mountedWrappers.push(wrapper);
    await flushPromises();

    command().filterState.search = 'app';
    await flushPromises();
    await nextTick();

    const groupId = onlyId(command().allGroups.value);

    expect(wrapper.find('[data-slot="command-group"]').attributes('hidden')).toBeUndefined();

    // Thay item khớp bằng item không khớp: `allGroups` giữ nguyên số phần tử và
    // group vẫn còn id cũ trong set của nó, còn `allItems` cũng giữ nguyên
    // `.size`. Đọc `.size` ở cả hai registry thì không có tín hiệu nào để chạy
    // lại bộ lọc, và group rỗng vẫn được render.
    items.value = ['zzz-no-match'];
    await flushPromises();
    await nextTick();

    expect(wrapper.find('[data-slot="command-group"]').attributes('hidden')).toBeDefined();
    expect(command().filterState.filtered.groups.has(groupId)).toBe(false);
    expect(command().filterState.filtered.count).toBe(0);
  });
});

describe('Command does not keep a trace of items unmounted during a search', () => {
  it('removes an item from filtered.items when it unmounts mid-search', async () => {
    const { items, command, wrapper } = mountCommand(['apple', 'appetite']);

    mountedWrappers.push(wrapper);
    await flushPromises();

    command().filterState.search = 'app';
    await flushPromises();
    await nextTick();

    // Cả hai đều khớp 'app', nên cả hai đều có mặt trong bảng lọc.
    const removedId = idOfText(command(), 'apple');
    expect(command().filterState.filtered.items.has(removedId)).toBe(true);

    // Gỡ 'apple' trong lúc search vẫn đang bật: `onUnmounted` chỉ gỡ khỏi
    // `allItems`, và vòng lặp trong `filterItems` chỉ ghi những id còn nằm trong
    // `allItems` — nếu bảng không được dựng lại thì entry cũ nằm lại vĩnh viễn,
    // và bảng `filtered.items` không còn mô tả danh sách item đang tồn tại.
    items.value = ['appetite'];
    await flushPromises();
    await nextTick();

    expect(command().allItems.value.has(removedId)).toBe(false);
    expect(command().filterState.filtered.items.has(removedId)).toBe(false);
    // Item còn lại vẫn khớp nên phải có mặt: bảng được dựng lại đầy đủ, không chỉ
    // bị cắt bớt id đã mất.
    expect(command().filterState.filtered.items.has(idOfText(command(), 'appetite'))).toBe(true);
  });

  it('removes an item from allGroups when it unmounts, so the group is not treated as still holding a matching item', async () => {
    const { items, itemTexts, command, wrapper } = mountCommand(['apple']);

    mountedWrappers.push(wrapper);
    await flushPromises();

    command().filterState.search = 'app';
    await flushPromises();
    await nextTick();

    const groupId = onlyId(command().allGroups.value);
    const itemId = idOfText(command(), 'apple');

    // `allGroups` chỉ co lại khi `CommandGroup` unmount, nên id của item đã rời đi
    // vẫn nằm trong set của group; vòng tính `filtered.groups` vẫn thấy nó và
    // group trống vẫn được render (`CommandGroup.isRender` đọc chính set đó).
    items.value = [];
    await flushPromises();
    await nextTick();

    // Hệ quả mà người dùng thấy: group rỗng không được render. Đo được rằng triệu
    // chứng DOM này cần **cả** vế này lẫn việc dựng lại `filtered.items` trong
    // `Command.vue` cùng mất mới lộ ra (bỏ một vế thì vế kia vẫn che được) — nên
    // đây là assertion về hành vi, không phải về riêng một dòng code. Đặt trước
    // các assertion registry để nó là vế đầu tiên nổ, không bị chặn phía sau.
    expect(wrapper.find('[data-slot="command-group"]').attributes('hidden')).toBeDefined();

    expect(command().allGroups.value.get(groupId)?.has(itemId)).toBe(false);
    expect(command().filterState.filtered.groups.has(groupId)).toBe(false);
    expect(command().filterState.filtered.count).toBe(0);
    expect(itemTexts()).toEqual([]);
  });
});

describe('CommandItem outside CommandGroup', () => {
  it('renders when there is no wrapping CommandGroup', async () => {
    // List phẳng là cách compose hợp lệ, và type context đã khai `id?: string`.
    // `useCommandGroup()` không fallback sẽ ném
    // `Injection Symbol(CommandGroupContext) not found` ngay lúc setup.
    const Host = defineComponent({
      setup: () => () =>
        h(Command, null, {
          default: () =>
            h(CommandList, null, {
              default: () => h(CommandItem, { value: 'x' }, { default: () => 'item' }),
            }),
        }),
    });
    const wrapper = mount(Host, { attachTo: document.body });

    mountedWrappers.push(wrapper);
    await flushPromises();

    expect(wrapper.findAll('[data-slot="command-item"]').length).toBe(1);
  });
});
