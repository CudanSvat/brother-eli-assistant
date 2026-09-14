/** How long to skip a rate-limited endpoint before trying it again. */
const COOLDOWN_MS = 5 * 60_000;

function rpcHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "rpc";
  }
}

/**
 * Parse one or more RPC URLs from env.
 * Accepts comma / semicolon / whitespace separators so Railway can hold
 * several Alchemy keys in a single `STARKNET_RPC_URL` variable.
 */
export function parseRpcUrls(...raw: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const chunk of raw) {
    if (!chunk) continue;
    for (const part of chunk.split(/[\s,;]+/)) {
      const url = part.trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

function looksRateLimited(status: number, body: string): boolean {
  if (status === 429) return true;
  return /\b429\b|capacity limit|rate.?limit|too many requests|monthly capacity/i.test(body);
}

/**
 * Fetch wrapper that retries the same JSON-RPC call on the next URL when
 * Alchemy (or another provider) returns 429 / capacity exceeded.
 */
export function createFailoverFetch(urls: string[]): typeof fetch {
  if (urls.length <= 1) return globalThis.fetch.bind(globalThis);

  let active = 0;
  const coolUntil = urls.map(() => 0);

  const pickNext = (exclude: Set<number>): number | null => {
    const now = Date.now();
    for (let n = 0; n < urls.length; n++) {
      const i = (active + n) % urls.length;
      if (exclude.has(i)) continue;
      if (coolUntil[i]! > now) continue;
      return i;
    }
    // Everything cooled — still try the least-recently-cooled one.
    let best: number | null = null;
    let bestUntil = Number.POSITIVE_INFINITY;
    for (let i = 0; i < urls.length; i++) {
      if (exclude.has(i)) continue;
      const until = coolUntil[i]!;
      if (until < bestUntil) {
        bestUntil = until;
        best = i;
      }
    }
    return best;
  };

  return async (_input, init) => {
    const tried = new Set<number>();
    let last: Response | undefined;

    while (tried.size < urls.length) {
      const idx = pickNext(tried);
      if (idx == null) break;
      tried.add(idx);

      const url = urls[idx]!;
      const res = await globalThis.fetch(url, init);
      let body = "";
      try {
        body = await res.clone().text();
      } catch {
        /* ignore */
      }

      if (looksRateLimited(res.status, body)) {
        coolUntil[idx] = Date.now() + COOLDOWN_MS;
        const next = (idx + 1) % urls.length;
        console.warn(
          `RPC ${rpcHost(url)} rate-limited (HTTP ${res.status}); cooling ${COOLDOWN_MS / 60_000}m, next ${rpcHost(urls[next]!)}`,
        );
        active = next;
        last = res;
        continue;
      }

      active = idx;
      return res;
    }

    return last ?? new Response("All RPC endpoints rate-limited", { status: 429 });
  };
}
