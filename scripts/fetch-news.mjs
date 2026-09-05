// ═══════════════════════════════════════════════════════════════════════════
// MMSAWW NEWS — server-side collector
//
// Runs on a schedule via GitHub Actions (see .github/workflows/fetch-news.yml).
// Fetches all sources, dedups, categorizes, translates, and writes the result
// to data/news.json — which the static index.html simply loads and renders.
//
// Zero npm dependencies — Node 20+ has fetch() built in.
// ═══════════════════════════════════════════════════════════════════════════

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const GROQ_KEY = process.env.GROQ_API_KEY;
if (!GROQ_KEY) {
  console.error("GROQ_API_KEY is not set (add it as a GitHub Actions secret)");
  process.exit(1);
}

// ─── Config ──────────────────────────────────────────────────────────────
const OUT_PATH = new URL("../data/news.json", import.meta.url);
const STORE_MAX_H = 48;          // keep cards up to 48h old, same as before
const DEAD_SOURCES = new Set(["WSJ","FT","Bloomberg","Reuters wire","DropsCapital"]);

const CATEGORIES = [
  { id:"geopolitics", label:"Геополитика",        color:"#f87171" },
  { id:"finance",     label:"Финансы",            color:"#34d399" },
  { id:"tech",        label:"Технологии",         color:"#a78bfa" },
  { id:"lifestyle",   label:"Лайфстайл",          color:"#e879f9" },
  { id:"local",       label:"Ярославль & Москва", color:"#60a5fa" },
];

const NATIONAL_KW = /украин|ukraine|нато|nato|трамп|trump|байден|biden|иран|iran|израил|israel|газа|хамас|хуситы|ракетн.*удар|авиаудар|биткоин|bitcoin|brent/i;

const CAT_PROMPT = `Ты редактор новостного агрегатора. Для каждой новости определи:
1. Категорию — одну из четырёх:
"geopolitics"  — ВСЁ военное и политическое: Украина, Иран, Израиль, Китай, США, НАТО, ООН, санкции, войны, конфликты, дипломатия, выборы мировых лидеров.
"finance"      — экономика и деньги: биржи, курсы валют, ЦБ, ставки, нефть/газ как товар, отчёты компаний, крипто, сделки M&A, тарифы, ВВП, инфляция.
"tech"         — технологии: ИИ, ПО, железо, стартапы, кибербезопасность, космос, электромобили, биотех.
"lifestyle"    — всё остальное: спорт, культура, криминал, здоровье, общество, люди, погода, ДТП, ЖКХ.

2. Тему (ent) — 1-3 слова, главный субъект новости для группировки похожих новостей: имя человека, страна, компания, событие.
Примеры: "Иран", "ФРС", "Трамп", "Nvidia", "выборы в Молдове". Если явного субъекта нет — пустая строка.

Ответь ТОЛЬКО JSON-массивом, порядок сохрани:
[{"i":0,"cat":"finance","ent":"ФРС"},{"i":1,"cat":"lifestyle","ent":""},...]`;

