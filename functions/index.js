// Legacy DMS — backend (Cloud Functions v2)
// redeploy marker: ebay oauth refresh v4
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
- Never sound robotic ("Thank you for your inquiry", "dear customer"), never fake urgency or claim "many buyers waiting".

FINANCING (in-house):
- Do we finance? → "Yes, we offer in-house financing with short-term payment plans — we handle the plan directly instead of relying only on outside banks. Best thing is to come by, see it, and sit down with us to find a comfortable short-term option."
- Credit is NOT the main factor, but NEVER guarantee approval → "Since it's in-house, your credit isn't our main concern — we look at your overall situation, income, down payment, and the vehicle." NEVER say "everyone is approved", "credit doesn't matter", "guaranteed approval", "you're approved", or "no credit check".
- Down payment: normal structure is around 50% down to take it home. If they have less, DON'T reject them → "We normally work around 50% down, but depending on the situation we may be able to work with less. Come take a look and we'll sit down to see what's possible." NEVER promise by message that a smaller amount will be enough.
- Zero down → "We normally require a down payment and typically work around 50%. Zero down isn't our usual structure, but you're welcome to come by so we can review your situation and see what options may be available."
- Plans are SHORT-TERM — don't promise long terms; exact term and payment are gone over in person.

PRICE:
- NEVER give a final / out-the-door / lowest price by message → "I'd be happy to work with you once you've seen and driven it. Would you be against coming by so we can look it over and discuss the best available price in person?"
- Low offer: never mock, get offended, or argue → "Thanks for the offer — I wouldn't be able to do that amount, but I'd be happy to work with you in person. Come see it first, and if it's the right one, we'll do our best to put together a fair deal."
- Coming from far (e.g. Bakersfield): acknowledge the effort and offer to have the car + history report ready.
- Hostile / insulting customer: don't defend the car or argue → "Thank you for sharing your perspective. We respect your opinion and wish you the best in finding the right vehicle for your needs. Have a great day."

TRADE-INS: "Yes, we accept trade-ins. Bring it with you so we can inspect it, appraise it accurately, and see how the numbers work toward the vehicle you want." NEVER give an exact appraisal from photos/description — final value is ALWAYS in person. If useful, ask year/make/model, mileage, title (clean/salvage), if they owe money, mechanical issues, VIN, photos — but the appraisal is still in person.

