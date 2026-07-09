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

// Allow the browser interface to call this server (CORS) — safe here because
// the key never leaves the server; the browser only receives finished results.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
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
  const m = cleaned.match(/\[[\s\S]*\]/);
  if (!m) throw new Error("No JSON array found in model output");
  const arr = JSON.parse(m[0]);
  if (!Array.isArray(arr)) throw new Error("Parsed payload is not an array");
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
app.get("/api/tenders", async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "No API key configured on the server. Add ANTHROPIC_API_KEY to your .env file." });
  }
  // Optional filters passed from the interface
  const cats = (req.query.cats || "").toString();
  const srcs = (req.query.sources || "").toString();

  const scope = cats
    ? cats
    : "avionics, cockpit/multifunction displays (AMLCD/MFD/head assembly), navigation (INS/EGI/anti-jam GPS/TACAN), mission computers, EFB, secure aircraft connectivity gateways, airborne network servers, avionics cybersecurity (ED-203A)";
  const srcLine = srcs ? ` Prioritize these portals/regions: ${srcs}.` : "";

  const prompt = `Search the web for CURRENTLY OPEN, non-Israeli defence procurement tenders/RFPs/RFIs matching: ${scope}.${srcLine} Also match component nomenclature (AMLCD, display unit, head assembly, mission computer LRU, data concentrator) and non-English notices (German/French/Polish), translating titles to English. EXCLUDE Israeli sites/tenders. Only tenders published mid-2025 or later. Return ONLY a JSON array (no markdown, no prose) of up to 8 items, schema per item: {"id":"","refNo":"","title":"","source":"NATO|US DoD|EU|UK MOD|France|EDF|AU|CA|IN","sourceLong":"","org":"","location":"","cats":["subset of ${CATS.join(",")}"],"desc":"2-3 sentences","value":null,"valueDisplay":"","deadline":"YYYY-MM-DD or null","posted":"YYYY-MM-DD","status":"live|engage","elig":"open|indigenous|oem|consortium|registration","match":60-95,"keywords":[],"url":"","docs":[{"n":"filename"}],"notes":""}`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,          // <-- the key stays here, on the server
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
        tools: [{ type: "web_search_20250305", name: "web_search" }]
      })
    });
    if (!r.ok) {
      const body = await r.text();
      return res.status(502).json({ error: "Claude API error " + r.status, detail: body.slice(0,300) });
    }
    const data = await r.json();
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    const items = sanitize(extractJsonArray(text), "live");
    res.json({ ok: true, count: items.length, tenders: items, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: "Server failed to fetch tenders", detail: String(err.message || err) });
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