// ─── Sources (identical list to the client app — see index.html SOURCES) ──
const SOURCES = [
  { urls: [
      "JINA:https://www.kommersant.ru/",
      "JINA:https://www.kommersant.ru/lenta",
      "https://www.kommersant.ru/RSS/news.xml",
      "https://news.google.com/rss/search?q=site:kommersant.ru&hl=ru&gl=RU&ceid=RU:ru",
      "JINA:https://t.me/s/kommersant",
    ], name:"Коммерсант", country:"ru" },
  { urls: [
      "JINA:https://www.forbes.ru/",
      "JINA:https://www.forbes.ru/novosti",
      "https://www.forbes.ru/rss/news",
      "https://www.forbes.ru/rss",
      "https://news.google.com/rss/search?q=Forbes+Россия&hl=ru&gl=RU&ceid=RU:ru",
      "JINA:https://t.me/s/forbesrussia",
    ], name:"Forbes RU", country:"ru" },
  { urls: [
      "JINA:https://frankmedia.ru/",
      "JINA:https://frankmedia.ru/news",
      "https://frankmedia.ru/feed",
      "https://frankrg.com/feed",
      "https://news.google.com/rss/search?q=site:frankmedia.ru&hl=ru&gl=RU&ceid=RU:ru",
    ], name:"Frank Media", country:"ru" },
  { urls: [
      "JINA:https://www.banki.ru/news/lenta/",
      "https://www.banki.ru/news/rss/",
      "https://www.banki.ru/news/latest/rss/",
      "https://news.google.com/rss/search?q=site:banki.ru+банк&hl=ru&gl=RU&ceid=RU:ru",
    ], name:"Banki.ru", country:"ru" },
  { urls: [
      "JINA:https://www.rbc.ru/short_news/",
      "https://rssexport.rbc.ru/rbcnews/news/30/full.rss",
      "https://news.google.com/rss/search?q=site:rbc.ru&hl=ru&gl=RU&ceid=RU:ru",
    ], name:"РБК", country:"ru" },
  { urls: [
      "JINA:https://www.bbc.com/news",
      "https://feeds.bbci.co.uk/news/world/rss.xml",
      "https://feeds.bbci.co.uk/news/rss.xml?edition=int",
      "https://feeds.bbci.co.uk/news/rss.xml",
      "https://feeds.bbci.co.uk/news/world/europe/rss.xml",
    ], name:"BBC", country:"west" },
  { urls: [
      "JINA:https://www.aljazeera.com/",
      "https://www.aljazeera.com/xml/rss/all.xml",
      "https://www.aljazeera.com/xml/rss/world.xml",
    ], name:"Al Jazeera", country:"west" },
  { urls: [
      "JINA:https://www.politico.com/",
      "https://news.google.com/rss/search?q=when:1d+allinurl:politico.com&hl=en&gl=US&ceid=US:en",
      "https://www.politico.eu/feed/",
    ], name:"Politico", country:"west", maxAgeDays:2 },
  { urls: [
      "JINA:https://www.reuters.com/world/",
      "https://news.google.com/rss/search?q=when:1d+allinurl:reuters.com&hl=en&gl=US&ceid=US:en",
    ], name:"Reuters", country:"west", maxAgeDays:2 },
  { urls: [
      "JINA:https://apnews.com/",
      "https://news.google.com/rss/search?q=when:1d+allinurl:apnews.com&hl=en&gl=US&ceid=US:en",
    ], name:"AP", country:"west", maxAgeDays:2 },
  { urls: [
      "JINA:https://habr.com/ru/all/",
      "https://habr.com/ru/rss/all/all/",
    ], name:"Habr", country:"ru", forceCat:"tech" },
  { urls: [
      "JINA:https://76.ru/",
      "JINA:https://76.ru/text/gorod/",
      "https://76.ru/rss/",
      "https://news.yandex.ru/yaroslavl.rss",
    ], name:"Ярославль", country:"ru", tag:"Ярославль" },
  { urls: [
      "JINA:https://www.m24.ru/",
      "JINA:https://www.mos.ru/news/",
      "https://www.m24.ru/rss.xml",
      "https://news.yandex.ru/moscow.rss",
    ], name:"Москва", country:"ru", tag:"Москва" },
];

// ─── Small helpers (ported verbatim from the client app) ──────────────────
const cdata = s => (s||"").replace(/<!\[CDATA\[|\]\]>/g,"").trim();
const strip = s => (s||"").replace(/<[^>]+>/g," ").replace(/\s{2,}/g," ").trim();

