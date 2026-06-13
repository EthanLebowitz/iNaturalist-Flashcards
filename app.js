(function() {
	var params = new URLSearchParams(location.search);
	var tracking = ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid','fbclid','msclkid'];
	tracking.forEach(function(p){ params.delete(p); });
	var clean = location.pathname + (params.toString() ? '?' + params.toString() : '') + location.hash;
	history.replaceState(null, '', clean);
})();

var iteration = 0;      // fetch cursor: position in entryIndexes of the last card fetched from iNat
var sessionHistory = []; // ordered list of entry objects shown this session
var historyIndex = -1;  // pointer into sessionHistory; -1 means nothing shown yet
var page = 1;
var data; //container for json
var totalEntries=0;
var linkIndex=0;
var internalTotalEntries;
var anchored = (location.hash != "");
var IDsAt10kMarkers = []; //entry ID for the 10,000th entry, the 20,000th entry, etc.

window.reportResults = {};    // cardId → 'correct'|'incorrect', session-scoped for grid rendering
window.speciesStatsCache = new Map(); // taxonId (string) → { recent: ['c'|'i', ...] }
var selfReportShownForCurrentCard = false;
var HIDE_ANSWER_HIDES_SELF_REPORT = true; // set false to keep self-report visible when answer is hidden

// ---- seen-card tracking (localStorage; isolated per deck) ----
function seenKey(){ return "seenCards:" + (window.currentDeckKey || 'tracking'); }
function loadSeenForDeck(){
	try { return new Set(JSON.parse(localStorage.getItem(seenKey()) || "[]")); }
	catch(e){ return new Set(); }
}
var seenCards = loadSeenForDeck();
function isSeen(id){ return seenCards.has(Number(id)); }
function markSeen(id){
	if(id == null) return;
	seenCards.add(Number(id));
	try { localStorage.setItem(seenKey(), JSON.stringify([...seenCards])); } catch(e){}
}

// ---- location filter persistence ----
function loadLocationFilter(){ try { return JSON.parse(localStorage.getItem('locationFilter')||'null'); } catch(e){ return null; } }
function saveLocationFilter(obj){ try { if(obj) localStorage.setItem('locationFilter', JSON.stringify(obj)); else localStorage.removeItem('locationFilter'); } catch(e){} }

$('#answer').hide(); //hide the answer

function showAnswer(){
	var isVisible = document.getElementById("answer").offsetWidth > 0 || document.getElementById("answer").offsetHeight > 0;
	if(isVisible){
		$("#answer").slideUp(200);
		document.getElementById("showAnswer").innerHTML = "Show Answer";
		hideEdibilityBadge();
		if(HIDE_ANSWER_HIDES_SELF_REPORT){
			document.getElementById('selfReport').classList.remove('is-visible');
			selfReportShownForCurrentCard = false;
		}
	}
	else{
		$("#answer").slideDown(200);
		document.getElementById("showAnswer").innerHTML = "Hide Answer";
		if (window.track) window.track('answer_revealed', { deck: window.currentDeckKey });
		showEdibilityBadge();
		if(!selfReportShownForCurrentCard){
			selfReportShownForCurrentCard = true;
			requestAnimationFrame(function() {
				document.getElementById('selfReport').classList.add('is-visible');
			});
		}
	}
}

function deckQueryString(){
	var q = window.MODES[window.currentDeckKey].query || {};
	return Object.keys(q).map(function(k){ return "&" + k + "=" + q[k]; }).join("");
}
let INAT_BASE = "https://api.inaturalist.org/v1/observations?identified=true&photos=true&quality_grade=research&order=desc&order_by=created_at" + deckQueryString();
window.speciesCommonality = new Map(); // taxonId (number) → { taxonId, name, count, w (linear 0–1), ancestorIds }
async function loadSpeciesCommonality(deckKey) {
	window.speciesCommonality = new Map();
	try {
		var resp = await fetch('/data/species-counts/' + deckKey + '.json');
		if (!resp.ok) return;
		var json = await resp.json();
		var arr = json.species || [];
		arr.forEach(function(s) { window.speciesCommonality.set(s.taxonId, s); });
	} catch(e) {}
}
loadSpeciesCommonality(window.currentDeckKey);
function buildObsUrl(opts) {
	var url = INAT_BASE + "&page=" + opts.page + "&per_page=" + (opts.perPage || 1);
	if(opts.marker) url += "&id_below=" + opts.marker;
	if(opts.filter) url += opts.filter;
	return url;
}
var entryIndexes = [];  //where secondary iteration and associated url indexes are stored; each slot is [urlIndex, offset]
var filterURLs = [];  //where species filtered urls are stored

function generateURLs(){ //generate filter urls — cross-product of species × regions
	filterURLs = [];
	var df = window.MODES[window.currentDeckKey].filters || {};
	var speciesParams = (df.species && taxonIdChoices.length > 0) ? taxonIdChoices : [""];
	var regionParams  = (df.region  && regionIdChoices.length  > 0) ? regionIdChoices  : [""];
	speciesParams.forEach(function(sp){
		regionParams.forEach(function(rp){
			if(sp === "" && rp === "") return;
			filterURLs.push("https://api.inaturalist.org/v1/observations?identified=true&photos=true&quality_grade=research&page=${page}&per_page=${perpage}&order=desc&order_by=created_at" + deckQueryString() + sp + rp);
		});
	});
}

function initializePostIndexGen(){ //sets up first card fetch after index generation
	iteration = -1; // fetchAndPushCard increments to 0 on first call, so entryIndexes[0] is used correctly
	sessionHistory = [];
	historyIndex = -1;
	data = null; //clear stale fetch data so fetchAndPushCard always does a fresh request on reinit
	window.reportResults = {};
	prefetchedNext = null;
	document.getElementById("totalObs").innerHTML = totalEntries+" Cards Generated";
	document.getElementById("entryTotal").innerHTML = totalEntries+" Cards Generated";
	renderSessionGrid();
	// A shared/anchored card (#<obsId> in the URL) takes precedence over a random draw.
	// Driving it from here (the last init step) avoids a race where a deferred filter/location
	// restore would otherwise wipe session history and fetch a random card over the anchor.
	if(anchored){ anchorCheck(); } else { fetchAndPushCard(); }
}

// The iNat API won't return results past page 10,000. To reach entries beyond that,
// we fetch the ID of the 10,000th entry, then use id_below to start a fresh 10k window.
async function getIDsAt10kMarkers(){
	var numberOf10ks = Math.floor(totalEntries / 10000);
	data = await getData(buildObsUrl({ page: 1, perPage: 1 }));
	var lastMarker = data.results[0].id;
	for(var i = 0; i < numberOf10ks; i++){
		data = await getData(buildObsUrl({ page: 10000, perPage: 1, marker: lastMarker }));
		lastMarker = data.results[0].id;
		IDsAt10kMarkers.push(lastMarker);
	}
}

