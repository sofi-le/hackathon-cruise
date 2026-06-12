// Harbor frontend — scam check + dropdown cultural filters -> /cultural-fit.
const $ = (id) => document.getElementById(id);

function chipSet(groupId) {
  const set = new Set();
  document.querySelectorAll(`#${groupId} .chip`).forEach((b) =>
    b.addEventListener("click", () => {
      b.classList.toggle("on");
      set.has(b.dataset.v) ? set.delete(b.dataset.v) : set.add(b.dataset.v);
    })
  );
  return set;
}
const cares = chipSet("cares");
const amenities = chipSet("amenities");
const access = chipSet("access");

$("location").addEventListener("change", () => ($("otherLocWrap").hidden = $("location").value !== "__other"));
$("culture").addEventListener("change", () => ($("otherCulWrap").hidden = $("culture").value !== "__other"));

$("demo").addEventListener("click", () => {
  $("listing").value =
    "Beautiful sunny 2BR in Quincy — only $1,200/month, utilities included! I was relocated abroad for work so I can't show it in person, but it's move-in ready. To reserve, send first month + $1,200 deposit by Zelle or Western Union and I'll FedEx you the keys. Please hurry, many people are interested!";
  $("why").value = "Job";
  $("aptType").value = "2 bedrooms";
  $("location").value = "Quincy, MA";
  $("culture").value = "Chinese — Cantonese / Hong Kong";
  ["food", "community", "language"].forEach((v) => toggle("cares", v));
  ["In-unit laundry", "Parking"].forEach((v) => toggle("amenities", v));
});
function toggle(group, v) {
  const c = document.querySelector(`#${group} .chip[data-v="${v}"]`);
  if (c && !c.classList.contains("on")) c.click();
}

window.copyDraft = () => {
  const el = $("draft");
  if (el) navigator.clipboard?.writeText(el.textContent);
};

$("go").addEventListener("click", run);

function pickLocation() {
  const v = $("location").value;
  if (v === "__other") return $("otherLoc").value.trim();
  if (v === "__from_listing") return ""; // let the backend pull it from the listing
  return v;
}

// Reflect the location the backend actually used back into the selector.
function setLocationSelector(loc) {
  if (!loc) return;
  const sel = $("location");
  let opt = [...sel.options].find((o) => o.value === loc || o.text === loc);
  if (!opt) { opt = new Option(loc, loc); sel.add(opt); }
  sel.value = opt.value;
  $("otherLocWrap").hidden = true;
}
const pickCulture = () => ($("culture").value === "__other" ? $("otherCul").value.trim() : $("culture").value);