function extractDateFromUrl(url) {
  const m = url.match(/\/(20\d{2})[\/\-](\d{2})[\/\-](\d{2})(?:[\/\-]|$)/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const mi = parseInt(mo,10), di = parseInt(d,10);
  if (mi < 1 || mi > 12 || di < 1 || di > 31) return null;
  const dt = new Date(`${y}-${mo}-${d}T12:00:00`);
  if (isNaN(dt.getTime())) return null;
  if (dt.getTime() > Date.now() + 86400000) return null;
  if (dt.getTime() < Date.now() - 30*86400000) return null;
  return dt;
}

function tokenSet(s) {
  const clean = s.toLowerCase()
    .replace(/[«»""„‟]/g," ")
    .replace(/[^а-яёa-z0-9]/gi," ")
    .replace(/\b(сообщает|сообщил|заявил|рассказал|объявил|тасс|риа|reuters|bloomberg|afp)\b/g," ");
  return new Set(clean.split(/\s+/).filter(w => w.length > 3));
}
function jaccard(a, b) {
  const sa = tokenSet(a), sb = tokenSet(b);
  let inter = 0; sa.forEach(t => { if (sb.has(t)) inter++; });
  const union = sa.size + sb.size - inter;
  return union ? inter/union : 0;
}
function groupArticles(items) {
  const groups = [], used = new Set();
  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;
    const g = [items[i]]; used.add(i);
    for (let j = i+1; j < items.length; j++) {
      if (used.has(j)) continue;
      if (jaccard(items[i].title, items[j].title) >= 0.35) { g.push(items[j]); used.add(j); }
    }
    groups.push(g);
  }
  return groups;
}

// ─── Fetching: no CORS proxies needed at all — this is the whole point ────
async function fetchWithTimeout(url, opts = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchJinaOne(targetUrl, src) {
  const res = await fetchWithTimeout("https://r.jina.ai/" + targetUrl, {
    headers: { "X-Timeout": "15", "Accept": "text/plain", "X-Return-Format": "markdown" }
  }, 12000);
  if (!res.ok) throw new Error("Jina HTTP " + res.status);
  const text = await res.text();
  const items = parseJinaMarkdown(text, src, targetUrl);
  if (items.length < 3) throw new Error("Jina: too few items (" + items.length + ")");
  return items;
}

function parseJinaMarkdown(text, src, targetUrl) {
  const domain = new URL(targetUrl).hostname.replace("www.", "");
  const out = [], seen = new Set();
  const linkRe = /(?<!!)\[([^\]]{15,200})\]\((https?:\/\/[^)]+)\)/g;
  let m;
  while ((m = linkRe.exec(text)) !== null && out.length < 30) {
    const [, rawTitle, link] = m;
    try { if (!new URL(link).hostname.includes(domain)) continue; } catch { continue; }
    const title = rawTitle
      .replace(/\s+/g, " ")
      .replace(/^\d{1,2}\s*#{1,6}\s*/, "")
      .replace(/^#{1,6}\s*/, "")
      .trim();
    if (title.length < 20) continue;
    if (seen.has(link)) continue;
    if (/\/(tag|category|author|search|page|feed|rss)\b/i.test(link)) continue;
    seen.add(link);
    const date = extractDateFromUrl(link) || new Date(Date.now() - out.length * 16 * 60000);
    out.push({
      title, description: title, link, date: date.toISOString(),
      sourceName: src.name, sourceCountry: src.country, tag: src.tag || null,
    });
  }
  return out;
}

function parseRSSXML(xml, src) {
  const out = [];
  const itemRe = /<item\b[\s\S]*?<\/item>|<entry\b[\s\S]*?<\/entry>/gi;
  const items = xml.match(itemRe) || [];
  for (const block of items.slice(0, 50)) {
    const grab = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
      return m ? strip(cdata(m[1])) : "";
    };
    const title = grab("title");
    const desc  = (grab("description") || grab("content")).slice(0, 350);
    let link = grab("link");
    if (!link) {
      const m = block.match(/<link[^>]*href=["']([^"']+)["']/i);
      if (m) link = m[1];
    }
    const rawDate = grab("pubDate") || grab("published") || grab("updated");
    const date = rawDate ? new Date(rawDate) : (extractDateFromUrl(link) || new Date());
    if (!title || title.length < 5) continue;
    if (src.tag) {
      const t = (title + " " + desc).toLowerCase();
      if (NATIONAL_KW.test(t)) continue;
    }
    if (src.maxAgeDays) {
      const maxMs = src.maxAgeDays * 24 * 60 * 60 * 1000;
      if (Date.now() - date.getTime() > maxMs) continue;
    }
    out.push({
      title, description: desc, link, date: date.toISOString(),
      sourceName: src.name, sourceCountry: src.country, tag: src.tag || null,
    });
  }
  return out;
}

