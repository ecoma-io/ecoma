import { createApp, toWebHandler } from 'h3';
import { describe, expect, it } from 'vitest';

import greet from './greet';

const handler = toWebHandler(createApp().use(greet));

async function getGreet(name?: string) {
  const search = name === undefined ? '' : `?name=${encodeURIComponent(name)}`;
  const response = await handler(new Request(`http://localhost/api/greet${search}`));

  return { status: response.status, body: await response.json() };
}

describe('greet', () => {
  it('greets World when the name query is absent', async () => {
    expect(await getGreet()).toEqual({
      status: 200,
      body: { message: 'Hello World' },
    });
  });

  it('greets the name from the query', async () => {
    expect(await getGreet('Ecoma')).toEqual({
      status: 200,
      body: { message: 'Hello Ecoma' },
    });
  });

  it('greets an empty name rather than falling back to World', async () => {
    // `q.name || 'World'` — chuỗi rỗng là falsy nên vẫn ra World. Khóa lại
    // hành vi này để đổi thành `??` không vô tình đổi contract của API.
    expect(await getGreet('')).toEqual({
      status: 200,
      body: { message: 'Hello World' },
    });
  });

  it('decodes a percent-encoded name', async () => {
    expect(await getGreet('Hồ Vân')).toEqual({
      status: 200,
      body: { message: 'Hello Hồ Vân' },
    });
  });

  it('treats a repeated query parameter as an array', async () => {
    // `getQuery` trả mảng khi param lặp lại; template literal sẽ join bằng
    // dấu phẩy. Ghi lại để thấy rõ API không validate input.
    const response = await handler(new Request('http://localhost/api/greet?name=A&name=B'));

    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: { message: 'Hello A,B' },
    });
  });
});
