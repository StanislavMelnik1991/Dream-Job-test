import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { createTriageServer } from "./server.mjs";

const server = createTriageServer();
const manualReview = { status: "manual_review", topic: null, draft: null };
let url;

before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `http://127.0.0.1:${server.address().port}/api/triage`;
});

after(async () => {
  const closed = once(server, "close");
  server.close();
  await closed;
});

function post(body) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

test("возвращает допустимую тему и черновик", async () => {
  const cases = [
    ["Когда будет доставка?", "delivery"],
    ["Какая цена?", "pricing"],
    ["Добрый день!", "other"],
  ];
  for (const [text, topic] of cases) {
    const response = await post(JSON.stringify({ text }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ready",
      topic,
      draft: "Спасибо за обращение. Уточним детали заявки.",
    });
  }
});

test("возвращает HTTP 400 для невалидного ввода", async () => {
  const bodies = ["", "{", "null", "{}", '{"text":null}', '{"text":42}', '{"text":""}', '{"text":" \\n\\t"}'];
  for (const body of bodies) {
    const response = await post(body);
    assert.equal(response.status, 400, `Тело запроса ${JSON.stringify(body)}`);
    assert.deepEqual(await response.json(), { status: "invalid_input" });
  }
});

test("отправляет заявку на ручной разбор при ошибке или некорректном ответе модели", async () => {
  for (const text of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
    const response = await post(JSON.stringify({ text }));
    assert.equal(response.status, 200, text);
    assert.deepEqual(await response.json(), manualReview, text);
  }
});

test("отправляет заявку на ручной разбор, не дожидаясь задержки имитатора", { timeout: 900 }, async () => {
  const response = await post(JSON.stringify({ text: "[timeout]" }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), manualReview);
});

test("ограничивает размер тела запроса", async () => {
  const response = await post(JSON.stringify({ text: "а".repeat(33_000) }));
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { status: "payload_too_large" });
});
