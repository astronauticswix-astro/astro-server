/* =========================================================================
   Astronautics Procurement Intelligence — Server ("the assistant")
   Created for Lior Marcus. Runs identically on your computer OR in the cloud.

   WHAT IT DOES
   - Holds your Claude API key SAFELY on the server side (read from .env).
   - Exposes simple endpoints the web interface calls:
       GET  /api/health         -> "I'm alive" check (used by the source button)
       GET  /api/tenders        -> returns tenders (live search via Claude)
       GET  /api/ted?q=...      -> live EU TED tender search (free official API)
   - Serves the web interface (the HTML file) from the /public folder.

   You never put the key in the HTML or in the browser. Only this file reads it.
   ========================================================================= */

const express = require("express");
const path = require("path");
require("dotenv").config(); // loads variables from the .env file

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";
const SAM_API_KEY = process.env.SAM_API_KEY || "";
const TEAM_PASSWORD = process.env.TEAM_PASSWORD || "Astronautics2026"; // team gate for costly endpoints

// Allow the browser interface to call this server (CORS) — safe here because
// the key never leaves the server; the browser only receives finished results.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, x-team-pass");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json());
// Serve the web interface (index.html) and any assets from /public
app.use(express.static(path.join(__dirname, "public")));

/* ---------- Helper: robustly pull a JSON array out of model text ---------- */
function extractJsonArray(text) {
  const cleaned = String(text || "").replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("[");
  if (start === -1) throw new Error("No JSON array found in model output");
  let t = cleaned.slice(start);
  const lastBr = t.lastIndexOf("]");
  if (lastBr !== -1) {
    try { const a = JSON.parse(t.slice(0, lastBr + 1)); if (Array.isArray(a)) return a; } catch (e) {}
  }
  // salvage a truncated reply: trim to the last complete top-level object
  let depth = 0, inStr = false, esc = false, lastComplete = -1;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) { esc = false; } else if (c === "\\") { esc = true; } else if (c === '"') { inStr = false; } continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") { depth--; if (depth === 1 && c === "}") lastComplete = i; }
  }
  if (lastComplete === -1) throw new Error("Model reply truncated before any complete item");
  const arr = JSON.parse(t.slice(0, lastComplete + 1) + "]");
  if (!Array.isArray(arr)) throw new Error("Salvaged payload is not an array");
  return arr;
}

/* ---------- Helper: sanitize/normalize items to our schema ---------- */
const CATS = ["Avionics","Navigation","Mission Systems","Avionics Displays","Airborne","Land","Naval","Connectivity","Cyber & Data"];
const SOURCES = ["NATO","US DoD","EU","UK MOD","France","EDF","AU","CA","IN"];
function sanitize(items, origin) {
  return items
    .filter(it => it && typeof it.title === "string" && typeof it.url === "string")
    .map(it => ({
      id: String(it.id || ("SRV-" + Date.now() + "-" + Math.random().toString(36).slice(2,6))).slice(0,64),
      refNo: String(it.refNo || it.id || "—").slice(0,80),
      title: String(it.title).slice(0,200),
      source: SOURCES.includes(it.source) ? it.source : "EU",
      sourceLong: String(it.sourceLong || "Live search").slice(0,120),
      org: String(it.org || "—").slice(0,160),
      location: String(it.location || "—").slice(0,120),
      cats: Array.isArray(it.cats) ? it.cats.filter(c => CATS.includes(c)) : [],
      desc: String(it.desc || "").slice(0,600),
      value: (typeof it.value === "number" && it.value > 0) ? it.value : null,
      valueDisplay: String(it.valueDisplay || "TBD").slice(0,60),
      deadline: (typeof it.deadline === "string" && /^\d{4}-\d{2}-\d{2}$/.test(it.deadline)) ? it.deadline : null,
      posted: (typeof it.posted === "string" && /^\d{4}-\d{2}-\d{2}$/.test(it.posted)) ? it.posted : new Date().toISOString().slice(0,10),
      status: (it.status === "engage") ? "engage" : "live",
      elig: ["open","indigenous","oem","consortium","registration"].includes(it.elig) ? it.elig : null,
      match: Math.min(95, Math.max(40, parseInt(it.match) || 60)),
      keywords: Array.isArray(it.keywords) ? it.keywords.slice(0,10).map(String) : [],
      url: it.url,
      docs: Array.isArray(it.docs) ? it.docs.slice(0,5).filter(d => d && d.n).map(d => ({ n: String(d.n).slice(0,120) })) : [],
      notes: String(it.notes || "Retrieved live — verify at source portal.").slice(0,400),
      origin: origin || "live"
    }));
}

