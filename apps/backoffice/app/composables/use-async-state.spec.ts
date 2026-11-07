/**
 * State machine của `useAsyncState` — tầng mà bốn trang dữ liệu dùng chung.
 *
 * Test ở đây mount một component **host** tối thiểu gọi composable, không mount page:
 * mục đích là ghim hợp đồng của chính composable (thứ tự chuyển trạng thái, nhánh lỗi,
 * re-entry), và một host nhỏ làm điều đó rõ hơn một page có thêm search/filter.
 * `tests/page-data-states.spec.ts` kiểm các page thật dùng hợp đồng đó.
 *
 * ⚠️ Mọi `Promise` do adapter trả về đều do **test** settle (deferred), nên không test
 * nào phụ thuộc thời gian. Xem `tests/fake-adapter.ts` để biết vì sao không dùng
 * `sleep`.
 */
import { mount } from '@vue/test-utils';
import { defineComponent, nextTick } from 'vue';
import { describe, expect, it } from 'vitest';

import { useAsyncState } from './use-async-state';
import type { StaffMember } from '../backoffice-data/types';
import { createFakeBackofficeAdapter } from '../../tests/fake-adapter';
import { at, flushPromises } from '../../tests/harness';

const OLDER: readonly StaffMember[] = [
  {
    accountId: 'acct_00000000000000000000000000',
    displayName: 'Bản Cũ',
    status: 'active',
    roleIds: [],
    entitlements: [],
  },
];
const NEWER: readonly StaffMember[] = [
  {
    accountId: 'acct_11111111111111111111111111',
    displayName: 'Bản Mới',
    status: 'active',
    roleIds: [],
    entitlements: [],
  },
];

/**
 * Component host: gọi composable rồi render `kind` ra DOM, để test vừa khẳng định được
 * state nội bộ vừa thấy nó đã đi tới render.
 */
function mountHost<T>(load: () => Promise<T>) {
  const Host = defineComponent({
    setup() {
      const { state, reload } = useAsyncState(load);
      return { state, reload };
    },
    template: '<div data-testid="state-kind">{{ state.kind }}</div>',
  });

  return mount(Host);
}

