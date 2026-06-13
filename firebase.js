import { initializeApp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import { getFirestore, doc, setDoc, getDocs, collection, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

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

function dk() { return window.currentDeckKey || 'tracking'; }
function speciesCol() { return collection(db, 'users', currentUser.uid, 'decks', dk(), 'species'); }
function speciesDoc(taxonId) { return doc(db, 'users', currentUser.uid, 'decks', dk(), 'species', String(taxonId)); }

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
		loadSpeciesStats();
	}
});
signInAnonymously(auth);

// Records a self-report: updates per-species rolling accuracy.
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

	const taxonId = entry && entry.taxon ? entry.taxon.id : null;

	// Update in-memory species cache so drawTargetSpecies sees the new result immediately
	if (taxonId && window.speciesStatsCache) {
		const existing = (window.speciesStatsCache.get(String(taxonId)) || {}).recent || [];
		window.speciesStatsCache.set(String(taxonId), {
			recent: [...existing, result === 'correct' ? 'c' : 'i'].slice(-10)
		});
	}

	if (!currentUser || !taxonId) return;

	const existing = (window.speciesStatsCache.get(String(taxonId)) || {}).recent || [];
	await setDoc(speciesDoc(taxonId), { recent: existing, updatedAt: serverTimestamp() }, { merge: true });
};
