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
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// Retry transient overloads (500/503) with backoff. 429 = quota: fail fast & clear.
async function generate(req, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await ai.models.generateContent(req);
    } catch (e) {
      const code = Number(e?.status ?? e?.code);
      if (code === 429)
        throw new Error("Gemini quota exceeded (free-tier limit for this Google account). Wait for the daily reset, switch to a key from a different account, or enable billing.");
      if (![500, 503].includes(code) || i === tries - 1) throw e;
      last = e;
      await new Promise((r) => setTimeout(r, 900 * (i + 1)));
    }
  }
  throw last;
}

// Structured JSON output (no tools). Fast — thinking disabled.
async function runJSON(system, content, schema, maxTokens = 4096) {
  const response = await generate({
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
  let text = (response.text ?? "{}").trim();
  if (text.startsWith("```")) text = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(text);
  } catch (e) {
    const finish = response.candidates?.[0]?.finishReason;
    throw new Error(`Model returned ${finish === "MAX_TOKENS" ? "truncated output (hit token limit)" : "invalid JSON"}: ${e.message}`);
  }
}

// Google Search grounded output (free text + citations). Used for fact-checking.
async function runGrounded(system, prompt, maxTokens = 2048) {
  const response = await generate({
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
    verdict: {
      type: "OBJECT",
      description: "ONE unified takeaway that ties cultural belonging AND the listing's scam risk together.",
      properties: {
        headline: { type: "STRING", description: "One punchy sentence combining belonging + safety." },
        recommendation: { type: "STRING", description: "What the renter should actually do next, referencing both the fit and the scam result." },
      },
      required: ["headline", "recommendation"],
    },
  },
  required: ["cultural_fit", "dimensions", "safety", "gaps", "verdict"],
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

// 3) FILTER — score the location against the profile AND fuse in the scam result.
async function filterFit(location, profile, discovered, sources, scam, lang) {
  return runJSON(
    `You are FILTER, a cultural-fit scoring agent. Given the user's profile, a location, grounded research about real nearby places, and (optionally) the SCAM analysis of a specific listing the renter is considering, produce the combined assessment.
Score each dimension (food, community, faith, social, language, safety) 0-100 by how well this location serves THIS person's needs, weighted by their priorities. Compute an overall cultural_fit.score as a priority-weighted blend. Put the relevant real places under each dimension. For each place's "source", only use a URL from the provided sources list — never invent one; leave it empty if none applies. List honest gaps. Do not invent places not present in the research.
Then write ONE unified "verdict" that fuses belonging and safety: if the listing's scam risk is "caution" or "scam", warn clearly and steer the renter to the REAL, safe places found here instead of paying that listing; if there is no listing or it looks safe, affirm the fit and give a concrete next step. The verdict must reference BOTH the cultural fit and the scam result when a listing is present.
Keep it compact: AT MOST 4 places per dimension, each "note" one short sentence, "why" one sentence, summary at most 2 sentences. ${respondIn(lang)}`,
    JSON.stringify({
      location,
      profile,
      research: discovered,
      allowed_sources: sources.map((s) => s.url),
      listing_scam_analysis: scam ? { risk: scam.risk, flags: scam.flags } : null,
    }),
    FIT_SCHEMA,
    8192,
  );
}

async function culturalFit({ location, origin, languages, survey, lang, listing }) {
  const hasListing = typeof listing === "string" && listing.trim();
  const profile = await buildProfile({ origin, languages, survey }, lang);

  // SCOUT the listing first so the scam check AND the cultural search can share
  // the same place (the listing's own address when no area was picked).
  let listingFacts = null;
  if (hasListing) listingFacts = await scoutListing(await buildScoutContent(listing), lang);

  const effectiveLocation =
    (location && location.trim()) ||
    (listingFacts && listingFacts.location && listingFacts.location !== "unknown" ? listingFacts.location : "");

  // Location-aware, profile-aware scam check.
  let scam = null;
  if (hasListing) {
    scam = await inspectListing(listingFacts, effectiveLocation || "the listing's stated area", profile, lang);
  }

  // No place to research -> return the scam result on its own (still integrated path).
  if (!effectiveLocation) {
    if (scam && scam.risk !== "safe") scam = { ...scam, ...(await rightsRecourse(listingFacts, scam, lang)) };
    return { scam, profile, effective_location: null };
  }

  // Grounded research + cultural scoring, with the scam result fused into the verdict.
  const { text: research, sources } = await discoverPlaces(effectiveLocation, profile, lang);
  const fit = await filterFit(effectiveLocation, profile, research, sources, scam, lang);

  // Add rights + draft complaint only when the listing is actually risky.
  if (scam && scam.risk !== "safe") scam = { ...scam, ...(await rightsRecourse(listingFacts, scam, lang)) };

  return { ...fit, sources, profile, effective_location: effectiveLocation, ...(scam ? { scam } : {}) };
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

const inspectListing = (listing, location, profile, lang) => {
  const bedKey = String(Math.max(0, Number(listing.beds ?? -1)));
  const baselineRent = HUD_FMR.monthly_fmr_usd[bedKey] ?? "unknown";
  return runJSON(
    `You are INSPECTOR, a rental-fraud analyst protecting newcomers and immigrants, who are disproportionately targeted by rental scams. You are given a structured listing, the AREA the renter is actually searching in, and the renter's cultural profile.
Judge the price against the TYPICAL market rent for that specific area (use your knowledge of the location; the HUD figure below is only a Boston example anchor, not the rule). Flag: below-market bait pricing for that area, off-platform/irreversible payment (Zelle, wire, gift cards, crypto), deposit before viewing, absentee/abroad landlord, urgency/pressure, refusal to show the unit, reused/stock photos, and tactics that specifically prey on someone new to the US or not fluent in English. Each flag = label + one-sentence why. No meaningful red flags -> risk "safe". ${respondIn(lang)}`,
    JSON.stringify({
      listing,
      search_area: location,
      renter_profile: { heritage: profile?.heritage, languages: profile?.languages },
      hud_example_anchor: { zip: HUD_FMR.zip, monthly_fmr_for_this_bedroom_usd: baselineRent },
    }),
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
  const inspection = await inspectListing(listing, listing.location, null, lang);
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

// Serve the demo frontend (server/public/index.html at "/").
app.use(express.static(path.join(__dirname, "public")));

// MAIN — cultural-fit filter
app.post("/cultural-fit", async (req, res) => {
  try {
    const { location, origin, languages, survey, lang, listing } = req.body ?? {};
    const hasLoc = typeof location === "string" && location.trim();
    const hasListing = typeof listing === "string" && listing.trim();
    if (!hasLoc && !hasListing) {
      return res.status(400).json({ error: "Provide a `location` (area/ZIP) and/or a `listing` to check." });
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

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Harbor backend listening on http://localhost:${PORT}`));