async function fetchSource(src) {
  const urlList = src.urls || [];
  const jinaUrls = urlList.filter(u => u.startsWith("JINA:")).map(u => u.slice(5));
  const rssUrls  = urlList.filter(u => !u.startsWith("JINA:"));

  const attempts = [];
  jinaUrls.forEach(u => attempts.push(fetchJinaOne(u, src)));
  rssUrls.forEach(u => attempts.push(
    fetchWithTimeout(u, {}, 8000).then(async res => {
      if (!res.ok) throw new Error("HTTP " + res.status);
      const xml = await res.text();
      const items = parseRSSXML(xml, src);
      if (!items.length) throw new Error("empty feed");
      return items;
    })
  ));

  if (!attempts.length) return { items: [], errors: ["no urls configured"] };
  try {
    const items = await Promise.any(attempts);
    return { items, errors: [] };
  } catch (aggErr) {
    const errors = [...new Set((aggErr.errors||[]).map(String))].slice(0,3);
    return { items: [], errors };
  }
}

// ─── Groq helpers ──────────────────────────────────────────────────────────
async function groqFetch(body, timeout = 20000) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + GROQ_KEY },
        body: JSON.stringify(body),
      }, timeout);
      if (res.status === 429) {
        if (attempt === 0) { await new Promise(r => setTimeout(r, 4000)); continue; }
        return null;
      }
      if (!res.ok) return null;
      return await res.json();
    } catch { if (attempt === 0) { await new Promise(r => setTimeout(r, 2000)); continue; } return null; }
  }
  return null;
}

