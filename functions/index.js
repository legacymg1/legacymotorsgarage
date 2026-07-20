// Legacy DMS — backend (Cloud Functions v2)
const { onCall, HttpsError, onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
setGlobalOptions({ region: "us-central1", maxInstances: 10 });

const ANTHROPIC_KEY = defineSecret("ANTHROPIC_KEY");
const EBAY_APP_ID = defineSecret("EBAY_APP_ID");
const EBAY_DEV_ID = defineSecret("EBAY_DEV_ID");
const EBAY_CERT_ID = defineSecret("EBAY_CERT_ID");
const EBAY_AUTH_TOKEN = defineSecret("EBAY_AUTH_TOKEN");

// Prueba: confirma que el backend está vivo.
exports.ping = onCall((request) => ({
  ok: true, msg: "backend vivo 🚀", at: new Date().toISOString(),
  uid: request.auth ? request.auth.uid : null,
}));

// 🔔 eBay Marketplace Account Deletion/Closure — endpoint requerido para habilitar el keyset de Producción.
// GET con challenge_code → responde SHA-256(challengeCode + verificationToken + endpointUrl).
// POST (aviso real de borrado) → 200 OK (no guardamos PII de usuarios de eBay, solo confirmamos).
const EBAY_VERIFY_TOKEN = "LMGebay2026vTkn7q3Zx9Rb2Kp8Wm4Nc6Yh1Fj0Ld5Sg";   // 44 chars, va IGUAL en el portal de eBay
const EBAY_DELETION_ENDPOINT = "https://us-central1-legacy-motors-garage.cloudfunctions.net/ebayAccountDeletion";
exports.ebayAccountDeletion = onRequest((req, res) => {
  if (req.method === "GET") {
    const challengeCode = req.query.challenge_code;
    if (!challengeCode) { res.status(400).json({ error: "missing challenge_code" }); return; }
    const h = crypto.createHash("sha256");
    h.update(String(challengeCode)); h.update(EBAY_VERIFY_TOKEN); h.update(EBAY_DELETION_ENDPOINT);
    res.status(200).json({ challengeResponse: h.digest("hex") });
    return;
  }
  // POST: aviso de borrado de cuenta — acusamos recibo. (Aquí borraríamos datos de ese usuario si guardáramos alguno.)
  try { console.log("eBay account deletion notice:", JSON.stringify(req.body || {})); } catch (e) {}
  res.status(200).send("ok");
});

// 🧪 Prueba de credenciales eBay (Trading API GetUser) — confirma que App ID/Dev ID/Cert ID + token funcionan. NO toca anuncios.
exports.ebayTest = onCall({ secrets: [EBAY_APP_ID, EBAY_DEV_ID, EBAY_CERT_ID, EBAY_AUTH_TOKEN], timeoutSeconds: 60 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const body = `<?xml version="1.0" encoding="utf-8"?>
<GetUserRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${EBAY_AUTH_TOKEN.value()}</eBayAuthToken></RequesterCredentials>
  <DetailLevel>ReturnSummary</DetailLevel>
</GetUserRequest>`;
  let text = "";
  try {
    const r = await fetch("https://api.ebay.com/ws/api.dll", {
      method: "POST",
      headers: {
        "X-EBAY-API-CALL-NAME": "GetUser",
        "X-EBAY-API-SITEID": "0",
        "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
        "X-EBAY-API-APP-NAME": EBAY_APP_ID.value(),
        "X-EBAY-API-DEV-NAME": EBAY_DEV_ID.value(),
        "X-EBAY-API-CERT-NAME": EBAY_CERT_ID.value(),
        "Content-Type": "text/xml",
      },
      body,
    });
    text = await r.text();
  } catch (e) {
    throw new HttpsError("internal", "No se pudo contactar a eBay: " + (e.message || e));
  }
  const pick = (tag) => { const m = text.match(new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">")); return m ? m[1] : ""; };
  return {
    ack: pick("Ack") || "unknown",
    userId: pick("UserID"),
    goodStanding: pick("eBayGoodStanding"),
    error: pick("LongMessage") || pick("ShortMessage"),
  };
});