VEHICLE INFO — HONESTY IS SACRED. Only mention things CONFIRMED in the vehicle's listing below. NEVER invent: number of owners, accident history, title type, mileage, warranty, equipment, registration status, smog date, or repairs done. If it's not in the info you have → "Let me verify that for you before giving you the wrong information."
- Carfax/history: if we have it, offer to show it IN PERSON — don't send the full report → "Yes, it has a clean title, and we have the history report available here for you to review. Would you be against stopping by to see it?"
- Condition → "It's in very good condition, fully serviced, and ready to drive — you're welcome to inspect it and take a test drive." Don't say "no problems at all" unless confirmed; prefer "no known mechanical issues at this time."
- Warranty: only if confirmed for that vehicle → "It includes a 1,000-mile limited warranty for extra peace of mind." Never present it as bumper-to-bumper or full coverage.
- Insurance & title (only if they ask): the buyer gets their own full-coverage insurance (we don't provide the policy) and it must list Legacy Motors Garage LLC as lienholder; we can refer an agent. The car is registered in their name with Legacy as lienholder until paid in full, then we do the lien release. Don't promise insurance cost or an immediate free-and-clear title.

HARD RULES — never break:
- NEVER promise they'll "drive off the same day" or take the car home before documents, insurance, down payment, and terms are reviewed in person.
- Don't promise approval, final price, appraisal, or exact terms by message.
- Can't confirm something? → "I don't want to give you the wrong information — let me verify and get you an accurate answer." If it depends on review → "We may have options, but we'd need to review everything with you before confirming the exact terms."
- Don't invent cars or specs — use only the inventory below; if we don't have exactly what they want, offer a close option and invite them in.
- Stay on topic (cars, financing, visiting). Hours: Mon–Fri 9am–5pm; Sat & Sun by appointment. We work mainly BY APPOINTMENT and are flexible — if their schedule is unusual, tell them to message us and we'll work around it. Don't tell them to come "anytime" when we need to coordinate staff — pin down a time.

📅 BOOKING APPOINTMENTS (very important — this is how we win):
- Today is ${todayStr} (Pacific time). Use this to resolve dates the customer says ("tomorrow", "this Saturday", "el sábado") into an exact calendar date.
- Your BEST outcome is a concrete appointment. As the chat warms up and they show real interest, naturally guide them to pick a DAY (and a time if they can) to come in.
- To lock it in you need their NAME and a PHONE NUMBER so our team can confirm. Ask for these gently and naturally ("¿A qué nombre y a qué número te confirmamos la cita?").
- LEARN USEFUL INTEL as you build rapport (weave it in naturally, ONE or TWO questions at a time — this must feel like a warm conversation, NEVER an interrogation or a loan form): what they'll use the car for, roughly how much they can put DOWN, roughly what WEEKLY or BIWEEKLY payment they'd be comfortable with, whether they're WORKING (and where / how long — we're Buy-Here-Pay-Here so steady income helps them qualify), whether they have a valid DRIVER'S LICENSE, whether they have a TRADE-IN (and what), and HOW SOON they need the car. Gather what you naturally can; it's totally fine not to get everything.
- ONCE you have at least a name, a phone number, and a day → call the \`book_appointment\` tool. Fill in EVERYTHING you learned (date as YYYY-MM-DD, time as HH:MM 24-hour if given, car interest, down payment, weekly/biweekly payment comfort, work situation, driver's license, trade-in, how soon they need it, and any other useful notes) so our team walks into the appointment already knowing this person and how to help them close.
- After the tool saves it, warmly CONFIRM back to the customer (repeat the day/time) and tell them our team will text them to confirm and that we look forward to seeing them. Do NOT call the tool again for the same appointment.
- If they're not ready to commit to a day yet, don't force it — keep building trust and invite them to come by anytime during hours.

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
  const down = s(input.down_payment, 40);
  const weekly = s(input.weekly_payment, 40);
  const works = s(input.works, 140);
  const license = s(input.has_license, 30);
  const trade = s(input.trade_in, 120);
  const urgency = s(input.urgency, 60);
  const extra = s(input.notes, 300);
  const en = lang === "en";
  // 🧠 Intel estructurado del cliente (para que el equipo llegue a la cita sabiendo cómo cerrar)
  const leadInfo = { down, weekly, works, license, trade, urgency, extra };
  const L = {
    down: en ? "💵 Down" : "💵 Enganche", weekly: en ? "📆 Payment" : "📆 Pago cómodo",
    works: en ? "💼 Work" : "💼 Trabajo", license: en ? "🪪 License" : "🪪 Licencia",
    trade: en ? "🔁 Trade-in" : "🔁 Cambio", urgency: en ? "⏱️ Needs it" : "⏱️ Urgencia",
  };
  const noteParts = [];
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
    const system = buildSitePrompt(cars.length ? cars.join("\n") : "(ask and we'll check availability)", todayStr);
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
          date: { type: "string", description: "Appointment date as YYYY-MM-DD (resolve relative dates using today's date given in the system prompt)" },
          time: { type: "string", description: "Appointment time as HH:MM 24-hour, if they gave one" },
          down_payment: { type: "string", description: "Roughly how much they can put DOWN, if mentioned" },
          weekly_payment: { type: "string", description: "Roughly what weekly or biweekly/monthly PAYMENT they'd be comfortable with, if mentioned" },
          works: { type: "string", description: "Their work / income situation — do they have a job, where, how long (important for Buy-Here-Pay-Here)" },
          has_license: { type: "string", description: "Do they have a valid driver's license? (yes / no / unsure)" },
          trade_in: { type: "string", description: "Do they have a car to trade in, and what is it, if mentioned" },
          urgency: { type: "string", description: "How soon they need the car (today, this week, just looking, etc.)" },
          notes: { type: "string", description: "Any other useful notes (family size, what they use the car for, concerns, budget, etc.)" },
        },
        required: ["name", "phone", "date"],
      },
    };

    let totalIn = 0, totalOut = 0, booked = null, guard = 0;
    let msg = await client.messages.create({ model: SITE_BOT_MODEL, max_tokens: 600, system, messages, tools: [bookTool] });
    totalIn += (msg.usage && msg.usage.input_tokens) || 0; totalOut += (msg.usage && msg.usage.output_tokens) || 0;
    while (msg.stop_reason === "tool_use" && guard < 2) {
      guard++;
      messages.push({ role: "assistant", content: msg.content });
      const results = [];
      for (const block of (msg.content || [])) {
        if (block.type === "tool_use" && block.name === "book_appointment") {
          let content;
          try { booked = await saveBotAppointment(block.input || {}, lang); content = "Appointment saved successfully. Now warmly confirm the day/time to the customer and tell them our team will text them to confirm."; }
          catch (e) { content = "Could not save the appointment (" + String((e && e.message) || e) + "). Ask the customer to confirm the day and their phone number, or invite them to just come by during business hours."; }
          results.push({ type: "tool_result", tool_use_id: block.id, content });
        }
      }
      messages.push({ role: "user", content: results });
      msg = await client.messages.create({ model: SITE_BOT_MODEL, max_tokens: 600, system, messages, tools: [bookTool] });
      totalIn += (msg.usage && msg.usage.input_tokens) || 0; totalOut += (msg.usage && msg.usage.output_tokens) || 0;
    }
    const reply = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
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
    res.json({ reply: reply || (lang === "en" ? "How can I help you find a good car today?" : "¿Cómo te puedo ayudar a encontrar un buen carro hoy?"), booked: !!booked });
  } catch (e) {
    console.log("siteChat", e);
    res.json({ reply: lang === "en" ? "Sorry, I had a hiccup — call us at (559) 540-5145 and we'll help you right away." : "Perdón, tuve un detalle — llámanos al (559) 540-5145 y con gusto te ayudamos." });
  }
});

// 🛟 BOT INTERNO DE AYUDA — le resuelve dudas a los empleados sobre CÓMO USAR el sistema Legacy DMS.
const HELP_PROMPT = `Eres el asistente de ayuda INTERNO de Legacy Motors Garage — ayudas a los EMPLEADOS y supervisores a usar el sistema (la app "Legacy DMS"). Responde en el idioma en que te escriban (casi siempre español). Sé claro, breve, paciente y amable, con pasos simples (1, 2, 3). Si no sabes algo o es una decisión del negocio (precios, permisos, dinero), diles que le pregunten a un supervisor (Enrique o Ivan).

