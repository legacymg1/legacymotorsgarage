// 💬 Widget de chat UNIFICADO — burbuja + panel para TODOS los roles, en cualquier página.
// Reusa la app Firebase de la página (misma sesión). Estado (leído/oculto) en la NUBE → sincroniza entre dispositivos.
import { getApps, getApp, initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore, collection, doc, setDoc, addDoc, deleteDoc, onSnapshot, query, orderBy, limit, where } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";
import { getMessaging, getToken, onMessage, isSupported } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js";

const CFG = { apiKey:"AIzaSyDrCMJQclGosVp3EV49vmwKDnji-Oti5j0", authDomain:"legacy-motors-garage.firebaseapp.com", projectId:"legacy-motors-garage", storageBucket:"legacy-motors-garage.firebasestorage.app", messagingSenderId:"783567672493", appId:"1:783567672493:web:3a825f2f59ec1c25e9a224" };
const app = getApps().length ? getApp() : initializeApp(CFG);
const db = getFirestore(app), auth = getAuth(app), functions = getFunctions(app);
const VAPID_KEY = "BDUfgtFZl2cfkkTcFSdGmXScxn0_Y-hthANv1DTW6S8EQJk_Abh6Zx6MCg8xdltHn-WEiwBjRjoV_OtClRhmOmU";

const ROLE_BY_EMAIL = {
  'ev@legacymotorsgarage.com':'owner','ivan.garcia@legacymotorsgarage.com':'owner',
  'warehouse@legacymotorsgarage.com':'packager','capture@legacymotorsgarage.com':'yard',
  'listing@legacymotorsgarage.com':'lister','yarda@legacymotorsgarage.com':'yard',
  'ebay@legacymotorsgarage.com':'lister','empaque@legacymotorsgarage.com':'packager',
  'mechanic@legacymotorsgarage.com':'mechanic','mecanico@legacymotorsgarage.com':'mechanic'
};
const NAMES = {
  'ev@legacymotorsgarage.com':'Enrique','ivan.garcia@legacymotorsgarage.com':'Ivan',
  'capture@legacymotorsgarage.com':'Captura','yarda@legacymotorsgarage.com':'Captura',
  'listing@legacymotorsgarage.com':'Listado','ebay@legacymotorsgarage.com':'Listado',
  'warehouse@legacymotorsgarage.com':'Empaque','empaque@legacymotorsgarage.com':'Empaque',
  'mechanic@legacymotorsgarage.com':'Mecánico','mecanico@legacymotorsgarage.com':'Mecánico'
};
const CH_ALL = [
  {k:'group',            n:'Legacy Group',            roles:['owner','warehouse','yard','lister','packager','mechanic']},
  {k:'owners',           n:'Supervisores',            roles:['owner']},
  {k:'capture-listing',  n:'Captura ↔ Listado',       roles:['owner','yard','lister']},
  {k:'capture-owners',   n:'Captura ↔ Supervisores',  roles:['owner','yard']},
  {k:'listing-owners',   n:'Listado ↔ Supervisores',  roles:['owner','lister']},
  {k:'warehouse-owners', n:'Empaque ↔ Supervisores',  roles:['owner','warehouse','packager']},
  {k:'mechanic-owners',  n:'Mecánico ↔ Supervisores', roles:['owner','mechanic']},
];
const esc=(s)=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const dispName=(e)=>NAMES[(e||'').toLowerCase()]||((e||'').split('@')[0])||e;

let ME='', MYROLE='', CH=[], msgs={}, allReads={}, hidden=[], unsub={}, hiddenUnsub=null, readsUnsub=null;
let open=false, view='list', curCh='', msgr=null, reg=null, toastT=null;
const REACTIONS=['👍','❤️','😂','😮','😢','🙏'];
let reax={}, _reaxDocs={};
function recomputeReax(){ reax={}; Object.keys(_reaxDocs).forEach(ch=>_reaxDocs[ch].forEach(r=>{ if(!r.msgId||!r.emoji) return; (reax[r.msgId]=reax[r.msgId]||{}); (reax[r.msgId][r.emoji]=reax[r.msgId][r.emoji]||[]).push(r.email); })); }
const chName=(k)=>{ const c=CH_ALL.find(x=>x.k===k); return c?c.n:k; };
const myReads=()=>allReads[ME]||{};

