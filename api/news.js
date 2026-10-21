// Vercel serverless function: ambil berita anime dari RSS (CORS tidak mengizinkan dari browser),
// lalu minta Groq menebak judul anime/manga yang dibahas tiap berita.
const FEEDS = [
  ["Anime News Network", "https://www.animenewsnetwork.com/all/rss.xml?ann-edition=w"],
  ["MyAnimeList", "https://myanimelist.net/rss/news.xml"]
];
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

module.exports = async (req, res) => {
  const got = await Promise.allSettled(FEEDS.map(async ([name, url]) => {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 AnimangaList" }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(name + " " + r.status);
    return parse(await r.text(), name);
  }));
  let items = got.flatMap(g => g.status === "fulfilled" ? g.value : [])
    .sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 24);
  if (!items.length) return res.status(502).json({ error: "Sumber berita tidak bisa dijangkau" });

  const key = process.env.GroqAPI || process.env.GROQ_API_KEY;
  items = items.map(x => ({ ...x, anime: null }));
  if (key) {
    try {
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: process.env.GROQ_NEWS_MODEL || "llama-3.3-70b-versatile",
          temperature: 0, max_tokens: 1500,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: 'For each numbered news headline, name the single anime or manga series it is about (official romaji or English title as listed on AniList). Use null when it is general industry news, an event, or not about one specific series. Answer with JSON only: {"items":[{"i":0,"anime":"Title or null"}]} covering every number.' },
            { role: "user", content: items.map((x, i) => i + ": " + x.title).join("\n") }
          ]
        })
      });
      const j = await r.json();
      const arr = JSON.parse(j.choices[0].message.content).items || [];
      arr.forEach(a => { if (items[a.i] && typeof a.anime === "string" && a.anime.trim()) items[a.i].anime = a.anime.trim().slice(0, 120); });
    } catch (e) { /* tanpa pencocokan anime, berita tetap tampil */ }
  }
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");
  res.status(200).json({ items });
};
