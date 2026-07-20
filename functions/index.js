// Legacy DMS — backend (Cloud Functions v2)
// redeploy marker: ebay oauth refresh v3
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
const EBAY_OAUTH_REFRESH = defineSecret("EBAY_OAUTH_REFRESH");

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

// 🔑 OAuth callback: eBay redirige aquí con ?code=... tras el consentimiento. Intercambia el code por refresh token y lo muestra.
const EBAY_RUNAME = "legacy_motors_g-legacymo-legacy-xpjkv";   // RuName de eBay (identificador del redirect, no secreto)
exports.ebayOAuthCallback = onRequest({ secrets: [EBAY_APP_ID, EBAY_CERT_ID] }, async (req, res) => {
  const code = req.query.code;
  if (!code) { res.status(400).send("Falta ?code — abre el enlace de consentimiento de eBay primero."); return; }
  try {
    const basic = Buffer.from(EBAY_APP_ID.value() + ":" + EBAY_CERT_ID.value()).toString("base64");
    const r = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
      method: "POST",
      headers: { "Authorization": "Basic " + basic, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=authorization_code&code=" + encodeURIComponent(String(code)) + "&redirect_uri=" + encodeURIComponent(EBAY_RUNAME),
    });
    const j = await r.json();
    if (j.refresh_token) {
      const days = Math.round((j.refresh_token_expires_in || 0) / 86400);
      res.status(200).send(`<!doctype html><html><body style="font-family:-apple-system,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;">
        <h2>✅ Autorización exitosa</h2>
        <p>Copia este <b>refresh token</b> y pégalo en <b>Secret Manager</b> con el nombre <code>EBAY_OAUTH_REFRESH</code>:</p>
        <textarea readonly style="width:100%;height:120px;font-size:12px;" onclick="this.select()">${j.refresh_token}</textarea>
        <p style="color:#666;">Válido ~${days} días. No lo compartas.</p>`);
    } else {
      res.status(200).send("<pre style='white-space:pre-wrap;'>" + JSON.stringify(j, null, 2) + "</pre>");
    }
  } catch (e) { res.status(500).send("Error: " + (e.message || e)); }
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
// Token de aplicación (client-credentials) con App ID + Cert ID — para las APIs REST públicas (Taxonomy)
async function ebayAppToken(){
  const basic = Buffer.from(EBAY_APP_ID.value() + ":" + EBAY_CERT_ID.value()).toString("base64");
  const r = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: { "Authorization": "Basic " + basic, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  });
  const j = await r.json();
  return j.access_token || "";
}
// Sugerencia de categoría LEAF (Taxonomy API). Prefiere una bajo eBay Motors (ancestro 6000).
async function ebayCategorySuggest(query){
  const tok = await ebayAppToken();
  if (!tok) return { id: "", ack: "notoken" };
  const r = await fetch("https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=" + encodeURIComponent(query), {
    headers: { "Authorization": "Bearer " + tok },
  });
  const j = await r.json();
  const sugg = j.categorySuggestions || [];
  const isMotors = (s) => (s.categoryTreeNodeAncestors || []).some((a) => /ebay motors|car\s*&\s*truck/i.test(a.categoryName || ""));
  const pick = sugg.find(isMotors) || sugg[0];
  return { id: (pick && pick.category) ? pick.category.categoryId : "", ack: sugg.find(isMotors) ? "motors" : (sugg.length ? "nonmotors" : "empty") };
}
// Aspectos (item specifics) que eBay pide para una categoría
async function ebayCategoryAspects(catId){
  const tok = await ebayAppToken();
  if (!tok) return [];
  const r = await fetch("https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=" + encodeURIComponent(catId), {
    headers: { "Authorization": "Bearer " + tok },
  });
  const j = await r.json();
  return (j.aspects || []).map((a) => ({ name: a.localizedAspectName, required: !!(a.aspectConstraint && a.aspectConstraint.aspectRequired) }));
}

const EBAY_SECRETS = [EBAY_APP_ID, EBAY_DEV_ID, EBAY_CERT_ID, EBAY_AUTH_TOKEN];

