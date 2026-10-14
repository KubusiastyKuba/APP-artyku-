const JOURNALS = [
  "Spine",
  "The Spine Journal",
  "European Spine Journal",
  "Global Spine Journal",
  "Journal of Neurosurgery: Spine",
  "Neurosurgical Focus",
  "Operative Neurosurgery",
  "Spine Deformity",
  "Scoliosis and Spinal Disorders",
  "The Journal of Bone and Joint Surgery",
  "Clinical Orthopaedics and Related Research"
];

const PAGE_SIZE = 20;
const IMPACT_THRESHOLD = 20;

const state = { articles: [], filtered: [], page: 1, activeList: "toRead", loading: false };

const store = {
  read: new Set(JSON.parse(localStorage.getItem("ssw_read") || "[]")),
  favorites: new Set(JSON.parse(localStorage.getItem("ssw_favorites") || "[]")),
  toRead: new Set(JSON.parse(localStorage.getItem("ssw_toRead") || "[]"))
};

const $ = id => document.getElementById(id);

function saveStore() {
  localStorage.setItem("ssw_read", JSON.stringify([...store.read]));
  localStorage.setItem("ssw_favorites", JSON.stringify([...store.favorites]));
  localStorage.setItem("ssw_toRead", JSON.stringify([...store.toRead]));
  updateStats();
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function cleanAbstract(text) {
  if (!text) return "";
  return String(text)
    .replace(/<br\s*\/?>/gi, "\n\n")
    .replace(/<\/(h4|h3|h2|p|div|li)>/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function journalQuery(journals) {
  return journals.map(j => `"${j}"[Journal]`).join(" OR ");
}

function spineQuery() {
  return `(
    "spine surgery"[Title/Abstract] OR "spinal surgery"[Title/Abstract] OR
    "lumbar spine"[Title/Abstract] OR "cervical spine"[Title/Abstract] OR
    "thoracic spine"[Title/Abstract] OR scoliosis[Title/Abstract] OR
    kyphosis[Title/Abstract] OR spondylolisthesis[Title/Abstract] OR
    "spinal stenosis"[Title/Abstract] OR "disc herniation"[Title/Abstract] OR
    "spinal fusion"[Title/Abstract] OR "spinal deformity"[Title/Abstract] OR
    "spine"[Title]
  )`;
}

function europePmcDate() {
  const from = $("dateFrom").value;
  const to = $("dateTo").value;
  if (!from && !to) return "";
  const start = from ? from.replaceAll("-", "/") : "1900/01/01";
  const end = to ? to.replaceAll("-", "/") : "2100/12/31";
  return ` AND FIRST_PDATE:[${start} TO ${end}]`;
}

function pubMedDate() {
  const from = $("dateFrom").value;
  const to = $("dateTo").value;
  if (!from && !to) return "";
  const start = from ? from.replaceAll("-", "/") : "1900/01/01";
  const end = to ? to.replaceAll("-", "/") : "2100/12/31";
  return ` AND ("${start}"[Date - Publication] : "${end}"[Date - Publication])`;
}

function setStatus(message, isError = false) {
  const status = $("status");
  status.textContent = message;
  status.classList.toggle("error", isError);
}

function normalizeEuropePmc(item) {
  const pmid = String(item.pmid || "");
  const doi = item.doi || item.articleids?.find(x => x.idtype === "doi")?.value || "";
  const title = item.title || "Brak tytułu";
  const journal = item.journal?.title || item.journalInfo?.journal?.title || item.source || "Nieznane czasopismo";
  const date = item.firstPublicationDate || item.firstIndexDate || "";
  const abstract = cleanAbstract(item.abstractText);
  const citations = Number(item.citedByCount || 0);
  const isOpenAccess = item.isOpenAccess === "Y" || item.inPMC === "Y" || item.inEPMC === "Y";

  return {
    id: pmid || doi || title,
    pmid,
    doi,
    title,
    journal,
    date,
    abstract,
    citations,
    isOpenAccess: Boolean(isOpenAccess),
    source: "Europe PMC"
  };
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Błąd połączenia (${response.status}).`);
  }
  return response.json();
}

async function fetchEuropePMC(journals) {
  const query = `(${journalQuery(journals)}) AND (${spineQuery()})${europePmcDate()}`;
  const url = new URL("https://www.ebi.ac.uk/europepmc/webservices/rest/search");
  url.searchParams.set("query", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("resultType", "core");
  url.searchParams.set("pageSize", "200");
  url.searchParams.set("sort", "CITED desc");

  const data = await fetchJson(url);
  return (data.resultList?.result || []).map(normalizeEuropePmc);
}

async function fetchPubMedIds(journals) {
  const query = `(${journalQuery(journals)}) AND (${spineQuery()})${pubMedDate()} NOT preprint[pt]`;
  const url = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi");
  url.searchParams.set("db", "pubmed");
  url.searchParams.set("term", query);
  url.searchParams.set("retmode", "json");
  url.searchParams.set("retmax", "200");

  try {
    const data = await fetchJson(url);
    return data.esearchresult?.idlist || [];
  } catch (error) {
    console.warn("PubMed ESearch niedostępny w tej przeglądarce:", error);
    return [];
  }
}

async function fetchPubMedSummaries(pmids) {
  if (!pmids.length) return [];

  const results = [];

  for (let i = 0; i < pmids.length; i += 100) {
    const chunk = pmids.slice(i, i + 100);
    const url = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi");
    url.searchParams.set("db", "pubmed");
    url.searchParams.set("id", chunk.join(","));
    url.searchParams.set("retmode", "json");

    try {
      const data = await fetchJson(url);
      const result = data.result || {};

      for (const pmid of chunk) {
        if (!result[pmid]) continue;
        const item = result[pmid];
        results.push({
          id: pmid,
          pmid,
          doi: item.articleids?.find(x => x.idtype === "doi")?.value || "",
          title: item.title || "Brak tytułu",
          journal: item.fulljournalname || item.source || "Nieznane czasopismo",
          date: item.pubdate || "",
          abstract: "",
          citations: 0,
          isOpenAccess: false,
          source: "PubMed"
        });
      }
    } catch (error) {
      console.warn("PubMed ESummary niedostępny:", error);
    }
  }

  return results;
}

function mergeArticles(europePmcArticles, pubMedArticles) {
  const map = new Map();

  for (const article of europePmcArticles) {
    map.set(article.pmid || article.doi || article.title, article);
  }

  for (const article of pubMedArticles) {
    const key = article.pmid || article.doi || article.title;
    const existing = map.get(key);

    if (!existing) {
      map.set(key, article);
    } else {
      existing.source = "Europe PMC + PubMed";
    }
  }

  return [...map.values()];
}

function getSelectedJournals() {
  return [...document.querySelectorAll(".journal-item input:checked")].map(input => input.value);
}

function applyFilters() {
  const titleQuery = $("titleSearch").value.trim().toLowerCase();
  const selectedJournals = getSelectedJournals();
  const oaOnly = $("oaOnly").checked;
  const hideRead = $("hideRead").checked;
  const favoritesOnly = $("favoritesOnly").checked;
  const sortBy = $("sortBy").value;

  state.filtered = state.articles.filter(article => {
    if (selectedJournals.length && !selectedJournals.includes(article.journal)) return false;
    if (titleQuery && !article.title.toLowerCase().includes(titleQuery)) return false;
    if (oaOnly && !article.isOpenAccess) return false;
    if (hideRead && store.read.has(article.id)) return false;
    if (favoritesOnly && !store.favorites.has(article.id)) return false;
    return true;
  });

  if (sortBy === "citations") {
    state.filtered.sort((a, b) => b.citations - a.citations);
  } else if (sortBy === "date") {
    state.filtered.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  } else {
    state.filtered.sort((a, b) => a.journal.localeCompare(b.journal));
  }

  state.page = 1;
  renderResults();
  updateStats();
}

function toggleSet(set, id) {
  if (set.has(id)) set.delete(id);
  else set.add(id);
}

function articleCard(article) {
  const card = document.createElement("article");
  card.className = "article";

  const isFavorite = store.favorites.has(article.id);
  const isRead = store.read.has(article.id);
  const isToRead = store.toRead.has(article.id);

  const pubmedUrl = article.pmid
    ? `https://pubmed.ncbi.nlm.nih.gov/${article.pmid}/`
    : `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(article.title)}`;

  const hasAbstract = Boolean(article.abstract);

  card.innerHTML = `
    <h3 class="article-title">${esc(article.title)}</h3>

    <div class="article-meta">
      <span>${esc(article.journal)}</span>
      <span>${esc(article.date || "Brak daty")}</span>
      <span>Cytowania: ${article.citations}</span>
      <span>Źródło: ${esc(article.source)}</span>
    </div>

    <div class="badges">
      ${article.isOpenAccess ? '<span class="badge oa">Open Access</span>' : ""}
      ${article.citations >= IMPACT_THRESHOLD ? '<span class="badge impact">Wysoki wpływ</span>' : ""}
    </div>

    <div class="abstract">${hasAbstract ? esc(article.abstract) : "Brak abstraktu w metadanych Europe PMC / PubMed."}</div>

    <div class="article-actions">
      <button class="ghost-btn abstract-btn" type="button" ${hasAbstract ? "" : "disabled"}>
        ${hasAbstract ? "Pokaż abstrakt" : "Brak abstraktu"}
      </button>
      <a href="${pubmedUrl}" target="_blank" rel="noopener">Otwórz w PubMed</a>
      <button class="ghost-btn fav-btn ${isFavorite ? "action-active" : ""}" type="button">
        ${isFavorite ? "★ Ulubione" : "☆ Ulubione"}
      </button>
      <button class="ghost-btn toread-btn ${isToRead ? "action-active" : ""}" type="button">
        ${isToRead ? "✓ Do przeczytania" : "+ Do przeczytania"}
      </button>
      <button class="ghost-btn read-btn ${isRead ? "action-active" : ""}" type="button">
        ${isRead ? "✓ Przeczytane" : "Oznacz jako przeczytane"}
      </button>
    </div>
  `;

  const abstract = card.querySelector(".abstract");
  const abstractButton = card.querySelector(".abstract-btn");

  if (hasAbstract) {
    abstractButton.addEventListener("click", () => {
      abstract.classList.toggle("open");
      abstractButton.textContent = abstract.classList.contains("open")
        ? "Ukryj abstrakt"
        : "Pokaż abstrakt";
    });
  }

  card.querySelector(".fav-btn").addEventListener("click", event => {
    toggleSet(store.favorites, article.id);
    event.currentTarget.classList.toggle("action-active");
    event.currentTarget.textContent = store.favorites.has(article.id) ? "★ Ulubione" : "☆ Ulubione";
    saveStore();
    applyFilters();
  });

  card.querySelector(".toread-btn").addEventListener("click", event => {
    toggleSet(store.toRead, article.id);
    event.currentTarget.classList.toggle("action-active");
    event.currentTarget.textContent = store.toRead.has(article.id) ? "✓ Do przeczytania" : "+ Do przeczytania";
    saveStore();
    updateStats();
  });

  card.querySelector(".read-btn").addEventListener("click", event => {
    toggleSet(store.read, article.id);
    event.currentTarget.classList.toggle("action-active");
    event.currentTarget.textContent = store.read.has(article.id) ? "✓ Przeczytane" : "Oznacz jako przeczytane";
    saveStore();
    applyFilters();
  });

  return card;
}

function renderResults() {
  const container = $("results");
  container.innerHTML = "";

  const totalPages = Math.max(1, Math.ceil(state.filtered.length / PAGE_SIZE));
  state.page = Math.min(state.page, totalPages);

  const start = (state.page - 1) * PAGE_SIZE;
  const pageArticles = state.filtered.slice(start, start + PAGE_SIZE);

  $("resultInfo").textContent = `${state.filtered.length} artykułów`;
  $("pageInfo").textContent = `Strona ${state.page} z ${totalPages}`;
  $("prevPage").disabled = state.page <= 1;
  $("nextPage").disabled = state.page >= totalPages;

  if (!pageArticles.length) {
    container.innerHTML = '<div class="empty">Brak artykułów dla wybranych filtrów. Spróbuj poszerzyć zakres dat lub wybrać więcej czasopism.</div>';
    return;
  }

  pageArticles.forEach(article => container.appendChild(articleCard(article)));
}

function renderSavedList() {
  const container = $("savedList");
  container.innerHTML = "";

  const ids =
    state.activeList === "toRead" ? store.toRead :
    state.activeList === "favorites" ? store.favorites :
    store.read;

  if (!ids.size) {
    container.innerHTML = '<div class="empty">Lista jest pusta.</div>';
    return;
  }

  const articles = state.articles.filter(article => ids.has(article.id));

  if (!articles.length) {
    container.innerHTML = '<div class="empty">Oznaczone artykuły pojawią się tutaj po pobraniu wyników.</div>';
    return;
  }

  articles.forEach(article => {
    const item = document.createElement("div");
    item.className = "saved-item";

    const pubmedUrl = article.pmid
      ? `https://pubmed.ncbi.nlm.nih.gov/${article.pmid}/`
      : `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(article.title)}`;

    item.innerHTML = `
      <a href="${pubmedUrl}" target="_blank" rel="noopener">${esc(article.title)}</a>
      <div class="muted">${esc(article.journal)} • ${esc(article.date || "")}</div>
    `;

    container.appendChild(item);
  });
}

function updateStats() {
  $("statTotal").textContent = state.articles.length;
  $("statOA").textContent = state.articles.filter(a => a.isOpenAccess).length;
  $("statToRead").textContent = store.toRead.size;
  $("statRead").textContent = store.read.size;
  $("statFavorites").textContent = store.favorites.size;
}

function renderJournalList() {
  const container = $("journalList");
  container.innerHTML = "";

  JOURNALS.forEach(journal => {
    const label = document.createElement("label");
    label.className = "journal-item";
    label.innerHTML = `
      <input type="checkbox" value="${esc(journal)}" checked />
      <span>${esc(journal)}</span>
    `;
    container.appendChild(label);
  });
}

async function loadArticles() {
  if (state.loading) return;

  const journals = getSelectedJournals();
  if (!journals.length) {
    setStatus("Wybierz co najmniej jedno czasopismo.", true);
    return;
  }

  state.loading = true;
  $("loadBtn").disabled = true;
  setStatus("Pobieram artykuły z Europe PMC i PubMed…");

  try {
    const europePmcArticles = await fetchEuropePMC(journals);
    const pubMedIds = await fetchPubMedIds(journals);
    const pubMedArticles = await fetchPubMedSummaries(pubMedIds);

    state.articles = mergeArticles(europePmcArticles, pubMedArticles);

    if (!state.articles.length) {
      setStatus("Nie znaleziono artykułów. Poszerz zakres dat lub sprawdź połączenie z internetem.");
    } else {
      setStatus(`Pobrano ${state.articles.length} unikalnych artykułów.`);
    }

    applyFilters();
  } catch (error) {
    console.error(error);
    setStatus(`Nie udało się pobrać artykułów: ${error.message}`, true);
  } finally {
    state.loading = false;
    $("loadBtn").disabled = false;
  }
}

function init() {
  const today = new Date();
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 7);

  $("dateFrom").value = weekAgo.toISOString().slice(0, 10);
  $("dateTo").value = today.toISOString().slice(0, 10);

  renderJournalList();
  updateStats();
  renderSavedList();

  $("loadBtn").addEventListener("click", loadArticles);

  ["titleSearch", "sortBy", "oaOnly", "hideRead", "favoritesOnly"].forEach(id => {
    $(id).addEventListener("input", applyFilters);
    $(id).addEventListener("change", applyFilters);
  });

  $("prevPage").addEventListener("click", () => {
    if (state.page > 1) {
      state.page--;
      renderResults();
    }
  });

  $("nextPage").addEventListener("click", () => {
    const totalPages = Math.max(1, Math.ceil(state.filtered.length / PAGE_SIZE));
    if (state.page < totalPages) {
      state.page++;
      renderResults();
    }
  });

  $("selectAllJournals").addEventListener("click", () => {
    document.querySelectorAll(".journal-item input").forEach(input => input.checked = true);
  });

  $("clearJournals").addEventListener("click", () => {
    document.querySelectorAll(".journal-item input").forEach(input => input.checked = false);
  });

  document.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(item => item.classList.remove("active"));
      tab.classList.add("active");
      state.activeList = tab.dataset.list;
      renderSavedList();
    });
  });

  $("themeToggle").addEventListener("click", () => {
    document.body.classList.toggle("dark");
    localStorage.setItem("ssw_theme", document.body.classList.contains("dark") ? "dark" : "light");
  });

  if (localStorage.getItem("ssw_theme") === "dark") {
    document.body.classList.add("dark");
  }
}

init();