// ---- Helpers Trading API (XML) ----
function xesc(s){ return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function ebayTags(text, tag){ const out = []; const re = new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">", "g"); let m; while ((m = re.exec(text))) out.push(m[1]); return out; }
async function ebayXml(callName, inner){
  const body = `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
<RequesterCredentials><eBayAuthToken>${EBAY_AUTH_TOKEN.value()}</eBayAuthToken></RequesterCredentials>
${inner}
</${callName}Request>`;
  const r = await fetch("https://api.ebay.com/ws/api.dll", {
    method: "POST",
    headers: {
      "X-EBAY-API-CALL-NAME": callName,
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
      "X-EBAY-API-APP-NAME": EBAY_APP_ID.value(),
      "X-EBAY-API-DEV-NAME": EBAY_DEV_ID.value(),
      "X-EBAY-API-CERT-NAME": EBAY_CERT_ID.value(),
      "Content-Type": "text/xml",
    },
    body,
  });
  return await r.text();
}

// 🧪 Verificar anuncio (VerifyAddFixedPriceItem) — arma el anuncio y eBay lo VALIDA sin publicarlo. Cero riesgo.
const EBAY_SECRETS = [EBAY_APP_ID, EBAY_DEV_ID, EBAY_CERT_ID, EBAY_AUTH_TOKEN];
exports.ebayVerifyListing = onCall({ secrets: EBAY_SECRETS, timeoutSeconds: 120 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const partId = request.data && request.data.partId;
  if (!partId) throw new HttpsError("invalid-argument", "Falta partId.");
  const snap = await admin.firestore().collection("parts").doc(partId).get();
  if (!snap.exists) throw new HttpsError("not-found", "Parte no encontrada.");
  const p = snap.data();
  const d = p.ebayDraft || {};

  const title = (d.title || p.ebayTitle || p.name || "Auto part").slice(0, 80);
  const desc = (d.description || p.name || "");
  const price = (((p.priceCents != null ? p.priceCents : 999) / 100)).toFixed(2);
  const condMap = { "New": "1000", "Used": "3000", "For parts or not working": "7000" };
  const condId = condMap[d.condition || p.condition] || "3000";

  // Categoría sugerida por eBay a partir del título
  let catId = "";
  try { catId = ebayTags(await ebayXml("GetSuggestedCategories", `<Query>${xesc(title)}</Query>`), "CategoryID")[0] || ""; } catch (e) {}
  if (!catId) catId = "6030"; // fallback: Car & Truck Parts

  const pics = (p.photoURLs || []).filter((u) => u && !/00_QR/.test(u)).slice(0, 12);
  const picXml = pics.length ? `<PictureDetails>${pics.map((u) => `<PictureURL>${xesc(u)}</PictureURL>`).join("")}</PictureDetails>` : "";

  const specs = [];
  const is = d.itemSpecifics || {};
  Object.keys(is).forEach((k) => { if (is[k]) specs.push([k, is[k]]); });
  if (!is["Manufacturer Part Number"]) { const mpn = (d.partNumbers && d.partNumbers[0]) || d.suggestedPartNumber; if (mpn) specs.push(["Manufacturer Part Number", mpn]); }
  const specsXml = specs.length ? `<ItemSpecifics>${specs.map(([n, v]) => `<NameValueList><Name>${xesc(n)}</Name><Value>${xesc(String(v))}</Value></NameValueList>`).join("")}</ItemSpecifics>` : "";

  const inner = `<Item>
  <Title>${xesc(title)}</Title>
  <Description>${xesc(desc)}</Description>
  <PrimaryCategory><CategoryID>${catId}</CategoryID></PrimaryCategory>
  <StartPrice>${price}</StartPrice>
  <ConditionID>${condId}</ConditionID>
  <Country>US</Country>
  <Currency>USD</Currency>
  <DispatchTimeMax>3</DispatchTimeMax>
  <ListingDuration>GTC</ListingDuration>
  <ListingType>FixedPriceItem</ListingType>
  <Quantity>1</Quantity>
  <Location>Porterville, CA</Location>
  <PostalCode>93257</PostalCode>
  ${picXml}
  ${specsXml}
  <ReturnPolicy><ReturnsAcceptedOption>ReturnsNotAccepted</ReturnsAcceptedOption></ReturnPolicy>
  <ShippingDetails>
    <ShippingType>Flat</ShippingType>
    <ShippingServiceOptions>
      <ShippingServicePriority>1</ShippingServicePriority>
      <ShippingService>USPSPriority</ShippingService>
      <ShippingServiceCost>15.00</ShippingServiceCost>
    </ShippingServiceOptions>
  </ShippingDetails>
</Item>`;

  const resp = await ebayXml("VerifyAddFixedPriceItem", inner);
  const ack = (resp.match(/<Ack>([\s\S]*?)<\/Ack>/) || [])[1] || "unknown";
  const errors = ebayTags(resp, "LongMessage").slice(0, 6);
  return { ack, categoryId: catId, title, price, condId, photos: pics.length, errors };
});

