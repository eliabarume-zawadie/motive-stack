/**
 * LOCAL STUB of the OpenAI Responses and Anthropic Messages endpoints, for DRY-RUNNING the live verification test
 * without keys or internet. It proves the test's own logic and the SDK wire handling only. It says NOTHING about the
 * real providers: results from it are never evidence of live verification.
 *
 *   npx tsx scripts/stub-provider.ts            (listens on http://127.0.0.1:3999)
 *   OPENAI_BASE_URL=http://127.0.0.1:3999/v1  ANTHROPIC_BASE_URL=http://127.0.0.1:3999  OPENAI_API_KEY=stub-key ...
 */
import { createServer } from "node:http";

const KEY = "stub-key";
const port = Number(process.env.STUB_PORT ?? 3999);

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    let body: any = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { /* ignore */ }

    if (req.method === "POST" && req.url === "/v1/responses") {
      if (req.headers.authorization !== `Bearer ${KEY}`) {
        return send(401, { error: { message: "Incorrect API key provided (stub).", type: "invalid_request_error", code: "invalid_api_key" } }, { "x-request-id": "req_stub_401" });
      }
      const structured = body.text?.format?.type === "json_schema";
      const text = structured ? JSON.stringify({ city: "Paris", country: "France" }) : "pong";
      return send(200, {
        id: "resp_stub_1", object: "response", status: "completed", model: body.model,
        output: [{ type: "message", role: "assistant", id: "m1", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
        usage: { input_tokens: 42, output_tokens: 12, total_tokens: 54 },
      }, { "x-request-id": "req_stub_openai" });
    }

    if (req.method === "POST" && req.url === "/v1/messages") {
      if (req.headers["x-api-key"] !== KEY) {
        return send(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key (stub)" } }, { "request-id": "req_stub_401" });
      }
      const structured = !!body.output_config?.format;
      const text = structured ? JSON.stringify({ city: "Paris", country: "France" }) : "pong";
      return send(200, {
        id: "msg_stub_1", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text }],
        stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 40, output_tokens: 11 },
      }, { "request-id": "req_stub_anthropic" });
    }
    send(404, { error: "not found" });
  });
});

server.listen(port, "127.0.0.1", () => console.log(`stub provider listening on http://127.0.0.1:${port}`));
