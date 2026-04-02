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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return json({ ok: true });
    if (request.method !== "GET") return json({ error: "Method not allowed" }, { status: 405 });
    if (url.pathname !== "/terraces") return json({ error: "Not found" }, { status: 404 });

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

    return json(terraces, {
      headers: { "cache-control": "public, max-age=60" },
    });
  },
};

