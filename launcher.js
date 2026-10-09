// ===== Legacy Launcher — menú único para brincar entre apps (solo dueños) =====
// Se incluye con: <script type="module" src="launcher.js"></script>
// Reconoce al dueño por su sesión de correo (compartida en el dominio) y pinta
// un botón-logo flotante que abre un menú de burbujas hacia cada sección.
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const CFG = {
  apiKey: "AIzaSyDrCMJQclGosVp3EV49vmwKDnji-Oti5j0",
  authDomain: "legacy-motors-garage.firebaseapp.com",
  projectId: "legacy-motors-garage",
  storageBucket: "legacy-motors-garage.firebasestorage.app",
  messagingSenderId: "783567672493",
  appId: "1:783567672493:web:3a825f2f59ec1c25e9a224"
};
const OWNERS = ["ev@legacymotorsgarage.com", "ivan.garcia@legacymotorsgarage.com"];
const EV = "ev@legacymotorsgarage.com";
const SECTIONS = [
  { k:"index",        label:"Inventario",   ico:"🚗", href:"index.html" },
  { k:"admin",        label:"Clientes",     ico:"👥", href:"admin.html" },
  { k:"finanzas",     label:"Finanzas",     ico:"💰", href:"finanzas.html" },
  // 🔒 PERSONAL de Enrique — datos privados y delicados. SOLO ev@ la ve en el menú.
  { k:"mis-finanzas", label:"Mis Finanzas", ico:"📊", href:"mis-finanzas.html", only: EV },
  { k:"empleado",     label:"Pit Crew",     ico:"🏁", href:"empleado.html" },
  { k:"warehouse",    label:"Almacén",      ico:"📦", href:"warehouse.html" },
];

// Reusa la app de Firebase de la página si ya existe (evita doble init).
let app; try { app = getApps().length ? getApp() : initializeApp(CFG, "legacy-launcher"); }
catch (e) { try { app = initializeApp(CFG, "legacy-launcher-" + Date.now()); } catch (_) { app = null; } }
if (app) {
  const auth = getAuth(app);
  onAuthStateChanged(auth, (user) => {
    const email = ((user && user.email) || "").toLowerCase();
    if (email && OWNERS.includes(email)) mount(email); else unmount();
  });
}

function currentKey(){
  const p = (location.pathname.split("/").pop() || "index.html").toLowerCase();
  const f = p || "index.html";
  const hit = SECTIONS.find(s => f === s.href || (f === "" && s.k === "index"));
  return hit ? hit.k : "index";
}

function unmount(){ const b=document.getElementById("lmg-launch-btn"); if(b) b.remove(); const o=document.getElementById("lmg-launch-ov"); if(o) o.remove(); }

