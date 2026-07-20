// Legacy DMS — backend (Cloud Functions v2)
const { onCall } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();
setGlobalOptions({ region: "us-central1", maxInstances: 10 });

// Prueba: confirma que el backend está vivo y desplegándose solo.
exports.ping = onCall((request) => {
  return {
    ok: true,
    msg: "backend vivo 🚀",
    at: new Date().toISOString(),
    uid: request.auth ? request.auth.uid : null,
  };
});
