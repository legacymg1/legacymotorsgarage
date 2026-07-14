const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const VALOR_APPID = defineSecret("VALOR_APPID");
const VALOR_APPKEY = defineSecret("VALOR_APPKEY");
const VALOR_EPI = defineSecret("VALOR_EPI");
const BASES = { sandbox:"https://securelink-staging.valorpaytech.com:4430", production:"https://securelink.valorpaytech.com:4430" };

exports.hello = onRequest({ region:"us-central1", cors:true }, (req,res)=>{
  res.json({ ok:true, msg:"Legacy DMS backend está vivo 🚗", time:new Date().toISOString() });
});

// Flexible para diagnosticar: ?mode= ?path= ?txn= ?method=
exports.getClientToken = onRequest(
  { region:"us-central1", cors:true, secrets:[VALOR_APPID,VALOR_APPKEY,VALOR_EPI] },
  async (req,res)=>{
    const mode = (req.query.mode==="sandbox")?"sandbox":"production";
    const base = BASES[mode];
    const path = req.query.path || "/";          // ej: /  ó /?saleapi=
    const txn  = req.query.txn  || "sale";        // 'none' para omitir
    const method = (req.query.method || "POST").toUpperCase();
    try {
      const p = new URLSearchParams();
      p.set("appid", VALOR_APPID.value());
      p.set("appkey", VALOR_APPKEY.value());
      p.set("epi", VALOR_EPI.value());
      if(txn !== "none") p.set("txn_type", txn);
      const url = base + path + (path.includes("?") ? "&" : "?") + p.toString();
      const r = await fetch(url, { method, headers:{ accept:"application/json" } });
      const txt = await r.text();
      let data; try{ data=JSON.parse(txt); }catch(e){ data={ raw: txt.slice(0,400) }; }
      const ok = !!(data && data.clientToken);
      res.status(ok?200:400).json({ ok, mode, tried:{path,txn,method}, clientToken:(data&&data.clientToken)||null, detail:data });
    } catch(e){ res.status(500).json({ ok:false, error:String((e&&e.message)||e) }); }
  }
);
