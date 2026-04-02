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

## If you still want Airtable

Keep Airtable access **server-side** (e.g. Cloudflare Worker / Netlify function) and have the browser call *your* endpoint. That endpoint can:

- Validate requests / rate-limit
- Use your Airtable token safely
- Return a sanitized JSON array in the same format as `terraces.json`