function mount(email){
  if (document.getElementById("lmg-launch-btn")) return;
  const secs = SECTIONS.filter(s => !s.only || s.only === email);
  const style = document.createElement("style");
  style.id = "lmg-launch-style";
  style.textContent = `
    #lmg-launch-btn{position:fixed;bottom:calc(16px + env(safe-area-inset-bottom,0px));left:14px;z-index:2147483000;
      width:46px;height:46px;border-radius:14px;border:1px solid rgba(232,182,74,0.55);
      background:rgba(14,18,26,0.72);backdrop-filter:blur(10px) saturate(1.3);-webkit-backdrop-filter:blur(10px) saturate(1.3);
      color:#e8b64a;font-weight:900;font-size:19px;letter-spacing:-0.03em;cursor:pointer;
      display:flex;align-items:center;justify-content:center;box-shadow:0 6px 22px rgba(0,0,0,0.45);
      font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display",system-ui,sans-serif;transition:transform .12s ease;}
    #lmg-launch-btn:active{transform:scale(.92);}
    #lmg-launch-ov{position:fixed;inset:0;z-index:2147483001;display:none;align-items:center;justify-content:center;
      background:rgba(6,9,14,0.62);backdrop-filter:blur(16px) saturate(1.2);-webkit-backdrop-filter:blur(16px) saturate(1.2);
      padding:max(26px,env(safe-area-inset-top,0px)) 22px calc(26px + env(safe-area-inset-bottom,0px));
      font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display",system-ui,sans-serif;}
    #lmg-launch-ov.open{display:flex;}
    .lmg-sheet{width:100%;max-width:440px;text-align:center;animation:lmgIn .22s ease;}
    @keyframes lmgIn{from{opacity:0;transform:translateY(10px) scale(.98);}to{opacity:1;transform:none;}}
    @media (prefers-reduced-motion:reduce){.lmg-sheet{animation:none;}}
    .lmg-brand{font-weight:900;font-size:19px;letter-spacing:0.14em;color:#f4f6f8;margin-bottom:3px;}
    .lmg-brand b{color:#e8b64a;}
    .lmg-sub{font-size:12px;color:#8b93a3;margin-bottom:24px;letter-spacing:0.04em;}
    .lmg-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;}
    @media (max-width:360px){.lmg-grid{grid-template-columns:repeat(2,1fr);}}
    .lmg-bub{display:flex;flex-direction:column;align-items:center;gap:9px;cursor:pointer;background:none;border:none;
      font-family:inherit;color:#f4f6f8;padding:4px;transition:transform .12s ease;}
    .lmg-bub:active{transform:scale(.93);}
    .lmg-circ{width:72px;height:72px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:30px;
      background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.14);box-shadow:0 6px 20px rgba(0,0,0,0.35);
      transition:border-color .15s ease,background .15s ease;}
    .lmg-bub:hover .lmg-circ{border-color:rgba(232,182,74,0.55);background:rgba(232,182,74,0.12);}
    .lmg-bub.here .lmg-circ{border-color:#e8b64a;background:rgba(232,182,74,0.16);}
    .lmg-lab{font-size:12.5px;font-weight:700;}
    .lmg-here{font-size:10px;color:#e8b64a;font-weight:800;letter-spacing:0.05em;}
    .lmg-close{margin-top:26px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.14);color:#cfd6e0;
      border-radius:999px;padding:11px 26px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;}
  `;
  document.head.appendChild(style);

  const btn = document.createElement("button");
  btn.id = "lmg-launch-btn"; btn.type = "button"; btn.title = "Menú Legacy"; btn.setAttribute("aria-label","Menú Legacy");
  btn.textContent = "L";
  btn.onclick = openMenu;
  document.body.appendChild(btn);

  const ov = document.createElement("div");
  ov.id = "lmg-launch-ov";
  const here = currentKey();
  ov.innerHTML = `<div class="lmg-sheet">
    <div class="lmg-brand">LEGACY <b>·</b> PIT CREW</div>
    <div class="lmg-sub">🏁 TODO EN UN SOLO LUGAR</div>
    <div class="lmg-grid">${secs.map(s => `
      <button class="lmg-bub ${s.k===here?'here':''}" data-href="${s.href}" data-here="${s.k===here?'1':'0'}">
        <div class="lmg-circ">${s.ico}</div>
        <div class="lmg-lab">${s.label}</div>
        ${s.k===here?'<div class="lmg-here">AQUÍ</div>':''}
      </button>`).join("")}</div>
    <button class="lmg-close" id="lmg-close">Cerrar</button>
  </div>`;
  ov.addEventListener("click", (e) => {
    if (e.target === ov || e.target.id === "lmg-close") { closeMenu(); return; }
    const b = e.target.closest(".lmg-bub"); if (!b) return;
    if (b.dataset.here === "1") { closeMenu(); return; }
    location.href = b.dataset.href;
  });
  document.body.appendChild(ov);
}
function openMenu(){ const o=document.getElementById("lmg-launch-ov"); if(o) o.classList.add("open"); }
function closeMenu(){ const o=document.getElementById("lmg-launch-ov"); if(o) o.classList.remove("open"); }