// 📦 Descargar todas las fotos de una parte (SIN el QR) en un ZIP — para que la esposa
// las suba a eBay desde Windows/Chrome (baja a Descargas → eBay las elige del explorador).
exports.zipPartPhotos = onCall({ timeoutSeconds: 120, memory: "512MiB" }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const partId = request.data && request.data.partId;
  if (!partId) throw new HttpsError("invalid-argument", "Falta partId.");

  const db = admin.firestore();
  const snap = await db.collection("parts").doc(partId).get();
  if (!snap.exists) throw new HttpsError("not-found", "Parte no encontrada.");
  const p = snap.data();

  // Fotos reales (excluye el QR — se queda interno)
  const urls = (p.photoURLs || []).filter((u) => u && !/00_QR/.test(u));
  if (!urls.length) throw new HttpsError("failed-precondition", "La parte no tiene fotos.");

  const JSZip = require("jszip");
  const zip = new JSZip();
  const base = (p.name || "parte").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_").slice(0, 40) || "parte";
  let n = 0;
  for (const u of urls) {
    try {
      const r = await fetch(u);
      if (!r.ok) continue;
      const ct = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
      const ext = /png/.test(ct) ? "png" : /webp/.test(ct) ? "webp" : "jpg";
      const buf = Buffer.from(await r.arrayBuffer());
      n += 1;
      zip.file(base + "_" + String(n).padStart(2, "0") + "." + ext, buf);
    } catch (e) { /* saltar la que falle */ }
  }
  if (!n) throw new HttpsError("internal", "No se pudieron leer las fotos.");

  const zipBuf = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
  return { filename: base + "_fotos.zip", count: n, zipBase64: zipBuf.toString("base64") };
});

