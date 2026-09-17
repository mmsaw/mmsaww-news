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
const DEAD_SOURCES = new Set(["WSJ","FT","Bloomberg","Reuters wire","DropsCapital","Banki.ru"]);

// Hard freshness gate for items that carry a REAL date (RSS pubDate, a date in
// the URL, "2 часа назад" next to the headline). Applies to every source;
// src.maxAgeDays, where set, tightens it further. Without this, one feed that
// happens to serve an archive item pushes months-old news into the feed.
const MAX_ITEM_AGE_H = 72;

// "First seen" ledger, kept OUTSIDE news.json so the client never downloads it.
// It's what lets an item with a guessed timestamp age out for good: the card
// itself falls out of the 48h window, but the ledger still remembers when we
// first laid eyes on it, so re-scraping the same evergreen link tomorrow can't
// resurrect it as brand-new.
const SEEN_PATH  = new URL("../data/seen.json", import.meta.url);
const SEEN_KEEP_H = 24 * 14;

// Publisher names that aggregators glue onto the end of a headline
// ("Заголовок — Коммерсантъ"). The same article arrives from the publisher's
// own RSS and from the Google News mirror with two different titles and two
// completely different links, so both have to normalise to one key.
const PUBLISHER_SUFFIXES = new Set([
  "коммерсантъ","коммерсант","ъ","forbes","forbes.ru","forbes russia","рбк","ведомости","тасс","риа новости",
  "interfax","интерфакс","frank media","frank rg","habr","хабр","m24","москва 24","ярославль","76.ru",
  "reuters","associated press","ap news","bbc","bbc news","al jazeera","politico","the moscow times","lenta.ru","известия",
]);

const CATEGORIES = [
  { id:"geopolitics",      label:"Геополитика",         color:"#f87171" },
  { id:"finance",          label:"Финансы",             color:"#34d399" },
  { id:"tech",             label:"Технологии",          color:"#a78bfa" },
  { id:"lifestyle",        label:"Лайфстайл",           color:"#e879f9" },
  { id:"world",            label:"Мир",                 color:"#fb923c" },
  { id:"foreign_lifestyle",label:"Зарубежный лайфстайл",color:"#38bdf8" },
  { id:"geek",             label:"Гик-новости",         color:"#818cf8" },
  { id:"other",            label:"Прочее",              color:"#9ca3af" },
  { id:"local",            label:"Ярославль & Москва",  color:"#60a5fa" },
];

// Sources whose geopolitics/finance content routes to the "Мир" display tab
// and whose tech/lifestyle content routes to "Зарубежный лайфстайл" — a
// display-only split by press origin, layered on top of the same unified
// classification below (card.cat stays the same regardless of source;
// only card.bucket, computed after classification, differs).
const WEST_PRESS_NAMES = new Set(["AP","Al Jazeera","BBC","Politico","Reuters"]);

// Habr covers real tech/finance/lifestyle topics per the unified classifier,
// but reads at a much more niche/applied level than mainstream coverage of
// the same topics (a specific library release vs. a national AI policy
// story) — all of it goes to its own tab instead of mixing into the
// regular RU category tabs. Unlike "other", this ISN'T about content
// quality — it's purely about audience/level, so it applies regardless of
// which cat the classifier assigned (except "local"/"other", which stay
// where they are for everyone).
const GEEK_SOURCE_NAMES = new Set(["Habr"]);


