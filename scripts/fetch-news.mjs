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

// Regex safety net — used when Groq is unavailable or rate-limited for a
// given batch, so items never just silently disappear the way they did in
// the first real run (483 fetched -> only 196 survived categorization,
// because failed batches had nowhere to fall back to).
const KW = {
  geopolitics: {
    include: /украин|ukraine|зсу|всу|обстрел|наступлен|фронт|донецк|луганск|харьков|запорожье|херсон|донбасс|бахмут|zelenskyy|зеленськ|ceasefire|перемир|иран|iran|израил|israel|газа|gaza|хамас|хезболл|хуситы|houthi|китай|china|сша|США|\busa\b|трамп|trump|байден|biden|нато|nato|ООН|\bun\b|g7|g20|макрон|macron|шольц|scholz|мид\b|госдеп|дипломат|посольств|саммит|summit|договор|treaty|санкц|военн.*операц|спецоперац|северн.*коре|north korea|тайван|taiwan|сирия|syria|йемен|yemen|талиб|taliban|пакистан|pakistan|ракетн.*удар|авиаудар|бомбардир|беженц|переговоры.*мир|мирн.*переговоры/i,
    exclude: /курс.*рубл|рубль.*курс|биржа открыл|инфляц.*%|ВВП.*вырос|gdp.*growth|\bipo\b|акци.*упал|прибыл.*компани|chatgpt|нейросет|смартфон.*выпуск|квартальн.*отчет|выручк.*млрд/i,
  },
  finance: {
    include: /рубль|доллар|евро\b|dollar|euro\b|биржа|инфляц|ВВП|gdp|цент.*банк|ЦБ\b|фрс\b|\bfed\b|акци|stock|нефть|brent|\bwti\b|газ.*цен|цен.*газ|рынок|market|банк.*отчет|инвест|крипт|crypto|биткоин|bitcoin|\bbtc\b|ethereum|\beth\b|defi|nft\b|binance|coinbase|solana|halving|staking|майнинг|ключев.*ставк|процент.*ставк|облигац|пошлин|tariff|сделк.*млрд|слияни|поглощени|\bipo\b|мвф|imf|бюджет.*дефицит|форекс|фьючерс|прибыл.*млрд|выручк|финанс.*отчет|квартальн.*результ/i,
    exclude: /военн.*операц|ракетн.*удар|фронт|обстрел.*жертв|авиаудар|переговоры.*мир/i,
  },
  tech: {
    include: /искусств.*интеллект|нейросет|chatgpt|openai|anthropic|deepseek|gemini|llm|\bgpt\b|\bии\b|\bai\b|кибератак|хакер|утечка данных|data breach|кибербезопасност|квантов|tesla|spacex|starlink|nvidia|intel|amd|apple.*выпуст|microsoft|google.*продукт|meta\b.*функц|amazon.*технолог|alibaba|huawei|samsung.*модел|робот|беспилотн.*аппарат|стартап|startup|венчур|биотех|biotech|полупроводник|semiconductor|смартфон.*выпуск|электромобил|электрокар|\b5g\b|\b6g\b/i,
    exclude: /украин|фронт|обстрел|военн.*операц/i,
  },
  lifestyle: { include: /.*/, exclude: /^$/ },
};