/* ---------- Team password gate (protects credit-consuming endpoints) ---------- */
function teamGate(req, res, next) {
  const pass = req.headers["x-team-pass"] || req.query.pass || "";
  if (pass !== TEAM_PASSWORD) {
    return res.status(401).json({ error: "TEAM_PASSWORD_REQUIRED", detail: "Enter the team password in the \ud83d\udce1 panel of the interface." });
  }
  next();
}
app.use(["/api/tenders", "/api/official", "/api/ted"], teamGate);

/* ---------- Health check: the source button pings this ---------- */
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    keyConfigured: ANTHROPIC_API_KEY.length > 0,
    model: ANTHROPIC_MODEL,
    time: new Date().toISOString()
  });
});

/* ---------- Live tenders via Claude web search ---------- */
/* ---------- Data-quality verification engine ---------- */
const VERIFY_LOG = {}; // id -> { status, checkedAt, note, correctedDeadline, correctedStatus }

async function aiVerifyTender(t) {
  if (!ANTHROPIC_API_KEY) throw new Error("No API key configured");
  const prompt = `Fact-check ONE government/defence tender record against real, current web sources. Record: title="${t.title}", claimed deadline="${t.deadline || "none"}", claimed status="${t.status}", source URL="${t.url}", org="${t.org || ""}".
Search the web to confirm: (1) does this programme/tender genuinely exist, (2) is the claimed deadline accurate, (3) is it still open or has it closed/been awarded.
Return ONLY a JSON object (no markdown, no prose): {"verdict":"confirmed|corrected|not_found","realDeadline":"YYYY-MM-DD or null","realStatus":"live|engage|closed","note":"max 2 sentences citing what you found"}`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search" }] })
  });
  if (!r.ok) throw new Error("Claude API error " + r.status);
  const data = await r.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
  const cleaned = text.replace(/```json|```/g, "").trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("No JSON object in verification reply");
  const v = JSON.parse(m[0]);
  return {
    status: v.verdict === "confirmed" ? "confirmed" : (v.verdict === "corrected" ? "corrected" : "not_found"),
    checkedAt: new Date().toISOString(),
    note: String(v.note || "").slice(0, 300),
    correctedDeadline: v.realDeadline || null,
    correctedStatus: v.realStatus || null
  };
}

app.post("/api/verify-tender", teamGate, express.json(), async (req, res) => {
  const t = req.body || {};
  if (!t.id || !t.title || !t.url) return res.status(400).json({ error: "id, title and url are required" });
  try {
    const result = await aiVerifyTender(t);
    VERIFY_LOG[t.id] = result;
    res.json({ ok: true, id: t.id, ...result });
  } catch (err) {
    res.status(500).json({ error: "Verification failed", detail: String(err.message || err) });
  }
});

app.get("/api/verify-status", (req, res) => { res.json({ ok: true, log: VERIFY_LOG }); });

/* ---------- Cache + daily auto-refresh ---------- */
const CACHE = { tenders: null, at: 0, params: "" };
const DAY_MS = 24 * 60 * 60 * 1000;