// 🖐️ Hacer la burbuja arrastrable a cualquier parte de la pantalla; recuerda dónde la dejaron. Un toque normal = abrir.
function makeDraggable(fab,key){
  fab.style.touchAction='none';
  let hasPos=false, sx=null, sy=null, ox=0, oy=0, moved=false;
  function applyPos(x,y){ const w=fab.offsetWidth||62, h=fab.offsetHeight||62; x=Math.max(8,Math.min(x,window.innerWidth-w-8)); y=Math.max(8,Math.min(y,window.innerHeight-h-8)); fab.style.left=x+'px'; fab.style.top=y+'px'; fab.style.right='auto'; fab.style.bottom='auto'; hasPos=true; }
  try{ const s=JSON.parse(localStorage.getItem(key)||'null'); if(s&&typeof s.x==='number'){ applyPos(s.x,s.y); } }catch(e){}
  function snapToEdge(){ const w=fab.offsetWidth||62, h=fab.offsetHeight||62; const r=fab.getBoundingClientRect(); let x=r.left, y=r.top; const toL=x, toR=window.innerWidth-(x+w), toT=y, toB=window.innerHeight-(y+h); const m=Math.min(toL,toR,toT,toB); if(m===toL) x=8; else if(m===toR) x=window.innerWidth-w-8; else if(m===toT) y=8; else y=window.innerHeight-h-8; fab.style.transition='left .18s ease, top .18s ease'; applyPos(x,y); return {x,y}; }
  fab.addEventListener('pointerdown',(e)=>{ moved=false; fab.style.transition='none'; const r=fab.getBoundingClientRect(); ox=r.left; oy=r.top; sx=e.clientX; sy=e.clientY; try{ fab.setPointerCapture(e.pointerId); }catch(_){} });
  fab.addEventListener('pointermove',(e)=>{ if(sx==null) return; const dx=e.clientX-sx, dy=e.clientY-sy; if(!moved && Math.abs(dx)+Math.abs(dy)<6) return; moved=true; fab._dragged=true; e.preventDefault(); applyPos(ox+dx,oy+dy); });
  fab.addEventListener('pointerup',()=>{ if(sx==null) return; sx=null; if(moved){ const pos=snapToEdge(); try{ localStorage.setItem(key,JSON.stringify(pos)); }catch(_){} setTimeout(()=>{ fab._dragged=false; },60); } });
  fab.addEventListener('click',(e)=>{ if(fab._dragged){ e.stopImmediatePropagation(); e.preventDefault(); fab._dragged=false; } },true);
  window.addEventListener('resize',()=>{ if(!hasPos) return; const r=fab.getBoundingClientRect(); applyPos(r.left,r.top); });
}
function build(){
  if(document.getElementById('lcw-fab')) return;
  const style=document.createElement('style');
  style.textContent=`#lcw-fab{position:fixed;left:18px;bottom:calc(96px + env(safe-area-inset-bottom));z-index:6500;width:62px;height:62px;border-radius:34px;background:#151a24;color:#f0c040;border:2px solid #f0c040;box-shadow:0 10px 28px rgba(0,0,0,.55);font-size:27px;cursor:pointer;display:none;align-items:center;justify-content:center;}
  #lcw-badge{position:absolute;top:-4px;right:-4px;background:#c0392b;color:#fff;border-radius:20px;min-width:20px;height:20px;font-size:11px;font-weight:800;line-height:20px;padding:0 5px;display:none;}
  #lcw-panel{position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.45);display:none;color:#e7e9ee;font-family:-apple-system,system-ui,sans-serif;}
  #lcw-sheet{position:fixed;left:14px;bottom:calc(90px + env(safe-area-inset-bottom));width:min(400px,calc(100vw - 28px));height:min(72vh,620px);border:2px solid #f0c040;border-radius:20px;box-shadow:0 22px 60px rgba(0,0,0,.7);display:flex;flex-direction:column;overflow:hidden;background:#0b0e14;}
  #lcw-panel .hd{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:13px 14px;border-bottom:1px solid #2a2f3a;background:#151a24;}
  #lcw-panel .hd .t{font-weight:800;flex:1;min-width:0;} #lcw-panel .hd .sub{font-size:11px;color:#98a0b0;font-weight:600;margin-top:1px;}
  #lcw-panel button{cursor:pointer;font-family:inherit;}
  #lcw-list{flex:1;overflow-y:auto;}
  #lcw-convo{display:none;flex:1;flex-direction:column;overflow:hidden;}
  #lcw-msgs{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:8px;}
  #lcw-bar{flex:0 0 auto;display:flex;gap:8px;padding:10px 12px 12px;border-top:1px solid #2a2f3a;background:#151a24;}
  #lcw-input{flex:1;min-width:0;background:#0b0e14;border:1px solid #2a2f3a;border-radius:10px;padding:11px 12px;color:#e7e9ee;font-size:15px;}
  .lcw-send{flex:0 0 auto;background:#f0c040;color:#0b0e14;border:none;border-radius:10px;padding:0 16px;font-weight:800;}
  .lcw-row{display:flex;gap:12px;align-items:center;padding:12px 14px;border-bottom:1px solid #1e232d;cursor:pointer;}
  .lcw-av{flex:0 0 auto;width:46px;height:46px;border-radius:50%;background:#1e232d;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:18px;color:#f0c040;}
  .lcw-x{flex:0 0 auto;width:44px;height:44px;border-radius:50%;background:#1e232d;border:none;color:#e7e9ee;font-size:20px;font-weight:800;}`;
  document.head.appendChild(style);
  const fab=document.createElement('button'); fab.id='lcw-fab'; fab.innerHTML='💬<span id="lcw-badge"></span>'; fab.onclick=openPanel; document.body.appendChild(fab);
  makeDraggable(fab,'lcw_fabpos');
  const p=document.createElement('div'); p.id='lcw-panel';
  p.innerHTML=`<div id="lcw-sheet">
    <div class="hd"><button id="lcw-back" style="display:none;background:none;border:none;color:#f0c040;font-size:22px;font-weight:800;">‹</button><div style="flex:1;min-width:0;"><div class="t" id="lcw-title">💬 Chat interno</div><div class="sub" id="lcw-subtitle" style="display:none;"></div></div><button class="lcw-x" id="lcw-close">✕</button></div>
    <div id="lcw-list"></div>
    <div id="lcw-convo"><div id="lcw-msgs"></div>
      <div id="lcw-note" class="lcw-note" style="display:none;flex:0 0 auto;padding:12px 14px calc(12px + env(safe-area-inset-bottom));border-top:1px solid #2a2f3a;background:#151a24;color:#98a0b0;font-size:12px;text-align:center;">📢 Solo los supervisores pueden escribir aquí</div>
      <div id="lcw-bar"><input id="lcw-input" type="text" readonly onfocus="this.removeAttribute('readonly')" placeholder="Escribe un mensaje…"><button class="lcw-send" id="lcw-sendbtn">Enviar</button></div>
    </div></div>`;
  document.body.appendChild(p);
  p.addEventListener('click',(e)=>{ if(e.target===p) closePanel(); });
  document.getElementById('lcw-close').onclick=closePanel;
  document.getElementById('lcw-back').onclick=backToList;
  document.getElementById('lcw-sendbtn').onclick=send;
  const inp=document.getElementById('lcw-input');
  inp.addEventListener('keydown',(e)=>{ if(e.key==='Enter') send(); });
  inp.addEventListener('focus',()=>{ setTimeout(fitSheet,150); setTimeout(fitSheet,350); });   // al aparecer el teclado, ajusta y baja al último
}

