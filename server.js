/**
 * Bot Control Panel - Backend
 * ----------------------------------------------------------------
 * File ini menjembatani panel HTML (frontend) dengan Minecraft yang
 * sesungguhnya lewat mineflayer. Frontend berbicara ke sini lewat
 * WebSocket (path /ws) memakai pesan JSON kecil ({ type: ... }).
 *
 * Jalankan:
 *   npm install
 *   node server.js
 * lalu buka https://reinhard-production.up.railway.app (sudah live di
 * Railway; untuk dev lokal, buka http://localhost:<PORT> sesuai env PORT).
 *
 * CATATAN KEAMANAN: panel ini TIDAK punya login/otentikasi sendiri.
 * Siapa pun yang bisa mengakses port ini bisa mengendalikan semua bot.
 * Jangan expose ke internet tanpa proteksi tambahan (auth/reverse proxy/VPN).
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const mineflayer = require('mineflayer');

const PORT = process.env.PORT || 8080;

// Auto-detect lokasi bot-control-panel.html: bisa di dalam folder public/
// (struktur "ideal" di README) ATAU sejajar langsung dengan server.js
// (kalau file-nya diupload flat, seperti yang paling sering terjadi di Railway).
// Ini menghindari error "Cannot GET /" / 500 kalau strukturnya tidak persis sama.
const CANDIDATE_DIRS = [path.join(__dirname, 'public'), __dirname];
const STATIC_DIR = CANDIDATE_DIRS.find((dir) =>
  fs.existsSync(path.join(dir, 'bot-control-panel.html'))
) || path.join(__dirname, 'public');

log('Menyajikan file statis dari: ' + STATIC_DIR);
if (!fs.existsSync(path.join(STATIC_DIR, 'bot-control-panel.html'))) {
  log('PERINGATAN: bot-control-panel.html TIDAK ditemukan di ' + STATIC_DIR + ' maupun di ' + __dirname + '. Pastikan file ini ikut ter-deploy.');
}

const app = express();
app.use(express.static(STATIC_DIR));
app.get('/', (req, res) => {
  const file = path.join(STATIC_DIR, 'bot-control-panel.html');
  res.sendFile(file, (err) => {
    if (err) {
      res.status(500).send(
        'bot-control-panel.html tidak ditemukan di server. ' +
        'Pastikan file ini ada di repo (boleh sejajar dengan server.js, atau di dalam folder public/).'
      );
    }
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

/** Semua bot yang sedang berjalan. key = botId (string dari frontend, mis. "1", "2"). */
const bots = new Map();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  });
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/**
 * Alasan kick/disconnect dari Minecraft sering berupa JSON chat component
 * (mis. '{"text":"You are not whitelisted on this server!"}'), bukan teks
 * biasa. Dua helper ini mengubahnya jadi teks yang bisa dibaca, supaya
 * toast di panel & log di Railway menunjukkan ALASAN ASLI server memutus
 * bot, bukan cuma pesan generik.
 */
function chatComponentToText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  let out = typeof node.text === 'string' ? node.text : '';
  if (Array.isArray(node.extra)) out += node.extra.map(chatComponentToText).join('');
  if (!out && typeof node.translate === 'string') out = node.translate;
  return out;
}

function formatDisconnectReason(reason) {
  if (reason == null || reason === '') return '';
  if (typeof reason === 'string') {
    try {
      return chatComponentToText(JSON.parse(reason)) || reason;
    } catch (e) {
      return reason; // bukan JSON, tampilkan apa adanya
    }
  }
  return (
    chatComponentToText(reason) ||
    (() => { try { return JSON.stringify(reason); } catch (e) { return String(reason); } })()
  );
}

/**
 * Error koneksi jaringan Node (ECONNREFUSED, ECONNRESET, dst) sering muncul
 * di toast tanpa konteks. Helper ini menambahkan penjelasan singkat supaya
 * tidak perlu tebak-tebakan lagi soal apa penyebabnya.
 */
function explainErrorCode(err) {
  switch (err && err.code) {
    case 'ECONNREFUSED':
      return ' (koneksi ditolak dari awal — cek lagi IP/port-nya, atau server sedang mati)';
    case 'ECONNRESET':
      return ' (sempat nyambung tapi diputus paksa di tengah jalan — bisa karena mismatch versi protokol, atau diblokir server)';
    case 'ETIMEDOUT':
      return ' (server tidak merespons — cek apakah port benar & tidak diblokir firewall)';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return ' (alamat server tidak ditemukan — cek lagi ejaan IP/hostname)';
    default:
      return '';
  }
}

