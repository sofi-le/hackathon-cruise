// Harbor — rental-scam detector backend (standalone demo server, no database)
// 3-step agent pipeline on the Google Gemini API. Run with: npm start
//
// Frontend contract:  POST /analyze-listing  { input: string, lang: string }
//   input -> plain text, an http(s) URL, OR a base64 screenshot (data URL or raw base64)
//   lang  -> language name/code; every agent answers in this language
// Returns: { risk, flags, rights, next_steps, draft_complaint, listing }

import express from "express";
import { GoogleGenAI } from "@google/genai";

const MODEL = "gemini-2.5-flash";
const PORT = process.env.PORT || 8787;

if (!process.env.GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY. Add it to server/.env (see .env.example).");
  process.exit(1);
}
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }); // server-side only

// ---------------------------------------------------------------------------
// Hardcoded HUD Fair Market Rent baseline for one Boston ZIP (FY2024, approx.)
// South End, Boston-Cambridge-Quincy MA-NH HUD Metro FMR Area.
// ---------------------------------------------------------------------------
const HUD_FMR = {
  zip: "02118",
  area: "Boston-Cambridge-Quincy, MA-NH HUD Metro FMR Area",
  year: 2024,
  monthly_fmr_usd: { "0": 2096, "1": 2364, "2": 2826, "3": 3543, "4": 3879 },
};

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------
const IMG_MAGIC = {
  "/9j/": "image/jpeg",
  "iVBORw0KGgo": "image/png",
  "R0lGOD": "image/gif",
  "UklGR": "image/webp",
};

function imageMediaType(b64) {
  for (const [magic, mime] of Object.entries(IMG_MAGIC)) {
    if (b64.startsWith(magic)) return mime;
  }
  return null;
}

async function fetchUrlText(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (HarborBot)" },
      signal: AbortSignal.timeout(8000),
    });
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return `SOURCE URL: ${url}\n\nPAGE TEXT:\n${text.slice(0, 6000)}`;
  } catch {
    return `SOURCE URL (could not be fetched, analyze the URL itself): ${url}`;
  }
}

const imageTextPart = () => ({
  text: "This is a screenshot of a rental listing. Read it carefully and extract the listing details.",
});

// Decide how to feed `input` to the SCOUT agent. Returns an array of Gemini "parts".
async function buildScoutContent(input) {
  const trimmed = input.trim();

  // data URL screenshot
  const dataUrl = trimmed.match(/^data:(image\/[a-zA-Z.+-]+);base64,(.+)$/s);
  if (dataUrl) {
    return [
      imageTextPart(),
      { inlineData: { mimeType: dataUrl[1], data: dataUrl[2] } },
    ];
  }

  // raw base64 image (no data: prefix)
  if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed) && trimmed.length > 200) {
    const compact = trimmed.replace(/\s+/g, "");
    const mime = imageMediaType(compact);
    if (mime) {
      return [
        imageTextPart(),
        { inlineData: { mimeType: mime, data: compact } },
      ];
    }
  }

  // URL
  if (/^https?:\/\/\S+$/i.test(trimmed)) {
    return [{ text: await fetchUrlText(trimmed) }];
  }

  // plain text
  return [{ text: `RENTAL LISTING:\n${trimmed}` }];
}

// ---------------------------------------------------------------------------
// Structured-output schemas (Gemini responseSchema format — guarantees JSON)
// ---------------------------------------------------------------------------
const SCOUT_SCHEMA = {
  type: "OBJECT",
  properties: {
    price: { type: "STRING", description: "Monthly rent as stated, or 'unknown'." },
    location: { type: "STRING" },
    beds: { type: "INTEGER", description: "Number of bedrooms; 0 for studio, -1 if unknown." },
    contact_method: { type: "STRING" },
    payment_ask: { type: "STRING", description: "How payment/deposit is requested (e.g. Zelle, wire, none stated)." },
    viewing_offered: { type: "BOOLEAN" },
    landlord_claims: { type: "STRING", description: "Notable claims the landlord makes about themselves/situation." },
    photos_note: { type: "STRING", description: "Anything notable about the photos (stocky, watermarked, mismatched, none)." },
  },
  required: ["price", "location", "beds", "contact_method", "payment_ask", "viewing_offered", "landlord_claims", "photos_note"],
};

const INSPECTOR_SCHEMA = {
  type: "OBJECT",
  properties: {
    risk: { type: "STRING", enum: ["safe", "caution", "scam"] },
    flags: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { flag: { type: "STRING" }, why: { type: "STRING" } },
        required: ["flag", "why"],
      },
    },
  },
  required: ["risk", "flags"],
};

