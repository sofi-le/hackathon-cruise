# Harbor — rental-scam detector for immigrants

Backend: one standalone Node server running a 3-step agent pipeline on the Claude API
(`claude-sonnet-4-6`, key server-side only). **No database, no Supabase** — just run it.

```
SCOUT  ──▶  INSPECTOR  ──▶  RIGHTS_RECOURSE
(extract)   (flag scams)    (legal fees + draft AG complaint)
```

Frontend calls one async function `analyzeListing(input, lang)`; the backend returns:

```ts
{ risk, flags, rights, next_steps, draft_complaint, listing }
//  risk: "safe" | "caution" | "scam"
//  flags: { flag, why }[]
//  next_steps: string[]
//  draft_complaint: string  (ready to send to the MA Attorney General)
```

`input` can be **plain text**, an **http(s) URL**, or a **base64 screenshot** (data URL or raw
base64 — vision is used automatically for images). Every agent answers in `lang`.

---

## Run it (3 commands)

Needs Node 20.6+ (uses built-in `--env-file` and global `fetch`).

```bash
cd server
cp .env.example .env          # then paste your ANTHROPIC_API_KEY into .env
npm install
npm start                     # -> http://localhost:8787
```

Smoke test in another terminal:

```bash
curl -X POST http://localhost:8787/analyze-listing \
  -H "Content-Type: application/json" \
  -d '{"input":"2BR South End 02118 $1,200/mo, landlord abroad, pay deposit by Zelle, no showings","lang":"English"}'
```

---

## Frontend (Lovable / React)

```ts
const ENDPOINT = "http://localhost:8787/analyze-listing"; // swap to your deployed URL later

export async function analyzeListing(input: string, lang: string) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input, lang }),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
  return res.json(); // { risk, flags, rights, next_steps, draft_complaint, listing }
}

// Screenshot upload → pass the data URL straight in as `input`:
//   const dataUrl = await new Promise<string>(r => {
//     const fr = new FileReader(); fr.onload = () => r(fr.result as string);
//     fr.readAsDataURL(file);
//   });
//   const result = await analyzeListing(dataUrl, "Spanish");
```

CORS is open (`*`) so the browser can call it directly during the hackathon.

---

## Files

- `server/index.mjs` — the whole backend (pipeline + input handling + CORS). One file.
- `server/seed.json` — 5 demo listings (3 scams, 2 legit) + hardcoded HUD Fair Market Rent
  baseline for Boston ZIP 02118. Use these to demo without typing.
- `server/.env.example` — copy to `.env`, add your key.

The HUD FMR baseline is also hardcoded inside `index.mjs` and fed to the INSPECTOR agent so it can
score below-market bait pricing.
