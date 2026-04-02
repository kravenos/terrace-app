# Sunny terrace finder (static)

This is a **static** (GitHub Pages-friendly) prototype that:

- Computes sun altitude/azimuth deterministically in the browser
- Fetches weather (cloud cover) from Open-Meteo (no API key)
- Loads terrace metadata from `terraces.json` (no secrets in frontend)

## Security (important)

Do **not** put Airtable tokens / API keys in `index.html`. If you previously published a Personal Access Token, **rotate it immediately** in Airtable.

## Terrace data

Edit `terraces.json`:

```json
[
  {
    "name": "Terrace name",
    "lat": 52.37,
    "lng": 4.90,
    "facing": 225,
    "shade_direction": 315,
    "shade_min_altitude": 18,
    "description": "Optional"
  }
]
```

Angles are degrees where:

- `0` = North, `90` = East, `180` = South, `270` = West

## Optional: load terraces from a public URL

If you want to host the JSON elsewhere, set this before calling `run()`:

```html
<script>
  window.TERRACES_URL = "terraces.json";
</script>
```

## Airtable via Cloudflare Worker (secure)

This repo includes a Worker in `worker/` that exposes:

- `GET /terraces` → returns a JSON array matching the `terraces.json` format

### Deploy

1. Install Wrangler and login:

```bash
npm i -g wrangler
wrangler login
```

2. Configure the Worker:

- Edit `worker/wrangler.toml` and set `AIRTABLE_TABLE` if needed.
- Set secrets/vars (do **not** commit tokens):

```bash
cd worker
wrangler secret put AIRTABLE_TOKEN
wrangler secret put AIRTABLE_BASE_ID
wrangler deploy
```

3. Point the web app at your Worker URL:

Add this near the top of `index.html` (before `run()` is used), or put it in a small `<script>` tag above the main script:

```html
<script>
  window.TERRACES_URL = "https://YOUR-WORKER.your-subdomain.workers.dev/terraces";
</script>
```