async function run() {
  const location = pickLocation();
  const listing = $("listing").value.trim();
  if (!location && !listing) return showErr("Paste a listing, pick an area — or both (they work together).");
  showErr("");

  // One integrated call: scam check + cultural fit share a location and fuse into a verdict.
  const body = {
    location, // may be "" — backend derives it from the listing
    origin: pickCulture(),
    lang: cleanLang(),
    survey: {
      why_moving: $("why").value,
      move_timing: $("timing").value,
      apartment_type: $("aptType").value,
      cares_most_about: [...cares],
      amenities: [...amenities],
      accessibility: [...access],
    },
    ...(listing ? { listing } : {}),
  };

  setLoading(true);
  try {
    const res = await fetch("/cultural-fit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    render(data);
  } catch (e) {
    showErr(e.message);
    setLoading(false);
  }
}

const cleanLang = () => ($("lang").value || "English").replace(/\s*\(.+\)/, "");

function setLoading(on) {
  $("empty").hidden = true;
  $("loading").hidden = !on;
  if (on) $("result").hidden = true;
  $("go").disabled = on;
}
function showErr(msg) {
  const el = $("err");
  el.hidden = !msg;
  el.textContent = msg || "";
}

const EMOJI = { food: "🍜", community: "🤝", faith: "🛐", social: "☕", language: "💬", safety: "🛡️" };
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function scamBlock(s) {
  const r = s.risk || "safe";
  const verdict = { safe: "✅ Listing is legit", caution: "⚠️ Be careful", scam: "🚨 Likely a SCAM" }[r] || r;
  let h = `<div class="scam-big ${r}"><div class="verdict">${verdict}</div>`;
  if (s.flags?.length)
    h += `<ul class="list big">` + s.flags.map((f) => `<li><b>${esc(f.flag)}:</b> ${esc(f.why)}</li>`).join("") + `</ul>`;
  if (s.rights) h += `<div class="section-title">⚖️ Your rights</div><p class="why">${esc(s.rights)}</p>`;
  if (s.next_steps?.length)
    h += `<div class="section-title">✅ What to do</div><ul class="list">` + s.next_steps.map((x) => `<li>${esc(x)}</li>`).join("") + `</ul>`;
  if (s.draft_complaint)
    h += `<details class="draft"><summary>📝 Draft complaint to the Attorney General</summary>
            <pre id="draft">${esc(s.draft_complaint)}</pre>
            <button class="ghost" onclick="copyDraft()">📋 Copy complaint</button></details>`;
  h += `</div>`;
  return h;
}

function render(d) {
  setLoading(false);
  let html = "";

  // Show (and reflect into the dropdown) the single location both checks used.
  if (d.effective_location) {
    const sel = $("location");
    const wasDerived = $("listing").value.trim() && (sel.value === "__from_listing" || sel.value === "");
    setLocationSelector(d.effective_location);
    html += `<div class="loc-pill">📍 Location used: <b>${esc(d.effective_location)}</b>${wasDerived ? " · detected from the listing" : ""}</div>`;
  }

  // Unified verdict — the integrated takeaway (belonging + safety together).
  if (d.verdict) {
    const cls = d.scam?.risk === "scam" ? "scam" : d.scam?.risk === "caution" ? "caution" : "safe";
    html += `<div class="verdict-banner ${cls}">
      <div class="vh">🧭 ${esc(d.verdict.headline)}</div>
      <p>${esc(d.verdict.recommendation)}</p></div>`;
  }

  // Scam details.
  if (d.scam) html += scamBlock(d.scam);

  // Cultural fit (if present).
  if (d.cultural_fit) {
    const fit = d.cultural_fit;
    html += `
      <div class="score-head">
        <div class="score-ring" style="--p:${fit.score}"><span>${fit.score}</span></div>
        <div><h2>Cultural fit</h2><p class="muted">${esc(fit.summary)}</p></div>
      </div>`;
    for (const dim of d.dimensions || []) {
      html += `
        <div class="dim">
          <div class="dim-top"><h3>${EMOJI[dim.key] || ""} ${esc(dim.label)}</h3><b>${dim.score}</b></div>
          <div class="bar"><i style="width:${dim.score}%"></i></div>
          <p class="why">${esc(dim.why)}</p>
          ${(dim.places || []).map((p) => `
            <div class="place"><b>${esc(p.name)}</b> <span class="meta">· ${esc(p.type)}${p.distance ? " · " + esc(p.distance) : ""}</span>
            <div>${esc(p.note)} ${p.source ? `<a href="${esc(p.source)}" target="_blank" rel="noopener">↗</a>` : ""}</div></div>`).join("")}
        </div>`;
    }
    if (d.safety?.summary) html += `<div class="section-title">🛡️ Safety</div><p class="why">${esc(d.safety.summary)}</p>`;
    if (d.gaps?.length) html += `<div class="section-title">🔎 Gaps</div><ul class="list">` + d.gaps.map((g) => `<li>${esc(g)}</li>`).join("") + `</ul>`;
    if (d.sources?.length) html += `<div class="section-title">📎 Sources</div><div class="sources">` + d.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a>`).join("") + `</div>`;
  }

  const r = $("result");
  r.innerHTML = html;
  r.hidden = false;
}