// 🔑 Access token de USUARIO (refresh_token grant) — para las APIs REST de vender (Inventory/Account). Scopes sell.inventory + sell.account.
async function ebayUserAccessToken(scope){
  const rt = (EBAY_OAUTH_REFRESH.value() || "").trim();  // limpia espacios/saltos si se pegó con basura
  const basic = Buffer.from(EBAY_APP_ID.value() + ":" + EBAY_CERT_ID.value()).toString("base64");
  const scopes = scope || "https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.account";
  const r = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: { "Authorization": "Basic " + basic, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=refresh_token&refresh_token=" + encodeURIComponent(rt) +
          "&scope=" + encodeURIComponent(scopes),
  });
  const j = await r.json().catch(() => ({}));
  return { token: j.access_token || "", raw: j };
}

// 🧪 Prueba OAuth: confirma que el refresh token da un access token con permiso sell.inventory.
exports.ebayOauthTest = onCall({ secrets: [EBAY_APP_ID, EBAY_CERT_ID, EBAY_OAUTH_REFRESH], timeoutSeconds: 60 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  let a = await ebayUserAccessToken();  // intenta ambos scopes
  let scopeNote = "sell.inventory + sell.account";
  if (!a.token) {  // reintenta con solo sell.inventory (por si no se consintió sell.account)
    const b = await ebayUserAccessToken("https://api.ebay.com/oauth/api_scope/sell.inventory");
    if (b.token) { a = b; scopeNote = "solo sell.inventory (sell.account NO consentido)"; }
  }
  if (!a.token) {
    const err = a.raw || {};
    return { ok: false, status: 0, body: "Token error: " + (err.error || "?") + " — " + (err.error_description || "sin detalle") };
  }
  const r = await fetch("https://api.ebay.com/sell/inventory/v1/location?limit=1", { headers: { "Authorization": "Bearer " + a.token } });
  const status = r.status;
  let body = ""; try { body = await r.text(); } catch (e) {}
  return { ok: status >= 200 && status < 300, status, scope: scopeNote, body: (body || "").slice(0, 300) };
});

async function loadPart(partId){
  if (!partId) throw new HttpsError("invalid-argument", "Falta partId.");
  const snap = await admin.firestore().collection("parts").doc(partId).get();
  if (!snap.exists) throw new HttpsError("not-found", "Parte no encontrada.");
  return Object.assign({ id: partId }, snap.data());
}

// Resuelve la CATEGORÍA de eBay Motors desde la frase de la IA (sesgo "car truck" + filtro estricto Motors)
async function resolveCategory(p){
  const d = p.ebayDraft || {};
  const title = (d.title || p.ebayTitle || p.name || "Auto part").slice(0, 80);
  const catQuery = "car truck " + (d.ebayCategory || [p.vYear, p.vMake, p.vModel, p.name].filter(Boolean).join(" ") || title);
  let catAck = "", catId = "";
  try { const c = await ebayCategorySuggest(catQuery); catId = c.id; catAck = c.ack; } catch (e) { catAck = "err:" + (e.message || e); }
  if (!catId) catId = "6030";
  return { catId, catAck };
}