async function runLiveFetch(cats, srcs, geo) {
  const scope = cats
    ? cats
    : "avionics, cockpit/multifunction displays (AMLCD/MFD/head assembly), navigation (INS/EGI/anti-jam GPS/TACAN), mission computers, EFB, secure aircraft connectivity gateways, airborne network servers, avionics cybersecurity (ED-203A)";
  const srcLine = srcs ? ` Prioritize these portals/regions: ${srcs}.` : "";

  const prompt = `Search the web for CURRENTLY OPEN, non-Israeli defence procurement tenders/RFPs/RFIs matching: ${scope}.${srcLine} Also match component nomenclature: AMLCD, display unit, head assembly, EFI, standby display, INS/EGI/IMU, ring laser gyro (RLG/MRLG), fiber optic gyro (FOG), accelerometers, GPS/INS with SAASM/M-Code, marine/submarine inertial navigation (AUV/ROV), land navigation & artillery fire-control, flight-control actuators, line-of-sight stabilization, position sensors, mission computer LRU, data concentrator; and non-English notices (German/French/Polish/Dutch/Spanish: licitación, aviónica, navegación inercial/Portuguese: licitação, pregão, edital, aviônica), translating titles to English. GEOGRAPHY RULES (mandatory): never include tenders from China, Russia, North Korea, or Israel. Exclude all Arab countries EXCEPT the United Arab Emirates and Saudi Arabia (permitted, no special emphasis). African countries are LOW priority.${geo ? " FOCUS regions: " + geo + "." : ""} ALSO SEARCH publicly posted supplier/subcontract opportunities, RFQs and industry days from major defence primes (Boeing, Airbus, Lockheed Martin, RTX/Collins, Northrop, BAE, Thales, Leonardo, Rheinmetall, Saab, GD, L3Harris, Embraer, Hanwha/KAI, MHI) — mark these status engage and note the prime. EXCLUDE Israeli sites/tenders. Only tenders published mid-2025 or later. Return ONLY a JSON array (no markdown, no prose) of up to 8 items, schema per item: {"id":"","refNo":"","title":"","source":"NATO|US DoD|EU|UK MOD|France|EDF|AU|CA|IN","sourceLong":"","org":"","location":"","cats":["subset of ${CATS.join(",")}"],"desc":"2-3 sentences","value":null,"valueDisplay":"","deadline":"YYYY-MM-DD or null","posted":"YYYY-MM-DD","status":"live|engage","elig":"open|indigenous|oem|consortium|registration","match":60-95,"keywords":[],"url":"","docs":[{"n":"filename"}],"notes":""}`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,          // <-- the key stays here, on the server
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 8000,
        messages: [{ role: "user", content: prompt }],
        tools: [{ type: "web_search_20250305", name: "web_search" }]
      })
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error("Claude API error " + r.status + ": " + body.slice(0, 200));
    }
    const data = await r.json();
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    const items = sanitize(extractJsonArray(text), "live");
    // Also pull from official portal APIs (UK FTS always; SAM.gov when key configured)
    let officialItems = [], officialErrors = [];
    try {
      const kw = cats ? cats.split(",").map(x=>x.trim()).filter(Boolean) : null;
      const o = await fetchOfficialAPIs(kw);
      officialItems = sanitize(o.items, "live");
      officialErrors = o.errors;
    } catch (e) { officialErrors = [String(e.message || e)]; }
    // merge + dedupe by title
    const seenT = new Set(items.map(t => t.title.toLowerCase().replace(/[^a-z0-9]/g,"")));
    const merged = items.concat(officialItems.filter(t => !seenT.has(t.title.toLowerCase().replace(/[^a-z0-9]/g,""))));
    return { ok: true, count: merged.length, tenders: merged, sources: { claude: items.length, officialApis: merged.length - items.length }, officialErrors, fetchedAt: new Date().toISOString() };
}

app.get("/api/tenders", async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "No API key configured on the server. Add ANTHROPIC_API_KEY to your .env file." });
  }
  const cats = (req.query.cats || "").toString();
  const srcs = (req.query.sources || "").toString();
  const geo = (req.query.geo || "").toString();
  const force = req.query.force === "1";
  const pkey = cats + "|" + srcs + "|" + geo;
  const fresh = CACHE.tenders && (Date.now() - CACHE.at < DAY_MS) && CACHE.params === pkey;
  if (fresh && !force) {
    return res.json({ ...CACHE.tenders, cached: true, cacheAgeMinutes: Math.round((Date.now() - CACHE.at) / 60000), verifyLog: VERIFY_LOG });
  }
  try {
    const out = await runLiveFetch(cats, srcs, geo);
    CACHE.tenders = out; CACHE.at = Date.now(); CACHE.params = pkey;
    res.json({ ...out, cached: false, verifyLog: VERIFY_LOG });
  } catch (err) {
    // serve stale cache on failure rather than erroring out
    if (CACHE.tenders) return res.json({ ...CACHE.tenders, cached: true, stale: true, fetchError: String(err.message || err) });
    res.status(500).json({ error: "Server failed to fetch tenders", detail: String(err.message || err) });
  }
});

