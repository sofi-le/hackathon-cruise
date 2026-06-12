# Harbor — find where you belong, not just where you live

A **cultural-fit filter** for newcomers and diaspora. You tell it *where you're from*; it scores a
neighborhood for **belonging** — the cultural and social layer Zillow ignores — with **real, named
places and citations** (Google Search grounding). It's a *filter*, not a feed.

Backend: one standalone Node server on the **Google Gemini API** (`gemini-2.5-flash`, key
server-side only). **No database** — just run it.

```
PROFILE  ──▶  DISCOVER (grounded)  ──▶  FILTER
(your background)  (real nearby places + facts)  (cultural-fit score per dimension)
```

Dimensions scored: **food** (ethnic groceries/markets), **community** (diaspora, cultural orgs,
Chinatown-type hubs), **faith**, **social** (cafés/clubs with events like mahjong & language
meetups), **language access**, and **safety** (factual). A rental **scam check** runs as an
optional sub-step when a listing is included.

---

## Endpoints

### `POST /cultural-fit`  — main feature

```jsonc
// request
{
  "location": "Quincy, MA 02169",          // required: address, neighborhood, or ZIP
  "origin":   "Hong Kong (Cantonese)",     // optional but recommended
  "languages": ["Cantonese", "English"],   // optional
  "survey":   { "cook_at_home": "...", "faith": "...", "social": ["mahjong"] }, // optional, free-form
  "lang":     "English",                   // optional: every field answered in this language
  "listing":  "..."                        // optional: text/URL/screenshot -> also runs scam check
}

// response
{
  "cultural_fit": { "score": 0-100, "summary": "..." },
  "dimensions": [
    { "key": "food", "label": "...", "score": 0-100, "why": "...",
      "places": [ { "name": "...", "type": "grocery", "distance": "1.2mi", "note": "...", "source": "https://..." } ] }
    // food | community | faith | social | language | safety
  ],
  "safety": { "summary": "..." },
  "gaps": [ "No nearby Vietnamese grocery within 2mi", "..." ],
  "sources": [ { "title": "...", "url": "https://..." } ],   // citations = fact-checking
  "profile": { ... },                                        // structured profile (transparency)
  "scam":    { "risk": "scam", "flags": [ { "flag": "...", "why": "..." } ] }  // only if `listing` sent
}
```

### `POST /analyze-listing`  — full rental-scam analysis (sub feature)

`{ input, lang }` → `{ risk, flags, rights, next_steps, draft_complaint, listing }`. `input` can be
text, an http(s) URL, or a base64 screenshot (vision auto-used).

---

## Run it

Needs Node 20.6+ (built-in `--env-file` and `fetch`). Get a Gemini key (free tier) at
https://aistudio.google.com/apikey — grounding is included.

```bash
cd server
cp .env.example .env          # paste your GEMINI_API_KEY
npm install
npm start                     # -> http://localhost:8787
```

Smoke test:

```bash
curl -X POST http://localhost:8787/cultural-fit \
  -H "Content-Type: application/json" \
  -d '{"location":"Quincy, MA 02169","origin":"Hong Kong (Cantonese)","languages":["Cantonese"],"survey":{"social":["mahjong"],"cook_at_home":"Cantonese groceries"},"lang":"English"}'
```

---

## Frontend (Lovable / React)

```ts
const BASE = "http://localhost:8787"; // swap to your tunnel/deploy URL

export async function culturalFit(args: {
  location: string;
  origin?: string;
  languages?: string[];
  survey?: Record<string, unknown>;
  lang?: string;
  listing?: string;
}) {
  const res = await fetch(`${BASE}/cultural-fit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
  return res.json();
}

// Optional: dedicated scam check
export async function analyzeListing(input: string, lang = "English") {
  const res = await fetch(`${BASE}/analyze-listing`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input, lang }),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
  return res.json();
}
```

CORS is open (`*`). To call it from a deployed Lovable app (HTTPS), expose your local server over
HTTPS with a tunnel: `cloudflared tunnel --url http://localhost:8787`, then use that URL as `BASE`.

---

## Files

- `server/index.mjs` — the whole backend: cultural-fit pipeline + grounding + scam sub-check + CORS.
- `server/seed.json` — cultural-fit demo profiles/locations + scam-check examples + HUD FMR baseline.
- `server/.env.example` — copy to `.env`, add your `GEMINI_API_KEY`.

**Onboarding the survey:** the `survey` object is free-form — send whatever your onboarding asks
(heritage, languages, what you cook, faith, social interests, what you care most about). The PROFILE
agent structures it and infers sensible defaults when answers are sparse.