/* ------------------------------------------------------------------ */
/* Helper - fitur serang HANYA menyasar mob/hewan, TIDAK PERNAH pemain  */
/* ------------------------------------------------------------------ */
function isAttackableMob(entity, bot) {
  if (!entity || !bot.entity) return false;
  if (entity === bot.entity) return false;
  if (entity.type === 'player') return false;
  return entity.type === 'mob' || entity.type === 'hostile' || entity.type === 'animal';
}

/* ------------------------------------------------------------------ */
/* Membuat & mengelola satu instance bot                                */
/* ------------------------------------------------------------------ */
function createBot({ botId, host, port, username, password, autoRespawn, antiAfk }) {
  if (bots.has(botId)) {
    destroyBot(botId, false);
  }

  broadcast({ type: 'status', botId, connected: false, message: 'Menghubungkan ke server...' });

  let bot;
  try {
    bot = mineflayer.createBot({
      host,
      port: port || 25565,
      username,
      // Sera MC kelihatannya sudah pindah ke Minecraft 26.2 ("Chaos Cubed"), sedangkan
      // mineflayer baru resmi mendukung sampai 26.1 (satu versi di bawahnya). Tanpa baris
      // ini, mineflayer mencoba auto-detect versi dari server dan gagal paham dengan
      // "26.2" -> koneksi kebentuk tapi lalu diputus mentah tanpa paket kick (persis gejala
      // "Terputus dari server" yang kita lihat). Memaksa ke versi terbaru yang DIKENALI
      // mineflayer ini berpeluang tetap nyambung KALAU Sera MC menjalankan plugin
      // kompatibilitas versi lama seperti ViaVersion/ViaBackwards. Kalau masih tetap gagal
      // setelah ini, itu tandanya server tidak punya backward-compat, dan satu-satunya
      // solusi tuntas adalah menunggu mineflayer resmi rilis dukungan 26.2.
      version: '26.1',
      auth: 'offline', // kasus paling umum untuk panel ini: server offline-mode + plugin AuthMe.
      // Kalau kamu perlu login akun premium/Microsoft, ganti ke 'microsoft', kosongkan
      // password, lalu pantau terminal untuk link+kode login (lihat README).
    });
  } catch (err) {
    broadcast({ type: 'status', botId, connected: false, message: 'Gagal membuat bot: ' + err.message });
    return;
  }

  const entry = {
    bot,
    features: { autoRespawn: false, antiAfk: false, autoFishing: false, autoAttack: false, autoAim: false, autoBack: false },
    intervals: {},
    fishingActive: false,
    attackIntervalMs: 500,
    loggedIn: !password,
  };
  bots.set(botId, entry);

  // Mineflayer akan MELEMPAR & MENJATUHKAN proses Node kalau event 'error' tidak
  // ditangani sama sekali, jadi listener ini wajib ada.
  bot.on('error', (err) => {
    log('Bot ' + botId + ' error:', err && err.stack ? err.stack : err);
    const hint = explainErrorCode(err);
    broadcast({ type: 'status', botId, connected: false, message: 'Error: ' + (err && err.message ? err.message : String(err)) + hint });
    clearAllIntervals(entry);
    bots.delete(botId);
  });

  bot.once('spawn', () => {
    broadcast({ type: 'status', botId, connected: true, message: 'Bergabung ke server' });
    if (password) {
      setTimeout(() => {
        try { bot.chat('/login ' + password); } catch (e) {}
      }, 1200);
    }
    applyFeature(botId, 'autoRespawn', !!autoRespawn);
    applyFeature(botId, 'antiAfk', !!antiAfk);
    sendPlayers(botId);
    sendHealth(botId);
  });

  bot.on('chat', (from, message) => {
    broadcast({ type: 'chatLog', botId, from, message, timestamp: Date.now() });

    // Heuristik login AuthMe: kalau belum "login", coba tebak dari isi pesan server.
    // Sintaks command bisa beda-beda antar plugin auth, sesuaikan kalau perlu.
    if (password && !entry.loggedIn) {
      const lower = message.toLowerCase();
      if (lower.indexOf('regist') !== -1 || lower.indexOf('daftar') !== -1) {
        try { bot.chat('/register ' + password + ' ' + password); } catch (e) {}
      } else if (
        lower.indexOf('logged in') !== -1 ||
        lower.indexOf('login berhasil') !== -1 ||
        lower.indexOf('berhasil login') !== -1 ||
        lower.indexOf('successfully') !== -1
      ) {
        entry.loggedIn = true;
      }
    }
  });

  bot.on('health', () => sendHealth(botId));
  bot.on('playerJoined', () => sendPlayers(botId));
  bot.on('playerLeft', () => sendPlayers(botId));

  bot.on('death', () => {
    broadcast({ type: 'deathLog', botId, timestamp: Date.now() });
    if (entry.features.autoRespawn) {
      try { bot.respawn(); } catch (e) {}
    }
    if (entry.features.autoBack) {
      setTimeout(() => { try { bot.chat('/back'); } catch (e) {} }, 1500);
    }
  });

  bot.on('kicked', (reason, loggedIn) => {
    log('Bot ' + botId + ' di-kick (loggedIn=' + loggedIn + '), reason mentah:', reason);
    const text = formatDisconnectReason(reason);
    broadcast({ type: 'status', botId, connected: false, message: 'Di-kick server: ' + (text || 'tanpa alasan') });
    clearAllIntervals(entry);
    bots.delete(botId);
  });

  bot.on('end', (reason) => {
    if (!bots.has(botId)) return; // sudah ditangani destroyBot/kicked/error di atas
    clearAllIntervals(entry);
    bots.delete(botId);
    log('Bot ' + botId + ' end, reason mentah:', reason);
    const text = formatDisconnectReason(reason);
    broadcast({
      type: 'status',
      botId,
      connected: false,
      message: text
        ? 'Terputus dari server: ' + text
        : 'Terputus dari server (koneksi ditutup tanpa paket kick resmi — kemungkinan diblokir/diputus sebelum sempat login; cek log Railway untuk detail)',
    });
  });
}