async function generateEntryIndexesList(){ //generates list of deck slots using the filterURLs list
	entryIndexes=[]; //resets
	totalEntries=0;
	if(filterURLs.length!=0){ //if there are filters
		document.getElementById("entryTotal").innerHTML = "processing..."; //indicates that it's processing
		for(var a=0; a<filterURLs.length; a++){
			var URL = filterURLs[a].replace("${page}", page).replace("${perpage}", 1);
			var filterResult = await getData(URL).then(function(rData) {
				return { total: rData.total_results, capped: Math.min(rData.total_results, 10000) };
			}).catch(function() { return { total: 0, capped: 0 }; });
			totalEntries += filterResult.total;
			for(var i=0; i<filterResult.capped; i++){ //build deck: [urlIndex, offset] per card
				entryIndexes.push([a, i]);
			}
			if(a === filterURLs.length - 1){ // must run after all filter URLs are processed; async response timing makes this unreliable if placed outside the loop
				shuffle(entryIndexes);
				initializePostIndexGen();
			}
		}
	}
	else{ //if there are no filters
		var noFilterResult = await getData(buildObsUrl({ page: 1, perPage: 1 }))
			.then(function(rData){ return { total: rData.total_results, capped: Math.min(rData.total_results, 10000) }; })
			.catch(function(e){ console.error('deck count fetch failed:', e); return { total: 0, capped: 0 }; });
		totalEntries += noFilterResult.total;
		for(var i=0; i<noFilterResult.capped; i++){ //only one URL so urlIndex is always 0
			entryIndexes.push([0, i]);
		}
		shuffle(entryIndexes);
		initializePostIndexGen();
	}
}

var speciesChoices=[];
var taxonIdChoices=[];
var regionChoices=[];
var regionIdChoices=[];

// Restore persisted location filter on load; applyLocationFilter calls applyCheckboxFilters
// which calls generateEntryIndexesList, so skip the direct call when a filter is restored.
(function(){
	var df = (window.MODES[window.currentDeckKey] && window.MODES[window.currentDeckKey].filters) || {};
	var savedLoc = df.region ? loadLocationFilter() : null;
	if(savedLoc){
		// applyLocationFilter is defined later (in the jQuery ready handler). Stash the
		// pending filter so that handler applies it once the function exists — avoids a
		// setTimeout race where the timer could fire before applyLocationFilter is defined.
		window.__pendingLocationRestore = savedLoc;
	} else {
		generateURLs();
		generateEntryIndexesList();
	}
})();

function getData(URL) {
	return fetch(URL).then(function(r){ return r.json(); });
}

async function sendQueries(){ //decides what URL to use then fetches
	var url;
	if(filterURLs.length === 0){ //no filters: use base URL
		if(page > 10000){ //need id_below marker to reach past the 10k API limit
			url = buildObsUrl({ page: page % 10000, perPage: 1, marker: IDsAt10kMarkers[Math.floor(page / 10000) - 1] });
		} else {
			url = buildObsUrl({ page: page, perPage: 1 });
		}
	} else { //filters active: use filter URL for this linkIndex
		url = filterURLs[linkIndex].replace("${page}", page).replace("${perpage}", 1);
	}
	data = await getData(url);
	return data;
}

async function anchorCheck(){
	var anchor = location.hash.replace('#','');
	if(anchor !== ""){
		var prelimData = await getData("https://api.inaturalist.org/v1/observations/"+anchor);
		window._pendingNavMethod = 'anchor';
		pushToHistory(prelimData.results[0]);
	}
}

function applyCheckboxFilters(preserveAnchor){
	if(anchored && !preserveAnchor){anchored=false;}
	var df = (window.MODES[window.currentDeckKey] && window.MODES[window.currentDeckKey].filters) || {};
	speciesChoices=[];
	taxonIdChoices=[];
	if(df.species){
		document.querySelectorAll('#speciesList input[type="checkbox"]:not(#allSpecies):checked').forEach(function(cb){
			speciesChoices.push(cb.dataset.name);
			taxonIdChoices.push(cb.value);
		});
	}
	regionChoices=[];
	regionIdChoices=[];
	if(df.region){
		document.querySelectorAll('#regionList input[type="checkbox"]:not(#allRegions):checked').forEach(function(cb){
			regionChoices.push(cb.dataset.name);
			regionIdChoices.push(cb.value);
		});
		// Persist region selection so it survives page reload
		if(regionChoices.length === 1){
			saveLocationFilter({ value: regionIdChoices[0], name: regionChoices[0] });
		} else {
			// Multiple or no regions selected — clear the single saved location
			saveLocationFilter(null);
		}
	}
	var totalActive = speciesChoices.length + regionChoices.length;
	document.getElementById("filterButton").innerHTML = totalActive > 0
		? "Filters (" + totalActive + " Active)"
		: "Filters (None)";
	if (window.track) window.track('filter_applied', { deck: window.currentDeckKey, species_count: speciesChoices.length });
	iteration = 0;
	sessionHistory = [];
	historyIndex = -1;
	page = 1;
	linkIndex = 0;
	prefetchedNext = null;
	generateURLs();
	generateEntryIndexesList();
	$('#answer').hide();
}

// Wire up filter checkboxes
$(function(){
	var allCb = document.getElementById('allSpecies');
	var speciesCbs = document.querySelectorAll('#speciesList input[type="checkbox"]:not(#allSpecies)');
	allCb.checked = true;
	speciesCbs.forEach(function(cb){ cb.checked = false; });

	allCb.addEventListener('change', function(){
		if(this.checked){
			speciesCbs.forEach(function(cb){ cb.checked = false; });
		} else {
			this.checked = true;
		}
		applyCheckboxFilters();
	});

	speciesCbs.forEach(function(cb){
		cb.addEventListener('change', function(){
			var anyChecked = document.querySelectorAll('#speciesList input[type="checkbox"]:not(#allSpecies):checked').length > 0;
			allCb.checked = !anyChecked;
			applyCheckboxFilters();
		});
	});

	var allRegionsCb = document.getElementById('allRegions');
	var regionCbs = document.querySelectorAll('#regionList input[type="checkbox"]:not(#allRegions)');
	allRegionsCb.checked = true;
	regionCbs.forEach(function(cb){ cb.checked = false; });

	allRegionsCb.addEventListener('change', function(){
		if(this.checked){
			regionCbs.forEach(function(cb){ cb.checked = false; });
		} else {
			this.checked = true;
		}
		applyCheckboxFilters();
	});

	regionCbs.forEach(function(cb){
		cb.addEventListener('change', function(){
			var anyChecked = document.querySelectorAll('#regionList input[type="checkbox"]:not(#allRegions):checked').length > 0;
			allRegionsCb.checked = !anyChecked;
			applyCheckboxFilters();
		});
	});
});

