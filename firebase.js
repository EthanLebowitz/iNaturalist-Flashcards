import { initializeApp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, getDocs, collection, increment, serverTimestamp, runTransaction } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyD_StgI5Ka3wdHFVjjfxH7p2_W1P4eUpJg",
  authDomain: "track-cards-585dc.firebaseapp.com",
  projectId: "track-cards-585dc",
  storageBucket: "track-cards-585dc.firebasestorage.app",
  messagingSenderId: "170711990598",
  appId: "1:170711990598:web:3cd6655ee8ec9a1b84e547"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ── Analytics ────────────────────────────────────────────────────────────────
// GA4 is already loaded via the gtag.js snippet in <head> (measurement id
// G-1PLNMCYXMQ). Route all custom events through it — no separate SDK needed.
// track(name, params) is exposed globally for the classic script and used here too.
function track(name, params) {
  if (typeof window.gtag !== "function") return;
  try { window.gtag("event", name, params || {}); } catch (e) {}
}
window.track = track;
track("deck_view", { deck: dk() });
let currentUser = null;
let poolACache = null;

function dk() { return window.currentDeckKey || 'tracking'; }
function cardsCol() { return collection(db, 'decks', dk(), 'cards'); }
function cardDoc(id) { return doc(db, 'decks', dk(), 'cards', String(id)); }
function poolDoc() { return doc(db, 'users', currentUser.uid, 'pools', dk()); }
function attemptsCol() { return collection(db, 'users', currentUser.uid, 'decks', dk(), 'attempts'); }
function attemptDoc(id) { return doc(db, 'users', currentUser.uid, 'decks', dk(), 'attempts', String(id)); }
function ratingDoc(id) { return doc(db, 'users', currentUser.uid, 'decks', dk(), 'ratings', String(id)); }
function speciesCol() { return collection(db, 'users', currentUser.uid, 'decks', dk(), 'species'); }
function speciesDoc(taxonId) { return doc(db, 'users', currentUser.uid, 'decks', dk(), 'species', String(taxonId)); }

async function loadPoolA() {
  const snap = await getDocs(cardsCol());
  poolACache = [];
  snap.forEach(d => poolACache.push({ id: Number(d.id), ...d.data() }));
  console.log('Pool A loaded:', poolACache.length, 'cards');
}

async function loadSpeciesStats() {
  if (!currentUser) return;
  window.speciesStatsCache = new Map();
  const snap = await getDocs(speciesCol());
  snap.forEach(d => window.speciesStatsCache.set(d.id, d.data()));
}

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  if (user) {
    if (typeof window.gtag === "function") window.gtag("set", { user_id: user.uid });
    loadPoolA(); loadSpeciesStats();
  }
});
signInAnonymously(auth);

window.reloadDeckData = async function() {
  poolACache = null;
  window.speciesStatsCache = new Map();
  if (currentUser) { await loadPoolA(); await loadSpeciesStats(); }
};

function _applyAttemptUI(result) {
  const gotBtn = document.getElementById('gotItBtn');
  const missedBtn = document.getElementById('missedItBtn');
  gotBtn.disabled = true;
  missedBtn.disabled = true;
  gotBtn.classList.remove('active');
  missedBtn.classList.remove('active');
  if (result === 'correct') gotBtn.classList.add('active');
  else if (result === 'incorrect') missedBtn.classList.add('active');
}

// Returns Pool A cards that belong to a specific taxon, optionally filtered by place.
window.getSpeciesPoolA = function(taxonId, activePlaceIds, seenSet) {
  if (!poolACache) return [];
  return poolACache.filter(function(card) {
    if (seenSet && seenSet.has(card.id)) return false;
    var ancestors = card.ancestorIds || [];
    if (!ancestors.includes(taxonId) && card.taxonId !== taxonId) return false;
    if (activePlaceIds && activePlaceIds.length > 0) {
      var places = card.placeIds || [];
      if (!activePlaceIds.some(function(id){ return places.includes(id); })) return false;
    }
    return true;
  });
};

