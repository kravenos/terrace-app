function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET,OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function sanitizeTerrace(fields) {
  return {
    name: fields.name ?? fields.Name ?? "?",
    lat: Number(fields.lat),
    lng: Number(fields.lng),
    facing: Number.isFinite(Number(fields.facing)) ? Number(fields.facing) : 180,
    shade_direction: Number(fields.shade_direction) || 0,
    shade_min_altitude: Number(fields.shade_min_altitude) || 0,
    description: fields.description ?? "",
  };
}

function getClientIp(request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

async function checkRateLimit(request, ctx, { maxPerMinute }) {
  if (!maxPerMinute || maxPerMinute <= 0) return null;

  const ip = getClientIp(request);
  const minute = Math.floor(Date.now() / 60000);
  const keyUrl = new URL(request.url);
  keyUrl.pathname = `/__rl/${encodeURIComponent(ip)}/${minute}`;
  keyUrl.search = "";
  const key = new Request(keyUrl.toString(), { method: "GET" });

  const cache = caches.default;
  const existing = await cache.match(key);
  const count = existing ? Number(await existing.text()) || 0 : 0;
  if (count >= maxPerMinute) {
    return json(
      {
        error: "Rate limited",
        hint: `Too many requests. Try again in a minute.`,
      },
      {
        status: 429,
        headers: {
          "retry-after": "60",
          "cache-control": "no-store",
        },
      },
    );
  }

  const next = String(count + 1);
  const res = new Response(next, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      // keep the counter around slightly longer than a minute bucket
      "cache-control": "public, max-age=70",
    },
  });
  ctx.waitUntil(cache.put(key, res));
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return json({ ok: true });
    if (request.method !== "GET") return json({ error: "Method not allowed" }, { status: 405 });
    if (url.pathname !== "/terraces") return json({ error: "Not found" }, { status: 404 });

    const rl = await checkRateLimit(request, ctx, { maxPerMinute: Number(env.RATE_LIMIT_PER_MINUTE || 60) });
    if (rl) return rl;

    // Edge-cache the final JSON response to reduce Airtable hits
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const cached = await cache.match(cacheKey);
    if (cached) {
      const hit = new Response(cached.body, cached);
      hit.headers.set("x-cache", "HIT");
      return hit;
    }

    const token = env.AIRTABLE_TOKEN;
    const baseId = env.AIRTABLE_BASE_ID;
    const table = env.AIRTABLE_TABLE || "Terraces";
    const filter = env.AIRTABLE_FILTER || "";

    if (!token) return json({ error: "Missing AIRTABLE_TOKEN" }, { status: 500 });
    if (!baseId) return json({ error: "Missing AIRTABLE_BASE_ID" }, { status: 500 });
    const tokenTrimmed = typeof token === "string" ? token.trim() : "";
    if (!/^pat[a-zA-Z0-9_.-]{10,}$/.test(tokenTrimmed)) {
      return json(
        {
          error: "Invalid AIRTABLE_TOKEN",
          hint: "AIRTABLE_TOKEN should start with pat… (no quotes, no spaces). Re-set it with `wrangler secret put AIRTABLE_TOKEN`.",
        },
        { status: 500 },
      );
    }
    if (typeof baseId !== "string" || !/^app[a-zA-Z0-9]{10,}$/.test(baseId.trim())) {
      return json(
        {
          error: "Invalid AIRTABLE_BASE_ID",
          hint: "AIRTABLE_BASE_ID should look like appXXXXXXXXXXXXXX (no quotes, no spaces). Re-set it with `wrangler secret put AIRTABLE_BASE_ID`.",
        },
        { status: 500 },
      );
    }

    const airtableUrl = new URL(`https://api.airtable.com/v0/${baseId.trim()}/${encodeURIComponent(table)}`);
    airtableUrl.searchParams.set("maxRecords", "100");
    if (filter) airtableUrl.searchParams.set("filterByFormula", filter);

    let res;
    try {
      res = await fetch(airtableUrl.toString(), {
        headers: { authorization: `Bearer ${tokenTrimmed}` },
        cf: { cacheTtl: 60, cacheEverything: true },
      });
    } catch {
      return json({ error: "Failed to reach Airtable" }, { status: 502 });
    }

    if (!res.ok) {
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      let details;
      try {
        if (ct.includes("application/json")) {
          const j = await res.json();
          details = j?.error?.message || j?.error || j;
        } else {
          const txt = await res.text();
          details = txt ? txt.slice(0, 2000) : undefined;
        }
      } catch {
        details = undefined;
      }
      return json(
        {
          error: `Airtable error (${res.status})`,
          details,
          debug: {
            table,
            filterEnabled: Boolean(filter),
            baseIdPrefix: typeof baseId === "string" ? baseId.slice(0, 3) : null,
            tokenPrefix: tokenTrimmed ? tokenTrimmed.slice(0, 3) : null,
          },
          hint:
            res.status === 400
              ? "Check AIRTABLE_BASE_ID / AIRTABLE_TABLE / AIRTABLE_FILTER. If you used a filter, try removing it."
              : res.status === 401
                ? "Token rejected. Re-set AIRTABLE_TOKEN and ensure it has access to this base with records:read scope."
              : undefined,
        },
        { status: 502 },
      );
    }

    const data = await res.json();
    const records = Array.isArray(data?.records) ? data.records : [];
    const terraces = records
      .map((r) => sanitizeTerrace(r.fields || {}))
      .filter((t) => Number.isFinite(t.lat) && Number.isFinite(t.lng));

    const out = json(terraces, {
      headers: { "cache-control": "public, max-age=60" },
    });
    out.headers.set("x-cache", "MISS");
    ctx.waitUntil(cache.put(cacheKey, out.clone()));
    return out;
  },
};

