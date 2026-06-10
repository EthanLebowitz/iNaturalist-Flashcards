// Scrapes iNaturalist /observations/species_counts for each deck and writes
// data/species-counts/<deck>.json.  Run with:  node scripts/scrape-species-counts.mjs
// Re-run whenever the deck composition changes significantly.

import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'data', 'species-counts');
mkdirSync(OUT_DIR, { recursive: true });

// Mirror of window.MODES deck queries
const DECKS = {
  tracking:    { project_id: 962 },
  birds:       { taxon_id: 3 },
  feathers:    { project_id: 11413 },
  skulls:      { project_id: 488 },
  mushrooms:   { taxon_id: '50814,152032' },
  butterflies: { taxon_id: 47157 },
  dragonflies: { taxon_id: 47792 },
  spiders:     { taxon_id: 47118 },
  bees:        { taxon_id: 630955 },
  snakes:      { taxon_id: 85553 },
  herps:       { taxon_id: '26036,20978' },
  plants:      { project_id: 35019 },
};

const INAT_BASE = 'https://api.inaturalist.org/v1/observations/species_counts';
const DELAY_MS = 1200; // stay under iNat's rate limit

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchPage(query, page) {
  const params = new URLSearchParams({
    quality_grade: 'research',
    per_page: 500,
    page,
    ...query,
  });
  const url = `${INAT_BASE}?${params}`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'trackingCards-scraper/1.0' } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.json();
}

async function scrapeDecks(keys) {
  const targets = keys.length ? keys : Object.keys(DECKS);
  for (const deck of targets) {
    const query = DECKS[deck];
    if (!query) { console.warn(`Unknown deck: ${deck}`); continue; }
    console.log(`\nScraping ${deck}…`);

    const species = [];
    let page = 1;
    let totalResults = Infinity;

    while (species.length < totalResults) {
      const data = await fetchPage(query, page);
      if (page === 1) { totalResults = data.total_results; console.log(`  total species: ${totalResults}`); }
      if (!data.results || data.results.length === 0) break;
      for (const r of data.results) {
        species.push({
          taxonId:    r.taxon.id,
          name:       r.taxon.preferred_common_name || r.taxon.name,
          rank:       r.taxon.rank,
          count:      r.count,
          ancestorIds: r.taxon.ancestor_ids || [],
        });
      }
      console.log(`  page ${page}: ${data.results.length} species (total so far: ${species.length})`);
      if (data.results.length < 500) break;
      page++;
      await sleep(DELAY_MS);
    }

    const maxCount = Math.max(...species.map(s => s.count), 1);
    const logMax = Math.log(maxCount + 1);
    for (const s of species) {
      s.w = Math.log(s.count + 1) / logMax; // log-normalised commonality in [0,1]
    }
    // Sort descending by count for readability
    species.sort((a, b) => b.count - a.count);

    const out = { deck, generatedAt: new Date().toISOString().slice(0, 10), maxCount, species };
    const path = join(OUT_DIR, `${deck}.json`);
    writeFileSync(path, JSON.stringify(out, null, 2));
    console.log(`  → wrote ${species.length} species to ${path}`);
    await sleep(DELAY_MS);
  }
}

const args = process.argv.slice(2);
scrapeDecks(args).catch(e => { console.error(e); process.exit(1); });