// Returns Pool A candidates matching the active filters, excluding already-seen cards.
window.getFilteredPoolA = function(taxonIdChoices, regionIdChoices, seenSet) {
  if (!poolACache) return [];
  const activeTaxonIds = taxonIdChoices.map(v => parseInt(v.split('=')[1]));
  const activePlaceIds = regionIdChoices.map(v => parseInt(v.split('=')[1]));
  return poolACache.filter(card => {
    if (seenSet && seenSet.has(card.id)) return false;
    if (activeTaxonIds.length > 0) {
      const ancestors = card.ancestorIds || [];
      if (!activeTaxonIds.some(id => ancestors.includes(id))) return false;
    }
    if (activePlaceIds.length > 0) {
      const places = card.placeIds || [];
      if (!activePlaceIds.some(id => places.includes(id))) return false;
    }
    return true;
  });
};

// Hydrates the self-report button state when navigating to a card (session only).
window.loadAttempt = function(cardId) {
  if (window.reportResults && window.reportResults[Number(cardId)]) {
    _applyAttemptUI(window.reportResults[Number(cardId)]);
  }
};

// Records a self-report: updates ELO (first time only) and per-species rolling accuracy.
window.submitReport = async function(result) {
  const cardId = window.currentCardId;
  const entry = window.currentEntry;
  if (!cardId) return;

  const gotBtn = document.getElementById('gotItBtn');
  const missedBtn = document.getElementById('missedItBtn');

  // Optimistic UI
  gotBtn.disabled = true;
  missedBtn.disabled = true;
  gotBtn.classList.remove('active');
  missedBtn.classList.remove('active');
  if (result === 'correct') gotBtn.classList.add('active');
  else missedBtn.classList.add('active');

  track("self_report", { deck: dk(), result: result, taxon_id: (entry && entry.taxon ? entry.taxon.id : null), time_on_card_ms: window._cardShownAt ? Date.now() - window._cardShownAt : null });

  // Update session cache so the grid and button state restore correctly on navigation
  if (!window.reportResults) window.reportResults = {};
  window.reportResults[Number(cardId)] = result;
  if (typeof window.renderSessionGrid === 'function') window.renderSessionGrid();

  // Auto-advance; Firestore write continues in the background
  setTimeout(function(){ if (window.currentCardId === cardId) nextEntry(1); }, 0);

  if (!currentUser) return;

  const taxonId = entry && entry.taxon ? entry.taxon.id : null;
  const ancestorIds = entry && entry.taxon && entry.taxon.ancestor_ids ? entry.taxon.ancestor_ids : [];
  const placeIds = entry && entry.place_ids ? entry.place_ids : [];

  const userRef    = poolDoc();
  const cardRef    = cardDoc(cardId);
  const attemptRef = attemptDoc(cardId);
  const speciesRef = taxonId ? speciesDoc(taxonId) : null;

  await runTransaction(db, async (txn) => {
    const reads = [txn.get(userRef), txn.get(cardRef), txn.get(attemptRef)];
    if (speciesRef) reads.push(txn.get(speciesRef));
    const [userSnap, cardSnap, attemptSnap, speciesSnap] = await Promise.all(reads);

    const S = result === 'correct' ? 1 : 0;
    const userElo     = userSnap.exists()    ? (userSnap.data().elo    || 1500) : 1500;
    const cardElo     = cardSnap.exists()    ? (cardSnap.data().elo    || 1500) : 1500;
    const eloScored   = attemptSnap.exists() ? (attemptSnap.data().eloScored || false) : false;
    const reviewCount = attemptSnap.exists() ? (attemptSnap.data().reviewCount || 0) : 0;
    const firstResult = attemptSnap.exists() ? (attemptSnap.data().firstResult || result) : result;
    const history     = attemptSnap.exists() ? (attemptSnap.data().history || []) : [];

    // ELO — applied once per (user, card)
    var newUserElo = userElo, newCardElo = cardElo;
    if (!eloScored) {
      const K = 24;
      const E = 1 / (1 + Math.pow(10, (cardElo - userElo) / 400));
      newUserElo = Math.round(userElo + K * (S - E));
      newCardElo = Math.round(cardElo - K * (S - E));
    }

    txn.set(userRef, { elo: newUserElo, eloGames: increment(eloScored ? 0 : 1) }, { merge: true });

    txn.set(cardRef, {
      elo: newCardElo, taxonId, ancestorIds, placeIds,
      correctCount:   increment(result === 'correct'   ? 1 : 0),
      incorrectCount: increment(result === 'incorrect' ? 1 : 0)
    }, { merge: true });

    txn.set(attemptRef, {
      eloScored: true,
      firstResult,
      lastResult: result,
      reviewCount: reviewCount + 1,
      ancestorIds, placeIds,
      history: [...history, { result, ts: Date.now() }],
      updatedAt: serverTimestamp()
    }, { merge: true });

    // Per-species rolling accuracy (last 10)
    if (speciesRef) {
      const existing = speciesSnap && speciesSnap.exists() ? (speciesSnap.data().recent || []) : [];
      const newRecent = [...existing, result === 'correct' ? 'c' : 'i'].slice(-10);
      txn.set(speciesRef, { recent: newRecent, updatedAt: serverTimestamp() }, { merge: true });
    }
  });

  // Update in-memory species cache so drawTargetSpecies sees the new result immediately
  if (taxonId && window.speciesStatsCache) {
    const existing = (window.speciesStatsCache.get(String(taxonId)) || {}).recent || [];
    window.speciesStatsCache.set(String(taxonId), {
      recent: [...existing, result === 'correct' ? 'c' : 'i'].slice(-10)
    });
  }
};