function generateHTML(images, entryID, entry, total){ //generates html for a new entry
	var taxon = entry.taxon || {};
	var answerName = taxon.preferred_common_name || taxon.name || "Unknown";
	var namesHTML = (taxon.preferred_common_name && taxon.name)
		? "<span class='answer-names'><span>" + answerName + "</span><span class='answer-scientific'>(" + taxon.name + ")</span></span>"
		: "<span>" + answerName + "</span>";
	if (taxon.id) {
		var taxonUrl = "https://www.inaturalist.org/taxa/" + taxon.id;
		document.getElementById("answer").innerHTML =
			"<a class='answer-link' href='" + taxonUrl + "' target='_blank' rel='noopener'>" + namesHTML + "<svg style='flex-shrink:0;margin-left:10px;opacity:0.6' width='17' height='17' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><path d='M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'/><polyline points='15 3 21 3 21 9'/><line x1='10' y1='14' x2='21' y2='3'/></svg></a>";
	} else {
		document.getElementById("answer").innerHTML =
			"<span class='answer-link'>" + namesHTML + "</span>";
	}
	// Build share link using the deck's slug so the URL is canonical and crawlable.
	// Default deck (tracking) uses root path; other decks use their slug.
	var deckSlug = (window.currentDeckKey !== window.DEFAULT_DECK && window.MODES[window.currentDeckKey])
		? (window.MODES[window.currentDeckKey].slug || '') : '';
	var shareLink = "https://flashcards.ethleb.com" + deckSlug + "#" + entry.id;
	var shareLinkEl = document.getElementById("shareLink");
	var iconClipboard = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><rect x="9" y="2" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
	var iconCheck = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;color:#94e2d5"><polyline points="20 6 9 17 4 12"/></svg>';
	shareLinkEl.innerHTML = iconClipboard + '<span>' + shareLink + '</span>';
	shareLinkEl.onclick = function() {
		navigator.clipboard.writeText(shareLink).then(function() {
			shareLinkEl.innerHTML = iconCheck + '<span>Copied!</span>';
			setTimeout(function() { shareLinkEl.innerHTML = iconClipboard + '<span>' + shareLink + '</span>'; }, 1500);
		});
	};
	document.getElementById("location").innerHTML = '<img src="/assets/logo-transparent-cropped.png" style="height:1em;width:1em;vertical-align:middle;margin-right:4px;filter:invert(1) opacity(0.7);"> ' + entry.place_guess;
	document.getElementById("linkObs").innerHTML = "<a href='"+entry.uri+"' target='_blank'>Go To Observation</a>";
	document.getElementById("totalObs").innerHTML = totalEntries+" Cards";
	document.getElementById("currentObs").innerHTML = "Current Card: "+(historyIndex+1);
	document.getElementById("shuffled").innerHTML = "Shuffled";
	var HTML="<div class='slideshow-track'>";
	for(var i=0; i<images.length; i++){
		var currentImage = i+1;
		var photoUrl = buildPhotoUrl(entry, i);
		HTML=HTML+"<div class='mySlides'>\n<img src='"+photoUrl+"' class='img' alt='Photo "+currentImage+"' id='img"+i+"'></div>\n";
	}
	HTML=HTML+"</div>";
	if(images.length>1){ //only add prev/next arrows if there is more than 1 image
		HTML=HTML+"\n\n<button class='prev' aria-label='Previous photo'>&#10094;</button>\n<button class='next' aria-label='Next photo'>&#10095;</button>\n";
		HTML=HTML+"<div id='slideCounter' class='numbertext'>1/"+images.length+"</div>\n";
	}
	document.getElementById("slideshowContainer").innerHTML = HTML; //inject generated html into page
	HTML="";
	for(var i=0; i<images.length; i++){
		HTML=HTML+"<button class='dot' aria-label='Photo "+(i+1)+"'></button>\n";
	}
	document.getElementById("dots").innerHTML = HTML; //inject into page
	slideIndex = 1;
	showSlides(slideIndex); //show slides
	wireSlideshow(images.length);
	setTimeout(syncSlideshowBound, 250);
}

function parseEntry(entry) { //gets list of photo ids from entry
	var entryID = entry.id; //gets entry ID
	window.currentCardId = entryID;
	window.currentEntry = entry;
	window._cardShownAt = Date.now();
	if (window.track) window.track('card_view', {
		deck: window.currentDeckKey,
		card_id: String(entryID),
		taxon_id: (entry.taxon ? entry.taxon.id : null),
		nav_method: window._pendingNavMethod || 'initial'
	});
	window._pendingNavMethod = null;
	markSeen(entryID);
	window.location.hash=""; //set anchor as id

	collapseMore();

	// Reset self-report UI and edibility badge for the new card
	selfReportShownForCurrentCard = false;
	hideEdibilityBadge();
	document.getElementById('selfReport').classList.remove('is-visible');
	var gotBtn = document.getElementById('gotItBtn');
	var missedBtn = document.getElementById('missedItBtn');
	gotBtn.classList.remove('active');
	missedBtn.classList.remove('active');
	gotBtn.disabled = false;
	missedBtn.disabled = false;
	document.getElementById('selfReportFeedback').textContent = '';
	// Restore session-cached report state on back-navigation
	if(window.reportResults[entryID]){
		gotBtn.disabled = true;
		missedBtn.disabled = true;
		if(window.reportResults[entryID] === 'correct') gotBtn.classList.add('active');
		else missedBtn.classList.add('active');
	}

	var images = [];
	for(var i=0; i<entry.photos.length; i++){
		images.push(entry.photos[i].id);
	}
	generateHTML(images, entryID, entry);
	if(typeof window.loadRating === 'function') window.loadRating(entryID);
	if(typeof window.loadAttempt === 'function') window.loadAttempt(entryID);
	renderSessionGrid();
}

window.renderSessionGrid = function renderSessionGrid() {
	var grid = document.getElementById('sessionGrid');
	var historySection = document.getElementById('historySection');
	if(!grid) return;
	if(sessionHistory.length === 0){ grid.style.display = 'none'; if(historySection) historySection.style.display = 'none'; return; }
	grid.style.display = 'flex';
	if(historySection) historySection.style.display = 'block';
	var html = '';
	for(var i = 0; i < sessionHistory.length; i++){
		var entry = sessionHistory[i];
		var result = window.reportResults[entry.id];
		var colorClass = result === 'correct' ? 'grid-tile--correct' : result === 'incorrect' ? 'grid-tile--incorrect' : 'grid-tile--unseen';
		var activeClass = i === historyIndex ? ' grid-tile--active' : '';
		var name = entry.taxon && entry.taxon.preferred_common_name ? entry.taxon.preferred_common_name : '?';
		html += '<div class="grid-tile ' + colorClass + activeClass + '" onclick="navigateToHistoryIndex(' + i + ')" title="' + name + '"></div>';
	}
	grid.innerHTML = html;
};

function navigateToHistoryIndex(i) {
	if(i < 0 || i >= sessionHistory.length) return;
	if (window.track) window.track('history_navigate', {
		deck: window.currentDeckKey,
		card_id: window.currentCardId ? String(window.currentCardId) : null,
		time_on_card_ms: window._cardShownAt ? Date.now() - window._cardShownAt : null,
		target_index: i
	});
	window._pendingNavMethod = 'history';
	historyIndex = i;
	window.location.hash = '';
	$('#answer').hide();
	document.getElementById('showAnswer').innerHTML = 'Show Answer';
	parseEntry(sessionHistory[i]);
}

function shuffle(a) { //shuffles a list
		for (let i = a.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[a[i], a[j]] = [a[j], a[i]];
		}
		return a;
}

function pushToHistory(entry) {
	sessionHistory.push(entry);
	historyIndex = sessionHistory.length - 1;
	$('#answer').hide();
	document.getElementById("showAnswer").innerHTML = "Show Answer";
	parseEntry(entry);
	setTimeout(prefetchNextCard, 0);
}

// Sample from Gamma(a) using the log-sum method (exact for integer a >= 1)
function sampleGamma(a) {
	var s = 0;
	for(var i = 0; i < a; i++) s -= Math.log(Math.random() || 1e-10);
	return s;
}

// Sample from Beta(a, b) via the Gamma ratio
function sampleBeta(a, b) {
	var ga = sampleGamma(a), gb = sampleGamma(b);
	return ga / (ga + gb);
}

