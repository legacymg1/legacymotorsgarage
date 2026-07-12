// Legacy DMS — backend (Cloud Functions)
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");

const VALOR_APPID = defineSecret("VALOR_APPID");
const VALOR_APPKEY = defineSecret("VALOR_APPKEY");
const VALOR_EPI = defineSecret("VALOR_EPI");

// SANDBOX / staging de Valor (NO producción todavía)
const VALOR_BASE = "https://securelink-staging.valorpaytech.com:4430";

exports.hello = onRequest({ region: "us-central1", cors: true }, (req, res) => {
  res.json({ ok: true, msg: "Legacy DMS backend está vivo 🚗", time: new Date().toISOString() });
});

// Fase 1: pide un Client Token a Valor. La APP Key vive como secreto, jamás sale al cliente.
exports.getClientToken = onRequest(
  { region: "us-central1", cors: true, secrets: [VALOR_APPID, VALOR_APPKEY, VALOR_EPI] },
  async (req, res) => {
    try {
      const payload = {
        appid: VALOR_APPID.value(),
        appkey: VALOR_APPKEY.value(),
        epi: VALOR_EPI.value(),
        txn_type: "sale"
      };
      const r = await fetch(VALOR_BASE + "/?saleapi=", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      const txt = await r.text();
      let data; try { data = JSON.parse(txt); } catch (e) { data = { raw: txt }; }
      if (data && data.clientToken) {
        res.json({ ok: true, clientToken: data.clientToken, validity: data.validity || null });
      } else {
        logger.warn("Valor token inesperado", { status: r.status, data });
        res.status(400).json({ ok: false, error: (data && (data.error_no || data.error_code)) || "sin token", detail: data });
      }
    } catch (e) {
      logger.error("getClientToken error", e);
      res.status(500).json({ ok: false, error: String((e && e.message) || e) });
    }
  }
);
