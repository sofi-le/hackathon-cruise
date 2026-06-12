// Harbor frontend — dropdown filters -> same-origin /cultural-fit.
const $ = (id) => document.getElementById(id);

// multi-select chip groups
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

// "Other…" reveal for location + culture
$("location").addEventListener("change", () => ($("otherLocWrap").hidden = $("location").value !== "__other"));
$("culture").addEventListener("change", () => ($("otherCulWrap").hidden = $("culture").value !== "__other"));

$("demo").addEventListener("click", () => {
  $("why").value = "Job";
  $("timing").value = "Within 1 month";
  $("aptType").value = "1 bedroom";
  $("location").value = "Quincy, MA";
  $("culture").value = "Chinese — Cantonese / Hong Kong";
  ["food", "community", "language"].forEach((v) => toggle("cares", v));
  ["In-unit laundry", "Parking"].forEach((v) => toggle("amenities", v));
  toggle("access", "Elevator");
});
function toggle(group, v) {
  const c = document.querySelector(`#${group} .chip[data-v="${v}"]`);
  if (c && !c.classList.contains("on")) c.click();
}

$("go").addEventListener("click", run);

function pickLocation() {
  const v = $("location").value;
  return v === "__other" ? $("otherLoc").value.trim() : v;
}
function pickCulture() {
  const v = $("culture").value;
  return v === "__other" ? $("otherCul").value.trim() : v;
}

async function run() {
  const location = pickLocation();
  if (!location) return showErr("Please pick an area (or choose Other and type one).");
  showErr("");

  const body = {
    location,
    origin: pickCulture(),
    lang: ($("lang").value || "English").replace(/\s*\(.+\)/, ""), // strip the "(Chinese)" hint
    survey: {
      why_moving: $("why").value,
      move_timing: $("timing").value,
      apartment_type: $("aptType").value,
      cares_most_about: [...cares],
      amenities: [...amenities],
      accessibility: [...access],
    },
  };
  const listing = $("listing").value.trim();
  if (listing) body.listing = listing;

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

function render(d) {
  setLoading(false);
  const fit = d.cultural_fit || { score: 0, summary: "" };
  let html = `
    <div class="score-head">
      <div class="score-ring" style="--p:${fit.score}"><span>${fit.score}</span></div>
      <div><h2>Cultural fit</h2><p class="muted">${esc(fit.summary)}</p></div>
    </div>`;

  if (d.scam) {
    const r = d.scam.risk || "safe";
    const label = { safe: "✅ Listing looks OK", caution: "⚠️ Listing — be careful", scam: "🚨 Likely scam listing" }[r] || r;
    html += `<div class="banner ${r}"><b>${label}</b>` +
      (d.scam.flags?.length ? "<ul class='list'>" + d.scam.flags.map((f) => `<li><b>${esc(f.flag)}:</b> ${esc(f.why)}</li>`).join("") + "</ul>" : "") +
      `</div>`;
  }

  for (const dim of d.dimensions || []) {
    html += `
      <div class="dim">
        <div class="dim-top"><h3>${EMOJI[dim.key] || ""} ${esc(dim.label)}</h3><b>${dim.score}</b></div>
        <div class="bar"><i style="width:${dim.score}%"></i></div>
        <p class="why">${esc(dim.why)}</p>
        ${(dim.places || []).map((p) => `
          <div class="place">
            <b>${esc(p.name)}</b> <span class="meta">· ${esc(p.type)}${p.distance ? " · " + esc(p.distance) : ""}</span>
            <div>${esc(p.note)} ${p.source ? `<a href="${esc(p.source)}" target="_blank" rel="noopener">↗</a>` : ""}</div>
          </div>`).join("")}
      </div>`;
  }

  if (d.safety?.summary) html += `<div class="section-title">🛡️ Safety</div><p class="why">${esc(d.safety.summary)}</p>`;
  if (d.gaps?.length) html += `<div class="section-title">🔎 Gaps</div><ul class="list">` + d.gaps.map((g) => `<li>${esc(g)}</li>`).join("") + `</ul>`;
  if (d.sources?.length) html += `<div class="section-title">📎 Sources</div><div class="sources">` + d.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a>`).join("") + `</div>`;

  const r = $("result");
  r.innerHTML = html;
  r.hidden = false;
}