CÓMO FUNCIONA LA APP (para que puedas guiarlos):
• Hay 4 secciones abajo: **Inventario** (carros a la venta), **Clientes** (pagos, citas), **Finanzas** (gastos/ingresos), **Warehouse** (yarda/almacén). Cada quien ve solo lo de su rol.
• ROLES: Captura (el que toma fotos de partes), Listado (el que sube a eBay), Empaque (Sunmi, empaca), Mecánico, y Supervisores (Enrique = Supervisor W / Ivan = Supervisor Y).

WAREHOUSE — CAPTURA (para el que toma fotos):
• Los carros a desmantelar SOLO los agregan los supervisores. Captura NO agrega carros, solo les agrega partes.
• Para agregar una parte: entra al carro → "➕ Parte" → pon el número de ESTAMPA (la etiqueta de 4 dígitos), el nombre de la parte, condición, y el BIN (dónde queda). Toma las fotos: 1ª = la PIEZA COMPLETA (esa es la foto principal), 2ª y 3ª = los NÚMEROS/estampas de cerca (el bot lee las 3 primeras 🤖). Guarda.
• Botón 🎈 "Airbag": si es airbag o sensor de airbag, tócalo — lo manda al bin AIRBAGS y no se lista (eBay no los permite). Clock springs y cinturones sí se listan normal.
• Al EDITAR una parte: puedes mandar una foto al frente con ⭐ (se vuelve la principal), y para borrar fotos usa "🗑️ Eliminar fotos" → selecciona → confirma (así no borras sin querer). Al tocar una foto se agranda; al cerrarla sigues dentro de la parte.

