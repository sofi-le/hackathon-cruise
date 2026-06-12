// Harbor — "find where you belong, not just where you live."
// A cultural-fit filter for newcomers/diaspora, on the Google Gemini API.
//
// MAIN feature  — POST /cultural-fit
//   Body: { location, origin?, languages?, survey?, lang?, listing? }
//   Scores a place against your cultural background (food, community, faith,
//   social/third-places, language access, safety), with REAL named places and
//   citations via Google Search grounding. If `listing` is provided, also runs a
//   light scam/fact-check sub-step.
//
// SUB feature   — POST /analyze-listing  (kept from before)
//   Body: { input, lang } -> full 3-step rental-scam analysis.
//
// No database. Run with: npm start

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
// Hardcoded HUD Fair Market Rent baseline for one Boston ZIP (used by scam check)
// ---------------------------------------------------------------------------
const HUD_FMR = {
  zip: "02118",
  area: "Boston-Cambridge-Quincy, MA-NH HUD Metro FMR Area",
  year: 2024,
  monthly_fmr_usd: { "0": 2096, "1": 2364, "2": 2826, "3": 3543, "4": 3879 },
};

// ===========================================================================
// Gemini helpers
// ===========================================================================

// Structured JSON output (no tools). Fast — thinking disabled.
async function runJSON(system, content, schema, maxTokens = 2048) {
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: content, // string OR array of parts
    config: {
      systemInstruction: system,
      responseMimeType: "application/json",
      responseSchema: schema,
      maxOutputTokens: maxTokens,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  return JSON.parse(response.text ?? "{}");
}

// Google Search grounded output (free text + citations). Used for fact-checking.
async function runGrounded(system, prompt, maxTokens = 2048) {
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      systemInstruction: system,
      tools: [{ googleSearch: {} }],
      maxOutputTokens: maxTokens,
    },
  });
  const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const sources = [
    ...new Map(
      chunks
        .map((c) => c.web)
        .filter((w) => w?.uri)
        .map((w) => [w.uri, { title: w.title ?? w.uri, url: w.uri }]),
    ).values(),
  ];
  return { text: response.text ?? "", sources };
}

const respondIn = (lang) =>
  `Always respond in the user's language: ${lang}. Every human-readable string you output must be written in ${lang} (keep proper nouns, place names, and amounts as-is).`;

// ===========================================================================
// MAIN: Cultural-fit filter
// ===========================================================================

const PROFILE_SCHEMA = {
  type: "OBJECT",
  properties: {
    heritage: { type: "STRING", description: "Cultural background, e.g. 'Cantonese / Hong Kong'." },
    languages: { type: "ARRAY", items: { type: "STRING" } },
    food_needs: { type: "ARRAY", items: { type: "STRING" }, description: "Cuisines, ingredients, or grocery types that matter." },
    faith: { type: "STRING", description: "Religion / community institution, or 'none'." },
    social_interests: { type: "ARRAY", items: { type: "STRING" }, description: "e.g. mahjong, language meetups, cultural clubs, sports." },
    priorities: {
      type: "ARRAY",
      description: "Which dimensions matter most, with a weight 1-5.",
      items: {
        type: "OBJECT",
        properties: {
          dimension: { type: "STRING", enum: ["food", "community", "faith", "social", "language", "safety"] },
          weight: { type: "INTEGER" },
        },
        required: ["dimension", "weight"],
      },
    },
    summary: { type: "STRING" },
  },
  required: ["heritage", "languages", "food_needs", "faith", "social_interests", "priorities", "summary"],
};

const FIT_SCHEMA = {
  type: "OBJECT",
  properties: {
    cultural_fit: {
      type: "OBJECT",
      properties: { score: { type: "INTEGER", description: "0-100 overall cultural fit." }, summary: { type: "STRING" } },
      required: ["score", "summary"],
    },
    dimensions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          key: { type: "STRING", enum: ["food", "community", "faith", "social", "language", "safety"] },
          label: { type: "STRING" },
          score: { type: "INTEGER", description: "0-100 for this dimension." },
          why: { type: "STRING" },
          places: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                name: { type: "STRING" },
                type: { type: "STRING", description: "e.g. grocery, community center, temple, cafe, language school." },
                distance: { type: "STRING", description: "Approx distance or neighborhood, or 'unknown'." },
                note: { type: "STRING" },
                source: { type: "STRING", description: "A citation URL from the provided sources, or empty." },
              },
              required: ["name", "type", "note"],
            },
          },
        },
        required: ["key", "label", "score", "why", "places"],
      },
    },
    safety: {
      type: "OBJECT",
      properties: { summary: { type: "STRING" } },
      required: ["summary"],
    },
    gaps: { type: "ARRAY", items: { type: "STRING" }, description: "Honest cultural gaps, e.g. 'No nearby Vietnamese grocery within 2mi'." },
  },
  required: ["cultural_fit", "dimensions", "safety", "gaps"],
};