// Thompson sampling over Pool A candidates (quality turn).
// Returns the winning card object, or null if a random iNat card (Beta(1,1)) won.
function thompsonDraw(candidates) {
	if(!candidates || candidates.length === 0) return null;
	var bestCard = null, bestScore = -1;
	candidates.forEach(function(card) {
		var score = sampleBeta((card.thumbsUp || 0) + 1, (card.thumbsDown || 0) + 1);
		if(score > bestScore){ bestScore = score; bestCard = card; }
	});
	// A random unseen iNat card is modelled as Beta(1,1) = Math.random().
	// If the best Pool A card can't beat that, serve a fresh random card instead.
	return bestScore > Math.random() ? bestCard : null;
}

// Weighted draw favouring cards with shaky ELO (few reports), penalising downvoted cards (refine turn).
// ratingBoost decays from 1.0 → 0 as n approaches ELO_TARGET, then holds at EXPLORE_WEIGHT.
// thumbsQuality = Beta expected value in (0,1] — penalises downvoted cards smoothly.
var ELO_TARGET = 8;
var EXPLORE_WEIGHT = 0.3;
// Prefetch: false = preload only the first photo (lighter); true = preload every photo (smoother slideshow).
var PREFETCH_ALL_IMAGES = false;
function ratingDrawWeight(card) {
	var n = (card.correctCount || 0) + (card.incorrectCount || 0);
	var boost = n > 0 && n < ELO_TARGET ? (1 - n / ELO_TARGET) : EXPLORE_WEIGHT;
	var thumbsQuality = ((card.thumbsUp || 0) + 1) / ((card.thumbsUp || 0) + (card.thumbsDown || 0) + 2);
	return boost * thumbsQuality;
}
function weightedDraw(candidates) {
	if(!candidates || candidates.length === 0) return null;
	var weights = candidates.map(ratingDrawWeight);
	var total = weights.reduce(function(s, w) { return s + w; }, 0);
	if(total <= 0) return null;
	// Compete against the same Beta(1,1) baseline as thompsonDraw.
	var bestScore = Math.random();
	var winner = null;
	var cumulative = 0;
	var r = Math.random() * total;
	for(var i = 0; i < candidates.length; i++){
		cumulative += weights[i];
		if(r <= cumulative){ winner = candidates[i]; break; }
	}
	if(!winner) winner = candidates[candidates.length - 1];
	// Only serve if the best normalised weight beats the baseline.
	var normalised = Math.max.apply(null, weights) / (total / candidates.length);
	return normalised > bestScore ? winner : null;
}

// Fraction of draws that go through the targeted-species path (vs. Pool A / shuffled deck).
var TARGET_FRACTION = 0.5;
// Exponents for the species score formula: score = w^COMMONALITY_POWER * (1-p)^ACCURACY_POWER.
// Both default to 1 (linear). Raise COMMONALITY_POWER to favour very common species more strongly;
// raise ACCURACY_POWER to favour species the user keeps missing more strongly.
var COMMONALITY_POWER = 1;
var ACCURACY_POWER = 1;

// Stage 1: Thompson-sample a target species weighted by commonality × (1 − rolling accuracy).
// Returns { taxonId, count } or null if no commonality data or all species filtered out.
function drawTargetSpecies(activeTaxonIds, activePlaceIds) {
	if (!window.speciesCommonality || window.speciesCommonality.size === 0) return null;
	var candidates = [];
	window.speciesCommonality.forEach(function(data, taxonId) {
		if (activeTaxonIds.length > 0) {
			var ancestors = data.ancestorIds || [];
			if (!activeTaxonIds.some(function(id){ return ancestors.includes(id) || id === taxonId; })) return;
		}
		var stats = window.speciesStatsCache ? window.speciesStatsCache.get(String(taxonId)) : null;
		var recent = stats ? (stats.recent || []) : [];
		var correct = recent.filter(function(r){ return r === 'c'; }).length;
		var incorrect = recent.length - correct;
		var pSample = sampleBeta(correct + 1, incorrect + 1);
		var score = Math.pow(data.w, COMMONALITY_POWER) * Math.pow(1 - pSample, ACCURACY_POWER);
		candidates.push({ taxonId: taxonId, score: score, count: data.count });
	});
	if (candidates.length === 0) return null;
	var total = candidates.reduce(function(s, c){ return s + c.score; }, 0);
	if (total <= 0) return null;
	var r = Math.random() * total;
	var cumulative = 0;
	for (var i = 0; i < candidates.length; i++) {
		cumulative += candidates[i].score;
		if (r <= cumulative) return candidates[i];
	}
	return candidates[candidates.length - 1];
}

// Builds the full-resolution photo URL for entry photo index i.
// Must produce a byte-identical URL to generateHTML so the browser cache is hit on render.
function buildPhotoUrl(entry, i) {
	var thumb = entry.observation_photos[i].photo.url;
	var base  = thumb.split("photos/")[0] + "photos/";
	var ext   = thumb.split("/square.")[1].split("?")[0];
	return base + entry.photos[i].id + "/large." + ext + "?";
}

function preloadEntryImages(entry) {
	var count = PREFETCH_ALL_IMAGES ? entry.photos.length : 1;
	var imgs = [];
	for (var i = 0; i < count; i++) {
		var img = new Image();
		img.src = buildPhotoUrl(entry, i);
		imgs.push(img);
	}
	return imgs; // hold references so GC doesn't drop in-flight loads
}

var prefetchedNext = null; // { promise, entry, images } or null

function prefetchNextCard() {
	// Only prefetch when the user is at the session frontier (not inside history)
	if (historyIndex < sessionHistory.length - 1) return;
	// Already have a prefetch in flight or ready
	if (prefetchedNext) return;
	var slot = {};
	slot.entry = null;
	slot.images = [];
	slot.promise = fetchNextCard().then(function(entry) {
		if (entry) {
			slot.entry = entry;
			slot.images = preloadEntryImages(entry);
		}
		return entry;
	});
	prefetchedNext = slot;
}