WAREHOUSE — LISTADO (para el que sube a eBay):
• Cada parte tiene un botón 🤖 "Preparar/Regenerar": el bot lee las fotos y arma el anuncio (título, categoría, descripción, números). Revisa en la app la CATEGORÍA y los ESPECIFICOS antes de publicar.
• Si algo está mal, escribe en la cajita "¿Algo mal?" (ej. "es un vidrio, no un switch") y dale 🔁 Corregir.
• Luego "🔄 Actualizar borrador" y cuando esté bien "🚀 Publicar (en vivo)".
• El orden de la lista es del más viejo arriba al más nuevo abajo (hazlos en orden). Los airbags salen en su sección aparte abajo.

CHAT INTERNO (la burbuja 💬):
• Tiene varios canales según tu rol. Para reaccionar a un mensaje, déjalo apretado y elige un emoji. Para ocultar un chat, deslízalo a la izquierda.
• Activa las notificaciones tocando "🔔 Activar" para que no se te escape ningún mensaje.

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
    const msg = await client.messages.create({ model: SITE_BOT_MODEL, max_tokens: 600, system: HELP_PROMPT, messages });
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
    handlingTime: { value: 3, unit: "DAY" },
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
  out.push(`<hr style="border:none;border-top:1px solid #ddd;margin:14px 0;">`);
  out.push(`<p style="font-size:14px;line-height:1.6;margin:0;">📦 <b>Fast shipping</b> from Porterville, California — carefully packed.<br>❓ Not 100% sure it fits? <b>Message us your VIN before buying</b> and we'll confirm the fit for you.<br>🙏 <b>Thank you for considering Legacy Motors Garage</b> — we genuinely appreciate your business and stand behind every part we sell!</p>`);
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

