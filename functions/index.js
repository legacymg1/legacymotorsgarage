// Legacy DMS — backend (Cloud Functions v2)
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();
setGlobalOptions({ region: "us-central1", maxInstances: 10 });

const ANTHROPIC_KEY = defineSecret("ANTHROPIC_KEY");

// Prueba: confirma que el backend está vivo.
exports.ping = onCall((request) => ({
  ok: true, msg: "backend vivo 🚀", at: new Date().toISOString(),
  uid: request.auth ? request.auth.uid : null,
}));

// 🤖 IA: lee las fotos de una parte y arma el anuncio de eBay (título + descripción + OEM + specifics)
exports.prepareEbay = onCall({ secrets: [ANTHROPIC_KEY], timeoutSeconds: 120, memory: "512MiB" }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const partId = request.data && request.data.partId;
  if (!partId) throw new HttpsError("invalid-argument", "Falta partId.");

  const db = admin.firestore();
  const snap = await db.collection("parts").doc(partId).get();
  if (!snap.exists) throw new HttpsError("not-found", "Parte no encontrada.");
  const p = snap.data();

  // Fotos reales (sin el QR), máximo 5
  const urls = (p.photoURLs || []).filter((u) => u && !/00_QR/.test(u)).slice(0, 5);
  const images = [];
  for (const u of urls) {
    try {
      const r = await fetch(u);
      if (!r.ok) continue;
      const ct = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
      const media = /png/.test(ct) ? "image/png" : /webp/.test(ct) ? "image/webp" : "image/jpeg";
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 4.8 * 1024 * 1024) continue;
      images.push({ type: "image", source: { type: "base64", media_type: media, data: buf.toString("base64") } });
    } catch (e) { /* saltar imagen que falle */ }
  }
  if (!images.length) throw new HttpsError("failed-precondition", "La parte no tiene fotos para analizar.");

  const veh = [p.vYear, p.vMake, p.vModel, p.vTrim].filter(Boolean).join(" ");
  const feedback = (request.data && request.data.feedback ? String(request.data.feedback) : "").trim().slice(0, 500);
  let prompt = `You are an expert US used auto-parts lister for eBay Motors.
This part was removed from a ${veh || "vehicle"}.
The seller labeled it: "${p.name || ""}". Stated condition: "${p.condition || "Used"}".
Study the photos carefully. Read any OEM / part / interchange numbers stamped on the part or on labels.
Return ONLY valid JSON (no markdown, no backticks) with EXACTLY these keys:
{"title": "<=80 char keyword-rich eBay title, e.g. Year Make Model PartName OEM#",
 "description": "2-4 sentences: what it is, fitment, condition, any visible wear/damage",
 "partNumbers": ["OEM/interchange numbers you can actually read; [] if none"],
 "condition": "Used" | "For parts or not working" | "New",
 "itemSpecifics": {"Brand": "", "Manufacturer Part Number": "", "Placement on Vehicle": "", "Fitment": ""},
 "confidence": "high" | "medium" | "low"}
If unsure of a value use an empty string. NEVER invent part numbers you cannot see.`;

  if (feedback) {
    prompt += `\n\nThe user REVIEWED a previous AI draft and gave this correction/instruction (in Spanish or English): "${feedback}". Apply it precisely — the user is the human expert who is looking at the real part.`;
    if (p.ebayDraft) prompt += `\nThe previous draft was: ${JSON.stringify({ title: p.ebayDraft.title, description: p.ebayDraft.description, partNumbers: p.ebayDraft.partNumbers })}.`;
  }

  const AnthropicMod = require("@anthropic-ai/sdk");
  const Anthropic = AnthropicMod.Anthropic || AnthropicMod.default || AnthropicMod;
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY.value() });

  let text = "";
  try {
    const msg = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      messages: [{ role: "user", content: [...images, { type: "text", text: prompt }] }],
    });
    text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  } catch (e) {
    throw new HttpsError("internal", "IA: " + (e.message || "error"));
  }

  let draft;
  try {
    const m = text.match(/\{[\s\S]*\}/);
    draft = JSON.parse(m ? m[0] : text);
  } catch (e) {
    draft = { title: (p.ebayTitle || p.name || ""), description: text.slice(0, 500), partNumbers: [], condition: p.condition || "Used", itemSpecifics: {}, confidence: "low", raw: text.slice(0, 800) };
  }
  draft.generatedAt = new Date().toISOString();
  draft.by = (request.auth.token && request.auth.token.email) || "";
  if (feedback) draft.lastFeedback = feedback;

  await db.collection("parts").doc(partId).update({ ebayDraft: draft, ebayDraftAt: draft.generatedAt });
  return draft;
});