// Resuelve los ITEM SPECIFICS (compartido por el camino XML/Trading y el JSON/Inventory).
// Pide a eBay los aspectos de ESA categoría y los llena con lo que tenemos (como a mano). Devuelve [{name, values:[...]}].
async function resolveSpecs(p, catId){
  const d = p.ebayDraft || {};
  const is = d.itemSpecifics || {};
  const specs = [];
  const seen = new Set();
  const addSpec = (name, values) => {
    if (!name || !values) return;
    const vals = (Array.isArray(values) ? values : [values]).map((v) => String(v).trim().slice(0, 65)).filter(Boolean).slice(0, 30);
    const k = name.toLowerCase();
    if (!vals.length || seen.has(k)) return;
    seen.add(k); specs.push({ name, values: vals });
  };
  const dataFor = (name) => {
    const n = name.toLowerCase();
    for (const k of Object.keys(is)) { if (k.toLowerCase() === n && is[k]) return [is[k]]; }              // match directo con lo de la IA
    if (/manufacturer part number|^mpn$/.test(n)) { const v = (d.partNumbers && d.partNumbers[0]) || d.suggestedPartNumber || is["Manufacturer Part Number"]; return v ? [v] : null; }
    if (/(interchange|superseded|other|alternative).*(part )?number/.test(n) && d.interchange && d.interchange.length) return d.interchange;
    if (/^brand$/.test(n) && is.Brand) return [is.Brand];
    if (/placement/.test(n)) { const v = is["Placement on Vehicle"] || is.Placement; return v ? [v] : null; }
    if (/warranty/.test(n)) return ["No Warranty"];
    if (/^type$/.test(n) && p.name) return [p.name];
    if (/non-domestic|modified item|custom bundle|^bundle/.test(n)) return ["No"];
    return null;
  };
  let aspects = [];
  try { aspects = await ebayCategoryAspects(catId); } catch (e) {}
  aspects.forEach((a) => addSpec(a.name, dataFor(a.name)));                                                // llena los campos que eBay pide
  Object.keys(is).forEach((k) => { if (is[k] && !/fitment|fits|compatib/i.test(k)) addSpec(k, [is[k]]); }); // + cualquier extra de la IA
  if (!seen.has("manufacturer part number") && !seen.has("mpn")) { const mpn = (d.partNumbers && d.partNumbers[0]) || d.suggestedPartNumber; if (mpn) addSpec("Manufacturer Part Number", [mpn]); }
  return specs;
}