function startListeners(){
  CH.forEach(c=>{ if(unsub[c.k]) return;
    const qy=query(collection(db,'chat_channels',c.k,'messages'), orderBy('ts'), limit(300));
    unsub[c.k]=onSnapshot(qy, s=>{ msgs[c.k]=s.docs.map(d=>({id:d.id,...d.data()})); refresh(); }, e=>console.log('lcw',c.k,e));
    // 😀 Reacciones del canal
    onSnapshot(query(collection(db,'chat_reactions'), where('ch','==',c.k)), s=>{ _reaxDocs[c.k]=s.docs.map(d=>d.data()); recomputeReax(); if(open&&view==='convo'&&curCh===c.k) renderMsgs(); }, e=>console.log('reax',c.k,e));
  });
  // 📖 Marcadores de LEÍDO (por usuario, en la nube) → no-leídos sincronizados + palomitas después
  if(!readsUnsub) readsUnsub=onSnapshot(collection(db,'chat_reads'), s=>{ const m={}; s.forEach(d=>m[d.id]=d.data()||{}); allReads=m; refresh(); }, e=>{ console.log('reads',e); if(MYROLE==='owner') alert('No se pudo leer chat_reads (¿falta la regla?): '+((e&&e.message)||e)); });
  // 🗄️ Chats ocultos (por usuario, en la nube)
  if(!hiddenUnsub) hiddenUnsub=onSnapshot(doc(db,'chat_hidden',ME), s=>{ hidden=(s.exists()&&s.data().channels)||[]; if(open&&view==='list') renderList(); }, e=>console.log('hidden',e));
}
function refresh(){ if(open&&view==='convo') renderMsgs(); if(open&&view==='list') renderList(); badge(); }

