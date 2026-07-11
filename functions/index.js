// Legacy DMS — backend (Cloud Functions)
// Primera prueba: confirmar que el servidor despliega y responde antes de tocar pagos.
const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");

exports.hello = onRequest({ region: "us-central1", cors: true }, (req, res) => {
  logger.info("hello ping ok");
  res.json({
    ok: true,
    msg: "Legacy DMS backend está vivo 🚗",
    time: new Date().toISOString()
  });
});
