/*
  Monitor Roblox - script.js
  Implementa:
   - IndexedDB persistente com stores "events" (raw) e "sessions" (pareados)
   - Checagem periódica (1 minuto) enquanto a página estiver aberta
   - Mecanismo simulador caso CORS/Autenticação impeça chamadas reais
   - UI: tabela paginada, ordenável, filtrável; contadores e export CSV/XLS
   - Service Worker registration e tentativas de Background Sync / Periodic Sync
   - Função setUsername() pública para alterar o usuário monitorado
*/

/* =========================
   CONFIGURAÇÃO / ESTADO
   ========================= */
const CONFIG = {
  pollIntervalMs: 60 * 1000, // 1 minuto
  dbName: 'roblox_monitor_v1',
  dbVersion: 1,
  eventsStore: 'events',     // cada mudança de estado
  sessionsStore: 'sessions', // start/end/duration calculados
  pageSize: 12,
};

// Estado da UI / runtime
let state = {
  username: localStorage.getItem('rb_username') || '', // usuário monitorado
  useSimulator: localStorage.getItem('rb_use_sim') === 'true',
  lastKnownStatus: null, // { online: boolean, game: string|null, ts: number }
  pollingTimer: null,
  currentSessionStart: null, // timestamp
  page: 1,
  sortBy: 'timestamp_desc'
};

/* =========================
   IndexedDB helper simples
   Promise-based, minimal
   ========================= */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CONFIG.dbName, CONFIG.dbVersion);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(CONFIG.eventsStore)) {
        const ev = db.createObjectStore(CONFIG.eventsStore, { keyPath: 'id', autoIncrement: true });
        ev.createIndex('byTimestamp', 'timestamp', { unique: false });
        ev.createIndex('byDate', 'date', { unique: false }); // YYYY-MM-DD
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

function dbAdd(storeName, record) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const st = tx.objectStore(storeName);
    const r = st.add(record);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

function dbPut(storeName, record) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const st = tx.objectStore(storeName);
    const r = st.put(record);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

function dbGetAll(storeName, indexName=null, range=null, direction='prev') {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const st = tx.objectStore(storeName);
    const source = indexName ? st.index(indexName) : st;
    const req = source.getAll(range ? range : undefined);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function dbClear(storeName) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const st = tx.objectStore(storeName);
    const req = st.clear();
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  }));
}

/* =========================
   Utilitários de data/hora
   ========================= */