// 🤖 IA: lee las fotos de una parte y arma el anuncio de eBay (título + descripción + OEM + specifics)
exports.prepareEbay = onCall({ secrets: [ANTHROPIC_KEY], timeoutSeconds: 240, memory: "512MiB" }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const partId = request.data && request.data.partId;
  if (!partId) throw new HttpsError("invalid-argument", "Falta partId.");

  const db = admin.firestore();
  const snap = await db.collection("parts").doc(partId).get();
  if (!snap.exists) throw new HttpsError("not-found", "Parte no encontrada.");
  const p = snap.data();

  // Fotos reales (sin el QR): SOLO las 3 primeras. El flujo de captura sube en orden
  // 1-2 = números/etiquetas, 3 = general. Con eso el bot tiene todo (números + identificación)
  // sin pagar por las 4-5 fotos extra que van al anuncio pero no aportan a la IA. Baja costo ~60%.
  const urls = (p.photoURLs || []).filter((u) => u && !/00_QR/.test(u)).slice(0, 3);
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
  // Modelo (para comparar Sonnet vs Haiku) + modo "no guardar" (comparación no pisa el borrador bueno)
  const MODELS = { sonnet: "claude-sonnet-5", haiku: "claude-haiku-4-5" };
  const reqModel = (request.data && request.data.model) || "";
  const MODEL = MODELS[reqModel] || (Object.values(MODELS).indexOf(reqModel) >= 0 ? reqModel : "claude-sonnet-5");
  const doSave = !(request.data && request.data.save === false);
  let prompt = `You are an expert US used auto-parts lister for eBay Motors.
This part was removed from a "${veh || "vehicle"}" — BUT that stated vehicle may be wrong; trust the actual part number over it.
The seller labeled it: "${p.name || ""}". Stated condition: "${p.condition || "Used"}".
STEP 1 — Read the photos carefully. Identify the part and read ALL numbers stamped/labeled on it. IGNORE connector pin numbers (e.g. "5 4 3 2 1" printed by the plug) — those are NOT part numbers.
STEP 2 — USE WEB SEARCH to: (a) verify the real OEM/manufacturer part number, (b) find which vehicles it ACTUALLY fits, and (c) find interchange / superseded numbers (widens buyers). If the read part number does NOT fit the stated vehicle, note it in "fitmentNote".
STEP 2b — MANY PARTS HAVE NO READABLE NUMBER. When you cannot read a part number on the part, still DETERMINE the OEM number it SHOULD be: use web search with the vehicle (${veh || "the stated vehicle"}) + the part name + what you see in the photos to find the most likely correct OEM/manufacturer part number for THIS exact part on THIS vehicle. Put that in "suggestedPartNumber" (single best number) and briefly say how sure you are in "fitmentNote". If the exact number depends on trim/engine/options you cannot see, give the best candidate and say so — a strong lead the human will verify. Only leave it empty if you truly cannot narrow it down at all.
STEP 3 — Return ONLY valid JSON (no markdown, no backticks) with EXACTLY these keys:
{"title": "<=80 char keyword-rich eBay title with VERIFIED fitment",
 "description": "2-4 sentences that COMPLEMENT eBay's auto-generated description (do NOT write generic catalog filler): focus on THIS specific used part — its real condition & visible wear, the VERIFIED fitment, and interchange numbers. This is a seller's condition/fitment note.",
 "partNumbers": ["numbers you actually READ on the part; [] if none"],
 "suggestedPartNumber": "best OEM number this part SHOULD be (from web search) when none was readable; '' if you truly cannot determine one",
 "interchange": ["interchange/alternate numbers found via web search; [] if none"],
 "fitsVehicles": "short verified list of vehicles it fits (from web search)",
 "fitmentNote": "" ,
 "condition": "Used" | "For parts or not working" | "New",
 "itemSpecifics": {"Brand": "", "Manufacturer Part Number": "", "Placement on Vehicle": "", "Fitment": ""},
 "confidence": "high" | "medium" | "low"}
Never invent a number you READ (partNumbers must be real reads). But suggestedPartNumber is EXPECTED to be a researched best-guess — provide it whenever you reasonably can. Base fitment on web search, not guesses. Put a warning in "fitmentNote" if the part does not match the stated vehicle.`;

  if (feedback) {
    prompt += `\n\nThe user REVIEWED a previous AI draft and gave this correction/instruction (in Spanish or English): "${feedback}". Apply it precisely — the user is the human expert who is looking at the real part.`;
    if (p.ebayDraft) prompt += `\nThe previous draft was: ${JSON.stringify({ title: p.ebayDraft.title, description: p.ebayDraft.description, partNumbers: p.ebayDraft.partNumbers })}.`;
  }

  const AnthropicMod = require("@anthropic-ai/sdk");
  const Anthropic = AnthropicMod.Anthropic || AnthropicMod.default || AnthropicMod;
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY.value() });

  let text = "", usage = {};
  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      // cache_control en el ÚLTIMO bloque → cachea fotos+prompt. Las búsquedas web re-leen ese prefijo
      // desde caché (~10% del costo) en vez de re-procesar las fotos cada vez. Baja mucho el gasto.
      messages: [{ role: "user", content: [...images, { type: "text", text: prompt, cache_control: { type: "ephemeral" } }] }],
    });
    usage = msg.usage || {};
    text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  } catch (e) {
    throw new HttpsError("internal", "IA: " + (e.message || "error"));
  }
  const inTok = usage.input_tokens || 0, outTok = usage.output_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0, cacheRead = usage.cache_read_input_tokens || 0;
  const searches = (usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0;
  // Precio por modelo: entrada $/M, salida $/M. Caché: escritura = entrada×1.25, lectura = entrada×0.10. Búsqueda $0.01.
  const PRICES = { "claude-sonnet-5": { in: 3, out: 15 }, "claude-haiku-4-5": { in: 1, out: 5 } };
  const pr = PRICES[MODEL] || PRICES["claude-sonnet-5"];
  const costUsd = +(((inTok / 1e6) * pr.in) + ((cacheWrite / 1e6) * pr.in * 1.25) + ((cacheRead / 1e6) * pr.in * 0.10) + ((outTok / 1e6) * pr.out) + (searches * 0.01)).toFixed(5);

  let draft;
  try {
    const m = text.match(/\{[\s\S]*\}/);
    draft = JSON.parse(m ? m[0] : text);
  } catch (e) {
    draft = { title: (p.ebayTitle || p.name || ""), description: text.slice(0, 500), partNumbers: [], condition: p.condition || "Used", itemSpecifics: {}, confidence: "low", raw: text.slice(0, 800) };
  }
  draft.generatedAt = new Date().toISOString();
  draft.by = (request.auth.token && request.auth.token.email) || "";
  draft.model = MODEL;
  draft.tokens = { input: inTok, output: outTok, cacheWrite, cacheRead };
  draft.searches = searches;
  draft.costUsd = costUsd;   // costo estimado de ESTA generación (para el análisis de costos)
  if (feedback) draft.lastFeedback = feedback;

  if (doSave) await db.collection("parts").doc(partId).update({ ebayDraft: draft, ebayDraftAt: draft.generatedAt });
  return draft;
});