const RIGHTS_SCHEMA = {
  type: "OBJECT",
  properties: {
    rights: { type: "STRING", description: "Plain-language summary of which fees are legal in this jurisdiction." },
    next_steps: { type: "ARRAY", items: { type: "STRING" } },
    draft_complaint: { type: "STRING", description: "A short, ready-to-send draft complaint to the state Attorney General." },
  },
  required: ["rights", "next_steps", "draft_complaint"],
};

// ---------------------------------------------------------------------------
// Agent runner
// ---------------------------------------------------------------------------
async function runAgent(system, content, schema, maxTokens = 2048) {
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: content, // string OR array of parts
    config: {
      systemInstruction: system,
      responseMimeType: "application/json",
      responseSchema: schema,
      maxOutputTokens: maxTokens,
      thinkingConfig: { thinkingBudget: 0 }, // disable thinking for a fast demo
    },
  });
  return JSON.parse(response.text ?? "{}");
}

const respondIn = (lang) =>
  `Always respond in the user's language: ${lang}. Every string value you output must be written in ${lang} (keep proper nouns and amounts as-is).`;

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------
async function analyze(input, lang) {
  // 1) SCOUT — normalize any input into a structured listing.
  const scoutContent = await buildScoutContent(input);
  const listing = await runAgent(
    `You are SCOUT, an extraction agent for rental listings. Pull the facts from the provided text, URL content, or screenshot into the schema. If a field is not present, say "unknown" (or beds = -1). Do not infer a scam verdict — only extract. ${respondIn(lang)}`,
    scoutContent,
    SCOUT_SCHEMA,
  );

  // Pick the relevant FMR baseline for the inspector.
  const bedKey = String(Math.max(0, Number(listing.beds ?? -1)));
  const baselineRent = HUD_FMR.monthly_fmr_usd[bedKey] ?? "unknown";

  // 2) INSPECTOR — flag scam patterns against the market baseline.
  const inspection = await runAgent(
    `You are INSPECTOR, a rental-fraud analyst. Given a structured listing and a HUD Fair Market Rent (FMR) baseline, identify scam patterns and assign an overall risk.
Look for: below-market bait pricing (well under FMR), off-platform / irreversible payment (Zelle, wire, gift cards, crypto), deposit or fees requested before any viewing, absentee or "I'm abroad / out of state" landlord, urgency/pressure tactics, refusal to show the unit, and signs of reused or stock photos.
Each flag = a short label plus a one-sentence "why". If no meaningful red flags, risk = "safe". ${respondIn(lang)}`,
    JSON.stringify({
      listing,
      hud_fmr_baseline: {
        zip: HUD_FMR.zip,
        area: HUD_FMR.area,
        year: HUD_FMR.year,
        monthly_fmr_for_this_bedroom_count_usd: baselineRent,
        full_table_usd: HUD_FMR.monthly_fmr_usd,
      },
    }),
    INSPECTOR_SCHEMA,
  );

  // 3) RIGHTS_RECOURSE — legal fees + what-to-do + draft AG complaint.
  const recourse = await runAgent(
    `You are RIGHTS_RECOURSE, a tenant-rights assistant for the jurisdiction of Massachusetts (default).
Explain which move-in fees are legal in Massachusetts (first month, last month, security deposit up to one month, and a bona-fide lock/key fee) and which are NOT (e.g. broker fees charged to the tenant in some cases, "application fees", holding deposits before a lease, amounts beyond the statutory limits).
Then give concise, practical next steps for someone who suspects this listing is a scam, and write a SHORT draft complaint to the Massachusetts Attorney General's Office (Consumer Protection Division) that the user can fill in and send. The tone should be clear and accessible for an immigrant who may be new to US renting. ${respondIn(lang)}`,
    JSON.stringify({ listing, risk: inspection.risk, flags: inspection.flags, jurisdiction: "Massachusetts" }),
    RIGHTS_SCHEMA,
    2048,
  );

  return {
    risk: inspection.risk,
    flags: inspection.flags,
    rights: recourse.rights,
    next_steps: recourse.next_steps,
    draft_complaint: recourse.draft_complaint,
    listing, // included for transparency/debug; ignore on the frontend if unused
  };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "15mb" })); // generous limit for base64 screenshots

// Open CORS so the Lovable frontend can call this from the browser.
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.post("/analyze-listing", async (req, res) => {
  try {
    const { input, lang } = req.body ?? {};
    if (!input || typeof input !== "string") {
      return res.status(400).json({ error: "Body must include a non-empty string `input`." });
    }
    const result = await analyze(input, typeof lang === "string" && lang ? lang : "English");
    res.json(result);
  } catch (e) {
    console.error("analyze-listing error:", e);
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.get("/", (_req, res) => res.send("Harbor backend OK. POST /analyze-listing { input, lang }"));

app.listen(PORT, () => console.log(`Harbor backend listening on http://localhost:${PORT}`));