function categorizeFallback(title, desc) {
  const t = (title + " " + (desc||"")).toLowerCase();
  if (KW.geopolitics.include.test(t) && !KW.geopolitics.exclude.test(t)) return "geopolitics";
  if (KW.finance.include.test(t)     && !KW.finance.exclude.test(t))     return "finance";
  if (KW.tech.include.test(t)        && !KW.tech.exclude.test(t))        return "tech";
  return "lifestyle";
}

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
async function groqFetch(body, timeout = 20000, patient = false) {
  // "patient" mode (long backoff, more attempts) is ONLY for calls with no
  // fallback and low volume (the 5 daily digests) — worth waiting for.
  // Default (fast-fail) mode is for high-volume calls (100+ translations,
  // dozens of categorize batches) that have a cheap fallback (Google
  // Translate / regex) — waiting 8-24s per retry there was stalling the
  // whole run for many minutes instead of just falling back quickly.
  const maxAttempts = patient ? 4 : 2;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + GROQ_KEY },
        body: JSON.stringify(body),
      }, timeout);
      if (res.status === 429) {
        if (attempt < maxAttempts - 1) {
          const delay = patient ? 8000 * (attempt + 1) : 4000;
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        return null;
      }
      if (!res.ok) return null;
      return await res.json();
    } catch { if (attempt < maxAttempts - 1) { await new Promise(r => setTimeout(r, patient ? 3000 : 2000)); continue; } return null; }
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

  // Groq's free tier is 30 requests/minute. Firing all batches at once (the
  // first real run had 16 of them) blows straight through that limit —
  // most get rate-limited and, with nothing to fall back to, those items
  // just vanished (483 fetched -> only 196 survived). Now: process a few
  // batches at a time, with a pause between waves, and anything that still
  // fails goes through the same regex classifier the client used to use —
  // so a Groq hiccup degrades quality for that batch, never drops it.
  const WAVE_SIZE = 4;
  for (let w = 0; w < batches.length; w += WAVE_SIZE) {
    const wave = batches.slice(w, w + WAVE_SIZE);
    await Promise.all(wave.map(async ({ offset, items }) => {
      const result = await classifyBatchGroq(items);
      if (result) {
        result.forEach(r => {
          if (typeof r.i === "number" && r.cat) { catMap[offset+r.i] = r.cat; entMap[offset+r.i] = r.ent || ""; }
        });
      }
      // Fill any gaps (missing indices, or Groq unavailable) with regex fallback
      items.forEach((it, bi) => {
        const idx = offset + bi;
        if (!catMap[idx]) catMap[idx] = categorizeFallback(it.title, it.description);
      });
    }));
    if (w + WAVE_SIZE < batches.length) await new Promise(r => setTimeout(r, 8000));
  }

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

async function groqComplete(prompt, maxTokens = 900) {
  const d = await groqFetch({
    model: "openai/gpt-oss-120b", max_tokens: maxTokens, reasoning_effort: "low",
    messages: [{ role: "user", content: prompt }],
  }, 25000, true);
  return d?.choices?.[0]?.message?.content?.trim() || null;
}

function detectMood(text) {
  const tl = text.toLowerCase();
  if (/напряжённ|напряженн/.test(tl)) return { bc:"tense",   bt:"Напряжённая" };
  if (/тревожн/.test(tl))             return { bc:"alarm",   bt:"Тревожная" };
  if (/позитивн/.test(tl))            return { bc:"calm",    bt:"Позитивная" };
  if (/смешанн/.test(tl))             return { bc:"mixed",   bt:"Смешанная" };
  return { bc:"neutral", bt:"Нейтральная" };
}