// 1) PROFILE — turn "where you're from" + survey into a structured profile.
async function buildProfile({ origin, languages, survey }, lang) {
  return runJSON(
    `You are PROFILE, an onboarding agent for a cultural-belonging app. Turn the user's background and survey answers into a structured cultural profile: what food, community, faith, social life, and language access matter to them, and how much (priorities/weights 1-5). Infer sensible defaults from their heritage when answers are sparse. ${respondIn(lang)}`,
    JSON.stringify({ origin: origin ?? "unknown", languages: languages ?? [], survey: survey ?? {} }),
    PROFILE_SCHEMA,
    1024,
  );
}

// 2) DISCOVER — grounded search for REAL nearby places + neighborhood facts.
async function discoverPlaces(location, profile, lang) {
  return runGrounded(
    `You are DISCOVER, a local-research agent. Using web search, find REAL, currently-existing places near the given location that match this person's cultural profile. Only report places you can actually find — never invent names. For each, give the name, type, approximate distance/neighborhood, and one specific detail (e.g. "hosts weekly mahjong", "carries Filipino groceries"). Cover: cultural/ethnic grocery stores & markets, community centers & cultural orgs, places of worship for their faith, cafes/venues that host cultural or community events, and language services. Then summarize the neighborhood's diaspora presence and its public-safety/crime context using factual sources. Be honest about gaps. ${respondIn(lang)}`,
    `LOCATION: ${location}\n\nCULTURAL PROFILE:\n${JSON.stringify(profile, null, 2)}`,
    2048,
  );
}

// 3) FILTER — score the location against the profile into the final result.
async function filterFit(location, profile, discovered, sources, lang) {
  return runJSON(
    `You are FILTER, a cultural-fit scoring agent. Given the user's profile, a location, and grounded research about real nearby places, produce a cultural-fit assessment.
Score each dimension (food, community, faith, social, language, safety) 0-100 by how well this location serves THIS person's needs, weighted by their priorities. Compute an overall cultural_fit.score as a priority-weighted blend. Put the relevant real places under each dimension. For each place's "source", only use a URL from the provided sources list — never invent one; leave it empty if none applies. List honest gaps. Do not invent places not present in the research. ${respondIn(lang)}`,
    JSON.stringify({ location, profile, research: discovered, allowed_sources: sources.map((s) => s.url) }),
    FIT_SCHEMA,
    3072,
  );
}

async function culturalFit({ location, origin, languages, survey, lang, listing }) {
  const profile = await buildProfile({ origin, languages, survey }, lang);
  const { text: research, sources } = await discoverPlaces(location, profile, lang);
  const fit = await filterFit(location, profile, research, sources, lang);

  const out = { ...fit, sources, profile };

  // Sub-check: if a listing was provided, run a light scam/fact-check.
  if (listing && typeof listing === "string") {
    const scoutContent = await buildScoutContent(listing);
    const scouted = await scoutListing(scoutContent, lang);
    out.scam = await inspectListing(scouted, lang);
  }

  return out;
}

// ===========================================================================
// SUB: Rental-scam pipeline (kept) + shared input handling
// ===========================================================================

const IMG_MAGIC = { "/9j/": "image/jpeg", "iVBORw0KGgo": "image/png", "R0lGOD": "image/gif", "UklGR": "image/webp" };
function imageMediaType(b64) {
  for (const [magic, mime] of Object.entries(IMG_MAGIC)) if (b64.startsWith(magic)) return mime;
  return null;
}
async function fetchUrlText(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (HarborBot)" }, signal: AbortSignal.timeout(8000) });
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
const imageTextPart = () => ({ text: "This is a screenshot of a rental listing. Read it carefully and extract the listing details." });

async function buildScoutContent(input) {
  const trimmed = input.trim();
  const dataUrl = trimmed.match(/^data:(image\/[a-zA-Z.+-]+);base64,(.+)$/s);
  if (dataUrl) return [imageTextPart(), { inlineData: { mimeType: dataUrl[1], data: dataUrl[2] } }];
  if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed) && trimmed.length > 200) {
    const compact = trimmed.replace(/\s+/g, "");
    const mime = imageMediaType(compact);
    if (mime) return [imageTextPart(), { inlineData: { mimeType: mime, data: compact } }];
  }
  if (/^https?:\/\/\S+$/i.test(trimmed)) return [{ text: await fetchUrlText(trimmed) }];
  return [{ text: `RENTAL LISTING:\n${trimmed}` }];
}

