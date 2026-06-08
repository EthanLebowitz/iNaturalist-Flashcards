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
  Q62102033: "edible_cooked",// edible when cooked
  Q1686195:  "medicinal",    // medicinal mushrooms
  Q4317894:  "inedible",     // inedible mushroom
  Q19888537: "caution",      // caution mushroom
  Q19888579: "allergenic",   // allergenic mushroom
  Q1169875:  "psychoactive", // psychoactive mushroom
  Q359511:   "poisonous",    // poisonous mushroom
  Q19888591: "deadly",       // deadly mushroom
};

// For each iNat-mapped taxon, find the nearest P789 value on itself or any
// Wikidata ancestor (via P171+). The OPTIONAL + ORDER BY rank ensures we get
// the most specific (deepest) edibility assignment first.
const SPARQL = `
SELECT ?inatId ?edibilityVal WHERE {
  ?taxon wdt:P3151 ?inatId .
  ?taxon wdt:P171* ?ancestor .
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

async function main() {
  console.log("Querying Wikidata...");
  const data = await fetchWikidata(SPARQL);
  const bindings = data.results.bindings;
  console.log(`  Got ${bindings.length} rows`);

  const out = {};
  let skipped = 0;

  for (const row of bindings) {
    const inatId     = row.inatId.value;           // already a plain string
    const qid        = qidFromUri(row.edibilityVal.value);
    const edibility  = EDIBILITY_MAP[qid];

    if (!edibility) {
      // Unlabeled blank-node or unknown QID — skip
      skipped++;
      continue;
    }

    // A taxon can have multiple edibility values in Wikidata (rare but possible).
    // Keep the most severe / most informative one via priority order.
    const PRIORITY = ["deadly","poisonous","allergenic","caution","psychoactive",
                      "inedible","edible_cooked","medicinal","edible","choice"];
    if (!out[inatId] || PRIORITY.indexOf(edibility) < PRIORITY.indexOf(out[inatId])) {
      out[inatId] = edibility;
    }
  }

  console.log(`  Mapped ${Object.keys(out).length} taxa (skipped ${skipped} unrecognised rows)`);

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`  Wrote ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
