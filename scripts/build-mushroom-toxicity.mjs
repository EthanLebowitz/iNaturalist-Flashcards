// Queries Wikidata for all fungi taxa with an edibility classification (P789)
// and an iNaturalist taxon ID (P3151), then writes mushroom-edibility.json.
//
// Run: node scripts/build-mushroom-toxicity.mjs
// Requires Node 18+ (built-in fetch). Writes to data/mushroom-edibility.json.

import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT   = join(__dir, "..", "data", "mushroom-edibility.json");

// Map Wikidata QIDs → short label used in the UI
const EDIBILITY_MAP = {
  Q654236:   "edible",       // edible mushroom
  Q19888517: "choice",       // choice mushroom (best edibles)
  Q62102033: "edible cooked",// edible when cooked
  Q1686195:  "medicinal",    // medicinal mushrooms
  Q4317894:  "inedible",     // inedible mushroom
  Q19888537: "caution",      // caution mushroom
  Q19888579: "allergenic",   // allergenic mushroom
  Q1169875:  "psychoactive", // psychoactive mushroom
  Q359511:   "poisonous",    // poisonous mushroom
  Q19888591: "deadly",       // deadly mushroom
};

// Query A: P789 set directly on the taxon itself.
const SPARQL_DIRECT = `
SELECT ?taxon ?inatId ?edibilityVal WHERE {
  ?taxon wdt:P3151 ?inatId ;
         wdt:P789  ?edibilityVal .
}
`.trim();

// Query B: for taxa with no direct P789, inherit from the nearest ancestor.
// FILTER NOT EXISTS ensures we only include taxa that truly lack a direct value.
const SPARQL_INHERITED = `
SELECT ?taxon ?inatId ?edibilityVal WHERE {
  ?taxon wdt:P3151 ?inatId .
  FILTER NOT EXISTS { ?taxon wdt:P789 [] }
  ?taxon wdt:P171+ ?ancestor .
  ?ancestor wdt:P789 ?edibilityVal .
}
`.trim();

async function fetchWikidata(query) {
  const url = "https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(query);
  const res = await fetch(url, {
    headers: { "User-Agent": "track-cards-build-script/1.0 (https://track-cards.ethleb.com)" }
  });
  if (!res.ok) throw new Error(`Wikidata SPARQL request failed: ${res.status} ${res.statusText}`);
  return res.json();
}

function qidFromUri(uri) {
  // "http://www.wikidata.org/entity/Q654236" → "Q654236"
  return uri.split("/").pop();
}

const PRIORITY = ["deadly","poisonous","allergenic","caution","psychoactive",
                  "inedible","edible cooked","medicinal","edible","choice"];

function collectSets(bindings, sets = {}, qids = {}, skippedRef = { n: 0 }) {
  for (const row of bindings) {
    const inatId    = row.inatId.value;
    const qid       = qidFromUri(row.edibilityVal.value);
    const edibility = EDIBILITY_MAP[qid];
    if (!edibility) { skippedRef.n++; continue; }
    if (!sets[inatId]) sets[inatId] = new Set();
    sets[inatId].add(edibility);
    if (!qids[inatId]) qids[inatId] = qidFromUri(row.taxon.value);
  }
  return sets;
}

async function main() {
  const skipped = { n: 0 };
  const directQids = {}, inheritedQids = {};

  console.log("Querying Wikidata (direct P789)...");
  const directData = await fetchWikidata(SPARQL_DIRECT);
  console.log(`  Got ${directData.results.bindings.length} rows`);
  const directSets = collectSets(directData.results.bindings, {}, directQids, skipped);

  console.log("Querying Wikidata (inherited P789, taxa with no direct value)...");
  const inheritedData = await fetchWikidata(SPARQL_INHERITED);
  console.log(`  Got ${inheritedData.results.bindings.length} rows`);
  // Only populate inherited sets for taxa not already covered by a direct assignment.
  const inheritedSets = {};
  collectSets(inheritedData.results.bindings, inheritedSets, inheritedQids, skipped);

  // Merge: direct values take full precedence; inherited is fallback only.
  const merged = { ...inheritedSets, ...directSets };
  const mergedQids = { ...inheritedQids, ...directQids };

  const DANGER_SET = new Set(["deadly","poisonous","allergenic","caution","inedible"]);
  const EDIBLE_SET = new Set(["edible","choice","edible cooked"]);

  const out = {};
  for (const [inatId, set] of Object.entries(merged)) {
    const hasDanger = [...set].some(v => DANGER_SET.has(v));
    const hasEdible = [...set].some(v => EDIBLE_SET.has(v));
    if (hasDanger && hasEdible) continue; // contradictory — omit entirely
    out[inatId] = {
      labels: [...set].sort((a, b) => PRIORITY.indexOf(a) - PRIORITY.indexOf(b)),
      qid: mergedQids[inatId] || null,
    };
  }

  console.log(`  Mapped ${Object.keys(out).length} taxa (skipped ${skipped.n} unrecognised rows)`);

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`  Wrote ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
