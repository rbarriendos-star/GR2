'use strict';
// GHOST RACE online: servidor HTTP + WebSocket (implementación mínima propia, sin dependencias).
// El servidor es la autoridad: simula con public/core.js (misma lógica del juego original) y envía instantáneas.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]; } } catch (e) {}
const Core = require('./public/core.js'), { KEYS, COLS, CFG } = Core, E = process.env;
const PORT = +E.PORT || 3000, ROOM_CODE = E.ROOM_CODE || 'FANTASMA', MAX = 4;
const LEVEL = Math.min(2, Math.max(0, (E.TRAFFIC_LEVEL === undefined || E.TRAFFIC_LEVEL === '' ? 1 : +E.TRAFFIC_LEVEL) | 0));
const GRACE = (+E.RECONNECT_GRACE_S || 15) * 1000, ORIGINS = (E.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const GOAL = +E.TEST_RACE_LENGTH || Core.GOAL; // TEST_RACE_LENGTH solo para pruebas automáticas
// Recarga de la autodestrucción, en segundos y medida con el reloj del servidor. Cambia este valor por defecto o usa SELF_DESTRUCT_COOLDOWN_S.
const SELF_DESTRUCT_COOLDOWN_S = +E.SELF_DESTRUCT_COOLDOWN_S > 0 ? +E.SELF_DESTRUCT_COOLDOWN_S : 10, SD_MS = SELF_DESTRUCT_COOLDOWN_S * 1000;
if (!E.ROOM_CODE) console.warn('AVISO: usando el código por defecto "FANTASMA". Define ROOM_CODE.');

// ---------- HTTP estático (carpeta public/) ----------
const PUB = path.join(__dirname, 'public'), MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.ico': 'image/x-icon', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let u; try { u = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e) { res.writeHead(400).end(); return; }
  if (u === '/healthz') { res.end('ok'); return; }
  if (u === '/') u = '/index.html';
  const f = path.join(PUB, path.normalize(u));
  if (!f.startsWith(PUB + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404).end('404'); return; } res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(d); });
});

// ---------- WebSocket mínimo (texto, sin fragmentación) ----------
const conns = new Set();
const eq = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());
class Conn {
  constructor(sock) { this.sock = sock; this.buf = Buffer.alloc(0); this.open = true; this.p = null; this.fails = 0; this.win = 0; this.cnt = 0; this.alive = true; conns.add(this);
    sock.setNoDelay(true); sock.on('data', d => this.onData(d)); sock.on('close', () => this.onClose()); sock.on('error', () => sock.destroy()); }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]); if (this.buf.length > 4096) return this.close();
    while (this.buf.length >= 2) {
      const b = this.buf, op = b[0] & 15; let len = b[1] & 127, off = 2;
      if (!(b[1] & 128) || len > 126) return this.close(); // el cliente debe enmascarar; mensajes pequeños
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; if (len > 1024) return this.close(); }
      if (b.length < off + 4 + len) return;
      const mk = b.slice(off, off + 4), data = Buffer.from(b.slice(off + 4, off + 4 + len)); for (let i = 0; i < len; i++) data[i] ^= mk[i & 3];
      this.buf = b.slice(off + 4 + len);
      if (op === 8) return this.close(); if (op === 9) { this.frame(10, data); continue; } if (op === 10) { this.alive = true; continue; }
      if (op === 1 && (b[0] & 128)) this.onMsg(data.toString('utf8'));
    }
  }
  frame(op, data) { if (!this.open || data.length > 65535) return; if (this.sock.writableLength > 1e6) return this.close(); const n = data.length, h = n < 126 ? Buffer.from([128 | op, n]) : Buffer.from([128 | op, 126, n >> 8, n & 255]); this.sock.write(Buffer.concat([h, data])); }
  sendRaw(s) { this.frame(1, Buffer.from(s)); } send(o) { this.sendRaw(JSON.stringify(o)); }
  close() { if (!this.open) return; this.frame(8, Buffer.alloc(0)); this.open = false; this.sock.end(); }
  onClose() { this.open = false; conns.delete(this); drop(this); }
  onMsg(s) {
    const now = Date.now(); if (now - this.win > 1000) { this.win = now; this.cnt = 0; } if (++this.cnt > 60) return; // límite de mensajes por segundo
    let m; try { m = JSON.parse(s); } catch (e) { return; } if (!m || typeof m.t !== 'string') return;
    if (m.t === 'join') return join(this, m);
    const p = this.p; if (!p) return;
    if (m.t === 'start') return start(p);
    const r = room.st === 'race' && room.racers.get(p.slot); if (!r) return;
    if (m.t === 'brake') r.brake = m.v === true;
    else if (m.t === 'lane' && room.cd <= 0 && r.st === 'drive') {
      if ((m.d !== -1 && m.d !== 1) || !Number.isInteger(m.n) || m.n <= p.lastN) return; // acciones inválidas / duplicadas
      p.lastN = m.n; r.lane = Math.max(0, Math.min(3, r.lane + m.d));
    } else if (m.t === 'boom' && room.cd <= 0 && r.st === 'drive') { // autodestrucción: el cliente solo la solicita; el servidor valida y controla la recarga
      if (!Number.isInteger(m.n) || m.n <= p.lastN) return; p.lastN = m.n; // duplicados ignorados
      const now = Date.now(); if (now < p.readyAt) return; // en recarga
      if (r.selfDestruct()) p.readyAt = now + SD_MS; // consume la habilidad una sola vez (el estado es del jugador, no del vehículo)
    }
  }
}
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if ((req.url || '').split('?')[0] !== '/ws' || String(req.headers.upgrade).toLowerCase() !== 'websocket' || !key || conns.size >= 40 || (ORIGINS.length && !ORIGINS.includes(req.headers.origin || ''))) { sock.destroy(); return; }
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64') + '\r\n\r\n');
  new Conn(sock);
});
setInterval(() => { for (const c of conns) { if (!c.alive) { c.sock.destroy(); continue; } c.alive = false; c.frame(9, Buffer.alloc(0)); } }, 20000);