/* Daily self-refresh: keeps the cache warm so every file open shows fresh data */
function scheduledRefresh() {
  if (!ANTHROPIC_API_KEY) return;
  runLiveFetch("", "", "").then(async out => {
    CACHE.tenders = out; CACHE.at = Date.now(); CACHE.params = "||";
    console.log("[cron] daily refresh done — " + out.count + " tenders @ " + new Date().toISOString());
    // Auto-verification sweep: pick the 3 stalest-unverified tenders and fact-check them
    try {
      const candidates = (out.tenders || [])
        .filter(t => !VERIFY_LOG[t.id])
        .sort((a, b) => new Date(a.posted || 0) - new Date(b.posted || 0))
        .slice(0, 3);
      for (const t of candidates) {
        try {
          const result = await aiVerifyTender(t);
          VERIFY_LOG[t.id] = result;
          console.log("[cron] verified " + t.id + " -> " + result.status);
        } catch (e) { console.warn("[cron] verify failed for " + t.id + ": " + (e.message || e)); }
      }
    } catch (e) { console.warn("[cron] verification sweep failed: " + (e.message || e)); }
  }).catch(e => console.warn("[cron] daily refresh failed: " + (e.message || e)));
}
setTimeout(scheduledRefresh, 30 * 1000);           // warm-up shortly after boot
setInterval(scheduledRefresh, DAY_MS);              // then once a day

/* =========================================================================
   OFFICIAL PORTAL APIs — direct "service doors" that bypass web indexing.
   These turn PARTIAL-indexed portals into properly covered sources.
   Each fetcher is best-effort: a failure in one source never blocks others.
   ========================================================================= */

const DEFAULT_KEYWORDS = ["avionics","multifunction display","inertial navigation","mission computer","TACAN","electronic flight bag"];

/* UK Find a Tender — public OCDS API, no key required */
async function fetchUKFTS(keyword) {
  const url = "https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages?limit=10&stages=tender&keywords=" + encodeURIComponent(keyword);
  const r = await fetch(url, { headers: { "accept": "application/json" } });
  if (!r.ok) throw new Error("UK FTS " + r.status);
  const data = await r.json();
  const out = [];
  for (const pkg of (data.results || data.releasePackages || [])) {
    const rel = (pkg.releases && pkg.releases[0]) || pkg;
    const t = rel.tender || {};
    if (!t.title) continue;
    out.push({
      id: "UKFTS-" + String(rel.ocid || t.id || Math.random().toString(36).slice(2)).slice(-24),
      refNo: String(rel.ocid || t.id || "—"),
      title: t.title,
      source: "UK MOD",
      sourceLong: "UK Find a Tender (official API)",
      org: (rel.buyer && rel.buyer.name) || "—",
      location: "United Kingdom",
      cats: [],
      desc: String(t.description || "").slice(0, 500),
      value: (t.value && typeof t.value.amount === "number") ? t.value.amount : null,
      valueDisplay: (t.value && t.value.amount) ? ("≈ " + (t.value.currency || "GBP") + " " + t.value.amount.toLocaleString()) : "TBD",
      deadline: (t.tenderPeriod && t.tenderPeriod.endDate) ? String(t.tenderPeriod.endDate).slice(0,10) : null,
      posted: rel.date ? String(rel.date).slice(0,10) : null,
      status: "live",
      match: 65,
      keywords: [keyword],
      url: "https://www.find-tender.service.gov.uk/Search/Results?Keywords=" + encodeURIComponent(keyword),
      docs: [],
      notes: "Fetched via the official UK FTS OCDS API — verify details on the notice page."
    });
  }
  return out;
}