async function classifyBatchGroq(items) {
  const lines = items.map((it,i) => `${i}. [${it.sourceName}] ${it.title}: ${(it.description||"").slice(0,130)}`).join("\n");
  const d = await groqFetch({
    model: "openai/gpt-oss-20b", max_tokens: 2000, reasoning_effort: "low",
    messages: [{ role:"system", content: CAT_PROMPT }, { role:"user", content: "Статьи:\n" + lines }],
  }, 20000);
  if (!d) return null;
  const text = d.choices?.[0]?.message?.content || "";
  const m = text.match(/\[[\s\S]*?\]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function categorizeWithAI(rawItems) {
  const localItems = rawItems.filter(it => it.tag);
  const nonLocal    = rawItems.filter(it => !it.tag);
  const BATCH = 30;
  const catMap = {}, entMap = {};
  const batches = [];
  for (let i = 0; i < nonLocal.length; i += BATCH) batches.push({ offset:i, items: nonLocal.slice(i,i+BATCH) });

  await Promise.all(batches.map(async ({ offset, items }) => {
    const result = await classifyBatchGroq(items);
    if (result) result.forEach(r => {
      if (typeof r.i === "number" && r.cat) { catMap[offset+r.i] = r.cat; entMap[offset+r.i] = r.ent || ""; }
    });
  }));

  const classified = nonLocal.map((it, idx) => {
    const cat = catMap[idx];
    if (!cat || cat === "local") return null;
    return { ...it, cat, entity: entMap[idx] || "" };
  }).filter(Boolean);

  const local = localItems.map(it => ({ ...it, cat: it.forceCat || "local" }));
  return [...local, ...classified];
}

async function groqTranslate(text, targetLang) {
  if (!text) return null;
  const dir = targetLang === "ru" ? "русский" : "английский";
  const d = await groqFetch({
    model: "openai/gpt-oss-20b", max_tokens: 600, reasoning_effort: "low",
    messages: [{ role:"user", content: `Переведи на ${dir} язык, только перевод без пояснений и без кавычек:\n\n${text.slice(0,1000)}` }],
  }, 12000);
  return d?.choices?.[0]?.message?.content?.trim() || null;
}

async function gtranslate(text, targetLang) {
  if (!text) return null;
  const sl = targetLang === "ru" ? "en" : "ru";
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${targetLang}&dt=t&q=${encodeURIComponent(text.slice(0,1000))}`;
    const res = await fetchWithTimeout(url, {}, 8000);
    if (!res.ok) return null;
    const data = await res.json();
    return (data[0]||[]).map(c => c[0]||"").join("") || null;
  } catch { return null; }
}

// ─── Main pipeline ─────────────────────────────────────────────────────────
async function main() {
  console.log(`[${new Date().toISOString()}] Fetching ${SOURCES.length} sources...`);

  const results = await Promise.all(SOURCES.map(async src => {
    const { items, errors } = await fetchSource(src);
    console.log(`  ${items.length ? "✓" : "✗"} ${src.name}: ${items.length} items ${errors[0] ? "("+errors[0]+")" : ""}`);
    return items;
  }));

  let allItems = results.flat();

  // Global exact-title dedup
  const seenTitles = new Map();
  allItems = allItems.filter(it => {
    const key = it.title.toLowerCase().replace(/[^а-яёa-z0-9]/gi,"").slice(0,60);
    if (seenTitles.has(key)) return false;
    seenTitles.set(key, true);
    return true;
  });
  console.log(`Total unique items: ${allItems.length}`);

  // Categorize (AI) + assign forceCat sources directly
  const withForceCat = allItems.map(it => {
    const src = SOURCES.find(s => s.name === it.sourceName);
    return src?.forceCat ? { ...it, cat: src.forceCat } : it;
  });
  const preClassified = withForceCat.filter(it => it.cat && !it.tag);
  const needsClassify  = withForceCat.filter(it => !it.cat && !it.tag);
  const localItems     = withForceCat.filter(it => it.tag);

  const classified = needsClassify.length ? await categorizeWithAI(needsClassify) : [];
  const categorized = [
    ...localItems.map(it => ({ ...it, cat: "local" })),
    ...preClassified,
    ...classified,
  ];
  console.log(`Categorized: ${categorized.length} items`);

  // Group by category, dedupe within each via Jaccard
  const byCat = {};
  categorized.forEach(it => { (byCat[it.cat] = byCat[it.cat] || []).push(it); });
  Object.values(byCat).forEach(arr => arr.sort((a,b) => new Date(b.date) - new Date(a.date)));

  const cards = [];
  for (const [cat, items] of Object.entries(byCat)) {
    const groups = groupArticles(items);
    groups.slice(0, 30).forEach(g => {
      const sources = [...new Set(g.map(x => x.sourceName))];
      cards.push({
        id: g[0].link.replace(/[^a-z0-9]/gi,"").slice(-24),
        title: g[0].title,
        description: g[0].description,
        cat, entity: g.map(x=>x.entity).find(Boolean) || "",
        date: g.reduce((max,x) => x.date > max ? x.date : max, g[0].date),
        sources, link: g[0].link,
        raw: g.map(x => ({ title:x.title, description:x.description, link:x.link, sourceName:x.sourceName })),
        needsTranslation: g.some(x => x.sourceCountry === "west"),
      });
    });
  }
  cards.sort((a,b) => new Date(b.date) - new Date(a.date));
  console.log(`Final cards: ${cards.length}`);

  // Translate titles for western cards — Groq first (reliable), Google fallback
  for (const card of cards.filter(c => c.needsTranslation)) {
    let t = await groqTranslate(card.title, "ru");
    if (!t) t = await gtranslate(card.title, "ru");
    if (t) card.title_ru = t;
    let s = await groqTranslate(card.description, "ru");
    if (!s) s = await gtranslate(card.description, "ru");
    if (s) card.description_ru = s;
  }

  // Merge with previous run's cards still inside the 48h window (so items
  // stay visible across runs even after they scroll out of "latest fetch")
  let previous = [];
  if (existsSync(OUT_PATH)) {
    try { previous = JSON.parse(await readFile(OUT_PATH, "utf-8")).cards || []; } catch {}
  }
  const cutoff = Date.now() - STORE_MAX_H * 3600000;
  const byId = new Map();
  previous
    .filter(c => new Date(c.date).getTime() > cutoff)
    .filter(c => !DEAD_SOURCES.has(c.sources?.[0]))
    .forEach(c => byId.set(c.id, c));
  cards.forEach(c => byId.set(c.id, c)); // fresh data wins on conflict
  const merged = [...byId.values()].sort((a,b) => new Date(b.date) - new Date(a.date));

  const output = {
    generatedAt: new Date().toISOString(),
    categories: CATEGORIES,
    cards: merged,
  };

  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(output, null, 0));
  console.log(`Wrote ${merged.length} cards to data/news.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