function toISODate(ts) {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function fmtTime(ts) {
  if (ts == null) return '—';
  const d = new Date(ts);
  return d.toLocaleString();
}

function formatDurationSec(sec) {
  if (!sec || sec < 0) return '00:00:00';
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

/* =========================
   API ROBLOX - real + simulador
   ========================= */

/*
  fetchRobloxStatus(username)

  Tenta pegar status real do usuário por APIs públicas do Roblox.
  Se falhar (CORS, 403, etc), retorna { ok:false, reason, fallback:true }
  Se ok, retorna { ok:true, online: bool, gameName: string|null, raw: {...} }

  OBS: As APIs públicas do Roblox mudam e podem exigir headers/cookies; aqui
  tentamos um endpoint de presença público e caímos no simulador quando necessário.
*/
async function fetchRobloxStatus(username) {
  if (!username) throw new Error('username vazio');

  if (state.useSimulator) {
    return simulateStatus(username);
  }

  try {
    // Exemplo: Roblox friends/presence APIs ou endpoints de presença costumam exigir userId.
    // Passo 1: obter userId pelo username (endpoint público)
    const getIdUrl = `https://apis.roblox.com/users/get-by-username?username=${encodeURIComponent(username)}`;
    const r1 = await fetch(getIdUrl);
    if (!r1.ok) throw new Error('não conseguiu obter userId: ' + r1.status);
    const udata = await r1.json();
    if (udata && udata.Id) {
      const userId = udata.Id;
      // Exemplo de endpoint de presença (pode variar / ter CORS):
      // (Nota: esse é só um exemplo. Se der CORS, o catch tratará.)
      const presenceUrl = `https://presence.roblox.com/v1/presence/users?userIds=${userId}`;
      const r2 = await fetch(presenceUrl);
      if (!r2.ok) throw new Error('não conseguiu obter presença: ' + r2.status);
      const pjson = await r2.json();
      // pjson.users[0].userPresenceType ? 0 offline, 1 online (depende da API)
      const userPresence = (pjson && pjson[0]) ? pjson[0] : null;
      if (!userPresence) {
        return { ok: true, online: false, gameName: null, raw: pjson };
      }
      // tentativa de extrair nome do jogo — a propriedade pode variar
      let gameName = null;
      if (userPresence.rootPlaceId) {
        gameName = `Jogo (place ${userPresence.rootPlaceId})`;
      } else if (userPresence.universeId) {
        gameName = `Jogo (universe ${userPresence.universeId})`;
      } else if (userPresence.gameId) {
        gameName = `Jogo (id ${userPresence.gameId})`;
      }
      const online = !!userPresence.userPresenceType && userPresence.userPresenceType !== 0;
      return { ok:true, online, gameName, raw: userPresence };
    } else {
      // não encontrou userId -> fallback
      return { ok:false, reason: 'username não encontrado', fallback:true };
    }
  } catch (err) {
    // Falha (provavelmente CORS ou endpoint diferente) -> sinalizar fallback
    console.warn('fetchRobloxStatus fallback por erro:', err);
    return { ok:false, reason: err.message || String(err), fallback:true };
  }
}

/* Simulador: gera variações realistas de online/offline para testes */
function simulateStatus(username) {
  // cria um pseudo-rand determinístico por minuto baseado no nome e no minuto atual
  const now = Date.now();
  const minute = Math.floor(now / 60000);
  const seed = [...username].reduce((s,c)=>s + c.charCodeAt(0), 0) + minute;
  const rnd = Math.abs(Math.sin(seed)) % 1;
  const online = rnd > 0.4; // ~60% chance online
  let gameName = null;
  if (online) {
    const games = ['Jogo A', 'Jogo B', 'City Adventure', 'Tycoon X', 'Obby Fun'];
    gameName = games[Math.floor((rnd * 1000) % games.length)];
  }
  return Promise.resolve({ ok:true, online, gameName, raw:{sim:true} });
}

/* =========================
   Registro de eventos e sessões
   ========================= */

/*
  addStatusEvent(username, online, gameName, ts)
  - Salva um evento "raw" indicando que o usuário mudou / foi consultado
  - Atualiza também o store de "sessions" quando há pairing online->offline
*/
async function addStatusEvent(username, online, gameName, ts = Date.now()) {
  const date = toISODate(ts);
  const ev = {
    username,
    online,
    gameName: gameName || null,
    timestamp: ts,
    date,
    createdAt: Date.now()
  };
  await dbAdd(CONFIG.eventsStore, ev);
  addLog(`Evento salvo: ${username} — ${online ? 'ONLINE' : 'OFFLINE'} — ${gameName || '-'}`);
  // Atualizar sessions: se passou a ONLINE, iniciamos current session; se passou a OFFLINE, encerramos e salvamos sessão.
  if (online) {
    // Iniciar sessão se não houver sessão em andamento
    if (!state.currentSessionStart) {
      state.currentSessionStart = ts;
      state.lastKnownStatus = { online, gameName, ts };
      // também guardar um event de start (já gravado acima)
    } else {
      // já estava online - possivelmente apenas atualização de jogoName -> atualizar lastKnown
      state.lastKnownStatus = { online, gameName, ts };
    }
  } else {
    // passou para offline
    if (state.currentSessionStart) {
      const start = state.currentSessionStart;
      const end = ts;
      const durationSec = Math.max(0, Math.floor((end - start) / 1000));
      const session = {
        username,
        startTs: start,
        endTs: end,
        durationSec,
        gameName: state.lastKnownStatus && state.lastKnownStatus.gameName ? state.lastKnownStatus.gameName : gameName || null,
        date: toISODate(start),
        createdAt: Date.now()
      };
      await dbAdd(CONFIG.sessionsStore, session);
      addLog(`Sessão salva: ${formatDurationSec(durationSec)} — ${session.gameName || '-'}`);
      state.currentSessionStart = null;
      state.lastKnownStatus = { online, gameName, ts };
    } else {
      // estava offline já — só atualiza lastKnownStatus
      state.lastKnownStatus = { online, gameName, ts };
    }
  }
}

/* Ao abrir a página, tentamos "reconstruir" sessões pendentes:
   - Se havia um session em andamento (nunca gravamos na store enquanto online),
     podemos checar o último evento salvo e, se ele foi ONLINE, considerar que a sessão
     começou naquele timestamp. Em reabertura, se ainda estiver ONLINE, mantemos
     o start; se estiver OFFLINE, pegamos o tempo de fim como o ts do evento atual.
*/
async function repairStateFromDB() {
  // pegar último evento salvo para o usuário
  const all = await dbGetAll(CONFIG.eventsStore);
  const forUser = all.filter(e => e.username === state.username).sort((a,b)=>a.timestamp-b.timestamp);
  if (forUser.length === 0) return;
  const lastEv = forUser[forUser.length - 1];
  if (lastEv.online) {
    // sessão provavelmente começou em lastEv.timestamp
    state.currentSessionStart = lastEv.timestamp;
    state.lastKnownStatus = { online: true, gameName: lastEv.gameName, ts: lastEv.timestamp };
  } else {
    state.currentSessionStart = null;
    state.lastKnownStatus = { online: false, gameName: null, ts: lastEv.timestamp };
  }
}

/* Quando a página reabre, queremos "preencher" a lacuna entre última checagem e agora.
   Estratégia:
     - Pegar último evento salvo (se existir)
     - Se último evento foi ONLINE e agora estamos OFFLINE: criar sessão com end = último offline detectado
     - Se último evento foi ONLINE e agora ainda ONLINE: mantemos sessão (start = ultimo online)
     - Se último evento foi OFFLINE e agora ONLINE: iniciar uma nova sessão com start = agora
     - Caso haja um longo gap e o usuário ficou ONLINE por várias horas, não conseguimos saber exatamente,
       então fazemos a melhor aproximação: assume status contínuo entre timestamps.
*/
async function onReopenFillGap(currentStatus, nowTs=Date.now()) {
  try {
    const all = await dbGetAll(CONFIG.eventsStore);
    const forUser = all.filter(e => e.username === state.username).sort((a,b)=>a.timestamp-b.timestamp);
    const lastEv = forUser.length ? forUser[forUser.length - 1] : null;
    if (!lastEv) {
      // nenhum dado anterior -> só gravar evento atual
      await addStatusEvent(state.username, currentStatus.online, currentStatus.gameName, nowTs);
      return;
    }
    // Se último evento for mais antigo que agora:
    if (lastEv.online && !currentStatus.online) {
      // usuário estava online e agora offline -> criar session: start = lastEv.timestamp, end = nowTs
      const start = lastEv.timestamp;
      const end = nowTs;
      const durationSec = Math.max(0, Math.floor((end - start) / 1000));
      const session = {
        username: state.username,
        startTs: start,
        endTs: end,
        durationSec,
        gameName: lastEv.gameName || currentStatus.gameName || null,
        date: toISODate(start),
        createdAt: Date.now()
      };
      await dbAdd(CONFIG.sessionsStore, session);
      // salvar também o evento atual (offline)
      await dbAdd(CONFIG.eventsStore, {
        username: state.username, online: false, gameName: currentStatus.gameName || null, timestamp: nowTs, date: toISODate(nowTs), createdAt: Date.now()
      });
      addLog(`Lacuna preenchida com sessão: ${formatDurationSec(durationSec)}`);
    } else {
      // Caso geral: apenas adicionar evento atual e ajustar state
      await dbAdd(CONFIG.eventsStore, {
        username: state.username, online: currentStatus.online, gameName: currentStatus.gameName || null, timestamp: nowTs, date: toISODate(nowTs), createdAt: Date.now()
      });
    }
    // finalmente, reparar estado runtime
    await repairStateFromDB();
  } catch (err) {
    console.error('Erro ao preencher lacuna:', err);
    addLog('Erro ao preencher lacuna: ' + err.message);
  }
}

/* =========================
   Polling loop e lógica principal
   ========================= */

async function checkAndRecord() {
  if (!state.username) {
    addLog('Nenhum usuário definido — esperando setUsername()');
    return;
  }
  const ts = Date.now();
  const res = await fetchRobloxStatus(state.username);
  if (!res.ok && res.fallback) {
    addLog(`API real indisponível: ${res.reason}. Usando simulador.`);
    // se API real falhou e fallback, usamos simulador
    state.useSimulator = true;
    localStorage.setItem('rb_use_sim','true');
    const sim = await simulateStatus(state.username);
    await onStatusResult(sim, ts);
  } else if (!res.ok) {
    addLog(`Erro API: ${res.reason}`);
  } else {
    await onStatusResult(res, ts);
  }
}

async function onStatusResult(res, ts) {
  const online = !!res.online;
  const game = res.gameName || null;
  // comparar com lastKnownStatus
  if (!state.lastKnownStatus) {
    // primeira vez
    await addStatusEvent(state.username, online, game, ts);
  } else {
    const lastOnline = !!state.lastKnownStatus.online;
    if (lastOnline !== online || (online && state.lastKnownStatus.gameName !== game)) {
      // houve mudança de status ou mudança de jogo -> gravar evento
      await addStatusEvent(state.username, online, game, ts);
    } else {
      // sem mudança -> opcionalmente atualizar um "heartbeat" (gravamos menos frequentemente)
      // Para economizar escrita, só gravamos heartbeat a cada 30 minutos
      const lastTs = state.lastKnownStatus.ts || 0;
      if (ts - lastTs > 30 * 60 * 1000) {
        await dbAdd(CONFIG.eventsStore, {
          username: state.username, online, gameName: game, timestamp: ts, date: toISODate(ts), createdAt: Date.now(), heartbeat:true
        });
        addLog('Heartbeat gravado para manter histórico');
        state.lastKnownStatus.ts = ts;
      } else {
        // nada a fazer
      }
    }
  }
  // atualizar estado runtime
  state.lastKnownStatus = { online, gameName: game, ts };
  // atualizar UI
  updateUILive(online, game);
}

/* Start/stop polling while page is visible */
function startPolling() {
  stopPolling();
  // taxa conservadora: executar imediatamente, depois a cada pollIntervalMs
  checkAndRecord().catch(err => console.error(err));
  state.pollingTimer = setInterval(()=> {
    checkAndRecord().catch(err => console.error(err));
  }, CONFIG.pollIntervalMs);
  addLog('Polling iniciado a cada ' + (CONFIG.pollIntervalMs/1000) + 's');
}

function stopPolling() {
  if (state.pollingTimer) {
    clearInterval(state.pollingTimer);
    state.pollingTimer = null;
    addLog('Polling parado');
  }
}

/* Quando a aba ficar visível novamente, repara lacunas e reinicia polling */
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    addLog('Aba visível — reparando lacunas e reiniciando polling');
    try {
      // consultar status uma vez e preencher lacuna
      const res = state.useSimulator ? await simulateStatus(state.username) : await fetchRobloxStatus(state.username);
      const ts = Date.now();
      if (res.ok !== false) {
        await onReopenFillGap(res, ts);
      }
    } catch (err) {
      console.warn('Erro ao reparar lacuna:', err);
    }
    startPolling();
  } else {
    // aba oculta: podemos diminuir frequência ou pausar para economizar bateria
    addLog('Aba oculta — pausando polling para economizar recursos');
    stopPolling();
  }
});

