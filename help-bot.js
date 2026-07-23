/* 🛟 Legacy DMS — bot INTERNO de ayuda (empleados y supervisores). Reusa la sesión Firebase de la página. */
import { getApps, getApp, initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
const CFG={apiKey:"AIzaSyDrCMJQclGosVp3EV49vmwKDnji-Oti5j0",authDomain:"legacy-motors-garage.firebaseapp.com",projectId:"legacy-motors-garage",storageBucket:"legacy-motors-garage.firebasestorage.app",messagingSenderId:"783567672493",appId:"1:783567672493:web:3a825f2f59ec1c25e9a224"};
const app=getApps().length?getApp():initializeApp(CFG);
const auth=getAuth(app);
const ENDPOINT='https://us-central1-legacy-motors-garage.cloudfunctions.net/helpChat';
const TEAM=['ev@legacymotorsgarage.com','ivan.garcia@legacymotorsgarage.com','warehouse@legacymotorsgarage.com','capture@legacymotorsgarage.com','listing@legacymotorsgarage.com','yarda@legacymotorsgarage.com','ebay@legacymotorsgarage.com','empaque@legacymotorsgarage.com','mechanic@legacymotorsgarage.com','mecanico@legacymotorsgarage.com'];
const HI='¡Hola! 🛟 Soy el ayudante del sistema Legacy. Pregúntame lo que quieras: cómo agregar una parte, subir a eBay, usar el chat, los airbags, lo que sea. ¿En qué te ayudo?';
let built=false, msgs=[], openS=false, busy=false;

function build(){
  if(built) return; built=true;
  var css=document.createElement('style');
  css.textContent='#hb-fab{position:fixed;right:18px;bottom:calc(96px + env(safe-area-inset-bottom));z-index:2147481000;background:#0b0e14;color:#5b9dff;border:1px solid #5b9dff;border-radius:30px;width:54px;height:54px;font-size:24px;box-shadow:0 8px 24px rgba(0,0,0,.5);cursor:pointer;display:none;align-items:center;justify-content:center;}'
   +'#hb-panel{position:fixed;inset:0;z-index:2147481001;background:#0b0e14;display:none;flex-direction:column;overflow:hidden;font-family:-apple-system,system-ui,sans-serif;color:#e7e9ee;}'
   +'#hb-panel.on{display:flex;}'
   +'@media(min-width:601px){#hb-panel{inset:auto;right:18px;bottom:20px;width:390px;height:min(620px,calc(100vh - 40px));border:1px solid #2a2f3a;border-radius:18px;box-shadow:0 20px 60px rgba(0,0,0,.6);}}'
   +'#hb-hd{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:calc(14px + env(safe-area-inset-top)) 16px 14px;background:linear-gradient(135deg,#12203a,#0b0e14);border-bottom:1px solid #2a2f3a;}'
   +'#hb-hd .av{width:40px;height:40px;flex:0 0 auto;border-radius:50%;background:#1e232d;display:flex;align-items:center;justify-content:center;font-size:20px;}'
   +'#hb-hd .ti{flex:1;min-width:0;font-weight:800;font-size:15px;} #hb-hd .su{font-size:11px;color:#98a0b0;font-weight:500;}'
   +'#hb-x{background:#1e232d;border:none;color:#e7e9ee;font-size:20px;font-weight:800;cursor:pointer;width:38px;height:38px;border-radius:50%;flex:0 0 auto;}'
   +'#hb-msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:9px;-webkit-overflow-scrolling:touch;}'
   +'.hb-b{max-width:82%;padding:10px 14px;border-radius:16px;font-size:15px;line-height:1.45;word-break:break-word;box-shadow:0 1px 2px rgba(0,0,0,.25);}'
   +'.hb-bot{align-self:flex-start;background:#1a1f2b;border-bottom-left-radius:5px;}'
   +'.hb-me{align-self:flex-end;background:#5b9dff;color:#04132b;font-weight:500;border-bottom-right-radius:5px;}'
   +'.hb-typing{align-self:flex-start;color:#98a0b0;font-size:13px;padding:4px 6px;}'
   +'#hb-bar{flex:0 0 auto;display:flex;gap:8px;align-items:flex-end;padding:10px 12px calc(10px + env(safe-area-inset-bottom));border-top:1px solid #2a2f3a;background:#151a24;}'
   +'#hb-in{flex:1;min-width:0;background:#0b0e14;border:1px solid #2a2f3a;border-radius:22px;padding:12px 16px;color:#e7e9ee;font-size:16px;outline:none;}'
   +'#hb-snd{flex:0 0 auto;background:#5b9dff;color:#04132b;border:none;border-radius:50%;width:44px;height:44px;font-weight:800;font-size:18px;cursor:pointer;}';
  document.head.appendChild(css);
  var fab=document.createElement('button'); fab.id='hb-fab'; fab.textContent='🛟'; fab.title='Ayuda del sistema'; fab.onclick=toggle; document.body.appendChild(fab);
  var p=document.createElement('div'); p.id='hb-panel';
  p.innerHTML='<div id="hb-hd"><div class="av">🛟</div><div class="ti">Ayuda del sistema<div class="su">Dudas de cómo usar la app</div></div><button id="hb-x">✕</button></div>'
   +'<div id="hb-msgs"></div><div id="hb-bar"><input id="hb-in" type="text" autocomplete="off" enterkeyhint="send" placeholder="Escribe tu duda…"><button id="hb-snd">➤</button></div>';
  document.body.appendChild(p);
  document.getElementById('hb-x').onclick=toggle;
  document.getElementById('hb-snd').onclick=send;
  var inp=document.getElementById('hb-in');
  inp.addEventListener('keydown',function(e){ if(e.key==='Enter') send(); });
  inp.addEventListener('focus',function(){ setTimeout(fit,150); setTimeout(fit,350); });
  function fit(){ if(window.innerWidth>600) return; var vv=window.visualViewport; if(!vv) return; p.style.height=vv.height+'px'; p.style.transform='translateY('+vv.offsetTop+'px)'; var m=document.getElementById('hb-msgs'); if(m) m.scrollTop=m.scrollHeight; }
  window._hbFit=fit;
}
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function render(){ var box=document.getElementById('hb-msgs'); if(!box) return; box.innerHTML=msgs.map(function(m){ return '<div class="hb-b '+(m.role==='assistant'?'hb-bot':'hb-me')+'">'+esc(m.content).replace(/\n/g,'<br>')+'</div>'; }).join('')+(busy?'<div class="hb-typing">Escribiendo…</div>':''); box.scrollTop=box.scrollHeight; }
function toggle(){
  var fab=document.getElementById('hb-fab'), p=document.getElementById('hb-panel'); if(!p) return;
  openS=!openS; p.classList.toggle('on',openS); fab.style.display=openS?'none':'flex';
  if(openS){ if(!msgs.length){ msgs.push({role:'assistant',content:HI}); } render(); var vv=window.visualViewport; if(vv&&window._hbFit){ vv.addEventListener('resize',window._hbFit); vv.addEventListener('scroll',window._hbFit); window._hbFit(); } setTimeout(function(){ var i=document.getElementById('hb-in'); if(i&&window.innerWidth>600) i.focus(); },120); }
  else { var vv2=window.visualViewport; if(vv2&&window._hbFit){ vv2.removeEventListener('resize',window._hbFit); vv2.removeEventListener('scroll',window._hbFit); } p.style.height=''; p.style.transform=''; }
}
function send(){
  var i=document.getElementById('hb-in'); var txt=(i.value||'').trim(); if(!txt||busy) return;
  i.value=''; msgs.push({role:'user',content:txt}); busy=true; render();
  fetch(ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:msgs.slice(-12)})})
    .then(function(r){return r.json();})
    .then(function(d){ busy=false; msgs.push({role:'assistant',content:(d&&d.reply)||'Perdón, intenta de nuevo.'}); render(); })
    .catch(function(){ busy=false; msgs.push({role:'assistant',content:'Perdón, tuve un detalle. Intenta de nuevo.'}); render(); });
}
onAuthStateChanged(auth,function(u){
  var email=((u&&u.email)||'').toLowerCase();
  if(u && TEAM.indexOf(email)>=0){ build(); var fab=document.getElementById('hb-fab'); if(fab) fab.style.display='flex'; }
  else { var fab=document.getElementById('hb-fab'); if(fab) fab.style.display='none'; var p=document.getElementById('hb-panel'); if(p) p.classList.remove('on'); }
});
