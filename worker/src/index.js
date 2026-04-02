function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET,OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function badRequest(message) {
  return json({ error: message }, { status: 400 });
}

function serverError(message) {
  return json({ error: message }, { status: 500 });
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

    if (request.method === "OPTIONS") {
      return json({ ok: true });
    }

    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, { status: 405 });
    }

    // Routes:
    // - GET /terraces → array of terrace objects
    if (url.pathname !== "/terraces") {
      return json({ error: "Not found" }, { status: 404 });
    }

    const token = env.AIRTABLE_TOKEN;
    const baseId = env.AIRTABLE_BASE_ID;
    const table = env.AIRTABLE_TABLE || "Terraces";

    if (!token) return serverError("Missing AIRTABLE_TOKEN");
    if (!baseId) return serverError("Missing AIRTABLE_BASE_ID");

    // Airtable API
    const airtableUrl = new URL(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`);
    airtableUrl.searchParams.set("maxRecords", "100");
    airtableUrl.searchParams.set("filterByFormula", "{active}=1");

    let res;
    try {
      res = await fetch(airtableUrl.toString(), {
        headers: { authorization: `Bearer ${token}` },
        cf: {
          cacheTtl: 60,
          cacheEverything: true,
        },
      });
    } catch (e) {
      return serverError("Failed to reach Airtable");
    }

    if (!res.ok) {
      return serverError(`Airtable error (${res.status})`);
    }

    const data = await res.json();
    const records = Array.isArray(data?.records) ? data.records : [];
    const terraces = records.map((r) => sanitizeTerrace(r.fields || {})).filter((t) => {
      return Number.isFinite(t.lat) && Number.isFinite(t.lng);
    });

    return json(terraces, {
      headers: {
        "cache-control": "public, max-age=60",
      },
    });
  },
};

