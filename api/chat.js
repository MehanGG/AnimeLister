// Vercel serverless function: meneruskan chat ke Groq. API key disimpan di Environment Variable, bukan di browser.
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const key = process.env.GroqAPI || process.env.GROQ_API_KEY;
  if (!key) return res.status(500).json({ error: "Environment variable GroqAPI belum diatur di Vercel" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const msgs = (Array.isArray(body.messages) ? body.messages : []).slice(-10).map(m => ({
    role: m && m.role === "assistant" ? "assistant" : "user",
    content: String((m && m.content) || "").slice(0, 1500)
  })).filter(m => m.content);
  if (!msgs.length) return res.status(400).json({ error: "Pesan kosong" });

  const lang = body.lang === "en" ? "English" : "Indonesian";
  const mode = body.mode === "MANGA" ? "MANGA" : "ANIME";
  const system = `You are the AnimangaList assistant. Only discuss anime, manga and closely related topics; politely decline anything else in one sentence.
Reply in ${lang}. The user is currently browsing ${mode.toLowerCase()}.
Answer with ONE valid JSON object only (no markdown, no text outside it): {"reply": string, "kind": "ANIME" or "MANGA", "titles": string[]}.
- "reply": 1-3 short friendly sentences. Do not list the titles inside it, they are shown as cards under your message.
- "titles": when the user asks for recommendations or names specific works, up to 20 exact official titles (romaji or English, as on AniList), best match first. If the user asks for N titles, give N (max 20), but accuracy beats quantity: give fewer rather than padding with poor matches. Otherwise [].
- "kind": what the titles are (default ${mode}).
Before including a title, check it against EVERY detail in the request (premise, protagonist gender, power level, setting, genre, year, etc.) and drop any that do not clearly fit. Only include works that really exist. Never recommend adult or hentai titles.`;

  let model = (process.env.GROQ_MODEL || "llama-3.3-70b-versatile").trim();
  if (/^gpt-oss/.test(model)) model = "openai/" + model; // terima "gpt-oss-120b" tanpa awalan
  const oss = model.includes("gpt-oss");

  const call = async (effort, maxTokens) => {
    const payload = { model, messages: [{ role: "system", content: system }, ...msgs], temperature: 0.5, max_tokens: maxTokens };
    if (oss) payload.reasoning_effort = effort;           // model penalaran: tanpa JSON mode, di-parse manual
    else payload.response_format = { type: "json_object" };
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const j = await r.json().catch(() => ({}));
    const text = r.ok ? ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "") : ((j.error && j.error.failed_generation) || "");
    return { r, j, text };
  };
  const parse = txt => {
    try { return JSON.parse(txt); } catch (e) {}
    const a = txt.indexOf("{"), b = txt.lastIndexOf("}");
    if (a >= 0 && b > a) { try { return JSON.parse(txt.slice(a, b + 1)); } catch (e) {} }
    return null;
  };

  try {
    let c = await call(process.env.GROQ_EFFORT || "high", oss ? 6000 : 1200);
    let out = parse(c.text);
    if (!out && oss) { c = await call("low", 3000); out = parse(c.text); } // percobaan ulang yang lebih ringan
    if (!out) {
      if (!c.r.ok) return res.status(502).json({ error: (c.j.error && c.j.error.message) || "Groq error " + c.r.status });
      out = { reply: c.text, titles: [] };
    }
    const titles = (Array.isArray(out.titles) ? out.titles : []).slice(0, 20).map(String);
    let reply = String(out.reply || "");
    if (!reply && !titles.length) reply = lang === "English" ? "Sorry, I couldn't answer that. Please try again." : "Maaf, aku belum bisa menjawab itu. Coba tanyakan lagi.";
    res.status(200).json({ reply, kind: out.kind === "MANGA" ? "MANGA" : "ANIME", titles });
  } catch (e) {
    res.status(502).json({ error: "Tidak bisa menghubungi Groq" });
  }
};