const SCOUT_SCHEMA = {
  type: "OBJECT",
  properties: {
    price: { type: "STRING" }, location: { type: "STRING" }, beds: { type: "INTEGER" },
    contact_method: { type: "STRING" }, payment_ask: { type: "STRING" }, viewing_offered: { type: "BOOLEAN" },
    landlord_claims: { type: "STRING" }, photos_note: { type: "STRING" },
  },
  required: ["price", "location", "beds", "contact_method", "payment_ask", "viewing_offered", "landlord_claims", "photos_note"],
};
const INSPECTOR_SCHEMA = {
  type: "OBJECT",
  properties: {
    risk: { type: "STRING", enum: ["safe", "caution", "scam"] },
    flags: { type: "ARRAY", items: { type: "OBJECT", properties: { flag: { type: "STRING" }, why: { type: "STRING" } }, required: ["flag", "why"] } },
  },
  required: ["risk", "flags"],
};
const RIGHTS_SCHEMA = {
  type: "OBJECT",
  properties: {
    rights: { type: "STRING" }, next_steps: { type: "ARRAY", items: { type: "STRING" } }, draft_complaint: { type: "STRING" },
  },
  required: ["rights", "next_steps", "draft_complaint"],
};

const scoutListing = (content, lang) =>
  runJSON(
    `You are SCOUT, an extraction agent for rental listings. Pull the facts from the provided text, URL content, or screenshot into the schema. If a field is not present, say "unknown" (beds = -1). Do not infer a scam verdict. ${respondIn(lang)}`,
    content, SCOUT_SCHEMA, 1024,
  );

const inspectListing = (listing, lang) => {
  const bedKey = String(Math.max(0, Number(listing.beds ?? -1)));
  const baselineRent = HUD_FMR.monthly_fmr_usd[bedKey] ?? "unknown";
  return runJSON(
    `You are INSPECTOR, a rental-fraud analyst. Given a structured listing and a HUD Fair Market Rent (FMR) baseline, flag scam patterns and assign risk.
Look for: below-market bait pricing, off-platform/irreversible payment (Zelle, wire, gift cards, crypto), deposit before viewing, absentee/abroad landlord, urgency, refusal to show, reused/stock photos. Each flag = label + one-sentence why. No red flags -> risk "safe". ${respondIn(lang)}`,
    JSON.stringify({ listing, hud_fmr_baseline: { zip: HUD_FMR.zip, area: HUD_FMR.area, year: HUD_FMR.year, monthly_fmr_for_this_bedroom_count_usd: baselineRent, full_table_usd: HUD_FMR.monthly_fmr_usd } }),
    INSPECTOR_SCHEMA, 1024,
  );
};

const rightsRecourse = (listing, inspection, lang) =>
  runJSON(
    `You are RIGHTS_RECOURSE, a tenant-rights assistant for Massachusetts (default).
Explain which move-in fees are legal in Massachusetts (first month, last month, security deposit up to one month, bona-fide lock/key fee) and which are NOT (e.g. holding deposits before a lease, amounts beyond statutory limits). Give concise next steps for someone who suspects a scam, and write a SHORT draft complaint to the Massachusetts Attorney General (Consumer Protection Division). Clear, accessible tone for an immigrant new to US renting. ${respondIn(lang)}`,
    JSON.stringify({ listing, risk: inspection.risk, flags: inspection.flags, jurisdiction: "Massachusetts" }),
    RIGHTS_SCHEMA, 2048,
  );

async function analyzeListing(input, lang) {
  const content = await buildScoutContent(input);
  const listing = await scoutListing(content, lang);
  const inspection = await inspectListing(listing, lang);
  const recourse = await rightsRecourse(listing, inspection, lang);
  return { risk: inspection.risk, flags: inspection.flags, rights: recourse.rights, next_steps: recourse.next_steps, draft_complaint: recourse.draft_complaint, listing };
}

// ===========================================================================
// HTTP server
// ===========================================================================
const app = express();
app.use(express.json({ limit: "15mb" }));
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// MAIN — cultural-fit filter
app.post("/cultural-fit", async (req, res) => {
  try {
    const { location, origin, languages, survey, lang, listing } = req.body ?? {};
    if (!location || typeof location !== "string") {
      return res.status(400).json({ error: "Body must include a non-empty string `location` (address, neighborhood, or ZIP)." });
    }
    const result = await culturalFit({
      location,
      origin,
      languages,
      survey,
      listing,
      lang: typeof lang === "string" && lang ? lang : "English",
    });
    res.json(result);
  } catch (e) {
    console.error("cultural-fit error:", e);
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// SUB — full rental-scam analysis
app.post("/analyze-listing", async (req, res) => {
  try {
    const { input, lang } = req.body ?? {};
    if (!input || typeof input !== "string") {
      return res.status(400).json({ error: "Body must include a non-empty string `input`." });
    }
    const result = await analyzeListing(input, typeof lang === "string" && lang ? lang : "English");
    res.json(result);
  } catch (e) {
    console.error("analyze-listing error:", e);
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.get("/", (_req, res) =>
  res.send("Harbor backend OK. POST /cultural-fit { location, origin, survey, lang } | POST /analyze-listing { input, lang }"));

app.listen(PORT, () => console.log(`Harbor backend listening on http://localhost:${PORT}`));