const unread=(k)=>{ const r=(myReads()[k])||0; return (msgs[k]||[]).filter(m=>(m.tms||0)>r && (m.byEmail||'')!==ME).length; };
const lastMsg=(k)=>{ const a=msgs[k]||[]; return a.length?a[a.length-1]:null; };
function badge(){ const b=document.getElementById('lcw-badge'); if(!b) return; const n=CH.reduce((s,c)=>s+unread(c.k),0); if(n>0){ b.textContent=n>9?'9+':n; b.style.display='block'; } else b.style.display='none'; }
function markSeen(k){ const last=lastMsg(k); const tms=last?(last.tms||Date.now()):Date.now();
  // Actualiza YA la vista (no espera a la nube) → el contador baja al instante
  allReads[ME]=allReads[ME]||{}; if((allReads[ME][k]||0)<tms) allReads[ME][k]=tms; badge(); if(open&&view==='list') renderList();
  try{ setDoc(doc(db,'chat_reads',ME),{ email:ME, [k]:tms, at:new Date().toISOString() },{merge:true}).catch(e=>{ if(MYROLE==='owner') alert('No se guardó leído: '+((e&&e.message)||e)); }); }catch(e){}
}
window.lcwHide=(k)=>{ if(hidden.indexOf(k)<0){ hidden=hidden.concat([k]); } try{ setDoc(doc(db,'chat_hidden',ME),{ email:ME, channels:hidden },{merge:true}); }catch(e){} renderList(); };
window.lcwUnhide=(k)=>{ hidden=hidden.filter(x=>x!==k); try{ setDoc(doc(db,'chat_hidden',ME),{ email:ME, channels:hidden },{merge:true}); }catch(e){} renderList(); };

