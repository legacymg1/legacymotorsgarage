// Legacy DMS — backend (Cloud Functions)
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");

const VALOR_APPID = defineSecret("VALOR_APPID");
const VALOR_APPKEY = defineSecret("VALOR_APPKEY");
const VALOR_EPI = defineSecret("VALOR_EPI");

// Bases de Valor. Diagnóstico: probamos producción (solo para PEDIR TOKEN, no cobra).
const BASES = {
  sandbox: "https://securelink-staging.valorpaytech.com:4430",
  production: "https://securelink.valorpaytech.com:4430"
};

exports.hello = onRequest({ region: "us-central1", cors: true }, (req, res) => {
  res.json({ ok: true, msg: "Legacy DMS backend está vivo 🚗", time: new Date().toISOString() });
});

exports.getClientToken = onRequest(
  { region: "us-central1", cors: true, secrets: [VALOR_APPID, VALOR_APPKEY, VALOR_EPI] },
  async (req, res) => {
    const mode = (req.query.mode === "production") ? "production" : "sandbox";
    const base = BASES[mode];
    try {
      const payload = {
        appid: VALOR_APPID.value(),
        appkey: VALOR_APPKEY.value(),
        epi: VALOR_EPI.value(),
        txn_type: "sale"
      };
      const r = await fetch(base + "/?saleapi=", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      const txt = await r.text();
      let data; try { data = JSON.parse(txt); } catch (e) { data = { raw: txt }; }
      if (data && data.clientToken) {
        res.json({ ok: true, mode, clientToken: data.clientToken, validity: data.validity || null });
      } else {
        logger.warn("Valor token inesperado", { mode, status: r.status, data });
        res.status(400).json({ ok: false, mode, error: (data && (data.error_no || data.error_code)) || "sin token", detail: data });
      }
    } catch (e) {
      logger.error("getClientToken error", e);
      res.status(500).json({ ok: false, mode, error: String((e && e.message) || e) });
    }
  }
);