/* =========================
   UI: atualização ao vivo + render histórico
   ========================= */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function addLog(msg) {
  const logs = $('#logs');
  const now = new Date().toLocaleTimeString();
  logs.textContent = `[${now}] ${msg}\n` + logs.textContent;
}

function updateUILive(online, game) {
  $('#liveStatus').textContent = `Status: ${online ? 'ONLINE' : 'OFFLINE'}`;
  $('#liveStatus').style.color = online ? 'var(--accent-2)' : 'var(--muted)';
  // atualiza currentSession display
  if (online) {
    if (!state.currentSessionStart) {
      state.currentSessionStart = state.lastKnownStatus ? state.lastKnownStatus.ts : Date.now();
    }
    // mostrar contador que atualiza a cada segundo
    startLiveSessionTimer();
  } else {
    stopLiveSessionTimer();
  }
  // recarregar tabela/ resumo
  renderSummaryToday();
  renderTable();
}

let liveTimerHandle = null;
function startLiveSessionTimer() {
  stopLiveSessionTimer();
  liveTimerHandle = setInterval(()=> {
    renderSummaryToday();
    renderCurrentSession();
  }, 1000);
}

function stopLiveSessionTimer() {
  if (liveTimerHandle) {
    clearInterval(liveTimerHandle);
    liveTimerHandle = null;
  }
}

