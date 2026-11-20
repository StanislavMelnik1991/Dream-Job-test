import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));
const maxBodyBytes = 64 * 1024;
const modelTimeoutMs = 300;
const topics = new Set(["delivery", "pricing", "other"]);
const invalidInput = { status: "invalid_input" };
const manualReview = { status: "manual_review", topic: null, draft: null };

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function handleTriage(request, response) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > maxBodyBytes) {
      response.setHeader("Connection", "close");
      request.resume();
      return json(response, 413, { status: "payload_too_large" });
    }
    chunks.push(chunk);
  }

  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  } catch {
    return json(response, 400, invalidInput);
  }
  if (typeof input?.text !== "string" || !input.text.trim()) {
    return json(response, 400, invalidInput);
  }

  return json(response, 200, await triage(input.text));
}

async function triage(text) {
  const controller = new AbortController();
  let timer;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error("Model timed out"));
        controller.abort();
      }, modelTimeoutMs);
    });
    const raw = await Promise.race([classify(text, { signal: controller.signal }), deadline]);
    if (typeof raw !== "string") return manualReview;

    const result = JSON.parse(raw);
    if (!topics.has(result?.topic) || typeof result.draft !== "string" || !result.draft.trim()) {
      return manualReview;
    }
    return { status: "ready", topic: result.topic, draft: result.draft };
  } catch {
    return manualReview;
  } finally {
    clearTimeout(timer);
  }
}

export function createTriageServer() {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      await handleTriage(request, response);
    } catch {
      if (!response.destroyed && !response.headersSent) {
        json(response, 500, { status: "server_error" });
      }
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createTriageServer().listen(Number(process.env.PORT || 3000), "127.0.0.1");
}