function rowHTML(c,swipe){
  const lm=lastMsg(c.k), u=unread(c.k);
  const who=lm?((lm.byEmail===ME?'Tú':(lm.byName||''))+': '):'';
  const prev=lm?esc(who+(lm.text||'')):'<span style="color:#6b7280;">Sin mensajes aún</span>';
  const when=lm&&lm.ts?new Date(lm.ts).toLocaleString('es-MX',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'';
  const av=chName(c.k).slice(0,1).toUpperCase();
  const inner=`<div class="lcw-av">${av}</div><div style="flex:1;min-width:0;"><div style="display:flex;justify-content:space-between;gap:8px;"><div style="font-weight:800;">${chName(c.k)}</div><div style="font-size:11px;color:#6b7280;flex:0 0 auto;">${when}</div></div><div style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-top:2px;"><div style="flex:1;min-width:0;color:#98a0b0;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${prev}</div>${u>0?'<span style="flex:0 0 auto;background:#25d366;color:#0b0e14;border-radius:20px;min-width:20px;height:20px;font-size:11px;font-weight:800;line-height:20px;text-align:center;padding:0 6px;">'+u+'</span>':''}</div></div>`;
  if(!swipe) return `<div class="lcw-row" style="opacity:.6;cursor:default;">${inner}<button class="lcw-send" style="background:none;border:1px solid #2a2f3a;color:#e7e9ee;padding:6px 10px;border-radius:8px;" onclick="lcwUnhide('${c.k}')">↩️ Mostrar</button></div>`;
  return `<div style="position:relative;overflow:hidden;border-bottom:1px solid #1e232d;"><div style="position:absolute;inset:0;display:flex;justify-content:flex-end;align-items:center;background:#8a6d1f;"><span onclick="lcwHide('${c.k}')" style="color:#fff;font-weight:800;padding:0 22px;cursor:pointer;">🗄️ Ocultar</span></div><div class="lcw-swrow" data-k="${c.k}" style="position:relative;background:#0b0e14;transition:transform .15s;"><div class="lcw-row" style="border:none;" onclick="lcwTap(this,'${c.k}')">${inner}</div></div></div>`;
}
function renderList(){
  const box=document.getElementById('lcw-list'); if(!box) return;
  const vis=CH.filter(c=>hidden.indexOf(c.k)<0).sort((a,b)=>{ const la=lastMsg(a.k),lb=lastMsg(b.k); return (lb?lb.tms||0:0)-(la?la.tms||0:0); });
  const hid=CH.filter(c=>hidden.indexOf(c.k)>=0);
  const banner = pushOn() ? '' : `<div onclick="lcwEnablePush()" style="display:flex;gap:10px;align-items:center;margin:10px;padding:11px 13px;background:rgba(240,192,64,.12);border:1px solid rgba(240,192,64,.45);border-radius:12px;cursor:pointer;"><span style="font-size:20px;">🔔</span><div style="flex:1;font-size:13px;font-weight:700;">Activar notificaciones — que no se te escape ningún mensaje</div><span style="color:#f0c040;font-weight:800;">›</span></div>`;
  let html=banner+vis.map(c=>rowHTML(c,true)).join('');
  if(hid.length) html+=`<details style="margin-top:6px;"><summary style="cursor:pointer;padding:12px 14px;font-weight:800;color:#98a0b0;">🗄️ Ocultas (${hid.length})</summary>`+hid.map(c=>rowHTML(c,false)).join('')+`</details>`;
  box.innerHTML=html; attachSwipe();
}
let swEl=null,swX0=0,swDX=0;
function attachSwipe(){ document.querySelectorAll('#lcw-list .lcw-swrow').forEach(el=>{
  el.addEventListener('touchstart',(e)=>{ swEl=el; swX0=e.touches[0].clientX; el.style.transition='none'; },{passive:true});
  el.addEventListener('touchmove',(e)=>{ if(swEl!==el)return; let dx=e.touches[0].clientX-swX0; if(dx>0)dx=0; if(dx<-96)dx=-96; el.style.transform='translateX('+dx+'px)'; swDX=dx; },{passive:true});
  el.addEventListener('touchend',()=>{ if(swEl!==el)return; el.style.transition='transform .15s'; el.style.transform=(swDX<-60)?'translateX(-96px)':'translateX(0)'; swEl=null; },{passive:true});
}); }
window.lcwTap=(el,k)=>{ const row=el.closest('.lcw-swrow'); if(row&&row.style.transform&&parseFloat(row.style.transform.replace(/[^0-9.-]/g,''))<-20){ row.style.transform='translateX(0)'; return; } openConvo(k); };

function canWrite(k){ return k==='group' ? MYROLE==='owner' : true; }   // Legacy Group = solo supervisores escriben
function openConvo(k){ curCh=k; view='convo';
  document.getElementById('lcw-list').style.display='none';
  document.getElementById('lcw-convo').style.display='flex';
  document.getElementById('lcw-back').style.display='';
  document.getElementById('lcw-title').textContent=chName(k);
  document.getElementById('lcw-subtitle').style.display='none';
  const w=canWrite(k);
  document.getElementById('lcw-bar').style.display=w?'flex':'none'; document.getElementById('lcw-note').style.display=w?'none':'block';
  renderMsgs(); markSeen(k); clearNotifs();
  if(w) setTimeout(()=>{ const i=document.getElementById('lcw-input'); if(i) i.focus(); },100);
}
window.lcwOpenTo=(k)=>{ if(!k||!CH.some(c=>c.k===k)){ openPanel(); return; } open=true; document.getElementById('lcw-panel').style.display='block'; openConvo(k); vpOn(); clearNotifs(); };
function backToList(){ view='list'; document.getElementById('lcw-convo').style.display='none'; document.getElementById('lcw-list').style.display='block'; document.getElementById('lcw-back').style.display='none'; document.getElementById('lcw-title').textContent='💬 Chat interno'; document.getElementById('lcw-subtitle').style.display='none'; renderList(); }
// Ventana flotante (tipo Messenger): al abrir el teclado, sube la ventana arriba del teclado; si no, deja la tarjeta chica.
function fitSheet(){ const sh=document.getElementById('lcw-sheet'), vv=window.visualViewport; if(!sh) return;
  if(!vv || window.innerWidth>700){ sh.style.bottom=''; sh.style.height=''; return; }
  const kb=Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  if(kb>60){ sh.style.bottom=(kb+8)+'px'; sh.style.height=(vv.height-70)+'px'; }
  else { sh.style.bottom=''; sh.style.height=''; }
  const m=document.getElementById('lcw-msgs'); if(m) m.scrollTop=m.scrollHeight;
}
function vpOn(){ const vv=window.visualViewport; if(!vv) return; vv.addEventListener('resize',fitSheet); vv.addEventListener('scroll',fitSheet); fitSheet(); }
function vpOff(){ const vv=window.visualViewport, sh=document.getElementById('lcw-sheet'); if(vv){ vv.removeEventListener('resize',fitSheet); vv.removeEventListener('scroll',fitSheet); } if(sh){ sh.style.height=''; sh.style.bottom=''; } }
function openPanel(){ open=true; view='list'; if(MYROLE==='owner') window._notifDiag=true; document.getElementById('lcw-panel').style.display='block'; backToList(); vpOn(); clearNotifs(); }
function closePanel(){ open=false; const p=document.getElementById('lcw-panel'); if(p)p.style.display='none'; vpOff(); }
function renderMsgs(){
  const box=document.getElementById('lcw-msgs'); if(!box) return;
  const arr=msgs[curCh]||[];
  if(!arr.length){ box.innerHTML='<div style="text-align:center;margin:auto;color:#98a0b0;">Sin mensajes aún. Escribe el primero 👋</div>'; return; }
  box.innerHTML=arr.map(m=>{ const mine=(m.byEmail||'')===ME; const when=m.ts?new Date(m.ts).toLocaleString('es-MX',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'';
    const rx=reax[m.id]||{}; const chips=Object.keys(rx).filter(e=>rx[e].length).map(e=>{ const mineR=rx[e].indexOf(ME)>=0; return '<span onclick="lcwReact(\''+m.id+'\',\''+e+'\')" style="display:inline-flex;align-items:center;gap:2px;font-size:12px;background:'+(mineR?'rgba(240,192,64,.18)':'#1e232d')+';border:1px solid '+(mineR?'#f0c040':'#2a2f3a')+';border-radius:20px;padding:1px 7px;margin:3px 3px 0 0;cursor:pointer;">'+e+' '+rx[e].length+'</span>'; }).join('');
    return `<div data-mid="${m.id}" style="align-self:${mine?'flex-end':'flex-start'};max-width:82%;">${mine?'':`<div style="font-size:11px;color:#98a0b0;margin:0 0 2px 4px;font-weight:700;">${esc(m.byName||m.byEmail||'')}</div>`}<div class="lcw-bubble" style="background:${mine?'#f0c040':'#151a24'};color:${mine?'#0b0e14':'#e7e9ee'};border-radius:14px;padding:8px 12px;font-size:14px;line-height:1.4;word-break:break-word;">${esc(m.text||'')}</div><div style="font-size:10px;color:#6b7280;margin:2px 6px 0;text-align:${mine?'right':'left'};">${when}</div>${chips?'<div style="text-align:'+(mine?'right':'left')+';">'+chips+'</div>':''}</div>`;
  }).join('');
  box.scrollTop=box.scrollHeight;
  attachLongPress();
}
// 😀 Dejar apretado un mensaje → selector de reacciones
function attachLongPress(){
  document.querySelectorAll('#lcw-msgs [data-mid] .lcw-bubble').forEach(b=>{
    const el=b.parentNode; const mid=el.getAttribute('data-mid'); let timer=null;
    const start=()=>{ timer=setTimeout(()=>{ try{ if(navigator.vibrate) navigator.vibrate(30); }catch(e){} showReactPicker(mid,b); }, 420); };
    const cancel=()=>{ if(timer){ clearTimeout(timer); timer=null; } };
    b.addEventListener('touchstart',start,{passive:true}); b.addEventListener('touchend',cancel); b.addEventListener('touchmove',cancel);
    b.addEventListener('contextmenu',(e)=>{ e.preventDefault(); showReactPicker(mid,b); });
  });
}
function hideReactPicker(){ const p=document.getElementById('lcw-reactpick'); if(p) p.remove(); }
function showReactPicker(msgId, anchor){
  hideReactPicker();
  const rect=anchor.getBoundingClientRect();
  const pick=document.createElement('div'); pick.id='lcw-reactpick';
  pick.style.cssText='position:fixed;z-index:2147483004;background:#1e232d;border:1px solid #2a2f3a;border-radius:26px;padding:6px 10px;display:flex;gap:8px;box-shadow:0 8px 26px rgba(0,0,0,.6);';
  pick.innerHTML=REACTIONS.map(e=>'<span onclick="lcwReact(\''+msgId+'\',\''+e+'\')" style="font-size:26px;cursor:pointer;line-height:1;">'+e+'</span>').join('');
  document.body.appendChild(pick);
  let top=rect.top-54; if(top<70) top=rect.bottom+8;
  let left=rect.left; const w=pick.offsetWidth; if(left+w>window.innerWidth-10) left=window.innerWidth-w-10; if(left<10) left=10;
  pick.style.top=top+'px'; pick.style.left=left+'px';
  setTimeout(()=>{ document.addEventListener('click',hideReactPicker,{once:true}); document.addEventListener('touchstart',(ev)=>{ if(!pick.contains(ev.target)) hideReactPicker(); },{once:true,passive:true}); }, 20);
}
window.lcwReact=async (msgId,emoji)=>{
  hideReactPicker();
  const rid=curCh+'__'+msgId+'__'+ME;
  const mine=!!(reax[msgId]&&reax[msgId][emoji]&&reax[msgId][emoji].indexOf(ME)>=0);
  try{ if(mine){ await deleteDoc(doc(db,'chat_reactions',rid)); } else { await setDoc(doc(db,'chat_reactions',rid),{ ch:curCh, msgId, email:ME, emoji, at:new Date().toISOString() }); } }catch(e){ console.log('react',e); alert('Reacción no se guardó: '+((e&&e.message)||e)); }
};
async function send(){
  const i=document.getElementById('lcw-input'); if(!i||!curCh) return;
  const text=(i.value||'').trim(); if(!text) return; const ch=curCh; i.value='';
  try{ await addDoc(collection(db,'chat_channels',ch,'messages'),{ text:text.slice(0,1000), byEmail:ME, byName:dispName(ME), byRole:MYROLE, ts:new Date().toISOString(), tms:Date.now() }); }
  catch(e){ i.value=text; alert('Error: '+((e&&e.message)||e)); return; }
  try{ markSeen(ch); }catch(_){}
  setTimeout(()=>{ try{ const p=httpsCallable(functions,'sendChatPush')({ channel:ch, text:text.slice(0,180), byName:dispName(ME) }); if(p&&p.catch) p.catch(()=>{}); }catch(_){} },0);
}
function toast(k,m){
  let el=document.getElementById('lcw-toast');
  if(!el){ el=document.createElement('div'); el.id='lcw-toast'; el.style.cssText='position:fixed;top:calc(10px + env(safe-area-inset-top));left:10px;right:10px;max-width:560px;margin:0 auto;z-index:2147483002;background:#151a24;border:1px solid #f0c040;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.55);padding:11px 14px;display:none;cursor:pointer;color:#e7e9ee;font-family:-apple-system,system-ui,sans-serif;'; document.body.appendChild(el); }
  el.onclick=()=>{ el.style.display='none'; window.lcwOpenTo(k); };
  el.innerHTML='<div style="font-weight:800;font-size:13px;">💬 '+esc(chName(k))+'</div><div style="margin-top:2px;color:#98a0b0;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+esc((m.byName||'')+': '+(m.text||''))+'</div>';
  el.style.display='block'; try{ if(navigator.vibrate) navigator.vibrate(60); }catch(e){}
  if(toastT) clearTimeout(toastT); toastT=setTimeout(()=>{ if(el) el.style.display='none'; },5000);
}
function clearNotifs(){ try{ if(!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.getRegistrations().then(async regs=>{
    let total=0; const parts=[];
    for(const r of regs){ const w=r.active||r.waiting||r.installing; if(w){ try{ w.postMessage({type:'lmg-clear-notifs'}); }catch(e){} }
      if(r.getNotifications){ try{ const ns=await r.getNotifications(); total+=ns.length; parts.push(((r.active&&r.active.scriptURL||'?').split('/').pop())+':'+ns.length); ns.forEach(n=>n.close()); }catch(e){ parts.push('err'); } }
      else parts.push('noGetNotif');
    }
  }).catch(()=>{});
}catch(e){} }

// 🔔 Push (reusa el SW existente de la página; si no hay, registra firebase-messaging-sw.js)
function pushOn(){ return ('Notification' in window) && Notification.permission==='granted'; }
async function ensureToken(){ try{
  if(!pushOn()) return false; if(!(await isSupported())) return false;
  let existing=null; try{ existing=await navigator.serviceWorker.getRegistration(); }catch(e){}
  if(existing && existing.active) reg=existing; else reg=await navigator.serviceWorker.register('firebase-messaging-sw.js');
  await navigator.serviceWorker.ready;
  if(!msgr) msgr=getMessaging(app);
  const tok=await getToken(msgr,{vapidKey:VAPID_KEY,serviceWorkerRegistration:reg});
  if(tok){ await setDoc(doc(db,'push_tokens',tok),{ token:tok, email:ME, role:MYROLE, lang:'es', ts:new Date().toISOString() }); return true; }
}catch(e){ console.log('lcw push',e); } return false; }
window.lcwEnablePush=async ()=>{ try{
  if(!('Notification' in window)||!(await isSupported())){ alert('Este navegador no soporta notificaciones.'); return; }
  const perm=await Notification.requestPermission(); if(perm!=='granted'){ alert('No diste permiso de notificaciones.'); renderList(); return; }
  const ok=await ensureToken(); renderList(); alert(ok?'🔔 ¡Notificaciones activadas!':'No se pudo activar (¿navegador compatible?).');
}catch(e){ alert('Error: '+((e&&e.message)||e)); } };
function initPush(){ if(pushOn()) ensureToken(); isSupported().then(ok=>{ if(ok){ try{ if(!msgr)msgr=getMessaging(app); onMessage(msgr,()=>{ if(open&&view==='list') renderList(); }); }catch(e){} } }).catch(()=>{});
  if('serviceWorker' in navigator){ navigator.serviceWorker.addEventListener('message',(e)=>{ if(e.data&&e.data.type==='open-chat') window.lcwOpenTo(e.data.channel); }); }
}

onAuthStateChanged(auth,(u)=>{
  const email=((u&&u.email)||'').toLowerCase();
  const role=ROLE_BY_EMAIL[email]||'';
  if(u && role){
    ME=email; MYROLE=role; CH=CH_ALL.filter(c=>c.roles.indexOf(role)>=0);
    build();
    const fab=document.getElementById('lcw-fab'); if(fab) fab.style.display='flex';
    startListeners(); initPush(); badge();
    try{ const cc=new URLSearchParams(location.search).get('chat'); if(cc) setTimeout(()=>window.lcwOpenTo(cc),600); }catch(e){}
  } else {
    const fab=document.getElementById('lcw-fab'); if(fab) fab.style.display='none'; closePanel();
  }
});