describe('useAsyncState — data loading states', () => {
  it('starts in loading with no value to render as a result', async () => {
    const fake = createFakeBackofficeAdapter();
    const wrapper = mountHost(() => fake.adapter.listStaff());
    await flushPromises(wrapper);

    expect(wrapper.get('[data-testid="state-kind"]').text()).toBe('loading');
    expect(wrapper.vm.state).toEqual({ kind: 'loading' });

    await fake.settleAll();
    await flushPromises(wrapper);
  });

  it('resolves to ready with the exact value the adapter returned', async () => {
    const fake = createFakeBackofficeAdapter({ staff: NEWER });
    const wrapper = mountHost(() => fake.adapter.listStaff());
    await flushPromises(wrapper);

    at(fake.staffCalls).resolve(NEWER);
    await flushPromises(wrapper);

    expect(wrapper.vm.state).toEqual({ kind: 'ready', value: NEWER });
    expect(wrapper.get('[data-testid="state-kind"]').text()).toBe('ready');
  });

  it('stays in loading until the adapter settles, never jumping to empty or ready', async () => {
    const fake = createFakeBackofficeAdapter({ staff: NEWER });
    const wrapper = mountHost(() => fake.adapter.listStaff());
    await flushPromises(wrapper);

    // Nhiều vòng flush: nếu composable coi "chưa có giá trị" là rỗng thì nó đã nhảy
    // sang `empty` ở đây, và người dùng thấy "không có dữ liệu" thay vì "đang tải".
    await flushPromises(wrapper);
    await flushPromises(wrapper);
    expect(wrapper.vm.state.kind).toBe('loading');

    at(fake.staffCalls).resolve(NEWER);
    await flushPromises(wrapper);
    expect(wrapper.vm.state.kind).toBe('ready');
  });

  it('rejects to error, neither empty nor ready', async () => {
    const fake = createFakeBackofficeAdapter();
    const wrapper = mountHost(() => fake.adapter.listStaff());
    await flushPromises(wrapper);

    at(fake.staffCalls).reject(new Error('adapter hỏng'));
    await flushPromises(wrapper);

    expect(wrapper.vm.state).toEqual({ kind: 'error', message: 'adapter hỏng' });
  });

  it('rejects with a non-Error value → message is String(error), possibly "[object Object]"', async () => {
    const fake = createFakeBackofficeAdapter();
    const wrapper = mountHost(() => fake.adapter.listStaff());
    await flushPromises(wrapper);

    at(fake.staffCalls).reject({ status: 500 });
    await flushPromises(wrapper);

    expect(wrapper.vm.state).toEqual({ kind: 'error', message: '[object Object]' });
  });

  it('a caller-provided isEmpty yields empty, and empty is distinct from error', async () => {
    const fake = createFakeBackofficeAdapter({ staff: [] });
    const Host = defineComponent({
      setup() {
        const { state } = useAsyncState(
          () => fake.adapter.listStaff(),
          (value) => value.length === 0,
        );
        return { state };
      },
      template: '<div data-testid="state-kind">{{ state.kind }}</div>',
    });
    const wrapper = mount(Host);
    await flushPromises(wrapper);

    at(fake.staffCalls).resolve([]);
    await flushPromises(wrapper);

    expect(wrapper.vm.state).toEqual({ kind: 'empty' });
    expect(wrapper.vm.state).not.toHaveProperty('message');
  });

  it('treats an empty array as empty by default', async () => {
    const fake = createFakeBackofficeAdapter({ staff: [] });
    const Host = defineComponent({
      setup() {
        const { state } = useAsyncState(() => fake.adapter.listStaff());
        return { state };
      },
      template: '<div data-testid="state-kind">{{ state.kind }}</div>',
    });
    const wrapper = mount(Host);
    await flushPromises(wrapper);

    at(fake.staffCalls).resolve([]);
    await flushPromises(wrapper);

    expect(wrapper.vm.state).toEqual({ kind: 'empty' });
  });

  it('treats `undefined` as empty by default, not ready', async () => {
    // `undefined` là cách adapter báo "không có context cho handle này". Nếu nó vào
    // nhánh `ready`, template render `value: undefined` — một card trắng trơn, phá
    // đúng cam kết "`ready` bắt buộc có `value`" của kiểu.
    const wrapper = mountHost(() => Promise.resolve(undefined));
    await flushPromises(wrapper);

    expect(wrapper.vm.state).toEqual({ kind: 'empty' });
  });

  it('treats `null` as empty by default, not ready', async () => {
    const wrapper = mountHost(() => Promise.resolve(null));
    await flushPromises(wrapper);

    expect(wrapper.vm.state).toEqual({ kind: 'empty' });
  });

  it('reload after error → loading then ready with fresh data', async () => {
    const fake = createFakeBackofficeAdapter({ staff: NEWER });
    const wrapper = mountHost(() => fake.adapter.listStaff());
    await flushPromises(wrapper);

    at(fake.staffCalls).reject(new Error('lần đầu hỏng'));
    await flushPromises(wrapper);
    expect(wrapper.vm.state.kind).toBe('error');

    const reloaded = wrapper.vm.reload();
    await flushPromises(wrapper);
    expect(wrapper.vm.state).toEqual({ kind: 'loading' });
    expect(fake.staffCalls).toHaveLength(2);

    at(fake.staffCalls, 1).resolve(NEWER);
    await flushPromises(wrapper);

    expect(wrapper.vm.state).toEqual({ kind: 'ready', value: NEWER });
    await reloaded;
  });

  it('a superseded request finishing later does not overwrite the newer result', async () => {
    const fake = createFakeBackofficeAdapter();
    const wrapper = mountHost(() => fake.adapter.listStaff());
    await flushPromises(wrapper);

    // ⚠️ Không `await reload()`: promise đó chỉ resolve khi `load()` settle, mà ở đây
    // test cố tình giữ hai request cùng bay. `await` nó là treo test tới timeout.
    const first = at(fake.staffCalls);
    const reloading = wrapper.vm.reload();
    await nextTick();
    const second = at(fake.staffCalls, 1);

    // Request mới hoàn tất trước, request cũ hoàn tất sau — thứ tự ngược với thứ tự gọi.
    second.resolve(NEWER);
    await flushPromises(wrapper);
    expect(wrapper.vm.state).toEqual({ kind: 'ready', value: NEWER });

    first.resolve(OLDER);
    await flushPromises(wrapper);

    expect(wrapper.vm.state).toEqual({ kind: 'ready', value: NEWER });
    await reloading;
  });

  it('a superseded request finishing late does not restore a stale error', async () => {
    const fake = createFakeBackofficeAdapter();
    const wrapper = mountHost(() => fake.adapter.listStaff());
    await flushPromises(wrapper);

    const first = at(fake.staffCalls);
    const reloading = wrapper.vm.reload();
    await nextTick();
    const second = at(fake.staffCalls, 1);

    second.resolve(NEWER);
    await flushPromises(wrapper);
    expect(wrapper.vm.state).toEqual({ kind: 'ready', value: NEWER });

    first.reject(new Error('lần gọi cũ đã hỏng'));
    await flushPromises(wrapper);

    expect(wrapper.vm.state).toEqual({ kind: 'ready', value: NEWER });
    await reloading;
  });

  it('a superseded request settling while the newer one is pending shows no stale result', async () => {
    const fake = createFakeBackofficeAdapter();
    const wrapper = mountHost(() => fake.adapter.listStaff());
    await flushPromises(wrapper);

    const first = at(fake.staffCalls);
    const reloading = wrapper.vm.reload();
    await nextTick();
    const second = at(fake.staffCalls, 1);

    // Request mới vẫn đang chờ. Kết quả của request cũ không phải kết quả hiện hành.
    first.resolve(OLDER);
    await flushPromises(wrapper);

    expect(wrapper.vm.state).toEqual({ kind: 'loading' });

    second.resolve(NEWER);
    await flushPromises(wrapper);
    expect(wrapper.vm.state).toEqual({ kind: 'ready', value: NEWER });
    await reloading;
  });

  it('unmount before the adapter settles throws nothing and leaves no unhandled rejection', async () => {
    const fake = createFakeBackofficeAdapter();
    const unhandled: unknown[] = [];
    const track = (reason: unknown): void => {
      unhandled.push(reason);
    };

    const wrapper = mountHost(() => fake.adapter.listStaff());
    await flushPromises(wrapper);
    expect(fake.staffCalls).toHaveLength(1);

    process.on('unhandledRejection', track);
    try {
      await wrapper.unmount();

      // Cả hai chiều đều phải có người bắt: promise của một component đã unmount không
      // còn ai await, nên một nhánh thiếu `catch` sẽ thành unhandled rejection.
      at(fake.staffCalls).resolve(NEWER);
      await flushPromises();

      const second = createFakeBackofficeAdapter();
      const other = mountHost(() => second.adapter.listStaff());
      await flushPromises(other);
      await other.unmount();
      at(second.staffCalls).reject(new Error('sau khi unmount'));
      await flushPromises();
    } finally {
      process.off('unhandledRejection', track);
    }

    expect(unhandled).toEqual([]);
  });
});