async function calcTotalOnlineForDate(dateStr) {
  // soma durationSec em sessionsStore com date = dateStr
  const all = await dbGetAll(CONFIG.sessionsStore);
  const forUser = all.filter(s => s.username === state.username && s.date === dateStr);
  const totalSec = forUser.reduce((acc,s)=>acc + (s.durationSec || 0), 0);
  // Também, se há sessão em andamento que começou hoje, adicioná-la:
  if (state.currentSessionStart && toISODate(state.currentSessionStart) === dateStr) {
    const addSec = Math.floor((Date.now() - state.currentSessionStart)/1000);
    return totalSec + addSec;
  }
  return totalSec;
}

async function renderSummaryToday() {
  const today = toISODate(Date.now());
  const totSec = await calcTotalOnlineForDate(today);
  $('#todayTotal').textContent = formatDurationSec(totSec);
}

function renderCurrentSession() {
  const el = $('#currentSession');
  if (state.currentSessionStart) {
    const sec = Math.floor((Date.now() - state.currentSessionStart)/1000);
    el.textContent = formatDurationSec(sec) + (state.lastKnownStatus && state.lastKnownStatus.gameName ? ' — ' + state.lastKnownStatus.gameName : '');
  } else {
    el.textContent = '—';
  }
}

/* Render tabela paginada ordenável/filtrável */
async function renderTable() {
  const tbody = $('#historyTable tbody');
  tbody.innerHTML = '';
  // pegar sessões (mais informativas que eventos)
  const allSessions = await dbGetAll(CONFIG.sessionsStore);
  let rows = allSessions.filter(s => s.username === state.username);
  // filtros:
  const dateFilter = $('#filterDate').value;
  if (dateFilter) rows = rows.filter(r => r.date === dateFilter);
  const gameFilter = $('#filterGame').value.trim().toLowerCase();
  if (gameFilter) rows = rows.filter(r => (r.gameName || '').toLowerCase().includes(gameFilter));
  const searchText = $('#searchText').value.trim().toLowerCase();
  if (searchText) {
    rows = rows.filter(r => {
      return (r.gameName || '').toLowerCase().includes(searchText)
        || formatDurationSec(r.durationSec).includes(searchText)
        || formatDateForSearch(r.startTs).includes(searchText);
    });
  }
  // ordenação
  const sortBy = $('#sortBy').value || state.sortBy;
  rows.sort((a,b)=> {
    switch(sortBy){
      case 'timestamp_asc': return a.startTs - b.startTs;
      case 'duration_desc': return (b.durationSec||0) - (a.durationSec||0);
      case 'duration_asc': return (a.durationSec||0) - (b.durationSec||0);
      default: // timestamp_desc
        return b.startTs - a.startTs;
    }
  });
  // paginação
  const page = state.page || 1;
  const pageSize = CONFIG.pageSize;
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  state.page = Math.min(page, totalPages);
  const startIdx = (state.page - 1) * pageSize;
  const pageRows = rows.slice(startIdx, startIdx + pageSize);
  // preencher
  for (const s of pageRows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${fmtTime(s.startTs)}</td>
      <td>${fmtTime(s.endTs)}</td>
      <td>${formatDurationSec(s.durationSec)}</td>
      <td>${s.gameName || '-'}</td>
      <td>session</td>
    `;
    tbody.appendChild(tr);
  }
  $('#pageInfo').textContent = `${state.page} / ${totalPages}`;
}

/* Helper para pesquisa de data em sessões */
function formatDateForSearch(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString();
}

/* Event handlers UI */
function attachUI() {
  $('#setUserBtn').addEventListener('click', ()=> {
    const v = $('#usernameInput').value.trim();
    if (!v) return alert('Informe o nome do usuário Roblox (username).');
    setUsername(v);
  });
  $('#resetBtn').addEventListener('click', async ()=> {
    if (!confirm('Resetar todo o histórico local para o usuário atual?')) return;
    await dbClear(CONFIG.eventsStore);
    await dbClear(CONFIG.sessionsStore);
    state.currentSessionStart = null;
    state.lastKnownStatus = null;
    addLog('Histórico limpo pelo usuário');
    renderTable();
    renderSummaryToday();
  });
  $('#exportCsv').addEventListener('click', exportCsv);
  $('#exportXls').addEventListener('click', exportXls);
  $('#filterDate').addEventListener('change', ()=> { state.page=1; renderTable(); });
  $('#filterGame').addEventListener('input', ()=> { state.page=1; renderTable(); });
  $('#sortBy').addEventListener('change', ()=> { state.page=1; renderTable(); });
  $('#searchText').addEventListener('input', ()=> { state.page=1; renderTable(); });
  $('#prevPage').addEventListener('click', ()=> { state.page = Math.max(1, state.page - 1); renderTable(); });
  $('#nextPage').addEventListener('click', ()=> { state.page = state.page + 1; renderTable(); });
  $('#useSim').addEventListener('change', (e)=> {
    state.useSimulator = e.target.checked;
    localStorage.setItem('rb_use_sim', state.useSimulator ? 'true' : 'false');
    addLog('Use simulator: ' + state.useSimulator);
  });
}

/* =========================
   Export CSV / XLS
   ========================= */

async function exportCsv() {
  const sessions = await dbGetAll(CONFIG.sessionsStore);
  const rows = sessions.filter(s => s.username === state.username).sort((a,b)=>a.startTs-b.startTs);
  const header = ['username','start','end','duration_sec','duration_hms','date','gameName'];
  const lines = [header.join(',')];
  for (const s of rows) {
    const line = [
      `"${s.username}"`,
      `"${new Date(s.startTs).toISOString()}"`,
      `"${new Date(s.endTs).toISOString()}"`,
      s.durationSec,
      `"${formatDurationSec(s.durationSec)}"`,
      `"${s.date}"`,
      `"${(s.gameName || '').replace(/"/g,'""')}"`
    ].join(',');
    lines.push(line);
  }
  const csv = lines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${state.username || 'roblox'}_history.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* Export XLS (simples): gera HTML table com MIME type 'application/vnd.ms-excel'
   Excel geralmente abre este arquivo. Não é verdadeiro .xlsx mas funciona offline. */