// ---------- Sala única ----------
const room = { players: Array(MAX).fill(null), st: 'lobby', host: -1, world: null, racers: new Map(), cd: 0, clock: 0 };
const live = p => (p && p.conn && p.conn.open ? p.conn : null);
function lobbyMsg() {
  const m = { t: 'lobby', st: room.st, host: room.host, players: room.players.filter(Boolean).map(p => ({ id: p.slot, name: p.name, host: p.slot === room.host, on: !!live(p) })) };
  for (const p of room.players) { const c = live(p); if (c) c.send(m); }
}
function raceInfo(p) { const c = live(p); if (c) c.send({ t: 'race', cool: SD_MS, players: [...room.racers.values()].map(r => ({ id: r.id, name: r.name })) }); }
function join(c, m) {
  if (c.p) return;
  if (typeof m.code !== 'string' || !eq(m.code.trim(), ROOM_CODE)) { c.send({ t: 'badcode' }); if (++c.fails >= 5) c.close(); return; } // el código se comprueba SOLO aquí
  const token = String(m.token || ''); if (!/^[A-Za-z0-9-]{8,64}$/.test(token)) { c.send({ t: 'err', m: 'Identificador no válido' }); return; }
  const name = String(m.name || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 12) || 'Jugador';
  let p = room.players.find(q => q && q.token === token);
  if (p) { const old = p.conn; if (old && old !== c) { old.p = null; old.send({ t: 'kicked' }); old.close(); } p.conn = c; p.gone = 0; } // misma persona: reconexión o 2.ª pestaña => una sola plaza
  else {
    const slot = room.players.indexOf(null); if (slot < 0) { c.send({ t: 'full' }); c.close(); return; }
    p = { slot, token, name, conn: c, gone: 0, joined: Date.now(), lastN: 0, readyAt: 0 }; room.players[slot] = p; if (room.host < 0) room.host = slot;
  }
  c.p = p; c.send({ t: 'welcome', id: p.slot });
  if (room.st === 'race' && room.racers.has(p.slot)) raceInfo(p);
  lobbyMsg();
}
function removePlayer(p, quiet) {
  room.players[p.slot] = null; room.racers.delete(p.slot);
  if (room.host === p.slot) { const n = room.players.filter(live).sort((a, b) => a.joined - b.joined)[0] || room.players.find(Boolean); room.host = n ? n.slot : -1; } // el anfitrión se traspasa
  if (!quiet) lobbyMsg();
}
function drop(c) {
  const p = c.p; if (!p || p.conn !== c) return; p.conn = null;
  if (room.st === 'race' && room.racers.has(p.slot)) { p.gone = Date.now(); lobbyMsg(); } else removePlayer(p);
}
function start(p) {
  if (p.slot !== room.host || room.st === 'race') return;
  const act = room.players.filter(live); if (act.length < 2) { live(p).send({ t: 'err', m: 'Hacen falta al menos 2 jugadores' }); return; }
  const w = new Core.World((Date.now() % 1e6) + 1, LEVEL); room.world = w; room.racers.clear();
  for (const q of act) { q.lastN = 0; q.readyAt = 0; /* habilidad cargada al empezar */ room.racers.set(q.slot, new Core.Racer(q.slot, { n: q.name, c: CFG[q.slot].c, b: CFG[q.slot].b }, false, w)); }
  room.st = 'race'; room.cd = 3; room.clock = 0; for (const q of act) raceInfo(q); lobbyMsg();
}
function finish(rs) { // rs ordenado por progreso (el primero gana)
  const rank = rs.map(r => ({ id: r.id, name: r.name, expl: r.expl, tp: r.tp })), ids = rs.map(r => r.id);
  room.st = 'lobby'; room.world = null; room.racers.clear();
  for (const p of room.players) if (p && !live(p)) removePlayer(p, true);
  for (const id of ids) { const c = live(room.players[id]); if (c) c.send({ t: 'end', rank }); }
  lobbyMsg();
}
const abil = r => { const p = room.players[r.id]; return p ? Math.max(0, p.readyAt - Date.now()) | 0 : 0; }; // ms de recarga restantes
function snapshot(rs) {
  const w = room.world, m = {
    t: 's', cd: +Math.max(0, room.cd).toFixed(2), clock: +room.clock.toFixed(2),
    r: rs.map(r => [r.id, KEYS.indexOf(r.type), +r.x.toFixed(1), Math.round(r.y), Math.round(r.st === 'ghost' && r.target ? 0 : r.v), r.hp, +r.inv.toFixed(2), r.st === 'ghost' ? 1 : 0, r.lane, r.expl, r.tp, +r.gt.toFixed(2), abil(r)]),
    v: w.tr.filter(t => !t.dead).map(t => [t.id, KEYS.indexOf(t.t), Math.round(t.x), Math.round(t.y), COLS.indexOf(t.col), Math.round(t.v)]), e: w.ev
  }; w.ev = [];
  const s = JSON.stringify(m); for (const r of rs) { const c = live(room.players[r.id]); if (c) c.sendRaw(s); }
}
let last = Date.now(), tk = 0;
setInterval(() => { // 30 Hz de simulación, 15 Hz de instantáneas
  const now = Date.now(), dt = Math.min(.1, (now - last) / 1000); last = now;
  for (const p of room.players) if (p && p.gone && now - p.gone > GRACE) removePlayer(p); // libera la plaza al caducar la reconexión
  if (room.st !== 'race') return;
  const rs = [...room.racers.values()];
  if (!rs.length) { room.st = 'lobby'; room.world = null; lobbyMsg(); return; }
  if (rs.length === 1) { finish(rs); return; } // los demás abandonaron: gana el que queda
  if (room.cd > 0) room.cd -= dt;
  else {
    room.clock += dt; for (const r of rs) r.update(dt);
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) Core.racerBump(rs[i], rs[j]);
    const ys = rs.map(r => r.y); room.world.update(dt, Math.min(...ys), Math.max(...ys));
    if (rs.some(r => r.y >= GOAL)) { finish(rs.sort((a, b) => b.y - a.y)); return; }
  }
  if (++tk % 2 === 0) snapshot(rs);
}, 33);
server.listen(PORT, () => console.log('GHOST RACE online escuchando en el puerto ' + PORT));
