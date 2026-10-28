// Prueba de humo: arranca el servidor y simula jugadores reales por WebSocket. Requiere Node >= 22 (WebSocket global).
const { spawn } = require('child_process'), path = require('path');
const PORT = 3456, CODE = 'CODIGO-TEST';
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, ROOM_CODE: CODE, RECONNECT_GRACE_S: '2', SELF_DESTRUCT_COOLDOWN_S: '3', TEST_RACE_LENGTH: '4500' }, stdio: 'inherit' });
const wait = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
function client(token, name, code = CODE) {
  const c = { msgs: [], snaps: 0, last: null, closed: false }; const ws = c.ws = new WebSocket('ws://localhost:' + PORT + '/ws');
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name, code, token }));
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.t === 's') { c.snaps++; c.last = m; } else c.msgs.push(m); };
  ws.onclose = () => { c.closed = true; }; c.send = o => ws.send(JSON.stringify(o)); return c;
}
const has = (c, t) => c.msgs.find(m => m.t === t), lastLobby = c => [...c.msgs].reverse().find(m => m.t === 'lobby');
(async () => {
  await wait(600);
  const bad = client('token-malo-0001', 'X', 'otro'); await wait(300); ok(has(bad, 'badcode'), 'código incorrecto rechazado por el servidor');
  const T = i => 'token-jugador-000' + i, cs = [0, 1, 2, 3].map(i => client(T(i), 'J' + i)); await wait(500);
  ok(lastLobby(cs[0]).players.length === 4, 'cuatro jugadores en la sala (4/4)');
  const fifth = client(T(9), 'J9'); await wait(300); ok(has(fifth, 'full'), 'quinto jugador: sala llena');
  const dup = client(T(1), 'J1b'); await wait(300);
  ok(has(cs[1], 'kicked') && lastLobby(dup).players.length === 4, 'misma persona en otra pestaña: no ocupa otra plaza (la anterior se cierra)'); cs[1] = dup;
  cs[2].send({ t: 'start' }); await wait(300); ok(!has(cs[0], 'race'), 'un jugador que no es anfitrión no puede iniciar');
  cs[0].send({ t: 'start' }); await wait(1000);
  ok(cs.every(c => has(c, 'race') && c.snaps > 3), 'carrera iniciada y todos reciben instantáneas');
  ok(cs[0].last.cd > 0, 'cuenta atrás sincronizada'); await wait(3300);
  const me = c => c.last.r.find(r => r[0] === cs.indexOf(c)), l0 = me(cs[0])[8];
  cs[0].send({ t: 'lane', d: 1, n: 1 }); cs[0].send({ t: 'lane', d: 1, n: 1 }); await wait(400); // el duplicado (mismo n) se ignora
  ok(me(cs[0])[8] === Math.min(3, l0 + 1), 'cambio de carril aplicado una sola vez (duplicado ignorado)');
  const v1 = me(cs[0])[4]; cs[0].send({ t: 'brake', v: true }); await wait(1200); ok(me(cs[0])[4] < v1, 'el freno reduce la velocidad'); cs[0].send({ t: 'brake', v: false });
  ok(cs[0].last.v.length > 0 && cs[0].last.r.length === 4, 'tráfico y 4 corredores en el mismo estado');
  // ---- autodestrucción ----
  const row = (c, i) => c.last.r.find(r => r[0] === i), e0 = row(cs[0], 0)[9];
  cs[0].send({ t: 'boom', n: 2 }); cs[0].send({ t: 'boom', n: 3 }); await wait(300); // doble clic
  ok(row(cs[0], 0)[9] === e0 + 1 && row(cs[0], 0)[7] === 1, 'autodestrucción: una sola explosión (doble clic = 1 uso) y el fantasma sale del vehículo');
  const ab0 = row(cs[0], 0)[12]; ok(ab0 > 0 && ab0 <= 3000, 'recarga iniciada en el servidor (' + ab0 + ' ms restantes)');
  ok(row(cs[1], 1)[12] === 0 && row(cs[2], 2)[12] === 0, 'las recargas de los demás jugadores son independientes');
  cs[1].send({ t: 'boom', n: 1 }); await wait(300); ok(row(cs[0], 0)[9] === e0 + 1 && row(cs[1], 1)[12] > 0, 'cada jugador solo puede activar la suya');
  await wait(1500); ok(row(cs[0], 0)[7] === 0 && row(cs[0], 0)[10] >= 1, 'el fantasma se teletransporta y vuelve a conducir (mismo sistema de posesión)');
  const ab1 = row(cs[0], 0)[12]; cs[0].send({ t: 'boom', n: 4 }); await wait(300);
  ok(row(cs[0], 0)[9] === e0 + 1 && ab1 > 0 && row(cs[0], 0)[12] <= ab1, 'en recarga se rechaza la habilidad y cambiar de vehículo no la reinicia');
  for (let i = 0; i < 30 && row(cs[0], 0)[12] > 0; i++) await wait(200);
  cs[0].send({ t: 'boom', n: 5 }); await wait(300); ok(row(cs[0], 0)[9] === e0 + 2, 'al completar la recarga se puede volver a usar');
  cs[3].send({ t: 'boom', n: 1 }); await wait(300); const abBefore = row(cs[3], 3)[12]; cs[2].ws.close(); cs[3].ws.close(); await wait(500);
  const back = client(T(3), 'J3'); await wait(500); ok(has(back, 'race') && back.snaps > 0, 'reconexión a mitad de carrera dentro del margen: recupera su corredor'); ok(abBefore > 0 && back.last.r.find(r => r[0] === 3)[12] > 0 && back.last.r.find(r => r[0] === 3)[12] <= abBefore, 'la habilidad conserva su recarga tras reconectar');
  cs[1].ws.close(); back.ws.close(); await wait(3500);
  ok(has(cs[0], 'end') && has(cs[0], 'end').rank.length === 1, 'si los demás abandonan, la carrera termina y gana el que queda');
  const l = lastLobby(cs[0]); ok(l.players.length === 1 && l.st === 'lobby', 'plazas liberadas tras caducar la reconexión');
  const n2 = client(T(5), 'N2'), n3 = client(T(6), 'N3'); await wait(500); ok(lastLobby(n2).players.length === 3, 'nuevos jugadores pueden entrar en las plazas libres');
  cs[0].ws.close(); await wait(400); ok(lastLobby(n2).host !== undefined && lastLobby(n2).players.some(p => p.host), 'si el anfitrión se va, otro jugador pasa a ser anfitrión');
  n2.send({ t: 'start' }); n3.send({ t: 'start' }); await wait(500);
  const starter = lastLobby(n2).host === 1 ? n2 : n3; starter.send({ t: 'start' }); await wait(500);
  const finalOne = has(n2, 'race') || has(n3, 'race'); ok(finalOne, 'el nuevo anfitrión inicia la siguiente carrera'); await wait(3500); n2.send({ t: 'boom', n: 1 }); await wait(300); ok(n2.last.r.find(r => r[0] === 1)[12] > 0, 'la autodestrucción funciona en la carrera siguiente');
  let end = null; for (let i = 0; i < 200 && !end; i++) { await wait(300); end = has(n2, 'end') || has(n3, 'end'); }
  ok(end && end.rank.length === 2, 'la carrera llega a la meta y muestra la clasificación final (' + (end ? end.rank.map(r => r.name + ' E' + r.expl + '/T' + r.tp).join(', ') : 'sin fin') + ')');
  starter.send({ t: 'start' }); await wait(1000); ok(n2.last.cd > 0 && n2.last.r.every(r => r[12] === 0), 'nueva carrera: la habilidad empieza cargada para todos');
  const lateBoom = client(T(7), 'Late'); await wait(200); lateBoom.send({ t: 'boom', n: 1 }); await wait(200); ok(lateBoom.snaps === 0, 'quien no está en la carrera no puede usar la habilidad'); lateBoom.ws.close();
  srv.kill(); console.log(fails ? fails + ' FALLOS' : 'TODO OK'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