async function fetchNextCard() {
	// Tier 1: Targeted-species path (commonality × accuracy-gap sampling)
	var adaptiveToggle = document.getElementById('adaptiveToggle');
	if ((!adaptiveToggle || adaptiveToggle.checked) && Math.random() < TARGET_FRACTION) {
		var activeTaxonIds = taxonIdChoices.map(function(v){ return parseInt(v.split('=')[1]); });
		var activePlaceIds = regionIdChoices.map(function(v){ return parseInt(v.split('=')[1]); });
		var target = drawTargetSpecies(activeTaxonIds, activePlaceIds);
		if (target) {
			// Stage 2a: pick a quality-rated card in Pool A for this species
			if (typeof window.getSpeciesPoolA === 'function') {
				var speciesCandidates = window.getSpeciesPoolA(target.taxonId, activePlaceIds, seenCards);
				var poolWinner = Math.random() < 0.5 ? weightedDraw(speciesCandidates) : thompsonDraw(speciesCandidates);
				if (poolWinner) {
					var poolResult = await getData("https://api.inaturalist.org/v1/observations/" + poolWinner.id);
					if (poolResult && poolResult.results && poolResult.results[0]) return poolResult.results[0];
				}
			}
			// Stage 2b: fetch a fresh random observation for this species from iNat
			var maxPage = Math.min(target.count, 10000);
			var randomPage = Math.ceil(Math.random() * maxPage);
			var regionParam = regionIdChoices.length > 0 ? regionIdChoices[Math.floor(Math.random() * regionIdChoices.length)] : '';
			var freshData = await getData(buildObsUrl({ page: randomPage, perPage: 1, filter: '&taxon_id=' + target.taxonId + regionParam }));
			if (freshData && freshData.results && freshData.results[0]) {
				var freshEntry = freshData.results[0];
				if (!seenCards.has(freshEntry.id)) return freshEntry;
			}
		}
	}

	// Tier 2: Pool A
	if(typeof window.getFilteredPoolA === 'function'){
		var candidates = window.getFilteredPoolA(taxonIdChoices, regionIdChoices, seenCards);
		var winner = Math.random() < 0.5 ? weightedDraw(candidates) : thompsonDraw(candidates);
		if(winner){
			var obsResult = await getData("https://api.inaturalist.org/v1/observations/" + winner.id);
			if(obsResult && obsResult.results && obsResult.results[0]){
				return obsResult.results[0];
			}
		}
	}
	// Tier 3: Shuffled deck
	if(iteration < totalEntries - 1) iteration++;
	var slot = entryIndexes[iteration];
	if(!slot) return null;
	linkIndex = slot[0];
	page = slot[1] + 1;
	if(page > 10000){
		var markerIdx = Math.floor(page / 10000) - 1;
		if(IDsAt10kMarkers[markerIdx] === undefined){
			var safeMax = Math.min(totalEntries, 10000 * (IDsAt10kMarkers.length + 1));
			page = Math.ceil(Math.random() * safeMax);
		}
	}
	var fetchedData = await sendQueries();
	var entry = fetchedData.results[0];
	if(!entry){
		if(iteration < totalEntries - 1) return fetchNextCard();
		return null;
	}
	if(isSeen(entry.id) && iteration < totalEntries - 1){
		return fetchNextCard();
	}
	return entry;
}

async function fetchAndPushCard() {
	var entry = await fetchNextCard();
	if (entry) pushToHistory(entry);
}

async function nextEntry(direction) {
	if(anchored){ anchored = false; }
	if (window.track) window.track('card_navigate', {
		deck: window.currentDeckKey,
		direction: direction === 0 ? 'prev' : 'next',
		time_on_card_ms: window._cardShownAt ? Date.now() - window._cardShownAt : null
	});
	window._pendingNavMethod = direction === 0 ? 'prev' : 'next';
	window.location.hash = "";
	if(direction === 0){ // Prev — always use session history, never fetch
		if(historyIndex > 0){
			historyIndex--;
			$('#answer').hide();
			document.getElementById("showAnswer").innerHTML = "Show Answer";
			parseEntry(sessionHistory[historyIndex]);
		}
		return;
	}
	if(direction === 1){ // Next
		if(historyIndex < sessionHistory.length - 1){
			// Still within session history — just move the pointer, no fetch needed
			historyIndex++;
			$('#answer').hide();
			document.getElementById("showAnswer").innerHTML = "Show Answer";
			parseEntry(sessionHistory[historyIndex]);
			return;
		}
		// Past the frontier — consume prefetched card if ready, otherwise fetch normally
		if(prefetchedNext){
			var slot = prefetchedNext;
			prefetchedNext = null;
			var entry = slot.entry || await slot.promise;
			if(entry) pushToHistory(entry);
			else await fetchAndPushCard();
		} else {
			await fetchAndPushCard();
		}
	}
}


// Snapshots collapsed controls height into --ctrl-h-init (fixes image max-height)
// and --ctrl-h-live (drives padding-bottom for centering). Called once per card
// and on resize. ResizeObserver below keeps --ctrl-h-live current as controls expand.
function syncSlideshowBound() {
	var panel = document.querySelector('.slideshow-panel');
	var controls = document.querySelector('.controls-panel');
	if (!panel || !controls) return;
	if (window.innerWidth > 768) {
		panel.style.removeProperty('--ctrl-h-init');
		panel.style.removeProperty('--ctrl-h-live');
		return;
	}
	var h = controls.offsetHeight + 'px';
	panel.style.setProperty('--ctrl-h-init', h);
	panel.style.setProperty('--ctrl-h-live', h);
}
window.addEventListener('resize', syncSlideshowBound);

// Keeps --ctrl-h-live tracking the controls height as it changes (answer reveal,
// more section, etc.) so the slideshow stays centered in the available space.
(function() {
	var observer = new ResizeObserver(function() {
		if (window.innerWidth > 768) return;
		var panel = document.querySelector('.slideshow-panel');
		var controls = document.querySelector('.controls-panel');
		if (panel && controls) panel.style.setProperty('--ctrl-h-live', controls.offsetHeight + 'px');
	});
	function start() { var c = document.querySelector('.controls-panel'); if (c) observer.observe(c); }
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
	else start();
}());

//////////////////////////slideshow
var slideIndex = 1;
var slideAnimating = false;

function unlockSlide() { slideAnimating = false; }

function getTrack() { return document.querySelector("#slideshowContainer .slideshow-track"); }

function setTrackPos(track, idx, animate) {
	if (animate) {
		track.classList.add("is-animating");
	} else {
		track.classList.remove("is-animating");
	}
	track.style.transform = "translateX(" + (-(idx - 1) * 100) + "%)";
}

function updateDots(idx) {
	var dots = document.getElementsByClassName("dot");
	for (var i = 0; i < dots.length; i++) {
		dots[i].classList.toggle("active", i === idx - 1);
	}
	var counter = document.getElementById("slideCounter");
	if (counter) counter.textContent = idx + "/" + dots.length;
}

function plusSlides(n) {
	if (slideAnimating) return;
	var slides = document.getElementsByClassName("mySlides");
	var next = slideIndex + n;
	if (next < 1) next = slides.length;
	if (next > slides.length) next = 1;
	slideIndex = next;
	var track = getTrack();
	if (track) {
		slideAnimating = true;
		setTrackPos(track, slideIndex, true);
		track.addEventListener("transitionend", unlockSlide, { once: true });
	}
	updateDots(slideIndex);
}

function currentSlide(n) {
	var slides = document.getElementsByClassName("mySlides");
	slideIndex = Math.max(1, Math.min(slides.length, n));
	var track = getTrack();
	if (track) setTrackPos(track, slideIndex, true);
	updateDots(slideIndex);
}

function showSlides(n) {
	var slides = document.getElementsByClassName("mySlides");
	if (n > slides.length) { slideIndex = 1; }
	if (n < 1) { slideIndex = slides.length; }
	var track = getTrack();
	if (track) setTrackPos(track, slideIndex, false);
	updateDots(slideIndex);
}

// Wire arrows and dots (called after generateHTML injects them — elements are replaced each card)
function wireSlideshow(imageCount) {
	var container = document.getElementById("slideshowContainer");
	var prevBtn = container.querySelector(".prev");
	var nextBtn = container.querySelector(".next");
	if (prevBtn) prevBtn.onclick = function() { plusSlides(-1); };
	if (nextBtn) nextBtn.onclick = function() { plusSlides(1); };

	var dots = document.getElementsByClassName("dot");
	for (var i = 0; i < dots.length; i++) {
		(function(idx) { dots[idx].onclick = function() { currentSlide(idx + 1); }; })(i);
	}
}

