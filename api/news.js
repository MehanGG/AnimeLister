// Vercel serverless function: ambil berita anime dari RSS (CORS tidak mengizinkan dari browser),
// ambil gambar/ringkasan dari halaman artikel (og:image), lalu minta Groq menebak anime yang dibahas.
const FEEDS = [
  ["Anime News Network", "https://www.animenewsnetwork.com/all/rss.xml?ann-edition=w"],
  ["MyAnimeList", "https://myanimelist.net/rss/news.xml"]
];
const UA = { "User-Agent": "Mozilla/5.0 (compatible; AnimangaList)" };
const dec = s => s.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, "$1").replace(/<[^>]+>/g, "")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;|&apos;/g, "'").trim();

function parse(xml, source){
  const out = [];
  for (const block of xml.match(/<item[\s>][\s\S]*?<\/item>/g) || []) {
    const get = tag => { const m = block.match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">")); return m ? dec(m[1].trim()) : ""; };
    const title = get("title"), link = get("link"), d = new Date(get("pubDate"));
    const im = block.match(/<enclosure[^>]*?url="([^"]+)"/) || block.match(/<media:(?:thumbnail|content)[^>]*?url="([^"]+)"/) || block.match(/<img[^>]*?src=["']([^"']+)["']/);
    if (title && link) out.push({ title, link, source, date: isNaN(d) ? "" : d.toISOString(), desc: get("description").slice(0, 900), img: im && /^https?:/.test(im[1]) ? im[1].replace(/&amp;/g, "&") : "" });
  }
  return out;
}

async function og(url){
  try {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return {};
    const html = (await r.text()).slice(0, 80000);
    const meta = p => {
      const m = html.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + p + '["\'][^>]*content=["\']([^"\']+)["\']', "i")) ||
                html.match(new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']' + p + '["\']', "i"));
      return m ? dec(m[1]) : "";
    };
    const img = meta("og:image");
    return { img: /^https?:/.test(img) ? img : "", desc: meta("og:description") };
  } catch (e) { return {}; }
}

async function guess(items, key){
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({
      model: process.env.GROQ_NEWS_MODEL || "llama-3.3-70b-versatile",
      temperature: 0, max_tokens: 1800,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: 'For each numbered news headline, name the single anime or manga series it is about (official romaji or English title as listed on AniList, without extra words like "anime" or "film"). Use null only when it is general industry news not about one specific series. Answer with JSON only: {"items":[{"i":0,"anime":"Title or null"}]} covering every number.' },
        { role: "user", content: items.map((x, i) => i + ": " + x.title).join("\n") }
      ]
    })
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || "Groq " + r.status);
  const obj = JSON.parse(j.choices[0].message.content);
  const arr = Array.isArray(obj.items) ? obj.items : (Object.values(obj).find(Array.isArray) || []);
  let n = 0;
  arr.forEach(a => { const it = items[a && a.i]; if (it && typeof a.anime === "string" && a.anime.trim() && a.anime.toLowerCase() !== "null") { it.anime = a.anime.trim().slice(0, 120); n++; } });
  return n;
}

module.exports = async (req, res) => {
  const got = await Promise.allSettled(FEEDS.map(async ([name, url]) => {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(name + " " + r.status);
    return parse(await r.text(), name);
  }));
  const items = got.flatMap(g => g.status === "fulfilled" ? g.value : [])
    .sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 24).map(x => ({ ...x, anime: null }));
  if (!items.length) return res.status(502).json({ error: "Sumber berita tidak bisa dijangkau" });

  const key = process.env.GroqAPI || process.env.GROQ_API_KEY;
  let ai = key ? "ok" : "GroqAPI belum diatur";
  await Promise.all([
    // gambar + ringkasan dari halaman artikel kalau RSS tidak menyediakannya
    Promise.all(items.map(async x => {
      if (x.img && x.desc) return;
      const m = await og(x.link);
      if (!x.img) x.img = m.img || "";
      if (!x.desc) x.desc = (m.desc || "").slice(0, 900);
    })),
    key ? guess(items, key).then(n => { if (!n) ai = "AI tidak menemukan judul anime"; }).catch(e => { ai = "AI gagal: " + e.message; }) : null
  ]);
  res.setHeader("Cache-Control", ai === "ok" ? "s-maxage=900, stale-while-revalidate=3600" : "no-store");
  res.status(200).json({ items, ai });
};