/* SAM.gov Opportunities — official API, requires a FREE key (SAM_API_KEY in .env) */
async function fetchSAMgov(keyword) {
  if (!SAM_API_KEY) return []; // silently skip when no key configured
  const today = new Date(); const from = new Date(today); from.setMonth(from.getMonth() - 2);
  const fmt = d => String(d.getMonth()+1).padStart(2,"0") + "/" + String(d.getDate()).padStart(2,"0") + "/" + d.getFullYear();
  const url = "https://api.sam.gov/opportunities/v2/search?api_key=" + encodeURIComponent(SAM_API_KEY)
    + "&keywords=" + encodeURIComponent(keyword)
    + "&postedFrom=" + fmt(from) + "&postedTo=" + fmt(today)
    + "&ptype=o,p,r&limit=10";
  const r = await fetch(url);
  if (!r.ok) throw new Error("SAM.gov " + r.status);
  const data = await r.json();
  const out = [];
  for (const o of (data.opportunitiesData || [])) {
    if (!o.title) continue;
    out.push({
      id: "SAM-" + String(o.noticeId || Math.random().toString(36).slice(2)).slice(-24),
      refNo: String(o.solicitationNumber || o.noticeId || "—"),
      title: o.title,
      source: "US DoD",
      sourceLong: "SAM.gov (official API)",
      org: String(o.fullParentPathName || o.departmentName || "—").split(".").slice(-1)[0],
      location: "United States",
      cats: [],
      desc: String(o.description || o.title).slice(0, 500),
      value: null,
      valueDisplay: "See notice",
      deadline: o.responseDeadLine ? String(o.responseDeadLine).slice(0,10) : null,
      posted: o.postedDate ? String(o.postedDate).slice(0,10) : null,
      status: "live",
      match: 65,
      keywords: [keyword],
      url: o.uiLink || ("https://sam.gov/opp/" + o.noticeId + "/view"),
      docs: [],
      notes: "Fetched via the official SAM.gov Opportunities API — verify details on the notice page."
    });
  }
  return out;
}

/* Merge official-API results for a set of keywords; failures never block */
async function fetchOfficialAPIs(keywords) {
  const kws = (keywords && keywords.length ? keywords : DEFAULT_KEYWORDS).slice(0, 4);
  const jobs = [];
  for (const k of kws) { jobs.push(fetchUKFTS(k)); jobs.push(fetchSAMgov(k)); }
  const settled = await Promise.allSettled(jobs);
  const items = [], errors = [];
  for (const sres of settled) {
    if (sres.status === "fulfilled") items.push(...sres.value);
    else errors.push(String(sres.reason && sres.reason.message || sres.reason));
  }
  // dedupe by normalized title
  const seen = new Set(); const dedup = [];
  for (const it of items) {
    const key = it.title.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (seen.has(key)) continue; seen.add(key); dedup.push(it);
  }
  return { items: dedup, errors };
}

/* ---------- Official-APIs endpoint (no Claude, no Anthropic key needed) ---------- */
app.get("/api/official", async (req, res) => {
  const kws = (req.query.q || "").toString().split(",").map(x => x.trim()).filter(Boolean);
  try {
    const { items, errors } = await fetchOfficialAPIs(kws);
    res.json({ ok: true, count: items.length, tenders: sanitize(items, "live"), samKeyConfigured: !!SAM_API_KEY, errors });
  } catch (err) {
    res.status(500).json({ error: "Official API fetch failed", detail: String(err.message || err) });
  }
});

/* ---------- Bonus: live EU TED search (free official API, no key needed) ----------
   This shows how to add a real portal directly. Returns raw-ish notices.        */
app.get("/api/ted", async (req, res) => {
  const q = (req.query.q || "avionics").toString();
  try {
    const r = await fetch("https://api.ted.europa.eu/v3/notices/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: q, fields: ["ND","TI","PD","DD"], limit: 10, scope: "ACTIVE" })
    });
    if (!r.ok) return res.status(502).json({ error: "TED API error " + r.status });
    const data = await r.json();
    res.json({ ok: true, source: "TED", results: data });
  } catch (err) {
    res.status(500).json({ error: "TED fetch failed", detail: String(err.message || err) });
  }
});

/* ---------- Fallback: send the interface for any other path ---------- */
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log("=".repeat(58));
  console.log("  Astronautics Procurement server is RUNNING");
  console.log("  Open your browser at:  http://localhost:" + PORT);
  console.log("  API key loaded:        " + (ANTHROPIC_API_KEY ? "YES ✅" : "NO ❌  (add it to .env)"));
  console.log("=".repeat(58));
});
