// ===== Legacy Launcher — menú único (solo dueños) =====
// Reusa el LOGO que ya existe en la barra superior de cada página.
// En cada página se marca el logo con  data-legacy-launch  y este script,
// si el usuario es dueño, lo vuelve el disparador de un menú desplegable
// de burbujas transparentes para brincar entre las apps (sin re-login).
//   <script type="module" src="launcher.js"></script>
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
  { k:"index",        label:"Inventario",   short:"Inventario", ico:"🚗", href:"index.html" },
  { k:"admin",        label:"Clientes",     short:"Clientes",   ico:"👥", href:"admin.html" },
  { k:"finanzas",     label:"Finanzas",     short:"Finanzas",   ico:"💰", href:"finanzas.html" },
  // 🔒 PERSONAL de Enrique — solo ev@ la ve.
  { k:"mis-finanzas", label:"Mis Finanzas", short:"Mis Fin.",   ico:"📊", href:"mis-finanzas.html", only: EV },
  { k:"empleado",     label:"Pit Crew",     short:"Pit Crew",   ico:"🏁", href:"empleado.html" },
  { k:"warehouse",    label:"Almacén",      short:"Almacén",    ico:"📦", href:"warehouse.html" },
];

let app; try { app = getApps().length ? getApp() : initializeApp(CFG, "legacy-launcher"); }
catch (e) { try { app = initializeApp(CFG, "legacy-launcher-" + Date.now()); } catch (_) { app = null; } }
if (app) onAuthStateChanged(getAuth(app), (user) => {
  const email = ((user && user.email) || "").toLowerCase();
  if (email && OWNERS.includes(email)) enable(email); else disable();
});

function currentKey(){
  const f = (location.pathname.split("/").pop() || "index.html").toLowerCase();
  const hit = SECTIONS.find(s => f === s.href || (f === "" && s.k === "index"));
  return hit ? hit.k : "index";
}
let SECS = [];
function enable(email){
  SECS = SECTIONS.filter(s => !s.only || s.only === email);
  injectStyle(); buildMenu();
  applyBars();
  // por si la barra se pinta/cambia después de cargar (apps que arman el header en JS)
  if (!window.__lmgObs){
    window.__lmgObs = new MutationObserver(() => { if (window.__lmgOwner) applyBars(); });
    try { window.__lmgObs.observe(document.body, { childList:true, subtree:true }); } catch(e){}
  }
  window.__lmgOwner = true;
}
function applyBars(){
  // Oculta el logo propio de cada página (para los dueños) y pone el logo estándar.
  document.querySelectorAll("[data-legacy-brand]").forEach(b => { if (b.dataset.lmgHid !== "1"){ b.dataset.lmgHid="1"; b.dataset.lmgDisp = b.style.display||""; b.style.display="none"; } });
  document.querySelectorAll("[data-legacy-bar]").forEach(ensureLogo);
  // Usa el LOGO que ya existe (ej. el grande de la página principal) como disparador.
  document.querySelectorAll("[data-legacy-launch]").forEach(wireExisting);
  // Esconde las barras de abajo viejas (cada página tenía la suya) y pone UNA sola compartida (estilo Facebook).
  ["staff-tabbar","wh-tabbar"].forEach((id) => { const el=document.getElementById(id); if(el && el.dataset.lmgHidBar!=="1"){ el.dataset.lmgHidBar="1"; el.dataset.lmgBarDisp=el.style.display||""; el.style.display="none"; } });
  ensureBottomNav();
}
function ensureBottomNav(){
  let nav = document.getElementById("lmg-nav");
  if(!nav){ nav = document.createElement("nav"); nav.id = "lmg-nav"; document.body.appendChild(nav);
    try{ document.body.style.paddingBottom = "calc(86px + env(safe-area-inset-bottom, 0px))"; }catch(e){} }
  const here = currentKey();
  nav.innerHTML = SECS.map(s =>
    `<a href="${s.href}" class="${s.k===here?'active':''}" aria-current="${s.k===here?'page':'false'}"><span class="ic">${s.ico}</span>${s.short||s.label}</a>`).join("");
}
function wireExisting(el){
  if (el.dataset.lmgWired === "1") return;
  el.dataset.lmgWired = "1"; el.style.cursor = "pointer";
  el.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); toggleMenu(el); });
}
function disable(){
  window.__lmgOwner = false;
  document.querySelectorAll(".lmg-logo").forEach(el => el.remove());
  document.querySelectorAll('[data-legacy-brand][data-lmg-hid="1"]').forEach(b => { b.style.display = b.dataset.lmgDisp||""; b.removeAttribute("data-lmg-hid"); });
  document.querySelectorAll('[data-legacy-launch][data-lmg-wired="1"]').forEach(el => el.removeAttribute("data-lmg-wired"));
  ["staff-tabbar","wh-tabbar"].forEach((id) => { const el=document.getElementById(id); if(el && el.dataset.lmgHidBar==="1"){ el.style.display=el.dataset.lmgBarDisp||""; delete el.dataset.lmgHidBar; } });
  const nav=document.getElementById("lmg-nav"); if(nav) nav.remove();
  try{ document.body.style.paddingBottom=""; }catch(e){}
  closeMenu();
}
function ensureLogo(bar){
  if (bar.querySelector(":scope > .lmg-logo")) return;
  const logo = document.createElement("button");
  logo.type = "button"; logo.className = "lmg-logo"; logo.setAttribute("aria-label","Menú Legacy");
  logo.innerHTML = `<img class="lmg-logo-img" src="legacy-logo.png?v=3" alt="Legacy Motors Garage"><span class="lmg-chev">▾</span>`;
  logo.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); toggleMenu(logo); });
  bar.insertBefore(logo, bar.firstChild);
}

