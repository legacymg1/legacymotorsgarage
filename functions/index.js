// Legacy DMS — backend (Cloud Functions)
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");

const VALOR_APPID = defineSecret("VALOR_APPID");
const VALOR_APPKEY = defineSecret("VALOR_APPKEY");
const VALOR_EPI = defineSecret("VALOR_EPI");

const BASES = {
  sandbox: "https://securelink-staging.valorpaytech.com:4430",
  production: "https://securelink.valorpaytech.com:4430"
};

exports.hello = onRequest({ region: "us-central1", cors: true }, (req, res) => {
  res.json({ ok: true, msg: "Legacy DMS backend está vivo 🚗", time: new Date().toISOString() });
});

// Fase 1: pide un Client Token a Valor. Los parámetros van en el QUERY STRING (no en el body).
exports.getClientToken = onRequest(
  { region: "us-central1", cors: true, secrets: [VALOR_APPID, VALOR_APPKEY, VALOR_EPI] },
  async (req, res) => {
    const mode = (req.query.mode === "sandbox") ? "sandbox" : "production";
    const base = BASES[mode];
    try {
      const params = new URLSearchParams();
      params.set("appid", VALOR_APPID.value());
      params.set("appkey", VALOR_APPKEY.value());
      params.set("epi", VALOR_EPI.value());
      params.set("txn_type", "sale");
      const url = base + "/?" + params.toString();
      const r = await fetch(url, { method: "POST", headers: { accept: "application/json" } });
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
