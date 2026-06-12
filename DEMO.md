# Harbor — Demo Guide

**Harbor helps immigrants & newcomers rent safely and find where they belong.**
It fuses two things Zillow never does: it catches rental **scams**, and it scores a neighborhood
for **cultural belonging** — then ties them into one recommendation.

---

## Full feature list

### 🚨 Scam protection
- Accepts a listing as **plain text, a URL** (auto-fetched & cleaned), or a **screenshot** (Gemini vision reads it).
- Detects real scam patterns: **below-market bait** (judged against the area's real market), **off-platform/irreversible payment** (Zelle, wire, gift cards, crypto), **deposit-before-viewing**, **absentee/abroad landlord**, **urgency/pressure**, **refusal to show the unit**, **reused/stock photos**, and **tactics that target newcomers / non-English speakers**.
- **Risk verdict**: `safe / caution / scam`, with each red flag explained.
- **Know-your-rights**: which move-in fees are legal vs illegal (Massachusetts).
- **What-to-do** next steps.
- **Auto-drafted complaint** to the state Attorney General — one-tap **copy**.

### 🏡 Cultural-fit filter
- "Where you're from" + a quick survey → a structured **cultural profile** with weighted priorities.
- **Real, named nearby places** pulled **live from Google Search** (not hallucinated) — ethnic groceries, community centers, places of worship, cafés with cultural events (mahjong, language meetups), language services.
- **6 scored dimensions**: food, community, faith, social, language, safety.
- **Honest gaps** ("no Vietnamese grocery within 2 mi").
- **Citations** on every claim — fact-checked, with source links.

### 🔗 The two working together (the differentiator)
- **Shared location** — the scam check and the cultural fit run on the *same* place. Paste only a listing and it **derives the location from the listing itself**.
- **Location-aware scam check** — below-market detection uses *that area's* real market, and knows the renter is a newcomer.
- **One unified verdict** — a final agent reads *both* results: e.g. *"Quincy is a strong cultural fit — but this listing is a scam. Use these real, safe places nearby instead."*

### 🌍 Built for newcomers
- **Multilingual** — every agent answers in the user's chosen language.
- Bright, **dropdown-driven** UI (no blank-page typing), chips, one-tap demo.
- No database; one Node server runs the API *and* the UI. Structured JSON outputs, transient-error retries, friendly quota messages.

---

## Demo script (2–3 min)

1. **The problem (15s).** "Newcomers get hit from two sides: rental scammers target them, and tools like Zillow show schools and groceries but never whether *your* community is nearby. Harbor does both — together."
2. **One click.** Hit **✨ Try a demo** → it fills a realistic scam listing + Quincy + a Cantonese/Hong Kong profile → **🔎 Check it out**.
3. **Lead with the verdict (the wow).** Read the banner: *"Quincy is a strong cultural fit, but this listing is a scam."* "That sentence is two AI agents talking to each other — the safety check and the belonging score, fused."
4. **Scam detail.** Point at the flags (Zelle deposit, landlord abroad, no showings, below-market), then expand the **draft complaint** and hit **Copy** — "ready to send to the AG."
5. **Cultural fit.** Scroll to the dimension scores and the **real places** — "Kam Man Foods, the community center — each with a live citation. Not made up."
6. **Language flip (optional).** Switch results language to 中文 / Español and rerun — same intelligence, the user's language.
7. **Close.** "Same listing, same neighborhood, one verdict: don't pay this scam — here's where you'll actually belong, safely."

**One-liner:** *"Harbor is a rental copilot for immigrants — it spots the scam and finds your community, in one answer, in your language."*

---

## How the multi-agent system works together

Harbor is a **code-orchestrated pipeline of 6 specialized agents** (Google Gemini). Each agent has a single job, its own prompt, and a strict output contract (structured JSON, or grounded search). The orchestrator (`culturalFit()` in `server/index.mjs`) wires their outputs together — the agents don't free-roam; the code decides the hand-offs.

```
                 ┌─────────────┐
   your survey ─▶│  PROFILE    │── cultural profile (weights) ─┐──────────────┐
                 └─────────────┘                               │              │
                 ┌─────────────┐                               ▼              ▼
   your listing ▶│   SCOUT     │── listing facts ─┬─────▶┌───────────┐  ┌───────────┐
   (text/URL/img)└─────────────┘                  │      │ INSPECTOR │  │ DISCOVER  │
                         │  (its address)          │      │ scam risk │  │ grounded  │
                         ▼                         │      │  + flags  │  │  search   │
                 ┌──── shared location ────────────┘      └─────┬─────┘  └─────┬─────┘
                 │ (your area, OR the listing's own)            │ scam result  │ real
                 └──────────────────────────────────┐          │              │ places +
                                                     ▼          ▼              ▼ citations
                                              ┌──────────────────────────────────────┐
                                              │  FILTER  → cultural-fit scores +      │
                                              │           ONE unified VERDICT         │
                                              │           (reads BOTH sides)          │
                                              └───────────────────┬──────────────────┘
                                                                  │ if risk ≠ safe
                                                                  ▼
                                                          ┌────────────────┐
                                                          │ RIGHTS_RECOURSE│
                                                          │ rights + steps │
                                                          │ + draft AG     │
                                                          │   complaint    │
                                                          └────────────────┘
```

**The six agents**

| Agent | Job | Tech |
|---|---|---|
| **PROFILE** | Turns "where you're from" + survey into a weighted cultural profile | structured JSON |
| **SCOUT** | Extracts listing facts from text / URL / screenshot | structured JSON + **vision** |
| **INSPECTOR** | Scores scam risk + flags, aware of the *area's market* and that the renter is a newcomer | structured JSON |
| **DISCOVER** | Finds *real* nearby cultural places + neighborhood facts | **Google Search grounding** (citations) |
| **FILTER** | Scores the 6 cultural dimensions **and** fuses in the scam result to write the unified verdict | structured JSON |
| **RIGHTS_RECOURSE** | Legal fees + next steps + draft AG complaint (only runs if the listing is risky) | structured JSON |

**How they actually integrate (not just side-by-side):**
1. **PROFILE** feeds three agents — it tells INSPECTOR the renter is a newcomer, tells DISCOVER what to search for, and gives FILTER its scoring weights.
2. **SCOUT** does double duty: its facts feed INSPECTOR, and its extracted address becomes the **shared location** when you didn't pick an area — so the scam check and the cultural search are always about the *same place*.
3. **INSPECTOR's** scam result is **passed into FILTER**, so the cultural agent can write a verdict that references the danger.
4. **FILTER** produces the single takeaway that mentions *both* belonging and safety.
5. **RIGHTS_RECOURSE** is **gated** — it only spends a call when the listing is `caution`/`scam`, so safe listings stay fast.

**Why a pipeline, not one big prompt:** each agent stays small and reliable (one schema, one job), you can swap/upgrade one without touching the others, and grounding (DISCOVER) is isolated from the JSON-mode agents (Gemini can't do forced-JSON and live search in the same call).