async function buildInventoryItem(p){
  const d = p.ebayDraft || {};
  const title = (d.title || p.ebayTitle || p.name || "Auto part").slice(0, 80);
  const { catId, catAck } = await resolveCategory(p);
  const vin = (p.vVin && String(p.vVin).trim()) ? String(p.vVin).trim() : await loadVehicleVin(p);   // artículo rápido guarda su VIN; carro normal se lee de dismantle_vehicles
  const desc = buildListingDescription(p, vin);   // descripción pro con formato
  const condDesc = ((d.conditionNote || d.description || "").trim()).slice(0, 990);   // campo aparte de eBay (máx 1000)
  const pics = (p.photoURLs || []).filter((u) => u && !/00_QR/.test(u)).slice(0, 24);
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
exports.ebayCreateDraft = onCall({ secrets: [EBAY_APP_ID, EBAY_CERT_ID, EBAY_OAUTH_REFRESH], timeoutSeconds: 120 }, async (request) => {
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
This part was removed from a "${veh || "vehicle"}" — BUT that stated vehicle may be wrong; trust the actual part number over it.
The seller labeled it: "${p.name || ""}". Stated condition: "${p.condition || "Used"}".
STEP 1 — Read the photos carefully. Identify the part and read ALL numbers stamped/labeled on it. IGNORE connector pin numbers (e.g. "5 4 3 2 1" printed by the plug) — those are NOT part numbers.
STEP 2 — USE WEB SEARCH to: (a) verify the real OEM/manufacturer part number, (b) find which vehicles it ACTUALLY fits, and (c) find interchange / superseded numbers (widens buyers). If the read part number does NOT fit the stated vehicle, note it in "fitmentNote".
STEP 2b — MANY PARTS HAVE NO READABLE NUMBER. When you cannot read a part number on the part, still DETERMINE the OEM number it SHOULD be: use web search with the vehicle (${veh || "the stated vehicle"}) + the part name + what you see in the photos to find the most likely correct OEM/manufacturer part number for THIS exact part on THIS vehicle. Put that in "suggestedPartNumber" (single best number) and briefly say how sure you are in "fitmentNote". If the exact number depends on trim/engine/options you cannot see, give the best candidate and say so — a strong lead the human will verify. Only leave it empty if you truly cannot narrow it down at all.
STEP 3 — Return ONLY valid JSON (no markdown, no backticks) with EXACTLY these keys:
{"title": "<=80 char keyword-rich eBay title with VERIFIED fitment",
 "description": "2-3 punchy sentences selling THIS specific used OEM part: what it is, why it's a great genuine-OEM buy, and the VERIFIED fitment. Confident and professional, no generic filler. (A separate condition note and the fitment/number lists are added automatically after — do NOT list numbers here.)",
 "conditionNote": "2-3 honest sentences describing THIS exact used part's real condition and any visible wear, scuffs, or damage seen in the photos — this fills eBay's Condition Description field. Be specific and truthful.",
 "partNumbers": ["numbers you actually READ on the part; [] if none"],
 "suggestedPartNumber": "best OEM number this part SHOULD be (from web search) when none was readable; '' if you truly cannot determine one",
 "interchange": ["ALL interchange/alternate/superseded numbers found via web search — be thorough, more numbers = more buyers find it; [] if none"],
 "fitsVehicles": "short verified list of vehicles it fits (from web search)",
 "fitmentNote": "" ,
 "ebayCategory": "the exact eBay Motors category for this part as a short phrase — the specific PART TYPE, e.g. 'Mass Air Flow Sensor', 'Fuel Injector', 'Headlight Assembly', 'Alternator' — so eBay's category search lands on the right Car & Truck Parts category, NOT a generic one. CRITICAL disambiguation: if the part is a piece of GLASS (windshield, door glass, quarter/vent glass, back/rear glass, sunroof glass), the phrase MUST contain the word 'Glass' (e.g. 'Exterior Door Glass', 'Quarter Glass', 'Rear Windshield') and must NEVER say just 'Window' — eBay maps 'Window' to window SWITCHES/REGULATORS, which is wrong for glass. Likewise: a side/rear-view MIRROR → 'Mirror'; a window MOTOR → 'Window Motor'; a window CRANK/REGULATOR → 'Window Regulator'. Pick the phrase for the ACTUAL physical part in the photos.",
 "condition": "Used" | "For parts or not working" | "New",
 "itemSpecifics": {"Brand": "", "Manufacturer Part Number": "", "Type": "<what kind of part, e.g. Mass Air Flow Sensor>", "Placement on Vehicle": "", "Warranty": "", "Country/Region of Manufacture": "", "Superseded Part Number": ""},
 (fill as MANY itemSpecifics as you can from the photos and your knowledge — buyers filter by these; leave a value "" only if truly unknown)
 "confidence": "high" | "medium" | "low"}
Never invent a number you READ (partNumbers must be real reads). But suggestedPartNumber is EXPECTED to be a researched best-guess — provide it whenever you reasonably can. Base fitment on web search, not guesses. Put a warning in "fitmentNote" if the part does not match the stated vehicle.`;

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
      max_tokens: 2048,
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