// Touch swipe — wired once at startup; reads current slide state dynamically
(function() {
	var container = document.getElementById("slideshowContainer");
	var touchStartX = null;
	var touchStartY = null;
	var dragging = false;
	var containerWidth = 0;

	container.addEventListener("touchstart", function(e) {
		// Don't treat arrow button taps as swipe gestures — they have their own onclick
		if (e.target.closest('.prev, .next')) { touchStartX = null; return; }
		slideAnimating = false; // cancel any in-progress arrow animation
		touchStartX = e.touches[0].clientX;
		touchStartY = e.touches[0].clientY;
		dragging = false;
		containerWidth = container.offsetWidth;
		var track = getTrack();
		if (track) track.classList.remove("is-animating");
	}, { passive: true });

	container.addEventListener("touchmove", function(e) {
		if (touchStartX === null) return;
		var slides = document.getElementsByClassName("mySlides");
		if (slides.length < 2) return;
		var dx = e.touches[0].clientX - touchStartX;
		var dy = e.touches[0].clientY - touchStartY;
		if (!dragging) {
			if (Math.abs(dy) > Math.abs(dx)) { touchStartX = null; return; }
			dragging = true;
		}
		var track = getTrack();
		if (!track) return;
		var base = -(slideIndex - 1) * 100;
		var offset = (dx / containerWidth) * 100;
		if ((slideIndex === 1 && dx > 0) || (slideIndex === slides.length && dx < 0)) {
			offset = offset * 0.25;
		}
		track.style.transform = "translateX(" + (base + offset) + "%)";
	}, { passive: true });

	container.addEventListener("touchend", function(e) {
		if (!dragging) { touchStartX = null; return; }
		var dx = e.changedTouches[0].clientX - touchStartX;
		touchStartX = null;
		dragging = false;
		var slides = document.getElementsByClassName("mySlides");
		if (slides.length < 2) return;
		var threshold = containerWidth * 0.2;
		if (dx < -threshold && slideIndex < slides.length) {
			plusSlides(1);
		} else if (dx > threshold && slideIndex > 1) {
			plusSlides(-1);
		} else {
			var track = getTrack();
			if (track) setTrackPos(track, slideIndex, true);
		}
	}, { passive: true });
}());

//////////////////////////////////modals

function setupFilterModal(){
	var filterModal = document.getElementById('filterModal');
	document.getElementById("filterButton").onclick = function() {
		filterModal.style.display = "block";
	};
	filterModal.querySelector('.close').onclick = function() {
		filterModal.style.display = "none";
	};
}

setupFilterModal();

// Adaptive Species Selection info modal
(function(){
	var btn = document.getElementById('adaptiveInfoBtn');
	var modal = document.getElementById('adaptiveInfoModal');
	var closeBtn = document.getElementById('adaptiveInfoClose');
	var row = document.getElementById('adaptiveToggleRow');
	var toggle = document.getElementById('adaptiveToggle');
	row.addEventListener('click', function(e){
		if (e.target === btn || btn.contains(e.target)) return;
		toggle.checked = !toggle.checked;
		toggle.dispatchEvent(new Event('change'));
	});
	btn.addEventListener('click', function(e){
		e.stopPropagation();
		modal.style.display = 'block';
	});
	closeBtn.addEventListener('click', function(){ modal.style.display = 'none'; });
	modal.addEventListener('click', function(e){ if (e.target === modal) modal.style.display = 'none'; });
})();

// Adaptive Species Selection toggle
(function(){
	var toggle = document.getElementById('adaptiveToggle');
	try { if (localStorage.getItem('adaptiveEnabled') === 'false') toggle.checked = false; } catch(e) {}
	toggle.addEventListener('change', function(){
		try { localStorage.setItem('adaptiveEnabled', this.checked ? 'true' : 'false'); } catch(e) {}
		if (window.track) window.track('setting_change', { deck: window.currentDeckKey, setting: 'adaptive_species', value: this.checked });
	});
})();

// Deck selector
(function(){
	var sel = document.getElementById('deckSelect');
	Object.keys(window.MODES).forEach(function(key){
		var m = window.MODES[key];
		if(m.type !== 'deck') return;
		var opt = document.createElement('option');
		opt.value = key;
		opt.textContent = m.label;
		if(key === window.currentDeckKey) opt.selected = true;
		sel.appendChild(opt);
	});

	function applyDeckFilterVisibility(){
		var df = (window.MODES[window.currentDeckKey] && window.MODES[window.currentDeckKey].filters) || {};
		var anyFilter = !!(df.species || df.region);
		document.getElementById('filterButton').style.display = anyFilter ? '' : 'none';
		var speciesSection = document.getElementById('speciesFilterSection');
		var speciesDivider = document.getElementById('speciesDivider');
		if(speciesSection) speciesSection.style.display = df.species ? '' : 'none';
		if(speciesDivider) speciesDivider.style.display = df.species ? '' : 'none';
	}
	applyDeckFilterVisibility();

	function resetFilterCheckboxes(){
		var allSpeciesCb = document.getElementById('allSpecies');
		if(allSpeciesCb){
			allSpeciesCb.checked = true;
			document.querySelectorAll('#speciesList input[type="checkbox"]:not(#allSpecies)').forEach(function(cb){ cb.checked = false; });
		}
		var allRegionsCb = document.getElementById('allRegions');
		if(allRegionsCb){
			allRegionsCb.checked = true;
			document.querySelectorAll('#regionList input[type="checkbox"]:not(#allRegions)').forEach(function(cb){ cb.checked = false; });
		}
		document.getElementById('filterButton').innerHTML = 'Filters (None)';
	}

	function switchDeck(key){
		var mode = window.MODES[key];
		if(!mode || !mode.slug) return;
		if (window.track) window.track('deck_switch', { deck: key, from_deck: window.currentDeckKey });
		location.assign(mode.slug);
	}

	sel.addEventListener('change', function(){ switchDeck(this.value); });

})();

// Dev tools (local only)
(function(){
	var isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.protocol === 'file:';
	if(!isLocal) return;
	document.getElementById('devClearRow').style.display = '';
	document.getElementById('devClearBtn').onclick = function(){
		localStorage.clear();
		location.reload();
	};
})();

// More section toggle
function collapseMore() {
	if (window.innerWidth > 768) return;
	var filterModal = document.getElementById('filterModal');
	if (filterModal && filterModal.style.display === 'block') return;
	var $body = $('#moreBody');
	if (!$body.is(':visible')) return;
	$body.slideUp(200);
	var toggle = document.getElementById('moreToggle');
	toggle.classList.remove('open');
	toggle.querySelector('span:first-child').textContent = 'More';
}

document.getElementById('moreToggle').addEventListener('click', function(){
	var $body = $('#moreBody');
	var isOpen = $body.is(':visible');
	if(isOpen){ $body.slideUp(200); }
	else {
		$body.slideDown(200);
		if (window.track) window.track('more_panel_open', { deck: window.currentDeckKey, card_id: window.currentCardId ? String(window.currentCardId) : null });
	}
	this.classList.toggle('open', !isOpen);
	this.querySelector('span:first-child').textContent = isOpen ? 'More' : 'Less';
});

document.addEventListener('click', function(e) {
	if (window.innerWidth > 768) return;
	if (!e.target.closest('.controls-panel')) collapseMore();
});