window.loadRating = async function(cardId) {
  const upBtn = document.getElementById('thumbsUp');
  const downBtn = document.getElementById('thumbsDown');
  upBtn.className = 'rating-btn';
  downBtn.className = 'rating-btn';
  upBtn.disabled = false;
  downBtn.disabled = false;
  if (!currentUser) return;
  const snap = await getDoc(ratingDoc(cardId));
  if (snap.exists()) {
    const val = snap.data().rating;
    if (val === 1) upBtn.classList.add('active-up');
    else downBtn.classList.add('active-down');
    upBtn.disabled = true;
    downBtn.disabled = true;
  }
};

window.submitRating = async function(value) {
  const cardId = window.currentCardId;
  if (!currentUser || !cardId) return;
  const upBtn = document.getElementById('thumbsUp');
  const downBtn = document.getElementById('thumbsDown');
  upBtn.disabled = true;
  downBtn.disabled = true;
  if (value === 1) upBtn.classList.add('active-up');
  else downBtn.classList.add('active-down');
  const ratingRef = ratingDoc(cardId);
  if ((await getDoc(ratingRef)).exists()) return;
  track("card_rating", { deck: dk(), rating: value === 1 ? "up" : "down" });
  await setDoc(ratingRef, { rating: value, timestamp: serverTimestamp() });
  const entry = window.currentEntry;
  const taxonId = entry && entry.taxon ? entry.taxon.id : null;
  const ancestorIds = entry && entry.taxon && entry.taxon.ancestor_ids ? entry.taxon.ancestor_ids : [];
  const placeIds = entry && entry.place_ids ? entry.place_ids : [];
  await setDoc(cardDoc(cardId), {
    thumbsUp: increment(value === 1 ? 1 : 0),
    thumbsDown: increment(value === -1 ? 1 : 0),
    taxonId, ancestorIds, placeIds
  }, { merge: true });
  if (poolACache) {
    const existing = poolACache.find(c => c.id === Number(cardId));
    if (existing) {
      if (value === 1) existing.thumbsUp = (existing.thumbsUp || 0) + 1;
      else existing.thumbsDown = (existing.thumbsDown || 0) + 1;
    } else {
      poolACache.push({
        id: Number(cardId), taxonId, ancestorIds, placeIds,
        thumbsUp: value === 1 ? 1 : 0,
        thumbsDown: value === -1 ? 1 : 0
      });
    }
  }
};