// Server-side daily digest — was a per-reader Groq call before (using each
// visitor's own key); now computed once here and shipped inside news.json,
// so it's instant for everyone and doesn't depend on the reader having a key.
async function generateDigests(cards) {
  const yesterday = new Date(Date.now() - 86400000);
  const yStart = new Date(yesterday); yStart.setHours(0,0,0,0);
  const yEnd   = new Date(yesterday); yEnd.setHours(23,59,59,999);
  const yCards = cards.filter(c => { const d = new Date(c.date); return d >= yStart && d <= yEnd; });
  const pool = yCards.length >= 3 ? yCards : cards.slice(0, 40);
  const dateStr = yesterday.toLocaleDateString("ru-RU", { day:"numeric", month:"long" });
  const catLabels = { geopolitics:"Геополитика", finance:"Финансы", tech:"Технологии", lifestyle:"Лайфстайл" };
  const digests = {};

  // "all" — cross-category overview
  const byCat = {};
  pool.forEach(c => { if (catLabels[c.cat]) (byCat[c.cat] = byCat[c.cat] || []).push(c); });
  const sections = Object.entries(catLabels)
    .filter(([id]) => (byCat[id]||[]).length > 0)
    .map(([id, label]) => `### ${label}\n` + (byCat[id]||[]).slice(0,6).map(c => `- ${c.title_ru||c.title}`).join("\n"))
    .join("\n\n");
  const allPrompt = `Ты редактор новостного агрегатора. Напиши общее резюме за ${dateStr} по разделам.\n\nДля каждого раздела - 1-2 предложения с ключевыми событиями. Конкретные факты, имена, цифры.\nВ конце - одно предложение с тональностью дня.\n\nОтветь ТОЛЬКО HTML:\n<p><b>Геополитика:</b> ...</p>\n<p><b>Финансы:</b> ...</p>\n<p><b>Технологии:</b> ...</p>\n<p><b>Лайфстайл:</b> ...</p>\n<p><b>Тональность дня:</b> Слово - почему</p>\n\nПропускай разделы без новостей. Максимум 180 слов. Только HTML.\n\nНовости:\n${sections}`;
  const allText = await groqComplete(allPrompt);
  if (allText) digests.all = { html: allText, ...detectMood(allText) };

  // Per-category deep-dive
  for (const [cat, label] of Object.entries(catLabels)) {
    const items = (byCat[cat] || pool.filter(c=>c.cat===cat)).slice(0, 12).map(c => `- ${c.title_ru||c.title}`).join("\n");
    if (!items) continue;
    const prompt = `Ты редактор новостного агрегатора. Напиши резюме раздела "${label}" за ${dateStr}.\n\nВыдели 2-3 самых важных события, 2-3 предложения на каждое. Конкретные факты, имена, цифры. В конце - одно предложение с общим итогом раздела.\n\nОтветь ТОЛЬКО HTML-параграфами:\n<p><b>Событие 1:</b> ...</p>\n<p><b>Событие 2:</b> ...</p>\n<p><b>Итог:</b> ...</p>\n\nМаксимум 160 слов. Только HTML.\n\nНовости раздела:\n${items}`;
    const text = await groqComplete(prompt, 700);
    if (text) digests[cat] = { html: text, ...detectMood(text) };
    await new Promise(r => setTimeout(r, 1500)); // stay well under Groq's rate limit
  }

  return digests;
}


async function main() {
  console.log(`[${new Date().toISOString()}] Fetching ${SOURCES.length} sources...`);

  const results = await Promise.all(SOURCES.map(async src => {
    let { items, errors } = await fetchSource(src);
    if (!items.length) {
      // Whole-source retry: a transient blip (momentary rate-limit, brief
      // network hiccup) shouldn't cost this source the entire 20-minute
      // cycle. One retry after a short pause catches most of these.
      await new Promise(r => setTimeout(r, 5000));
      const retry = await fetchSource(src);
      if (retry.items.length) { items = retry.items; errors = []; }
      else errors = retry.errors.length ? retry.errors : errors;
    }
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

  // Digests run BEFORE translation — only 5 Groq calls total, and they get
  // priority on the rate-limit budget while it's freshest. Translation
  // needs ~240 calls and has its own Google-fallback per item, so it can
  // absorb rate-limit pressure far better than a single missed digest call
  // (which has no fallback and used to just come back empty).
  console.log("Generating daily digests...");
  const digests = await generateDigests(merged);
  console.log(`Digests: ${Object.keys(digests).join(", ") || "none"}`);

  // Translate titles for western cards — Groq first (reliable), Google
  // fallback. Runs on the MERGED set (not just this run's fresh batch) and
  // filters on "!title_ru", so any card still missing a translation gets
  // retried every run — including ones that already scrolled out of the
  // source's live RSS feed and would otherwise never get a second attempt.
  const toTranslate = merged.filter(c => c.needsTranslation && !c.title_ru);
  const TR_CONCURRENT = 3;
  for (let i = 0; i < toTranslate.length; i += TR_CONCURRENT) {
    const batch = toTranslate.slice(i, i + TR_CONCURRENT);
    await Promise.all(batch.map(async card => {
      let t = await groqTranslate(card.title, "ru");
      if (!t) t = await gtranslate(card.title, "ru");
      if (t) card.title_ru = t;
      let s = await groqTranslate(card.description, "ru");
      if (!s) s = await gtranslate(card.description, "ru");
      if (s) card.description_ru = s;
    }));
  }
  console.log(`Translated: ${toTranslate.length} cards (${toTranslate.filter(c=>c.title_ru).length} succeeded)`);

  const output = {
    generatedAt: new Date().toISOString(),
    categories: CATEGORIES,
    digests,
    cards: merged,
  };

  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(output, null, 0));
  console.log(`Wrote ${merged.length} cards to data/news.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