// Arma el <Item> XML del anuncio a partir de la parte (compartido por Verificar y Publicar)
async function buildEbayItem(p, priceUsd){
  const d = p.ebayDraft || {};
  const title = (d.title || p.ebayTitle || p.name || "Auto part").slice(0, 80);
  const desc = (d.description || p.name || "");
  const price = priceUsd ? Number(priceUsd).toFixed(2) : (((p.priceCents != null ? p.priceCents : 999) / 100)).toFixed(2);
  const condMap = { "New": "1000", "Used": "3000", "For parts or not working": "7000" };
  const condId = condMap[d.condition || p.condition] || "3000";

  const { catId, catAck } = await resolveCategory(p);

  const pics = (p.photoURLs || []).filter((u) => u && !/00_QR/.test(u)).slice(0, 12);
  const picXml = pics.length ? `<PictureDetails>${pics.map((u) => `<PictureURL>${xesc(u)}</PictureURL>`).join("")}</PictureDetails>` : "";

  const specs = await resolveSpecs(p, catId);
  const specsXml = specs.length ? `<ItemSpecifics>${specs.map((s) => `<NameValueList><Name>${xesc(s.name)}</Name>${s.values.map((v) => `<Value>${xesc(v)}</Value>`).join("")}</NameValueList>`).join("")}</ItemSpecifics>` : "";
  const inner = `<Item>
  <SKU>${xesc(p.id || p.entryId || "")}</SKU>
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
  return { inner, catId, catAck, title, price, condId, photos: pics.length };
}

// 🧪 Verificar anuncio (VerifyAddFixedPriceItem) — valida sin publicar. Cero riesgo.
exports.ebayVerifyListing = onCall({ secrets: EBAY_SECRETS, timeoutSeconds: 120 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const p = await loadPart(request.data && request.data.partId);
  const it = await buildEbayItem(p, request.data && request.data.priceUsd);
  const resp = await ebayXml("VerifyAddFixedPriceItem", it.inner);
  const ack = (resp.match(/<Ack>([\s\S]*?)<\/Ack>/) || [])[1] || "unknown";
  return { ack, categoryId: it.catId, catAck: it.catAck, title: it.title, price: it.price, condId: it.condId, photos: it.photos, errors: ebayTags(resp, "LongMessage").slice(0, 6) };
});

// 🚀 Publicar anuncio EN VIVO (AddFixedPriceItem) — crea el anuncio real. El front pide confirmación + precio.
exports.ebayPublishListing = onCall({ secrets: EBAY_SECRETS, timeoutSeconds: 120 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const p = await loadPart(request.data && request.data.partId);
  const priceUsd = request.data && request.data.priceUsd;
  const it = await buildEbayItem(p, priceUsd);
  const resp = await ebayXml("AddFixedPriceItem", it.inner);
  const ack = (resp.match(/<Ack>([\s\S]*?)<\/Ack>/) || [])[1] || "unknown";
  const itemId = ebayTags(resp, "ItemID")[0] || "";
  const errors = ebayTags(resp, "LongMessage").slice(0, 6);
  if ((ack === "Success" || ack === "Warning") && itemId) {
    const upd = { ebayItemId: itemId, ebayListedAt: new Date().toISOString(), status: "publicado" };
    if (priceUsd) upd.priceCents = Math.round(Number(priceUsd) * 100);
    await admin.firestore().collection("parts").doc(p.id).update(upd);
  }
  return { ack, itemId, categoryId: it.catId, price: it.price, errors };
});

// ═══════════════════════════════════════════════════════════════════════════
// 🅱️  FLUJO DE BORRADOR (OAuth + Inventory API REST) — publicar con 1 clic + revisión humana
// ═══════════════════════════════════════════════════════════════════════════

const EBAY_LOC_KEY = "LMG_PORTERVILLE";

// Llamada REST genérica a las APIs de vender de eBay (Inventory/Account). token = access token de usuario.
async function ebayRest(method, path, token, body){
  const r = await fetch("https://api.ebay.com" + path, {
    method,
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Accept-Language": "en-US",
      "Content-Language": "en-US",
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null, text = "";
  try { text = await r.text(); json = text ? JSON.parse(text) : null; } catch (e) {}
  return { status: r.status, ok: r.status >= 200 && r.status < 300, json, text };
}

// Extrae mensajes de error legibles de una respuesta REST de eBay
function ebayRestErrors(r){
  const e = r.json && r.json.errors;
  if (Array.isArray(e) && e.length) return e.map((x) => (x.message || x.longMessage || "error") + (x.parameters ? (" [" + x.parameters.map((q) => q.value).join(", ") + "]") : "")).slice(0, 6);
  return [(r.text || "").slice(0, 300) || ("HTTP " + r.status)];
}

// Condición → enum del Inventory API (distinto de los IDs del Trading API)
function ebayCondEnum(c){
  const s = String(c || "").toLowerCase();
  if (/new/.test(s)) return "NEW";
  if (/parts|not working/.test(s)) return "FOR_PARTS_OR_NOT_WORKING";
  if (/fair|acceptable/.test(s)) return "USED_GOOD";
  if (/good/.test(s)) return "USED_VERY_GOOD";
  return "USED_EXCELLENT";
}

// Asegura la ubicación de inventario (ship-from). Se crea una sola vez.
async function ebayEnsureLocation(token){
  let r = await ebayRest("GET", "/sell/inventory/v1/location/" + EBAY_LOC_KEY, token);
  if (r.ok) return { key: EBAY_LOC_KEY, existed: true };
  const body = {
    location: { address: { addressLine1: "649 W Olive Ave", city: "Porterville", stateOrProvince: "CA", postalCode: "93257", country: "US" } },
    locationInstructions: "Ships from here",
    name: "Legacy Motors Garage",
    merchantLocationStatus: "ENABLED",
    locationTypes: ["WAREHOUSE"],
  };
  r = await ebayRest("POST", "/sell/inventory/v1/location/" + EBAY_LOC_KEY, token, body);
  return { key: EBAY_LOC_KEY, existed: false, created: r.ok, status: r.status, err: r.ok ? null : ebayRestErrors(r), raw: r.ok ? null : (r.text || "").slice(0, 400) };
}

// Asegura las 3 políticas (envío/pago/devolución). Usa las existentes o crea unas por defecto.
async function ebayEnsurePolicies(token){
  const out = {};
  // 0) Opt-in a Business Policies (requisito de la API). Idempotente: si ya está, eBay lo ignora.
  const opt = await ebayRest("POST", "/sell/account/v1/program/opt_in", token, { programType: "SELLING_POLICY_MANAGEMENT" });
  out.optIn = opt.ok ? "ok" : (ebayRestErrors(opt)[0] || "").slice(0, 120);
  // Envío (Fulfillment)
  let r = await ebayRest("GET", "/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US", token);
  if (!r.ok) return { optedIn: false, err: ebayRestErrors(r), raw: (r.text || "").slice(0, 400), optIn: out.optIn };
  let list = (r.json && r.json.fulfillmentPolicies) || [];
  if (list.length) out.fulfillmentPolicyId = list[0].fulfillmentPolicyId;
  else {
    const c = await ebayRest("POST", "/sell/account/v1/fulfillment_policy", token, {
      name: "LMG Flat USPS Priority", marketplaceId: "EBAY_US",
      categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES" }],
      handlingTime: { value: 3, unit: "DAY" },
      shippingOptions: [{ optionType: "DOMESTIC", costType: "FLAT_RATE",
        shippingServices: [{ sortOrder: 1, shippingCarrierCode: "USPS", shippingServiceCode: "USPSPriority",
          shippingCost: { value: "15.0", currency: "USD" }, freeShipping: false, buyerResponsibleForShipping: false }] }],
    });
    if (c.ok) out.fulfillmentPolicyId = c.json.fulfillmentPolicyId; else out.fulfillmentErr = ebayRestErrors(c);
  }
  // Pago (Payment)
  r = await ebayRest("GET", "/sell/account/v1/payment_policy?marketplace_id=EBAY_US", token);
  list = (r.json && r.json.paymentPolicies) || [];
  if (list.length) out.paymentPolicyId = list[0].paymentPolicyId;
  else {
    const c = await ebayRest("POST", "/sell/account/v1/payment_policy", token, {
      name: "LMG Payment", marketplaceId: "EBAY_US",
      categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES" }], immediatePay: true,
    });
    if (c.ok) out.paymentPolicyId = c.json.paymentPolicyId; else out.paymentErr = ebayRestErrors(c);
  }
  // Devolución (Return)
  r = await ebayRest("GET", "/sell/account/v1/return_policy?marketplace_id=EBAY_US", token);
  list = (r.json && r.json.returnPolicies) || [];
  if (list.length) out.returnPolicyId = list[0].returnPolicyId;
  else {
    const c = await ebayRest("POST", "/sell/account/v1/return_policy", token, {
      name: "LMG Returns 30d", marketplaceId: "EBAY_US",
      categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES" }],
      returnsAccepted: true, returnPeriod: { value: 30, unit: "DAY" }, returnShippingCostPayer: "BUYER",
    });
    if (c.ok) out.returnPolicyId = c.json.returnPolicyId; else out.returnErr = ebayRestErrors(c);
  }
  return out;
}

// ⚙️ Configurar cuenta de eBay para la API (una sola vez): ubicación + políticas. Guarda IDs en config/ebay.
exports.ebaySellerSetup = onCall({ secrets: [EBAY_APP_ID, EBAY_CERT_ID, EBAY_OAUTH_REFRESH], timeoutSeconds: 120 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const a = await ebayUserAccessToken();
  if (!a.token) return { ok: false, step: "token", errors: [(a.raw && a.raw.error_description) || "sin token"] };
  const loc = await ebayEnsureLocation(a.token);
  const pol = await ebayEnsurePolicies(a.token);
  const cfg = {
    locationKey: loc.key,
    fulfillmentPolicyId: pol.fulfillmentPolicyId || null,
    paymentPolicyId: pol.paymentPolicyId || null,
    returnPolicyId: pol.returnPolicyId || null,
    updatedAt: new Date().toISOString(),
  };
  await admin.firestore().collection("config").doc("ebay").set(cfg, { merge: true });
  const ready = !!(cfg.fulfillmentPolicyId && cfg.paymentPolicyId && cfg.returnPolicyId && cfg.locationKey);
  // Aggrega TODOS los errores en una lista plana y legible para el frontend
  const errors = [];
  const push = (label, v) => { if (!v) return; errors.push(label + ": " + (Array.isArray(v) ? v.join(" | ") : String(v))); };
  if (!loc.existed && !loc.created) { push("Ubicación (HTTP " + (loc.status || "?") + ")", loc.err); push("Ubicación raw", loc.raw); }
  if (pol.optIn && pol.optIn !== "ok") push("Opt-in Business Policies", pol.optIn);
  push("Políticas (GET falló)", pol.err);
  push("Políticas raw", pol.raw);
  push("Envío", pol.fulfillmentErr);
  push("Pago", pol.paymentErr);
  push("Devolución", pol.returnErr);
  return { ok: ready, location: loc, policies: pol, cfg, errors };
});

// Arma el payload JSON (inventory item) para el Inventory API
async function buildInventoryItem(p){
  const d = p.ebayDraft || {};
  const title = (d.title || p.ebayTitle || p.name || "Auto part").slice(0, 80);
  const desc = (d.description || p.name || "");
  const { catId } = await resolveCategory(p);
  const pics = (p.photoURLs || []).filter((u) => u && !/00_QR/.test(u)).slice(0, 24);
  const specs = await resolveSpecs(p, catId);
  const aspects = {};
  specs.forEach((s) => { aspects[s.name] = s.values; });
  const is = d.itemSpecifics || {};
  const mpn = (d.partNumbers && d.partNumbers[0]) || d.suggestedPartNumber || is["Manufacturer Part Number"];
  const brand = is.Brand || "Unbranded";
  const product = { title, description: desc, aspects, imageUrls: pics, brand };
  if (mpn) product.mpn = mpn;
  const invItem = {
    availability: { shipToLocationAvailability: { quantity: 1 } },
    condition: ebayCondEnum(d.condition || p.condition),
    product,
  };
  return { sku: String(p.id), invItem, title, desc, catId, photos: pics.length, aspects: Object.keys(aspects).length };
}

// 📝 Crear BORRADOR en eBay (Inventory API: inventory item + oferta SIN publicar). No sale en vivo.
exports.ebayCreateDraft = onCall({ secrets: [EBAY_APP_ID, EBAY_CERT_ID, EBAY_OAUTH_REFRESH], timeoutSeconds: 120 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const p = await loadPart(request.data && request.data.partId);
  const priceUsd = request.data && request.data.priceUsd;
  const a = await ebayUserAccessToken();
  if (!a.token) return { ok: false, step: "token", errors: [(a.raw && a.raw.error_description) || "sin token"] };

  const cfgSnap = await admin.firestore().collection("config").doc("ebay").get();
  const cfg = cfgSnap.exists ? cfgSnap.data() : {};
  if (!cfg.fulfillmentPolicyId || !cfg.paymentPolicyId || !cfg.returnPolicyId || !cfg.locationKey) {
    return { ok: false, step: "setup", errors: ["Falta configurar la cuenta. Corre '⚙️ Configurar eBay' primero."] };
  }

  const b = await buildInventoryItem(p);
  const price = priceUsd ? Number(priceUsd).toFixed(2) : (((p.priceCents != null ? p.priceCents : 999) / 100)).toFixed(2);

  // 1) Inventory item (idempotente por SKU)
  const inv = await ebayRest("PUT", "/sell/inventory/v1/inventory_item/" + encodeURIComponent(b.sku), a.token, b.invItem);
  if (!inv.ok) return { ok: false, step: "inventory_item", status: inv.status, errors: ebayRestErrors(inv) };

  // 2) Oferta SIN publicar = borrador. Reusa la oferta si ya existe para este SKU.
  let offerId = "";
  const exist = await ebayRest("GET", "/sell/inventory/v1/offer?sku=" + encodeURIComponent(b.sku) + "&marketplace_id=EBAY_US", a.token);
  if (exist.ok && exist.json && exist.json.offers && exist.json.offers.length) offerId = exist.json.offers[0].offerId;
  const offerBody = {
    sku: b.sku, marketplaceId: "EBAY_US", format: "FIXED_PRICE", availableQuantity: 1,
    categoryId: b.catId, listingDescription: b.desc,
    listingPolicies: { fulfillmentPolicyId: cfg.fulfillmentPolicyId, paymentPolicyId: cfg.paymentPolicyId, returnPolicyId: cfg.returnPolicyId },
    pricingSummary: { price: { value: price, currency: "USD" } },
    merchantLocationKey: cfg.locationKey,
  };
  let offer;
  if (offerId) offer = await ebayRest("PUT", "/sell/inventory/v1/offer/" + offerId, a.token, offerBody);
  else offer = await ebayRest("POST", "/sell/inventory/v1/offer", a.token, offerBody);
  if (!offer.ok) return { ok: false, step: "offer", status: offer.status, errors: ebayRestErrors(offer) };
  if (!offerId) offerId = offer.json && offer.json.offerId;

  const upd = { ebayOfferId: offerId, ebayDraftCat: b.catId, ebayDraftAt: new Date().toISOString(), status: "borrador" };
  if (priceUsd) upd.priceCents = Math.round(Number(priceUsd) * 100);
  await admin.firestore().collection("parts").doc(p.id).update(upd);

  return { ok: true, offerId, categoryId: b.catId, title: b.title, price, photos: b.photos, aspects: b.aspects };
});

// 🚀 Publicar la oferta EN VIVO (después de que la revisen). 1 clic → anuncio real.
exports.ebayPublishOffer = onCall({ secrets: [EBAY_APP_ID, EBAY_CERT_ID, EBAY_OAUTH_REFRESH], timeoutSeconds: 120 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const p = await loadPart(request.data && request.data.partId);
  let offerId = p.ebayOfferId;
  const a = await ebayUserAccessToken();
  if (!a.token) return { ok: false, step: "token", errors: [(a.raw && a.raw.error_description) || "sin token"] };
  if (!offerId) {
    const exist = await ebayRest("GET", "/sell/inventory/v1/offer?sku=" + encodeURIComponent(String(p.id)) + "&marketplace_id=EBAY_US", a.token);
    if (exist.ok && exist.json && exist.json.offers && exist.json.offers.length) offerId = exist.json.offers[0].offerId;
  }
  if (!offerId) return { ok: false, step: "offer", errors: ["No hay borrador para esta parte. Crea el borrador primero."] };
  const r = await ebayRest("POST", "/sell/inventory/v1/offer/" + offerId + "/publish", a.token);
  if (!r.ok) return { ok: false, step: "publish", status: r.status, errors: ebayRestErrors(r) };
  const listingId = r.json && r.json.listingId;
  await admin.firestore().collection("parts").doc(p.id).update({
    ebayItemId: listingId || "", ebayListedAt: new Date().toISOString(), status: "publicado",
  });
  return { ok: true, listingId };
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
exports.prepareEbay = onCall({ secrets: [ANTHROPIC_KEY, EBAY_APP_ID, EBAY_CERT_ID], timeoutSeconds: 240, memory: "512MiB" }, async (request) => {
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
 "ebayCategory": "the exact eBay Motors category for this part as a short phrase — the specific PART TYPE, e.g. 'Mass Air Flow Sensor', 'Fuel Injector', 'Headlight Assembly', 'Alternator' — so eBay's category search lands on the right Car & Truck Parts category, NOT a generic one",
 "condition": "Used" | "For parts or not working" | "New",
 "itemSpecifics": {"Brand": "", "Manufacturer Part Number": "", "Type": "<what kind of part, e.g. Mass Air Flow Sensor>", "Placement on Vehicle": "", "Warranty": "", "Country/Region of Manufacture": "", "Superseded Part Number": ""},
 (fill as MANY itemSpecifics as you can from the photos and your knowledge — buyers filter by these; leave a value "" only if truly unknown)
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

  // Resuelve la categoría de eBay Motors desde la frase que dio la IA (getCategorySuggestions + filtro Motors) y la guarda en el draft
  try { const c = await ebayCategorySuggest(draft.ebayCategory || draft.title || ""); if (c.id) { draft.ebayCategoryId = c.id; draft.ebayCategoryAck = c.ack; } } catch (e) {}

  if (doSave) await db.collection("parts").doc(partId).update({ ebayDraft: draft, ebayDraftAt: draft.generatedAt });
  return draft;
});