function setupInfoModal(){
	var infoModal = document.getElementById('infoModal');
	document.getElementById("infoButton").onclick = function() {
		infoModal.style.display = "block";
		if (window.track) window.track('more_info_open', { deck: window.currentDeckKey, card_id: window.currentCardId ? String(window.currentCardId) : null });
	};
	infoModal.querySelector('.close').onclick = function() {
		infoModal.style.display = "none";
	};
}

setupInfoModal();

// Location modal
$(function(){
	var modal = document.getElementById('locationModal');
	var regionSelect = document.getElementById('locationRegionSelect');
	var msgEl = document.getElementById('locationModalMsg');

	// Radius control (miles; converted to km for iNat API). The radius appears in two places
	// — the first-visit location modal and the Filters modal — so the value and both inputs
	// are kept in sync here, and a live "Near me" filter re-applies when the radius changes.
	var RADIUS_STEP = 50;
	var RADIUS_MIN = 50;
	var RADIUS_MAX = 5000;
	var nearMeRadiusMi = 600;
	try { var saved = parseInt(localStorage.getItem('nearMeRadiusMi'), 10); if(saved >= RADIUS_MIN) nearMeRadiusMi = saved; } catch(e){}
	var lastNearMeCoords = null;
	try { var c = JSON.parse(localStorage.getItem('nearMeCoords') || 'null'); if(c && c.lat && c.lng) lastNearMeCoords = c; } catch(e){}

	var radiusInputs = ['radiusDisplay', 'filterRadiusDisplay']
		.map(function(id){ return document.getElementById(id); })
		.filter(Boolean);
	function clampRadius(v){ return Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, v || RADIUS_MIN)); }
	function syncRadiusDisplays(){ radiusInputs.forEach(function(el){ el.value = nearMeRadiusMi; }); }
	syncRadiusDisplays();

	function isNearMeActive(){
		var cb = document.getElementById('dynamicLocationCb');
		return !!(cb && cb.checked);
	}
	var radiusApplyTimer = null;
	function applyRadiusChange(){
		if(!(lastNearMeCoords && isNearMeActive())) return; // only re-apply a live near-me filter
		clearTimeout(radiusApplyTimer);
		radiusApplyTimer = setTimeout(function(){
			var loc = { value: buildNearMeValue(lastNearMeCoords.lat, lastNearMeCoords.lng), name: 'Near me (' + nearMeRadiusMi + ' mi)' };
			saveLocationFilter(loc);
			window.applyLocationFilter(loc);
		}, 400);
	}
	function setRadius(v){
		nearMeRadiusMi = clampRadius(v);
		try { localStorage.setItem('nearMeRadiusMi', String(nearMeRadiusMi)); } catch(e){}
		syncRadiusDisplays();
		applyRadiusChange();
	}
	function wireStepper(displayId, downId, upId){
		var d = document.getElementById(displayId);
		if(d) d.addEventListener('change', function(){ setRadius(parseInt(this.value, 10)); });
		var down = document.getElementById(downId);
		if(down) down.onclick = function(){ setRadius(nearMeRadiusMi - RADIUS_STEP); };
		var up = document.getElementById(upId);
		if(up) up.onclick = function(){ setRadius(nearMeRadiusMi + RADIUS_STEP); };
	}
	wireStepper('radiusDisplay', 'radiusStepDown', 'radiusStepUp');
	wireStepper('filterRadiusDisplay', 'filterRadiusStepDown', 'filterRadiusStepUp');

	function buildNearMeValue(lat, lng){
		var radiusKm = Math.round(nearMeRadiusMi * 1.60934);
		return '&lat=' + lat + '&lng=' + lng + '&radius=' + radiusKm;
	}

	// Shared geolocation request used by both the location modal and the Filters modal.
	function requestNearMe(msgEl, onSuccess){
		msgEl.textContent = 'Getting location…';
		msgEl.style.color = 'var(--subtext0)';
		if(!navigator.geolocation){ msgEl.textContent = 'Geolocation is not supported by your browser.'; msgEl.style.color = 'var(--red)'; return; }
		navigator.geolocation.getCurrentPosition(
			function(pos){
				var lat = pos.coords.latitude.toFixed(4);
				var lng = pos.coords.longitude.toFixed(4);
				lastNearMeCoords = { lat: lat, lng: lng };
				try { localStorage.setItem('nearMeCoords', JSON.stringify(lastNearMeCoords)); } catch(e){}
				try { localStorage.setItem('nearMeRadiusMi', String(nearMeRadiusMi)); } catch(e){}
				try { localStorage.setItem('locationPrompted', '1'); } catch(e){}
				var loc = { value: buildNearMeValue(lat, lng), name: 'Near me (' + nearMeRadiusMi + ' mi)' };
				saveLocationFilter(loc);
				window.applyLocationFilter(loc);
				msgEl.textContent = '';
				if(onSuccess) onSuccess();
			},
			function(err){
				var msg = err.code === 1 ? 'Location access was denied. Choose a region below.' : 'Could not get your location. Choose a region below.';
				msgEl.textContent = msg;
				msgEl.style.color = 'var(--red)';
			},
			{ timeout: 10000 }
		);
	}
	var filterNearMeBtn = document.getElementById('filterNearMeBtn');
	if(filterNearMeBtn){
		filterNearMeBtn.onclick = function(){ requestNearMe(document.getElementById('filterNearMeMsg')); };
	}

	// Populate dropdown from existing regionList checkboxes (single source of truth)
	document.querySelectorAll('#regionList input[type="checkbox"]:not(#allRegions)').forEach(function(cb){
		var opt = document.createElement('option');
		opt.value = cb.value;
		opt.textContent = cb.dataset.name;
		regionSelect.appendChild(opt);
	});

	function closeModal(){ modal.style.display = 'none'; }

	// Apply a saved location filter by checking the matching checkbox (or creating one for lat/lng)
	window.applyLocationFilter = function(loc, opts){
		var allRegions = document.getElementById('allRegions');
		document.querySelectorAll('#regionList input[type="checkbox"]:not(#allRegions)').forEach(function(cb){ cb.checked = false; });
		if(loc){
			var cb = [...document.querySelectorAll('#regionList input[type="checkbox"]:not(#allRegions)')]
				.find(function(c){ return c.value === loc.value; });
			if(!cb){
				// Remove any stale near-me checkbox (e.g. when the radius changed, the value differs)
				var staleDyn = document.getElementById('dynamicLocationCb');
				if(staleDyn){ var staleLabel = staleDyn.closest('label'); if(staleLabel) staleLabel.remove(); }
				// Dynamic checkbox for current-location lat/lng filter
				cb = document.createElement('input');
				cb.type = 'checkbox';
				cb.value = loc.value;
				cb.dataset.name = loc.name;
				cb.id = 'dynamicLocationCb';
				cb.addEventListener('change', function(){
					var anyChecked = document.querySelectorAll('#regionList input[type="checkbox"]:not(#allRegions):checked').length > 0;
					var allRegionsCb = document.getElementById('allRegions');
					if(allRegionsCb) allRegionsCb.checked = !anyChecked;
					applyCheckboxFilters();
				});
				var label = document.createElement('label');
				label.className = 'filter-item';
				label.appendChild(cb);
				var check = document.createElement('span');
				check.className = 'filter-check';
				label.appendChild(check);
				label.appendChild(document.createTextNode(loc.name));
				var regionList = document.getElementById('regionList');
				regionList.insertBefore(label, regionList.children[1]); // after "All Regions"
			}
			cb.checked = true;
			if(allRegions) allRegions.checked = false;
		} else {
			if(allRegions) allRegions.checked = true;
		}
		applyCheckboxFilters(opts && opts.preserveAnchor);
	};

	// Apply a location filter persisted from a previous visit. The startup IIFE runs during
	// parsing (before this function is defined) and stashes the pending filter here.
	if(window.__pendingLocationRestore){
		// Preserve a shared/anchored card (#<obsId>) so the restored filter doesn't replace it.
		window.applyLocationFilter(window.__pendingLocationRestore, { preserveAnchor: anchored });
		window.__pendingLocationRestore = null;
	}

	document.getElementById('useCurrentLocBtn').onclick = function(){
		requestNearMe(msgEl, closeModal);
	};

	document.getElementById('saveLocationBtn').onclick = function(){
		var val = regionSelect.value;
		if(!val){ msgEl.textContent = 'Please choose a region.'; msgEl.style.color = 'var(--red)'; return; }
		var name = regionSelect.options[regionSelect.selectedIndex].textContent;
		var loc = { value: val, name: name };
		saveLocationFilter(loc);
		try { localStorage.setItem('locationPrompted', '1'); } catch(e){}
		window.applyLocationFilter(loc);
		closeModal();
	};

	document.getElementById('skipLocationBtn').onclick = function(){
		try { localStorage.setItem('locationPrompted', '1'); } catch(e){}
		closeModal();
	};

	// Show on first visit if current deck supports region filters
	(function(){
		var prompted = false;
		try { prompted = !!localStorage.getItem('locationPrompted'); } catch(e){}
		var df = (window.MODES[window.currentDeckKey] && window.MODES[window.currentDeckKey].filters) || {};
		if(!prompted && df.region){
			modal.style.display = 'block';
		}
	})();
});