async function exportXls() {
  const sessions = await dbGetAll(CONFIG.sessionsStore);
  const rows = sessions.filter(s => s.username === state.username).sort((a,b)=>a.startTs-b.startTs);
  let html = `<table><tr><th>username</th><th>start</th><th>end</th><th>duration</th><th>date</th><th>gameName</th></tr>`;
  for (const s of rows) {
    html += `<tr>
      <td>${s.username}</td>
      <td>${new Date(s.startTs).toISOString()}</td>
      <td>${new Date(s.endTs).toISOString()}</td>
      <td>${formatDurationSec(s.durationSec)}</td>
      <td>${s.date}</td>
      <td>${(s.gameName || '')}</td>
    </tr>`;
  }
  html += `</table>`;
  const blob = new Blob([html], { type: 'application/vnd.ms-excel' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${state.username || 'roblox'}_history.xls`;
  a.click();
  URL.revokeObjectURL(url);
}

/* =========================
   Public API
   ========================= */

/*
  setUsername(username)
  - função única para trocar o usuário monitorado (pedida)
  - persiste no localStorage
*/
async function setUsername(username) {
  username = String(username || '').trim();
  if (!username) {
    alert('Username inválido');
    return;
  }
  state.username = username;
  localStorage.setItem('rb_username', username);
  $('#usernameInput').value = username;
  addLog('Usuário definido: ' + username);
  // recuperar estado do DB e iniciar polling
  await repairStateFromDB();
  // checar status imediatamente e preencher lacunas
  try {
    const res = state.useSimulator ? await simulateStatus(username) : await fetchRobloxStatus(username);
    if (res.ok !== false) {
      await onReopenFillGap(res, Date.now());
    } else {
      addLog('Falha ao obter status inicial: ' + (res.reason || 'unknown'));
    }
  } catch (err) {
    console.warn('Erro obtendo status inicial:', err);
  }
  // start polling
  startPolling();
  // UI
  renderTable();
  renderSummaryToday();
}

/* expose setUsername global para o usuário executar via console */
window.setUsername = setUsername;

/* =========================
   Service Worker registration e tentativas de Background Sync
   ========================= */

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    addLog('Service Worker não suportado no navegador.');
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register('sw.js', { scope: './' });
    addLog('Service Worker registrado.');
    // tentar registrar periodic sync se suportado
    if ('periodicSync' in reg) {
      try {
        // Pedido de permissão pode ser necessário
        await reg.periodicSync.register('roblox-check', { minInterval: 60 * 1000 });
        addLog('Periodic Sync registrado (quando suportado pelo navegador).');
      } catch (err) {
        console.warn('Periodic Sync falhou:', err);
      }
    }
  } catch (err) {
    console.warn('Registro SW falhou:', err);
    addLog('Registro SW falhou: ' + err.message);
  }
}

/* =========================
   Inicialização
   ========================= */

window.addEventListener('load', async () => {
  attachUI();
  // preencher UI se username já salvo
  if (state.username) {
    $('#usernameInput').value = state.username;
    setTimeout(()=> setUsername(state.username), 50);
  }
  $('#useSim').checked = state.useSimulator;
  // render table once
  renderTable();
  renderSummaryToday();
  // registrar service worker (opcional)
  registerServiceWorker();
});

/* =========================
   Observações e utilitários finais
   ========================= */

/* Nota: este script tenta gravar sessões ao detectar transições ONLINE -> OFFLINE.
   Enquanto o usuário estiver online e a página fechada, os navegadores não fornecem
   garantia de executar código JS em background. Usamos Service Worker + periodicSync
   quando disponível para tentar checar em background, mas muitos navegadores desktop/mobile
   limitam ou não implementam essas APIs. Portanto:
    - ideal: deixar a página aberta (ou ao menos reabri-la com frequência)
    - a cada reabertura, fazemos reconciliation (onReopenFillGap) para preencher lacunas
*/

