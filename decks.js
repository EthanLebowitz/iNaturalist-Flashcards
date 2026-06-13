window.MODES = {
  tracking: {
    type: "deck",
    label: "Tracks",
    slug: "/tracks/",
    query: { project_id: 962 },
    filters: { species: true, region: true },
    seo: {
      title: "Track and Sign Flashcards",
      h1: "Track and Sign Identification Flashcards",
      label: "tracks",
      labelSingular: "track and sign",
    }
  },
  skulls: {
    type: "deck",
    label: "Skulls & Bones",
    slug: "/skulls/",
    query: { project_id: 488 },
    filters: { species: false, region: true },
    seo: {
      title: "Skull & Bone Flashcards",
      h1: "Skull & Bone Identification Flashcards",
      label: "skulls and bones",
      labelSingular: "skull and bone",
    }
  },
  mushrooms: {
    type: "deck",
    label: "Mushrooms",
    slug: "/mushrooms/",
    query: { taxon_id: "50814,152032" },       // Agaricomycetes + Pezizomycetes (morels, truffles)
    filters: { species: false, region: true },
    seo: {
      title: "Mushroom Flashcards",
      h1: "Mushroom Identification Flashcards",
      label: "mushrooms",
      labelSingular: "mushroom",
    }
  },
  butterflies: {
    type: "deck",
    label: "Butterflies & Moths",
    slug: "/butterflies/",
    query: { taxon_id: 47157 },               // Lepidoptera
    filters: { species: false, region: true },
    seo: {
      title: "Butterfly & Moth Flashcards",
      h1: "Butterfly & Moth Identification Flashcards",
      label: "butterflies and moths",
      labelSingular: "butterfly and moth",
    }
  },
  bees: {
    type: "deck",
    label: "Bees",
    slug: "/bees/",
    query: { taxon_id: 630955 },              // Anthophila
    filters: { species: false, region: true },
    seo: {
      title: "Bee Flashcards",
      h1: "Bee Identification Flashcards",
      label: "bees",
      labelSingular: "bee",
    }
  },
  birds: {
    type: "deck",
    label: "Birds",
    slug: "/birds/",
    query: { taxon_id: 3 },                  // Aves
    filters: { species: false, region: true },
    seo: {
      title: "Bird Flashcards",
      h1: "Bird Identification Flashcards",
      label: "birds",
      labelSingular: "bird",
    }
  },
  feathers: {
    type: "deck",
    label: "Feathers",
    slug: "/feathers/",
    query: { project_id: 11413 },
    filters: { species: false, region: true },
    seo: {
      title: "Feather Flashcards",
      h1: "Feather Identification Flashcards",
      label: "feathers",
      labelSingular: "feather",
    }
  },
  dragonflies: {
    type: "deck",
    label: "Dragonflies & Damselflies",
    slug: "/dragonflies/",
    query: { taxon_id: 47792 },              // Odonata
    filters: { species: false, region: true },
    seo: {
      title: "Dragonfly & Damselfly Flashcards",
      h1: "Dragonfly & Damselfly Identification Flashcards",
      label: "dragonflies and damselflies",
      labelSingular: "dragonfly and damselfly",
    }
  },
  spiders: {
    type: "deck",
    label: "Spiders",
    slug: "/spiders/",
    query: { taxon_id: 47118 },              // Araneae
    filters: { species: false, region: true },
    seo: {
      title: "Spider Flashcards",
      h1: "Spider Identification Flashcards",
      label: "spiders",
      labelSingular: "spider",
    }
  },
  snakes: {
    type: "deck",
    label: "Snakes",
    slug: "/snakes/",
    query: { taxon_id: 85553 },              // Serpentes
    filters: { species: false, region: true },
    seo: {
      title: "Snake Flashcards",
      h1: "Snake Identification Flashcards",
      label: "snakes",
      labelSingular: "snake",
    }
  },
  herps: {
    type: "deck",
    label: "Reptiles & Amphibians",
    slug: "/herps/",
    query: { taxon_id: "26036,20978" },      // Reptilia + Amphibia
    filters: { species: false, region: true },
    seo: {
      title: "Reptile & Amphibian Flashcards",
      h1: "Reptile & Amphibian Identification Flashcards",
      label: "reptiles and amphibians",
      labelSingular: "reptile and amphibian",
    }
  },
  edibles: {
    type: "deck",
    label: "Wild Edible Plants",
    slug: "/edibles/",
    query: { project_id: 35019 },
    filters: { species: false, region: true },
    seo: {
      title: "Wild Edible Plant Flashcards",
      h1: "Wild Edible Plant Identification Flashcards",
      label: "wild edible plants",
      labelSingular: "wild edible plant",
    }
  }
};
window.DEFAULT_DECK = "tracking";
(function(){
  // Check __DECK__ (set by per-deck shell page) first
  if(window.__DECK__ && window.MODES[window.__DECK__] && window.MODES[window.__DECK__].type === 'deck'){
    window.currentDeckKey = window.__DECK__;
  } else {
    // Pathname slug lookup (skip '/' to avoid matching default inadvertently)
    var pathDeck = null;
    Object.keys(window.MODES).forEach(function(k){
      var slug = window.MODES[k].slug;
      if(slug && slug !== '/' && location.pathname === slug) pathDeck = k;
    });
    if(pathDeck){
      window.currentDeckKey = pathDeck;
    } else {
      // Legacy ?deck= param fallback
      var d = new URLSearchParams(location.search).get('deck');
      var valid = d && window.MODES[d] && window.MODES[d].type === 'deck';
      window.currentDeckKey = valid ? d : window.DEFAULT_DECK;
    }
  }
  document.title = window.MODES[window.currentDeckKey].seo.title;
})();