function injectStyle(){
  if (document.getElementById("lmg-style")) return;
  const s = document.createElement("style"); s.id = "lmg-style";
  s.textContent = `
    .lmg-logo{display:inline-flex;align-items:center;gap:5px;padding:4px 8px;border-radius:12px;cursor:pointer;
      background:none;border:none;flex:0 0 auto;transition:background .15s ease,transform .1s ease;}
    .lmg-logo:hover{background:rgba(232,182,74,0.12);}
    .lmg-logo:active{transform:scale(.96);}
    .lmg-logo-img{height:56px;width:auto;display:block;}
    .lmg-chev{display:inline-block;font-size:12px;opacity:.85;color:#c9b896;transition:transform .18s ease;}
    .lmg-logo[data-lmg-open] .lmg-chev{transform:rotate(180deg);}
    #lmg-catch{position:fixed;inset:0;z-index:2147483000;display:none;background:transparent;}
    #lmg-catch.open{display:block;}
    #lmg-dd{position:fixed;z-index:2147483001;display:none;width:min(84vw,260px);
      font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display",system-ui,sans-serif;
      animation:lmgDrop .16s ease;}
    #lmg-dd.open{display:block;}
    @keyframes lmgDrop{from{opacity:0;transform:translateY(-6px);}to{opacity:1;transform:none;}}
    @media (prefers-reduced-motion:reduce){#lmg-dd{animation:none;}}
    .lmg-row{display:flex;align-items:center;gap:12px;width:100%;margin-bottom:8px;padding:11px 14px;border-radius:14px;cursor:pointer;
      background:rgba(20,24,34,0.66);border:1px solid rgba(255,255,255,0.12);
      backdrop-filter:blur(14px) saturate(1.3);-webkit-backdrop-filter:blur(14px) saturate(1.3);
      box-shadow:0 6px 20px rgba(0,0,0,0.28);color:#f4f6f8;font-size:15px;font-weight:700;text-align:left;
      font-family:inherit;transition:transform .1s ease,border-color .15s ease;}
    .lmg-row:last-child{margin-bottom:0;}
    .lmg-row:active{transform:scale(.98);}
    .lmg-row:hover{border-color:rgba(232,182,74,0.55);}
    .lmg-row.here{border-color:#e8b64a;background:rgba(232,182,74,0.16);}
    .lmg-ico{font-size:20px;width:26px;text-align:center;flex:0 0 auto;}
    .lmg-here{margin-left:auto;font-size:10px;font-weight:800;letter-spacing:.05em;color:#e8b64a;}
    /* Barra inferior ÚNICA — burbuja flotante de cristal (estilo iPhone), misma en todas */
    #lmg-nav{position:fixed;left:12px;right:12px;bottom:calc(10px + env(safe-area-inset-bottom,0px));z-index:2147482990;
      display:flex;gap:2px;padding:6px;border-radius:24px;
      background:rgba(13,16,24,0.62);border:1px solid rgba(255,255,255,0.14);
      -webkit-backdrop-filter:saturate(180%) blur(24px);backdrop-filter:saturate(180%) blur(24px);
      box-shadow:0 12px 34px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.06);
      font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;max-width:560px;margin:0 auto;}
    #lmg-nav a{flex:1;min-width:0;text-align:center;padding:8px 2px;text-decoration:none;color:#8a8fa8;border-radius:17px;
      font-size:9.5px;font-weight:700;letter-spacing:.02em;display:flex;flex-direction:column;align-items:center;gap:3px;
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:color .15s ease,background .15s ease;}
    #lmg-nav a .ic{font-size:21px;line-height:1.05;}
    #lmg-nav a.active{color:#c9a84c;background:rgba(201,168,76,0.15);}
    #lmg-nav a:active{transform:scale(.94);}
  `;
  document.head.appendChild(s);
}
function buildMenu(){
  if (document.getElementById("lmg-dd")) { renderRows(); return; }
  const catcher = document.createElement("div"); catcher.id = "lmg-catch";
  catcher.addEventListener("click", closeMenu);
  const dd = document.createElement("div"); dd.id = "lmg-dd";
  document.body.appendChild(catcher); document.body.appendChild(dd);
  renderRows();
  window.addEventListener("resize", closeMenu);
}
function renderRows(){
  const here = currentKey();
  document.getElementById("lmg-dd").innerHTML = SECS.map(s =>
    `<button class="lmg-row ${s.k===here?'here':''}" data-href="${s.href}" data-here="${s.k===here?'1':'0'}">
       <span class="lmg-ico">${s.ico}</span><span>${s.label}</span>${s.k===here?'<span class="lmg-here">AQUÍ</span>':''}
     </button>`).join("");
  document.getElementById("lmg-dd").querySelectorAll(".lmg-row").forEach(r => {
    r.addEventListener("click", () => { if (r.dataset.here === "1") { closeMenu(); return; } location.href = r.dataset.href; });
  });
}
let openAnchor = null;
function toggleMenu(anchor){
  const dd = document.getElementById("lmg-dd");
  if (dd.classList.contains("open") && openAnchor === anchor) { closeMenu(); return; }
  openAnchor = anchor;
  const r = anchor.getBoundingClientRect();
  const w = Math.min(window.innerWidth * 0.84, 260);
  let left = r.left; if (left + w > window.innerWidth - 10) left = window.innerWidth - w - 10; if (left < 10) left = 10;
  dd.style.top = (r.bottom + 8) + "px"; dd.style.left = left + "px";
  dd.classList.add("open"); document.getElementById("lmg-catch").classList.add("open");
  anchor.setAttribute("data-lmg-open","1");
}
function closeMenu(){
  const dd = document.getElementById("lmg-dd"); if (dd) dd.classList.remove("open");
  const c = document.getElementById("lmg-catch"); if (c) c.classList.remove("open");
  document.querySelectorAll("[data-lmg-open]").forEach(el => el.removeAttribute("data-lmg-open"));
  openAnchor = null;
}