function destroyBot(botId, notify) {
  const entry = bots.get(botId);
  if (!entry) return;
  clearAllIntervals(entry);
  bots.delete(botId);
  try { entry.bot.quit(); } catch (e) {}
  if (notify) {
    broadcast({ type: 'status', botId, connected: false, message: 'Bot diputus' });
  }
}

function clearAllIntervals(entry) {
  Object.keys(entry.intervals).forEach((k) => clearInterval(entry.intervals[k]));
  entry.intervals = {};
  entry.fishingActive = false;
}

/* ------------------------------------------------------------------ */
/* Fitur on/off                                                         */
/* ------------------------------------------------------------------ */
function applyFeature(botId, feature, enabled, options) {
  const entry = bots.get(botId);
  if (!entry) return;
  const bot = entry.bot;
  entry.features[feature] = enabled;

  if (feature === 'antiAfk') {
    clearInterval(entry.intervals.antiAfk);
    if (enabled) {
      entry.intervals.antiAfk = setInterval(() => {
        if (!bot.entity) return;
        const yaw = bot.entity.yaw + (Math.random() - 0.5) * 1.2;
        const pitch = (Math.random() - 0.5) * 0.5;
        bot.look(yaw, pitch, true).catch(() => {});
      }, 4000);
    }
  }

  if (feature === 'autoFishing') {
    if (enabled) startFishingLoop(botId);
    else entry.fishingActive = false;
  }

  if (feature === 'autoAttack') {
    clearInterval(entry.intervals.autoAttack);
    if (enabled) {
      entry.attackIntervalMs = (options && options.intervalMs) || entry.attackIntervalMs || 500;
      entry.intervals.autoAttack = setInterval(() => attackNearestMob(botId), entry.attackIntervalMs);
    }
  }

  if (feature === 'autoAim') {
    clearInterval(entry.intervals.autoAim);
    if (enabled) {
      entry.intervals.autoAim = setInterval(() => aimAtNearestMob(botId), 200);
    }
  }
  // autoRespawn & autoBack dibaca langsung dari entry.features saat event 'death' terjadi.
}

