// Generates per-deck landing pages and sitemap.xml from template.html.
// Run: node scripts/build-pages.mjs
// Re-run whenever a deck is added or template.html changes.

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, '..');

// Load deck definitions from the single source of truth: decks.js
const decksJs = readFileSync(join(root, 'decks.js'), 'utf-8');
const ctx = { window: {}, location: { pathname: '/', search: '' }, URLSearchParams, document: { title: '' } };
vm.createContext(ctx);
vm.runInContext(decksJs, ctx);
const MODES = ctx.window.MODES;

const DECKS = Object.entries(MODES)
  .filter(([, deck]) => deck.slug)
  .map(([key, deck]) => ({ key, ...deck }));

// Extract body HTML from template.html
const templateHtml = readFileSync(join(root, 'template.html'), 'utf-8');
const bodyMatch = templateHtml.match(/<body>([\s\S]*)<\/body>/);
if (!bodyMatch) { console.error('Could not extract <body> from template.html'); process.exit(1); }
const bodyHtml = bodyMatch[1];

// Single description template — only seo.label and seo.labelSingular differ per deck.
function deckDescription(seo) {
  return `These are ${seo.labelSingular} flashcards generated from research grade iNaturalist observations for practicing identification of ${seo.label}. For most decks there are hundreds of thousands or millions such observations, so it's like an infinite ${seo.labelSingular} quiz!`;
}

function deckIntroHtml(deck) {
  const seo = deck.seo;
  return `\t  <div id="deck-intro-about">
\t    <h2>${seo.h1}</h2>
\t    <p>${deckDescription(seo)}</p>
\t    <p>An observation being classified as "research grade" means that it has been agreed on by a critical mass of identifiers on iNaturalist. This helps ensure some quality, but since all IDs are done by the community there may be some mistakes.</p>
\t    <p>If you like this site, check out my other projects or get in touch at <a href="https://ethleb.com?utm_source=drugstats&utm_medium=referral&utm_campaign=footer_link" target="_blank" className="text-[#89b4fa]">ethleb.com</a>. Also, this site is open source, and you can <a href="https://github.com/EthanLebowitz/iNaturalist-Flashcards" target="_blank" rel="noopener">view the code or contribute on github</a>!</p>
\t    <p>I hope you enjoy!</p>
\t    <p>Ethan Lebowitz</p>
\t  </div>`;
}

function deckLinksHtml() {
  return DECKS.map(d => `\t      <li><a href="${d.slug}">${d.label}</a></li>`).join('\n');
}

const GA_SNIPPET = `<!-- Google Analytics (GA4) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-1PLNMCYXMQ"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-1PLNMCYXMQ');
</script>`;

function shellHead(deck) {
  const url = `https://flashcards.ethleb.com${deck.slug}`;
  const seo = deck.seo;
  const description = deckDescription(seo);
  return `<!-- Made by Ethan Lebowitz-->
${GA_SNIPPET}

<title>${seo.title}</title>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${description}">
<meta name="author" content="Ethan Lebowitz">
<meta name="robots" content="index, follow">
<link rel="canonical" href="${url}">
<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">

<!-- Open Graph / social sharing -->
<meta property="og:type" content="website">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${seo.h1}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="https://flashcards.ethleb.com/assets/og-image.png">

<!-- Twitter Card -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${seo.h1}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="https://flashcards.ethleb.com/assets/og-image.png">

<!-- Structured data -->
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "LearningResource",
  "name": "${seo.h1}",
  "description": "${description}",
  "url": "${url}",
  "author": { "@type": "Person", "name": "Ethan Lebowitz" },
  "learningResourceType": "Quiz",
  "educationalLevel": "beginner"
}
</script>

<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/app.css">
<script
			  src="https://code.jquery.com/jquery-3.5.1.js"
			  integrity="sha256-QWo7LDvxbWT2tbbQ97B53yJnYU3WhH/C8ycbRAkjPDc="
			  crossorigin="anonymous">
</script>
<script>window.__DECK__ = '${deck.key}';</script>
<script src="/decks.js"></script>
<script type="module" src="/firebase.js"></script>`;
}

const links = deckLinksHtml();

DECKS.forEach(function(deck) {
  const slugDir = deck.slug.replace(/^\//, '').replace(/\/$/, '');
  const dir = join(root, slugDir);
  mkdirSync(dir, { recursive: true });

  const body = bodyHtml
    .replace(/<!-- DECK_H1_START -->[\s\S]*?<!-- DECK_H1_END -->/, deck.seo.h1)
    .replace(/[ \t]*<!-- DECK_INTRO_START -->[\s\S]*?<!-- DECK_INTRO_END -->/, deckIntroHtml(deck))
    .replace(/[ \t]*<!-- DECK_LINKS_START -->[\s\S]*?<!-- DECK_LINKS_END -->/, links);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
${shellHead(deck)}
</head>
<body>
${body}</body>
</html>`;

  writeFileSync(join(dir, 'index.html'), html, 'utf-8');
  console.log('Written /' + slugDir + '/index.html');
});

// sitemap.xml
const today = new Date().toISOString().split('T')[0];
const baseUrl = 'https://flashcards.ethleb.com';
const urls = DECKS
  .map(d => `  <url><loc>${baseUrl}${d.slug}</loc><lastmod>${today}</lastmod></url>`)
  .join('\n');

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

writeFileSync(join(root, 'sitemap.xml'), sitemap, 'utf-8');
console.log('Written sitemap.xml');
