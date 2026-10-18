// Vercel serverless function: meneruskan chat ke Groq. API key disimpan di Environment Variable, bukan di browser.
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const key = process.env.GroqAPI || process.env.GROQ_API_KEY;
  if (!key) return res.status(500).json({ error: "Environment variable GroqAPI belum diatur di Vercel" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const msgs = (Array.isArray(body && body.messages) ? body.messages : []).slice(-10).map(m => ({
    role: m && m.role === "assistant" ? "assistant" : "user",
    content: String((m && m.content) || "").slice(0, 1500)
  })).filter(m => m.content);
  if (!msgs.length) return res.status(400).json({ error: "Pesan kosong" });

  const lang = body.lang === "en" ? "English" : "Indonesian";
  const mode = body.mode === "MANGA" ? "MANGA" : "ANIME";
  const system = `You are the AnimangaList assistant. Only discuss anime, manga and closely related topics; politely decline anything else in one sentence.
Reply in ${lang}. The user is currently browsing ${mode.toLowerCase()}.
Answer with ONE JSON object only: {"reply": string, "kind": "ANIME" or "MANGA", "titles": string[]}.
- "reply": 1-3 short friendly sentences. Do not list the titles inside it, they are shown as cards under your message.
- "titles": when the user asks for recommendations or names specific works, up to 10 exact official titles (romaji or English, as on AniList), best match first. If the user asks for N titles, give N (max 10). Otherwise [].
- "kind": what the titles are (default ${mode}).
Only include works that really exist. Never recommend adult or hentai titles.`;

  let model = (process.env.GROQ_MODEL || "llama-3.3-70b-versatile").trim();
  if (/^gpt-oss/.test(model)) model = "openai/" + model; // terima "gpt-oss-120b" tanpa awalan
  const oss = model.includes("gpt-oss");

  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model,
        messages: [{ role: "system", content: system }, ...msgs],
        temperature: 0.6,
        max_tokens: oss ? 2500 : 900,
        ...(oss ? { reasoning_effort: "low" } : {}),
        response_format: { type: "json_object" }
      })
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: (j.error && j.error.message) || "Groq error " + r.status });
    let out;
    try { out = JSON.parse(j.choices[0].message.content); }
    catch (e) { out = { reply: String(j.choices[0].message.content || ""), titles: [] }; }
    res.status(200).json({
      reply: String(out.reply || ""),
      kind: out.kind === "MANGA" ? "MANGA" : "ANIME",
      titles: (Array.isArray(out.titles) ? out.titles : []).slice(0, 10).map(String)
    });
  } catch (e) {
    res.status(502).json({ error: "Tidak bisa menghubungi Groq" });
  }
};