// Single global modal-dismiss handlers (bound once, not per card)
// ── Edibility badge ──────────────────────────────────────────────────────────
var mushroomEdibility = null;

(function loadMushroomEdibility(){
	fetch('/data/mushroom-edibility.json')
		.then(function(r){ return r.json(); })
		.then(function(d){ mushroomEdibility = d; })
		.catch(function(){ mushroomEdibility = {}; });
})();

var EDIBILITY_LABELS = {
	choice:        { icon: '★', text: 'Choice edible' },
	edible:        { icon: '✓', text: 'Edible' },
	'edible cooked': { icon: '🔥', text: 'Edible when cooked' },
	medicinal:     { icon: '♥', text: 'Medicinal' },
	inedible:      { icon: '⦸', text: 'Inedible' },
	caution:       { icon: '⚠', text: 'Caution' },
	allergenic:    { icon: '⚠', text: 'Allergenic' },
	psychoactive:  { icon: '☸', text: 'Psychoactive' },
	poisonous:     { icon: '☠', text: 'Poisonous' },
	deadly:        { icon: '☠', text: 'Deadly poisonous' },
};

function getEdibility(entry) {
	if (!mushroomEdibility || !entry) return null;
	var ids = [entry.taxon && entry.taxon.id].concat(entry.taxon && entry.taxon.ancestor_ids || []);
	for (var i = 0; i < ids.length; i++) {
		var v = mushroomEdibility[String(ids[i])];
		if (v) return v; // { labels: [...], qid: "Q..." } at the most specific matching level
	}
	return null;
}

function showEdibilityBadge() {
	var el  = document.getElementById('edibility-badge');
	var src = document.getElementById('edibility-source');
	if (!el) return;

	// Clear any pending hide-transition cleanup
	if (el._hideTimer) { clearTimeout(el._hideTimer); el._hideTimer = null; }

	el.innerHTML = '';
	el.classList.remove('is-visible');
	if (src) src.classList.remove('is-visible');

	if (window.currentDeckKey !== 'mushrooms') return;
	var result = getEdibility(window.currentEntry);
	if (!result || !result.labels || !result.labels.length) return;

	result.labels.forEach(function(edibility) {
		var meta = EDIBILITY_LABELS[edibility];
		if (!meta) return;
		var pill = document.createElement('span');
		pill.className = 'eb-pill eb--' + edibility.replace(/\s+/g, '-');
		pill.textContent = meta.icon + ' ' + meta.text;
		el.appendChild(pill);
	});

	if (el.children.length) {
		if (src) {
			var wikiUrl = result.qid
				? 'https://www.wikidata.org/wiki/' + result.qid
				: 'https://www.wikidata.org';
			var link = src.querySelector('a');
			if (link) link.href = wikiUrl;
		}
		// Restore display then defer so the browser sees the collapsed state before animating
		el.style.display = '';
		if (src) src.style.display = '';
		requestAnimationFrame(function() {
			el.classList.add('is-visible');
			if (src) src.classList.add('is-visible');
		});
	}
}

function hideEdibilityBadge() {
	var el  = document.getElementById('edibility-badge');
	var src = document.getElementById('edibility-source');
	if (!el) return;
	el.classList.remove('is-visible');
	if (src) src.classList.remove('is-visible');
	// Clear innerHTML after transition so pills don't flash back during slide-in
	el._hideTimer = setTimeout(function() {
		el.innerHTML = '';
		el.style.display = 'none';
		var src2 = document.getElementById('edibility-source');
		if (src2) src2.style.display = 'none';
		el._hideTimer = null;
	}, 300);
}
// ─────────────────────────────────────────────────────────────────────────────

window.onclick = function(event) {
	['filterModal','infoModal'].forEach(function(id){
		var m = document.getElementById(id);
		if(m && event.target === m) m.style.display = "none";
	});
};

document.addEventListener('click', function(e) {
	var a = e.target.closest('a[href]');
	if (!a) return;
	var href = a.getAttribute('href') || '';
	if (!href || href.charAt(0) === '#' || href.indexOf('javascript') === 0) return;
	var linkType = 'external';
	if (href.indexOf('inaturalist.org/observations') !== -1) linkType = 'inat_obs';
	else if (href.indexOf('inaturalist.org/taxa') !== -1) linkType = 'inat_taxon';
	else if (href.indexOf('inaturalist.org') !== -1) linkType = 'inat_other';
	else if (href.indexOf('reddit.com') !== -1) linkType = 'reddit';
	else if (href.indexOf('ethleb.com') !== -1) linkType = 'author_site';
	else if (href.indexOf('wikidata.org') !== -1) linkType = 'wikidata';
	if (window.track) window.track('link_follow', {
		deck: window.currentDeckKey,
		card_id: window.currentCardId ? String(window.currentCardId) : null,
		link_type: linkType
	});
});
$(document).keyup(function(e) {
	if(e.keyCode === 27){
		document.querySelectorAll('.modal').forEach(function(m){ m.style.display = "none"; });
		// Esc on location modal counts as "skip" — mark prompted so it doesn't re-appear
		try { localStorage.setItem('locationPrompted', '1'); } catch(e){}
	}
	// Arrow keys: navigate photos within the current card (skip if typing in an input)
	var tag = document.activeElement && document.activeElement.tagName;
	if(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
	if(e.keyCode === 37) { plusSlides(-1); }
	if(e.keyCode === 39) { plusSlides(1); }
});
