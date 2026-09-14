import { parseRpcUrls, createFailoverFetch } from "../src/lib/rpc.ts";

const urls = parseRpcUrls(
  "https://a.example/v2/k1, https://b.example/v2/k2",
  "https://a.example/v2/k1",
);
if (urls.length !== 2) throw new Error(`expected 2 urls, got ${urls.length}`);

const orig = globalThis.fetch;
let calls = 0;
globalThis.fetch = (async (url: RequestInfo | URL) => {
  calls += 1;
  const s = String(url);
  if (s.includes("a.example")) {
    return new Response(
      JSON.stringify({ error: { code: 429, message: "Monthly capacity limit exceeded" } }),
      { status: 429 },
    );
  }
  return new Response(JSON.stringify({ jsonrpc: "2.0", result: 1 }), { status: 200 });
}) as typeof fetch;

const res = await createFailoverFetch(urls)("https://ignored", { method: "POST", body: "{}" });
globalThis.fetch = orig;

if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
if (calls !== 2) throw new Error(`expected 2 fetches, got ${calls}`);
console.log("rpc failover ok");
