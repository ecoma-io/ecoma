/**
 * HTTP client chạy TRONG platform network — container ephemeral `node <file>`
 * mount repo read-only chạy đúng file này (node thuần, không dependency). Đầu
 * vào: MỘT JSON request trên stdin `{url, method, headers, body}`; đầu ra:
 * MỘT dòng JSON `{status, body}` trên stdout.
 *
 * Fence cấu trúc: output KHÔNG BAO GIỜ echo headers (Authorization đi qua
 * stdin của pipeline, không qua argv của process nào và không quay ra output);
 * body response được giữ nguyên văn vì suite assert trên nó — worker không
 * bao giờ echo prompt vào response, nên fence prompt nằm ở suite, không ở đây.
 */

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  raw += chunk;
}

const request = JSON.parse(raw);
const response = await fetch(request.url, {
  method: request.method ?? 'GET',
  headers: request.headers ?? {},
  ...(request.body === undefined ? {} : { body: request.body }),
});
const body = await response.text();
process.stdout.write(`${JSON.stringify({ status: response.status, body })}\n`);
