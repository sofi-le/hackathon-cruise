// Harbor frontend — talks to the same-origin backend (/cultural-fit).
const $ = (id) => document.getElementById(id);
const cares = new Set();

// chip toggles
document.querySelectorAll("#cares .chip").forEach((b) =>
  b.addEventListener("click", () => {
    b.classList.toggle("on");
    cares.has(b.dataset.v) ? cares.delete(b.dataset.v) : cares.add(b.dataset.v);
  })
);

$("demo").addEventListener("click", () => {
  $("origin").value = "Hong Kong (Cantonese)";
  $("languages").value = "Cantonese, English";
  $("cook").value = "Cantonese groceries, fresh seafood, dim sum";
  $("faith").value = "none";
  $("social").value = "mahjong, tai chi";
  $("location").value = "Quincy, MA 02169";
  ["food", "community", "language"].forEach((v) => {
    const c = document.querySelector(`#cares .chip[data-v="${v}"]`);
    if (c && !c.classList.contains("on")) c.click();
  });
});

$("go").addEventListener("click", run);

async function run() {
  const location = $("location").value.trim();
  if (!location) return showErr("Please enter a neighborhood, address, or ZIP.");
  showErr("");

  const body = {
    location,
    origin: $("origin").value.trim(),
    languages: $("languages").value.split(",").map((s) => s.trim()).filter(Boolean),
    lang: $("lang").value.trim() || "English",
    survey: {
      cook_at_home: $("cook").value.trim(),
      faith: $("faith").value.trim(),
      social: $("social").value.split(",").map((s) => s.trim()).filter(Boolean),
      cares_most_about: [...cares],
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

  if (d.safety?.summary) html += `<div class="section-title">Safety</div><p class="why">${esc(d.safety.summary)}</p>`;

  if (d.gaps?.length) {
    html += `<div class="section-title">Gaps</div><ul class="list">` +
      d.gaps.map((g) => `<li>${esc(g)}</li>`).join("") + `</ul>`;
  }

  if (d.sources?.length) {
    html += `<div class="section-title">Sources</div><div class="sources">` +
      d.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a>`).join("") + `</div>`;
  }

  const r = $("result");
  r.innerHTML = html;
  r.hidden = false;
}