async function startFishingLoop(botId) {
  const entry = bots.get(botId);
  if (!entry) return;
  const bot = entry.bot;
  const rod = bot.inventory.items().find((i) => i.name.indexOf('fishing_rod') !== -1);
  if (!rod) {
    broadcast({ type: 'chatLog', botId, from: 'SYSTEM', message: 'Tidak ada fishing rod di inventory bot.', timestamp: Date.now() });
    entry.features.autoFishing = false;
    return;
  }
  try { await bot.equip(rod, 'hand'); } catch (e) {}
  entry.fishingActive = true;
  while (entry.features.autoFishing && entry.fishingActive && bots.get(botId)) {
    try {
      await bot.fish();
    } catch (e) {
      break; // batang pancing hilang / diganggu / bot terputus
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

function attackNearestMob(botId) {
  const entry = bots.get(botId);
  if (!entry || !entry.bot.entity) return;
  const bot = entry.bot;
  const target = bot.nearestEntity((e) => isAttackableMob(e, bot) && bot.entity.position.distanceTo(e.position) < 4);
  if (!target) return;
  const name = target.displayName || target.name || 'mob';
  const targetId = target.id;
  try { bot.attack(target); } catch (e) {}
  setTimeout(() => {
    if (bots.has(botId) && !bot.entities[targetId]) {
      broadcast({ type: 'killLog', botId, mob: name, timestamp: Date.now() });
    }
  }, 400);
}

function aimAtNearestMob(botId) {
  const entry = bots.get(botId);
  if (!entry || !entry.bot.entity) return;
  const bot = entry.bot;
  const target = bot.nearestEntity((e) => isAttackableMob(e, bot) && bot.entity.position.distanceTo(e.position) < 3);
  if (!target) return;
  const height = target.height || 1.6;
  const point = target.position.offset(0, height * 0.85, 0);
  bot.lookAt(point, true).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Aksi manual                                                          */
/* ------------------------------------------------------------------ */
const MOVE_KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sprint'];

function setMove(botId, key, state) {
  const entry = bots.get(botId);
  if (!entry || MOVE_KEYS.indexOf(key) === -1) return;
  try { entry.bot.setControlState(key, !!state); } catch (e) {}
}

function stopAll(botId) {
  const entry = bots.get(botId);
  if (!entry) return;
  MOVE_KEYS.forEach((k) => { try { entry.bot.setControlState(k, false); } catch (e) {} });
}

function doLeftClick(botId) {
  const entry = bots.get(botId);
  if (!entry || !entry.bot.entity) return;
  const bot = entry.bot;
  const target = bot.nearestEntity((e) => isAttackableMob(e, bot) && bot.entity.position.distanceTo(e.position) < 4);
  if (target) {
    try { bot.attack(target); } catch (e) {}
    return;
  }
  try {
    const block = typeof bot.blockAtCursor === 'function' ? bot.blockAtCursor(4) : null;
    if (block) bot.dig(block).catch(() => {});
  } catch (e) {}
}

function doRightClick(botId) {
  const entry = bots.get(botId);
  if (!entry || !entry.bot.entity) return;
  const bot = entry.bot;
  try {
    const block = typeof bot.blockAtCursor === 'function' ? bot.blockAtCursor(4) : null;
    if (block) {
      bot.activateBlock(block).catch(() => {});
    } else {
      bot.activateItem();
    }
  } catch (e) {}
}

function sendChat(botId, message) {
  const entry = bots.get(botId);
  if (!entry) return;
  try { entry.bot.chat(String(message).slice(0, 250)); } catch (e) {}
}

function sendPlayers(botId) {
  const entry = bots.get(botId);
  if (!entry) return;
  broadcast({ type: 'players', botId, players: Object.keys(entry.bot.players || {}) });
}

function sendHealth(botId) {
  const entry = bots.get(botId);
  if (!entry) return;
  broadcast({ type: 'health', botId, health: entry.bot.health, food: entry.bot.food });
}

/* ------------------------------------------------------------------ */
/* WebSocket                                                            */
/* ------------------------------------------------------------------ */
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    handleMessage(ws, msg);
  });
});

function handleMessage(ws, msg) {
  if (!msg || !msg.type) return;

  if (msg.type === 'sync') {
    const summaries = [];
    bots.forEach((entry, id) => {
      summaries.push({
        botId: id,
        connected: !!entry.bot.entity,
        players: Object.keys(entry.bot.players || {}),
        health: entry.bot.health,
        food: entry.bot.food,
      });
    });
    ws.send(JSON.stringify({ type: 'syncData', bots: summaries }));
    return;
  }

  const botId = msg.botId != null ? String(msg.botId) : null;
  if (!botId) return;

  switch (msg.type) {
    case 'connect': {
      const portNum = parseInt(msg.port, 10);
      createBot({
        botId,
        host: String(msg.host || '').trim(),
        port: portNum >= 1 && portNum <= 65535 ? portNum : 25565,
        username: String(msg.username || '').trim().slice(0, 16) || 'Bot' + botId,
        password: msg.password ? String(msg.password) : '',
        autoRespawn: !!msg.autoRespawn,
        antiAfk: !!msg.antiAfk,
      });
      break;
    }
    case 'disconnect':
      destroyBot(botId, true);
      break;
    case 'chat':
      sendChat(botId, msg.message);
      break;
    case 'move':
      setMove(botId, msg.key, msg.state);
      break;
    case 'leftclick':
      doLeftClick(botId);
      break;
    case 'rightclick':
      doRightClick(botId);
      break;
    case 'stopAll':
      stopAll(botId);
      break;
    case 'feature':
      applyFeature(botId, msg.feature, !!msg.enabled, msg.options);
      break;
    case 'refreshPlayers':
      sendPlayers(botId);
      break;
    default:
      break;
  }
}

server.listen(PORT, () => {
  log('Bot Control Panel backend jalan di port ' + PORT + ' (publik: https://reinhard-production.up.railway.app)');
});
