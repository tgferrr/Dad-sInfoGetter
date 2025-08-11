/* Service Worker para o Monitor Roblox
   - Tenta reagir a 'sync' / 'periodicsync' events para fazer checagens quando possível
   - Usa IndexedDB no contexto do worker para escrever dados (mesmo schema)
   - Atenção: nem todos os navegadores permitem periodicSync / background fetch; este SW faz o melhor que pode.
*/

/* ========== IndexedDB helpers (duplicado minimal para o worker) ========== */
const CONFIG = {
  dbName: 'roblox_monitor_v1',
  dbVersion: 1,
  eventsStore: 'events',
  sessionsStore: 'sessions',
};

function openDBWorker() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CONFIG.dbName, CONFIG.dbVersion);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(CONFIG.eventsStore)) {
        const ev = db.createObjectStore(CONFIG.eventsStore, { keyPath: 'id', autoIncrement: true });
        ev.createIndex('byTimestamp', 'timestamp', { unique: false });
        ev.createIndex('byDate', 'date', { unique: false });
        ev.createIndex('byUsername', 'username', { unique: false });
      }
      if (!db.objectStoreNames.contains(CONFIG.sessionsStore)) {
        const ss = db.createObjectStore(CONFIG.sessionsStore, { keyPath: 'id', autoIncrement: true });
        ss.createIndex('byDate', 'date', { unique: false });
        ss.createIndex('byUsername', 'username', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbAddWorker(storeName, record) {
  return openDBWorker().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const st = tx.objectStore(storeName);
    const r = st.add(record);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

/* ========== Worker fetch logic ===========
   Recebe mensagem do main thread com { type:'doCheck', username, useSimulator }
   ou tenta reagir a periodic sync events.
*/

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  self.clients.claim();
});

/* Função utilitária de fetch — muito simples: tentamos pegar userId e presence */
async function fetchRobloxStatusWorker(username) {
  try {
    const getIdUrl = `https://api.roblox.com/users/get-by-username?username=${encodeURIComponent(username)}`;
    const r1 = await fetch(getIdUrl);
    if (!r1.ok) throw new Error('userId fetch failed: ' + r1.status);
    const udata = await r1.json();
    if (udata && udata.Id) {
      const userId = udata.Id;
      const presenceUrl = `https://presence.roblox.com/v1/presence/users?userIds=${userId}`;
      const r2 = await fetch(presenceUrl);
      if (!r2.ok) throw new Error('presence fetch failed: ' + r2.status);
      const pjson = await r2.json();
      const userPresence = (pjson && pjson[0]) ? pjson[0] : null;
      let gameName = null;
      if (userPresence && userPresence.rootPlaceId) gameName = `Jogo (place ${userPresence.rootPlaceId})`;
      const online = !!userPresence && userPresence.userPresenceType && userPresence.userPresenceType !== 0;
      return { ok:true, online, gameName, raw:userPresence };
    } else {
      return { ok:false, reason:'username not found', fallback:true };
    }
  } catch (err) {
    return { ok:false, reason: err.message || String(err), fallback:true };
  }
}

/* Simulador simples */
function simulateStatusWorker(username) {
  const now = Date.now();
  const minute = Math.floor(now / 60000);
  const seed = [...username].reduce((s,c)=>s + c.charCodeAt(0), 0) + minute;
  const rnd = Math.abs(Math.sin(seed)) % 1;
  const online = rnd > 0.45;
  let gameName = null;
  if (online) {
    const games = ['Jogo A','Jogo B','TycoonX','Obby'];
    gameName = games[Math.floor((rnd * 1000) % games.length)];
  }
  return { ok:true, online, gameName, raw:{sim:true} };
}

/* Salvar evento worker-side */
async function workerSaveEvent(username, res, ts) {
  const ev = { username, online: !!res.online, gameName: res.gameName || null, timestamp: ts, date: new Date(ts).toISOString().slice(0,10), createdAt: Date.now() };
  try {
    await dbAddWorker(CONFIG.eventsStore, ev);
    // Se mudança ONLINE->OFFLINE, calcular e salvar session (simplificado):
    // Nota: worker não tem acesso ao runtime state do main, então fazemos aproximação:
    if (!res.online) {
      // tenta encerrar sessão aproximada de 5 minutos (fallback) - isto é apenas tentativa
      // comportamento ideal: main thread harmoniza e cria sessões precisas ao reabrir
      const approxStart = ts - (5*60*1000);
      const session = {
        username,
        startTs: approxStart,
        endTs: ts,
        durationSec: Math.floor((ts - approxStart)/1000),
        date: new Date(approxStart).toISOString().slice(0,10),
        gameName: res.gameName || null,
        createdAt: Date.now()
      };
      await dbAddWorker(CONFIG.sessionsStore, session);
    }
  } catch (err) {
    // nada fazer
  }
}

self.addEventListener('message', (ev) => {
  const d = ev.data || {};
  if (d && d.type === 'doCheck' && d.username) {
    (async ()=> {
      const ts = Date.now();
      let res = null;
      if (d.useSimulator) res = simulateStatusWorker(d.username);
      else res = await fetchRobloxStatusWorker(d.username);
      if (!res.ok && res.fallback) {
        // usar simulador
        res = simulateStatusWorker(d.username);
      }
      await workerSaveEvent(d.username, res, ts);
      // opcional: notificar UI via postMessage
      const clients = await self.clients.matchAll({ includeUncontrolled:true });
      for (const c of clients) {
        c.postMessage({ type:'checked', username:d.username, res, ts });
      }
    })();
  }
});

/* Periodic sync event (quando supportado) */
self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'roblox-check') {
    e.waitUntil((async ()=>{
      // pegar username da storage do client? Não dá fácil; pede mensagem do client.
      // Em vez disso, iteramos clients e solicitamos que enviem username.
      const clients = await self.clients.matchAll({ includeUncontrolled:true });
      for (const c of clients) {
        c.postMessage({ type:'periodicSyncRequest' });
      }
    })());
  }
});

/* Sync event fallback (one-off sync) */
self.addEventListener('sync', (e) => {
  // Sync tag expected from main thread
  if (e.tag && e.tag.startsWith('roblox-check')) {
    e.waitUntil((async ()=>{
      const parts = e.tag.split(':'); // e.g. roblox-check:USERNAME:SIM
      const username = parts[1] || null;
      const useSim = parts[2] === '1';
      if (username) {
        let res = null;
        if (useSim) res = simulateStatusWorker(username);
        else res = await fetchRobloxStatusWorker(username);
        if (!res.ok && res.fallback) res = simulateStatusWorker(username);
        await workerSaveEvent(username, res, Date.now());
      }
    })());
  }
});