const CAT_PROMPT = `Ты редактор новостного агрегатора. Для каждой новости определи категорию и тему.

КАТЕГОРИИ (выбери одну):

"geopolitics" — международная политика и военные темы: войны и конфликты,
дипломатия, санкции, выборы и смена власти в других странах, действия
НАТО/ООН/ЕС, отношения между странами, теракты, миграционные кризисы.

"finance" — экономика, деньги, бизнес: курсы валют, биржи и котировки,
решения ЦБ и ставки, инфляция и ВВП, крипто как актив, сделки M&A,
отчётность компаний, тарифы и торговые войны, цены на сырьё как товар.

"tech" — технологии и наука: ИИ и ПО, железо и гаджеты, стартапы и венчур,
кибербезопасность, космос, биотех/медтех как индустрия, автопром
(электромобили, беспилотники как технология).

"lifestyle" — жизнь, культура, общество: спорт, кино/музыка/искусство,
здоровье и медицина (не как индустрия), происшествия и криминал, погода
и экология, наука как открытие (не как бизнес), знаменитости, соцтемы
(образование, ЖКХ, транспорт).

"local" — используй ТОЛЬКО для новостей, у которых в квадратных скобках
указан город (например [город: Ярославль]), И которые реально описывают
событие в этом конкретном городе: местная администрация, происшествие на
конкретной улице/районе, местное ЖКХ, локальное культурное событие, работа
конкретных городских служб. Если у новости указан город, но по содержанию
это национальная/федеральная новость (просто republished локальным СМИ) —
НЕ ставь "local", определи её обычную категорию (geopolitics/finance/
tech/lifestyle) как для любой другой новости.

"other" — используй ТОЛЬКО если новость реально не описывает никакое
событие/тему выше: чисто служебный/рекламный текст, анонс без содержания,
нечитаемый обрывок, ИЛИ название раздела/рубрики сайта без реального
события (например "Образовательные программы", "Техническая поддержка",
"Школа управления" — это пункты меню, а не новости). Это редкая
категория, не запасной вариант для лени — почти любая настоящая новость
подойдёт под одну из категорий выше.

ПРИ ПОГРАНИЧНЫХ СЛУЧАЯХ — приоритет:
1. Военное/дипломатическое → всегда geopolitics, даже с экономическим
   аспектом (санкции против компании — geopolitics, не finance)
2. Деньги/бизнес конкретной компании или рынка → finance, даже если это
   tech-компания (акции Nvidia — finance, не tech)
3. Технология как продукт/индустрия → tech; та же технология как повод
   для развлечения → lifestyle (ИИ-стартап привлёк инвестиции — tech;
   нейросеть нарисовала смешную картинку — lifestyle)
4. Если новость про людей/общество без чёткой темы выше → lifestyle,
   не other
5. Новость с указанным городом, но НЕ являющаяся местной по сути —
   классифицируй по обычным правилам выше, не как local

Тему (ent) — 1-3 слова, главный субъект новости для группировки похожих
новостей: имя человека, страна, компания, событие. Для местных новостей —
конкретное место/учреждение (например "мэрия Ярославля", "парк Победы").
Примеры: "Иран", "ФРС", "Трамп", "Nvidia", "выборы в Молдове". Если явного
субъекта нет — пустая строка.

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
    ], name:"Habr", country:"ru" },
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
// Google News (and some other feeds) HTML-encode their description markup
// (e.g. "&lt;a href=...&gt;Title&lt;/a&gt;") instead of using real tags or
// CDATA. Decoding entities BEFORE stripping tags turns that back into real
// <a>...</a> markup so the tag-removal regex below can actually catch it —
// otherwise the encoded garbage (full of Latin href/target text) leaks
// straight through as "the description", and its Latin-heavy content can
// even fool the English-language detector into trying to translate it.
const decodeEntitiesServer = s => (s||"")
  .replace(/&amp;/g,"&")
  .replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"')
  .replace(/&#39;/g,"'").replace(/&nbsp;/g," ").replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(n));
const strip = s => decodeEntitiesServer(s||"").replace(/<[^>]+>/g," ").replace(/\s{2,}/g," ").trim();

function extractDateFromUrl(url) {
  const m = (url || "").match(/\/(20\d{2})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:[\/\-]|$)/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const mi = parseInt(mo,10), di = parseInt(d,10);
  if (mi < 1 || mi > 12 || di < 1 || di > 31) return null;
  const dt = new Date(`${y}-${String(mi).padStart(2,"0")}-${String(di).padStart(2,"0")}T12:00:00`);
  if (isNaN(dt.getTime())) return null;
  if (dt.getTime() > Date.now() + 86400000) return null;
  // NOTE: an OLD date is deliberately returned rather than discarded. It used
  // to return null past 30 days, which made the caller fall through to
  // "no date known" -> a synthetic fresh timestamp: an archive link came out
  // looking like breaking news. Age is the freshness gate's job, not this
  // function's — here we only reject dates that aren't dates.
  return dt;
}

// Is this item too old to publish? Only meaningful for a real date; a guessed
// timestamp says nothing about the article's age and is handled by the ledger.
function isStale(date, src) {
  const maxH = src?.maxAgeDays ? src.maxAgeDays * 24 : MAX_ITEM_AGE_H;
  return Date.now() - new Date(date).getTime() > maxH * 3600000;
}

function stripPublisherSuffix(t) {
  const m = (t || "").match(/^(.*\S)\s*[-–—|]\s*([^-–—|]{2,32})$/);
  if (!m) return t || "";
  const tail = m[2].trim().toLowerCase().replace(/\.(ru|com|org|net|eu)$/,"");
  return PUBLISHER_SUFFIXES.has(tail) ? m[1].trim() : t;
}

// Identity of a story = its headline, not its link. One article reaches us
// under several URLs (publisher RSS, the same URL with ?from=top_main_5 from a
// front-page scrape, a news.google.com redirect) — keying on the link made
// each of those a separate card.
function normTitle(t) {
  return stripPublisherSuffix(t).toLowerCase().replace(/[ё]/g,"е").replace(/[^а-яa-z0-9]/gi,"");
}

function cardId(title) {
  const s = normTitle(title) || String(title || "");
  let h1 = 0x811c9dc5, h2 = 5381;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = (Math.imul(h2, 33) + c) >>> 0;
  }
  return (h1.toString(36) + "" + h2.toString(36)).slice(0, 16);
}

// Looks for an actual date/time string near a headline in Jina-scraped
// listing text -- many sites show "2 часа назад" or "вчера, 14:32" right
// next to each headline. When found, this is a REAL timestamp (not a
// guess), unlike the synthetic list-position fallback used when nothing
// here matches either. A tight window keeps this from picking up a
// neighboring article's timestamp instead of the right one.
function findNearbyDate(text, matchIndex, titleLen) {
  const start = Math.max(0, matchIndex - 150);
  const end   = Math.min(text.length, matchIndex + titleLen + 150);
  const nearby = text.slice(start, end);

  let m = nearby.match(/(\d+)\s*(час|часа|часов)\s*назад/i);
  if (m) return new Date(Date.now() - parseInt(m[1],10) * 3600000);

  m = nearby.match(/(\d+)\s*(минут[аы]?|мин)\s*назад/i);
  if (m) return new Date(Date.now() - parseInt(m[1],10) * 60000);

  if (/только\s*что/i.test(nearby)) return new Date();

  m = nearby.match(/вчера[,\s]*(?:в\s*)?(\d{1,2}):(\d{2})/i);
  if (m) {
    const d = new Date(Date.now() - 86400000);
    d.setHours(parseInt(m[1],10), parseInt(m[2],10), 0, 0);
    return d;
  }
  if (/\bвчера\b/i.test(nearby)) {
    const d = new Date(Date.now() - 86400000);
    d.setHours(12, 0, 0, 0);
    return d;
  }

  m = nearby.match(/сегодня[,\s]*(?:в\s*)?(\d{1,2}):(\d{2})/i);
  if (m) {
    const d = new Date();
    d.setHours(parseInt(m[1],10), parseInt(m[2],10), 0, 0);
    return d;
  }

  // Absolute dates — "24.07.2026", "24.07.26", "24 июля" / "24 июля 2026".
  // Listing pages print these next to older material, and picking them up is
  // what turns a July article into a knowingly-old item (which the freshness
  // gate then drops) instead of an undated one that gets stamped "now".
  m = nearby.match(/\b(\d{1,2})[.](\d{1,2})[.](20\d{2}|\d{2})\b/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + parseInt(m[3],10) : parseInt(m[3],10);
    const d = new Date(y, parseInt(m[2],10) - 1, parseInt(m[1],10), 12, 0, 0);
    if (!isNaN(d.getTime()) && d.getTime() < Date.now() + 86400000) return d;
  }
  m = nearby.match(RU_MONTH_RE);
  if (m) {
    const mi = RU_MONTHS.findIndex(st => new RegExp("^" + st, "i").test(m[2]));
    if (mi >= 0) {
      const y = m[3] ? parseInt(m[3],10) : new Date().getFullYear();
      const d = new Date(y, mi, parseInt(m[1],10), 12, 0, 0);
      // No year printed and the date lands in the future => it's last year's.
      if (!m[3] && d.getTime() > Date.now() + 86400000) d.setFullYear(y - 1);
      if (!isNaN(d.getTime()) && d.getTime() < Date.now() + 86400000) return d;
    }
  }

  return null;
}

const RU_MONTHS = ["январ","феврал","март","апрел","ма[йя]","июн","июл","август","сентябр","октябр","ноябр","декабр"];
const RU_MONTH_RE = new RegExp(`\\b(\\d{1,2})\\s+(${RU_MONTHS.join("|")})[а-яё]*(?:\\s+(20\\d{2}))?`, "i");

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
      // Listing markup often puts the timestamp inside the link text, so the
      // headline arrives as "09:04 09:04 Собянин: ...". A real headline never
      // opens with a clock time, and a date is only stripped when it's
      // duplicated (an obvious markup artefact, not "16 сентября в Москве…").
      .replace(/^(?:\d{1,2}:\d{2}\s*)+/, "")
      .replace(new RegExp(`^(\\d{1,2}\\s+(?:${RU_MONTHS.join("|")})[а-яё]*)\\s+\\1\\s+`, "i"), "")
      .trim();
    if (title.length < 20) continue;
    // Reject template-placeholder leakage — some sites' JS-rendered listing
    // widgets get scraped by Jina before the template engine has filled in
    // real values, leaving raw "{{icon}}{{headline}}"-style syntax where a
    // real headline should be. If curly-brace placeholders make up a large
    // chunk of the "title", there's no real content here — skip it rather
    // than surface template syntax as if it were news.
    const placeholderChars = (title.match(/\{\{?[a-zA-Z0-9_]+\}?\}/g) || []).join("").length;
    if (placeholderChars > title.length * 0.3) continue;
    // Reject navigation/menu-item noise — Jina sometimes picks up section
    // links alongside real headlines ("Образовательные программы",
    // "Техническая поддержка", "Школа управления РБК"). These pass the
    // length check but are generic 2-3 word category/utility names, not
    // real headlines — real news almost always describes an actual event
    // (who did what) and reads as a longer phrase. A genuine headline under
    // 4 words is rare enough that this is a safe, cheap structural filter.
    if (title.split(/\s+/).length < 4) continue;
    if (seen.has(link)) continue;
    // Non-article destinations a front-page scrape keeps dragging in: topic
    // hubs, photo galleries, newsletter sign-ups, ad pages, podcast feeds.
    // They carry no publish date, so they used to be stamped "now" on every
    // single run and sat in the feed indefinitely.
    if (/\/(tag|category|author|search|page|feed|rss|theme|newsletters?|podcasts?|projects|promo)\b/i.test(link)) continue;
    if (/\/media\/photo\//i.test(link)) continue;
    // Section roots ("mos.ru/mayor/", "kommersant.ru/ad") — a single
    // non-numeric path segment is a landing page, never an article. Numeric
    // single segments ARE articles on some sites (frankmedia.ru/294703), and
    // deeper paths stay allowed, so real coverage isn't caught by this.
    try {
      const segs = new URL(link).pathname.split("/").filter(Boolean);
      if (segs.length <= 1 && !/^\d+$/.test(segs[0] || "")) continue;
    } catch { continue; }
    seen.add(link);
    const urlDate = extractDateFromUrl(link);
    const nearbyDate = urlDate ? null : findNearbyDate(text, m.index, rawTitle.length);
    const dateReliable = !!(urlDate || nearbyDate);
    const date = urlDate || nearbyDate || new Date(Date.now() - out.length * 16 * 60000);
    if (dateReliable && isStale(date, src)) continue;
    out.push({
      title, description: title, link, date: date.toISOString(), dateReliable,
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
    const title = grab("title").replace(/\s+-\s+[\w.]+\.(ru|com|org|net)$/i, "");
    const descRaw = grab("description") || grab("content");
    const desc  = descRaw.slice(0, 350);
    let link = grab("link");
    if (!link) {
      const m = block.match(/<link[^>]*href=["']([^"']+)["']/i);
      if (m) link = m[1];
    }
    const rawDate = grab("pubDate") || grab("published") || grab("updated");
    const pubDate = rawDate ? new Date(rawDate) : null;
    const pubDateOk = !!(pubDate && !isNaN(pubDate.getTime()));
    const urlDate = pubDateOk ? null : extractDateFromUrl(link);
    const dateReliable = pubDateOk || !!urlDate;
    const date = pubDateOk ? pubDate : (urlDate || new Date());
    if (!title || title.length < 5) continue;
    // Global gate now, not just for the few sources that had maxAgeDays set:
    // any feed can serve an archive item, and one that does shouldn't be able
    // to put July on today's front page.
    if (dateReliable && isStale(date, src)) continue;
    out.push({
      title, description: desc, link, date: date.toISOString(), dateReliable,
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
  const lines = items.map((it,i) => {
    const cityHint = it.tag ? `[город: ${it.tag}] ` : "";
    return `${i}. ${cityHint}[${it.sourceName}] ${it.title}: ${(it.description||"").slice(0,220)}`;
  }).join("\n");
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
  // Tag-based sources (Ярославль/Москва) now go through the SAME
  // classifier as everything else — the model judges whether each item is
  // genuinely local city news or just national content republished by a
  // local outlet (using the "[город: X]" hint added in classifyBatchGroq).
  // Previously every tag-sourced item was auto-stamped "local" with no
  // real check beyond a narrow keyword blocklist, which is exactly what
  // let generic national content flood the Ярославль/Москва tabs.
  const BATCH = 30;
  const catMap = {}, entMap = {};
  const batches = [];
  for (let i = 0; i < rawItems.length; i += BATCH) batches.push({ offset:i, items: rawItems.slice(i,i+BATCH) });

  // Groq's free tier is 30 requests/minute. Firing all batches at once (the
  // first real run had 16 of them) blows straight through that limit —
  // most get rate-limited and, with nothing to fall back to, those items
  // just vanished (483 fetched -> only 196 survived). Now: process a few
  // batches at a time, with a pause between waves, and anything that still
  // fails goes through the regex classifier — so a Groq hiccup degrades
  // quality for that batch, never drops it. The regex fallback can't judge
  // geo-relevance, so tag-sourced items default to "local" there (the old
  // behavior) rather than being mis-routed by a blind keyword match.
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
      items.forEach((it, bi) => {
        const idx = offset + bi;
        if (!catMap[idx]) catMap[idx] = it.tag ? "local" : categorizeFallback(it.title, it.description);
      });
    }));
    if (w + WAVE_SIZE < batches.length) await new Promise(r => setTimeout(r, 8000));
  }

  return rawItems.map((it, idx) => {
    const cat = catMap[idx];
    if (!cat) return null;
    return { ...it, cat, entity: entMap[idx] || "" };
  }).filter(Boolean);
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

async function gtranslate(text, targetLang, attempt = 0) {
  if (!text) return null;
  const sl = targetLang === "ru" ? "en" : "ru";
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${targetLang}&dt=t&q=${encodeURIComponent(text.slice(0,1000))}`;
    const res = await fetchWithTimeout(url, {}, 8000);
    if (res.status === 429 && attempt < 1) {
      await new Promise(r => setTimeout(r, 1200));
      return gtranslate(text, targetLang, attempt + 1);
    }
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
  const allPrompt = `Ты редактор новостного агрегатора. Напиши общее резюме за ${dateStr} по разделам.\n\nДля каждого раздела - 1-2 предложения с ключевыми событиями. Используй только факты из заголовков ниже, не добавляй ничего от себя.\nВ конце - одно предложение с тональностью дня.\n\nОтветь ТОЛЬКО HTML:\n<p><b>Геополитика:</b> ...</p>\n<p><b>Финансы:</b> ...</p>\n<p><b>Технологии:</b> ...</p>\n<p><b>Лайфстайл:</b> ...</p>\n<p><b>Тональность дня:</b> Слово - почему</p>\n\nПропускай разделы без новостей. Максимум 180 слов. Только HTML.\n\nНовости:\n${sections}`;
  const allText = await groqComplete(allPrompt);
  if (allText) digests.all = { html: allText, ...detectMood(allText) };

  // Per-category deep-dive
  for (const [cat, label] of Object.entries(catLabels)) {
    const items = (byCat[cat] || pool.filter(c=>c.cat===cat)).slice(0, 12).map(c => `- ${c.title_ru||c.title}`).join("\n");
    if (!items) continue;
    const prompt = `Ты редактор новостного агрегатора. Напиши резюме раздела "${label}" за ${dateStr}.\n\nВыдели 2-3 самых важных события, 2-3 предложения на каждое. Используй только факты из заголовков ниже, не добавляй ничего от себя. В конце - одно предложение с общим итогом раздела.\n\nОтветь ТОЛЬКО HTML-параграфами:\n<p><b>Событие 1:</b> ...</p>\n<p><b>Событие 2:</b> ...</p>\n<p><b>Итог:</b> ...</p>\n\nМаксимум 160 слов. Только HTML.\n\nНовости раздела:\n${items}`;
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

  // Global dedup on the NORMALISED headline (publisher suffix stripped, no
  // 60-char truncation — that truncation is why "…закупок" and
  // "…закупок - Коммерсантъ" hashed differently and both survived).
  // Where the same story arrives several times, keep the best copy: a real
  // publish date beats a guessed one, and a direct publisher link beats a
  // Google News redirect (which is also an unstable, opaque URL).
  const variantScore = it =>
    (it.dateReliable ? 2 : 0) + (/news\.google\.com/i.test(it.link) ? 0 : 1);
  const bestByTitle = new Map();
  for (const it of allItems) {
    const key = normTitle(it.title) || it.link;
    const prev = bestByTitle.get(key);
    if (!prev || variantScore(it) > variantScore(prev)) bestByTitle.set(key, it);
  }
  allItems = [...bestByTitle.values()];
  console.log(`Total unique items: ${allItems.length}`);

  const categorized = allItems.length ? await categorizeWithAI(allItems) : [];
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
      // Display bucket: same classification (cat) everywhere, but Western
      // press gets routed to its own tabs ("Мир" / "Зарубежный лайфстайл")
      // instead of mixing into the RU tabs. "other" is shared regardless
      // of origin — genuinely uncategorizable content isn't worth splitting
      // by press further. Local (tag-based) sources already have cat="local"
      // from categorizeWithAI and pass through unchanged.
      const isWestern = sources.some(s => WEST_PRESS_NAMES.has(s));
      const isGeek = sources.some(s => GEEK_SOURCE_NAMES.has(s));
      let bucket = cat;
      if (cat === "other") bucket = "other";
      else if (cat === "local") bucket = "local";
      else if (isGeek) bucket = "geek";
      else if (isWestern && (cat === "geopolitics" || cat === "finance")) bucket = "world";
      else if (isWestern && (cat === "tech" || cat === "lifestyle")) bucket = "foreign_lifestyle";
      // Use whichever raw item has the latest date — but carry along THAT
      // item's own reliability flag, not just its timestamp, so a merged
      // card doesn't inherit a confident-looking time from a source that
      // was actually guessing.
      const latest = g.reduce((best,x) => x.date > best.date ? x : best, g[0]);
      cards.push({
        // Content-based and therefore stable across runs: the same story keeps
        // the same id no matter which URL variant or which source happened to
        // represent it this time.
        id: cardId(g[0].title),
        title: g[0].title,
        description: g[0].description,
        cat, bucket, entity: g.map(x=>x.entity).find(Boolean) || "",
        date: latest.date,
        dateReliable: latest.dateReliable !== false,
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
  let previous = [], seenLedger = {};
  if (existsSync(OUT_PATH)) {
    try { previous = JSON.parse(await readFile(OUT_PATH, "utf-8")).cards || []; } catch {}
  }
  if (existsSync(SEEN_PATH)) {
    try { seenLedger = JSON.parse(await readFile(SEEN_PATH, "utf-8")).seen || {}; } catch {}
  }

  const now   = new Date().toISOString();
  const nowMs = Date.now();
  const cutoff = nowMs - STORE_MAX_H * 3600000;

  // Every headline a card was built from maps to that card's id, so a story
  // whose group representative changed between runs is still recognised as the
  // same story rather than entering as a second card.
  const cardKeys = c => {
    const ks = [normTitle(c.title || "")];
    (c.raw || []).forEach(r => ks.push(normTitle(r.title || "")));
    return [...new Set(ks.filter(k => k.length > 10))];
  };

  // Re-key carried-over cards to the content-based id. This also performs the
  // one-time migration off the old link-tail ids — old duplicates of one story
  // collapse onto a single id right here.
  for (const c of previous) {
    c.id = cardId(c.title);
    const fs = c.firstSeenAt || c.date || now;
    if (!seenLedger[c.id] || seenLedger[c.id] > fs) seenLedger[c.id] = fs;
  }

  const keyToId = new Map();
  const byId = new Map();
  for (const c of previous) {
    const existing = byId.get(c.id);
    if (existing) {
      existing.sources = [...new Set([...(existing.sources||[]), ...(c.sources||[])])];
      if (!existing.title_ru && c.title_ru) existing.title_ru = c.title_ru;
      if (!existing.description_ru && c.description_ru) existing.description_ru = c.description_ru;
      continue;
    }
    c.firstSeenAt = seenLedger[c.id] || c.firstSeenAt || now;
    byId.set(c.id, c);
    cardKeys(c).forEach(k => { if (!keyToId.has(k)) keyToId.set(k, c.id); });
  }

  for (const c of cards) {
    const known = cardKeys(c).map(k => keyToId.get(k)).find(Boolean);
    if (known) c.id = known;
    const prev = byId.get(c.id);
    // firstSeenAt marks when THIS story first entered our system — distinct
    // from the article's own publish date. The ledger keeps it even after the
    // card itself has aged out, so a permanent front-page link can't come
    // back as "new" tomorrow.
    c.firstSeenAt = seenLedger[c.id] || prev?.firstSeenAt || now;
    if (prev) {
      c.sources = [...new Set([...(prev.sources||[]), ...(c.sources||[])])];
      if (!c.title_ru && prev.title_ru) c.title_ru = prev.title_ru;
      if (!c.description_ru && prev.description_ru) c.description_ru = prev.description_ru;
      if (prev.dateReliable && !c.dateReliable) { c.date = prev.date; c.dateReliable = true; }
    }
    // A guessed timestamp must never be refreshed on every run — that is what
    // kept evergreen links (and genuinely old articles pinned to a front page)
    // permanently "minutes old" and immune to the 48h window. Pin it to when we
    // first saw the item instead, so it ages like everything else.
    if (!c.dateReliable) c.date = c.firstSeenAt;
    seenLedger[c.id] = c.firstSeenAt;
    byId.set(c.id, c);
    cardKeys(c).forEach(k => { if (!keyToId.has(k)) keyToId.set(k, c.id); });
  }

  // Final safety pass: collapse anything still sharing a headline (oldest
  // sighting wins, so ordering stays stable), then age out on a date that is
  // now trustworthy for every card — real where we know it, first-seen where
  // we don't.
  const collapsed = new Map();
  for (const c of [...byId.values()].sort((a,b) => new Date(a.firstSeenAt) - new Date(b.firstSeenAt))) {
    const keys = cardKeys(c);
    if (!keys.length) keys.push("id:" + c.id);   // title too short to key on
    const hit = keys.map(k => collapsed.get(k)).find(Boolean);
    if (hit) {
      hit.sources = [...new Set([...(hit.sources||[]), ...(c.sources||[])])];
      continue;
    }
    keys.forEach(k => collapsed.set(k, c));
  }
  const merged = [...new Set(collapsed.values())]
    .filter(c => !(c.sources||[]).some(s => DEAD_SOURCES.has(s)))
    .filter(c => new Date(c.date).getTime() > cutoff)
    .sort((a,b) => new Date(b.firstSeenAt) - new Date(a.firstSeenAt));
  console.log(`Merged: ${merged.length} cards (from ${previous.length} previous + ${cards.length} fresh)`);

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
  const TR_CONCURRENT = 5;
  for (let i = 0; i < toTranslate.length; i += TR_CONCURRENT) {
    const batch = toTranslate.slice(i, i + TR_CONCURRENT);
    await Promise.all(batch.map(async card => {
      // Google first — it's free, fast (~request), and doesn't compete with
      // categorization/digests for Groq's limited per-minute quota. Groq
      // only picks up whatever Google couldn't handle.
      let t = await gtranslate(card.title, "ru");
      if (!t) t = await groqTranslate(card.title, "ru");
      if (t) card.title_ru = t;
      let s = await gtranslate(card.description, "ru");
      if (!s) s = await groqTranslate(card.description, "ru");
      if (s) card.description_ru = s;
    }));
  }
  console.log(`Translated: ${toTranslate.length} cards (${toTranslate.filter(c=>c.title_ru).length} succeeded)`);

  // Trending topics — how many distinct cards mention the same entity in
  // the last 8 hours. Pure aggregation over data we already have (entity
  // was assigned during categorization above) — no extra AI calls, no
  // extra fetches. Sustained repeat coverage of the same subject is a
  // reasonable, cheap proxy for "this matters right now".
  const trendWindow = Date.now() - 8 * 3600000;
  const entityCounts = new Map();
  for (const c of merged) {
    if (!c.entity || new Date(c.firstSeenAt).getTime() < trendWindow) continue;
    entityCounts.set(c.entity, (entityCounts.get(c.entity) || 0) + 1);
  }
  const trending = [...entityCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([entity, count]) => ({ entity, count }));
  console.log(`Trending: ${trending.map(t => `${t.entity}(${t.count})`).join(", ") || "none"}`);

  const output = {
    generatedAt: new Date().toISOString(),
    categories: CATEGORIES,
    digests,
    trending,
    cards: merged,
  };

  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(output, null, 0));

  // Ledger: keep entries for two weeks — long enough that an evergreen link
  // can't sneak back in as new, short enough that the file stays small. It is
  // written separately so the client's download doesn't grow.
  const seenCutoff = nowMs - SEEN_KEEP_H * 3600000;
  const prunedSeen = {};
  for (const [id, ts] of Object.entries(seenLedger)) {
    const t = new Date(ts).getTime();
    if (!isNaN(t) && t > seenCutoff) prunedSeen[id] = ts;
  }
  await writeFile(SEEN_PATH, JSON.stringify({ v: 1, updatedAt: now, seen: prunedSeen }, null, 0));
  console.log(`Wrote ${merged.length} cards to data/news.json (ledger: ${Object.keys(prunedSeen).length} ids)`);
}

main().catch(err => { console.error(err); process.exit(1); });
