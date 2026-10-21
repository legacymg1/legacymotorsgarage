// Legacy DMS — backend (Cloud Functions v2)
// redeploy marker: push onMoneyIn trigger (IAM + eventarc service agent concedidos)
const { onCall, HttpsError, onRequest } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
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
const PLAID_CLIENT_ID = defineSecret("PLAID_CLIENT_ID");
const PLAID_SECRET = defineSecret("PLAID_SECRET");
const SQUARE_ACCESS_TOKEN = defineSecret("SQUARE_ACCESS_TOKEN");
// Zoho SMTP pass: se lee en TIEMPO DE EJECUCIÓN desde Secret Manager (no en el deploy),
// para que el despliegue no falle si el secreto aún no tiene permisos/valor.
let _zohoPassCache = null;
async function _getZohoPass() {
  if (_zohoPassCache) return _zohoPassCache;
  const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");
  const client = new SecretManagerServiceClient();
  // Prueba varios nombres por si se creó en minúsculas u otra variante (los nombres son case-sensitive).
  const names = ["ZOHO_MAIL_PASS", "zoho_mail_pass", "Zoho_Mail_Pass", "ZOHO_PASS", "zoho_pass"];
  for (const n of names) {
    try {
      const [v] = await client.accessSecretVersion({ name: "projects/legacy-motors-garage/secrets/" + n + "/versions/latest" });
      _zohoPassCache = v.payload.data.toString("utf8").trim();
      if (_zohoPassCache) return _zohoPassCache;
    } catch (e) { /* prueba el siguiente */ }
  }
  return null;
}

// Prueba: confirma que el backend está vivo.
exports.ping = onCall((request) => ({
  ok: true, msg: "backend vivo 🚀", at: new Date().toISOString(),
  uid: request.auth ? request.auth.uid : null,
}));

// 💹 Precios de mercado EN VIVO (BTC/cripto + acciones) para el portal financiero privado del dueño.
// Sin llaves, sin CORS (corre en el servidor). SOLO el dueño (ev@) puede llamarlo.
exports.marketQuotes = onCall({ timeoutSeconds: 30 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const email = ((request.auth.token && request.auth.token.email) || "").toLowerCase();
  if (email !== "ev@legacymotorsgarage.com") throw new HttpsError("permission-denied", "Solo el dueño.");
  const cryptoIds = (request.data && Array.isArray(request.data.crypto)) ? request.data.crypto.filter(Boolean).slice(0, 30) : [];
  const stocks = (request.data && Array.isArray(request.data.stocks)) ? request.data.stocks.filter(Boolean).slice(0, 40) : [];
  const out = { crypto: {}, stocks: {}, at: new Date().toISOString() };
  try {
    if (cryptoIds.length) {
      const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=" + encodeURIComponent(cryptoIds.join(",")) + "&vs_currencies=usd");
      if (r.ok) { const j = await r.json(); for (const k in j) { if (j[k] && typeof j[k].usd === "number") out.crypto[k] = j[k].usd; } }
    }
  } catch (e) { /* precios cripto no disponibles */ }
  for (const symRaw of stocks) {
    const sym = String(symRaw).toUpperCase().trim();
    if (!sym) continue;
    try {
      const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(sym) + "?interval=1d&range=1d", { headers: { "User-Agent": "Mozilla/5.0" } });
      if (r.ok) {
        const j = await r.json();
        const p = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta && j.chart.result[0].meta.regularMarketPrice;
        if (typeof p === "number") out.stocks[sym] = p;
      }
    } catch (e) { /* símbolo no disponible */ }
  }
  return out;
});

// 🔗 PLAID — conectar cuentas reales (bancos, tarjetas, Robinhood) al portal financiero privado del dueño.
// Los access_token viven SOLO en el backend (colección plaid_items, negada al cliente por las reglas). SOLO ev@.
function plaidOwnerOnly(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const email = ((request.auth.token && request.auth.token.email) || "").toLowerCase();
  if (email !== "ev@legacymotorsgarage.com") throw new HttpsError("permission-denied", "Solo el dueño.");
}
function plaidClient() {
  const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");
  const cfg = new Configuration({
    basePath: PlaidEnvironments.production,
    baseOptions: { headers: { "PLAID-CLIENT-ID": PLAID_CLIENT_ID.value(), "PLAID-SECRET": PLAID_SECRET.value() } },
  });
  return new PlaidApi(cfg);
}
const _r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

exports.plaidLinkToken = onCall({ secrets: [PLAID_CLIENT_ID, PLAID_SECRET], timeoutSeconds: 30 }, async (request) => {
  plaidOwnerOnly(request);
  const kind = (request.data && request.data.kind) === "investments" ? "investments" : "bank";
  const client = plaidClient();
  const req = {
    user: { client_user_id: "ev-owner" },
    client_name: "Legacy Finance",
    country_codes: ["US"],
    language: "en",
  };
  if (kind === "investments") {
    req.products = ["investments"];
  } else if (kind === "card") {
    // Tarjeta de crédito / tienda que solo da saldo + día de pago (ej. Merrick): pedir liabilities, no transactions.
    req.products = ["liabilities"];
  } else {
    req.products = ["transactions"];
    req.additional_consented_products = ["liabilities"];
  }
  let r;
  try {
    r = await client.linkTokenCreate(req);
  } catch (e) {
    const msg = (e && e.response && e.response.data && e.response.data.error_message) || (e && e.message) || "error desconocido";
    throw new HttpsError("failed-precondition", "Plaid: " + msg);
  }
  return { link_token: r.data.link_token };
});

exports.plaidExchange = onCall({ secrets: [PLAID_CLIENT_ID, PLAID_SECRET], timeoutSeconds: 30 }, async (request) => {
  plaidOwnerOnly(request);
  const publicToken = request.data && request.data.public_token;
  if (!publicToken) throw new HttpsError("invalid-argument", "Falta public_token.");
  const kind = (request.data && request.data.kind) === "investments" ? "investments" : "bank";
  const institution = (request.data && request.data.institution ? String(request.data.institution) : "").slice(0, 80);
  const owner = (request.data && request.data.owner) === "ella" ? "ella" : "yo";
  const client = plaidClient();
  const ex = await client.itemPublicTokenExchange({ public_token: publicToken });
  await admin.firestore().collection("plaid_items").doc(ex.data.item_id).set({
    accessToken: ex.data.access_token, itemId: ex.data.item_id, kind, institution, owner, createdAt: new Date().toISOString(),
  });
  return { ok: true, itemId: ex.data.item_id };
});

// 👤 Etiquetar de quién es una cuenta conectada (Tú / Esposa) — vista familiar en un solo portal.
exports.plaidSetOwner = onCall({ timeoutSeconds: 15 }, async (request) => {
  plaidOwnerOnly(request);
  const itemId = request.data && request.data.itemId;
  if (!itemId) throw new HttpsError("invalid-argument", "Falta itemId.");
  const owner = (request.data && request.data.owner) === "ella" ? "ella" : "yo";
  await admin.firestore().collection("plaid_items").doc(itemId).set({ owner }, { merge: true });
  return { ok: true };
});

exports.plaidSync = onCall({ secrets: [PLAID_CLIENT_ID, PLAID_SECRET], timeoutSeconds: 180 }, async (request) => {
  plaidOwnerOnly(request);
  const client = plaidClient();
  const snap = await admin.firestore().collection("plaid_items").get();
  const items = [];
  let cash = 0, cardDebt = 0, invest = 0;
  for (const d of snap.docs) {
    const it = d.data();
    const entry = { itemId: it.itemId, kind: it.kind, institution: it.institution || "", owner: it.owner || "yo", accounts: [] };
    try {
      const bal = await client.accountsBalanceGet({ access_token: it.accessToken });
      let liab = null;
      try { const l = await client.liabilitiesGet({ access_token: it.accessToken }); liab = l.data.liabilities; } catch (e) { /* sin liabilities */ }
      for (const a of bal.data.accounts) {
        const b = (a.balances && (a.balances.current != null ? a.balances.current : a.balances.available)) || 0;
        const acc = { name: a.name || a.official_name || "", mask: a.mask || "", type: a.type, subtype: a.subtype, balance: _r2(b), limit: (a.balances && a.balances.limit != null) ? _r2(a.balances.limit) : null };
        if (a.type === "depository") cash += b;
        else if (a.type === "credit") {
          cardDebt += b;
          if (liab && liab.credit) {
            const cl = liab.credit.find((c) => c.account_id === a.account_id);
            if (cl) {
              acc.stmtCloseDate = cl.last_statement_issue_date || "";                       // fecha de corte
              acc.dueDate = cl.next_payment_due_date || cl.last_payment_due_date || "";      // fecha de pago
              acc.stmtBalance = cl.last_statement_balance != null ? _r2(cl.last_statement_balance) : null; // pagar esto = sin intereses
              acc.minPayment = cl.minimum_payment_amount != null ? _r2(cl.minimum_payment_amount) : "";     // pago mínimo
              acc.lastPayAmount = cl.last_payment_amount != null ? _r2(cl.last_payment_amount) : null;
              acc.lastPayDate = cl.last_payment_date || "";
              acc.isOverdue = !!cl.is_overdue;
              const aprs = cl.aprs || [];
              const purchase = aprs.find((x) => x.apr_type === "purchase_apr");
              const special = aprs.find((x) => x.apr_type === "special");
              acc.apr = (purchase && purchase.apr_percentage != null) ? purchase.apr_percentage
                      : ((aprs[0] && aprs[0].apr_percentage != null) ? aprs[0].apr_percentage : "");  // preferir APR de COMPRA
              acc.aprs = aprs.map((x) => ({ type: x.apr_type, pct: x.apr_percentage, bal: x.balance_subject_to_apr, interest: x.interest_charge_amount }));
              if (special && special.apr_percentage != null) acc.promoApr = special.apr_percentage;  // 0%/promo detectado (sin fecha fin desde Plaid)
            }
          }
        } else if (a.type === "investment" || a.type === "brokerage") invest += b;
        entry.accounts.push(acc);
      }
    } catch (e) { entry.error = String((e && e.response && e.response.data && e.response.data.error_message) || (e && e.message) || e); }
    items.push(entry);
  }
  return { at: new Date().toISOString(), items, totals: { cash: _r2(cash), cardDebt: _r2(cardDebt), invest: _r2(invest) } };
});

exports.plaidRemove = onCall({ secrets: [PLAID_CLIENT_ID, PLAID_SECRET], timeoutSeconds: 30 }, async (request) => {
  plaidOwnerOnly(request);
  const itemId = request.data && request.data.itemId;
  if (!itemId) throw new HttpsError("invalid-argument", "Falta itemId.");
  const ref = admin.firestore().collection("plaid_items").doc(itemId);
  const doc = await ref.get();
  if (doc.exists) {
    try { await plaidClient().itemRemove({ access_token: doc.data().accessToken }); } catch (e) { /* igual lo borramos localmente */ }
    await ref.delete();
  }
  return { ok: true };
});

// 🧾 Jala las TRANSACCIONES de un año (ej. 2025) de las cuentas de banco/tarjeta conectadas por Plaid.
// Devuelve agregados (cuánto ENTRÓ a efectivo, cuánto se GASTÓ en tarjetas) + la lista para hacer CSV.
// Honesto: la cobertura depende de cada banco (devuelve la fecha más vieja que dio cada uno).
exports.plaidTransactions = onCall({ secrets: [PLAID_CLIENT_ID, PLAID_SECRET], timeoutSeconds: 540, memory: "1GiB" }, async (request) => {
  plaidOwnerOnly(request);
  const year = parseInt(request.data && request.data.year, 10) || (new Date().getFullYear() - 1);
  const start = year + "-01-01", end = year + "-12-31";
  const client = plaidClient();
  const snap = await admin.firestore().collection("plaid_items").get();
  const items = [], txns = [];
  const CAP = 25000;
  for (const d of snap.docs) {
    const it = d.data();
    if (it.kind === "investments") { items.push({ itemId: it.itemId, institution: it.institution || "", owner: it.owner || "yo", skipped: "inversión (sin transacciones)" }); continue; }
    const entry = { itemId: it.itemId, institution: it.institution || "", owner: it.owner || "yo", earliest: "", count: 0 };
    try {
      const accMap = {};
      let offset = 0, total = Infinity;
      while (offset < total) {
        const r = await client.transactionsGet({ access_token: it.accessToken, start_date: start, end_date: end, options: { count: 500, offset } });
        total = r.data.total_transactions || 0;
        (r.data.accounts || []).forEach((a) => { accMap[a.account_id] = { type: a.type, name: a.name || a.official_name || "", mask: a.mask || "" }; });
        const batch = r.data.transactions || [];
        for (const t of batch) {
          const acc = accMap[t.account_id] || {};
          const cat = (t.personal_finance_category && t.personal_finance_category.primary) || (Array.isArray(t.category) ? t.category[0] : "") || "";
          txns.push({ date: t.date, name: (t.merchant_name || t.name || "").slice(0, 80), amount: t.amount, accType: acc.type || "", acc: (acc.name || "") + (acc.mask ? (" ••" + acc.mask) : ""), inst: it.institution || "", cat, owner: it.owner || "yo", pending: !!t.pending });
          if (!entry.earliest || t.date < entry.earliest) entry.earliest = t.date;
          entry.count++;
        }
        offset += batch.length;
        if (!batch.length) break;
        if (txns.length > CAP) break;
      }
    } catch (e) { entry.error = String((e && e.response && e.response.data && e.response.data.error_message) || (e && e.message) || e); }
    items.push(entry);
    if (txns.length > CAP) break;
  }
  // Agregados. Plaid: amount>0 = sale dinero de la cuenta; amount<0 = entra dinero.
  const isXfer = (c) => /TRANSFER|LOAN_PAYMENTS|CREDIT_CARD_PAYMENT|BANK_FEES/i.test(c || "");
  let cashIn = 0, cashInNoXfer = 0, cashOut = 0, ccSpend = 0, ccSpendNoXfer = 0, ccPay = 0;
  for (const t of txns) {
    if (t.pending) continue;
    if (t.accType === "depository") {
      if (t.amount < 0) { cashIn += -t.amount; if (!isXfer(t.cat)) cashInNoXfer += -t.amount; }
      else cashOut += t.amount;
    } else if (t.accType === "credit") {
      if (t.amount > 0) { ccSpend += t.amount; if (!isXfer(t.cat)) ccSpendNoXfer += t.amount; }
      else ccPay += -t.amount;
    }
  }
  return {
    year, at: new Date().toISOString(), items,
    totals: { cashIn: _r2(cashIn), cashInNoXfer: _r2(cashInNoXfer), cashOut: _r2(cashOut), ccSpend: _r2(ccSpend), ccSpendNoXfer: _r2(ccSpendNoXfer), ccPay: _r2(ccPay) },
    txns,
  };
});

// 🌐 Traducir un mensaje corto → { es, en }. Se llama al ENVIAR al canal GROUP para guardar ambas versiones.
// Callable normal (sin Eventarc) → no necesita permisos especiales. Modelo Haiku (rápido y baratísimo).
exports.translateText = onCall({ secrets: [ANTHROPIC_KEY], timeoutSeconds: 20 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const text = String((request.data && request.data.text) || "").trim();
  if (!text) return { es: "", en: "" };
  try {
    const AnthropicMod = require("@anthropic-ai/sdk");
    const Anthropic = AnthropicMod.Anthropic || AnthropicMod.default || AnthropicMod;
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY.value() });
    const msg = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 500,
      system: "You translate short internal team chat messages for a car dealership / junkyard. Return ONLY valid JSON: {\"es\":\"<Spanish version>\",\"en\":\"<English version>\"}. Keep it natural and casual, preserve emojis, names, numbers and part references. If it's already in one language, still provide both.",
      messages: [{ role: "user", content: text.slice(0, 800) }],
    });
    const raw = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { const mm = raw.match(/\{[\s\S]*\}/); if (mm) { try { parsed = JSON.parse(mm[0]); } catch (e2) {} } }
    return { es: String((parsed && parsed.es) || text).slice(0, 1200), en: String((parsed && parsed.en) || text).slice(0, 1200) };
  } catch (e) { return { es: text, en: text }; }
});

// 💬 BOT DE AYUDA del PORTAL DEL CLIENTE — dudas de uso + de su cuenta; escala a humano. Guarda la plática para revisión.
exports.portalHelp = onCall({ secrets: [ANTHROPIC_KEY], timeoutSeconds: 40 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const data = request.data || {};
  const lang = (data.lang === "en") ? "en" : "es";
  const ctx = data.client || {};
  const history = Array.isArray(data.messages) ? data.messages.slice(-12) : [];
  const ctxLines = [
    ctx.name ? ("Nombre: " + ctx.name) : "",
    ctx.car ? ("Vehículo: " + ctx.car) : "",
    (ctx.balance != null && ctx.balance !== "") ? ("Saldo que debe: " + ctx.balance) : "",
    ctx.nextPay ? ("Próximo pago (fecha): " + ctx.nextPay) : "",
    (ctx.payAmount != null && ctx.payAmount !== "") ? ("Monto del pago: " + ctx.payAmount) : "",
    (ctx.contractSigned === true) ? "Contrato: firmado" : ((ctx.contractSigned === false) ? "Contrato: aún sin firmar" : ""),
  ].filter(Boolean).join("\n");
  const SYS =
`Eres el asistente del PORTAL DE CLIENTES de Legacy Motors Garage (dealer de autos usados, Buy Here Pay Here, en Porterville, CA). Atiendes a un cliente que YA inició sesión en su portal.
Responde SIEMPRE en ${lang === "en" ? "English" : "español"}, claro, corto y amable (de tú). Usa máximo 2-4 oraciones por respuesta.
PUEDES ayudar con:
- Cómo PAGAR: desde el portal con el botón de pago (Square). Por el link se agrega un cargo por servicio de 2.9% (ej. $100 → $102.90); su deuda baja por el monto base.
- Dónde VER/descargar su CONTRATO firmado.
- Su SALDO y su próximo PAGO (usa los datos de "CUENTA DEL CLIENTE"; si no los tienes, dile que los ve en la pantalla principal del portal).
- Subir su LICENCIA/IDENTIFICACIÓN y su SEGURO.
- Agendar un SERVICIO.
- Ver y APROBAR su ESTIMADO de servicio: en su portal aparece el estimado de su carro (trabajos, partes y total); puede marcar la casilla para recibir mensajes y tocar "Aceptar estimado". Es un estimado y puede cambiar tras la inspección; le avisamos antes de cualquier trabajo extra. Si no le aparece el estimado, dile que lo abrimos nosotros y le mandamos el enlace por mensaje.
REGLAS:
- Usa SOLO los datos de la cuenta que te doy abajo; NUNCA inventes montos ni fechas. Si falta un dato, dilo y dile dónde verlo.
- NO des asesoría legal ni cambies montos/acuerdos/fechas. Para disputas, cambios de pago, prórrogas, o algo delicado o que no puedas resolver → dile que toque el botón "Hablar con Legacy" para hablar con una persona.
CUENTA DEL CLIENTE:
${ctxLines || "(sin datos de cuenta)"}`;
  try {
    const AnthropicMod = require("@anthropic-ai/sdk");
    const Anthropic = AnthropicMod.Anthropic || AnthropicMod.default || AnthropicMod;
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY.value() });
    const msgs = history
      .map((m) => ({ role: (m.role === "assistant" ? "assistant" : "user"), content: String(m.text || m.content || "").slice(0, 2000) }))
      .filter((m) => m.content);
    if (!msgs.length) throw new HttpsError("invalid-argument", "Mensaje vacío.");
    const resp = await client.messages.create({ model: "claude-sonnet-5", max_tokens: 500, system: SYS, messages: msgs });
    const reply = (resp.content && resp.content[0] && resp.content[0].text) || "";
    try {
      const cid = String(data.clientId || "anon").slice(0, 80);
      await admin.firestore().collection("portal_bot_convos").doc(cid).set({
        clientId: cid, name: ctx.name || "", lastAt: new Date().toISOString(),
        messages: admin.firestore.FieldValue.arrayUnion(
          { role: "user", text: msgs[msgs.length - 1].content, at: new Date().toISOString() },
          { role: "assistant", text: reply, at: new Date().toISOString() }
        ),
      }, { merge: true });
    } catch (e) { console.error("portalHelp save", e); }
    return { reply };
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    console.error("portalHelp", e);
    throw new HttpsError("internal", String((e && e.message) || e));
  }
});

// ✨ GENERA EL POST BILINGÜE para Facebook Marketplace de un carro del inventario.
// onRequest + CORS (index.html no tiene el SDK de Functions). Protegido con el ID token del usuario.
// Reglas anti-baneo de Marketplace: NADA de "financing/credit/approval/warranty included/buy here pay here".
exports.generateCarPost = onRequest({ secrets: [ANTHROPIC_KEY], cors: true, timeoutSeconds: 45 }, async (req, res) => {
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  try {
    const body = req.body || {};
    // Seguridad: solo personal con sesión iniciada (verifica el ID token de Firebase que manda el frontend).
    const idToken = String(body.idToken || "");
    if (!idToken) { res.status(401).json({ error: "auth" }); return; }
    try { await admin.auth().verifyIdToken(idToken); }
    catch (e) { res.status(401).json({ error: "auth" }); return; }

    const car = body.car || {};
    const feats = Array.isArray(body.features) ? body.features.slice(0, 40) : [];
    const extra = String(body.extra || "").slice(0, 400);
    let downPct = parseInt(body.downPct, 10); if (!(downPct > 0 && downPct <= 100)) downPct = 50;

    // Datos REALES del VIN decode (solo hechos verdaderos; el bot no inventa).
    const spec = car.spec && typeof car.spec === "object" ? car.spec : null;
    const specFacts = spec ? Object.keys(spec)
      .filter((k) => ["bodyClass","body","doors","driveType","drive","engineCylinders","cylinders","displacementL","fuelType","transmissionStyle","transmission","series","trim"].includes(k))
      .map((k) => k + ": " + spec[k]).filter((s) => s && !/: (null|undefined|)$/.test(s)).slice(0, 12) : [];

    const payload = {
      year: car.year || "", make: car.make || "", model: car.model || "", trim: car.trim || "",
      color: car.color || "", miles: car.miles || "", price: car.price || "",
      vinSpec: specFacts,
      features: feats,      // [{en, es}, ...]
      extra: extra,         // texto libre del vendedor (ej. "2 juegos de llaves, rines nuevos")
      downPct: downPct,
    };

    const system = "You write ONE Facebook Marketplace post for a used-car dealership (Legacy Motors Garage LLC, 21122 Ave 152, Porterville, CA 93257, phone (559) 540-5145).\n\n" +
      "OUTPUT FORMAT — strict:\n" +
      "- BILINGUAL on the SAME line: English first, then ' | ', then Spanish. EVERY content line must be bilingual so the buyer never scrolls to find their language.\n" +
      "- Line 1: a 🔥 headline with the {year} {make} {model} {trim} + the single strongest hook (e.g. Clean Title, Low Miles) + 'Ready to Drive!' — bilingual, wrapped in 🔥 ... 🔥 feel. The first ~180 characters are the mobile preview, so pack the hook here.\n" +
      "- Then ✅ feature lines, ONE per feature, bilingual. Use ONLY the features given in 'features' and anything in 'extra'. NEVER invent a feature. If a VIN spec fact is clearly a selling point (e.g. body style, cylinders, automatic transmission, AWD/4WD) you may add it as a ✅ line, but never state fuel-economy numbers.\n" +
      "- Then one ✨ summary line: warm, honest, 1 short sentence each language.\n" +
      "- Then one 💰 call-to-action line, worded EXACTLY like this (replace PCT with the downPct number): \"💰 Ask how you can take it home with PCT% today! | ¡Pregunta cómo puedes llevártelo con el PCT% hoy mismo!\". Do NOT add any other words about payments, down payment, 'enganche', or plans — just this line.\n" +
      "- Then 📍 address line (the dealership address) and 📞 phone line.\n\n" +
      "BANNED — these get the post removed/banned on Facebook Marketplace, NEVER use any of them in any language: financing, finance, we finance, credit, 'no credit', 'bad credit', 'guaranteed approval', approval, approved, APR, loan, interest, 'buy here pay here', 'warranty included', 'warranty', 'down payment', 'down', 'enganche', 'payment plan', 'plan de pagos', 'monthly', 'weekly', 'mensual', 'semanal'. The ONLY thing you may say about money/payments is the exact call-to-action line above (the 'PCT% today' line) plus, optionally, the vehicle price. Never promise approval or mention credit in any way.\n\n" +
      "STYLE: clean, modern, trustworthy — like the best US used-car dealers. Punchy emoji bullets. Keep the whole post UNDER 1300 characters total. Natural Spanish (Mexican, warm). Return ONLY the post text, ready to paste — no markdown, no code fences, no notes.";

    const AnthropicMod = require("@anthropic-ai/sdk");
    const Anthropic = AnthropicMod.Anthropic || AnthropicMod.default || AnthropicMod;
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY.value() });
    const msg = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1100,
      system: system,
      messages: [{ role: "user", content: "Make the Facebook Marketplace post for this vehicle. Data (JSON):\n" + JSON.stringify(payload) }],
    });
    let post = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    // Red de seguridad: quita cercos de código si el modelo los puso.
    post = post.replace(/^```[a-z]*\n?/i, "").replace(/```$/,"").trim();
    res.status(200).json({ post: post.slice(0, 4900) });
  } catch (e) {
    console.error("generateCarPost error", e);
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

// ===== 📸 ESCANEAR RECIBO → autollenar gasto (Finanzas). Claude visión. onCall (finanzas tiene el SDK). =====
exports.scanReceipt = onCall({ secrets: [ANTHROPIC_KEY], timeoutSeconds: 45 }, async (request) => {
  if (!request.auth) { throw new HttpsError("unauthenticated", "Inicia sesión."); }
  const data = request.data || {};
  let b64 = String(data.imageBase64 || "");
  let mt = String(data.mediaType || "image/jpeg");
  if (b64.indexOf("base64,") >= 0) {
    const pre = b64.slice(0, b64.indexOf("base64,"));
    const m = pre.match(/image\/(jpeg|png|webp|gif)/i);
    if (m) mt = "image/" + m[1].toLowerCase();
    b64 = b64.split("base64,").pop();
  }
  if (!b64) { throw new HttpsError("invalid-argument", "Falta la imagen."); }
  const cats = Array.isArray(data.categories) ? data.categories.slice(0, 30) : [];
  const today = new Date().toISOString().slice(0, 10);
  const sys = "You read a photo of a purchase receipt or invoice for a used-car dealership / parts yard. " +
    "Extract the data and return ONLY a strict JSON object — no prose, no code fences. Keys:\n" +
    "- amount: the GRAND TOTAL finally payable for this purchase, in dollars, INCLUDING tax (number). " +
    "It is the number next to the FINAL total label (usually at the BOTTOM): Total, TOTAL, Total Due, Amount Due, Balance Due, Grand Total, Total a Pagar, Importe Total, or similar. " +
    "It is almost ALWAYS the LARGEST dollar amount on the receipt, and it must be >= the subtotal and >= every single line item. " +
    "NEVER use as the amount: a single line-item price, a unit price, the subtotal, the tax by itself, the amount tendered / cash given / change, an order/invoice/receipt/transaction number, a phone number, an account or card number, a date, a store number, or a quantity. " +
    "If a GIFT CARD, rewards, or points were applied, DO NOT subtract them: the amount is the FULL grand total (goods + shipping + tax) — NOT the reduced 'amount charged to card' / 'non-gift-card amount' left after the gift card. " +
    "If several totals appear (split payments, etc.) use the full grand total of the order.\n" +
    "- subtotal: the sum of the line items BEFORE tax, in dollars (number). If not printed, use the sum of the item amounts.\n" +
    "- tax: the total sales tax in dollars (number). 0 if none printed.\n" +
    "- items: an ARRAY of the individual products/line items actually purchased. Each element is an object: " +
    "{\"description\": short name of the product (keep it as printed, trimmed; Spanish ok), " +
    "\"amount\": the line's price in dollars as printed — if there is a quantity, use the EXTENDED price (qty × unit price) (number), " +
    "\"qty\": the quantity if printed else 1 (number), " +
    "\"category\": the SINGLE best category for THIS item, copied EXACTLY from this list: " + JSON.stringify(cats) + " — if none fits use \"Otro\"}. " +
    "Include ONLY real purchased products. Do NOT include subtotal, tax, total, change, or tendered as items. " +
    "NEVER include PAYMENT lines as items: Gift Card, Gift Card Amount, Gift Card Balance, Non-Gift-Card Amount, Amount Charged (to card), Rewards/Points applied, Balance Due — those are HOW it was paid, not products or discounts, so leave them out entirely. " +
    "A true price DISCOUNT on a product (e.g. 'Subscribe & Save discount', 'Coupon', 'Promotion') DOES count — include it as an item with a NEGATIVE amount. If you truly cannot read any line items, return an empty array.\n" +
    "- date: purchase date as YYYY-MM-DD. If the year is missing, assume " + today.slice(0, 4) + ". If no date is visible, use \"" + today + "\".\n" +
    "- vendor: the store/business name, short.\n" +
    "- note: a SHORT description in Spanish (2-6 words) of what was bought overall.\n" +
    "- orderNo: the order / invoice / receipt number printed on the document (e.g. 'Order #', 'Invoice #', 'Receipt #', 'Transaction #'). Letters and digits only as printed. Empty string if none.\n" +
    "- category: choose the SINGLE best match for the WHOLE receipt from the list above, copied EXACTLY. If none fits, use \"Otro\".\n" +
    "- method: one of \"cash\",\"terminal\",\"ach\",\"zelle\". Guess from the receipt (card/VISA/MASTERCARD/DEBIT => \"terminal\"; otherwise \"cash\"). Default \"cash\".\n" +
    "If a value is unknown use an empty string, except numbers (use 0) and items (use []). Return JSON only.";
  try {
    const AnthropicMod = require("@anthropic-ai/sdk");
    const Anthropic = AnthropicMod.Anthropic || AnthropicMod.default || AnthropicMod;
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY.value() });
    const msg = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 2000,
      system: sys,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mt, data: b64 } },
        { type: "text", text: "Extract the receipt data (including each line item) as strict JSON." },
      ] }],
    });
    let txt = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    txt = txt.replace(/^```[a-z]*\n?/i, "").replace(/```$/, "").trim();
    let out = {};
    try { out = JSON.parse(txt); } catch (e) { const m = txt.match(/\{[\s\S]*\}/); if (m) { try { out = JSON.parse(m[0]); } catch (_) {} } }
    const items = (Array.isArray(out.items) ? out.items : []).map((it) => ({
      description: String((it && it.description) || "").slice(0, 120),
      amount: Math.round((Number(it && it.amount) || 0) * 100) / 100,
      qty: Number(it && it.qty) || 1,
      category: String((it && it.category) || "").slice(0, 60),
    })).filter((it) => it.description || it.amount);
    // 🔎 Reconciliación del TOTAL: nunca puede ser menor que el subtotal (o la suma de productos) antes de impuestos.
    // Atrapa el caso donde el modelo agarró un número chico al azar en vez del total.
    let fixedAmount = Number(out.amount) || 0;
    const _sub = Number(out.subtotal) || 0;
    const _tax = Number(out.tax) || 0;
    const _itemsSum = Math.round(items.reduce((s, it) => s + (Number(it.amount) || 0), 0) * 100) / 100;
    // Usa la suma NETA de productos (incluye descuentos negativos) como base — así NO re-inflamos un total
    // que ya trae un descuento aplicado (Subscribe & Save, cupón). Solo cae al subtotal si no hay items.
    const _base = items.length ? _itemsSum : _sub;
    if (fixedAmount <= 0 || (_base > 0.009 && fixedAmount < _base - 0.01)) {
      const _calc = Math.round((_base + _tax) * 100) / 100;
      if (_calc > 0) fixedAmount = _calc;
    }
    return {
      amount: fixedAmount,
      subtotal: Number(out.subtotal) || 0,
      tax: Number(out.tax) || 0,
      items: items.slice(0, 60),
      date: /^\d{4}-\d{2}-\d{2}$/.test(out.date || "") ? out.date : today,
      vendor: String(out.vendor || "").slice(0, 80),
      note: String(out.note || "").slice(0, 120),
      orderNo: String(out.orderNo || "").slice(0, 50),
      category: String(out.category || "").slice(0, 60),
      method: ["cash", "terminal", "ach", "zelle"].includes(out.method) ? out.method : "cash",
    };
  } catch (e) {
    console.error("scanReceipt error", e);
    throw new HttpsError("internal", String((e && e.message) || e));
  }
});

// 🪪 LECTOR DE ID — lee una licencia / ID / pasaporte y regresa los datos del cliente para autollenar.
exports.scanId = onCall({ secrets: [ANTHROPIC_KEY], timeoutSeconds: 45 }, async (request) => {
  if (!request.auth) { throw new HttpsError("unauthenticated", "Inicia sesión."); }
  const data = request.data || {};
  let b64 = String(data.imageBase64 || "");
  let mt = String(data.mediaType || "image/jpeg");
  if (b64.indexOf("base64,") >= 0) {
    const pre = b64.slice(0, b64.indexOf("base64,"));
    const m = pre.match(/image\/(jpeg|png|webp|gif)/i);
    if (m) mt = "image/" + m[1].toLowerCase();
    b64 = b64.split("base64,").pop();
  }
  if (!b64) { throw new HttpsError("invalid-argument", "Falta la imagen."); }
  const sys = "You read a photo of a government ID: a US/Mexican driver's license, a US state ID, a passport, or a Mexican 'Matrícula Consular'. " +
    "Return ONLY a strict JSON object — no prose, no code fences. Keys:\n" +
    "- fullName: the person's full name as printed, in natural order 'First Middle Last' (fix ALL-CAPS to Title Case; keep accents/ñ). On US licenses the name may be shown Last, First.\n" +
    "- firstName: given name(s) only.\n" +
    "- lastName: family name(s) only.\n" +
    "- address: the street address line only (number + street + apt), as printed.\n" +
    "- city: city.\n" +
    "- state: 2-letter state/province code (e.g. CA). For a passport use the issuing country's region if shown, else empty.\n" +
    "- zip: postal/ZIP code.\n" +
    "- dob: date of birth as YYYY-MM-DD.\n" +
    "- idNumber: the ID / license / document number exactly as printed (letters+digits).\n" +
    "- idType: EXACTLY one of \"Driver's License\", \"State ID\", \"Passport\", \"Matricula Consular\", \"Other\".\n" +
    "- idState: the 2-letter code of the issuing state/authority (e.g. CA). Empty if not applicable.\n" +
    "- idExpiry: expiration date as YYYY-MM-DD.\n" +
    "- sex: \"M\", \"F\", or empty.\n" +
    "Convert every date to YYYY-MM-DD (US licenses print MM/DD/YYYY). If a field is not visible or unreadable, use an empty string. Return JSON only.";
  try {
    const AnthropicMod = require("@anthropic-ai/sdk");
    const Anthropic = AnthropicMod.Anthropic || AnthropicMod.default || AnthropicMod;
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY.value() });
    const msg = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 700,
      system: sys,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mt, data: b64 } },
        { type: "text", text: "Extract the ID data as strict JSON." },
      ] }],
    });
    let txt = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    txt = txt.replace(/^```[a-z]*\n?/i, "").replace(/```$/, "").trim();
    let out = {};
    try { out = JSON.parse(txt); } catch (e) { const m = txt.match(/\{[\s\S]*\}/); if (m) { try { out = JSON.parse(m[0]); } catch (_) {} } }
    const dstr = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "";
    const idTypes = ["Driver's License", "State ID", "Passport", "Matricula Consular", "Other"];
    return {
      fullName: String(out.fullName || "").slice(0, 80),
      firstName: String(out.firstName || "").slice(0, 60),
      lastName: String(out.lastName || "").slice(0, 60),
      address: String(out.address || "").slice(0, 120),
      city: String(out.city || "").slice(0, 60),
      state: String(out.state || "").slice(0, 4),
      zip: String(out.zip || "").slice(0, 12),
      dob: dstr(out.dob),
      idNumber: String(out.idNumber || "").slice(0, 40),
      idType: idTypes.includes(out.idType) ? out.idType : "",
      idState: String(out.idState || "").slice(0, 4),
      idExpiry: dstr(out.idExpiry),
      sex: ["M", "F"].includes(out.sex) ? out.sex : "",
    };
  } catch (e) {
    console.error("scanId error", e);
    throw new HttpsError("internal", String((e && e.message) || e));
  }
});

// 🔢 LECTOR DE ODÓMETRO — lee las millas de una foto del tablero (para actualizar el inventario).
exports.scanOdometer = onCall({ secrets: [ANTHROPIC_KEY], timeoutSeconds: 45 }, async (request) => {
  if (!request.auth) { throw new HttpsError("unauthenticated", "Inicia sesión."); }
  const data = request.data || {};
  let b64 = String(data.imageBase64 || "");
  let mt = String(data.mediaType || "image/jpeg");
  if (b64.indexOf("base64,") >= 0) {
    const pre = b64.slice(0, b64.indexOf("base64,"));
    const m = pre.match(/image\/(jpeg|png|webp|gif)/i);
    if (m) mt = "image/" + m[1].toLowerCase();
    b64 = b64.split("base64,").pop();
  }
  if (!b64) { throw new HttpsError("invalid-argument", "Falta la imagen."); }
  const sys = "You read a photo of a vehicle's odometer (the dashboard mileage display, digital or analog). " +
    "Return ONLY a strict JSON object — no prose, no code fences. Keys:\n" +
    "- miles: the ODOMETER total reading as an integer, digits only, NO commas and NO units (e.g. 85230). " +
    "This is the big TOTAL mileage number, NOT the trip meter. Trip meters are usually shorter, show a decimal (e.g. 123.4), or are labeled TRIP / A / B / ODO2 — ignore those. If several numbers appear, choose the main total-odometer one (usually the largest whole number). " +
    "If you cannot read it confidently, use null.\n" +
    "- unit: \"mi\" or \"km\", whichever the dashboard shows. Use \"mi\" if unsure.\n" +
    "- confidence: a number from 0 to 1 of how sure you are of the reading.\n" +
    "Return JSON only.";
  try {
    const AnthropicMod = require("@anthropic-ai/sdk");
    const Anthropic = AnthropicMod.Anthropic || AnthropicMod.default || AnthropicMod;
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY.value() });
    const msg = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 200,
      system: sys,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mt, data: b64 } },
        { type: "text", text: "Read the odometer TOTAL mileage as strict JSON." },
      ] }],
    });
    let txt = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    txt = txt.replace(/^```[a-z]*\n?/i, "").replace(/```$/, "").trim();
    let out = {};
    try { out = JSON.parse(txt); } catch (e) { const m = txt.match(/\{[\s\S]*\}/); if (m) { try { out = JSON.parse(m[0]); } catch (_) {} } }
    let miles = null;
    if (out.miles != null && out.miles !== "") {
      const n = parseInt(String(out.miles).replace(/[^0-9]/g, ""), 10);
      if (!isNaN(n) && n >= 0 && n < 2000000) miles = n;
    }
    const unit = (String(out.unit || "mi").toLowerCase().indexOf("km") >= 0) ? "km" : "mi";
    let conf = Number(out.confidence); if (isNaN(conf) || conf < 0 || conf > 1) conf = null;
    return { miles, unit, confidence: conf };
  } catch (e) {
    console.error("scanOdometer error", e);
    throw new HttpsError("internal", String((e && e.message) || e));
  }
});

// ===== 💳 PAGOS CON SQUARE (portal del cliente + "enviar cobro" desde el admin) =====
const SQUARE_LOCATION_ID = "LDTPHV3ZR18D0";       // Ubicación de Production (NO es secreto)
const SQUARE_API = "https://connect.squareup.com"; // Production
function _sqHeaders() {
  return { "Authorization": "Bearer " + SQUARE_ACCESS_TOKEN.value(), "Content-Type": "application/json", "Square-Version": "2024-10-17" };
}
// Crea un link de pago (hosted checkout de Square) para un cliente. El cliente mete su tarjeta EN SQUARE.
exports.createSquareCheckout = onRequest({ secrets: [SQUARE_ACCESS_TOKEN], cors: true, timeoutSeconds: 30 }, async (req, res) => {
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  try {
    const body = req.body || {};
    const idToken = String(body.idToken || "");
    if (!idToken) { res.status(401).json({ error: "auth" }); return; }
    try { await admin.auth().verifyIdToken(idToken); } catch (e) { res.status(401).json({ error: "auth" }); return; }
    const clientId = String(body.clientId || "").slice(0, 80);
    const amountCents = Math.round(Number(body.amountCents) || 0);
    if (!clientId) { res.status(400).json({ error: "clientId" }); return; }
    if (!(amountCents >= 100)) { res.status(400).json({ error: "amount_min" }); return; }   // mínimo $1
    if (amountCents > 2000000) { res.status(400).json({ error: "amount_max" }); return; }    // tope $20,000 por seguridad
    const snap = await admin.firestore().doc("clients/" + clientId).get();
    if (!snap.exists) { res.status(404).json({ error: "client" }); return; }
    const c = snap.data() || {};
    const carLabel = [c.year, c.make, c.model].filter(Boolean).join(" ") || "Vehículo";
    const payload = {
      idempotency_key: (Date.now().toString(36) + Math.random().toString(36).slice(2, 12)),
      order: {
        location_id: SQUARE_LOCATION_ID,
        reference_id: clientId,
        line_items: [{ name: "Pago — " + carLabel, quantity: "1", base_price_money: { amount: amountCents, currency: "USD" } }],
        // 💳 Cargo por servicio 2.9% sobre el monto base (lo paga el cliente por usar el link).
        service_charges: [{ name: "Cargo por servicio / Service fee (2.9%)", percentage: "2.9", calculation_phase: "SUBTOTAL_PHASE" }],
        // Guardamos el monto BASE (sin el 2.9%): es lo que reduce la deuda del cliente al registrar el abono.
        metadata: { baseCents: String(amountCents) },
      },
      checkout_options: {
        redirect_url: "https://legacymotorsgarage.com/portal.html?sqdone=1",
        ask_for_shipping_address: false,
        // Métodos de pago en el link: tarjeta + Cash App Pay + Apple/Google Pay (Afterpay apagado).
        accepted_payment_methods: { apple_pay: true, google_pay: true, cash_app_pay: true, afterpay_clearpay: false },
      },
    };
    const r = await fetch(SQUARE_API + "/v2/online-checkout/payment-links", { method: "POST", headers: _sqHeaders(), body: JSON.stringify(payload) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { console.error("square createLink", JSON.stringify(j)); res.status(502).json({ error: (j.errors && j.errors[0] && j.errors[0].detail) || "square_error" }); return; }
    const link = j.payment_link || {};
    res.status(200).json({ url: link.url || link.long_url || "", orderId: link.order_id || "" });
  } catch (e) { console.error("createSquareCheckout", e); res.status(500).json({ error: String((e && e.message) || e) }); }
});
// Recupera la orden de Square, verifica que esté PAGADA y registra el abono (idempotente por id del pago).
async function _sqRecordOrderId(orderId) {
  const r = await fetch(SQUARE_API + "/v2/orders/batch-retrieve", { method: "POST", headers: _sqHeaders(), body: JSON.stringify({ order_ids: [orderId] }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error("square retrieve", JSON.stringify(j)); return { ok: false, error: "square_error" }; }
  const order = (j.orders && j.orders[0]) || null;
  if (!order) { return { ok: false, error: "order" }; }
  // 🔧 CAJA DE SERVICIO: si el link es de una orden de servicio, se registra como ingreso de Servicio (no abono del dealer).
  if (order.metadata && order.metadata.kind === "service" && order.metadata.serviceOrderId) {
    return await _sqRecordServiceCharge(order);
  }
  const tenders = Array.isArray(order.tenders) ? order.tenders : [];
  const paid = order.state === "COMPLETED" || (order.net_amount_due_money && Number(order.net_amount_due_money.amount) === 0 && tenders.length);
  if (!paid) { return { ok: false, status: order.state || "PENDING" }; }
  const clientId = String(order.reference_id || "");
  if (!clientId) { return { ok: false, error: "no_ref" }; }
  const payId = (tenders[0] && tenders[0].id) || order.id;
  // El abono que reduce la deuda = monto BASE (sin el 2.9%). Lo sacamos de metadata; si no está,
  // usamos el total de los line items (sin el cargo por servicio); último recurso: el total.
  let amountCents = 0;
  try { amountCents = parseInt(order.metadata && order.metadata.baseCents, 10) || 0; } catch (e) {}
  if (!amountCents) {
    amountCents = Math.round(((order.net_amounts && order.net_amounts.line_item_total_money && order.net_amounts.line_item_total_money.amount)) || (order.total_money && order.total_money.amount) || 0);
  }
  const amount = Math.round(amountCents) / 100;
  const entryId = "sq_" + payId;
  const db = admin.firestore();
  const nowISO = new Date().toISOString();
  const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const cref = db.doc("clients/" + clientId);
  let clientName = "";
  await db.runTransaction(async (tx) => {
    const cs = await tx.get(cref);
    if (!cs.exists) return;
    const c = cs.data() || {}; clientName = c.name || "";
    const payments = Array.isArray(c.payments) ? c.payments.slice() : [];
    if (payments.some((p) => p && p.entryId === entryId)) return;   // ya registrado (idempotente)
    let schedDate = "";
    try {
      const sched = Array.isArray(c.schedule) ? c.schedule : [];
      const paidSet = new Set(payments.map((p) => p && p.schedDate).filter(Boolean));
      for (const d of sched) { if (!paidSet.has(d)) { schedDate = d; break; } }
    } catch (e) {}
    payments.push({ entryId, amount, date: dateStr, method: "square", schedDate, createdAt: nowISO, createdBy: "square", source: "square" });
    tx.update(cref, { payments });
    tx.set(db.doc("transactions/" + entryId), { entryId, type: "payment", dept: "dealer", clientId, clientName, amountCents, method: "square", date: dateStr, schedDate: "", createdAt: nowISO, createdBy: "square", note: "Pago por Square (el cliente pagó +2.9% de cargo por servicio aparte)", source: "square" });
  });
  return { ok: true, amount, clientName };
}

// 🔧 Registra el cobro de una ORDEN DE SERVICIO pagada por Square (idempotente por id del pago).
async function _sqRecordServiceCharge(order) {
  const tenders = Array.isArray(order.tenders) ? order.tenders : [];
  const paid = order.state === "COMPLETED" || (order.net_amount_due_money && Number(order.net_amount_due_money.amount) === 0 && tenders.length);
  if (!paid) return { ok: false, status: order.state || "PENDING" };
  const orderId = String(order.metadata.serviceOrderId || "");
  if (!orderId) return { ok: false, error: "no_ref" };
  let amountCents = 0;
  try { amountCents = parseInt(order.metadata.baseCents, 10) || 0; } catch (e) {}
  if (!amountCents) amountCents = Math.round((order.net_amounts && order.net_amounts.line_item_total_money && order.net_amounts.line_item_total_money.amount) || (order.total_money && order.total_money.amount) || 0);
  const payId = (tenders[0] && tenders[0].id) || order.id;
  const db = admin.firestore();
  const snap = await db.collection("serviceOrders").doc(orderId).get();
  if (!snap.exists) return { ok: false, error: "order" };
  await _postServiceIncome(db, snap.data() || {}, orderId, amountCents, "square", "sq_" + payId, "square", order.metadata.priv === "1");
  return { ok: true, amount: Math.round(amountCents) / 100 };
}

// Postea el ingreso de SERVICIO (bolsa dealer, category Servicio) + marca la orden pagada/entregada. Idempotente por entryId.
// priv=true → transacción PRIVADA ("fuera de Legacy"): entra a Finanzas pero NO cuenta en los números de Legacy.
async function _postServiceIncome(db, o, orderId, amountCents, method, entryId, who, priv) {
  const nowISO = new Date().toISOString();
  const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const txRef = db.doc("transactions/" + entryId);
  const oref = db.collection("serviceOrders").doc(orderId);
  let startedParts = null;   // {name, folio, veh} si este pago ARRANCÓ el servicio (pago temprano de refacciones)
  await db.runTransaction(async (tx) => {
    const ts = await tx.get(txRef);
    if (ts.exists) return;   // ya registrado (idempotente)
    const os = await tx.get(oref);
    const cur = os.exists ? (os.data() || {}) : o;
    const total = Number(cur.grandTotalCents) || 0;
    const newPaid = (Number(cur.paidCents) || 0) + Math.round(amountCents);
    tx.set(txRef, {
      entryId, type: "income", dept: "dealer", category: "Servicio", saleType: "servicio", private: !!priv,
      clientId: cur.clientId || "", clientName: cur.clientName || "",
      serviceOrderId: orderId, orderNum: cur.orderNum || null, carLabel: cur.vehicleLabel || "",
      amountCents: Math.round(amountCents), method: method || "cash", date: dateStr,
      note: "Orden de servicio #" + (cur.orderNum || orderId) + (newPaid < total ? " (abono)" : ""), createdAt: nowISO, createdBy: who || method || "service-caja", source: "service-caja",
    });
    const fullyPaid = (newPaid >= total && total > 0);
    const patch = { paidCents: newPaid, paid: fullyPaid, paidAt: nowISO, payMethod: method || "cash", updatedAt: nowISO };
    if (priv) patch.private = true;
    if (cur.estimateStatus !== "accepted") { patch.estimateStatus = "accepted"; if (!cur.estimateAcceptedAt) patch.estimateAcceptedAt = nowISO; }   // 💡 pagar = aceptar
    if (fullyPaid) { patch.status = "entregado"; if (!cur.deliveredAt) patch.deliveredAt = nowISO; }
    // 🚀 PAGO TEMPRANO DE REFACCIONES (antes de recibir el carro): arranca el servicio → estado 'arrancado'.
    else if (["agendado", "por_recibir", ""].indexOf(cur.status || "") >= 0) {
      patch.status = "arrancado"; if (!cur.partsPaidAt) patch.partsPaidAt = nowISO;
      startedParts = { name: cur.clientName || "Cliente", folio: cur.orderNum ? ("#" + cur.orderNum) : "", veh: cur.vehicleLabel || cur.plate || "" };
    }
    // 🧾 INVOICE inmutable: foto final de lo cobrado (una sola vez, al quedar pagada). Cubre efectivo, tarjeta y link de Square.
    if (fullyPaid && !cur.invoice) {
      patch.invoice = {
        num: cur.orderNum || null, at: nowISO, by: who || method || "service-caja",
        services: Array.isArray(cur.services) ? cur.services : [],
        parts: Array.isArray(cur.parts) ? cur.parts : [],
        laborTotalCents: Number(cur.laborTotalCents) || 0, partsTotalCents: Number(cur.partsTotalCents) || 0,
        grandTotalCents: total, depositCents: Number(cur.depositCents) || 0, balanceCents: 0,
        paidCents: newPaid, payMethod: method || "cash", private: !!priv,
      };
    }
    tx.set(oref, patch, { merge: true });
  });
  // 🚀 Avisa a los dueños que el cliente pagó las refacciones → hay que ORDENARLAS.
  if (startedParts) {
    try {
      const fol = startedParts.folio ? (" " + startedParts.folio) : "";
      const veh = startedParts.veh ? (" · " + startedParts.veh) : "";
      await _pushToOwners({
        title: "🚀 Pagó las refacciones" + fol, body: startedParts.name + " pagó — ordena sus piezas 📦" + veh,
        titleEn: "🚀 Parts paid" + fol, bodyEn: startedParts.name + " paid — order the parts 📦" + veh,
        url: "/admin.html",
      });
    } catch (e) { console.log("startedParts push", e); }
  }
}

// 💵 CAJA DE SERVICIO: cobra una orden. method 'cash' = registra YA (ingreso + marca pagada); 'square' = crea link de pago y lo regresa.
exports.svcCharge = onCall({ secrets: [SQUARE_ACCESS_TOKEN], timeoutSeconds: 30 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id || !(id.isOwner || id.email)) throw new HttpsError("permission-denied", "Solo staff/dueños cobran.");
  const d = request.data || {};
  const orderId = String(d.orderId || "");
  const method = String(d.method || "cash");
  if (!orderId) throw new HttpsError("invalid-argument", "Falta la orden.");
  const db = admin.firestore();
  const oref = db.collection("serviceOrders").doc(orderId);
  const snap = await oref.get();
  if (!snap.exists) throw new HttpsError("not-found", "La orden no existe.");
  const o = snap.data() || {};
  const total = Number(o.grandTotalCents) || 0;
  const already = Number(o.paidCents) || 0;
  const defaultDue = Math.max(0, total - already);
  const amountCents = d.amountCents != null ? Math.round(Number(d.amountCents)) : defaultDue;
  const priv = !!d.private;   // 🔒 "fuera de Legacy": entra a Finanzas pero privado (no cuenta en los números de Legacy)
  if (!(amountCents > 0)) throw new HttpsError("invalid-argument", "Monto inválido.");
  if (amountCents > 2000000) throw new HttpsError("invalid-argument", "Monto demasiado alto.");
  // ✅ "YA ESTÁ EN FINANZAS" (reconcile): cuadra la orden SIN crear transacción ni postear ingreso (el dinero ya se registró por otro lado).
  if (d.reconcile) {
    if (!id.isOwner) throw new HttpsError("permission-denied", "Solo dueños pueden conciliar.");
    const newPaid = already + amountCents;
    const fullyPaid = (newPaid >= total && total > 0);
    const nowISO = new Date().toISOString();
    const patch = { paidCents: newPaid, paid: fullyPaid, paidAt: nowISO, payMethod: method || "cash", reconciled: true, balanceCents: Math.max(0, total - newPaid), updatedAt: nowISO };
    if (o.estimateStatus !== "accepted") { patch.estimateStatus = "accepted"; if (!o.estimateAcceptedAt) patch.estimateAcceptedAt = nowISO; }
    if (fullyPaid) { patch.status = "entregado"; if (!o.deliveredAt) patch.deliveredAt = nowISO; }
    const linkTx = String(d.linkTxId || "");   // opcional: liga la transacción ya existente a la orden
    if (linkTx) { try { await db.collection("transactions").doc(linkTx).set({ serviceOrderId: orderId, orderNum: o.orderNum || null }, { merge: true }); } catch (e) {} }
    await oref.set(patch, { merge: true });
    return { ok: true, paid: fullyPaid, paidCents: newPaid, reconciled: true };
  }
  if (method === "cash") {
    await _postServiceIncome(db, o, orderId, amountCents, "cash", "svc_" + orderId + "_" + Date.now().toString(36), id.email || id.name || "", priv);
    const fresh = (await oref.get()).data() || {};
    return { ok: true, paid: !!fresh.paid, paidCents: Number(fresh.paidCents) || 0 };
  }
  if (method === "square") {
    const carLabel = o.vehicleLabel || "Servicio";
    const payload = {
      idempotency_key: (Date.now().toString(36) + Math.random().toString(36).slice(2, 12)),
      order: {
        location_id: SQUARE_LOCATION_ID, reference_id: o.clientId || orderId,
        line_items: [{ name: "Orden de servicio #" + (o.orderNum || "") + " — " + carLabel, quantity: "1", base_price_money: { amount: amountCents, currency: "USD" } }],
        service_charges: [{ name: "Cargo por servicio / Service fee (2.9%)", percentage: "2.9", calculation_phase: "SUBTOTAL_PHASE" }],
        metadata: Object.assign({ kind: "service", serviceOrderId: orderId, baseCents: String(amountCents) }, priv ? { priv: "1" } : {}),   // ⚠️ Square rechaza metadata con valor "" → solo mandar priv si es privado.
      },
      checkout_options: {
        redirect_url: "https://legacymotorsgarage.com/portal.html?sqdone=1",
        ask_for_shipping_address: false,
        accepted_payment_methods: { apple_pay: true, google_pay: true, cash_app_pay: true, afterpay_clearpay: false },
      },
    };
    const r = await fetch(SQUARE_API + "/v2/online-checkout/payment-links", { method: "POST", headers: _sqHeaders(), body: JSON.stringify(payload) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { console.error("svcCharge square", JSON.stringify(j)); throw new HttpsError("internal", (j.errors && j.errors[0] && j.errors[0].detail) || "square_error"); }
    const link = j.payment_link || {};
    const url = link.url || link.long_url || "";
    await oref.set({ squarePayUrl: url, squareOrderId: link.order_id || "", payMethod: "square-pending", updatedAt: new Date().toISOString() }, { merge: true });
    return { ok: true, url, squareOrderId: link.order_id || "" };
  }
  throw new HttpsError("invalid-argument", "Método inválido.");
});

// Tras el pago, Square regresa al portal con el orderId. Esto RE-VERIFICA con Square que sí se pagó
// y lo registra en la cuenta del cliente + Finanzas (idempotente por el id del pago de Square).
exports.confirmSquarePayment = onRequest({ secrets: [SQUARE_ACCESS_TOKEN], cors: true, timeoutSeconds: 30 }, async (req, res) => {
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  try {
    const orderId = String((req.body && req.body.orderId) || "").slice(0, 160);
    if (!orderId) { res.status(400).json({ error: "orderId" }); return; }
    const out = await _sqRecordOrderId(orderId);
    res.status(200).json(out);
  } catch (e) { console.error("confirmSquarePayment", e); res.status(500).json({ error: String((e && e.message) || e) }); }
});

// 💳 El CLIENTE paga una ORDEN DE SERVICIO con tarjeta desde su portal (total o una parte). Verifica que la orden sea suya (por teléfono).
exports.createServiceCheckout = onRequest({ secrets: [SQUARE_ACCESS_TOKEN], cors: true, timeoutSeconds: 30 }, async (req, res) => {
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  try {
    const body = req.body || {};
    const idToken = String(body.idToken || "");
    if (!idToken) { res.status(401).json({ error: "auth" }); return; }
    let decoded; try { decoded = await admin.auth().verifyIdToken(idToken); } catch (e) { res.status(401).json({ error: "auth" }); return; }
    const phone = String(decoded.phone_number || "");
    const orderId = String(body.orderId || "").slice(0, 80);
    if (!orderId) { res.status(400).json({ error: "orderId" }); return; }
    const db = admin.firestore();
    const snap = await db.collection("serviceOrders").doc(orderId).get();
    if (!snap.exists) { res.status(404).json({ error: "order" }); return; }
    const o = snap.data() || {};
    // La orden debe ser del cliente (por su teléfono, directo o vía el doc del cliente).
    let mineOk = (o.clientPhone && phone && o.clientPhone === phone);
    if (!mineOk && o.clientId && phone) { try { const cs = await db.collection("clients").doc(o.clientId).get(); if (cs.exists && (cs.data().phoneE164 || "") === phone) mineOk = true; } catch (e) {} }
    if (!mineOk) { res.status(403).json({ error: "not_yours" }); return; }
    const total = Number(o.grandTotalCents) || 0;
    const due = Math.max(0, total - (Number(o.paidCents) || 0));
    let amountCents = body.amountCents != null ? Math.round(Number(body.amountCents)) : due;
    if (amountCents > due) amountCents = due;
    if (!(amountCents >= 100)) { res.status(400).json({ error: "amount_min" }); return; }
    const carLabel = o.vehicleLabel || "Servicio";
    const payload = {
      idempotency_key: (Date.now().toString(36) + Math.random().toString(36).slice(2, 12)),
      order: {
        location_id: SQUARE_LOCATION_ID, reference_id: o.clientId || orderId,
        line_items: [{ name: "Orden de servicio #" + (o.orderNum || "") + " — " + carLabel, quantity: "1", base_price_money: { amount: amountCents, currency: "USD" } }],
        service_charges: [{ name: "Cargo por servicio / Service fee (2.9%)", percentage: "2.9", calculation_phase: "SUBTOTAL_PHASE" }],
        metadata: { kind: "service", serviceOrderId: orderId, baseCents: String(amountCents) },   // ⚠️ NO mandar claves vacías: Square rechaza metadata con valor "".
      },
      checkout_options: {
        redirect_url: "https://legacymotorsgarage.com/portal.html?sqdone=1",
        ask_for_shipping_address: false,
        accepted_payment_methods: { apple_pay: true, google_pay: true, cash_app_pay: true, afterpay_clearpay: false },
      },
    };
    const r = await fetch(SQUARE_API + "/v2/online-checkout/payment-links", { method: "POST", headers: _sqHeaders(), body: JSON.stringify(payload) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { console.error("createServiceCheckout", JSON.stringify(j)); res.status(502).json({ error: (j.errors && j.errors[0] && j.errors[0].detail) || "square_error" }); return; }
    const link = j.payment_link || {};
    res.status(200).json({ url: link.url || link.long_url || "", orderId: link.order_id || "" });
  } catch (e) { console.error("createServiceCheckout", e); res.status(500).json({ error: String((e && e.message) || e) }); }
});

// 🔔 Webhook de Square: cuando un pago se completa, Square pega aquí y registramos el abono SOLO,
// aunque el cliente haya pagado desde el link por SMS sin abrir el portal. Re-verificamos con Square
// (así una llamada falsa no puede inventar un pago). Idempotente por el id del pago.
exports.squareWebhook = onRequest({ secrets: [SQUARE_ACCESS_TOKEN], timeoutSeconds: 30 }, async (req, res) => {
  if (req.method !== "POST") { res.status(200).send("ok"); return; }
  try {
    const b = req.body || {};
    const obj = (b.data && b.data.object) || {};
    const pay = obj.payment || obj || {};
    const orderId = pay.order_id || (obj.order && obj.order.id) || b.order_id || "";
    if (orderId) { try { await _sqRecordOrderId(String(orderId)); } catch (e) { console.error("sqWebhook record", e); } }
  } catch (e) { console.error("squareWebhook", e); }
  res.status(200).send("ok");   // siempre 200 para que Square no reintente en loop
});

// 💳 Lista los PAGOS recientes de Square (incluye los de la TERMINAL en persona) para asignarlos a clientes en Finanzas.
// Solo lee; NO registra nada. El front muestra la lista y Enrique asigna cada pago a un cliente/cuenta.
exports.squareRecentPayments = onCall({ secrets: [SQUARE_ACCESS_TOKEN], timeoutSeconds: 120 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const days = Math.min(400, Math.max(1, Number(request.data && request.data.days) || 90));
  const begin = new Date(Date.now() - days * 864e5).toISOString();
  const out = []; let cursor = "";
  try {
    for (let page = 0; page < 12; page++) {
      const qs = new URLSearchParams({ begin_time: begin, location_id: SQUARE_LOCATION_ID, sort_order: "DESC", limit: "100" });
      if (cursor) qs.set("cursor", cursor);
      const r = await fetch(SQUARE_API + "/v2/payments?" + qs.toString(), { headers: _sqHeaders() });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { console.error("sqPayments", JSON.stringify(j)); throw new HttpsError("internal", (j.errors && j.errors[0] && j.errors[0].detail) || "square_error"); }
      for (const p of (j.payments || [])) {
        const card = (p.card_details && p.card_details.card) || {};
        const totalCents = (p.total_money && p.total_money.amount) || (p.amount_money && p.amount_money.amount) || 0;
        const feeCents = (p.processing_fee || []).reduce((s, f) => s + ((f.amount_money && f.amount_money.amount) || 0), 0);
        out.push({
          id: p.id,
          createdAt: p.created_at || "",
          status: p.status || "",
          sourceType: p.source_type || "",                                   // CARD, CASH, EXTERNAL, etc.
          amountCents: (p.amount_money && p.amount_money.amount) || 0,        // lo que pagó el cliente (base)
          totalCents: totalCents,                                            // total cobrado (base + propina si hubo)
          feeCents: feeCents,                                                // comisión que se quedó Square
          netCents: Math.max(0, totalCents - feeCents),                      // lo que SE DEPOSITÓ a la cuenta
          feeReady: (p.processing_fee && p.processing_fee.length) ? true : false,  // la comisión a veces tarda ~1 día en aparecer
          cardBrand: card.card_brand || card.bin || "",
          last4: card.last_4 || "",
          cardholderName: card.cardholder_name || "",                         // nombre del tarjetahabiente (cuando viene)
          buyerEmail: p.buyer_email_address || "",                            // correo del comprador (si lo capturó para el recibo)
          customerId: p.customer_id || "",                                    // id del cliente de Square (si está ligado)
          entryMethod: (p.card_details && p.card_details.entry_method) || "", // KEYED, SWIPED, CONTACTLESS, EMV…
          orderId: p.order_id || "",
          note: p.note || "",
          receiptUrl: p.receipt_url || "",
        });
      }
      cursor = j.cursor || "";
      if (!cursor) break;
    }
    // La lista NO siempre trae processing_fee → pedir el detalle (GetPayment) de los que falten, en paralelo por lotes.
    const needFee = out.filter((p) => !p.feeReady).slice(0, 120);
    for (let i = 0; i < needFee.length; i += 10) {
      const batch = needFee.slice(i, i + 10);
      await Promise.all(batch.map(async (p) => {
        try {
          const rr = await fetch(SQUARE_API + "/v2/payments/" + encodeURIComponent(p.id), { headers: _sqHeaders() });
          const jj = await rr.json().catch(() => ({}));
          const pp = (jj && jj.payment) || {};
          if (pp.processing_fee && pp.processing_fee.length) {
            const fee = pp.processing_fee.reduce((s, f) => s + ((f.amount_money && f.amount_money.amount) || 0), 0);
            p.feeCents = fee;
            p.netCents = Math.max(0, (p.totalCents || 0) - fee);
            p.feeReady = true;
          }
          if (!p.cardholderName) {
            const cc = (pp.card_details && pp.card_details.card) || {};
            if (cc.cardholder_name) p.cardholderName = cc.cardholder_name;
          }
        } catch (e) { /* deja el pago sin fee si falla */ }
      }));
    }
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    console.error("squareRecentPayments", e);
    throw new HttpsError("internal", String((e && e.message) || e));
  }
  return { payments: out, count: out.length };
});

// 🔔 NOTIFICACIONES PUSH del chat interno.
// Debe empatar con CHAT_CHANNELS del frontend (quién es miembro de cada canal).
const CHAT_MEMBERS = {
  "group":            ["ev@legacymotorsgarage.com","ivan.garcia@legacymotorsgarage.com","warehouse@legacymotorsgarage.com","capture@legacymotorsgarage.com","listing@legacymotorsgarage.com","yarda@legacymotorsgarage.com","ebay@legacymotorsgarage.com","empaque@legacymotorsgarage.com","mechanic@legacymotorsgarage.com","mecanico@legacymotorsgarage.com"],
  "owners":           ["ev@legacymotorsgarage.com","ivan.garcia@legacymotorsgarage.com"],
  "capture-listing":  ["ev@legacymotorsgarage.com","ivan.garcia@legacymotorsgarage.com","capture@legacymotorsgarage.com","listing@legacymotorsgarage.com","yarda@legacymotorsgarage.com","ebay@legacymotorsgarage.com"],
  "capture-owners":   ["ev@legacymotorsgarage.com","ivan.garcia@legacymotorsgarage.com","capture@legacymotorsgarage.com","yarda@legacymotorsgarage.com"],
  "listing-owners":   ["ev@legacymotorsgarage.com","ivan.garcia@legacymotorsgarage.com","listing@legacymotorsgarage.com","ebay@legacymotorsgarage.com"],
  "warehouse-owners": ["ev@legacymotorsgarage.com","ivan.garcia@legacymotorsgarage.com","warehouse@legacymotorsgarage.com","empaque@legacymotorsgarage.com"],
  "mechanic-owners":  ["ev@legacymotorsgarage.com","ivan.garcia@legacymotorsgarage.com","mechanic@legacymotorsgarage.com","mecanico@legacymotorsgarage.com"],
};
const CHAT_TITLES = {
  "group": "Legacy Group", "owners": "Supervisores", "capture-listing": "Captura ↔ Listado",
  "capture-owners": "Captura ↔ Supervisores", "listing-owners": "Listado ↔ Supervisores",
  "warehouse-owners": "Empaque ↔ Supervisores", "mechanic-owners": "Mecánico ↔ Supervisores",
};
const CHAT_TITLES_EN = {
  "group": "Legacy Group", "owners": "Supervisors", "capture-listing": "Capture ↔ Listing",
  "capture-owners": "Capture ↔ Supervisors", "listing-owners": "Listing ↔ Supervisors",
  "warehouse-owners": "Warehouse ↔ Supervisors", "mechanic-owners": "Mechanic ↔ Supervisors",
};
// La app llama esto DESPUÉS de guardar el mensaje (evita triggers Eventarc y sus permisos IAM).
exports.sendChatPush = onCall({ timeoutSeconds: 30 }, async (request) => {
  try {
    if (!request.auth) return { ok: false };
    const email = (request.auth.token && request.auth.token.email || "").toLowerCase();
    const ch = String((request.data && request.data.channel) || "");
    const text = String((request.data && request.data.text) || "");
    const byName = String((request.data && request.data.byName) || email.split("@")[0]);
    const all = CHAT_MEMBERS[ch];
    if (!all || all.indexOf(email) < 0) return { ok: false };   // solo miembros del canal
    const members = all.filter((e) => e !== email);              // no te notificas a ti mismo
    if (!members.length) return { ok: true, sent: 0 };
    const db = admin.firestore();
    // Agrupa tokens por idioma → cada quien recibe el título en SU idioma.
    const grp = { es: { tokens: [], refs: [] }, en: { tokens: [], refs: [] } };
    const snap = await db.collection("push_tokens").where("email", "in", members).get();
    snap.forEach((d) => { const dd = d.data(); if (dd.token) { const lg = (dd.lang === "en") ? "en" : "es"; grp[lg].tokens.push(dd.token); grp[lg].refs.push(d.ref); } });
    const body = (byName + ": " + text).slice(0, 180);
    const dead = []; let sent = 0;
    for (const lg of ["es", "en"]) {
      if (!grp[lg].tokens.length) continue;
      const title = (lg === "en" ? CHAT_TITLES_EN[ch] : CHAT_TITLES[ch]) || "Legacy Chat";
      // SOLO data (sin 'notification') → la muestra el service worker UNA vez (evita el doble aviso).
      const res = await admin.messaging().sendEachForMulticast({
        tokens: grp[lg].tokens,
        data: { title, body, channel: ch, url: "/warehouse.html?chat=" + ch },
        webpush: { headers: { Urgency: "high", TTL: "86400" } },
      });
      sent += res.successCount;
      res.responses.forEach((r, i) => { if (!r.success) { const c = r.error && r.error.code; if (c === "messaging/registration-token-not-registered" || c === "messaging/invalid-registration-token") dead.push(grp[lg].refs[i]); } });
    }
    await Promise.all(dead.map((ref) => ref.delete().catch(() => {})));
    return { ok: true, sent };
  } catch (e) { console.log("sendChatPush err", e); return { ok: false, err: String(e && e.message || e) }; }
});

// 🔔 Push a los DUEÑOS (cha-ching + avisos). Lee push_tokens por correo (OWNER_EMAILS) y manda data-only (lo muestra el SW).
async function _pushToOwners(payload) {
  try {
    const db = admin.firestore();
    const snap = await db.collection("push_tokens").where("email", "in", OWNER_EMAILS).get();
    const grp = { es: { t: [], r: [] }, en: { t: [], r: [] } };
    snap.forEach((d) => { const dd = d.data() || {}; if (dd.token) { const lg = (dd.lang === "en") ? "en" : "es"; grp[lg].t.push(dd.token); grp[lg].r.push(d.ref); } });
    const dead = [];
    for (const lg of ["es", "en"]) {
      if (!grp[lg].t.length) continue;
      const title = ((lg === "en" ? payload.titleEn : payload.title) || payload.title || "Legacy").slice(0, 80);
      const body = ((lg === "en" ? payload.bodyEn : payload.body) || payload.body || "").slice(0, 180);
      const res = await admin.messaging().sendEachForMulticast({
        tokens: grp[lg].t,
        data: { title, body, url: payload.url || "/warehouse.html" },
        webpush: { headers: { Urgency: "high", TTL: "86400" } },
      });
      res.responses.forEach((r, i) => { if (!r.success) { const c = r.error && r.error.code; if (c === "messaging/registration-token-not-registered" || c === "messaging/invalid-registration-token") dead.push(grp[lg].r[i]); } });
    }
    await Promise.all(dead.map((ref) => ref.delete().catch(() => {})));
  } catch (e) { console.log("_pushToOwners", e); }
}

// 💰 CHA-CHING: cada vez que ENTRA dinero (cualquier ingreso en `transactions`) → avisa a los dueños al teléfono.
// Cubre TODO sin huecos: Finanzas, venta de carro (Clientes), caja de Servicio, Square y efectivo (todos postean aquí).
const _MONEY_IN_TYPES = ["income", "payment", "down", "cash_sale"];
exports.onMoneyIn = onDocumentCreated("transactions/{id}", async (event) => {
  try {
    const t = (event.data && event.data.data()) || null; if (!t) return;
    if (_MONEY_IN_TYPES.indexOf(t.type) < 0) return;            // solo dinero que entra (no gastos/retiros/transferencias)
    const cents = Number(t.amountCents) || 0; if (cents <= 0) return;
    const amt = "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const who = t.clientName || "";
    const deptLbl = ({ dealer: "Dealer", parts: "Partes", ebay: "eBay" })[t.dept] || "";
    const label = t.category || (t.saleType === "servicio" ? "Servicio" : "") || deptLbl || "Ingreso";
    const priv = (t.private === true) ? " 🔒" : "";
    const url = (t.source === "service-caja") ? "/admin.html" : "/finanzas.html";
    await _pushToOwners({
      title: "💰 Entró dinero" + priv, body: amt + " · " + label + (who ? (" · " + who) : ""),
      titleEn: "💰 Money in" + priv, bodyEn: amt + " · " + label + (who ? (" · " + who) : ""),
      url,
    });
  } catch (e) { console.log("onMoneyIn", e); }
});

// 🔔 Push a UN CLIENTE (por sus tokens: clientId o teléfono), EN SU IDIOMA (agrupa por lang del token).
async function _pushToClient(clientId, phone, payload) {
  try {
    const db = admin.firestore();
    const seen = {}; const docs = [];
    if (clientId) { const s = await db.collection("push_tokens").where("clientId", "==", clientId).get(); s.forEach((d) => { if (!seen[d.id]) { seen[d.id] = 1; docs.push(d); } }); }
    if (phone) { const s2 = await db.collection("push_tokens").where("phone", "==", phone).get(); s2.forEach((d) => { if (!seen[d.id]) { seen[d.id] = 1; docs.push(d); } }); }
    if (!docs.length) return;
    const grp = { es: { t: [], r: [] }, en: { t: [], r: [] } };
    docs.forEach((d) => { const dd = d.data() || {}; if (dd.token) { const lg = (dd.lang === "en") ? "en" : "es"; grp[lg].t.push(dd.token); grp[lg].r.push(d.ref); } });
    const dead = [];
    for (const lg of ["es", "en"]) {
      if (!grp[lg].t.length) continue;
      const title = ((lg === "en" ? payload.titleEn : payload.title) || payload.title || "Legacy").slice(0, 80);
      const body = ((lg === "en" ? payload.bodyEn : payload.body) || payload.body || "").slice(0, 180);
      const res = await admin.messaging().sendEachForMulticast({
        tokens: grp[lg].t, data: { title, body, url: payload.url || "/portal.html" },
        webpush: { headers: { Urgency: "high", TTL: "86400" } },
      });
      res.responses.forEach((r, i) => { if (!r.success) { const c = r.error && r.error.code; if (c === "messaging/registration-token-not-registered" || c === "messaging/invalid-registration-token") dead.push(grp[lg].r[i]); } });
    }
    await Promise.all(dead.map((ref) => ref.delete().catch(() => {})));
  } catch (e) { console.log("_pushToClient", e); }
}

// 🚗 Avisa al CLIENTE (en su idioma) cuando: le mandan un NUEVO ESTIMADO, o su auto queda LISTO para recoger.
exports.onServiceStatus = onDocumentUpdated("serviceOrders/{id}", async (event) => {
  try {
    const before = (event.data && event.data.before && event.data.before.data()) || {};
    const after = (event.data && event.data.after && event.data.after.data()) || {};
    const veh = after.vehicleLabel || (after.plate ? after.plate : "tu auto");
    const vehEn = after.vehicleLabel || (after.plate ? after.plate : "your car");
    const fol = after.orderNum ? (" #" + after.orderNum) : "";
    let p = null;
    if (before.estimateStatus !== "sent" && after.estimateStatus === "sent") {
      // 🧾 nuevo estimado enviado al cliente
      p = { title: "🧾 Tienes un nuevo estimado", body: "Revisa y acepta el estimado de " + veh + fol + ".", titleEn: "🧾 You have a new estimate", bodyEn: "Review and approve the estimate for " + vehEn + fol + "." };
    } else if (before.status !== after.status && after.status === "listo") {
      // 🚗 auto listo para recoger
      p = { title: "🚗 Tu auto está listo", body: "Ya puedes pasar por " + veh + fol + ".", titleEn: "🚗 Your car is ready", bodyEn: vehEn + fol + " is ready for pickup." };
    } else if (!before.partsReadyAt && after.partsReadyAt) {
      // 🎉 llegaron TODAS las refacciones → a coordinar la cita
      p = { title: "🎉 ¡Llegaron tus refacciones!", body: "Ya tenemos todo para " + veh + fol + ". Vamos a coordinar tu cita.", titleEn: "🎉 Your parts arrived!", bodyEn: "We have everything for " + vehEn + fol + ". Let's set your appointment." };
    } else if (!before.scheduledAt && after.scheduledAt) {
      // 🗓️ cita agendada (se puso fecha)
      const dt = (function () { try { return new Date(after.scheduledAt).toLocaleString("es-MX", { weekday: "long", day: "2-digit", month: "long", hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; } })();
      const dtEn = (function () { try { return new Date(after.scheduledAt).toLocaleString("en-US", { weekday: "long", month: "long", day: "2-digit", hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; } })();
      p = { title: "🗓️ Tu cita quedó agendada", body: "Te esperamos" + (dt ? (" el " + dt) : "") + " para " + veh + fol + ".", titleEn: "🗓️ Your appointment is set", bodyEn: "See you" + (dtEn ? (" on " + dtEn) : "") + " for " + vehEn + fol + "." };
    }
    if (!p) return;
    p.url = "/portal.html?order=" + event.params.id;
    await _pushToClient(after.clientId || "", after.clientPhone || "", p);
  } catch (e) { console.log("onServiceStatus", e); }
});

// 🔧 Push a UN EMPLEADO (por sus tokens: empId), EN SU IDIOMA (agrupa por lang del token).
async function _pushToEmp(empId, payload) {
  try {
    if (!empId) return;
    const db = admin.firestore();
    const snap = await db.collection("push_tokens").where("empId", "==", empId).get();
    if (snap.empty) return;
    const grp = { es: { t: [], r: [] }, en: { t: [], r: [] } };
    snap.forEach((d) => { const dd = d.data() || {}; if (dd.token) { const lg = (dd.lang === "en") ? "en" : "es"; grp[lg].t.push(dd.token); grp[lg].r.push(d.ref); } });
    const dead = [];
    for (const lg of ["es", "en"]) {
      if (!grp[lg].t.length) continue;
      const title = ((lg === "en" ? payload.titleEn : payload.title) || payload.title || "Legacy").slice(0, 80);
      const body = ((lg === "en" ? payload.bodyEn : payload.body) || payload.body || "").slice(0, 180);
      const res = await admin.messaging().sendEachForMulticast({
        tokens: grp[lg].t, data: { title, body, url: payload.url || "/warehouse.html" },
        webpush: { headers: { Urgency: "high", TTL: "86400" } },
      });
      res.responses.forEach((r, i) => { if (!r.success) { const c = r.error && r.error.code; if (c === "messaging/registration-token-not-registered" || c === "messaging/invalid-registration-token") dead.push(grp[lg].r[i]); } });
    }
    await Promise.all(dead.map((ref) => ref.delete().catch(() => {})));
  } catch (e) { console.log("_pushToEmp", e); }
}

// 🔧 "Atiende esto" — texto del aviso según prioridad (🔴 Ahora / 🟡 Siguiente), en el idioma del empleado.
function _taskPushPayload(t) {
  const prio = String(t.priority || "cola");
  const title = t.title || "Tarea";
  const car = t.carLabel ? (" · " + t.carLabel) : "";
  if (prio === "now") {
    return { title: "🔴 Atiende esto ahora", body: title + car, titleEn: "🔴 Attend this now", bodyEn: title + car, url: "/warehouse.html" };
  }
  if (prio === "next") {
    return { title: "🟡 Sigues con esto", body: title + car, titleEn: "🟡 You're up next", bodyEn: title + car, url: "/warehouse.html" };
  }
  return null; // 🟢 En cola no manda push
}

// 🔧 Avisa al EMPLEADO cuando le ASIGNAN una tarea 🔴 Ahora / 🟡 Siguiente (nueva).
exports.onTaskAssign = onDocumentCreated("tasks/{id}", async (event) => {
  try {
    const t = (event.data && event.data.data()) || null; if (!t) return;
    if (t.isTemplate || t.status === "hecho") return;
    if (!t.assignEmpId) return;
    const p = _taskPushPayload(t); if (!p) return;
    await _pushToEmp(t.assignEmpId, p);
  } catch (e) { console.log("onTaskAssign", e); }
});

// 🔧 Avisa al EMPLEADO cuando una tarea EXISTENTE se sube a 🔴/🟡 o se le reasigna (el "deja eso y atiende este").
exports.onTaskBump = onDocumentUpdated("tasks/{id}", async (event) => {
  try {
    const before = (event.data && event.data.before && event.data.before.data()) || {};
    const after = (event.data && event.data.after && event.data.after.data()) || {};
    if (after.isTemplate || after.status === "hecho") return;
    if (!after.assignEmpId) return;
    const p = _taskPushPayload(after); if (!p) return;        // solo 🔴/🟡 mandan
    const reassigned = before.assignEmpId !== after.assignEmpId;      // le tocó a otra persona
    const bumped = String(before.priority || "cola") !== String(after.priority || "cola"); // cambió la prioridad
    if (!reassigned && !bumped) return;                        // sin cambio relevante, no spamear
    await _pushToEmp(after.assignEmpId, p);
  } catch (e) { console.log("onTaskBump", e); }
});

// 🌐 BOT DE VENTAS de la página web (Claude). Contesta a visitantes y los empuja a venir en persona.
const SITE_BOT_MODEL = "claude-sonnet-5";   // buen balance calidad/costo (mismo que el bot de eBay). Se puede subir a opus.
function buildSitePrompt(inv, todayStr) {
  return `You are the sales assistant for **Legacy Motors Garage LLC**, a used-car dealership with IN-HOUSE financing at 21122 Ave 152, Porterville, CA 93257 · phone (559) 540-5145. You sound like a real, warm, helpful person on the team (think Enrique himself) — NEVER like a chatbot, a pushy salesperson, or a corporate script. Reply in the SAME language the customer writes (English → English, Spanish → Spanish; if they mix, use the predominant one; don't switch languages without reason). Use natural US English and natural Mexican Spanish. In Spanish always say "millas", NEVER "kilometraje".

WHO WE ARE — the feeling EVERY customer should walk away with: "these people actually want to listen to me, help me, and see what they can do for me." Warm and welcoming, confident but never arrogant, very willing to find solutions, professional but conversational, optimistic without false promises, flexible IN PERSON without negotiating everything by message, respectful even when someone makes a low offer or has bad credit.

YOUR GOAL is NOT to close the whole deal by message. It is to: (1) answer their question directly, (2) build confidence, (3) briefly highlight the vehicle's value, (4) invite them to see it in person, (5) get a SPECIFIC day AND time, (6) confirm the appointment — WITHOUT promising approval, final price, appraisal, or terms before reviewing their case in person.

MESSAGE STYLE:
- Answer their question FIRST. Keep it short — a couple of sentences, short paragraphs. No essays, never repeat the whole listing.
- Use the customer's name when you have it. Say "we" for the business. At most 1–2 emojis, only when it fits.
- End with an EASY next-step question — but VARY it, never end every message the exact same way. Good: "What time works best for you?", "Would morning or afternoon be easier?", "What day are you off this week?", "Would 10:30 work for you?", "Would you be against stopping by to see it in person?". Avoid vague ones: "Are you interested?", "Let me know.", "Do you want it?".
- Shape of a great reply: direct answer → a little reassurance/value → an honest limit if needed → ONE concrete next step.
- SOUND HUMAN, NOT AI. Write like a real person texting: casual, warm, with contractions. AVOID em-dashes and long dashes (the "—" and "–" characters) because heavy dash use is a dead giveaway that it's a bot. Use short sentences, commas, or a second line instead. Also DON'T use bullet-point / dash lists in chat (no "- item" lists); if you mention a few cars, say them in a natural sentence ("ahorita tenemos un Corolla 2013, un Altima 2019 y un Elantra 2014"). Don't be overly polished or perfectly parallel. Never robotic ("Thank you for your inquiry", "dear customer").
- Tasteful urgency is GOOD when it's TRUE: good cars move fast and we get new ones every week, so nudging "come see it before it's gone" or "come by so it doesn't get taken" is great. But NEVER invent specific buyers or lie ("3 people are looking at it right now").
- NEVER tell the customer they're wrong about what they want or need. If they say they want more space, agree and run with it ("perfect, let's get you something roomier") and NEVER say "you don't need more space". Work WITH what they told you; if we don't have the exact fit, say so warmly and offer the closest option plus invite them in.

🎯 HOW A TOP CLOSER WORKS (this is your edge — LEAD, don't just answer). A closer doesn't force, manipulate, or trick — they reduce uncertainty, uncover the truth, and make it easy for the customer to decide:
- LEAD, don't just react. After you answer, EVERY message must move ONE step forward: uncover a need, learn the budget, find the urgency, surface the real objection, or get a commitment. Ask yourself: "what do I need to learn now to help this person decide?"
- Answer the question, THEN gently take the wheel with a discovery question. E.g. "Do you finance?" → "Yes, short-term in-house financing. Just so I point you the right way — is your main concern the down payment, the monthly payment, or your credit?"
- BUILD 3 CERTAINTIES before asking for action: (1) the VEHICLE — specific evidence (clean title, service done, history report available, test drive), not "it's great, you'll love it"; (2) LEGACY — make the process visible ("we'll show you the history, let you inspect and drive it, and walk you through every number before you decide"); (3) their OWN decision — tie the car to THEIR real reason (getting to work on their own, a reliable car for their kid, done with constant repairs, a payment they can actually finish).
- GREET LIKE A REAL PERSON — GET THEIR NAME EARLY. Very early (your first or second reply, right after you start helping), introduce yourself in one line and ask their name the warm, casual way a friendly salesperson greets someone walking onto the lot: "Oye, con gusto te ayudo — ¿cómo te llamas?" / "By the way — what's your name?" Then USE their first name naturally through the chat (not every line, just enough to feel personal). It must feel human, NEVER like a form.
- ASK WHERE IN THE VALLEY THEY'RE FROM (casually). We're in Porterville, CA (Central Valley). Early on, weave in what town/area they're in — Porterville, Visalia, Tulare, Delano, Bakersfield, Fresno, Hanford, etc. Use it to connect and gauge the drive: if they're local, "Ah, aquí cerquita 🙌"; if they're farther, make the trip feel worth it ("vale la pena el viajecito, te tenemos todo listo para cuando llegues"). Don't ask like a survey — just curious and friendly.
- KEEP IT TIGHT AND HUMAN: aim to learn the essentials — their NAME, what part of the Valley they're from, what they need, roughly the down payment, and how soon — within the FIRST 3-4 exchanges. To the point, but always warm and conversational, ONE or TWO questions at a time, never a list.
- CLOSE WARM, CHARMING AND MEMORABLE. Once they commit to a day / the appointment is set, end with a warm, charismatic, personal send-off that uses their NAME and makes them feel genuinely welcome and looked-forward-to — like a real person who's happy they're coming, never a robot. E.g. "Perfecto, [nombre] 🙌 me va a dar mucho gusto conocerte y atenderte en persona — aquí te esperamos, vas a estar en muy buenas manos." Match their gender naturally (conocerte / conocerla / conocerlo). This is the LAST taste they get of Legacy — make it cordial, cálido and inviting so they leave excited to come.
- DISCOVER MOTIVATION naturally, ONE question at a time (never an interrogation): who's it for? what are they driving now? what made them start looking NOW? what matters most in the next car? what do they want to avoid from last time? if it works, how soon do they need it? People buy a CHANGE in their life, not just features.
- TACTICAL EMPATHY (Chris Voss — warm, never confrontational):
  · LABEL what they feel: "It sounds like your main concern is your credit." "It seems like you want to know the trip is worth it before driving out."
  · MIRROR: repeat their last key words as a question ("I'm worried about my credit." → "Your credit?") to get them to open up. Once per key moment, not every message.
  · CALIBRATED questions (invite them to think, don't command): "What would a comfortable plan look like for you?" "What would stop you from moving forward if you like the car?" "What would you need to know before making the drive?"
  · NO-ORIENTED questions (people feel safe saying no): "Would you be against stopping by tomorrow?" "Would it be a bad idea to have it ready at 10:30?" Natural, not every message.
  · ACCUSATION AUDIT: name their worry before they do → "You may feel the down payment sounds like a lot — that's exactly why we'd rather sit down and find a structure that fits you; and if you can do about 50% down, you're approved on the spot."
- OBJECTIONS are usually a symptom of a deeper concern — DON'T answer the first version. Use 5 steps: (1) validate ("I understand, that's a real amount"), (2) label ("it sounds like the down payment is the main thing"), (3) clarify ("is it that you don't have it available, or you'd rather keep some set aside?"), (4) isolate ("other than that, is anything else holding you back?"), (5) resolve + ASK for the commitment ("if we found a responsible structure you're comfortable with, would you be ready to move forward?").
- COMMON OBJECTIONS: "I need to think about it" → "Usually there's one specific part that doesn't feel right yet — is it the vehicle, the amount today, the payments, or something else?"  ·  "Payment too high" → "What amount would feel responsible instead of stressful?"  ·  "Found one cheaper" → ask what it includes and its condition, compare the TOTAL, never attack the other car  ·  "Can you lower the price?" → "Possibly, depending on the full deal — are you comfortable with the car itself and ready to move forward if we reach fair numbers?"
- CONVERSATION ARC (a flexible route, NOT a rigid script): open human → discover → soft-qualify (down payment, payment comfort, timing, trade, who decides — phrased warmly, never like a bank form) → tailor the value to what THEY told you → micro-commitment ("does this sound close to what you're looking for?") → specific appointment (offer two options: "would 11 or 12 work better?") → confirm.
- Keep the frame calm and in control. Your energy is "I don't need to convince everyone — I need to understand you, tell the truth, and see if there's a good deal here," NOT "please come, we'll do anything."

FINANCING (in-house):
- Do we finance? → "Yes — we offer in-house short-term financing AND credit options. Two simple paths: with about 50% down you're approved on the spot (we finance it ourselves); with less down we still have options and look at your situation. Best thing is to come by, see it, and we'll find the right fit."
- Credit: we now work with many different credit situations, so credit is NOT the main barrier — but NEVER guarantee approval for less than 50% down → "Since a lot of it is in-house, your credit isn't the only thing we look at — we consider your overall situation, income, down payment, and the vehicle. With about 50% down you're approved on the spot; with less we'd review your situation together." NEVER say "everyone is approved", "credit doesn't matter", "guaranteed approval", "you're approved" (for less than 50% down), or "no credit check".
- Down payment — THE KEY RULE: with about **50% down you are APPROVED ON THE SPOT** and we finance it in-house ourselves — this is the ideal, so gently steer people toward it (it also gets them the best, simplest terms). With LESS than 50%, we are FLEXIBLE and can start as low as about **5–10% down** depending on the person's situation, the vehicle, and their credit — so NEVER turn anyone away for a small down payment; it's just reviewed case by case and is NOT automatic. Example: "If you come with around 50% down, you're approved on the spot. With less, we still have options — we'd look at your situation and find the best path. Best thing is to come see the car and sit down with us." NEVER promise approval by message for less than 50%, and never say "guaranteed approval", "everyone is approved", or "no credit check".
- Zero down → "We do ask for a down payment — zero down isn't our usual structure — but even a small amount (around 5–10%) can work depending on your situation. And with about 50% down you're approved on the spot. Come by and we'll find your best option."
- Plans are SHORT-TERM — don't promise long terms; exact term and payment are gone over in person.

PRICE:
- NEVER give a final / out-the-door / lowest price by message → "I'd be happy to work with you once you've seen and driven it. Would you be against coming by so we can look it over and discuss the best available price in person?"
- Low offer: never mock, get offended, or argue → "Thanks for the offer — I wouldn't be able to do that amount, but I'd be happy to work with you in person. Come see it first, and if it's the right one, we'll do our best to put together a fair deal."
- Coming from far (e.g. Bakersfield): acknowledge the effort and offer to have the car + history report ready.
- Hostile / insulting customer: don't defend the car or argue → "Thank you for sharing your perspective. We respect your opinion and wish you the best in finding the right vehicle for your needs. Have a great day."

TRADE-INS: "Yes, we accept trade-ins. Bring it with you so we can inspect it, appraise it accurately, and see how the numbers work toward the vehicle you want." NEVER give an exact appraisal from photos/description — final value is ALWAYS in person. If useful, ask year/make/model, mileage, title (clean/salvage), if they owe money, mechanical issues, VIN, photos — but the appraisal is still in person.

VEHICLE INFO — HONESTY IS SACRED. Only mention things CONFIRMED in the vehicle's listing below. NEVER invent: number of owners, accident history, title type, mileage, warranty, equipment, registration status, smog date, or repairs done. If it's not in the info you have → "Let me verify that for you before giving you the wrong information."
- When you mention or offer a car, lead with just the YEAR, MAKE and MODEL (e.g. "the 2019 Nissan Altima"). Do NOT volunteer the mileage or a spec dump. Only give the mileage if they specifically ask for it.
- Vehicle history: NEVER use the word "Carfax" or any brand name — always say "vehicle history report" / "reporte de historial del vehículo". If we have it, offer to show it IN PERSON, don't send the full report → "Yes, it has a clean title, and we have the vehicle history report available here for you to review. Would you be against stopping by to see it?"
- Condition → "It's in very good condition, fully serviced, and ready to drive — you're welcome to inspect it and take a test drive." Don't say "no problems at all" unless confirmed; prefer "no known mechanical issues at this time."
- Warranty: only if confirmed for that vehicle → "It includes a 1,000-mile limited warranty for extra peace of mind." Never present it as bumper-to-bumper or full coverage.
- Insurance & title (only if they ask): the buyer gets their own full-coverage insurance (we don't provide the policy) and it must list Legacy Motors Garage LLC as lienholder; we can refer an agent. The car is registered in their name with Legacy as lienholder until paid in full, then we do the lien release. Don't promise insurance cost or an immediate free-and-clear title.

HARD RULES — never break:
- NEVER promise they'll "drive off the same day" or take the car home before documents, insurance, down payment, and terms are reviewed in person.
- Don't promise approval, final price, appraisal, or exact terms by message.
- Can't confirm something? → "I don't want to give you the wrong information — let me verify and get you an accurate answer." If it depends on review → "We may have options, but we'd need to review everything with you before confirming the exact terms."
- Don't invent cars or specs — use only the inventory below; if we don't have exactly what they want, offer a close option and invite them in.
- Stay on topic (cars, financing, visiting). Hours: Mon–Fri 9am–5pm; Sat & Sun by appointment. We work mainly BY APPOINTMENT and are flexible — if their schedule is unusual, tell them to message us and we'll work around it. Don't tell them to come "anytime" when we need to coordinate staff — pin down a time.
- ETHICS OF THE CLOSE: only guide toward a deal that's clear, informed, and sustainable for BOTH sides. Never push someone into a payment they can't realistically finish, never use guilt/shame/fear or fake urgency, never reframe a genuine "no" as invalid, never talk so fast/pushy they can't think. Persistence is not harassment. An irresponsible deal today becomes a late payment, a repo, and a bad review tomorrow.

📅 BOOKING APPOINTMENTS (very important — this is how we win):
- Today is ${todayStr} (Pacific time). Use this to resolve dates the customer says ("tomorrow", "this Saturday", "el sábado") into an exact calendar date.
- Your BEST outcome is a concrete appointment. BE PROACTIVE — don't wait for the customer to ask or insist. As soon as there's genuine interest, YOU suggest coming in and offer a specific day and time (two options work great: "would Thursday at 11 or 12 work better?"). Lead them to the visit; never make them be the one pushing to come in.
- To lock it in you need their NAME and a PHONE NUMBER so our team can confirm. Ask for these gently and naturally ("¿A qué nombre y a qué número te confirmamos la cita?").
- LEARN USEFUL INTEL as you build rapport (weave it in naturally, ONE or TWO questions at a time — this must feel like a warm conversation, NEVER an interrogation or a loan form): what they'll use the car for, roughly how much they can put DOWN, roughly what WEEKLY or BIWEEKLY payment they'd be comfortable with, whether they're WORKING (and where / how long — we're Buy-Here-Pay-Here so steady income helps them qualify), whether they have a valid DRIVER'S LICENSE, whether they have a TRADE-IN (and what), and HOW SOON they need the car. Gather what you naturally can; it's totally fine not to get everything.
- ONCE you have at least a name, a phone number, and a day → call the \`book_appointment\` tool. Fill in EVERYTHING you learned (date as YYYY-MM-DD, time as HH:MM 24-hour if given, car interest, down payment, weekly/biweekly payment comfort, work situation, driver's license, trade-in, how soon they need it, and any other useful notes) so our team walks into the appointment already knowing this person and how to help them close.
- ALSO write two short things for our salesperson so they can greet this customer WARMLY and never cold: (a) "summary" = a VERY SHORT story-style recap (2–4 sentences, in Spanish unless the customer wrote in English) of who this person is, what they're driving/dealing with, why they're looking now, and what they really want/feel — like briefing a teammate before the customer walks in. (b) "suggested_approach" = 1–2 sentences on how to best help and close them in person (their real concern, which certainty to build, what to lead with). Write these like a helpful human colleague, warm and specific — NOT a form.
- After the tool saves it, warmly CONFIRM back to the customer (repeat the day/time) and tell them our team will text them to confirm and that we look forward to seeing them. Do NOT call the tool again for the same appointment.
- If they're not ready to commit to a day yet, don't force it — keep building trust and invite them to come by anytime during hours.

INVENTORY & "when will you have more / do you have X?": We get NEW cars EVERY WEEK and ALWAYS have more in prep/production coming in that aren't listed below yet. So NEVER dead-end someone with "we don't have that / I don't know when we'll get more." Instead: tell them we get cars every week and usually have more about to come out (like SUVs, trucks, or sedans), and invite them to come see what's here AND what's about to arrive so they don't miss it. Example: "We actually get new cars every week, and we've got some really nice SUVs about to come out that would fit you great. Come take a look so they don't get taken. What day are you off this week?" Keep it TRUE and general: don't invent a specific unit, exact price, or exact arrival date.

CARS AVAILABLE RIGHT NOW:
${inv}`;
}
// 🗓️ Guarda una cita generada por el bot de ventas en la MISMA colección/formato que el CRM (admin.html) y el portal.
async function saveBotAppointment(input, lang) {
  const s = (v, n) => (v == null ? "" : String(v)).trim().slice(0, n);
  const name = s(input.name, 80);
  const phone = s(input.phone, 30);
  const date = s(input.date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("bad date");
  const tm = s(input.time, 5).match(/^(\d{1,2}):(\d{2})$/);
  const time = tm ? (String(Math.min(23, +tm[1])).padStart(2, "0") + ":" + tm[2]) : "";
  const car = s(input.car_interest, 120);
  const city = s(input.city, 60);
  const down = s(input.down_payment, 40);
  const weekly = s(input.weekly_payment, 40);
  const works = s(input.works, 140);
  const license = s(input.has_license, 30);
  const trade = s(input.trade_in, 120);
  const urgency = s(input.urgency, 60);
  const extra = s(input.notes, 300);
  const summary = s(input.summary, 600);
  const approach = s(input.suggested_approach, 400);
  const en = lang === "en";
  // 🧠 Intel estructurado del cliente (para que el equipo llegue a la cita sabiendo cómo cerrar)
  const leadInfo = { down, weekly, works, license, trade, urgency, extra, city };
  const L = {
    city: en ? "📍 From" : "📍 De", down: en ? "💵 Down" : "💵 Enganche", weekly: en ? "📆 Payment" : "📆 Pago cómodo",
    works: en ? "💼 Work" : "💼 Trabajo", license: en ? "🪪 License" : "🪪 Licencia",
    trade: en ? "🔁 Trade-in" : "🔁 Cambio", urgency: en ? "⏱️ Needs it" : "⏱️ Urgencia",
  };
  const noteParts = [];
  if (city) noteParts.push(L.city + ": " + city);
  if (down) noteParts.push(L.down + ": " + down);
  if (weekly) noteParts.push(L.weekly + ": " + weekly);
  if (works) noteParts.push(L.works + ": " + works);
  if (license) noteParts.push(L.license + ": " + license);
  if (trade) noteParts.push(L.trade + ": " + trade);
  if (urgency) noteParts.push(L.urgency + ": " + urgency);
  if (extra) noteParts.push(extra);
  noteParts.push(en ? "(Lead from website bot)" : "(Lead del bot de la web)");
  const id = "appt_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
  const data = {
    clientId: "", clientName: name, phone, phoneE164: "", lang,
    carLabel: car, vin: "", type: (en ? "Sale" : "Venta"), services: [{ es: "Venta", en: "Sale" }],
    date, time, note: noteParts.join(" · "), downPayment: down, leadInfo,
    botSummary: summary, botApproach: approach,
    status: "scheduled", confirmSent: false, reminderSent: false, source: "web-bot",
    createdAt: new Date().toISOString(), createdBy: "web-bot",
  };
  await admin.firestore().collection("appointments").doc(id).set(data);
  return data;
}
exports.siteChat = onRequest({ secrets: [ANTHROPIC_KEY], cors: true, timeoutSeconds: 60 }, async (req, res) => {
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  const lang = (req.body && req.body.lang === "en") ? "en" : "es";
  try {
    const msgsIn = Array.isArray(req.body && req.body.messages) ? req.body.messages.slice(-12) : [];
    let cars = [];
    try {
      const snap = await admin.firestore().collection("inventory").get();
      cars = snap.docs.map((d) => d.data())
        .filter((c) => c.status !== "sold" && c.status !== "prep")
        .slice(0, 80)
        .map((c) => [c.year, c.make, c.model].filter(Boolean).join(" ") + (c.miles ? " · " + Number(c.miles).toLocaleString() + " mi" : ""));
    } catch (e) {}
    // Fecha de HOY en hora del Pacífico (Porterville) para que el bot resuelva "mañana", "el sábado", etc.
    let todayStr = "";
    try {
      const ld = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(new Date());
      const iso = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      todayStr = ld + " (" + iso + ")";
    } catch (e) { todayStr = new Date().toISOString().slice(0, 10); }
    // 🧠 Prompt caching: el prompt grande (persona + curso de cierre + inventario) se cachea y se reusa en cada mensaje → baja el costo de entrada 50-90%.
    const system = [{ type: "text", text: buildSitePrompt(cars.length ? cars.join("\n") : "(ask and we'll check availability)", todayStr), cache_control: { type: "ephemeral" } }];
    const AnthropicMod = require("@anthropic-ai/sdk");
    const Anthropic = AnthropicMod.Anthropic || AnthropicMod.default || AnthropicMod;
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY.value() });
    const messages = msgsIn.filter((m) => m && m.content).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content).slice(0, 1200) }));
    if (!messages.length || messages[0].role !== "user") messages.unshift({ role: "user", content: lang === "en" ? "Hi" : "Hola" });

    const bookTool = {
      name: "book_appointment",
      description: "Save a real appointment for a customer who agreed to come in on a specific day. Only call when you have at least their name, phone number, and a day.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Customer's name" },
          phone: { type: "string", description: "Customer's phone number" },
          car_interest: { type: "string", description: "The car they're interested in (year make model), if known" },
          city: { type: "string", description: "What town/area of the Central Valley they're from (Porterville, Visalia, Tulare, Delano, Bakersfield, Fresno, etc.), if mentioned" },
          date: { type: "string", description: "Appointment date as YYYY-MM-DD (resolve relative dates using today's date given in the system prompt)" },
          time: { type: "string", description: "Appointment time as HH:MM 24-hour, if they gave one" },
          down_payment: { type: "string", description: "Roughly how much they can put DOWN, if mentioned" },
          weekly_payment: { type: "string", description: "Roughly what weekly or biweekly/monthly PAYMENT they'd be comfortable with, if mentioned" },
          works: { type: "string", description: "Their work / income situation — do they have a job, where, how long (important for Buy-Here-Pay-Here)" },
          has_license: { type: "string", description: "Do they have a valid driver's license? (yes / no / unsure)" },
          trade_in: { type: "string", description: "Do they have a car to trade in, and what is it, if mentioned" },
          urgency: { type: "string", description: "How soon they need the car (today, this week, just looking, etc.)" },
          notes: { type: "string", description: "Any other useful notes (family size, what they use the car for, concerns, budget, etc.)" },
          summary: { type: "string", description: "VERY SHORT story-style recap (2-4 sentences, in the customer's language) of who this person is, their situation, why they're looking now, and what they really want — to brief the salesperson so they greet them warmly, not cold." },
          suggested_approach: { type: "string", description: "1-2 sentences on how to best help and close this customer in person (their real concern, which certainty to build, what to lead with)." },
        },
        required: ["name", "phone", "date"],
      },
    };

    let totalIn = 0, totalOut = 0, booked = null, guard = 0;
    let msg = await client.messages.create({ model: SITE_BOT_MODEL, max_tokens: 600, system, messages, tools: [bookTool] });
    totalIn += (msg.usage && msg.usage.input_tokens) || 0; totalOut += (msg.usage && msg.usage.output_tokens) || 0;
    while (msg.stop_reason === "tool_use" && guard < 4) {
      guard++;
      messages.push({ role: "assistant", content: msg.content });
      const results = [];
      for (const block of (msg.content || [])) {
        if (block.type === "tool_use" && block.name === "book_appointment") {
          let content;
          try { booked = await saveBotAppointment(block.input || {}, lang); content = "Appointment saved successfully. Now warmly confirm the day/time to the customer and tell them our team will text them to confirm. Do NOT call the tool again."; }
          catch (e) { content = "Could not save the appointment (" + String((e && e.message) || e) + "). Ask the customer to confirm the day and their phone number, or invite them to just come by during business hours."; }
          results.push({ type: "tool_result", tool_use_id: block.id, content });
        } else if (block.type === "tool_use") {
          results.push({ type: "tool_result", tool_use_id: block.id, content: "Just reply to the customer in text now." });
        }
      }
      messages.push({ role: "user", content: results });
      msg = await client.messages.create({ model: SITE_BOT_MODEL, max_tokens: 600, system, messages, tools: [bookTool] });
      totalIn += (msg.usage && msg.usage.input_tokens) || 0; totalOut += (msg.usage && msg.usage.output_tokens) || 0;
    }
    let reply = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    // 🛟 Si el modelo terminó sin texto (p.ej. quiso usar la herramienta otra vez), forzamos una respuesta natural SIN herramientas usando todo el contexto — así NUNCA se ve el reset genérico "How can I help..."
    if (!reply) {
      try {
        if (msg.stop_reason === "tool_use") {
          messages.push({ role: "assistant", content: msg.content });
          messages.push({ role: "user", content: (msg.content || []).filter((b) => b.type === "tool_use").map((b) => ({ type: "tool_result", tool_use_id: b.id, content: "Already handled. Reply to the customer warmly in text now; do NOT call the tool again." })) });
        }
        const fin = await client.messages.create({ model: SITE_BOT_MODEL, max_tokens: 400, system, messages });
        totalIn += (fin.usage && fin.usage.input_tokens) || 0; totalOut += (fin.usage && fin.usage.output_tokens) || 0;
        reply = (fin.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      } catch (e) { /* usamos el fallback de abajo */ }
    }
    // 🧮 Taxímetro INDEPENDIENTE del bot de la web (config/aiUsage, claves "site_") — suma todo el ciclo de tool-use
    try {
      const cost = +((totalIn / 1e6) * 3 + (totalOut / 1e6) * 15).toFixed(6);
      const ym = new Date().toISOString().slice(0, 7).replace("-", "_");
      const inc = admin.firestore.FieldValue.increment;
      await admin.firestore().collection("config").doc("aiUsage").set({
        siteUsd: inc(cost), siteCount: inc(1), siteLastUsd: cost,
        ["site_m_" + ym + "_usd"]: inc(cost), ["site_m_" + ym + "_count"]: inc(1),
        siteUpdatedAt: new Date().toISOString(),
      }, { merge: true });
    } catch (e) {}
    const lastFallback = booked
      ? (lang === "en" ? "You're all set! 🙌 It'll be a real pleasure to meet you and take care of you in person — we'll be waiting for you. We'll text you to confirm. 🚗" : "¡Listo, ya quedó tu cita! 🙌 Me va a dar mucho gusto conocerte y atenderte en persona — aquí te esperamos, vas a estar en muy buenas manos. Te mandamos un mensajito para confirmar. 🚗")
      : (lang === "en" ? "Sorry, that got cut off. Could you tell me a bit more about what you're looking for?" : "Perdón, se me cortó. ¿Me cuentas un poco más de lo que andas buscando?");
    const finalReply = reply || lastFallback;
    // 📝 REGISTRO de la conversación (solo dueño) + contador diario de personas. No rompe la respuesta si falla.
    try {
      const convoId = String((req.body && req.body.convoId) || "").slice(0, 80).replace(/[^\w-]/g, "");
      if (convoId) {
        const now = new Date().toISOString();
        const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());  // YYYY-MM-DD Pacífico
        const lastUser = msgsIn.slice().reverse().find((m) => m && m.role !== "assistant" && m.content);
        const turn = [];
        if (lastUser && lastUser.content) turn.push({ role: "user", text: String(lastUser.content).slice(0, 1500), at: now });
        turn.push({ role: "assistant", text: String(finalReply).slice(0, 2000), at: now });
        const ref = admin.firestore().collection("bot_convos").doc(convoId);
        const snap = await ref.get();
        if (!snap.exists) {
          await ref.set({ convoId, lang, startedAt: now, lastAt: now, date: dateStr,
            firstMsg: (lastUser && lastUser.content) ? String(lastUser.content).slice(0, 200) : "",
            messages: turn, msgCount: turn.length, booked: !!booked });
          await admin.firestore().collection("bot_stats").doc(dateStr).set({ date: dateStr,
            convos: admin.firestore.FieldValue.increment(1), messages: admin.firestore.FieldValue.increment(turn.length), updatedAt: now }, { merge: true });
        } else {
          const prev = snap.data().messages || [];
          await ref.set({ lastAt: now, messages: prev.concat(turn).slice(-300), msgCount: (snap.data().msgCount || prev.length) + turn.length, booked: (snap.data().booked || !!booked) }, { merge: true });
          await admin.firestore().collection("bot_stats").doc(dateStr).set({ messages: admin.firestore.FieldValue.increment(turn.length), updatedAt: now }, { merge: true });
        }
      }
    } catch (e) { /* el log nunca debe tumbar la respuesta */ }
    res.json({ reply: finalReply, booked: !!booked });
  } catch (e) {
    console.log("siteChat", e);
    res.json({ reply: lang === "en" ? "Sorry, I had a hiccup — call us at (559) 540-5145 and we'll help you right away." : "Perdón, tuve un detalle — llámanos al (559) 540-5145 y con gusto te ayudamos." });
  }
});

// 💬 Repaso de las conversaciones del bot de ventas (SOLO dueños ev@ / ivan.garcia@). Lee vía backend → no expone las pláticas al cliente.
function salesOwnerOnly(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const email = ((request.auth.token && request.auth.token.email) || "").toLowerCase();
  if (email !== "ev@legacymotorsgarage.com" && email !== "ivan.garcia@legacymotorsgarage.com") throw new HttpsError("permission-denied", "Solo dueños.");
}
// 👥 CUENTAS DEL EQUIPO — SOLO el dueño (ev@). Poner/cambiar contraseñas sin depender de correos.
function ownerStrict(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const email = ((request.auth.token && request.auth.token.email) || "").toLowerCase();
  if (email !== "ev@legacymotorsgarage.com") throw new HttpsError("permission-denied", "Solo el dueño puede administrar cuentas.");
}
exports.teamListUsers = onCall({ timeoutSeconds: 30 }, async (request) => {
  ownerStrict(request);
  const out = [];
  let pageToken;
  do {
    const res = await admin.auth().listUsers(1000, pageToken);
    res.users.forEach((u) => {
      if (!u.email) return; // ignora sesiones anónimas del sitio (visitantes/bot): solo el equipo con correo
      out.push({
        uid: u.uid,
        email: u.email,
        disabled: !!u.disabled,
        lastSignIn: (u.metadata && u.metadata.lastSignInTime) || "",
        created: (u.metadata && u.metadata.creationTime) || "",
      });
    });
    pageToken = res.pageToken;
  } while (pageToken);
  out.sort((a, b) => (a.email || "").localeCompare(b.email || ""));
  return { users: out };
});
exports.teamSetPassword = onCall({ timeoutSeconds: 30 }, async (request) => {
  ownerStrict(request);
  const d = request.data || {};
  const password = String(d.password || "");
  if (password.length < 6) throw new HttpsError("invalid-argument", "La contraseña debe tener al menos 6 caracteres.");
  let uid = String(d.uid || "").trim();
  const email = String(d.email || "").trim().toLowerCase();
  if (!uid && email) {
    const u = await admin.auth().getUserByEmail(email);
    uid = u.uid;
  }
  if (!uid) throw new HttpsError("invalid-argument", "Falta el usuario.");
  await admin.auth().updateUser(uid, { password });
  return { ok: true };
});
// ⚙️ Escribe docs de config vía backend (evita tocar las reglas de Firestore). Whitelist por doc:
//   sellerSignature = SOLO dueño ev@ · stickerBatch/binBatch = cualquier usuario del almacén (staff).
exports.cfgSet = onCall({ timeoutSeconds: 30 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const email = ((request.auth.token && request.auth.token.email) || "").toLowerCase();
  const docId = String((request.data && request.data.docId) || "").trim();
  const data = (request.data && request.data.data) || {};
  // "owner" = solo ev@ (firma del vendedor); "partners" = cualquiera de los dueños (ev@ / Ivan); "staff" = equipo.
  const RULES = { sellerSignature: "owner", stickerBatch: "staff", binBatch: "staff", timeclock: "partners" };
  const level = RULES[docId];
  if (!level) throw new HttpsError("permission-denied", "Documento de config no permitido.");
  if (level === "owner" && email !== "ev@legacymotorsgarage.com") throw new HttpsError("permission-denied", "Solo el dueño.");
  if (level === "partners" && !OWNER_EMAILS.includes(email)) throw new HttpsError("permission-denied", "Solo los dueños.");
  if (typeof data !== "object" || Array.isArray(data)) throw new HttpsError("invalid-argument", "Datos inválidos.");
  await admin.firestore().collection("config").doc(docId).set(data, { merge: true });
  return { ok: true };
});
// ===== 🕐 RELOJ DE EMPLEADOS (check-in/out con GPS validado en el servidor) =====
const OWNER_EMAILS = ["ev@legacymotorsgarage.com", "ivan.garcia@legacymotorsgarage.com"];
// Dueños reconocidos por default en el equipo (todas las funciones, SIN reloj). No son empleados que fichan.
const OWNER_NAMES = { "ev@legacymotorsgarage.com": "Enrique", "ivan.garcia@legacymotorsgarage.com": "Ivan" };
// 💵 Tarifa de LABOR de los dueños (Enrique/Ivan) SOLO para costo de labor (tiempo×tarifa → costo del carro).
// NO es nómina: los dueños no fichan asistencia. Decidido por Enrique: $16.25/h (como Ayudante general).
const OWNER_LABOR_RATE = 16.25;
// 💪 COSTO DE LABOR por carro (INTERNO / gerencial) — tiempo × tarifa. NO toca Finanzas (NO crea transacción):
// acumula `laborCents`/`laborMin` en el carro (campo aparte) + bitácora `labor_log` (para P&L por carro y reporte por empleado).
async function _addCarLabor(db, rawCarId, info) {
  try {
    const raw = String(rawCarId || ""); if (!raw) return 0;
    let kind = "inventory", docId = raw;
    if (raw.indexOf("inv:") === 0) { kind = "inventory"; docId = raw.slice(4); }
    else if (raw.indexOf("dis:") === 0) { kind = "dismantle_vehicles"; docId = raw.slice(4); }
    const minutes = Math.max(0, Number(info.minutes) || 0);
    const rate = Math.max(0, Number(info.rate) || 0);   // $/h
    const costCents = Math.round((minutes / 60) * rate * 100);
    if (minutes <= 0 && costCents <= 0) return 0;
    const inc = admin.firestore.FieldValue.increment;
    try { await db.collection(kind).doc(docId).set({ laborCents: inc(costCents), laborMin: inc(Math.round(minutes)), laborUpdatedAt: new Date().toISOString() }, { merge: true }); } catch (e) {}
    try {
      await db.collection("labor_log").add({
        carId: docId, carKind: kind, carLabel: String(info.carLabel || ""),
        workerKey: String(info.workerKey || ""), workerName: String(info.workerName || ""), empId: String(info.empId || ""), role: String(info.role || ""),
        line: String(info.line || ""), minutes: Math.round(minutes), rateCents: Math.round(rate * 100), costCents: costCents,
        source: String(info.source || ""), refId: String(info.refId || ""), title: String(info.title || ""),
        at: new Date().toISOString(),
      });
    } catch (e) {}
    return costCents;
  } catch (e) { return 0; }
}
function _haversineM(aLat, aLng, bLat, bLng) {
  const R = 6371000, toR = (x) => x * Math.PI / 180;
  const dLat = toR(bLat - aLat), dLng = toR(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function _laMondayKey(now) {
  now = now || new Date();
  const dstr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(now); // YYYY-MM-DD
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short" }).format(now);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const offset = ((map[wd] || 0) + 6) % 7; // días desde el lunes
  const d = new Date(dstr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}
async function _tcConfig() {
  try { const s = await admin.firestore().collection("config").doc("timeclock").get(); return s.exists ? s.data() : {}; }
  catch (e) { return {}; }
}
// Verifica el GPS contra las ubicaciones configuradas (dealer/yonke). Devuelve {ok, location, distM}.
function _checkGeofence(cfg, lat, lng) {
  const radius = Number(cfg.radiusM) || 150;
  const spots = [["dealer", cfg.dealer], ["yonke", cfg.yonke]].filter((x) => x[1] && x[1].lat != null);
  if (!spots.length) return { ok: true, location: "(sin ubicación)", distM: null }; // aún no configurada → no bloquea
  if (lat == null || lng == null) return { ok: false, location: null, distM: null, noGps: true };
  let best = null;
  for (const [name, s] of spots) {
    const d = _haversineM(lat, lng, Number(s.lat), Number(s.lng));
    if (best === null || d < best.distM) best = { location: name, distM: d };
  }
  return { ok: best.distM <= radius, location: best.location, distM: Math.round(best.distM) };
}
function _emailKey(email) { return String(email || "").replace(/[/#?]/g, "_"); }
// Catálogo de FUNCIONES/tareas (debe coincidir con EMP_ROLES en finanzas.html y ROLE_TILES en empleado.html).
const ALL_EMP_ROLES = ["Detallador", "Fotos", "Mecánico", "Empaque", "Captura", "Listado", "Desmantelador", "Limpieza", "Ayudante general", "Oficina", "Ventas"];
// Teléfono → E.164 (igual que _empE164 en finanzas.html).
function _toE164(s) { const d = String(s || "").replace(/\D/g, ""); if (d.length === 10) return "+1" + d; if (d.length === 11 && d[0] === "1") return "+" + d; return ""; }
// Resuelve QUIÉN llama: dueño/staff por CORREO, o empleado por TELÉFONO (registro `employees`).
// Devuelve { key, name, email, phone, empId, roles, rate, photoURL, isOwner, active, notRegistered }.
async function _actorIdentity(request) {
  if (!request.auth) return null;
  const tok = request.auth.token || {};
  const email = String(tok.email || "").toLowerCase();
  const phone = String(tok.phone_number || "");
  if (email) {
    const isOwner = OWNER_EMAILS.includes(email);
    // 👁️ VER COMO EMPLEADO (solo dueño): si el dueño manda asEmpId, actúa como ESE empleado → todas las callables devuelven lo de él.
    const asEmpId = isOwner ? String((request.data || {}).asEmpId || "") : "";
    if (asEmpId) {
      try {
        const es = await admin.firestore().collection("employees").doc(asEmpId).get();
        if (es.exists) {
          const d = es.data() || {};
          return { key: "emp_" + asEmpId, name: d.name || "Empleado", email: "", phone: d.phoneE164 || "", empId: asEmpId, roles: Array.isArray(d.roles) ? d.roles : [], rate: Number(d.rate) || 0, photoURL: d.photoURL || "", active: d.active !== false, isOwner: false, notRegistered: false, impersonatedBy: email };
        }
      } catch (e) {}
    }
    return { key: _emailKey(email), name: (isOwner && OWNER_NAMES[email]) || tok.name || email.split("@")[0], email, phone: "", empId: "", roles: [], rate: isOwner ? OWNER_LABOR_RATE : 0, photoURL: "", active: true, isOwner, notRegistered: false };
  }
  if (phone) {
    const key = "ph_" + phone.replace(/\D/g, "");
    let snap;
    try { snap = await admin.firestore().collection("employees").where("phoneE164", "==", phone).limit(1).get(); }
    catch (e) { snap = { empty: true }; }
    if (snap && !snap.empty) {
      const docSnap = snap.docs[0]; const d = docSnap.data() || {};
      return { key, name: d.name || "Empleado", email: "", phone, empId: docSnap.id, roles: Array.isArray(d.roles) ? d.roles : [], rate: Number(d.rate) || 0, photoURL: d.photoURL || "", active: d.active !== false, isOwner: d.owner === true, notRegistered: false };
    }
    return { key, name: "", email: "", phone, empId: "", roles: [], rate: 0, photoURL: "", active: false, isOwner: false, notRegistered: true };
  }
  return null;
}
// La app del empleado llama esto al iniciar sesión → sabe su nombre y qué roles mostrarle.
exports.empMe = onCall({ timeoutSeconds: 20 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id) throw new HttpsError("unauthenticated", "Sin identidad.");
  if (id.email) {
    // Dueño/staff entrando por correo (para pruebas): ve todos los roles.
    return { ok: true, found: true, active: true, name: id.name, roles: id.isOwner ? ALL_EMP_ROLES : [], empId: "", photoURL: "", isOwner: id.isOwner, via: "email" };
  }
  if (id.notRegistered) return { ok: true, found: false, phone: id.phone, via: "phone" };
  if (!id.active) return { ok: true, found: true, active: false, name: id.name, roles: [], empId: id.empId, photoURL: id.photoURL, via: "phone" };
  return { ok: true, found: true, active: true, name: id.name, roles: id.roles, empId: id.empId, photoURL: id.photoURL, rate: id.rate, isOwner: id.isOwner, via: "phone" };
});

// 🔧 SERVICE Fase 2: las órdenes asignadas al empleado que llama (mecánico/detallador/…).
// Los empleados entran por TELÉFONO (no son staff), así que leen sus órdenes por aquí, no directo de Firestore.
const SVC_ORDER_STATUSES = ["agendado", "por_recibir", "recibido", "en_proceso", "pausado_partes", "listo", "entregado"];
// 🔧 LÍNEA DE PRODUCCIÓN (relevo por rol) — mismas reglas que admin.html. Orden fijo; configurable para reusar en inventario.
const SVC_ROLE_PIPELINE = ["Mecánico", "Detallador"];
function svcRoleRankSrv(r) { const i = SVC_ROLE_PIPELINE.indexOf(r); return i < 0 ? 99 : i; }
// Etapa ACTIVA = el primer rol de la línea con servicios sin terminar (null = todo listo).
// Si un servicio no trae rol, usa defRole (el rol de la orden) — igual que el admin.
function svcActiveRoleSrv(services, defRole) {
  const by = {}; (services || []).forEach((s) => { const r = s.role || defRole || "Mecánico"; (by[r] = by[r] || []).push(s); });
  const roles = Object.keys(by).sort((a, b) => svcRoleRankSrv(a) - svcRoleRankSrv(b));
  for (const r of roles) { if (by[r].some((s) => (s.status || "pendiente") !== "listo")) return r; }
  return null;
}
// Índices de servicios que le tocan a este trabajador (por persona asignada, o por rol si no hay persona fija).
function svcWorkerServiceIdx(services, id, defRole) {
  const out = [];
  (services || []).forEach((s, i) => {
    const role = s.role || defRole;
    const byEmp = s.assignEmpId && id.empId && s.assignEmpId === id.empId;
    const byRole = !s.assignEmpId && role && Array.isArray(id.roles) && id.roles.includes(role);
    if (byEmp || byRole) out.push(i);
  });
  return out;
}
// Estatus general de la orden derivado de la línea (conserva recepción/entrega).
function svcDeriveStatusSrv(o, svs) {
  if (!svs.length) return o.status || "por_recibir";
  const base = o.status || "por_recibir";
  if (base === "por_recibir" || base === "agendado" || base === "entregado") return base; // aún sin recibir / ya entregado
  if (!svcActiveRoleSrv(svs, o.assignRole)) return "listo";
  if (svs.some((s) => (s.status) === "en_proceso")) return "en_proceso";
  if (svs.some((s) => (s.status) === "pausado")) return "pausado_partes";
  return "recibido"; // recibido, etapa actual sin empezar
}
exports.svcMyOrders = onCall({ timeoutSeconds: 20 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id) throw new HttpsError("unauthenticated", "Sin identidad.");
  const db = admin.firestore();
  let docs = [];
  try { const snap = await db.collection("serviceOrders").get(); docs = snap.docs.map((d) => ({ id: d.id, ...d.data() })); } catch (e) {}
  const open = docs.filter((o) => o.status !== "entregado");
  const isStaff = (id.isOwner || id.email);
  let mine;
  if (isStaff) { mine = open; } // dueño/staff: ve todas (para probar)
  else if (id.empId || (Array.isArray(id.roles) && id.roles.length)) {
    mine = open.filter((o) => {
      const svs = Array.isArray(o.services) ? o.services : [];
      const bySvc = svs.length && svcWorkerServiceIdx(svs, id, o.assignRole).length > 0;     // por SERVICIO (rol del servicio o de la orden)
      const byOrder = (o.assignEmpId && o.assignEmpId === id.empId) || (!o.assignEmpId && o.assignRole && Array.isArray(id.roles) && id.roles.includes(o.assignRole)); // por orden (compat / respaldo)
      return bySvc || byOrder;
    });
  } else { mine = []; }
  const rank = { por_recibir: 0, recibido: 1, en_proceso: 2, pausado_partes: 3, agendado: 4, listo: 5 };
  mine.sort((a, b) => ((rank[a.status] == null ? 9 : rank[a.status]) - (rank[b.status] == null ? 9 : rank[b.status])) || ((a.scheduledAt || a.createdAt || "") < (b.scheduledAt || b.createdAt || "") ? -1 : 1));
  const out = mine.map((o) => {
    const svs = Array.isArray(o.services) ? o.services : [];
    const defRole = o.assignRole || "Mecánico";   // si un servicio no trae rol, usa el de la orden
    const activeRole = svcActiveRoleSrv(svs, defRole);
    const myIdx = isStaff ? svs.map((s, i) => i) : svcWorkerServiceIdx(svs, id, defRole);
    const myRoles = [...new Set(myIdx.map((i) => svs[i].role || defRole))];
    const myStageActive = isStaff ? true : myRoles.includes(activeRole);
    // La PRIMERA etapa de ESTA orden (no siempre Mecánico): la primera función presente según el orden de la línea.
    const presentRoles = [...new Set(svs.map((s) => s.role || defRole))].sort((a, b) => svcRoleRankSrv(a) - svcRoleRankSrv(b));
    const isFirstRole = activeRole && presentRoles[0] === activeRole;
    return {
      id: o.id, orderNum: o.orderNum || null, clientName: o.clientName || "", clientPhone: o.clientPhone || "",
      vin: o.vin || "", plate: o.plate || "", vehicleLabel: o.vehicleLabel || "",
      reason: o.reason || "", reasonEs: o.reasonEs || o.reason || "", reasonEn: o.reasonEn || o.reason || "",
      scheduledAt: o.scheduledAt || null, receivedAt: o.receivedAt || "", startedAt: o.startedAt || "", deliveredAt: o.deliveredAt || "",
      status: o.status || "por_recibir", paid: !!o.paid,
      assignRole: o.assignRole || "", assignName: o.assignName || "",
      // 🔧 línea / relevo
      activeRole: activeRole || "", myStageActive, waitingFor: (!myStageActive && activeRole) ? activeRole : "",
      canReceive: isStaff || (myRoles.includes(activeRole) && isFirstRole),
      services: svs.map((s) => ({ role: s.role || defRole, status: s.status || "pendiente", assignName: s.assignName || "", desc: s.desc || "", descEn: s.descEn || s.desc || "" })),
      myServices: myIdx.map((i) => ({ index: i, role: svs[i].role || defRole, status: svs[i].status || "pendiente", desc: svs[i].desc || "", descEn: svs[i].descEn || svs[i].desc || "" })),
    };
  });
  return { ok: true, orders: out, roles: id.roles || [], name: id.name || "" };
});
// 🔧 RELEVO: el trabajador marca SU etapa (empezar / pausar partes / reanudar / terminar). Al terminar su rol, el siguiente queda activo.
exports.svcServiceDone = onCall({ timeoutSeconds: 20 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id) throw new HttpsError("unauthenticated", "Sin identidad.");
  const d = request.data || {};
  const orderId = String(d.orderId || "");
  const action = String(d.action || "finish"); // start | pause | resume | finish
  if (!orderId) throw new HttpsError("invalid-argument", "Falta la orden.");
  const db = admin.firestore();
  const ref = db.collection("serviceOrders").doc(orderId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "La orden no existe.");
  const o = snap.data() || {};
  const svs = Array.isArray(o.services) ? o.services : [];
  if (!svs.length) throw new HttpsError("failed-precondition", "La orden no tiene servicios.");
  const isStaff = (id.isOwner || id.email);
  const defRole = o.assignRole || "Mecánico";
  const activeRole = svcActiveRoleSrv(svs, defRole);
  if (!activeRole) throw new HttpsError("failed-precondition", "La línea ya terminó.");
  // ¿qué servicios toca? staff: todos los del rol activo (o d.role). trabajador: los suyos del rol activo.
  let targetIdx;
  if (isStaff) {
    const role = d.role || activeRole;
    targetIdx = svs.map((s, i) => i).filter((i) => (svs[i].role || defRole) === role);
  } else {
    const myIdx = svcWorkerServiceIdx(svs, id, defRole);
    const myRoles = [...new Set(myIdx.map((i) => svs[i].role || defRole))];
    if (!myRoles.includes(activeRole)) throw new HttpsError("permission-denied", "Aún no es tu turno (espera a " + activeRole + ").");
    targetIdx = myIdx.filter((i) => (svs[i].role || defRole) === activeRole);
  }
  if (!targetIdx.length) throw new HttpsError("failed-precondition", "No hay servicios de esta etapa para ti.");
  const now = new Date().toISOString();
  targetIdx.forEach((i) => {
    if (action === "start" || action === "resume") { svs[i].status = "en_proceso"; if (!svs[i].startedAt) svs[i].startedAt = now; }
    else if (action === "pause") { svs[i].status = "pausado"; }
    else if (action === "finish") { svs[i].status = "listo"; svs[i].finishedAt = now; }
  });
  const newStatus = svcDeriveStatusSrv(o, svs);
  const patch = { services: svs, status: newStatus, updatedAt: now, updatedBy: id.email || id.name || id.empId || "" };
  if (newStatus === "en_proceso" && !o.startedAt) patch.startedAt = now;
  await ref.set(patch, { merge: true });
  return { ok: true, status: newStatus, activeRole: svcActiveRoleSrv(svs) };
});

// 🔧 SERVICE: el empleado asignado (o el dueño) mueve el estatus de la orden.
exports.svcOrderStatus = onCall({ timeoutSeconds: 20 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id) throw new HttpsError("unauthenticated", "Sin identidad.");
  const d = request.data || {};
  const orderId = String(d.orderId || "");
  const status = String(d.status || "");
  if (!orderId || SVC_ORDER_STATUSES.indexOf(status) < 0) throw new HttpsError("invalid-argument", "Datos inválidos.");
  const db = admin.firestore();
  const ref = db.collection("serviceOrders").doc(orderId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "La orden no existe.");
  const o = snap.data() || {};
  const mine = (o.assignEmpId && o.assignEmpId === id.empId) || (!o.assignEmpId && o.assignRole && Array.isArray(id.roles) && id.roles.includes(o.assignRole));
  if (!(id.isOwner || id.email || mine)) throw new HttpsError("permission-denied", "No es tu orden.");
  const patch = { status, updatedAt: new Date().toISOString(), updatedBy: id.email || id.name || id.empId || "" };
  if (status === "en_proceso" && !o.startedAt) patch.startedAt = new Date().toISOString();
  // ↩️ Si se REVIERTE a una etapa temprana (agendado/por recibir/recibido), reinicia los servicios a "pendiente"
  // para que el trabajo se reabra de verdad (el relevo arranca otra vez). Conserva rol/persona/precio/partes.
  const EARLY = ["agendado", "por_recibir", "recibido"];
  if (EARLY.indexOf(status) >= 0 && Array.isArray(o.services) && o.services.length) {
    patch.services = o.services.map((s) => Object.assign({}, s, { status: "pendiente" }));
  }
  await ref.set(patch, { merge: true });
  return { ok: true };
});

// 🔢 FOLIO de orden de servicio: contador ATÓMICO (counters/serviceOrders). Primer folio = #1001.
// Lo llama admin.html al CREAR una orden nueva. Owner o estación por correo o empleado con empId.
exports.svcNextNum = onCall({ timeoutSeconds: 20 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id || !(id.isOwner || id.email || id.empId)) throw new HttpsError("permission-denied", "Sin permiso.");
  const db = admin.firestore();
  const ref = db.collection("counters").doc("serviceOrders");
  const num = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const n = ((s.exists ? Number(s.data().n) : 0) || 1000) + 1;
    tx.set(ref, { n }, { merge: true });
    return n;
  });
  return { ok: true, num };
});

// 🔢 Backfill TEMPORAL de folios para órdenes viejas (por orden de creación). Un solo uso: ?key=lmgfin2026
exports.svcBackfillNums = onRequest(async (req, res) => {
  if ((req.query.key || "") !== "lmgfin2026") { res.status(403).json({ ok: false }); return; }
  try {
    const db = admin.firestore();
    const snap = await db.collection("serviceOrders").get();
    const docs = []; snap.forEach((d) => docs.push({ id: d.id, data: d.data() || {} }));
    docs.sort((a, b) => String(a.data.createdAt || "").localeCompare(String(b.data.createdAt || "")));
    const ref = db.collection("counters").doc("serviceOrders");
    const cs = await ref.get();
    let n = (cs.exists ? Number(cs.data().n) : 0) || 1000;
    const toSet = [];
    for (const o of docs) {
      if (o.data.orderNum) { if (Number(o.data.orderNum) > n) n = Number(o.data.orderNum); continue; }
      n += 1; toSet.push({ id: o.id, num: n });
    }
    const bw = db.batch();
    toSet.forEach((w) => bw.update(db.collection("serviceOrders").doc(w.id), { orderNum: w.num }));
    await bw.commit();
    await ref.set({ n }, { merge: true });
    res.json({ ok: true, assigned: toSet.length, counter: n, total: docs.length });
  } catch (e) { res.status(500).json({ ok: false, err: String((e && e.message) || e) }); }
});

// 🔎 DIAG TEMPORAL — reproduce la llamada a Square del pago de servicio y devuelve el error COMPLETO. ?key=lmgfin2026&num=1001
exports.sqDiag = onRequest({ secrets: [SQUARE_ACCESS_TOKEN], timeoutSeconds: 30 }, async (req, res) => {
  if ((req.query.key || "") !== "lmgfin2026") { res.status(403).json({ ok: false }); return; }
  try {
    const db = admin.firestore();
    const num = Number(req.query.num || 0);
    let o = null, orderId = "";
    const s = await db.collection("serviceOrders").where("orderNum", "==", num).limit(1).get();
    s.forEach((d) => { o = d.data() || {}; orderId = d.id; });
    if (!o) { res.json({ ok: false, err: "orden no encontrada" }); return; }
    const total = Number(o.grandTotalCents) || 0;
    let amountCents = Math.max(0, total - (Number(o.paidCents) || 0)) || total;
    if (amountCents < 100) amountCents = 100;
    const carLabel = o.vehicleLabel || "Servicio";
    const payload = {
      idempotency_key: (Date.now().toString(36) + Math.random().toString(36).slice(2, 12)),
      order: {
        location_id: SQUARE_LOCATION_ID, reference_id: o.clientId || orderId,
        line_items: [{ name: "Orden de servicio #" + (o.orderNum || "") + " — " + carLabel, quantity: "1", base_price_money: { amount: amountCents, currency: "USD" } }],
        service_charges: [{ name: "Cargo por servicio / Service fee (2.9%)", percentage: "2.9", calculation_phase: "SUBTOTAL_PHASE" }],
        metadata: { kind: "service", serviceOrderId: orderId, baseCents: String(amountCents) },
      },
      checkout_options: { redirect_url: "https://legacymotorsgarage.com/portal.html?sqdone=1", ask_for_shipping_address: false, accepted_payment_methods: { apple_pay: true, google_pay: true, cash_app_pay: true, afterpay_clearpay: false } },
    };
    const r = await fetch(SQUARE_API + "/v2/online-checkout/payment-links", { method: "POST", headers: _sqHeaders(), body: JSON.stringify(payload) });
    const j = await r.json().catch(() => ({}));
    res.json({ ok: r.ok, httpStatus: r.status, squareErrors: j.errors || null, url: (j.payment_link && j.payment_link.url) || null, sentAmountCents: amountCents });
  } catch (e) { res.status(500).json({ ok: false, err: String((e && e.message) || e) }); }
});

// 📋 F3 — HOJA DE RECEPCIÓN del carro de servicio (checklist corto al recibir). Guarda el estado AL RECIBIRLO (protege de daños pre-existentes) y avanza a 'recibido'.
exports.svcIntake = onCall({ timeoutSeconds: 20 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id) throw new HttpsError("unauthenticated", "Sin identidad.");
  const d = request.data || {};
  const orderId = String(d.orderId || "");
  if (!orderId) throw new HttpsError("invalid-argument", "Falta la orden.");
  const db = admin.firestore();
  const ref = db.collection("serviceOrders").doc(orderId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "La orden no existe.");
  const o = snap.data() || {};
  const mine = (o.assignEmpId && o.assignEmpId === id.empId) || (!o.assignEmpId && o.assignRole && Array.isArray(id.roles) && id.roles.includes(o.assignRole));
  if (!(id.isOwner || id.email || mine)) throw new HttpsError("permission-denied", "No es tu orden.");
  const inRaw = d.intake || {};
  const items = Array.isArray(inRaw.items) ? inRaw.items.slice(0, 24).map((it) => ({
    key: String(it.key || "").slice(0, 24),
    label: String(it.label || "").slice(0, 60),
    ok: !!it.ok,
    note: String(it.note || "").slice(0, 300),
  })) : [];
  const intake = {
    fuel: String(inRaw.fuel || "").slice(0, 8),
    miles: String(inRaw.miles || "").slice(0, 12),
    items,
    notes: String(inRaw.notes || "").slice(0, 1000),
    photos: Array.isArray(inRaw.photos) ? inRaw.photos.slice(0, 12).map((u) => String(u || "").slice(0, 600)) : [],
    at: new Date().toISOString(),
    by: id.email || id.name || id.empId || "",
  };
  const patch = { intake, updatedAt: new Date().toISOString(), updatedBy: id.email || id.name || id.empId || "" };
  if (SVC_ORDER_STATUSES.indexOf(o.status || "agendado") < SVC_ORDER_STATUSES.indexOf("recibido")) patch.status = "recibido";
  await ref.set(patch, { merge: true });
  return { ok: true };
});

// 🔧 SERVICE Fase 6 — identidad del CLIENTE del portal (entra por TELÉFONO, NO es staff). Lo buscamos por phoneE164.
async function _portalClient(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const db = admin.firestore();
  // 👁️ VISTA PREVIA DE DUEÑO: staff (por correo) puede ver el portal de un cliente por id (solo lectura).
  const _email = String((request.auth.token || {}).email || "").toLowerCase();
  const _prev = String(((request.data || {}).previewClientId) || "");
  if (_prev && OWNER_EMAILS.indexOf(_email) >= 0) {
    const cs = await db.collection("clients").doc(_prev).get();
    if (!cs.exists) throw new HttpsError("not-found", "Cliente no encontrado.");
    const cd = cs.data() || {};
    return { id: cs.id, phone: cd.phoneE164 || cd.phone || "", data: cd, preview: true };
  }
  const phone = String((request.auth.token || {}).phone_number || "");
  if (!phone) throw new HttpsError("permission-denied", "Sin teléfono verificado.");
  let snap;
  try { snap = await db.collection("clients").where("phoneE164", "==", phone).limit(1).get(); }
  catch (e) { snap = { empty: true }; }
  if (!snap || snap.empty) throw new HttpsError("not-found", "No encontramos tu expediente.");
  const d = snap.docs[0];
  return { id: d.id, phone, data: d.data() || {} };
}
// Convierte una orden de servicio a un estimado limpio para el portal del cliente (montos en dólares, idioma del cliente).
function _estPayload(o, en) {
  const c = (x) => Math.round(Number(x) || 0) / 100;
  const services = (Array.isArray(o.services) ? o.services : []).map((s) => ({
    desc: (en && s.descEn) ? s.descEn : (s.desc || ""),
    price: c(s.priceCents != null ? s.priceCents : Math.round((Number(s.price) || 0) * 100)),
    parts: (Array.isArray(s.parts) ? s.parts : []).map((p) => ({ desc: p.desc || "", price: c(p.priceCents != null ? p.priceCents : Math.round((Number(p.price) || 0) * 100)) })),
  }));
  return {
    id: o.id, orderNum: o.orderNum || null, vehicleLabel: o.vehicleLabel || "", vin: o.vin || "", plate: o.plate || "",
    status: o.status || "", estimateStatus: o.estimateStatus || "",
    services,
    laborTotal: c(o.laborTotalCents), partsTotal: c(o.partsTotalCents), total: c(o.grandTotalCents),
    deposit: c(o.depositCents), balance: c(o.balanceCents),
    paid: !!o.paid, paidCents: Number(o.paidCents) || 0, paidAt: o.paidAt || "", payMethod: o.payMethod || "",
    sentAt: o.estimateSentAt || "", acceptedAt: o.estimateAcceptedAt || "", createdAt: o.createdAt || "", partsReadyAt: o.partsReadyAt || "", partsPaidAt: o.partsPaidAt || "",
    scheduledAt: o.scheduledAt || "", receivedAt: o.receivedAt || "", startedAt: o.startedAt || "", promisedAt: o.promisedAt || "", deliveredAt: o.deliveredAt || "",
  };
}
// El PORTAL del cliente lee sus estimados por aquí (no puede leer serviceOrders directo: no es staff).
exports.svcPortalEstimates = onCall({ timeoutSeconds: 20 }, async (request) => {
  const cli = await _portalClient(request);
  const en = ((cli.data.lang || "") === "en");
  const db = admin.firestore();
  let docs = [];
  try { const snap = await db.collection("serviceOrders").where("clientId", "==", cli.id).get(); docs = snap.docs.map((d) => ({ id: d.id, ...d.data() })); } catch (e) {}
  if (!docs.length) { try { const s2 = await db.collection("serviceOrders").where("clientPhone", "==", cli.data.phone || "").get(); docs = s2.docs.map((d) => ({ id: d.id, ...d.data() })); } catch (e) {} }
  const withEst = docs.filter((o) => (o.estimateStatus === "sent" || o.estimateStatus === "accepted") || (Array.isArray(o.services) && o.services.length));
  withEst.sort((a, b) => ((b.createdAt || "") < (a.createdAt || "") ? -1 : 1));
  return { ok: true, lang: en ? "en" : "es", clientName: cli.data.name || "", orders: withEst.map((o) => _estPayload(o, en)) };
});
// El cliente ACEPTA el estimado desde su teléfono (+ consentimiento SMS opcional). Solo su propia orden.
exports.svcClientAccept = onCall({ timeoutSeconds: 20 }, async (request) => {
  const cli = await _portalClient(request);
  const d = request.data || {};
  const orderId = String(d.orderId || "");
  if (!orderId) throw new HttpsError("invalid-argument", "Falta la orden.");
  const db = admin.firestore();
  const ref = db.collection("serviceOrders").doc(orderId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "La orden no existe.");
  const o = snap.data() || {};
  const mine = (o.clientId && o.clientId === cli.id) || (o.clientPhone && o.clientPhone === (cli.data.phone || ""));
  if (!mine) throw new HttpsError("permission-denied", "No es tu orden.");
  const now = new Date().toISOString();
  await ref.set({ estimateStatus: "accepted", estimateAcceptedAt: now, estimateAcceptedBy: cli.phone, updatedAt: now }, { merge: true });
  // NOTA: el consentimiento SMS lo maneja el sistema que YA existe en el portal (writeConsent → objeto smsConsent + bitácora inmutable clients/{id}/consents). Aquí NO lo tocamos.
  // 🔔 cha-ching a los dueños: el cliente aceptó el estimado.
  const _nm = o.clientName || "Cliente"; const _fol = o.orderNum ? (" #" + o.orderNum) : "";
  await _pushToOwners({ title: "✅ Estimado aceptado", body: _nm + " aceptó el estimado" + _fol + (o.vehicleLabel ? (" · " + o.vehicleLabel) : ""), titleEn: "✅ Estimate approved", bodyEn: _nm + " approved the estimate" + _fol, url: "/admin.html" });
  return { ok: true };
});

// ✨ CORRECTOR + BILINGÜE de los trabajos de una orden de servicio. Entra una lista (ES/EN/mixto, con typos) → sale corregida en ES y EN (misma longitud/orden).
exports.svcFixText = onCall({ secrets: [ANTHROPIC_KEY], timeoutSeconds: 30 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const items = Array.isArray((request.data || {}).items)
    ? request.data.items.map((x) => String(x || "").slice(0, 300)).filter(Boolean).slice(0, 20) : [];
  if (!items.length) return { es: [], en: [] };
  const sys = "You clean up short auto-shop service line items written by shop staff. The input is a JSON array of strings; each is a service/job note that may be in Spanish, English, or mixed, with typos or abbreviations. " +
    "For EACH item: fix spelling and obvious grammar and keep it concise and faithful to the meaning. Do NOT add, merge, split, remove, reorder or invent items. Keep standard automotive part/term names. " +
    "Return ONLY strict JSON {\"es\":[...],\"en\":[...],\"fixed\":[...]} where \"es\" is each item corrected in natural Spanish, \"en\" each item corrected in natural English, and \"fixed\" each item corrected IN ITS OWN original language (Spanish stays Spanish, English stays English, mixed is cleaned up but not forced to one language — only fix spelling/grammar, do NOT translate). All three arrays have the SAME length and SAME order as the input. No prose, no code fences.";
  try {
    const AnthropicMod = require("@anthropic-ai/sdk");
    const Anthropic = AnthropicMod.Anthropic || AnthropicMod.default || AnthropicMod;
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY.value() });
    const msg = await client.messages.create({
      model: "claude-sonnet-5", max_tokens: 900, system: sys,
      messages: [{ role: "user", content: JSON.stringify(items) }],
    });
    let txt = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    txt = txt.replace(/^```[a-z]*\n?/i, "").replace(/```$/, "").trim();
    let out = {};
    try { out = JSON.parse(txt); } catch (e) { const m = txt.match(/\{[\s\S]*\}/); if (m) { try { out = JSON.parse(m[0]); } catch (_) {} } }
    let es = Array.isArray(out.es) ? out.es.map((x) => String(x || "").slice(0, 300)) : [];
    let en = Array.isArray(out.en) ? out.en.map((x) => String(x || "").slice(0, 300)) : [];
    let fixed = Array.isArray(out.fixed) ? out.fixed.map((x) => String(x || "").slice(0, 300)) : [];
    es = items.map((it, i) => es[i] || it);   // si la IA se desalinea o falta, cae al original
    en = items.map((it, i) => en[i] || it);
    fixed = items.map((it, i) => fixed[i] || es[i] || it);
    return { es, en, fixed };
  } catch (e) {
    console.error("svcFixText", e);
    return { es: items, en: items, fixed: items };   // si falla, no bloquea: regresa el original
  }
});

// ⏱️💵 ESTIMADOR DE LABOR — dado el carro + los trabajos, la IA sugiere tiempo y cuánto cobrar de labor (estimado de referencia).
exports.svcEstimate = onCall({ secrets: [ANTHROPIC_KEY], timeoutSeconds: 30 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const d = request.data || {};
  const vehicle = String(d.vehicle || "").slice(0, 120);
  const vin = String(d.vin || "").slice(0, 20);
  const rate = Math.max(40, Math.min(250, Number(d.laborRate) || 110));
  const jobs = Array.isArray(d.jobs) ? d.jobs.map((x) => String(x || "").slice(0, 200)).filter(Boolean).slice(0, 15) : [];
  if (!jobs.length) return { jobs: [] };
  const sys = "You are an experienced independent auto-repair shop service advisor in California. Given a vehicle and a list of repair/service jobs, estimate REALISTIC LABOR for EACH job (shop labor only — NOT the price of parts). " +
    "Assume a shop labor rate of about $" + rate + " per hour. For each job return: minutes (realistic labor time in minutes, rounded to a multiple of 15), laborUsd (a fair labor CHARGE in whole US dollars, roughly hours×rate, rounded to a sensible shop price), note (a VERY short caveat in Spanish, e.g. 'puede variar por condición', 'diagnóstico aparte', '+ partes'). " +
    "Be realistic and slightly conservative. For detailing/cleaning jobs, price by typical detail packages rather than strictly hourly. If a job is vague, give a typical ballpark and say so briefly in the note. " +
    "Return ONLY strict JSON {\"jobs\":[{\"minutes\":N,\"laborUsd\":N,\"note\":\"...\"}]} with the SAME length and SAME order as the input jobs. No prose, no code fences.";
  const userMsg = "Vehicle: " + (vehicle || "(unknown)") + (vin ? (" · VIN " + vin) : "") + "\nJobs (JSON): " + JSON.stringify(jobs);
  try {
    const AnthropicMod = require("@anthropic-ai/sdk");
    const Anthropic = AnthropicMod.Anthropic || AnthropicMod.default || AnthropicMod;
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY.value() });
    const msg = await client.messages.create({
      model: "claude-sonnet-5", max_tokens: 900, system: sys,
      messages: [{ role: "user", content: userMsg }],
    });
    let txt = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    txt = txt.replace(/^```[a-z]*\n?/i, "").replace(/```$/, "").trim();
    let out = {};
    try { out = JSON.parse(txt); } catch (e) { const m = txt.match(/\{[\s\S]*\}/); if (m) { try { out = JSON.parse(m[0]); } catch (_) {} } }
    const arr = Array.isArray(out.jobs) ? out.jobs : [];
    const res = jobs.map((_, i) => {
      const j = arr[i] || {};
      let mins = parseInt(j.minutes, 10); if (isNaN(mins) || mins <= 0) mins = 60;
      mins = Math.max(15, Math.min(1440, Math.round(mins / 15) * 15));
      let usd = Math.round(Number(j.laborUsd)); if (isNaN(usd) || usd < 0) usd = Math.round((mins / 60) * rate);
      return { minutes: mins, laborUsd: usd, note: String(j.note || "").slice(0, 120) };
    });
    return { jobs: res };
  } catch (e) {
    console.error("svcEstimate", e);
    throw new HttpsError("internal", String((e && e.message) || e));
  }
});

// 🏁 CICLO DEL CARRO (dealer) — carros esperando INSPECCIÓN INICIAL del mecánico (status 'prep' + reconStage 'mecanico').
// Auto-encolado: un carro nuevo se guarda con status:'prep' y reconStage:'mecanico' → aparece aquí solo.
exports.mechCars = onCall({ timeoutSeconds: 30 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id) throw new HttpsError("unauthenticated", "Sin identidad.");
  if (id.notRegistered || !id.active) throw new HttpsError("permission-denied", "No autorizado.");
  const isMech = id.isOwner || id.email || (Array.isArray(id.roles) && id.roles.indexOf("Mecánico") >= 0);
  if (!isMech) return { ok: true, cars: [] };
  const db = admin.firestore();
  let snap;
  try { snap = await db.collection("inventory").where("status", "==", "prep").get(); }
  catch (e) { throw new HttpsError("internal", "No se pudo leer el inventario."); }
  const cars = [];
  snap.forEach((d) => {
    const c = d.data() || {};
    if ((c.reconStage || "mecanico") !== "mecanico") return;   // solo los que esperan inspección inicial
    const label = [c.year, c.make, c.model].filter(Boolean).join(" ") || c.title || ("#" + (c.inventoryNum || ""));
    const photo = (Array.isArray(c.photos) && c.photos[0]) || c.img || "";
    const insp = c.inspection || {};
    cars.push({
      id: d.id, label, inventoryNum: String(c.inventoryNum || ""), vin: String(c.vin || ""),
      photo: String(photo || ""), createdAt: c.createdAt || null, miles: String(c.miles || ""),
      receivedMiles: String(c.receivedMiles || ""), inspStarted: !!insp.startedAt, inspDone: !!insp.reportAt,
    });
  });
  cars.sort((a, b) => String(a.inventoryNum).localeCompare(String(b.inventoryNum), undefined, { numeric: true }));
  return { ok: true, cars };
});

// 🔧 El mecánico registra las MILLAS con las que recibe el carro y ARRANCA la inspección.
exports.mechCarIntake = onCall({ timeoutSeconds: 20 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id) throw new HttpsError("unauthenticated", "Sin identidad.");
  const isMech = id.isOwner || id.email || (Array.isArray(id.roles) && id.roles.indexOf("Mecánico") >= 0);
  if (!isMech) throw new HttpsError("permission-denied", "No autorizado.");
  const d = request.data || {};
  const carId = String(d.carId || ""); if (!carId) throw new HttpsError("invalid-argument", "Falta el carro.");
  const miles = String(d.receivedMiles || "").replace(/[^\d]/g, "");
  const db = admin.firestore();
  const ref = db.collection("inventory").doc(carId);
  const snap = await ref.get(); if (!snap.exists) throw new HttpsError("not-found", "El carro no existe.");
  const existing = (snap.data() || {}).inspection || {};
  const insp = {
    startedAt: existing.startedAt || new Date().toISOString(),
    by: existing.by || (id.name || id.empId || ""),
    byMiles: miles, updatedAt: new Date().toISOString(),
  };
  await ref.set({ receivedMiles: miles, inspection: insp }, { merge: true });
  return { ok: true };
});

// 🔧 DVI — Inspección paso a paso del mecánico. Guarda borrador por área y, al terminar,
// escribe el REPORTE + LISTA DE PARTES en el carro y lo AVANZA en la línea Dealer
// (mecanico → pintura/detalle) o lo deja en espera de partes. Solo callables (sin regla Firestore).
exports.mechDvi = onCall({ timeoutSeconds: 30 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id) throw new HttpsError("unauthenticated", "Sin identidad.");
  const isMech = id.isOwner || id.email || (Array.isArray(id.roles) && id.roles.indexOf("Mecánico") >= 0);
  if (!isMech) throw new HttpsError("permission-denied", "No autorizado.");
  const d = request.data || {};
  const op = String(d.op || "");
  const carId = String(d.carId || ""); if (!carId) throw new HttpsError("invalid-argument", "Falta el carro.");
  const db = admin.firestore();
  const ref = db.collection("inventory").doc(carId);
  const snap = await ref.get(); if (!snap.exists) throw new HttpsError("not-found", "El carro no existe.");
  const car = snap.data() || {};
  const existing = car.inspection || {};
  const now = new Date().toISOString();
  const S = (v, n) => String(v == null ? "" : v).slice(0, n || 200);

  if (op === "get") {
    return { ok: true, inspection: existing, reconStage: car.reconStage || "mecanico" };
  }

  if (op === "save") {   // guarda el borrador (no termina)
    const draft = d.draft && typeof d.draft === "object" ? d.draft : {};
    await ref.set({ inspection: { startedAt: existing.startedAt || now, by: existing.by || (id.name || id.empId || ""), draft, updatedAt: now } }, { merge: true });
    return { ok: true };
  }

  if (op === "finish") {   // escribe el reporte final + avanza el carro
    // report = [{key,title,items:[{label,state,measure,note,part,photo}]}]
    const reportIn = Array.isArray(d.report) ? d.report : [];
    const report = reportIn.slice(0, 40).map((a) => ({
      key: S(a.key, 40), title: S(a.title, 80),
      items: (Array.isArray(a.items) ? a.items : []).slice(0, 40).map((it) => ({
        label: S(it.label, 120), state: S(it.state, 20), measure: S(it.measure, 40),
        note: S(it.note, 400), part: S(it.part, 160), photo: S(it.photo, 600),
      })),
    }));
    const partsIn = Array.isArray(d.parts) ? d.parts : [];
    const parts = partsIn.slice(0, 60).map((p) => ({ label: S(p.label, 160), note: S(p.note, 300), photo: S(p.photo, 600), area: S(p.area, 80) }))
      .filter((p) => p.label);
    const nextStage = ["detalle", "pintura"].indexOf(String(d.nextStage || "")) >= 0 ? String(d.nextStage) : "";
    const miles = String(d.miles || existing.byMiles || "").replace(/[^\d]/g, "");
    const needsParts = parts.length > 0 && !nextStage;
    const insp = {
      startedAt: existing.startedAt || now,
      by: existing.by || (id.name || id.empId || ""),
      byMiles: miles, updatedAt: now,
      reportAt: now, reportBy: (id.name || id.empId || id.email || ""),
      report, parts,
      outcome: needsParts ? "needs_parts" : "passed",
      waitingParts: needsParts,
      draft: null,
    };
    const patch = { inspection: insp };
    if (nextStage) patch.reconStage = nextStage;   // avanza la línea Dealer
    if (miles) patch.receivedMiles = miles;
    await ref.set(patch, { merge: true });
    return { ok: true, outcome: insp.outcome, nextStage, parts: parts.length };
  }

  throw new HttpsError("invalid-argument", "Operación inválida.");
});

// 🔧 TAREAS DE TRABAJO POR CARRO (car_tasks) — el admin pone el siguiente paso (ej. "reemplazar motor"),
// se acumulan, y van a la cola del mecánico. Solo por callables (admin SDK) → sin regla Firestore.
exports.invPrepList = onCall({ timeoutSeconds: 30 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id || !id.isOwner) throw new HttpsError("permission-denied", "Solo dueños.");
  const db = admin.firestore();
  let snap;
  try { snap = await db.collection("inventory").where("status", "==", "prep").get(); }
  catch (e) { throw new HttpsError("internal", "No se pudo leer el inventario."); }
  const cars = [];
  snap.forEach((d) => {
    const c = d.data() || {};
    const label = [c.year, c.make, c.model].filter(Boolean).join(" ") || c.title || ("#" + (c.inventoryNum || ""));
    cars.push({ id: d.id, label, inventoryNum: String(c.inventoryNum || ""), vin: String(c.vin || "") });
  });
  cars.sort((a, b) => String(a.inventoryNum).localeCompare(String(b.inventoryNum), undefined, { numeric: true }));
  return { ok: true, cars };
});

exports.carTaskAdd = onCall({ timeoutSeconds: 20 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id || !id.isOwner) throw new HttpsError("permission-denied", "Solo dueños.");
  const d = request.data || {};
  const carId = String(d.carId || ""); const title = String(d.title || "").trim().slice(0, 140);
  if (!carId || !title) throw new HttpsError("invalid-argument", "Falta el carro o la tarea.");
  const db = admin.firestore();
  const carSnap = await db.collection("inventory").doc(carId).get();
  if (!carSnap.exists) throw new HttpsError("not-found", "El carro no existe.");
  const c = carSnap.data() || {};
  const carLabel = [c.year, c.make, c.model].filter(Boolean).join(" ") || c.title || ("#" + (c.inventoryNum || ""));
  const ref = db.collection("car_tasks").doc();
  await ref.set({
    carId, carLabel, inventoryNum: String(c.inventoryNum || ""), vin: String(c.vin || ""),
    title, status: "cola", role: "Mecánico", createdBy: id.name || id.email || id.empId || "",
    createdAt: new Date().toISOString(), order: Date.now(),
  });
  return { ok: true, id: ref.id };
});

exports.mechTasks = onCall({ timeoutSeconds: 30 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id) throw new HttpsError("unauthenticated", "Sin identidad.");
  const isMech = id.isOwner || id.email || (Array.isArray(id.roles) && id.roles.indexOf("Mecánico") >= 0);
  if (!isMech) return { ok: true, tasks: [] };
  const db = admin.firestore();
  let snap;
  try { snap = await db.collection("car_tasks").get(); } catch (e) { return { ok: true, tasks: [] }; }
  const tasks = [];
  snap.forEach((d) => { const t = d.data() || {}; if (t.status === "hecho") return; tasks.push({ id: d.id, ...t }); });
  tasks.sort((a, b) => (a.order || 0) - (b.order || 0));
  return { ok: true, tasks };
});

exports.carTaskStatus = onCall({ timeoutSeconds: 20 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id) throw new HttpsError("unauthenticated", "Sin identidad.");
  const isMech = id.isOwner || id.email || (Array.isArray(id.roles) && id.roles.indexOf("Mecánico") >= 0);
  if (!isMech) throw new HttpsError("permission-denied", "No autorizado.");
  const d = request.data || {};
  const taskId = String(d.taskId || ""); const status = String(d.status || "");
  if (!taskId || ["cola", "en_proceso", "hecho"].indexOf(status) < 0) throw new HttpsError("invalid-argument", "Datos inválidos.");
  const db = admin.firestore();
  const patch = { status, updatedAt: new Date().toISOString(), updatedBy: id.name || id.email || id.empId || "" };
  if (status === "en_proceso") patch.startedAt = new Date().toISOString();
  if (status === "hecho") patch.finishedAt = new Date().toISOString();
  await db.collection("car_tasks").doc(taskId).set(patch, { merge: true });
  return { ok: true };
});

// 📋 TAREAS GUIADAS (jornada del empleado) — colección `tasks` con checklist, LÍNEA (dealer/service/desmantle/general)
// y plantilla diaria. Solo por callables (admin SDK). NO toca Warehouse.
const TASK_LINES = ["dealer", "service", "desmantle", "general"];
function _laDateKey() { return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }); }
function _taskMine(t, id) {
  const roles = Array.isArray(id.roles) ? id.roles : [];
  return (t.assignEmpId && t.assignEmpId === id.empId) || (!t.assignEmpId && t.assignRole && roles.indexOf(t.assignRole) >= 0) || id.isOwner || !!id.email;
}
exports.taskAdd = onCall({ timeoutSeconds: 20 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id || !id.isOwner) throw new HttpsError("permission-denied", "Solo dueños.");
  const d = request.data || {};
  const title = String(d.title || "").trim().slice(0, 140); if (!title) throw new HttpsError("invalid-argument", "Falta el título.");
  const line = TASK_LINES.indexOf(String(d.line || "general")) >= 0 ? String(d.line) : "general";
  const checklist = (Array.isArray(d.checklist) ? d.checklist : []).map((s) => String(s || "").trim()).filter(Boolean).slice(0, 40).map((text) => ({ text, done: false }));
  const assignEmpId = String(d.assignEmpId || "");
  const assignRole = String(d.assignRole || "");
  const recurring = (d.recurring === "daily") ? "daily" : "none";
  if (recurring === "daily" && !assignEmpId) throw new HttpsError("invalid-argument", "Una tarea diaria debe asignarse a un empleado.");
  const carId = String(d.carId || "");
  const carLabel = String(d.carLabel || "").slice(0, 80);
  const priority = ["cola", "next", "now"].indexOf(String(d.priority || "cola")) >= 0 ? String(d.priority) : "cola";
  const db = admin.firestore();
  let assignName = "";
  if (assignEmpId) { try { const es = await db.collection("employees").doc(assignEmpId).get(); if (es.exists) assignName = (es.data() || {}).name || ""; } catch (e) {} }
  const ref = db.collection("tasks").doc();
  const base = { title, line, checklist, assignEmpId, assignRole, assignName, carId, carLabel, priority, createdBy: id.name || id.email || "", createdAt: new Date().toISOString(), order: Date.now() };
  if (recurring === "daily") await ref.set(Object.assign(base, { isTemplate: true, recurring: "daily", status: "template" }));
  else await ref.set(Object.assign(base, { isTemplate: false, recurring: "none", status: "cola" }));
  return { ok: true, id: ref.id };
});
// ✏️ Editar una tarea (solo dueño). Preserva el progreso de los pasos cuyo texto no cambió.
exports.taskEdit = onCall({ timeoutSeconds: 20 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id || !id.isOwner) throw new HttpsError("permission-denied", "Solo dueños.");
  const d = request.data || {};
  const taskId = String(d.taskId || ""); if (!taskId) throw new HttpsError("invalid-argument", "Falta la tarea.");
  const db = admin.firestore();
  const ref = db.collection("tasks").doc(taskId);
  const snap = await ref.get(); if (!snap.exists) throw new HttpsError("not-found", "No existe.");
  const cur = snap.data() || {};
  const upd = {};
  if (d.title != null) { const title = String(d.title).trim().slice(0, 140); if (!title) throw new HttpsError("invalid-argument", "Falta el título."); upd.title = title; }
  if (d.assignEmpId != null || d.assignRole != null) {
    const assignEmpId = String(d.assignEmpId || "");
    upd.assignEmpId = assignEmpId;
    upd.assignRole = String(d.assignRole || "");   // la FUNCIÓN se conserva aunque haya ejecutor
    upd.assignName = "";
    if (assignEmpId) { try { const es = await db.collection("employees").doc(assignEmpId).get(); if (es.exists) upd.assignName = (es.data() || {}).name || ""; } catch (e) {} }
  }
  if (d.carId != null) upd.carId = String(d.carId || "");
  if (d.carLabel != null) upd.carLabel = String(d.carLabel || "").slice(0, 80);
  if (d.priority != null) upd.priority = ["cola", "next", "now"].indexOf(String(d.priority)) >= 0 ? String(d.priority) : "cola";
  if (Array.isArray(d.checklist)) {
    const oldDone = {}; (Array.isArray(cur.checklist) ? cur.checklist : []).forEach((c) => { if (c && c.text) oldDone[c.text] = !!c.done; });
    upd.checklist = d.checklist.map((s) => String(s || "").trim()).filter(Boolean).slice(0, 40).map((text) => ({ text, done: !!oldDone[text] }));
  }
  await ref.set(upd, { merge: true });
  return { ok: true };
});
// 🗑️ Eliminar una tarea (solo dueño).
exports.taskDelete = onCall({ timeoutSeconds: 20 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id || !id.isOwner) throw new HttpsError("permission-denied", "Solo dueños.");
  const taskId = String((request.data && request.data.taskId) || ""); if (!taskId) throw new HttpsError("invalid-argument", "Falta la tarea.");
  await admin.firestore().collection("tasks").doc(taskId).delete();
  return { ok: true };
});
exports.myTasks = onCall({ timeoutSeconds: 30 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id) throw new HttpsError("unauthenticated", "Sin identidad.");
  const db = admin.firestore();
  const today = _laDateKey();
  let snap; try { snap = await db.collection("tasks").get(); } catch (e) { return { ok: true, tasks: [] }; }
  const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const execs = all.filter((t) => !t.isTemplate && t.templateId);
  const templates = all.filter((t) => t.isTemplate && t.recurring === "daily" && _taskMine(t, id) && t.assignEmpId);
  for (const tpl of templates) {
    const has = execs.find((e) => e.templateId === tpl.id && e.dateKey === today && e.assignEmpId === tpl.assignEmpId);
    if (!has) {
      const ref = db.collection("tasks").doc();
      const exec = { title: tpl.title, line: tpl.line, checklist: (tpl.checklist || []).map((c) => ({ text: c.text, done: false })), assignEmpId: tpl.assignEmpId, assignRole: tpl.assignRole || "", assignName: tpl.assignName || "", carId: tpl.carId || "", carLabel: tpl.carLabel || "", isTemplate: false, recurring: "none", templateId: tpl.id, dateKey: today, status: "cola", createdBy: "auto", createdAt: new Date().toISOString(), order: tpl.order || Date.now() };
      try { await ref.set(exec); all.push(Object.assign({ id: ref.id }, exec)); } catch (e) {}
    }
  }
  const list = all.filter((t) => !t.isTemplate && t.status !== "hecho" && _taskMine(t, id));
  list.sort((a, b) => (a.order || 0) - (b.order || 0));
  const out = list.map((t) => ({ id: t.id, title: t.title, line: t.line || "general", checklist: t.checklist || [], materials: Array.isArray(t.materials) ? t.materials : [], status: t.status || "cola", priority: t.priority || "cola", order: t.order || 0, assignName: t.assignName || "", assignRole: t.assignRole || "", carId: t.carId || "", carLabel: t.carLabel || "", pausedReason: t.pausedReason || "", needsHelp: !!t.needsHelp }));
  return { ok: true, tasks: out, today };
});
exports.taskStep = onCall({ timeoutSeconds: 20 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id) throw new HttpsError("unauthenticated", "Sin identidad.");
  const d = request.data || {};
  const taskId = String(d.taskId || ""); const idx = parseInt(d.idx, 10); const done = !!d.done;
  if (!taskId || isNaN(idx)) throw new HttpsError("invalid-argument", "Datos inválidos.");
  const db = admin.firestore(); const ref = db.collection("tasks").doc(taskId);
  const snap = await ref.get(); if (!snap.exists) throw new HttpsError("not-found", "No existe.");
  const t = snap.data() || {};
  if (!_taskMine(t, id)) throw new HttpsError("permission-denied", "No es tu tarea.");
  const cl = Array.isArray(t.checklist) ? t.checklist.slice() : [];
  if (idx < 0 || idx >= cl.length) throw new HttpsError("invalid-argument", "Paso inválido.");
  cl[idx] = { text: cl[idx].text, done: done };
  const patch = { checklist: cl, updatedAt: new Date().toISOString() };
  if (t.status === "cola") { patch.status = "en_proceso"; patch.startedAt = new Date().toISOString(); }
  await ref.set(patch, { merge: true });
  return { ok: true };
});
exports.taskComplete = onCall({ timeoutSeconds: 20 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id) throw new HttpsError("unauthenticated", "Sin identidad.");
  const d = request.data || {};
  const taskId = String(d.taskId || ""); if (!taskId) throw new HttpsError("invalid-argument", "Falta la tarea.");
  const db = admin.firestore(); const ref = db.collection("tasks").doc(taskId);
  const snap = await ref.get(); if (!snap.exists) throw new HttpsError("not-found", "No existe.");
  const t = snap.data() || {};
  if (!_taskMine(t, id)) throw new HttpsError("permission-denied", "No es tu tarea.");
  const cl = Array.isArray(t.checklist) ? t.checklist : [];
  if (cl.length && cl.some((c) => !c.done) && d.force !== true) throw new HttpsError("failed-precondition", "Faltan pasos por marcar.");
  // ⏱️ cierra el cronómetro: suma el tramo abierto si venía en proceso
  const add = t.lastResumeAt ? Math.max(0, Date.now() - new Date(t.lastResumeAt).getTime()) : 0;
  const workedMs = (Number(t.workedMs) || 0) + add;
  await ref.set({ status: "hecho", finishedAt: new Date().toISOString(), finishedBy: id.name || id.email || id.empId || "", workedMs: workedMs, lastResumeAt: null }, { merge: true });
  // 💪 Costo de labor al CARRO (Dealer o Dismantling, según el prefijo del carId) — informativo, NO Finanzas.
  let laborCents = 0;
  if (t.carId && workedMs > 0) {
    laborCents = await _addCarLabor(db, t.carId, { minutes: workedMs / 60000, rate: Number(id.rate) || 0, workerKey: id.key, workerName: id.name || id.email || id.empId || "", empId: id.empId || "", role: t.assignRole || "", line: t.line || "", carLabel: t.carLabel || "", source: "task", refId: taskId, title: t.title || "" });
  }
  return { ok: true, workedMs: workedMs, laborCents: laborCents };
});

// 🔧 F4 — Ejecución de tareas: pausar (con motivo) / reanudar / reportar problema.
exports.taskAction = onCall({ timeoutSeconds: 20 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id) throw new HttpsError("unauthenticated", "Sin identidad.");
  const d = request.data || {};
  const taskId = String(d.taskId || ""); const op = String(d.op || "");
  if (!taskId) throw new HttpsError("invalid-argument", "Falta la tarea.");
  const db = admin.firestore(); const ref = db.collection("tasks").doc(taskId);
  const snap = await ref.get(); if (!snap.exists) throw new HttpsError("not-found", "No existe.");
  const tsk = snap.data() || {};
  if (!_taskMine(tsk, id)) throw new HttpsError("permission-denied", "No es tu tarea.");
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  // ⏱️ Cronómetro de TRABAJO (≠ asistencia): acumula workedMs mientras está en proceso. Base del costo de labor.
  if (op === "start") {   // arranca la tarea (primera vez)
    await ref.set({ status: "en_proceso", startedAt: tsk.startedAt || nowIso, lastResumeAt: nowIso, pausedReason: "", updatedAt: nowIso }, { merge: true });
    return { ok: true };
  }
  if (op === "pause") {
    const reason = String(d.reason || "").trim().slice(0, 200);
    const add = tsk.lastResumeAt ? Math.max(0, nowMs - new Date(tsk.lastResumeAt).getTime()) : 0;
    await ref.set({ status: "pausada", pausedReason: reason, pausedAt: nowIso, workedMs: (Number(tsk.workedMs) || 0) + add, lastResumeAt: null, updatedAt: nowIso }, { merge: true });
    return { ok: true };
  }
  if (op === "resume") {
    await ref.set({ status: "en_proceso", pausedReason: "", lastResumeAt: nowIso, startedAt: tsk.startedAt || nowIso, updatedAt: nowIso }, { merge: true });
    return { ok: true };
  }
  if (op === "matAdd") {
    const text = String(d.text || "").trim().slice(0, 140); if (!text) throw new HttpsError("invalid-argument", "Falta el material.");
    const mats = (Array.isArray(tsk.materials) ? tsk.materials.slice() : []);
    if (mats.length >= 60) throw new HttpsError("failed-precondition", "Demasiados materiales.");
    mats.push({ id: "m" + nowMs + Math.random().toString(36).slice(2, 6), text: text, done: false });
    await ref.set({ materials: mats, updatedAt: nowIso }, { merge: true });
    return { ok: true, materials: mats };
  }
  if (op === "matToggle") {
    const mid = String(d.mid || "");
    const mats = (Array.isArray(tsk.materials) ? tsk.materials : []).map((m) => (m.id === mid ? Object.assign({}, m, { done: !m.done }) : m));
    await ref.set({ materials: mats, updatedAt: nowIso }, { merge: true });
    return { ok: true, materials: mats };
  }
  if (op === "matRemove") {
    const mid = String(d.mid || "");
    const mats = (Array.isArray(tsk.materials) ? tsk.materials : []).filter((m) => m.id !== mid);
    await ref.set({ materials: mats, updatedAt: nowIso }, { merge: true });
    return { ok: true, materials: mats };
  }
  if (op === "problem") {
    const text = String(d.text || "").trim().slice(0, 300); if (!text) throw new HttpsError("invalid-argument", "Falta el detalle.");
    await ref.set({ problems: admin.firestore.FieldValue.arrayUnion({ text: text, by: id.name || id.email || id.empId || "", at: nowIso }), needsHelp: true, updatedAt: nowIso }, { merge: true });
    return { ok: true };
  }
  throw new HttpsError("invalid-argument", "Operación inválida.");
});

// 👑 PANEL DEL DUEÑO — todas las tareas abiertas (Pit) para el centro de operación. Solo dueños.
exports.allTasks = onCall({ timeoutSeconds: 30 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id || !id.isOwner) throw new HttpsError("permission-denied", "Solo dueños.");
  const db = admin.firestore();
  let snap; try { snap = await db.collection("tasks").get(); } catch (e) { return { ok: true, tasks: [] }; }
  const list = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((t) => !t.isTemplate && t.status !== "hecho");
  list.sort((a, b) => (a.order || 0) - (b.order || 0));
  const out = list.map((t) => { const cl = t.checklist || []; return { id: t.id, title: t.title, line: t.line || "general", assignName: t.assignName || "", assignRole: t.assignRole || "", assignEmpId: t.assignEmpId || "", carId: t.carId || "", carLabel: t.carLabel || "", checklist: cl.map((c) => ({ text: c.text, done: !!c.done })), materials: Array.isArray(t.materials) ? t.materials : [], status: t.status || "cola", priority: t.priority || "cola", order: t.order || 0, steps: cl.length, done: cl.filter((c) => c.done).length, pausedReason: t.pausedReason || "", needsHelp: !!t.needsHelp }; });
  return { ok: true, tasks: out };
});

// 👑 HOY SE HIZO (dueño): todo lo TERMINADO HOY (zona LA) por empleado — tareas, trabajos de carro, servicios y detallado.
exports.opsDoneToday = onCall({ timeoutSeconds: 30 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id || !id.isOwner) throw new HttpsError("permission-denied", "Solo dueños.");
  const db = admin.firestore();
  const laDay = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const isToday = (iso) => { if (!iso) return false; try { return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }) === laDay; } catch (e) { return false; } };
  const byPerson = {};
  const add = (name, item) => { const k = (String(name || "").trim().toLowerCase()) || "?"; if (!byPerson[k]) byPerson[k] = { name: name || "—", items: [] }; byPerson[k].items.push(item); };
  try { const s = await db.collection("tasks").get(); s.forEach((d) => { const t = d.data() || {}; if (t.status === "hecho" && isToday(t.finishedAt)) add(t.assignName || t.finishedBy, { kind: "task", title: t.title || "", line: t.line || "general", car: t.carLabel || "" }); }); } catch (e) {}
  try { const s = await db.collection("car_tasks").get(); s.forEach((d) => { const t = d.data() || {}; if (t.status === "hecho" && isToday(t.finishedAt)) add(t.assignName || t.finishedBy, { kind: "carTask", title: t.title || "", line: "dealer", car: t.carLabel || "" }); }); } catch (e) {}
  try { const s = await db.collection("serviceOrders").get(); s.forEach((d) => { const o = d.data() || {}; (Array.isArray(o.services) ? o.services : []).forEach((sv) => { if (sv.status === "listo" && isToday(sv.finishedAt)) add(sv.assignName, { kind: "service", title: sv.desc || "", line: "service", car: o.vehicleLabel || o.plate || "" }); }); }); } catch (e) {}
  try { const s = await db.collection("detail_jobs").get(); s.forEach((d) => { const j = d.data() || {}; if (j.status === "done" && isToday(j.finishedAt)) add(j.name, { kind: "detail", title: j.car ? ("Detailing · " + j.car) : "Detailing", line: "dealer", car: j.car || "" }); }); } catch (e) {}
  const people = Object.values(byPerson).map((p) => ({ name: p.name, count: p.items.length, items: p.items.slice(0, 40) })).sort((a, b) => b.count - a.count);
  return { ok: true, day: laDay, total: people.reduce((s, p) => s + p.count, 0), people };
});

// 👑 CARROS Y PARTES EN PROCESO (dueño): inventario en prep con su etapa, inspección y # de trabajos pendientes.
exports.carsInProcess = onCall({ timeoutSeconds: 30 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id || !id.isOwner) throw new HttpsError("permission-denied", "Solo dueños.");
  const db = admin.firestore();
  let snap; try { snap = await db.collection("inventory").where("status", "==", "prep").get(); } catch (e) { return { ok: true, cars: [] }; }
  const taskCount = {};
  try { const ts = await db.collection("car_tasks").get(); ts.forEach((d) => { const x = d.data() || {}; if (x.status !== "hecho" && x.carId) taskCount[x.carId] = (taskCount[x.carId] || 0) + 1; }); } catch (e) {}
  const cars = [];
  snap.forEach((d) => {
    const c = d.data() || {};
    const label = [c.year, c.make, c.model].filter(Boolean).join(" ") || c.title || ("#" + (c.inventoryNum || ""));
    const photo = (Array.isArray(c.photos) && c.photos[0]) || c.img || "";
    const insp = c.inspection || {};
    cars.push({ id: d.id, label, inventoryNum: String(c.inventoryNum || ""), vin: String(c.vin || ""), photo: String(photo || ""), reconStage: c.reconStage || "mecanico", receivedMiles: String(c.receivedMiles || ""), inspStarted: !!insp.startedAt, inspDone: !!insp.reportAt, waitingParts: !!insp.waitingParts, partsNeeded: (Array.isArray(insp.parts) ? insp.parts.length : 0), tasks: taskCount[d.id] || 0, laborCents: Number(c.laborCents) || 0, laborMin: Number(c.laborMin) || 0 });
  });
  cars.sort((a, b) => String(a.inventoryNum).localeCompare(String(b.inventoryNum), undefined, { numeric: true }));
  return { ok: true, cars };
});

// 🧩 LÍNEA DISMANTLING para el Centro de Operaciones: carros en desmantelado + contador de partes (quedan/vendidas).
// Un carro de dismantling NO termina su línea hasta vender la ÚLTIMA parte. Solo dueños.
exports.disInProcess = onCall({ timeoutSeconds: 30 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id || !id.isOwner) throw new HttpsError("permission-denied", "Solo dueños.");
  const db = admin.firestore();
  // Partes por carro: total, vendidas, en almacén.
  const byVeh = {};
  try {
    const ps = await db.collection("parts").get();
    ps.forEach((d) => {
      const p = d.data() || {}; const v = p.vehicleId; if (!v) return;
      const b = byVeh[v] || (byVeh[v] = { total: 0, sold: 0 });
      b.total += 1; const st = p.status || ""; if (st === "vendido" || st === "empaquetando" || st === "en_transito") b.sold += 1;
    });
  } catch (e) {}
  const cars = [];
  try {
    const snap = await db.collection("dismantle_vehicles").get();
    snap.forEach((d) => {
      const c = d.data() || {};
      const label = [c.year, c.make, c.model].filter(Boolean).join(" ") || c.title || ("#" + (c.inventoryNum || ""));
      const photo = (Array.isArray(c.photos) && c.photos[0]) || c.img || "";
      const b = byVeh[d.id] || { total: 0, sold: 0 };
      const left = Math.max(0, b.total - b.sold);
      // La línea termina cuando se vendió la última parte: ocultar los que ya tienen partes y todas vendidas.
      if (b.total > 0 && left === 0) return;
      cars.push({ id: d.id, label, inventoryNum: String(c.inventoryNum || ""), vin: String(c.vin || ""), photo: String(photo || ""), status: String(c.status || "desmantelando"), partsTotal: b.total, partsSold: b.sold, partsLeft: left, laborCents: Number(c.laborCents) || 0, laborMin: Number(c.laborMin) || 0 });
    });
  } catch (e) {}
  cars.sort((a, b) => String(a.inventoryNum).localeCompare(String(b.inventoryNum), undefined, { numeric: true }));
  return { ok: true, cars };
});

// 💰 CUENTAS DE UN CARRO de Dismantling — SOLO INFORMATIVO (lee, no escribe, NO toca Finanzas).
// Costo inicial + labor (interno) + conteo de partes + sumas a precio de LISTA (referencia).
// El NETO real de eBay ("lo que nos quedó") se conecta después (API de Finanzas de eBay). Solo dueños.
exports.carAccounts = onCall({ timeoutSeconds: 30 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id || !id.isOwner) throw new HttpsError("permission-denied", "Solo dueños.");
  const db = admin.firestore();
  const vid = String((request.data || {}).vehicleId || ""); if (!vid) throw new HttpsError("invalid-argument", "Falta el carro.");
  const vs = await db.collection("dismantle_vehicles").doc(vid).get();
  if (!vs.exists) throw new HttpsError("not-found", "El carro no existe.");
  const v = vs.data() || {};
  // ⚠️ "Vendida" = empaquetando + en_transito + vendido (el estatus final "vendido" casi no se usa;
  // las ventas reales viven en "empaquetando"). `shipping` = cuántas de esas aún en empaque/envío.
  const counts = { total: 0, vendido: 0, shipping: 0, publicado: 0, disponible: 0, borrador: 0 };
  let soldListCents = 0, availListCents = 0, sinPrecio = 0;
  let soldNetCents = 0, netMissing = 0;   // 💵 neto real de eBay (si ya se sincronizó)
  try {
    const ps = await db.collection("parts").get();
    ps.forEach((d) => {
      const p = d.data() || {}; if (p.vehicleId !== vid) return;
      counts.total++;
      const pc = Number(p.priceCents) || 0; if (!pc) sinPrecio++;
      const st = p.status || "disponible";
      if (st === "vendido" || st === "empaquetando" || st === "en_transito") {
        counts.vendido++; soldListCents += pc;
        if (st !== "vendido") counts.shipping++;
        if (p.ebayNetCents != null) soldNetCents += Number(p.ebayNetCents) || 0; else netMissing++;
      }
      else if (st === "publicado" || st === "en_ebay") { counts.publicado++; availListCents += pc; }
      else if (st === "borrador") { counts.borrador++; availListCents += pc; }
      else { counts.disponible++; availListCents += pc; }
    });
  } catch (e) {}
  const pipelineListCents = 0;   // (compatibilidad: ya no se separa, va dentro de vendidas)
  // 🧾 Ventas de partes registradas en FINANZAS ligadas a este carro (dismantleCarId) — sobre todo ventas FUERA de eBay.
  let finRevCents = 0, finN = 0, finRefCents = 0;
  try {
    const ts = await db.collection("transactions").where("dismantleCarId", "==", vid).get();
    ts.forEach((d) => {
      const tt = d.data() || {};
      if (tt.type === "income") { finRevCents += Number(tt.amountCents) || 0; finN++; }
      else if (tt.type === "expense" && tt.saleRefundOf) { finRefCents += Number(tt.amountCents) || 0; }
    });
  } catch (e) {}
  const finNetCents = finRevCents - finRefCents;
  const costCents = Number(v.costCents) || 0, laborCents = Number(v.laborCents) || 0, laborMin = Number(v.laborMin) || 0;
  const ebayNetReady = (counts.vendido > 0 && netMissing < counts.vendido);   // hay neto real de eBay para al menos una vendida
  const generadoCents = soldNetCents + finNetCents;   // 💰 generado total = neto eBay + ventas en Finanzas
  const totalCostCents = costCents + laborCents;
  const netoActualCents = generadoCents - totalCostCents;
  return {
    ok: true, label: [v.year, v.make, v.model].filter(Boolean).join(" ") || v.title || ("#" + (v.inventoryNum || "")),
    inventoryNum: String(v.inventoryNum || ""), vin: String(v.vin || ""),
    costCents, laborCents, laborMin, totalCostCents,
    counts, soldListCents, pipelineListCents, availListCents, sinPrecio,
    ebayNetReady, soldNetCents, netMissing,
    finRevCents, finN, finRefCents, finNetCents,
    generadoCents, netoActualCents,
  };
});

// 🔍 DIAGNÓSTICO de partes (temporal, solo lectura, solo dueños): ¿las vendidas están ligadas a un carro?
exports.partsDiag = onCall({ timeoutSeconds: 60 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id || !id.isOwner) throw new HttpsError("permission-denied", "Solo dueños.");
  const db = admin.firestore();
  const vs = await db.collection("dismantle_vehicles").get();
  const validVeh = new Set(vs.docs.map((d) => d.id));
  const ps = await db.collection("parts").get();
  const r = { total: 0, byStatus: {}, soldTotal: 0, soldWithVehicle: 0, soldVehicleValid: 0, soldNoVehicle: 0, soldWarehouseOnly: 0, soldWithEbayOrder: 0, soldInPerson: 0, vehicles: vs.size };
  // "Vendidas reales" = TODO lo que ya se vendió sin importar la etapa de envío: empaquetando + en_transito + vendido.
  const soldish = { total: 0, withVehicle: 0, vehicleValid: 0, noVehicle: 0, warehouseOnly: 0, withEbayOrder: 0, withPrice: 0 };
  const SOLDISH = ["empaquetando", "en_transito", "vendido"];
  ps.forEach((d) => {
    const p = d.data() || {}; r.total++;
    const st = p.status || "disponible"; r.byStatus[st] = (r.byStatus[st] || 0) + 1;
    if (st === "vendido") {
      r.soldTotal++;
      if (p.vehicleId) { r.soldWithVehicle++; if (validVeh.has(p.vehicleId)) r.soldVehicleValid++; } else r.soldNoVehicle++;
      if (p.warehouseOnly) r.soldWarehouseOnly++;
      if (p.ebayOrderId) r.soldWithEbayOrder++;
      if (p.soldInPerson) r.soldInPerson++;
    }
    if (SOLDISH.indexOf(st) >= 0) {
      soldish.total++;
      if (p.vehicleId) { soldish.withVehicle++; if (validVeh.has(p.vehicleId)) soldish.vehicleValid++; } else soldish.noVehicle++;
      if (p.warehouseOnly) soldish.warehouseOnly++;
      if (p.ebayOrderId) soldish.withEbayOrder++;
      if (Number(p.priceCents) > 0) soldish.withPrice++;
    }
  });
  return { ok: true, ...r, soldish };
});

// 🚗 Lista ligera de carros para apuntar una tarea suelta del Pit: inventario del dealer + carros para desmantelar (yarda). Solo dueños.
exports.invCarsLite = onCall({ timeoutSeconds: 30 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id || !id.isOwner) throw new HttpsError("permission-denied", "Solo dueños.");
  const db = admin.firestore();
  const inv = [];
  try {
    const snap = await db.collection("inventory").get();
    snap.forEach((d) => {
      const c = d.data() || {};
      const label = [c.year, c.make, c.model].filter(Boolean).join(" ") || c.title || ("#" + (c.inventoryNum || ""));
      const photo = (Array.isArray(c.photos) && c.photos[0]) || c.img || "";
      inv.push({ id: "inv:" + d.id, kind: "inventario", label, inventoryNum: String(c.inventoryNum || ""), vin: String(c.vin || ""), photo: String(photo || ""), status: String(c.status || "") });
    });
    inv.sort((a, b) => String(a.inventoryNum).localeCompare(String(b.inventoryNum), undefined, { numeric: true }));
  } catch (e) {}
  const dis = [];
  try {
    const snap = await db.collection("dismantle_vehicles").get();
    snap.forEach((d) => {
      const c = d.data() || {};
      const label = [c.year, c.make, c.model].filter(Boolean).join(" ") || ("VIN " + (c.vin || "").slice(-6));
      const photo = (Array.isArray(c.photoURLs) && c.photoURLs[0]) || "";
      dis.push({ id: "dis:" + d.id, kind: "desmantelar", label, inventoryNum: String(c.inventoryNum || ""), vin: String(c.vin || ""), photo: String(photo || ""), status: String(c.status || "") });
    });
    dis.sort((a, b) => String(a.inventoryNum).localeCompare(String(b.inventoryNum), undefined, { numeric: true }));
  } catch (e) {}
  return { ok: true, cars: inv.concat(dis), inventory: inv, dismantle: dis };
});

// 🔢 Numera los carros del YONKE (dismantle_vehicles) con formato D-00001. Idempotente: solo asigna a los que NO tienen número.
// Numera por orden de creación (createdAt). Solo dueños.
exports.yonkeEnsureNums = onCall({ timeoutSeconds: 60 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id || !id.isOwner) throw new HttpsError("permission-denied", "Solo dueños.");
  const db = admin.firestore();
  let snap; try { snap = await db.collection("dismantle_vehicles").get(); } catch (e) { return { ok: true, assigned: 0, total: 0 }; }
  const all = snap.docs.map((d) => ({ id: d.id, data: d.data() || {} }));
  // Mayor número ya usado (de los que ya tienen D-####)
  let maxN = 0;
  all.forEach((x) => { const m = String(x.data.inventoryNum || "").match(/(\d+)/); if (m) { const n = parseInt(m[1], 10); if (n > maxN) maxN = n; } });
  // Los que faltan, en orden de creación
  const missing = all.filter((x) => !String(x.data.inventoryNum || "").trim())
    .sort((a, b) => String(a.data.createdAt || "").localeCompare(String(b.data.createdAt || "")));
  let assigned = 0;
  for (const x of missing) {
    maxN += 1;
    const num = "D-" + String(maxN).padStart(5, "0");
    try { await db.collection("dismantle_vehicles").doc(x.id).set({ inventoryNum: num }, { merge: true }); assigned += 1; } catch (e) {}
  }
  return { ok: true, assigned, total: all.length };
});

// Índice de empleados por TELÉFONO (emp_phones/{phoneE164}) → lo usan las reglas de Firestore
// para reconocer al empleado (por teléfono) en las herramientas de la yarda, sin darle acceso de dueño.
async function _syncEmpPhone(db, empId) {
  try {
    const s = await db.collection("employees").doc(empId).get();
    if (!s.exists) return;
    const x = s.data() || {};
    const ph = x.phoneE164 || _toE164(x.phone || "");
    if (!ph) return;
    await db.collection("emp_phones").doc(ph).set({
      empId: empId, roles: Array.isArray(x.roles) ? x.roles : [], active: x.active !== false,
      owner: x.owner === true, name: x.name || "", updatedAt: new Date().toISOString(),
    });
  } catch (e) {}
}

// 👑 Panel del dueño en Pit Crew: listar y gestionar el equipo desde el teléfono. Solo dueños.
// 📊 REPORTE POR EMPLEADO (solo dueños): cuánto generó / cuánto costó su labor / cuántos carros y tareas.
// Fuentes: labor_log (tiempo→costo por carro), serviceOrders (ingreso de servicios), timeclock (horas de asistencia).
exports.empReport = onCall({ timeoutSeconds: 40 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id || !id.isOwner) throw new HttpsError("permission-denied", "Solo dueños.");
  const d = request.data || {};
  const name = String(d.name || "").trim(); const nameLc = name.toLowerCase();
  const empId = String(d.empId || "");
  if (!name && !empId) throw new HttpsError("invalid-argument", "Falta el empleado.");
  const db = admin.firestore();
  const weekKey = String(d.weekKey || "") || _laMondayKey(new Date());   // lunes de la semana elegida (o esta)
  const weekStart = weekKey + "T00:00:00.000-07:00";        // aprox inicio de semana (LA)
  const weekEnd = new Date(new Date(weekStart).getTime() + 7 * 86400000).toISOString();   // fin de esa semana
  // 1) LABOR (labor_log) — costo de su trabajo en carros, por línea
  let atMin = 0, atCost = 0, atTasks = 0; const atCars = new Set(); const byLineCost = {};
  let wkMin = 0, wkCost = 0, wkTasks = 0;
  try {
    const ls = await db.collection("labor_log").get();
    ls.forEach((doc) => {
      const e = doc.data() || {};
      const m = (empId && e.empId && e.empId === empId) || (nameLc && e.workerName && String(e.workerName).toLowerCase() === nameLc);
      if (!m) return;
      const mn = Number(e.minutes) || 0, cc = Number(e.costCents) || 0;
      atMin += mn; atCost += cc; atTasks++; if (e.carId) atCars.add(e.carId);
      const ln = e.line || "general"; byLineCost[ln] = (byLineCost[ln] || 0) + cc;
      if ((e.at || "") >= weekStart && (e.at || "") < weekEnd) { wkMin += mn; wkCost += cc; wkTasks++; }
    });
  } catch (e) {}
  // 2) SERVICIOS (serviceOrders) — ingreso de servicios que atendió (precio plano del trabajo)
  let svcRev = 0, svcCount = 0;
  try {
    const ss = await db.collection("serviceOrders").get();
    ss.forEach((doc) => {
      const o = doc.data() || {};
      (Array.isArray(o.services) ? o.services : []).forEach((s) => {
        const mine = (empId && s.assignEmpId && s.assignEmpId === empId) || (nameLc && s.assignName && String(s.assignName).toLowerCase() === nameLc);
        if (mine && (s.status === "listo" || s.status === "hecho")) { svcRev += Number(s.priceCents) || 0; svcCount++; }
      });
    });
  } catch (e) {}
  // 3) ASISTENCIA (timeclock) — horas de la semana + histórico + desde cuándo ingresó
  let wkHours = 0, atHours = 0, atShifts = 0, firstClockIn = "", lastClockIn = "";
  try {
    const tc = await db.collection("timeclock").get();
    tc.forEach((doc) => {
      const x = doc.data() || {};
      const mine = (empId && x.empId === empId) || (nameLc && String(x.name || "").toLowerCase() === nameLc);
      if (!mine) return;
      const h = Number(x.hours) || 0; atHours += h; atShifts++;
      if ((x.weekKey || "") === weekKey) wkHours += h;
      const ia = x.inAt || x.createdAt || "";
      if (ia) { if (!firstClockIn || ia < firstClockIn) firstClockIn = ia; if (!lastClockIn || ia > lastClockIn) lastClockIn = ia; }
    });
  } catch (e) {}
  // 4) MIEMBRO DESDE — alta del empleado (o su primera entrada si no hay alta)
  let memberSince = "", empPhone = "", empRoles = [], empRate = 0, empActive = true;
  try {
    let ref = null;
    if (empId) ref = db.collection("employees").doc(empId);
    let es = ref ? await ref.get() : null;
    if (!es || !es.exists) {   // buscar por nombre si no vino empId
      const all = await db.collection("employees").get();
      all.forEach((e) => { if (!es || !es.exists) { const dd = e.data() || {}; if (nameLc && String(dd.name || "").toLowerCase() === nameLc) es = e; } });
    }
    if (es && es.exists) { const dd = es.data() || {}; memberSince = dd.createdAt || ""; empPhone = dd.phone || ""; empRoles = Array.isArray(dd.roles) ? dd.roles : []; empRate = Number(dd.rate) || 0; empActive = dd.active !== false; }
  } catch (e) {}
  if (!memberSince) memberSince = firstClockIn;
  return {
    ok: true, name, empId, weekKey,
    week: { minutes: wkMin, costCents: wkCost, tasks: wkTasks, hours: Math.round(wkHours * 100) / 100 },
    allTime: { minutes: atMin, costCents: atCost, tasks: atTasks, cars: atCars.size, byLineCost, hours: Math.round(atHours * 100) / 100, shifts: atShifts },
    service: { revenueCents: svcRev, count: svcCount },
    tenure: { memberSince, firstClockIn, lastClockIn, phone: empPhone, roles: empRoles, rate: empRate, active: empActive },
  };
});

exports.empAdmin = onCall({ timeoutSeconds: 30 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id || !id.isOwner) throw new HttpsError("permission-denied", "Solo los dueños.");
  const db = admin.firestore();
  const d = (request.data && request.data) || {};
  const op = String(d.op || "list");
  if (op === "list") {
    const snap = await db.collection("employees").get();
    let emps = [];
    snap.forEach((doc) => {
      const x = doc.data() || {};
      emps.push({ id: doc.id, name: x.name || "", phone: x.phone || "", phoneE164: x.phoneE164 || "", roles: Array.isArray(x.roles) ? x.roles : [], rate: Number(x.rate) || 0, active: x.active !== false, owner: x.owner === true, photoURL: x.photoURL || "" });
    });
    emps.sort((a, b) => (Number(b.active) - Number(a.active)) || a.name.localeCompare(b.name));
    try { await Promise.all(emps.map((e) => _syncEmpPhone(db, e.id))); } catch (e) {}   // mantiene el índice emp_phones al día
    // 👑 Dueños por DEFAULT en el PANEL DE EQUIPO (withOwners): todas las funciones, SIN reloj. Sintéticos: no se editan/borran/fichan.
    // Fuera del panel (ej. asignar servicios) NO se inyectan, para no meter ids "owner:" donde no van.
    if (d.withOwners === true) {
      emps = emps.filter((e) => !e.owner);   // los dueños no van como empleados que fichan
      const owners = OWNER_EMAILS.map((em) => ({ id: "owner:" + em, name: OWNER_NAMES[em] || em.split("@")[0], email: em, phone: "", phoneE164: "", roles: ALL_EMP_ROLES.slice(), rate: OWNER_LABOR_RATE, active: true, owner: true, synthetic: true, noClock: true, photoURL: "" }));
      return { ok: true, emps: owners.concat(emps), roles: ALL_EMP_ROLES };
    }
    return { ok: true, emps, roles: ALL_EMP_ROLES };
  }
  if (op === "save") {
    const name = String(d.name || "").trim();
    if (!name) throw new HttpsError("invalid-argument", "Falta el nombre.");
    const phone = String(d.phone || "").trim();
    const roles = Array.isArray(d.roles) ? d.roles.filter((r) => ALL_EMP_ROLES.includes(r)) : [];
    const empId = (String(d.id || "").match(/^[A-Za-z0-9_]{3,80}$/) ? d.id : ("emp_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6)));
    const ref = db.collection("employees").doc(empId);
    const base = { name, phone, phoneE164: _toE164(phone), roles, rate: Math.max(0, Number(d.rate) || 0), active: d.active !== false, owner: d.owner === true, updatedAt: new Date().toISOString(), updatedBy: id.email || id.phone || id.key };
    const exists = (await ref.get()).exists;
    if (!exists) base.createdAt = new Date().toISOString();
    await ref.set(base, { merge: true });
    await _syncEmpPhone(db, empId);
    return { ok: true, id: empId };
  }
  if (op === "setActive") {
    const empId = String(d.id || "");
    if (!empId) throw new HttpsError("invalid-argument", "Falta el empleado.");
    await db.collection("employees").doc(empId).set({ active: d.active !== false, updatedAt: new Date().toISOString() }, { merge: true });
    await _syncEmpPhone(db, empId);
    return { ok: true };
  }
  if (op === "toggleRole") {
    const empId = String(d.id || "");
    const role = String(d.role || "");
    const on = !!d.on;
    if (!empId) throw new HttpsError("invalid-argument", "Falta el empleado.");
    if (!ALL_EMP_ROLES.includes(role)) throw new HttpsError("invalid-argument", "Función inválida.");
    const ref = db.collection("employees").doc(empId);
    await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      const x = s.exists ? (s.data() || {}) : {};
      let roles = Array.isArray(x.roles) ? x.roles.slice() : [];
      if (on) { if (!roles.includes(role)) roles.push(role); } else { roles = roles.filter((r) => r !== role); }
      tx.set(ref, { roles, updatedAt: new Date().toISOString() }, { merge: true });
    });
    await _syncEmpPhone(db, empId);
    return { ok: true };
  }
  if (op === "delete") {
    const empId = String(d.empId || "");
    if (!empId) throw new HttpsError("invalid-argument", "Falta el empleado.");
    if (empId.indexOf("owner:") === 0) throw new HttpsError("invalid-argument", "Un dueño no se borra.");
    try { await db.collection("employees").doc(empId).delete(); } catch (e) { throw new HttpsError("internal", "No se pudo borrar."); }
    try { await _syncEmpPhone(db, empId); } catch (e) {}   // limpia el índice de teléfono
    return { ok: true };
  }
  throw new HttpsError("invalid-argument", "Operación inválida.");
});
// Entrada / salida. request.data = { action:'in'|'out', lat, lng }
// Turno ABIERTO en timeclock_open/<actorKey> (1 por persona) → sin índices compuestos.
// Turnos CERRADOS en timeclock/<autoId> con weekKey (índice de un solo campo, automático).
exports.clockPunch = onCall({ timeoutSeconds: 30 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id) throw new HttpsError("unauthenticated", "Sin identidad.");
  if (id.notRegistered) throw new HttpsError("permission-denied", "Tu teléfono no está registrado. Pídele a Legacy que te dé de alta.");
  if (!id.active) throw new HttpsError("permission-denied", "Tu cuenta está inactiva. Habla con Legacy.");
  const action = String((request.data && request.data.action) || "").trim();
  const lat = request.data && request.data.lat != null ? Number(request.data.lat) : null;
  const lng = request.data && request.data.lng != null ? Number(request.data.lng) : null;
  if (["in", "out", "break_start", "break_end"].indexOf(action) < 0) throw new HttpsError("invalid-argument", "Acción inválida.");
  const db = admin.firestore();
  const openRef = db.collection("timeclock_open").doc(id.key);
  const openSnap = await openRef.get();
  const nowIso = new Date().toISOString();
  const now = Date.now();

  // DESCANSOS (no requieren GPS). El tiempo de descanso NO cuenta en las horas trabajadas.
  if (action === "break_start" || action === "break_end") {
    if (!openSnap.exists) throw new HttpsError("failed-precondition", "No tienes una entrada abierta.");
    const d = openSnap.data();
    const breaks = Array.isArray(d.breaks) ? d.breaks.slice() : [];
    if (action === "break_start") {
      if (d.onBreakSince) throw new HttpsError("failed-precondition", "Ya estás en un descanso.");
      breaks.push({ start: nowIso, end: null });
      await openRef.set({ onBreakSince: nowIso, breaks: breaks }, { merge: true });
      return { ok: true, action: "break_start", at: nowIso };
    } else {
      if (!d.onBreakSince) throw new HttpsError("failed-precondition", "No tienes un descanso abierto.");
      const bms = Math.max(0, now - new Date(d.onBreakSince).getTime());
      for (let i = breaks.length - 1; i >= 0; i--) { if (!breaks[i].end) { breaks[i].end = nowIso; break; } }
      await openRef.set({ onBreakSince: null, breaks: breaks, breakMs: (Number(d.breakMs) || 0) + bms }, { merge: true });
      return { ok: true, action: "break_end", breakMin: Math.round(bms / 60000), at: nowIso };
    }
  }

  // ENTRADA / SALIDA (requieren GPS)
  const cfg = await _tcConfig();
  const geo = _checkGeofence(cfg, lat, lng);
  if (geo.noGps) throw new HttpsError("failed-precondition", "No pudimos leer tu ubicación (GPS). Activa la ubicación e inténtalo de nuevo.");
  if (action === "in") {
    if (openSnap.exists) throw new HttpsError("failed-precondition", "Ya tienes una ENTRADA abierta. Haz Salida primero.");
    if (!geo.ok) throw new HttpsError("failed-precondition", "No estás en el Dealer ni en el Yonke (estás a " + geo.distM + " m). Acércate para registrar tu entrada.");
    await openRef.set({ actorKey: id.key, email: id.email, phone: id.phone, empId: id.empId, name: id.name, location: geo.location, inAt: nowIso, inLat: lat, inLng: lng, weekKey: _laMondayKey(new Date()), breaks: [], onBreakSince: null, breakMs: 0 });
    return { ok: true, action: "in", location: geo.location, at: nowIso };
  } else {
    if (!openSnap.exists) throw new HttpsError("failed-precondition", "No tienes una entrada abierta. Haz Entrada primero.");
    const d = openSnap.data();
    let breakMs = Number(d.breakMs) || 0;
    const breaks = Array.isArray(d.breaks) ? d.breaks.slice() : [];
    // Si sale durante un descanso, se cierra también y ese tiempo no cuenta.
    if (d.onBreakSince) { breakMs += Math.max(0, now - new Date(d.onBreakSince).getTime()); for (let i = breaks.length - 1; i >= 0; i--) { if (!breaks[i].end) { breaks[i].end = nowIso; break; } } }
    const grossMs = Math.max(0, now - new Date(d.inAt).getTime());
    const workedMs = Math.max(0, grossMs - breakMs);
    const hours = workedMs / 3600000;
    await db.collection("timeclock").add({
      actorKey: id.key, email: id.email, phone: id.phone, empId: id.empId, name: id.name,
      location: d.location || geo.location, outLocation: geo.location,
      inAt: d.inAt, outAt: nowIso, inLat: d.inLat, inLng: d.inLng, outLat: lat, outLng: lng,
      hours: Math.round(hours * 100) / 100, grossHours: Math.round((grossMs / 3600000) * 100) / 100,
      breakHours: Math.round((breakMs / 3600000) * 100) / 100, breaks: breaks,
      weekKey: d.weekKey || _laMondayKey(new Date()), createdAt: nowIso,
    });
    await openRef.delete();
    return { ok: true, action: "out", hours: Math.round(hours * 100) / 100, breakMin: Math.round(breakMs / 60000), at: nowIso };
  }
});
// Estado + horas de la semana de quien llama. Para su tarjeta en la app.
exports.clockMine = onCall({ timeoutSeconds: 30 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id) throw new HttpsError("unauthenticated", "Sin identidad.");
  const db = admin.firestore();
  const wk = _laMondayKey(new Date());
  const openSnap = await db.collection("timeclock_open").doc(id.key).get();
  const od = openSnap.exists ? (openSnap.data() || {}) : null;
  const open = od ? { inAt: od.inAt, location: od.location, onBreak: !!od.onBreakSince, onBreakSince: od.onBreakSince || null, breakTaken: ((Number(od.breakMs) || 0) > 0 || (Array.isArray(od.breaks) && od.breaks.length > 0)) } : null;
  const snap = await db.collection("timeclock").where("weekKey", "==", wk).get();
  const emailLc = (id.email || "").toLowerCase();
  let hours = 0;
  snap.forEach((d) => {
    const x = d.data();
    const mine = (x.actorKey && x.actorKey === id.key) || (!x.actorKey && emailLc && (x.email || "").toLowerCase() === emailLc);
    if (mine) hours += Number(x.hours) || 0;
  });
  if (od) {
    let el = Date.now() - new Date(od.inAt).getTime();
    el -= (Number(od.breakMs) || 0);
    if (od.onBreakSince) el -= Math.max(0, Date.now() - new Date(od.onBreakSince).getTime());
    hours += Math.max(0, el / 3600000);
  }
  return { ok: true, weekKey: wk, hours: Math.round(hours * 100) / 100, open };
});
// Panel del dueño (Finanzas): horas + pago de la semana por persona (correo o teléfono).
exports.clockWeek = onCall({ timeoutSeconds: 30 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const _wid = await _actorIdentity(request);
  if (!_wid || !_wid.isOwner) throw new HttpsError("permission-denied", "Solo dueños.");   // dueño por correo O por teléfono (flag owner)
  const db = admin.firestore();
  const cfg = await _tcConfig();
  const rates = cfg.rates || {};
  const wk = (request.data && request.data.weekKey) || _laMondayKey(new Date());
  // Tarifas de empleados por teléfono (viven en el registro `employees`).
  const empRateById = {}; const empOwnerById = {};
  try { const es = await db.collection("employees").get(); es.forEach((e) => { const dd = e.data() || {}; empRateById[e.id] = Number(dd.rate) || 0; empOwnerById[e.id] = dd.owner === true; }); }
  catch (e) {}
  const keyOf = (x) => x.actorKey || ("em_" + _emailKey((x.email || "?").toLowerCase()));
  const byKey = {};
  const touch = (x) => {
    const k = keyOf(x);
    if (!byKey[k]) byKey[k] = { key: k, email: (x.email || "").toLowerCase(), phone: x.phone || "", empId: x.empId || "", name: x.name || (x.email || "").split("@")[0] || "Empleado", hours: 0, open: false, shifts: 0 };
    return byKey[k];
  };
  const snap = await db.collection("timeclock").where("weekKey", "==", wk).get();
  snap.forEach((d) => { const x = d.data(); const r = touch(x); r.hours += Number(x.hours) || 0; r.shifts += 1; });
  // turnos abiertos (entrada sin salida)
  const openSnap = await db.collection("timeclock_open").get();
  openSnap.forEach((d) => { const x = d.data(); if ((x.weekKey || "") !== wk) return; const r = touch(x); r.open = true; let el = Date.now() - new Date(x.inAt).getTime(); el -= (Number(x.breakMs) || 0); if (x.onBreakSince) el -= Math.max(0, Date.now() - new Date(x.onBreakSince).getTime()); r.hours += Math.max(0, el / 3600000); });
  const list = Object.values(byKey).map((r) => {
    const rate = r.empId ? (empRateById[r.empId] || 0) : (Number(rates[r.email]) || 0);
    const hrs = Math.round(r.hours * 100) / 100;
    const owner = OWNER_EMAILS.includes(r.email) || (r.empId && empOwnerById[r.empId] === true);
    return { key: r.key, email: r.email, phone: r.phone, empId: r.empId, name: r.name, hours: hrs, open: r.open, shifts: r.shifts, rate, rateSource: r.empId ? "emp" : "email", pay: Math.round(hrs * rate * 100) / 100, owner: !!owner };
  }).sort((a, b) => b.hours - a.hours);
  const totalPay = list.reduce((s, r) => s + r.pay, 0);
  return { ok: true, weekKey: wk, rates, config: { dealer: cfg.dealer || null, yonke: cfg.yonke || null, radiusM: Number(cfg.radiusM) || 150 }, list, totalPay: Math.round(totalPay * 100) / 100 };
});

// 📅 Detalle de UN día: quién fichó ese día, con entrada→salida, horas, descanso y ubicación. Solo dueños.
exports.clockDay = onCall({ timeoutSeconds: 30 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const _wid = await _actorIdentity(request);
  if (!_wid || !_wid.isOwner) throw new HttpsError("permission-denied", "Solo dueños.");
  const ds = String((request.data && request.data.dateStr) || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) throw new HttpsError("invalid-argument", "Fecha inválida.");
  const db = admin.firestore();
  const wk = _laMondayKey(new Date(ds + "T12:00:00-07:00"));   // lunes de esa semana → una sola consulta
  const localDay = (iso) => { try { return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }); } catch (e) { return ""; } };
  const hm = (iso) => { try { return new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; } };
  const rows = [];
  const snap = await db.collection("timeclock").where("weekKey", "==", wk).get();
  snap.forEach((d) => {
    const x = d.data() || {};
    if (localDay(x.inAt) !== ds) return;
    rows.push({ name: x.name || (x.email || "").split("@")[0] || "Empleado", empId: x.empId || "", location: x.location || "", inAt: x.inAt || "", outAt: x.outAt || "", in: hm(x.inAt), out: x.outAt ? hm(x.outAt) : "", hours: Number(x.hours) || 0, breakHours: Number(x.breakHours) || 0, open: false });
  });
  // turnos abiertos que empezaron ese día (aún sin salida)
  const openSnap = await db.collection("timeclock_open").get();
  openSnap.forEach((d) => {
    const x = d.data() || {};
    if (localDay(x.inAt) !== ds) return;
    let el = Date.now() - new Date(x.inAt).getTime(); el -= (Number(x.breakMs) || 0);
    if (x.onBreakSince) el -= Math.max(0, Date.now() - new Date(x.onBreakSince).getTime());
    rows.push({ name: x.name || "Empleado", empId: x.empId || "", location: x.location || "", inAt: x.inAt || "", outAt: "", in: hm(x.inAt), out: "", hours: Math.max(0, el / 3600000), breakHours: (Number(x.breakMs) || 0) / 3600000, open: true });
  });
  rows.sort((a, b) => String(a.inAt || "").localeCompare(String(b.inAt || "")));
  const totalHours = rows.reduce((s, r) => s + r.hours, 0);
  return { ok: true, dateStr: ds, weekKey: wk, rows, count: rows.length, totalHours: Math.round(totalHours * 100) / 100 };
});

// 🧽 Trabajos de detallado (SOP guiado). op:'save' guarda/actualiza; op:'mine' trae los míos (7 días).
// Guarda tiempo por paso y por carro → métricas de cuánto tarda/cuesta cada proceso.
exports.detailJob = onCall({ timeoutSeconds: 30 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id) throw new HttpsError("unauthenticated", "Sin identidad.");
  if (id.notRegistered || !id.active) throw new HttpsError("permission-denied", "No autorizado.");
  const db = admin.firestore();
  const op = String((request.data && request.data.op) || "save");
  if (op === "mine") {
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    const snap = await db.collection("detail_jobs").where("empKey", "==", id.key).get();
    const jobs = [];
    snap.forEach((d) => { const x = d.data(); if ((x.startedAt || "") >= since) jobs.push(Object.assign({ id: d.id }, x)); });
    jobs.sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
    return { ok: true, jobs: jobs.slice(0, 50) };
  }
  // save
  const job = (request.data && request.data.job) || {};
  const jobId = (String(job.id || "").trim().match(/^[A-Za-z0-9_]{3,60}$/) ? job.id : ("dj_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6)));
  const steps = Array.isArray(job.steps) ? job.steps.slice(0, 40).map((s) => ({
    id: String(s.id || "").slice(0, 40), title: String(s.title || "").slice(0, 80),
    seconds: Math.max(0, Math.round(Number(s.seconds) || 0)), done: !!s.done, skipped: !!s.skipped,
  })) : [];
  const clean = {
    empKey: id.key, empId: id.empId, name: id.name, phone: id.phone,
    car: String(job.car || "").slice(0, 120), vin: String(job.vin || "").slice(0, 20),
    inventoryId: String(job.inventoryId || "").slice(0, 60), inventoryNum: String(job.inventoryNum || "").slice(0, 20),
    triage: (job.triage && typeof job.triage === "object" && !Array.isArray(job.triage) && JSON.stringify(job.triage).length < 2000) ? job.triage : {},
    estMin: Math.max(0, Math.round(Number(job.estMin) || 0)),
    steps, totalSeconds: Math.max(0, Math.round(Number(job.totalSeconds) || 0)),
    status: (job.status === "done") ? "done" : "active",
    startedAt: String(job.startedAt || new Date().toISOString()),
    updatedAt: new Date().toISOString(),
  };
  if (clean.status === "done") clean.finishedAt = String(job.finishedAt || new Date().toISOString());
  await db.collection("detail_jobs").doc(jobId).set(clean, { merge: true });
  // Al TERMINAR de detallar, el carro avanza a "listo" (sale de la lista del detallador → pasa a fotos/listado).
  if (clean.status === "done" && clean.inventoryId) {
    try { await db.collection("inventory").doc(clean.inventoryId).set({ reconStage: "listo", updatedAt: Date.now() }, { merge: true }); } catch (e) {}
  }
  return { ok: true, id: jobId };
});

// 🚗 Carros LISTOS PARA DETALLAR: status:'prep' y reconStage:'detalle' (ya pasaron por mecánico + pintura).
// El detallador solo toma carros que ya salieron de mecánico (smog/aceite/estéreo/reparaciones) y pintura.
exports.prepCars = onCall({ timeoutSeconds: 30 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id) throw new HttpsError("unauthenticated", "Sin identidad.");
  if (id.notRegistered || !id.active) throw new HttpsError("permission-denied", "No autorizado.");
  const db = admin.firestore();
  let snap;
  try { snap = await db.collection("inventory").where("status", "==", "prep").get(); }
  catch (e) { throw new HttpsError("internal", "No se pudo leer el inventario."); }
  const cars = [];
  snap.forEach((d) => {
    const c = d.data() || {};
    if ((c.reconStage || "mecanico") !== "detalle") return;   // gate: solo los listos para detallar
    const label = [c.year, c.make, c.model].filter(Boolean).join(" ") || c.title || c.carTitle || ("#" + (c.inventoryNum || ""));
    const photo = (Array.isArray(c.photos) && c.photos[0]) || (Array.isArray(c.photoURLs) && c.photoURLs[0]) || c.photo || c.coverPhoto || "";
    cars.push({ id: d.id, label, inventoryNum: String(c.inventoryNum || ""), vin: String(c.vin || ""), photo: String(photo || "") });
  });
  cars.sort((a, b) => String(a.inventoryNum).localeCompare(String(b.inventoryNum), undefined, { numeric: true }));
  return { ok: true, cars };
});

// 📮 Enviar el sales sheet a Lendmark directo por el SMTP de Zoho (from ev@, cc a ev@).
exports.sendLendmarkEmail = onCall({ timeoutSeconds: 60, memory: "512MiB" }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const email = ((request.auth.token && request.auth.token.email) || "").toLowerCase();
  if (!OWNER_EMAILS.includes(email)) throw new HttpsError("permission-denied", "Solo dueños.");
  const s = (request.data && request.data.data) || {};
  const to = String((request.data && request.data.to) || "branch257@lendmarkfinancial.com");
  const FROM = "ev@legacymotorsgarage.com";
  const vehicle = String(s.carTitle || "").slice(0, 120);
  const vin = String(s.vin || "").slice(0, 20);
  const money = (n) => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let sigUrl = "";
  try { const sg = await admin.firestore().collection("config").doc("sellerSignature").get(); sigUrl = (sg.exists && sg.data().dataUrl) || ""; } catch (e) {}
  const subject = "Vehicle Sales Sheet for Funding" + (vehicle ? (" — " + vehicle) : "") + (vin ? (" (VIN " + vin + ")") : "");
  const photos = Array.isArray(s.photos) ? s.photos.slice(0, 4) : [];
  const photoHtml = photos.length ? ('<div style="margin:8px 0;">' + photos.map((p) => '<img src="' + p + '" style="width:23%;max-height:120px;object-fit:cover;border:1px solid #999;margin:2px;">').join("") + "</div>") : "";
  const smogHtml = s.smogPhoto ? ('<p style="font-weight:bold;border-bottom:1px solid #000;margin:8px 0 3px;">SMOG CERTIFICATE</p><img src="' + s.smogPhoto + '" style="max-width:55%;max-height:220px;border:1px solid #999;">') : "";
  const odoHtml = s.odometerPhoto ? ('<p style="font-weight:bold;border-bottom:1px solid #000;margin:8px 0 3px;">ODOMETER / ODÓMETRO</p><img src="' + s.odometerPhoto + '" style="max-width:55%;max-height:220px;border:1px solid #999;">') : "";
  const vinPhotoHtml = s.vinPhoto ? ('<p style="font-weight:bold;border-bottom:1px solid #000;margin:8px 0 3px;">VIN PLATE / PLACA DEL VIN</p><img src="' + s.vinPhoto + '" style="max-width:55%;max-height:220px;border:1px solid #999;">') : "";
  const row = (a, b, bold) => '<tr><td style="padding:3px 0;' + (bold ? "font-weight:bold;border-top:1px solid #000;" : "") + '">' + a + '</td><td style="padding:3px 0;text-align:right;' + (bold ? "font-weight:bold;border-top:1px solid #000;" : "") + '">' + b + "</td></tr>";
  const totalRows = s.cash
    ? row("TOTAL (CASH / CONTADO)", money(s.total), true)
    : (row("TOTAL PRICE", money(s.total), true) + row("Less: Down Payment", "(" + money(s.down) + ")") + row("AMOUNT TO FINANCE", money(s.financed), true));
  const sheetHtml =
    '<div style="border-top:2px solid #000;margin-top:14px;padding-top:8px;">' +
    '<div style="font-weight:bold;font-size:15px;">VEHICLE SALES SHEET</div>' +
    '<table style="width:100%;font-size:13px;border-collapse:collapse;margin:6px 0;">' +
      row("Vehicle", vehicle) + row("VIN", vin || "—") + row("Odometer / Miles", s.miles ? (s.miles + " mi") : "—") + (s.color ? row("Color", s.color) : "") +
    "</table>" + photoHtml + smogHtml + odoHtml + vinPhotoHtml +
    '<p style="font-weight:bold;border-bottom:1px solid #000;margin:10px 0 3px;">PRICE BREAKDOWN</p>' +
    '<table style="width:100%;font-size:13px;border-collapse:collapse;">' +
      row("Vehicle Cash Price", money(s.price)) + row("Document Preparation Fee", money(s.docFee || 70)) + row("Smog Certification Fee", money(s.smog || 58.25)) +
      row("Sales Tax", money(s.tax)) + row("DMV / Registration Fees", money(s.dmv)) + totalRows +
    "</table>" +
    '<div style="margin-top:18px;">' + (sigUrl ? ('<img src="' + sigUrl + '" style="height:44px;">') : "") + '<div style="border-top:1px solid #000;width:220px;padding-top:3px;font-size:11px;">Dealer / Legacy Motors Garage LLC · ' + (s.today || "") + "</div></div>" +
    "</div>";
  const textBody =
    "Dear Lendmark Financial Services Team,\n\n" +
    "Please find below the vehicle sales sheet for the following deal, for your review and funding:\n\n" +
    (vehicle ? ("Vehicle: " + vehicle + "\n") : "") + (vin ? ("VIN: " + vin + "\n") : "") +
    "\nThe sheet includes the vehicle details, photographs, smog certificate, and the complete price breakdown (vehicle price, documentation fee, smog certification, sales tax, and DMV/registration fees)" +
    (s.cash ? "." : ", along with the down payment and the amount to finance.") +
    "\n\nPlease let us know if you need any additional documentation to process this transaction. We appreciate your partnership.\n\n" +
    "Best regards,\n\nEnrique Villagómez\nLegacy Motors Garage LLC\n21122 Ave 152, Porterville, CA 93257\nPhone: (559) 540-5145\nDealer License No. 83177";
  const htmlBody =
    '<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:680px;">' +
    "<p>Dear Lendmark Financial Services Team,</p>" +
    "<p>Please find below the vehicle sales sheet for the following deal, for your review and funding.</p>" +
    "<p>Please let us know if you need any additional documentation to process this transaction. We appreciate your partnership.</p>" +
    "<p>Best regards,<br><br><b>Enrique Villagómez</b><br>Legacy Motors Garage LLC<br>21122 Ave 152, Porterville, CA 93257<br>Phone: (559) 540-5145<br>Dealer License No. 83177</p>" +
    sheetHtml + "</div>";
  try {
    const pass = await _getZohoPass();
    if (!pass) return { ok: false, error: "Falta configurar la contraseña de Zoho. Verifica que el secreto ZOHO_MAIL_PASS exista en el proyecto legacy-motors-garage y que la función tenga permiso para leerlo." };
    const nodemailer = require("nodemailer");
    const transporter = nodemailer.createTransport({
      host: "smtp.zoho.com", port: 465, secure: true,
      auth: { user: FROM, pass },
    });
    await transporter.sendMail({ from: '"Legacy Motors Garage LLC" <' + FROM + ">", to, cc: FROM, subject, text: textBody, html: htmlBody });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

exports.botConvos = onCall({ timeoutSeconds: 30 }, async (request) => {
  salesOwnerOnly(request);
  const db = admin.firestore();
  const days = [];
  try {
    const ss = await db.collection("bot_stats").orderBy("date", "desc").limit(14).get();
    ss.forEach((d) => { const x = d.data(); days.push({ date: x.date || d.id, convos: x.convos || 0, messages: x.messages || 0 }); });
  } catch (e) {}
  const list = [];
  try {
    const cs = await db.collection("bot_convos").orderBy("lastAt", "desc").limit(60).get();
    cs.forEach((d) => { const x = d.data(); list.push({ id: d.id, date: x.date || "", lastAt: x.lastAt || "", startedAt: x.startedAt || "", firstMsg: x.firstMsg || "", msgCount: x.msgCount || ((x.messages || []).length), booked: !!x.booked, lang: x.lang || "es" }); });
  } catch (e) {}
  const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
  const today = days.find((d) => d.date === todayStr) || { date: todayStr, convos: 0, messages: 0 };
  return { today, days, list };
});
exports.botConvoGet = onCall({ timeoutSeconds: 30 }, async (request) => {
  salesOwnerOnly(request);
  const id = String((request.data && request.data.id) || "").slice(0, 80);
  if (!id) throw new HttpsError("invalid-argument", "Falta id.");
  const snap = await admin.firestore().collection("bot_convos").doc(id).get();
  if (!snap.exists) return { ok: false };
  const x = snap.data();
  return { ok: true, id, date: x.date || "", startedAt: x.startedAt || "", lastAt: x.lastAt || "", lang: x.lang || "es", booked: !!x.booked, messages: x.messages || [] };
});

// 🛟 BOT INTERNO DE AYUDA — le resuelve dudas a los empleados sobre CÓMO USAR el sistema Legacy DMS.
const HELP_PROMPT = `Eres el asistente de ayuda INTERNO de Legacy Motors Garage — ayudas a los EMPLEADOS y supervisores a usar el sistema (la app "Legacy DMS"). Responde en el idioma en que te escriban (casi siempre español). Sé claro, breve, paciente y amable, con pasos simples (1, 2, 3). Si no sabes algo o es una decisión del negocio (precios, permisos, dinero), diles que le pregunten a un supervisor (Enrique o Ivan).

CÓMO FUNCIONA LA APP (para que puedas guiarlos):
• Hay 4 secciones abajo: **Inventario** (carros a la venta), **Clientes** (pagos, citas), **Finanzas** (gastos/ingresos), **Warehouse** (yarda/almacén). Cada quien ve solo lo de su rol.
• ROLES: Captura (el que toma fotos de partes), Listado (el que sube a eBay), Empaque (Sunmi, empaca), Mecánico, y Supervisores (Enrique = Supervisor W / Ivan = Supervisor Y).

WAREHOUSE — CAPTURA (para el que toma fotos):
• Los carros a desmantelar SOLO los agregan los supervisores. Captura NO agrega carros, solo les agrega partes.
• Para agregar una parte: entra al carro → "➕ Parte" → pon el número de ESTAMPA (la etiqueta de 4 dígitos), el nombre de la parte, condición, y el BIN (dónde queda). Toma las fotos: 1ª = la PIEZA COMPLETA (esa es la foto principal), 2ª y 3ª = los NÚMEROS/estampas de cerca (el bot lee las 3 primeras 🤖). Guarda.
• El BIN acepta LETRAS y números (ej. A-14, V-3) — sirve para racks por letra como el de los vidrios. Se escribe en mayúsculas solo.
• 🖨️ REIMPRIMIR NÚMERO: en "Agregar parte rápida" hay un botón "🖨️ Reimprimir número de estampa". Si la estampa de una parte ya está borrosa o no se ve, tócalo, escribe el número, y se imprime una etiqueta nueva GRANDE con ese número en la Sunmi/impresora (comparte a la app de la impresora). Ya no usamos QR.
• Botón 🎈 "Airbag": si es airbag o sensor de airbag, tócalo — lo manda al bin AIRBAGS y no se lista (eBay no los permite). Clock springs y cinturones sí se listan normal.
• Al EDITAR una parte: puedes mandar una foto al frente con ⭐ (se vuelve la principal), y para borrar fotos usa "🗑️ Eliminar fotos" → selecciona → confirma (así no borras sin querer). Al tocar una foto se agranda; al cerrarla sigues dentro de la parte.

WAREHOUSE — LISTADO (para el que sube a eBay):
• Cada parte tiene un botón 🤖 "Preparar/Regenerar": el bot lee las fotos y arma el anuncio (título, categoría, descripción, números). Revisa en la app la CATEGORÍA y los ESPECIFICOS antes de publicar.
• Si algo está mal, escribe en la cajita "¿Algo mal?" (ej. "es un vidrio, no un switch") y dale 🔁 Corregir.
• Luego "🔄 Actualizar borrador" y cuando esté bien "🚀 Publicar (en vivo)".
• El orden de la lista es del más viejo arriba al más nuevo abajo (hazlos en orden). Los airbags salen en su sección aparte abajo.

WAREHOUSE — EMPAQUE (para el que empaca y envía, con la Sunmi en el shop):
• 🔎 "Busca tu parte" (caja de arriba): escribe el número de estampa o el nombre. Las de eBay con SKU no hace falta buscarlas.
• Cuando aparece la pieza, toca la foto para agrandarla y deslizarla; luego toca "✅ Es esta pieza".
• Sale "📍 Sácala del bin": ve al bin que indica, saca la pieza y, para confirmar que la tienes, teclea o escanea con el láser el número directo de la pieza (o toca "✅ Sí, ya la tengo"). Si escaneas una que NO es, te avisa y te deja reintentar sin sacarte.
• Si NO la encuentras, toca "❌ No la encuentro": la deja pendiente y avisa a los supervisores en el chat.
• Ya confirmada, abre "📦 Empaca tu producto": tips, medidas de la caja, y el PESO (escribes lo que sale en la báscula en libras, ej. 15.85, y se convierte solo a lb + oz). Toca "✅ Empacado y listo" → animación de enviado.
• 🚦 SEMÁFORO (la pieza NO se cambia de sección, solo cambia de color en su lugar): 🟢 Publicada → 🟤 Empaquetando (café, cuando terminas de empacar) → 🟣 En tránsito (morado; toca "🚚 Marcar como enviada" cuando ya la mandaste) → 🟡 VENDIDA (dorado; toca "💵 Marcar como VENDIDA" cuando eBay pagó). Cada paso queda registrado para las métricas. Si te equivocaste de estado, la misma pieza tiene el botón para regresarla.
• Si marcaste una por error como vendida, búscala y toca "↩️ Regresar a inventario".
• El teclado nunca tapa los buscadores: al escribir, el panel sube solo y baja cuando cierras el teclado.
• 🛠️ Herramientas de almacén (caja de abajo, se minimiza): "📥 Recibir / asignar ubicación" (piezas que llegan de la yarda sin bin: escanea o teclea el número y asígnale su bin), "🏷️ Alta de pieza vieja" (mete piezas viejas con estampa + bin), y "📦 Consolidar bins" (junta bins con pocas piezas: elige uno, muévelo a otro, y te dice apartar el bin vacío para Captura).

CHAT INTERNO (la burbuja 💬):
• Tiene varios canales según tu rol. Para reaccionar a un mensaje, déjalo apretado y elige un emoji. Para ocultar un chat, deslízalo a la izquierda.
• Activa las notificaciones tocando "🔔 Activar" para que no se te escape ningún mensaje.
• 🔧 SEÑALAR UNA PARTE: si tú y un compañero están hablando de una pieza específica, toca el botón 🔧 al lado de la cajita de escribir, busca la parte por su número de sticker o nombre, y se pega en el mensaje. Cualquiera puede tocar esa etiqueta 🔧 en el mensaje para saltar directo a esa parte y editarla/arreglarla. Sirve para que no haya confusión de cuál pieza es y la corrijan rápido entre los dos.
• 🌐 En el canal de avisos a todos (grupo), los mensajes se traducen solos: cada quien los lee en español o inglés según el idioma que tenga puesto en su app.
• La burbuja de chat (y la de ayuda) se pueden arrastrar y se pegan a la orilla; recuerdan dónde las dejaste.
• AYUDA (esta burbuja 🛟): tu conversación conmigo se queda guardada aunque cierres o salgas — puedes volver y ver lo que preguntaste antes.

INVENTARIO — AGREGAR / EDITAR UN CARRO (supervisores):
• Al AGREGAR un carro: escribe el VIN y toca "Decodificar VIN" — se llenan solos el año, la marca, el modelo y la VERSIÓN/Trim (LT, XLE, Sport...). El color NO viene en el VIN (por ley), así que ese se escribe a mano.
• Después de decodificar aparece "▸ Ver / corregir todos los datos del VIN": ábrelo para ver TODOS los datos y CORREGIR cualquiera antes de guardar.
• COSTO DE COMPRA: al agregar pones lo que costó el carro y eliges "¿Quién pagó?": Dealer (100%), Yarda/Partes (100%), o Mitad y mitad (50/50). El 50/50 parte el costo en dos gastos (mitad Dealer, mitad Partes). Si agregaste un carro SIN costo, al EDITARLO te deja registrarlo (sale el bloque del costo); si ya tiene, no lo pide para no duplicar.
• ANUNCIO PARA EL JACKET: abre el carro en la página y toca "🖨️ Imprimir anuncio" — sale en 1 hoja, con la foto principal y los datos (millas, VIN, versión, color, ficha del VIN), SIN video. Es para meterlo al jacket del carro (lo pide el DMV).
• FICHA TÉCNICA DEL VIN: en el anuncio hay un desplegable "📋 Ficha técnica del VIN" con TODOS los datos — lo ven el equipo y los clientes.
• La VERSIÓN y el COLOR salen en el anuncio (título) y en los CONTRATOS.
• Si un carro se DEVUELVE (te regresaron el dinero) o se manda A PARTES (yonke), en el carro (editar) hay botones para eso: "↩️ Devolví este carro" reversa su costo, y "🔧 Mandar a partes" lo copia al almacén.

CLIENTES (CRM) — CONTRATOS Y PAGOS (supervisores):
• Al agregar un cliente puedes BUSCAR el carro del inventario por NOMBRE o número — se llenan los datos del carro (incluye color y versión) para el contrato.
• "📄 Generar Contrato": si el cliente es de español a pagos sale UN documento bilingüe (inglés + español) con UNA firma; si es de contado, el de contado. Se firma en el iPad; el contrato firmado queda guardado (📑).
• "💰 Liquidar HOY": para liquidar una cuenta el mismo día con el monto que TÚ pongas (por si le haces descuento). Está en la ventana de registrar pago.
• "🚫 Cancelar venta (cliente cambia de carro)": hace una devolución del dinero (baja el ingreso de hoy), saca los impuestos/DMV de "por cotejar", archiva el contrato viejo y libera la firma para el carro nuevo. Está en registrar pago.
• "📁 Archivar contrato firmado": si el cliente ya firmó pero necesitas que firme uno nuevo (cambió de carro), esto guarda el viejo (anulado) y libera la firma.
• "📇 Guardar contacto": guarda el cliente (nombre + teléfono + carro) en los contactos del iPhone con un toque, para saber quién te escribe.
• Si borras un PAGO equivocado, también se anula solo en Finanzas.

FINANZAS (supervisores):
• BUSCADOR (barra de arriba): busca por MONTO (150, 150.00), NOMBRE del cliente, CARRO, o FECHA en muchas formas (15/9, "sep 15", "septiembre", "hoy", "ayer") y te lleva a ese día.
• ＋Ingreso / ＋Gasto: registra dinero que entra o sale, con su bolsa (Dealer / Partes / eBay). Cada gasto se puede ligar a un carro.
• CUENTAS POR COBRAR (💳): las ventas a pagos aparecen ahí con su saldo. Botones por cuenta: Abonar, Liquidar, y "🗑 Cancelar" (borra el saldo pendiente; lo ya cobrado se queda como ingreso).
• DEVOLVER UNA VENTA (↩️): en Movimientos, toca la venta → "↩️ Devolver venta". Deja el ingreso original y registra la devolución con fecha de HOY (soporta parcial). Para cuando un cliente devuelve una parte.
• CARGOS RECURRENTES: en "Recurrentes" agregas los gastos que se repiten (software, dominio, renta...). Ahora se REGISTRAN SOLOS como gasto cada que vence la fecha — no hay que meterlos a mano. Pon bien la Bolsa y la próxima fecha. Las pruebas gratis solo avisan, no se registran.
• DMV / IMPUESTOS: lo que el cliente paga de impuestos y placas se guarda aparte en "🏛️ DMV / Impuestos por cotejar" (no es ganancia, es dinero de paso al DMV).
• CORTE DE CAJA: para cuadrar el efectivo y repartir. El cierre lo ejecuta una sola cuenta (para no cerrarlo por error); cuádrenlo juntos.
• "🔧 Por carro (yonke)": cuánto va dejando cada carro a desmantelar (ventas de partes menos el costo del carro).

Si te preguntan algo que no está aquí o es de dinero/permisos/decisiones, di amablemente que le pregunten a Enrique o Ivan. Nunca inventes.`;
exports.helpChat = onRequest({ secrets: [ANTHROPIC_KEY], cors: true, timeoutSeconds: 60 }, async (req, res) => {
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  try {
    const msgsIn = Array.isArray(req.body && req.body.messages) ? req.body.messages.slice(-12) : [];
    const AnthropicMod = require("@anthropic-ai/sdk");
    const Anthropic = AnthropicMod.Anthropic || AnthropicMod.default || AnthropicMod;
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY.value() });
    const messages = msgsIn.filter((m) => m && m.content).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content).slice(0, 1200) }));
    if (!messages.length || messages[0].role !== "user") messages.unshift({ role: "user", content: "Hola" });
    // 🧠 Prompt caching: el manual grande (HELP_PROMPT) se cachea y se reusa en cada pregunta → baja el costo de entrada.
    const msg = await client.messages.create({ model: SITE_BOT_MODEL, max_tokens: 600, system: [{ type: "text", text: HELP_PROMPT, cache_control: { type: "ephemeral" } }], messages });
    const reply = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    try {
      const u = msg.usage || {};
      const cost = +(((u.input_tokens || 0) / 1e6) * 3 + ((u.output_tokens || 0) / 1e6) * 15).toFixed(6);
      const ym = new Date().toISOString().slice(0, 7).replace("-", "_");
      const inc = admin.firestore.FieldValue.increment;
      await admin.firestore().collection("config").doc("aiUsage").set({
        helpUsd: inc(cost), helpCount: inc(1),
        ["help_m_" + ym + "_usd"]: inc(cost), ["help_m_" + ym + "_count"]: inc(1),
      }, { merge: true });
    } catch (e) {}
    res.json({ reply: reply || "¿En qué te ayudo con el sistema?" });
  } catch (e) { console.log("helpChat", e); res.json({ reply: "Perdón, tuve un detalle. Intenta de nuevo o pregúntale a un supervisor." }); }
});

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
      // 💾 AUTO-GUARDA el refresh token en la base → todas las funciones de eBay lo usan sin tocar el secreto ni redeploy.
      let saved = false;
      try { await admin.firestore().collection("config").doc("ebay").set({ refreshToken: j.refresh_token, refreshAt: new Date().toISOString(), expiresDays: days }, { merge: true }); saved = true; } catch (e) {}
      res.status(200).send(`<!doctype html><html><body style="font-family:-apple-system,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;">
        <h2>✅ Autorización exitosa</h2>
        ${saved ? '<p style="color:#0a7d2c;font-weight:700;">💾 Token guardado automáticamente. ¡Ya quedó — no tienes que hacer nada más!</p>' : '<p style="color:#b00;">⚠️ No se pudo guardar solo. Copia el token de abajo y pégalo en Secret Manager (EBAY_OAUTH_REFRESH).</p>'}
        <details><summary style="cursor:pointer;color:#666;">Ver token (respaldo)</summary>
        <textarea readonly style="width:100%;height:120px;font-size:12px;" onclick="this.select()">${j.refresh_token}</textarea></details>
        <p style="color:#666;">Válido ~${days} días.</p>`);
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
// Trading API con TOKEN OAuth (IAF header) en vez del Auth'n'Auth viejo (revocado). Para GetMemberMessages / AddMemberMessageRTQ, etc.
async function ebayXmlOAuth(callName, inner, scope){
  const a = await ebayUserAccessToken(scope || "https://api.ebay.com/oauth/api_scope");
  if (!a.token) return { xml: "", tokenErr: a.raw || {} };
  const body = `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
${inner}
</${callName}Request>`;
  const r = await fetch("https://api.ebay.com/ws/api.dll", {
    method: "POST",
    headers: {
      "X-EBAY-API-CALL-NAME": callName,
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
      "X-EBAY-API-IAF-TOKEN": a.token,
      "Content-Type": "text/xml",
    },
    body,
  });
  return { xml: await r.text() };
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
const EBAY_MOTORS_TREE = "100";   // ⚠️ Árbol de eBay MOTORS (US). Las autopartes NO están en el árbol 0 (sitio general).
const EBAY_MP = "EBAY_MOTORS";    // ⚠️ Marketplace de autopartes. Con EBAY_US las categorías de Motors dan 25005 "invalid category".
async function ebayCategorySuggest(query){
  const tok = await ebayAppToken();
  if (!tok) return { id: "", ack: "notoken" };
  const r = await fetch("https://api.ebay.com/commerce/taxonomy/v1/category_tree/" + EBAY_MOTORS_TREE + "/get_category_suggestions?q=" + encodeURIComponent(query), {
    headers: { "Authorization": "Bearer " + tok },
  });
  const j = await r.json().catch(() => ({}));
  const sugg = j.categorySuggestions || [];
  const pick = sugg[0];   // En el árbol 100 TODO es eBay Motors P&A → la mejor sugerencia ya es la correcta
  const dbg = pick ? ((pick.category && pick.category.categoryName) || "?") : ("http=" + r.status + " " + JSON.stringify(j).slice(0, 100));
  return { id: (pick && pick.category) ? pick.category.categoryId : "", ack: pick ? "ok" : "empty", dbg };
}
// Aspectos (item specifics) que eBay pide para una categoría
async function ebayCategoryAspects(catId){
  const tok = await ebayAppToken();
  if (!tok) return [];
  const r = await fetch("https://api.ebay.com/commerce/taxonomy/v1/category_tree/" + EBAY_MOTORS_TREE + "/get_item_aspects_for_category?category_id=" + encodeURIComponent(catId), {
    headers: { "Authorization": "Bearer " + tok },
  });
  const j = await r.json();
  return (j.aspects || []).map((a) => ({
    name: a.localizedAspectName,
    required: !!(a.aspectConstraint && a.aspectConstraint.aspectRequired),
    values: (a.aspectValues || []).map((v) => v.localizedValue).filter(Boolean).slice(0, 40),
  }));
}

const EBAY_SECRETS = [EBAY_APP_ID, EBAY_DEV_ID, EBAY_CERT_ID, EBAY_AUTH_TOKEN];

// 🔑 Access token de USUARIO (refresh_token grant) — para las APIs REST de vender (Inventory/Account). Scopes sell.inventory + sell.account.
async function ebayUserAccessToken(scope){
  // 🔁 Prefiere el refresh token GUARDADO en la base (lo escribe el callback al autorizar) → sin tocar el secreto ni redeploy.
  let rt = "";
  try { const s = await admin.firestore().collection("config").doc("ebay").get(); if (s.exists) rt = String((s.data() || {}).refreshToken || "").trim(); } catch (e) {}
  if (!rt) rt = (EBAY_OAUTH_REFRESH.value() || "").trim();   // fallback al secreto (compatibilidad)
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

// 🔗 Re-autorización eBay con TODOS los permisos que usamos (inventario + cuenta + ÓRDENES/fulfillment).
// Abre este enlace UNA vez, inicia sesión en eBay, acepta → el callback te da un refresh token NUEVO con permiso de leer órdenes.
const EBAY_FINANCES_SCOPE = "https://api.ebay.com/oauth/api_scope/sell.finances";
const EBAY_ALL_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  EBAY_FINANCES_SCOPE,   // 💵 para leer el NETO real por orden (lo que nos quedó) — API de Finanzas
].join(" ");
exports.ebayConsent = onRequest({ secrets: [EBAY_APP_ID] }, (req, res) => {
  const url = "https://auth.ebay.com/oauth2/authorize?client_id=" + encodeURIComponent(EBAY_APP_ID.value()) +
    "&redirect_uri=" + encodeURIComponent(EBAY_RUNAME) +
    "&response_type=code&prompt=login&scope=" + encodeURIComponent(EBAY_ALL_SCOPES);
  res.redirect(302, url);
});

// 💵 NETO REAL de eBay por parte vendida ("lo que nos quedó"): API de Finanzas (getTransactions).
// Suma por orden CRÉDITO − DÉBITO (venta − comisiones − envío − reembolsos) = neto real, y lo guarda en cada parte (ebayNetCents).
// Solo dueños. Requiere el scope sell.finances (reautorizar eBay una vez).
exports.ebaySyncNet = onCall({ secrets: [EBAY_APP_ID, EBAY_CERT_ID, EBAY_OAUTH_REFRESH], timeoutSeconds: 180 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const id = await _actorIdentity(request);
  if (!id || !id.isOwner) throw new HttpsError("permission-denied", "Solo dueños.");
  const a = await ebayUserAccessToken(EBAY_FINANCES_SCOPE);
  if (!a.token) return { ok: false, needConsent: true, error: (a.raw && (a.raw.error_description || a.raw.error)) || "Sin token de finanzas. Reautoriza eBay." };
  const days = Math.min(730, Math.max(1, Number((request.data || {}).days) || 365));
  const from = new Date(Date.now() - days * 86400000).toISOString();
  const to = new Date(Date.now() + 86400000).toISOString();   // rango CERRADO (eBay a veces no acepta abierto)
  const net = {};   // orderId -> cents (suma firmada)
  let offset = 0, pages = 0, authBad = false, firstStatus = 0, errBody = "", txSeen = 0;
  while (pages < 40) {
    // Solo VENTAS (SALE) — el neto de la venta ya viene con las comisiones descontadas (pagos gestionados). Ignora las ~17mil comisiones sueltas.
    const url = "https://apiz.ebay.com/sell/finances/v1/transaction?limit=200&offset=" + offset +
      "&filter=" + encodeURIComponent("transactionType:{SALE},transactionDate:[" + from + ".." + to + "]");
    let r; try { r = await fetch(url, { headers: { "Authorization": "Bearer " + a.token, "Accept": "application/json" }, signal: AbortSignal.timeout(25000) }); } catch (e) { errBody = "fetch: " + (e && e.message || e); break; }
    if (!firstStatus) firstStatus = r.status;
    if (r.status === 401 || r.status === 403) { authBad = true; break; }
    const j = await r.json().catch(() => ({}));
    if (r.status >= 400 && !errBody) { try { errBody = JSON.stringify(j).slice(0, 300); } catch (e) {} }
    const txs = Array.isArray(j.transactions) ? j.transactions : [];
    txSeen += txs.length;
    txs.forEach((tx) => {
      const oid = tx.orderId || (Array.isArray(tx.references) && tx.references[0] && tx.references[0].referenceId) || "";
      if (!oid) return;
      const val = Math.round((Number(tx.amount && tx.amount.value) || 0) * 100);
      const sign = (String(tx.bookingEntry || "").toUpperCase() === "CREDIT") ? 1 : -1;
      net[oid] = (net[oid] || 0) + sign * val;
    });
    pages++;
    if (txs.length < 200) break;
    offset += 200;
  }
  if (authBad) return { ok: false, needConsent: true, error: "eBay negó el permiso de Finanzas (reautoriza con sell.finances)." };
  // Guarda el neto en cada parte vendida con ebayOrderId. (Órdenes de 1 parte = exacto; multi-parte = neto de la orden, afinar después.)
  const db = admin.firestore();
  let matched = 0, updated = 0;
  try {
    const ps = await db.collection("parts").get();
    let batch = db.batch(), n = 0;
    for (const d of ps.docs) {
      const p = d.data() || {}; if (!p.ebayOrderId) continue;   // cualquier parte vendida en eBay (empaquetando/en_transito/vendido)
      matched++;
      if (net[p.ebayOrderId] != null) {
        batch.set(d.ref, { ebayNetCents: net[p.ebayOrderId], ebayNetAt: new Date().toISOString() }, { merge: true });
        updated++; n++;
        if (n >= 400) { await batch.commit(); batch = db.batch(); n = 0; }
      }
    }
    if (n > 0) await batch.commit();
  } catch (e) {}
  return { ok: true, updated, matched, orders: Object.keys(net).length, days, firstStatus, txSeen, errBody, sampleOrders: Object.keys(net).slice(0, 4) };
});

// 🔍 TEMPORAL: diagnóstico directo de la API de Finanzas de eBay (gated por key). Sin montos (solo orderId/estatus).
exports.ebayFinDiag = onRequest({ secrets: [EBAY_APP_ID, EBAY_CERT_ID, EBAY_OAUTH_REFRESH], timeoutSeconds: 60 }, async (req, res) => {
  if (String(req.query.key || "") !== "lmgfin2026") { res.status(403).send("no"); return; }
  try {
    const a = await ebayUserAccessToken(EBAY_FINANCES_SCOPE);
    if (!a.token) { res.json({ ok: false, step: "token", tokenErr: a.raw || "sin token" }); return; }
    // 💸 MODO FEES: comisiones (NON_SALE_CHARGE) de los últimos N días — para ver insertion fees / store fee.
    if (String(req.query.mode || "") === "fees") {
      const fdays = Math.min(120, Math.max(1, Number(req.query.days) || 40));
      const ffrom = new Date(Date.now() - fdays * 86400000).toISOString();
      const fto = new Date(Date.now() + 86400000).toISOString();
      const byType = {}; let total = 0, cnt = 0, off = 0, pg = 0, fstatus = 0, ferr = "";
      while (pg < 40) {
        const u = "https://apiz.ebay.com/sell/finances/v1/transaction?limit=200&offset=" + off + "&filter=" + encodeURIComponent("transactionType:{NON_SALE_CHARGE},transactionDate:[" + ffrom + ".." + fto + "]");
        let rr; try { rr = await fetch(u, { headers: { "Authorization": "Bearer " + a.token, "Accept": "application/json" }, signal: AbortSignal.timeout(25000) }); } catch (e) { ferr = "fetch " + (e && e.message); break; }
        if (!fstatus) fstatus = rr.status;
        const jj = await rr.json().catch(() => ({}));
        if (rr.status >= 400) { ferr = JSON.stringify(jj).slice(0, 300); break; }
        const tx = Array.isArray(jj.transactions) ? jj.transactions : [];
        tx.forEach((t) => { const c = Math.round((Number(t.amount && t.amount.value) || 0) * 100); total += c; cnt++; const ft = t.feeType || (t.references && t.references[0] && t.references[0].referenceType) || "OTRO"; byType[ft] = (byType[ft] || 0) + c; });
        pg++; if (tx.length < 200) break; off += 200;
      }
      const byTypeUsd = {}; Object.keys(byType).forEach((k) => { byTypeUsd[k] = +(byType[k] / 100).toFixed(2); });
      res.json({ ok: true, mode: "fees", days: fdays, status: fstatus, count: cnt, totalUsd: +(total / 100).toFixed(2), byType: byTypeUsd, err: ferr });
      return;
    }
    const from = new Date(Date.now() - 365 * 86400000).toISOString();
    const to = new Date(Date.now() + 86400000).toISOString();
    const url = "https://apiz.ebay.com/sell/finances/v1/transaction?limit=50&filter=" + encodeURIComponent("transactionType:{SALE},transactionDate:[" + from + ".." + to + "]");
    const r = await fetch(url, { headers: { "Authorization": "Bearer " + a.token, "Accept": "application/json", "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" }, signal: AbortSignal.timeout(25000) });
    const status = r.status;
    const j = await r.json().catch(() => ({}));
    const txs = Array.isArray(j.transactions) ? j.transactions : [];
    // 📦 Conteo real de lo que SUBIMOS a eBay (Inventory API): items de inventario.
    let invTotal = null, invErr = "";
    try {
      const ai = await ebayUserAccessToken("https://api.ebay.com/oauth/api_scope/sell.inventory");
      if (ai.token) {
        const ih = { "Authorization": "Bearer " + ai.token, "Accept": "application/json", "Accept-Language": "en-US", "Content-Language": "en-US" };
        const ri = await fetch("https://api.ebay.com/sell/inventory/v1/inventory_item?limit=1", { headers: ih, signal: AbortSignal.timeout(25000) });
        const ji = await ri.json().catch(() => ({}));
        invTotal = (ji.total != null) ? ji.total : null;
        if (ri.status >= 400) invErr = "inv " + ri.status + ": " + JSON.stringify(ji).slice(0, 200);
      } else { invErr = "sin token inventory"; }
    } catch (e) { invErr = String(e && e.message || e); }
    res.json({
      ok: status < 300, step: "transaction", status, salesTotal: j.total, salesInPage: txs.length,
      sample: txs.slice(0, 4).map((t) => ({ orderId: t.orderId || "", type: t.transactionType || "", booking: t.bookingEntry || "", hasAmount: !!(t.amount && t.amount.value) })),
      ebayInventoryItems: invTotal, invErr,
      errBody: status >= 400 ? JSON.stringify(j).slice(0, 600) : "",
    });
  } catch (e) { res.json({ ok: false, step: "catch", error: String(e && e.message || e) }); }
});

// 📦 Órdenes vendidas SIN enviar (Fulfillment API getOrders) → cola "Por enviar" para Empaque.
// Devuelve datos crudos por orden (SKU, título, cantidad, fecha límite de envío, comprador); el front hace el match SKU→parte (bin/foto).
const EBAY_FULFILL_SCOPE = "https://api.ebay.com/oauth/api_scope/sell.fulfillment";
// Fotos REALES del anuncio de eBay (Trading API GetItem → PictureDetails.PictureURL). Para mostrarlas en la cola de Empaque.
async function ebayListingPhotos(itemId){
  if (!itemId) return [];
  // Usa la Browse API con TOKEN DE APLICACIÓN (client_credentials) — se genera solo y NO se revoca (el Trading token viejo sí fue revocado).
  try {
    const tok = await ebayAppToken();
    if (!tok) return [];
    const r = await fetch("https://api.ebay.com/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=" + encodeURIComponent(itemId), {
      headers: { "Authorization": "Bearer " + tok, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US", "Accept": "application/json" },
    });
    const j = await r.json().catch(() => ({}));
    const urls = [];
    if (j && j.image && j.image.imageUrl) urls.push(j.image.imageUrl);
    (j && j.additionalImages || []).forEach((im) => { if (im && im.imageUrl) urls.push(im.imageUrl); });
    return [...new Set(urls)].slice(0, 24);
  } catch (e) { return []; }
}
// 🧪 DIAGNÓSTICO mensajes eBay (protegido) — ¿nos deja leer las preguntas de compradores? /ebayMsgDiag?k=<EBAY_VERIFY_TOKEN>
exports.ebayMsgDiag = onRequest({ secrets: [EBAY_APP_ID, EBAY_CERT_ID, EBAY_OAUTH_REFRESH], timeoutSeconds: 60 }, async (req, res) => {
  if (req.query.k !== EBAY_VERIFY_TOKEN) { res.status(403).json({ error: "forbidden" }); return; }
  const out = {};
  try {
    const r = await ebayFetchInbox(2);   // usa el MISMO camino que el panel (headers+bodies+limpieza)
    out.err = r.err || null;
    out.unanswered = r.unanswered;
    out.total = r.total;
    const m = (r.list || [])[0];
    out.first = m ? { sender: m.sender, subject: m.subject, itemId: m.itemId, bodyLen: (m.body || "").length, bodyClean: (m.body || "").slice(0, 500) } : null;
  } catch (e) { out.err = (e && e.message) || String(e); }
  res.json(out);
});
// Decodifica entidades HTML y quita etiquetas (los mensajes de eBay traen HTML).
function ebayDecode(s, stripTags) {
  const ent = (x) => String(x).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/gi, " ").replace(/&bull;/gi, "·").replace(/&#\d+;/g, " ").replace(/&amp;/g, "&");
  let t = ent(ent(String(s || "")));   // 2 pasadas → maneja doble-encoding (&amp;nbsp;)
  if (stripTags) {
    t = t.replace(/<style[\s\S]*?<\/style>/gi, " ")   // ← quita el CSS que se veía como "@media only screen..."
         .replace(/<script[\s\S]*?<\/script>/gi, " ")
         .replace(/<head[\s\S]*?<\/head>/gi, " ")
         .replace(/<!--[\s\S]*?-->/g, " ")
         .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|td|li)>/gi, "\n")
         .replace(/<[^>]+>/g, " ")
         .replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    // Recorta el pie de plantilla de eBay (deja la pregunta del comprador arriba).
    t = t.split(/\n\s*(?:View your listing|Get to know the buyer|View listing|View item|Marketplaces|Report this message|Response options)/i)[0].trim();
  }
  return t;
}
// Lee el BUZÓN GENERAL de eBay (GetMyMessages): headers → filtra mensajes de comprador sin responder → trae los cuerpos.
async function ebayFetchInbox(maxN) {
  const T = (b, t) => { const m = b.match(new RegExp("<" + t + ">([\\s\\S]*?)</" + t + ">")); return m ? m[1] : ""; };
  // "Desde" configurable (botón "Empezar desde hoy") → ignora los mensajes viejos. Default: últimos 7 días.
  let since = "";
  try { const cfg = await admin.firestore().collection("config").doc("ebayInbox").get(); if (cfg.exists && cfg.data().since) since = cfg.data().since; } catch (e) {}
  const end = new Date();
  let start = since ? new Date(since) : new Date(end.getTime() - 7 * 86400000);
  const minStart = new Date(end.getTime() - 90 * 86400000);   // eBay limita la ventana
  if (start < minStart) start = minStart;
  const sinceMs = since ? new Date(since).getTime() : 0;
  const h = await ebayXmlOAuth("GetMyMessages", `<DetailLevel>ReturnHeaders</DetailLevel>\n<StartTime>${start.toISOString()}</StartTime>\n<EndTime>${end.toISOString()}</EndTime>`);
  if (h.tokenErr) return { err: "token" };
  const xml = h.xml || "";
  if ((ebayTags(xml, "Ack")[0] || "") === "Failure") return { err: (ebayTags(xml, "LongMessage")[0] || "eBay error") };
  const blocks = xml.match(/<Message>[\s\S]*?<\/Message>/g) || [];
  let heads = blocks.map((b) => ({
    messageId: T(b, "MessageID"),
    externalId: T(b, "ExternalMessageID"),
    sender: T(b, "Sender"),
    subject: ebayDecode(T(b, "Subject")).slice(0, 180),
    itemId: T(b, "ItemID"),
    date: T(b, "ReceiveDate"),
    read: /<Read>true<\/Read>/.test(b),
    replied: /<Replied>true<\/Replied>/.test(b),
    responseEnabled: /<ResponseEnabled>true<\/ResponseEnabled>/.test(b),
    responseURL: ebayDecode(T(b, "ResponseURL")),
    type: T(b, "MessageType"),
  }));
  const total = heads.length;
  // Solo mensajes de un COMPRADOR real, contestables y sin responder (no avisos del sistema de eBay).
  heads = heads.filter((m) => m.messageId && m.sender && m.sender.toLowerCase() !== "ebay" && !m.replied && m.responseEnabled && /AskSeller|M2M|ContacteBay|Member/i.test(m.type) && (!sinceMs || (new Date(m.date).getTime() >= sinceMs)));
  heads.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const unanswered = heads.length;
  heads = heads.slice(0, maxN || 30);
  // Cuerpos en lotes de 10 (GetMyMessages ReturnMessages).
  const byId = {};
  for (let i = 0; i < heads.length; i += 10) {
    const ids = heads.slice(i, i + 10).map((m) => "<MessageID>" + m.messageId + "</MessageID>").join("");
    const b = await ebayXmlOAuth("GetMyMessages", `<DetailLevel>ReturnMessages</DetailLevel>\n<MessageIDs>${ids}</MessageIDs>`);
    (String(b.xml || "").match(/<Message>[\s\S]*?<\/Message>/g) || []).forEach((blk) => { const id = T(blk, "MessageID"); if (id) byId[id] = ebayDecode(T(blk, "Text") || T(blk, "Body"), true).slice(0, 2000); });
  }
  heads.forEach((m) => { m.body = byId[m.messageId] || ""; });
  return { list: heads, unanswered, total };
}
// 📨 Bandeja de preguntas de compradores en eBay (solo dueños).
exports.ebayInbox = onCall({ secrets: [EBAY_APP_ID, EBAY_CERT_ID, EBAY_OAUTH_REFRESH], timeoutSeconds: 120 }, async (request) => {
  salesOwnerOnly(request);
  const r = await ebayFetchInbox(30);
  if (r.err) return { ok: false, needConsent: r.err === "token", error: r.err };
  return { ok: true, count: (r.list || []).length, unanswered: r.unanswered || 0, total: r.total || 0, list: r.list || [] };
});
// 🧹 "Empezar desde hoy": ignora los mensajes viejos (guarda un corte de fecha). NO borra nada en eBay.
exports.ebaySetSince = onCall({ timeoutSeconds: 20 }, async (request) => {
  salesOwnerOnly(request);
  const now = new Date().toISOString();
  await admin.firestore().collection("config").doc("ebayInbox").set({ since: now, updatedBy: (request.auth.token && request.auth.token.email) || "", updatedAt: now }, { merge: true });
  return { ok: true, since: now };
});
// ✍️ Borrador de respuesta (IA experta en autopartes) — el dueño lo revisa antes de enviar.
exports.ebayMsgDraft = onCall({ secrets: [ANTHROPIC_KEY], timeoutSeconds: 60 }, async (request) => {
  salesOwnerOnly(request);
  const q = String((request.data && request.data.question) || "").slice(0, 1500);
  const item = String((request.data && request.data.item) || "").slice(0, 200);
  if (!q) throw new HttpsError("invalid-argument", "Falta la pregunta.");
  const sys = `Eres el equipo de Legacy Motors Garage, vendedor de AUTOPARTES usadas de calidad en eBay (Porterville, CA). Un comprador hizo una pregunta sobre una parte. Redacta la RESPUESTA para enviársela:
- Cálida, breve, profesional y muy servicial (como un buen vendedor de refacciones). En el MISMO idioma del comprador (en eBay US casi siempre inglés).
- HONESTA con el fitment: si preguntan si una parte le queda a su carro y no puedes estar 100% seguro, pídele el año/marca/modelo o el número OEM/interchange para confirmar, u ofrece verificarlo — NUNCA prometas compatibilidad que no sabes.
- Útil: disponibilidad, condición, y que haces envío combinado si compran varias partes.
- No prometas fechas exactas de entrega ni nada que no controles. Cierra invitando a comprar con confianza.
- Devuelve SOLO el texto de la respuesta, listo para enviar (sin comillas, sin "Asunto:", sin firma tipo formulario — puedes cerrar con "— Legacy Motors Garage").
- NOTA: el mensaje del comprador puede traer texto de plantilla/HTML de eBay; IGNÓRALO y enfócate en lo que el comprador realmente pregunta o pide. El "Asunto" te dice de qué ARTÍCULO se trata. Si no queda clara la pregunta, responde de forma útil sobre esa parte e invita al comprador a decirte su año/marca/modelo para confirmar.`;
  const AnthropicMod = require("@anthropic-ai/sdk");
  const Anthropic = AnthropicMod.Anthropic || AnthropicMod.default || AnthropicMod;
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY.value() });
  const msg = await client.messages.create({ model: SITE_BOT_MODEL, max_tokens: 450, system: [{ type: "text", text: sys }], messages: [{ role: "user", content: (item ? ("Parte del anuncio: " + item + "\n\n") : "") + "Pregunta del comprador:\n" + q }] });
  const draft = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  return { ok: true, draft };
});
// 📤 Enviar la respuesta aprobada (AddMemberMessageRTQ).
exports.ebayMsgSend = onCall({ secrets: [EBAY_APP_ID, EBAY_CERT_ID, EBAY_OAUTH_REFRESH], timeoutSeconds: 60 }, async (request) => {
  salesOwnerOnly(request);
  const itemId = String((request.data && request.data.itemId) || "");
  // AddMemberMessageRTQ.ParentMessageID = el ExternalMessageID (qid) de la pregunta.
  const parentId = String((request.data && (request.data.externalId || request.data.messageId)) || "");
  const recipient = String((request.data && request.data.recipient) || "");
  const body = String((request.data && request.data.body) || "").slice(0, 2000);
  if (!parentId || !recipient || !body) throw new HttpsError("invalid-argument", "Faltan datos.");
  const x = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inner = `${itemId ? ("<ItemID>" + x(itemId) + "</ItemID>") : ""}
<MemberMessageRTQ>
  <Body>${x(body)}</Body>
  <ParentMessageID>${x(parentId)}</ParentMessageID>
  <RecipientID>${x(recipient)}</RecipientID>
  <DisplayToPublic>false</DisplayToPublic>
</MemberMessageRTQ>`;
  const r = await ebayXmlOAuth("AddMemberMessageRTQ", inner);
  if (r.tokenErr) return { ok: false, error: "token" };
  const ack = (ebayTags(r.xml || "", "Ack")[0] || "");
  if (ack === "Success" || ack === "Warning") return { ok: true };
  return { ok: false, error: (ebayTags(r.xml || "", "LongMessage")[0] || "eBay error") };
});
exports.ebayOrders = onCall({ secrets: [EBAY_APP_ID, EBAY_DEV_ID, EBAY_CERT_ID, EBAY_AUTH_TOKEN, EBAY_OAUTH_REFRESH], timeoutSeconds: 120 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const a = await ebayUserAccessToken(EBAY_FULFILL_SCOPE);
  if (!a.token) {
    const err = a.raw || {};
    // Si el refresh token no tiene el permiso de órdenes, hay que re-autorizar con /ebayConsent.
    return { ok: false, needConsent: /scope/i.test((err.error || "") + (err.error_description || "")), error: (err.error || "?") + " — " + (err.error_description || "sin detalle") };
  }
  // Órdenes activas sin enviar (NOT_STARTED = nada enviado; IN_PROGRESS = parcial).
  const filter = encodeURIComponent("orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS}");
  const url = "https://api.ebay.com/sell/fulfillment/v1/order?limit=200&filter=" + filter;
  const r = await fetch(url, { headers: { "Authorization": "Bearer " + a.token, "Accept": "application/json", "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" } });
  const status = r.status;
  let j = {}; try { j = await r.json(); } catch (e) {}
  if (status < 200 || status >= 300) {
    return { ok: false, status, error: (j && j.errors && j.errors[0] && j.errors[0].message) || ("HTTP " + status) };
  }
  const orders = (j.orders || []).map((o) => {
    const items = (o.lineItems || []).map((li) => ({
      sku: li.sku || "",
      title: li.title || "",
      qty: li.quantity || 1,
      itemId: li.legacyItemId || "",
      shipBy: (li.lineItemFulfillmentInstructions && li.lineItemFulfillmentInstructions.shipByDate) || "",
    }));
    // Fecha límite de envío de la orden = la más próxima de sus items (o la fecha de creación como respaldo).
    const shipDates = items.map((i) => i.shipBy).filter(Boolean).sort();
    return {
      orderId: o.orderId,
      buyer: (o.buyer && o.buyer.username) || "",
      createdAt: o.creationDate || "",
      status: o.orderFulfillmentStatus || "",
      shipBy: shipDates[0] || "",
      total: (o.pricingSummary && o.pricingSummary.total && o.pricingSummary.total.value) || "",
      items,
    };
  });
  // Ordena por fecha límite de envío (los sin fecha, por fecha de creación) — HOY primero.
  orders.sort((a2, b2) => (a2.shipBy || a2.createdAt || "").localeCompare(b2.shipBy || b2.createdAt || ""));
  // Enriquece con las fotos REALES del anuncio de eBay (una llamada GetItem por artículo único, en paralelo). Cap 60 para no abusar.
  const ids = [...new Set(orders.flatMap((o) => (o.items || []).map((i) => i.itemId).filter(Boolean)))].slice(0, 60);
  const photoMap = {};
  await Promise.all(ids.map(async (id) => { photoMap[id] = await ebayListingPhotos(id); }));
  orders.forEach((o) => (o.items || []).forEach((i) => { i.photos = (i.itemId && photoMap[i.itemId]) || []; }));
  return { ok: true, count: orders.length, orders };
});

// 🚚 SINCRONIZA "enviado" desde eBay → cuando marcas el pedido como shipped en eBay (compras la etiqueta),
// la pieza en nuestro almacén avanza SOLA a "en_transito" (ya no lo marcas a mano). Match por SKU/itemId.
exports.ebaySyncShipped = onCall({ secrets: [EBAY_APP_ID, EBAY_CERT_ID, EBAY_OAUTH_REFRESH], timeoutSeconds: 120 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const a = await ebayUserAccessToken(EBAY_ALL_SCOPES);
  if (!a.token) {
    const err = a.raw || {};
    return { ok: false, needConsent: /scope/i.test((err.error || "") + (err.error_description || "")), error: (err.error || "?") };
  }
  // Pedidos YA ENVIADOS (FULFILLED) — de aquí sacamos los SKU que ya salieron.
  const filter = encodeURIComponent("orderfulfillmentstatus:{FULFILLED}");
  const url = "https://api.ebay.com/sell/fulfillment/v1/order?limit=200&filter=" + filter;
  const r = await fetch(url, { headers: { "Authorization": "Bearer " + a.token, "Accept": "application/json", "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" } });
  let j = {}; try { j = await r.json(); } catch (e) {}
  if (r.status < 200 || r.status >= 300) {
    return { ok: false, status: r.status, error: (j && j.errors && j.errors[0] && j.errors[0].message) || ("HTTP " + r.status) };
  }
  const db = admin.firestore();
  // Estados desde los que SÍ avanzamos a en_transito al detectar el envío en eBay.
  const ADVANCE_FROM = ["empaquetando", "publicado", "borrador", "disponible"];
  let updated = 0; const done = [];
  for (const o of (j.orders || [])) {
    for (const li of (o.lineItems || [])) {
      const sku = (li.sku || "").trim();
      const itemId = String(li.legacyItemId || "").trim();
      let ref = null, data = null;
      if (sku) {
        const q = await db.collection("parts").where("stickerNum", "==", sku).limit(1).get();
        if (!q.empty) { ref = q.docs[0].ref; data = q.docs[0].data(); }
      }
      if (!ref && itemId) {
        const q = await db.collection("parts").where("ebayItemId", "==", itemId).limit(1).get();
        if (!q.empty) { ref = q.docs[0].ref; data = q.docs[0].data(); }
      }
      if (!ref || !data) continue;
      if (data.warehouseOnly) continue;                        // piezas viejas ya en eBay: no se tocan
      if (!ADVANCE_FROM.includes(data.status)) continue;       // ya está en_transito/vendido: no re-toca
      await ref.update({ status: "en_transito", ebayShippedAt: o.creationDate || new Date().toISOString(), ebayOrderId: o.orderId, packPending: false });
      updated++; done.push(sku || itemId);
    }
  }
  return { ok: true, updated, done };
});

async function loadPart(partId){
  if (!partId) throw new HttpsError("invalid-argument", "Falta partId.");
  const snap = await admin.firestore().collection("parts").doc(partId).get();
  if (!snap.exists) throw new HttpsError("not-found", "Parte no encontrada.");
  return Object.assign({ id: partId }, snap.data());
}

// Resuelve la CATEGORÍA de eBay Motors. Intenta VARIAS búsquedas (frase IA → tipo de parte → nombre+carro)
// y se queda con la PRIMERA que sea de Motors. Si ninguna acierta, cae a Car & Truck Parts general.
// Trae TODAS las hojas (categorías finales) del árbol "Car & Truck Parts & Accessories" (6030) de eBay Motors.
// get_category_suggestions es malo con autopartes (manda bicicletas/herramientas) → buscamos SOLO dentro de Motors.
let _motorsLeaves = null, _motorsDbg = "";
// Baja el árbol COMPLETO de eBay y saca las HOJAS bajo "Car & Truck Parts" (por nombre, sin adivinar IDs muertos).
async function ebayMotorsLeaves(){
  const tok = await ebayAppToken();
  if (!tok) { _motorsDbg = "notoken"; return []; }
  const r = await fetch("https://api.ebay.com/commerce/taxonomy/v1/category_tree/0", { headers: { "Authorization": "Bearer " + tok } });
  if (!r.ok) { _motorsDbg = "tree http=" + r.status; return []; }
  const j = await r.json();
  const leaves = [];
  const walk = (node, inParts) => {
    if (!node) return;
    const cat = node.category || {};
    const name = (cat.categoryName || "").toLowerCase();
    const nowIn = inParts || /car\s*&\s*truck parts/.test(name);   // entra a la rama de autopartes por nombre
    const kids = node.childCategoryTreeNodes || [];
    if (nowIn && (node.leafCategoryTreeNode === true || kids.length === 0)) {
      if (cat.categoryId && cat.categoryName) leaves.push({ id: cat.categoryId, name: cat.categoryName });
    }
    kids.forEach((k) => walk(k, nowIn));
  };
  walk(j.rootCategoryNode, false);
  const top = (j.rootCategoryNode && j.rootCategoryNode.childCategoryTreeNodes) || [];
  const motorsNode = top.find((n) => /motor/i.test((n.category && n.category.categoryName) || ""));
  const motorsKids = motorsNode ? (motorsNode.childCategoryTreeNodes || []).map((n) => (n.category && n.category.categoryName) || "?").join(",") : "no-motors-node";
  _motorsDbg = "n=" + leaves.length + " top=" + top.length + " | Motors kids: " + motorsKids.slice(0, 180);
  return leaves;
}
async function getMotorsLeaves(){
  if (_motorsLeaves && _motorsLeaves.length) return _motorsLeaves;
  // Caché en Firestore (para no bajar el árbol completo en cada cold start)
  try {
    const snap = await admin.firestore().collection("config").doc("motorsCats").get();
    if (snap.exists && Array.isArray(snap.data().leaves) && snap.data().leaves.length) { _motorsLeaves = snap.data().leaves; _motorsDbg = "cache n=" + _motorsLeaves.length; return _motorsLeaves; }
  } catch (e) {}
  try {
    _motorsLeaves = await ebayMotorsLeaves();
    if (_motorsLeaves.length) { try { await admin.firestore().collection("config").doc("motorsCats").set({ leaves: _motorsLeaves, updatedAt: new Date().toISOString() }); } catch (e) {} }
  } catch (e) { _motorsLeaves = []; _motorsDbg = "err:" + (e.message || e); }
  return _motorsLeaves || [];
}
// Elige la hoja de Motors cuyo NOMBRE coincide mejor con el tipo de parte
function matchMotorsLeaf(leaves, partType, name){
  if (!leaves || !leaves.length) return null;
  const words = (String(partType || "") + " " + String(name || "")).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  if (!words.length) return null;
  let best = null, bestScore = 0;
  for (const l of leaves) {
    const n = l.name.toLowerCase();
    let s = 0;
    for (const w of words) if (n.includes(w)) s += (w.length >= 4 ? 2 : 1);
    if (s > bestScore) { bestScore = s; best = l; }
  }
  return bestScore >= 2 ? best : null;
}

async function resolveCategory(p){
  const d = p.ebayDraft || {};
  const is = d.itemSpecifics || {};
  // 👑 MANDA la categoría que la IA YA usó para llenar los item specifics (draft.ebayCategoryId).
  // Si no, al publicar podríamos caer en otra categoría y eBay descarta los specifics que no aplican → salen vacíos.
  if (d.ebayCategoryId) return { catId: String(d.ebayCategoryId), catAck: "draft:" + (d.ebayCategoryAck || "") };
  const title = (d.title || p.ebayTitle || p.name || "Auto part").slice(0, 80);
  const partType = d.ebayCategory || is["Type"] || p.name || "";
  // get_category_suggestions EN EL ÁRBOL 100 (eBay Motors) → la mejor sugerencia ya es la categoría correcta de Motors.
  const queries = [partType, title, p.name].filter((q) => q && q.trim());
  let catAck = "none", catId = "", dbg0 = "";
  for (const q of queries) {
    try { const c = await ebayCategorySuggest(q); if (!dbg0) dbg0 = c.dbg || ""; if (c.id) { catId = c.id; catAck = "ok:" + ((c.dbg || "").slice(0, 40)); break; } catAck = c.ack; } catch (e) { catAck = "err:" + (e.message || e); }
  }
  if (!catId && d.ebayCategoryId) { catId = d.ebayCategoryId; catAck = "draft"; }
  if (!catId) { catId = "6030"; catAck += " | " + dbg0; }
  return { catId, catAck };
}

// Resuelve los ITEM SPECIFICS (compartido por el camino XML/Trading y el JSON/Inventory).
// Pide a eBay los aspectos de ESA categoría y los llena con lo que tenemos (como a mano). Devuelve [{name, values:[...]}].
const WARRANTY_VALUE = "1 Month";   // garantía fija de Legacy (si eBay rechaza este valor, prueba "30 Days")
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
    if (/oe\s*\/?\s*oem|^oem\s*(part\s*)?(number|no)|^oe\s*(part\s*)?(number|no)/.test(n)) { const v = d.suggestedPartNumber || (d.interchange && d.interchange[0]) || (d.partNumbers && d.partNumbers[0]) || is["OE/OEM Part Number"]; return v ? [v] : null; }
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
  // 🛡️ Garantía SIEMPRE 1 mes (lo que Legacy respeta al cliente). Pisa lo que haya puesto la IA.
  specs.forEach((sp) => { if (/warranty/i.test(sp.name)) sp.values = [WARRANTY_VALUE]; });
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
  <SKU>${xesc(p.stickerNum || p.id || p.entryId || "")}</SKU>
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
// mp = marketplace del header. Account API (políticas) = EBAY_US; Inventory (offer/item) = EBAY_MOTORS.
async function ebayRest(method, path, token, body, mp){
  let r;
  try {
    r = await fetch("https://api.ebay.com" + path, {
      method,
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Accept-Language": "en-US",
        "Content-Language": "en-US",
        "X-EBAY-C-MARKETPLACE-ID": mp || "EBAY_US",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) { return { status: 0, ok: false, json: null, text: "red/fetch: " + (e.message || e) }; }
  let json = null, text = "";
  try { text = await r.text(); json = text ? JSON.parse(text) : null; } catch (e) {}
  return { status: r.status, ok: r.status >= 200 && r.status < 300, json, text };
}

// Extrae mensajes de error legibles de una respuesta REST de eBay (con errorId + parámetros)
function ebayRestErrors(r){
  const e = r.json && r.json.errors;
  if (Array.isArray(e) && e.length) return e.map((x) => {
    const params = (x.parameters || []).map((q) => (q.name ? q.name + "=" : "") + q.value).join(", ");
    return (x.message || x.longMessage || "error") + (x.errorId ? (" (id " + x.errorId + ")") : "") + (params ? (" [" + params + "]") : "");
  }).slice(0, 6);
  return [(r.text || "").slice(0, 400) || ("HTTP " + r.status)];
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

// USA la mejor política que YA existe (según un test 'prefer'); crea una solo si NO hay ninguna.
// (Evita pelear con eBay actualizando políticas — usa las que el vendedor ya tiene y son válidas.)
async function ebayPickOrCreatePolicy(token, type, listKey, idKey, prefer, name, createBody){
  const r = await ebayRest("GET", "/sell/account/v1/" + type + "_policy?marketplace_id=EBAY_US", token);
  if (!r.ok) return { err: ebayRestErrors(r), raw: (r.text || "").slice(0, 300) };
  const list = (r.json && r.json[listKey]) || [];
  const pick = list.find(prefer) || list.find((p) => /^LMG/i.test(p.name || "")) || list[0];
  if (pick) return { id: pick[idKey], name: pick.name || "" };
  const c = await ebayRest("POST", "/sell/account/v1/" + type + "_policy", token, Object.assign({ name, marketplaceId: "EBAY_US" }, createBody));
  if (c.ok) return { id: c.json[idKey], name };
  return { err: ebayRestErrors(c), raw: (c.text || "").slice(0, 300) };
}

// Afina la política de envío: (a) excluye Alaska/Hawái, Protectorados de EE.UU. (incluye Puerto Rico) y APO/FPO;
// (b) fija el HANDLING TIME a 1 día (next-day). Solo escribe si algo cambia.
const EBAY_HANDLING_DAYS = 1;   // días de manejo (next-day). Cambia aquí si algún día quieres otro.
async function ebayExcludeRegions(token, id){
  try {
    const g = await ebayRest("GET", "/sell/account/v1/fulfillment_policy/" + id, token);
    if (!g.ok || !g.json) return "get_fail";
    const pol = g.json;
    let changed = false;
    // (a) exclusiones de zona
    const want = ["Alaska/Hawaii", "US Protectorates", "APO/FPO"];
    const cur = ((pol.shipToLocations || {}).regionExcluded || []).map((r) => r.regionName);
    if (!want.every((w) => cur.includes(w))) {
      const merged = new Set(cur); want.forEach((w) => merged.add(w));
      pol.shipToLocations = Object.assign({}, pol.shipToLocations, {
        regionExcluded: Array.from(merged).map((regionName) => ({ regionName })),
      });
      changed = true;
    }
    // (b) handling time = 1 día
    if (!pol.handlingTime || pol.handlingTime.value !== EBAY_HANDLING_DAYS || pol.handlingTime.unit !== "DAY") {
      pol.handlingTime = { value: EBAY_HANDLING_DAYS, unit: "DAY" };
      changed = true;
    }
    if (!changed) return "already h=" + EBAY_HANDLING_DAYS + "d";
    delete pol.fulfillmentPolicyId;  // va en la URL, no en el body
    const u = await ebayRest("PUT", "/sell/account/v1/fulfillment_policy/" + id, token, pol);
    return u.ok ? ("ok excl+handling=" + EBAY_HANDLING_DAYS + "d") : ((ebayRestErrors(u)[0] || "put_fail").slice(0, 120));
  } catch (e) { return "exc:" + String(e && e.message || e).slice(0, 80); }
}

// Asegura las 3 políticas: prefiere una de ENVÍO GRATIS, una de PAGO, y una de NO devoluciones — de las que ya tienes.
async function ebayEnsurePolicies(token, cfg){
  const out = {};
  const opt = await ebayRest("POST", "/sell/account/v1/program/opt_in", token, { programType: "SELLING_POLICY_MANAGEMENT" });
  out.optIn = opt.ok ? "ok" : (ebayRestErrors(opt)[0] || "").slice(0, 120);
  // Envío: prefiere una que tenga FREE shipping
  const isFree = (fp) => (fp.shippingOptions || []).some((o) => (o.shippingServices || []).some((s) => s.freeShipping === true));
  const ful = await ebayPickOrCreatePolicy(token, "fulfillment", "fulfillmentPolicies", "fulfillmentPolicyId", isFree, "LMG Free Shipping", {
    categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES" }],
    handlingTime: { value: EBAY_HANDLING_DAYS, unit: "DAY" },   // 1 día → envío gratis + manejo rápido = "Fast 'N Free" / estimado de entrega rápido
    shippingOptions: [{ optionType: "DOMESTIC", costType: "FLAT_RATE",
      shippingServices: [{ sortOrder: 1, shippingServiceCode: "USPSGroundAdvantage", freeShipping: true }] }],
  });
  if (ful.id) { out.fulfillmentPolicyId = ful.id; out.fulfillmentName = ful.name; out.excludeRegions = await ebayExcludeRegions(token, ful.id); } else { out.fulfillmentErr = ful.err; out.raw = ful.raw; }
  // Pago: la que haya (eBay Managed Payments maneja pagos + impuestos igual)
  const pay = await ebayPickOrCreatePolicy(token, "payment", "paymentPolicies", "paymentPolicyId", () => false, "LMG Payment", {
    categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES" }],
  });
  if (pay.id) { out.paymentPolicyId = pay.id; out.paymentName = pay.name; } else { out.paymentErr = pay.err; }
  // Devolución: prefiere una de NO returns
  const noRet = (rp) => rp.returnsAccepted === false;
  const ret = await ebayPickOrCreatePolicy(token, "return", "returnPolicies", "returnPolicyId", noRet, "LMG No Returns", {
    categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES" }], returnsAccepted: false,
  });
  if (ret.id) { out.returnPolicyId = ret.id; out.returnName = ret.name; } else { out.returnErr = ret.err; }
  return out;
}

// ⚙️ Configurar cuenta de eBay para la API (una sola vez): ubicación + políticas. Guarda IDs en config/ebay.
exports.ebaySellerSetup = onCall({ secrets: [EBAY_APP_ID, EBAY_CERT_ID, EBAY_OAUTH_REFRESH], timeoutSeconds: 120 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const a = await ebayUserAccessToken();
  if (!a.token) return { ok: false, step: "token", errors: [(a.raw && a.raw.error_description) || "sin token"] };
  const loc = await ebayEnsureLocation(a.token);
  const cfgSnap0 = await admin.firestore().collection("config").doc("ebay").get();
  const pol = await ebayEnsurePolicies(a.token, cfgSnap0.exists ? cfgSnap0.data() : {});
  const cfg = {
    locationKey: loc.key,
    fulfillmentPolicyId: pol.fulfillmentPolicyId || null,
    paymentPolicyId: pol.paymentPolicyId || null,
    returnPolicyId: pol.returnPolicyId || null,
    fulfillmentName: pol.fulfillmentName || "",
    paymentName: pol.paymentName || "",
    returnName: pol.returnName || "",
    excludeRegions: pol.excludeRegions || "",   // resultado handling(1d) + exclusión AK/HI/PR
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
// Lee el VIN del carro de donde salió la parte (colección dismantle_vehicles de la yarda)
async function loadVehicleVin(p){
  if (!p.vehicleId) return "";
  try { const vs = await admin.firestore().collection("dismantle_vehicles").doc(p.vehicleId).get(); return vs.exists ? (vs.data().vin || "") : ""; } catch (e) { return ""; }
}
// Marca del carro (ej. Honda) — se usa como Brand por defecto en eBay para partes OEM. Artículo rápido trae vMake.
async function loadVehicleMake(p){
  if (p.vMake && String(p.vMake).trim()) return String(p.vMake).trim();
  if (!p.vehicleId) return "";
  try { const vs = await admin.firestore().collection("dismantle_vehicles").doc(p.vehicleId).get(); return vs.exists ? (vs.data().make || "") : ""; } catch (e) { return ""; }
}

// 🚛 ¿Es un MOTOR o TRANSMISIÓN completa (envío por flete/LTL a terminal)? Decide la IA (freightItem); respaldo por palabras clave.
function isFreightPart(p){
  const d = p.ebayDraft || {};
  if (d.freightItem === true) return true;
  if (d.freightItem === false) return false;
  const n = ((p.name || "") + " " + (d.title || p.ebayTitle || "") + " " + (d.ebayCategory || "")).toLowerCase();
  // Excluir partes chicas que traen "motor"/"trans" pero NO son ensamble completo.
  if (/(window|blower|wiper|washer|cooling|radiator|starter|door|seat|heater|blend|throttle|hvac|fan)\s*motor|motor\s*mount|transmission\s*(mount|cooler|line|filter|pan|sensor|solenoid|control|module|wire|harness|dipstick)|shift\s*solenoid|valve\s*body|torque\s*converter/.test(n)) return false;
  return /\bengine\b|long\s*block|short\s*block|engine\s*assembly|motor\s*(completo|complete|long|short|assembly)|\btransmission\b|transmisi[oó]n|transaxle|gearbox/.test(n);
}
// 📝 Descripción PRO con formato (HTML): condición + fitment + números + interchange + carro/VIN + cierre de gracias.
// Se usa en cada anuncio para que todas se vean iguales de fregonas y completas.
function buildListingDescription(p, vin){
  const d = p.ebayDraft || {};
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Sanitiza: si un borrador viejo guardó JSON crudo o ```json en la descripción, no lo mostramos.
  let ov = (d.description || "").trim();
  if (/```|^\s*[{\[]|"\s*:\s*"|"title"\s*:/.test(ov)) ov = "";
  const overview = ov || (p.name || "").trim();
  const cond = (d.conditionNote || "").trim();
  const fits = (d.fitsVehicles || "").trim();
  const nums = [...(d.partNumbers || []), d.suggestedPartNumber].filter(Boolean);
  const inter = (d.interchange || []).filter(Boolean);
  const veh = [p.vYear, p.vMake, p.vModel, p.vTrim].filter(Boolean).join(" ");
  const out = [];
  if (overview) out.push(`<p style="font-size:15px;line-height:1.55;margin:0 0 12px;">${esc(overview)}</p>`);
  if (cond) out.push(`<p style="font-size:14px;line-height:1.5;margin:0 0 12px;"><b>🔎 Condition:</b> ${esc(cond)}</p>`);
  const li = [];
  if (fits) li.push(`<li>✅ <b>Verified Fitment:</b> ${esc(fits)}</li>`);
  if (nums.length) li.push(`<li>🔩 <b>Part Number(s):</b> ${esc(nums.join(", "))}</li>`);
  if (inter.length) li.push(`<li>🔄 <b>Interchange / Compatible Numbers:</b> ${esc(inter.join(", "))}</li>`);
  if (veh) li.push(`<li>🚗 <b>Pulled From:</b> ${esc(veh)}${vin ? ` &nbsp;·&nbsp; <b>VIN:</b> ${esc(vin)}` : ""}</li>`);
  if (li.length) out.push(`<ul style="font-size:14px;line-height:1.8;margin:0 0 12px;padding-left:20px;">${li.join("")}</ul>`);
  if (isFreightPart(p)) {
    out.push(`<div style="border:2px solid #c8960c;background:#fff8e6;border-radius:10px;padding:14px 16px;margin:0 0 14px;font-size:14px;line-height:1.6;color:#3a2c00;">
      <div style="font-size:15px;font-weight:800;margin-bottom:6px;">🚛 FREIGHT SHIPPING — PLEASE READ BEFORE BUYING</div>
      This is a large, heavy item (complete engine/transmission) that ships by <b>freight (LTL truck)</b>, professionally crated/palletized and insured.
      <ul style="margin:8px 0 8px;padding-left:20px;">
        <li><b>FREE shipping is to the freight terminal nearest to your delivery ZIP code</b> — <b>NOT</b> to your home or a residential address. You (or your shop) pick it up at the terminal, or we can quote residential/business delivery.</li>
        <li>The terminal will <b>call you to schedule pickup</b>. Bring a valid ID and a way to load it (the terminal has a forklift).</li>
        <li>Need it delivered to a <b>home / with a liftgate</b>, or want a delivery quote to your exact address? <b>Message us BEFORE you buy</b> and we'll get you the best rate.</li>
        <li><b>Inspect the crate before signing</b> the freight receipt. If you see damage, note it on the delivery paperwork and take photos — this protects your insurance claim.</li>
        <li>Business address with a loading dock/forklift usually ships fastest and cheapest.</li>
      </ul>
      Questions about fitment or delivery? <b>Message us any time</b> — we're happy to help before and after the sale. 🙌
    </div>`);
  }
  out.push(`<hr style="border:none;border-top:1px solid #ddd;margin:14px 0;">`);
  const shipLine = isFreightPart(p) ? `📦 Professionally crated &amp; shipped by freight from Porterville, California.` : `📦 <b>Fast shipping</b> from Porterville, California — carefully packed.`;
  out.push(`<p style="font-size:14px;line-height:1.6;margin:0;">${shipLine}<br>❓ Not 100% sure it fits? <b>Message us your VIN before buying</b> and we'll confirm the fit for you.<br>🙏 <b>Thank you for considering Legacy Motors Garage</b> — we genuinely appreciate your business and stand behind every part we sell!</p>`);
  return out.join("\n");
}

// 📦 Peso y dimensiones del paquete (aprox). Lee lo que estimó la IA en los specifics; si no, usa defaults.
function buildPackage(p){
  const is = (p.ebayDraft || {}).itemSpecifics || {};
  // Peso → siempre a LIBRAS (US)
  let lbs = 2;   // default razonable para una parte chica/mediana
  const wm = String(is["Item Weight"] || is["Weight"] || "").toLowerCase().match(/([\d.]+)\s*(kg|kilogram|g\b|gram|lb|lbs|pound|oz|ounce)/);
  if (wm) {
    let v = parseFloat(wm[1]); const u = wm[2];
    if (/kg|kilogram/.test(u)) lbs = v * 2.20462;
    else if (/^g\b|gram/.test(u)) lbs = v / 453.592;
    else if (/oz|ounce/.test(u)) lbs = v / 16;
    else lbs = v;
  }
  lbs = Math.max(0.3, +(lbs).toFixed(2));
  // Dimensiones → pulgadas (lee del specific si existe: acepta "54 mm / 2.13 in", cm, in)
  const dimOf = (name, def) => {
    const s = String(is[name] || "").match(/([\d.]+)\s*(mm|cm|in|inch)?/i);
    if (!s) return def;
    let v = parseFloat(s[1]); const u = (s[2] || "in").toLowerCase();
    if (/mm/.test(u)) v = v / 25.4; else if (/cm/.test(u)) v = v / 2.54;
    return Math.max(1, Math.round(v));
  };
  const dimensions = { length: dimOf("Item Length", 9), width: dimOf("Item Width", 7), height: dimOf("Item Height", 5), unit: "INCH" };
  return { weight: { value: lbs, unit: "POUND" }, dimensions };
}

// 💧 Marca de agua (logo discreto en la esquina) SOLO para las fotos del LISTING de eBay. Las originales del inventario NO se tocan.
// Cachea en Storage (wm/<hash>.jpg) → se procesa una vez por foto; si algo falla, usa la foto original (nunca rompe el anuncio).
const WM_LOGO_URL = "https://legacymotorsgarage.com/logo.png";
let _wmLogoBuf;
async function wmLogo(){ if (_wmLogoBuf !== undefined) return _wmLogoBuf; try { const r = await fetch(WM_LOGO_URL); _wmLogoBuf = r.ok ? Buffer.from(await r.arrayBuffer()) : null; } catch (e) { _wmLogoBuf = null; } return _wmLogoBuf; }
function wmTokenUrl(bucketName, key, token){ return "https://firebasestorage.googleapis.com/v0/b/" + bucketName + "/o/" + encodeURIComponent(key) + "?alt=media&token=" + token; }
// 🖼️ Convierte CUALQUIER HEIC/HEIF (o imagen) a JPG en el servidor con sharp (libheif).
// El navegador (heic2any) falla con ciertos HEIC del iPhone; las páginas llaman aquí por fetch como respaldo.
exports.heicConvert = onRequest({ cors: true, timeoutSeconds: 60, memory: "1GiB" }, async (req, res) => {
  try {
    if (req.method !== "POST") { res.status(405).send("POST only"); return; }
    const buf = (req.rawBody && req.rawBody.length) ? req.rawBody : (Buffer.isBuffer(req.body) ? req.body : null);
    if (!buf || !buf.length) { res.status(400).send("sin datos"); return; }
    // sharp NO decodifica HEIC (sin plugin HEVC por licencias) → usa heic-convert para decodificar HEIC a JPG,
    // y luego sharp SOLO para redimensionar/comprimir (sharp sí lee JPG).
    let jpgBuf = null, heicErr = "";
    try {
      const convert = require("heic-convert");
      jpgBuf = await convert({ buffer: buf, format: "JPEG", quality: 1 });
    } catch (he) {
      heicErr = (he && (he.stack || he.message)) || String(he);
    }
    try {
      const sharp = require("sharp");
      const out = await sharp(jpgBuf || buf, { failOn: "none" })
        .rotate()
        .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      res.set("Content-Type", "image/jpeg");
      res.set("Cache-Control", "no-store");
      res.status(200).send(out);
    } catch (se) {
      res.status(500).send("heic-convert_err=[" + (heicErr || "ok/converted") + "]  |  sharp_err=[" + ((se && se.message) || se) + "]");
    }
  } catch (e) {
    res.status(500).send("No se pudo convertir: " + ((e && e.message) || e));
  }
});

async function watermarkForListing(urls){
  let sharp, crypto;
  try { sharp = require("sharp"); crypto = require("crypto"); } catch (e) { return urls; }   // si no está la lib, deja las originales
  const bucket = admin.storage().bucket();
  const logoBuf = await wmLogo();
  const out = [];
  for (const url of urls) {
    if (!url) continue;
    try {
      const key = "wm/" + crypto.createHash("sha1").update(url).digest("hex") + ".jpg";
      const file = bucket.file(key);
      const [exists] = await file.exists();
      if (exists) {
        try { const [md] = await file.getMetadata(); const tk = md && md.metadata && md.metadata.firebaseStorageDownloadTokens; if (tk) { out.push(wmTokenUrl(bucket.name, key, String(tk).split(",")[0])); continue; } } catch (e) {}
      }
      const resp = await fetch(url); if (!resp.ok) throw new Error("fetch " + resp.status);
      const src = Buffer.from(await resp.arrayBuffer());
      const meta = await sharp(src).metadata();
      const targetW = Math.min(1600, meta.width || 1600);
      let img = sharp(src, { failOn: "none" }).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true });
      if (logoBuf) {
        const lw = Math.max(90, Math.round(targetW * 0.16));
        const logoR = await sharp(logoBuf).resize({ width: lw }).png().toBuffer();
        img = img.composite([{ input: logoR, gravity: "southeast" }]);
      }
      const buf = await img.jpeg({ quality: 82 }).toBuffer();
      const token = crypto.randomUUID();
      await file.save(buf, { contentType: "image/jpeg", resumable: false, metadata: { cacheControl: "public,max-age=31536000", metadata: { firebaseStorageDownloadTokens: token } } });
      out.push(wmTokenUrl(bucket.name, key, token));
    } catch (e) { out.push(url); }   // fallback: foto original
  }
  return out;
}
async function buildInventoryItem(p){
  const d = p.ebayDraft || {};
  const title = (d.title || p.ebayTitle || p.name || "Auto part").slice(0, 80);
  const { catId, catAck } = await resolveCategory(p);
  const vin = (p.vVin && String(p.vVin).trim()) ? String(p.vVin).trim() : await loadVehicleVin(p);   // artículo rápido guarda su VIN; carro normal se lee de dismantle_vehicles
  const desc = buildListingDescription(p, vin);   // descripción pro con formato
  const condDesc = ((d.conditionNote || d.description || "").trim()).slice(0, 990);   // campo aparte de eBay (máx 1000)
  const rawPics = (p.photoURLs || []).filter((u) => u && !/00_QR/.test(u)).slice(0, 24);
  const pics = await watermarkForListing(rawPics);   // 💧 con marca de agua para eBay
  const specs = await resolveSpecs(p, catId);
  const aspects = {};
  specs.forEach((s) => { aspects[s.name] = s.values; });
  const is = d.itemSpecifics || {};
  // eBay exige Brand + MPN en muchas categorías de auto partes (error 25002 BrandMPN si faltan).
  const mpn = (d.partNumbers && d.partNumbers[0]) || d.suggestedPartNumber || is["Manufacturer Part Number"] || is.MPN || "Does Not Apply";
  // Brand: la que diga el bot, si no la MARCA DEL CARRO (ej. Honda) — es parte OEM. Nunca dejamos Brand vacío.
  const carMake = await loadVehicleMake(p);
  const brand = is.Brand || d.brand || carMake || "Unbranded";
  const product = { title, description: desc, aspects, imageUrls: pics, brand, mpn };
  // También como item specifics (algunas categorías los quieren explícitos, con distintos nombres).
  if (!aspects.Brand) aspects.Brand = [brand];
  if (!aspects.MPN && !aspects["Manufacturer Part Number"]) aspects["Manufacturer Part Number"] = [mpn];
  const invItem = {
    availability: { shipToLocationAvailability: { quantity: 1 } },
    condition: ebayCondEnum(d.condition || p.condition),
    packageWeightAndSize: buildPackage(p),   // peso + dimensiones (aprox) para etiqueta/envío
    product,
  };
  if (condDesc) invItem.conditionDescription = condDesc;   // Condition description (campo separado de eBay)
  const sku = String(p.stickerNum || p.id);   // SKU = número de estampa (humano-legible, único por parte activa); respaldo al id interno
  return { sku, invItem, title, desc, catId, catAck, photos: pics.length, aspects: Object.keys(aspects).length };
}

// 📝 Crear BORRADOR en eBay (Inventory API: inventory item + oferta SIN publicar). No sale en vivo.
exports.ebayCreateDraft = onCall({ secrets: [EBAY_APP_ID, EBAY_CERT_ID, EBAY_OAUTH_REFRESH], timeoutSeconds: 240, memory: "1GiB" }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const p = await loadPart(request.data && request.data.partId);
  const priceUsd = request.data && request.data.priceUsd;
  try {
    const a = await ebayUserAccessToken();
    if (!a.token) return { ok: false, step: "token", errors: [(a.raw && a.raw.error_description) || "sin token"] };

    const cfgSnap = await admin.firestore().collection("config").doc("ebay").get();
    const cfg = cfgSnap.exists ? cfgSnap.data() : {};
    if (!cfg.fulfillmentPolicyId || !cfg.paymentPolicyId || !cfg.returnPolicyId || !cfg.locationKey) {
      return { ok: false, step: "setup", errors: ["Falta configurar la cuenta. Corre '⚙️ Configurar eBay' primero."] };
    }

    const b = await buildInventoryItem(p);
    const price = priceUsd ? Number(priceUsd).toFixed(2) : (((p.priceCents != null ? p.priceCents : 999) / 100)).toFixed(2);

    // 1) Inventory item (idempotente por SKU) — marketplace EBAY_MOTORS para autopartes
    let inv = await ebayRest("PUT", "/sell/inventory/v1/inventory_item/" + encodeURIComponent(b.sku), a.token, b.invItem, EBAY_MP);
    if (!inv.ok && b.invItem.packageWeightAndSize) {
      // eBay a veces truena (25001) por el peso/dimensiones → reintenta SIN eso para no bloquear
      const bodyNoPkg = Object.assign({}, b.invItem); delete bodyNoPkg.packageWeightAndSize;
      const inv2 = await ebayRest("PUT", "/sell/inventory/v1/inventory_item/" + encodeURIComponent(b.sku), a.token, bodyNoPkg, EBAY_MP);
      if (inv2.ok) inv = inv2;
    }
    if (!inv.ok) return { ok: false, step: "inventory_item", status: inv.status, errors: ebayRestErrors(inv) };

    // 2) Oferta SIN publicar = borrador. Reusa la oferta si ya existe para este SKU.
    // Primero: borra ofertas viejas del MISMO SKU en OTROS marketplaces (p.ej. EBAY_US de pruebas)
    // — si no, eBay bloquea Best Offer con "SKU en múltiples marketplaces" (25738).
    let offerId = "";
    const allOff = await ebayRest("GET", "/sell/inventory/v1/offer?sku=" + encodeURIComponent(b.sku), a.token, undefined, EBAY_MP);
    if (allOff.ok && allOff.json && allOff.json.offers) {
      for (const o of allOff.json.offers) {
        if (o.marketplaceId === EBAY_MP) { offerId = o.offerId; }
        else if (o.offerId && o.status !== "PUBLISHED") {
          await ebayRest("DELETE", "/sell/inventory/v1/offer/" + o.offerId, a.token, undefined, o.marketplaceId);
        }
      }
    }
    const offerBody = {
      sku: b.sku, marketplaceId: EBAY_MP, format: "FIXED_PRICE", availableQuantity: 1,
      categoryId: b.catId, listingDescription: b.desc,
      listingPolicies: {
        fulfillmentPolicyId: cfg.fulfillmentPolicyId, paymentPolicyId: cfg.paymentPolicyId, returnPolicyId: cfg.returnPolicyId,
        bestOfferTerms: { bestOfferEnabled: true },   // ✅ aceptar ofertas en todos los anuncios
      },
      pricingSummary: { price: { value: price, currency: "USD" } },
      merchantLocationKey: cfg.locationKey,
    };
    let offer;
    if (offerId) offer = await ebayRest("PUT", "/sell/inventory/v1/offer/" + offerId, a.token, offerBody, EBAY_MP);
    else offer = await ebayRest("POST", "/sell/inventory/v1/offer", a.token, offerBody, EBAY_MP);
    if (!offer.ok) return { ok: false, step: "offer", status: offer.status, errors: ebayRestErrors(offer) };
    if (!offerId) offerId = offer.json && offer.json.offerId;

    const upd = { ebayOfferId: offerId, ebayDraftCat: b.catId, ebayDraftAt: new Date().toISOString(), status: "borrador" };
    if (priceUsd) upd.priceCents = Math.round(Number(priceUsd) * 100);
    await admin.firestore().collection("parts").doc(p.id).update(upd);

    return { ok: true, offerId, categoryId: b.catId, categoryAck: b.catAck, title: b.title, price, photos: b.photos, aspects: b.aspects };
  } catch (e) {
    return { ok: false, step: "exception", errors: ["Error interno: " + (e && e.message ? e.message : String(e))] };
  }
});

// 🚀 Publicar la oferta EN VIVO (después de que la revisen). 1 clic → anuncio real.
exports.ebayPublishOffer = onCall({ secrets: [EBAY_APP_ID, EBAY_CERT_ID, EBAY_OAUTH_REFRESH], timeoutSeconds: 120 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const p = await loadPart(request.data && request.data.partId);
  try {
    let offerId = p.ebayOfferId;
    const a = await ebayUserAccessToken();
    if (!a.token) return { ok: false, step: "token", errors: [(a.raw && a.raw.error_description) || "sin token"] };
    if (!offerId) {
      const exist = await ebayRest("GET", "/sell/inventory/v1/offer?sku=" + encodeURIComponent(String(p.stickerNum || p.id)) + "&marketplace_id=" + EBAY_MP, a.token, undefined, EBAY_MP);
      if (exist.ok && exist.json && exist.json.offers && exist.json.offers.length) offerId = exist.json.offers[0].offerId;
    }
    if (!offerId) return { ok: false, step: "offer", errors: ["No hay borrador para esta parte. Crea el borrador primero."] };
    const r = await ebayRest("POST", "/sell/inventory/v1/offer/" + offerId + "/publish", a.token, undefined, EBAY_MP);
    if (!r.ok) return { ok: false, step: "publish", status: r.status, errors: ebayRestErrors(r) };
    const listingId = r.json && r.json.listingId;
    await admin.firestore().collection("parts").doc(p.id).update({
      ebayItemId: listingId || "", ebayListedAt: new Date().toISOString(), status: "publicado",
    });
    return { ok: true, listingId };
  } catch (e) {
    return { ok: false, step: "exception", errors: ["Error interno: " + (e && e.message ? e.message : String(e))] };
  }
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

// Pone un punto de caché tras la ÚLTIMA imagen → las fotos quedan cacheadas y se reusan
// en la 2ª pasada (llenado de specifics) a ~10% del costo. Evita pagar las fotos dos veces.
function withImgBreakpoint(images){
  return images.map((im, i) => (i === images.length - 1 ? Object.assign({}, im, { cache_control: { type: "ephemeral" } }) : im));
}

// 🤖 2ª pasada IA (barata, sin búsqueda web): llena los item specifics EXACTOS que eBay pide
// para ESA categoría, eligiendo de los valores permitidos. Reusa las fotos cacheadas.
async function aiFillAspects(client, model, images, ctx, aspects){
  const useful = (aspects || []).filter((a) => a.name && !/fitment|compatib|^fits/i.test(a.name)).slice(0, 40);
  if (!useful.length) return { specifics: {}, cost: 0 };
  const list = useful.map((a) => {
    const vals = (a.values && a.values.length) ? ` — pick one of: ${a.values.slice(0, 25).join(" | ")}` : "";
    return `- ${a.name}${a.required ? " (REQUIRED)" : ""}${vals}`;
  }).join("\n");
  const prompt = `Fill eBay Motors item specifics for this USED auto part.
Part: ${ctx.title}
Vehicle: ${ctx.veh}
Verified OEM/part numbers: ${ctx.numbers || "n/a"}
Interchange: ${ctx.interchange || "n/a"}
Condition: ${ctx.condition}

Fill AS MANY of these EXACT fields as you can, from the photos + your knowledge of this specific part. Rules:
- Where a field lists allowed values, you MUST copy one of them verbatim.
- ALWAYS fill "Manufacturer Part Number" and "OE/OEM Part Number" when a field with that name is listed, using the verified numbers above: "Manufacturer Part Number" = the part maker's own number (e.g. the number stamped on the part); "OE/OEM Part Number" = the vehicle-maker OEM number. If only one number is known, use it for both.
- Estimate weight/length/height/width ONLY if reasonable from the photos; otherwise omit.
- Do NOT include vehicle fitment/compatibility lists here.
- Prefer known facts over guesses; omit a field rather than invent.

FIELDS:
${list}

Return ONLY valid JSON: an object mapping each EXACT field name to a string value. Include only fields you can determine. Example: {"Material":"Plastic","Placement on Vehicle":"Front","Country/Region of Manufacture":"Japan","Connector Type":"5 Pin"}`;
  let text = "", usage = {};
  try {
    const msg = await client.messages.create({
      model, max_tokens: 1024,
      messages: [{ role: "user", content: [...withImgBreakpoint(images), { type: "text", text: prompt, cache_control: { type: "ephemeral" } }] }],
    });
    usage = msg.usage || {};
    text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  } catch (e) { return { specifics: {}, cost: 0, err: e.message }; }
  let obj = {};
  try { const m = text.match(/\{[\s\S]*\}/); obj = JSON.parse(m ? m[0] : text); } catch (e) {}
  const specifics = {};
  Object.keys(obj || {}).forEach((k) => {
    let v = obj[k];
    if (Array.isArray(v)) v = v[0];
    if (v != null && typeof v !== "object" && String(v).trim()) specifics[k] = String(v).trim().slice(0, 65);
  });
  const inTok = usage.input_tokens || 0, outTok = usage.output_tokens || 0, cw = usage.cache_creation_input_tokens || 0, cr = usage.cache_read_input_tokens || 0;
  const PRICES = { "claude-sonnet-5": { in: 3, out: 15 }, "claude-haiku-4-5": { in: 1, out: 5 } };
  const pr = PRICES[model] || PRICES["claude-sonnet-5"];
  const cost = +(((inTok / 1e6) * pr.in) + ((cw / 1e6) * pr.in * 1.25) + ((cr / 1e6) * pr.in * 0.10) + ((outTok / 1e6) * pr.out)).toFixed(5);
  return { specifics, cost, count: Object.keys(specifics).length };
}

// 🧠 Enseñarle al bot una regla PERMANENTE (aprende con cada corrección). action: add | list | del.
exports.teachBot = onCall({ timeoutSeconds: 20 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Inicia sesión.");
  const db = admin.firestore();
  const ref = db.collection("config").doc("aiRules");
  const bot = (request.data && request.data.bot) || "listing";
  const action = (request.data && request.data.action) || "add";
  const snap = await ref.get();
  const cur = (snap.exists && Array.isArray(snap.data()[bot])) ? snap.data()[bot] : [];
  if (action === "list") return { rules: cur };
  if (action === "del") {
    const id = request.data && request.data.id;
    const next = cur.filter((r) => r && r.id !== id);
    await ref.set({ [bot]: next }, { merge: true });
    return { ok: true, rules: next };
  }
  if (action === "add") {
    const text = (request.data && request.data.text ? String(request.data.text) : "").trim().slice(0, 300);
    if (!text) throw new HttpsError("invalid-argument", "Falta el texto de la regla.");
    if (cur.length >= 60) throw new HttpsError("failed-precondition", "Ya hay muchas reglas; borra alguna vieja primero.");
    const email = (request.auth.token && request.auth.token.email || "").toLowerCase();
    const id = "r" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    cur.push({ id, text, by: email, ts: new Date().toISOString() });
    await ref.set({ [bot]: cur }, { merge: true });
    return { ok: true, rules: cur };
  }
  throw new HttpsError("invalid-argument", "Acción no válida.");
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
  const urls = (p.photoURLs || []).filter((u) => u && !/00_QR/.test(u)).slice(0, 3);   // el bot lee las 3 primeras (1=pieza completa, 2-3=estampas/números). Muchas partes traen 2 estampas.
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
  const vinForPrompt = (p.vVin && String(p.vVin).trim()) ? String(p.vVin).trim() : await loadVehicleVin(p);   // el VIN del carro de donde salió la parte
  const liveFeedback = (request.data && request.data.feedback ? String(request.data.feedback) : "").trim().slice(0, 500);
  // 🧠 Corrección pegajosa: si no mandan una corrección nueva pero esta parte ya tenía una, la seguimos aplicando (no se olvida al regenerar).
  const stickyFeedback = (!liveFeedback && p.ebayDraft && p.ebayDraft.lastFeedback) ? String(p.ebayDraft.lastFeedback).slice(0, 500) : "";
  const feedback = liveFeedback || stickyFeedback;
  // Modelo (para comparar Sonnet vs Haiku) + modo "no guardar" (comparación no pisa el borrador bueno)
  const MODELS = { sonnet: "claude-sonnet-5", haiku: "claude-haiku-4-5" };
  const reqModel = (request.data && request.data.model) || "";
  const MODEL = MODELS[reqModel] || (Object.values(MODELS).indexOf(reqModel) >= 0 ? reqModel : "claude-sonnet-5");
  const doSave = !(request.data && request.data.save === false);
  let prompt = `You are an expert US used auto-parts lister for eBay Motors.
This exact part was PHYSICALLY REMOVED from this specific vehicle: "${veh || "a vehicle"}"${vinForPrompt ? ` (VIN: ${vinForPrompt})` : ""}. The seller pulled it off THIS car, so it is a CONFIRMED fit for this vehicle. TRUST this vehicle — it is correct.${vinForPrompt ? " If the stated year/make/model looks incomplete, DECODE the VIN to get the exact year, make, model and trim, and use that." : ""} ALWAYS build the title and the PRIMARY fitment around THIS exact ${veh ? "year/make/model" : "vehicle"}, and NEVER title it for a different vehicle.
The seller labeled it: "${p.name || ""}". Stated condition: "${p.condition || "Used"}".
STEP 1 — Read the photos carefully. Identify the part and read ALL numbers stamped/labeled on it. IGNORE connector pin numbers (e.g. "5 4 3 2 1" printed by the plug) — those are NOT part numbers.
STEP 2 — USE WEB SEARCH to ENRICH (never to replace the known vehicle): (a) find/verify the real OEM/manufacturer part number, (b) find INTERCHANGE / superseded numbers, and (c) find ADDITIONAL vehicles this part also fits — to widen buyers. Keep "${veh || "the known vehicle"}" as the PRIMARY confirmed fit. Only if the part number you READ clearly belongs to a completely different type of part, mention it in "fitmentNote" for the human to check — but STILL keep the title on "${veh || "the known vehicle"}".
STEP 2b — MANY PARTS HAVE NO READABLE NUMBER. When you cannot read a part number on the part, still DETERMINE the OEM number it SHOULD be: use web search with the vehicle (${veh || "the stated vehicle"}) + the part name + what you see in the photos to find the most likely correct OEM/manufacturer part number for THIS exact part on THIS vehicle. Put that in "suggestedPartNumber" (single best number) and briefly say how sure you are in "fitmentNote". If the exact number depends on trim/engine/options you cannot see, give the best candidate and say so — a strong lead the human will verify. Only leave it empty if you truly cannot narrow it down at all.
STEP 3 — Return ONLY valid JSON (no markdown, no backticks) with EXACTLY these keys:
{"title": "<=80 char keyword-rich eBay title. It MUST lead with the confirmed vehicle (${veh || "year make model"}) + the part, e.g. '${veh || "2013 Nissan Altima"} <Part> OEM <number>'. Use THIS known vehicle, never a guessed different one",
 "description": "2-3 punchy sentences selling THIS specific used OEM part: what it is, why it's a great genuine-OEM buy, and the VERIFIED fitment. Confident and professional, no generic filler. (A separate condition note and the fitment/number lists are added automatically after — do NOT list numbers here.)",
 "conditionNote": "2-3 honest sentences describing THIS exact used part's real condition and any visible wear, scuffs, or damage seen in the photos — this fills eBay's Condition Description field. Be specific and truthful.",
 "partNumbers": ["numbers you actually READ on the part; [] if none"],
 "suggestedPartNumber": "best OEM number this part SHOULD be (from web search) when none was readable; '' if you truly cannot determine one",
 "interchange": ["ALL interchange/alternate/superseded numbers found via web search — be thorough, more numbers = more buyers find it; [] if none"],
 "fitsVehicles": "list of vehicles it fits — START with the confirmed ${veh || "vehicle"}, then ADD other compatible vehicles found via web search",
 "fitmentNote": "" ,
 "ebayCategory": "the exact eBay Motors category for this part as a short phrase — the specific PART TYPE, e.g. 'Mass Air Flow Sensor', 'Fuel Injector', 'Headlight Assembly', 'Alternator' — so eBay's category search lands on the right Car & Truck Parts category, NOT a generic one. CRITICAL disambiguation: if the part is a piece of GLASS (windshield, door glass, quarter/vent glass, back/rear glass, sunroof glass), the phrase MUST contain the word 'Glass' (e.g. 'Exterior Door Glass', 'Quarter Glass', 'Rear Windshield') and must NEVER say just 'Window' — eBay maps 'Window' to window SWITCHES/REGULATORS, which is wrong for glass. Likewise: a side/rear-view MIRROR → 'Mirror'; a window MOTOR → 'Window Motor'; a window CRANK/REGULATOR → 'Window Regulator'. Pick the phrase for the ACTUAL physical part in the photos.",
 "freightItem": true or false — set TRUE ONLY if this is a COMPLETE engine (long block, short block, engine assembly) or a COMPLETE transmission/transaxle/gearbox that must ship by freight (LTL). Set FALSE for everything else, including small motors (window/blower/wiper/starter/fan motor) and small transmission parts (mount, solenoid, valve body, torque converter),
 "condition": "Used" | "For parts or not working" | "New",
 "itemSpecifics": {"Brand": "", "Manufacturer Part Number": "", "Type": "<what kind of part, e.g. Mass Air Flow Sensor>", "Placement on Vehicle": "", "Warranty": "", "Country/Region of Manufacture": "", "Superseded Part Number": ""},
 (fill as MANY itemSpecifics as you can from the photos and your knowledge — buyers filter by these; leave a value "" only if truly unknown)
 "confidence": "high" | "medium" | "low"}
Never invent a number you READ (partNumbers must be real reads). But suggestedPartNumber is EXPECTED to be a researched best-guess — provide it whenever you reasonably can. The stated vehicle is a CONFIRMED physical fit — ALWAYS keep it as the primary fit and in the title; only add a note in "fitmentNote" if something looks off. NEVER retitle the listing to a different vehicle than the one the part came from.`;

  // 🧠 REGLAS FIJAS que el equipo le ha ido enseñando al bot — SIEMPRE se aplican (aprendizaje acumulado nivel 1).
  try {
    const rSnap = await db.collection("config").doc("aiRules").get();
    const rules = (rSnap.exists && Array.isArray(rSnap.data().listing)) ? rSnap.data().listing : [];
    const texts = rules.map((r) => (r && r.text ? String(r.text) : "")).filter(Boolean);
    if (texts.length) {
      prompt += `\n\nHOUSE RULES — the Legacy team taught the bot these from real experience. ALWAYS obey them; they OVERRIDE the defaults above:\n` + texts.map((t) => "• " + t).join("\n");
    }
  } catch (e) { /* si falla la lectura de reglas, seguimos sin ellas */ }

  if (feedback) {
    prompt += `\n\nThe user REVIEWED a previous AI draft and gave this correction/instruction (in Spanish or English): "${feedback}". Apply it precisely — the user is the human expert who is looking at the real part. If the correction names or implies a different part type or eBay category (e.g. "es un vidrio", "it's glass, not a switch"), UPDATE "ebayCategory" accordingly.`;
    if (p.ebayDraft) prompt += `\nThe previous draft was: ${JSON.stringify({ title: p.ebayDraft.title, description: p.ebayDraft.description, partNumbers: p.ebayDraft.partNumbers })}.`;
  }

  const AnthropicMod = require("@anthropic-ai/sdk");
  const Anthropic = AnthropicMod.Anthropic || AnthropicMod.default || AnthropicMod;
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY.value() });

  let text = "", usage = {};
  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,   // subido de 2048: con VIN + fitment más rico el JSON crecía y se cortaba (salía borrador "simple")
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      // cache_control en el ÚLTIMO bloque → cachea fotos+prompt. Las búsquedas web re-leen ese prefijo
      // desde caché (~10% del costo) en vez de re-procesar las fotos cada vez. Baja mucho el gasto.
      messages: [{ role: "user", content: [...withImgBreakpoint(images), { type: "text", text: prompt, cache_control: { type: "ephemeral" } }] }],
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
    const stripFence = (s) => s.replace(/```+\s*json/gi, "").replace(/```+/g, "").trim();  // quita ```json … ```
    const tryParse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
    const cleaned = stripFence(text);
    draft = tryParse(cleaned)
         || (cleaned.match(/\{[\s\S]*\}/) && tryParse(cleaned.match(/\{[\s\S]*\}/)[0]))
         || (text.match(/\{[\s\S]*\}/) && tryParse(text.match(/\{[\s\S]*\}/)[0]));
    if (!draft) throw new Error("no-json");
  } catch (e) {
    // Nunca metemos el texto crudo (con ```json) a la descripción — mejor el nombre de la parte.
    draft = { title: (p.ebayTitle || p.name || ""), description: (p.name || ""), partNumbers: [], condition: p.condition || "Used", itemSpecifics: {}, confidence: "low", raw: text.slice(0, 800) };
  }
  draft.generatedAt = new Date().toISOString();
  draft.by = (request.auth.token && request.auth.token.email) || "";
  draft.model = MODEL;
  draft.tokens = { input: inTok, output: outTok, cacheWrite, cacheRead };
  draft.searches = searches;
  draft.costUsd = costUsd;   // costo estimado de ESTA generación (para el análisis de costos)
  if (feedback) draft.lastFeedback = feedback;

  // Resuelve la categoría de eBay Motors desde la frase que dio la IA (getCategorySuggestions + filtro Motors) y la guarda en el draft
  try { const c = await ebayCategorySuggest(draft.ebayCategory || draft.title || ""); if (c.id) { draft.ebayCategoryId = c.id; draft.ebayCategoryAck = c.ack; draft.ebayCategoryName = c.dbg || ""; } } catch (e) {}

  // 2ª pasada CONSCIENTE DE LA CATEGORÍA: trae los campos EXACTOS de esa categoría de eBay y los llena.
  // Reusa las fotos cacheadas (barato). Los valores verificados de la 1ª pasada (MPN, marca) mandan sobre estos.
  if (draft.ebayCategoryId) {
    try {
      const aspects = await ebayCategoryAspects(draft.ebayCategoryId);
      const ctx = {
        title: draft.title || p.name || "",
        veh,
        numbers: [...(draft.partNumbers || []), draft.suggestedPartNumber].filter(Boolean).join(", "),
        interchange: (draft.interchange || []).join(", "),
        condition: draft.condition || p.condition || "Used",
      };
      const filled = await aiFillAspects(client, MODEL, images, ctx, aspects);
      // Solo los valores CON contenido de la 1ª pasada mandan; los vacíos NO deben pisar lo que llenó la 2ª pasada
      const firstPass = {};
      Object.keys(draft.itemSpecifics || {}).forEach((k) => { const v = draft.itemSpecifics[k]; if (v != null && String(v).trim()) firstPass[k] = v; });
      draft.itemSpecifics = Object.assign({}, filled.specifics, firstPass);
      draft.aspectsFilled = Object.keys(draft.itemSpecifics).length;
      if (filled.cost) { draft.aspectFillCost = filled.cost; draft.costUsd = +((draft.costUsd || 0) + filled.cost).toFixed(5); }
    } catch (e) { /* si falla, se queda con los specifics de la 1ª pasada */ }
  }

  if (doSave) {
    await db.collection("parts").doc(partId).update({ ebayDraft: draft, ebayDraftAt: draft.generatedAt });
    // 🧮 Taxímetro ACUMULATIVO real: cada generación suma a un total que NUNCA baja (aunque regeneres).
    // (El costo por-parte se pisa al regenerar; esto lleva el gasto verdadero para auditar.)
    try {
      const ym = (draft.generatedAt || "").slice(0, 7).replace("-", "_");   // 2026_07
      const inc = admin.firestore.FieldValue.increment;
      await db.collection("config").doc("aiUsage").set({
        totalUsd: inc(draft.costUsd || 0), totalCount: inc(1),
        ["m_" + ym + "_usd"]: inc(draft.costUsd || 0), ["m_" + ym + "_count"]: inc(1),
        lastUsd: draft.costUsd || 0,   // costo de la ÚLTIMA generación (para "Última búsqueda")
        updatedAt: draft.generatedAt,
      }, { merge: true });
    } catch (e) { /* el taxímetro es informativo; no romper la generación por esto */ }
  }
  return draft;
});
