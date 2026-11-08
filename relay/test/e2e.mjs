// The real relay (src/worker.js + src/room.js) under `wrangler dev`, driven by sockets that play a game and its phones.
// Each check is a use case step or alternate. Run: node test/e2e.mjs            (local wrangler dev on :8831)
//                                              node test/e2e.mjs --remote <url> (a deployed relay; adds latency figures)
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import WebSocket from 'ws';

const remote = process.argv.includes('--remote') ? process.argv[process.argv.indexOf('--remote') + 1] : null;
const PORT = 8831;
const BASE = remote || 'http://127.0.0.1:' + PORT;
const WSBASE = BASE.replace(/^http/, 'ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, detail = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : '')); if (!ok) fails++; };

function sock(path, origin) {                      // a socket with an inbox: every message kept, waited on by type
  const ws = new WebSocket(WSBASE + path, origin ? { origin } : {});
  ws.inbox = []; ws.waiters = [];
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); ws.inbox.push(m); ws.waiters = ws.waiters.filter((w) => !w(m)); });
  ws.closed = new Promise((res) => ws.on('close', (code, reason) => res({ code, reason: reason.toString() })));
  ws.failed = new Promise((res) => ws.on('unexpected-response', (req, r) => res(r.statusCode)));
  ws.next = (t, ms = 5000) => new Promise((res, rej) => {
    const i = ws.inbox.findIndex((m) => m.t === t);
    if (i >= 0) return res(ws.inbox.splice(i, 1)[0]);
    const timer = setTimeout(() => rej(new Error('no ' + t + ' within ' + ms + ' ms')), ms);
    ws.waiters.push((m) => { if (m.t !== t) return false; ws.inbox.splice(ws.inbox.indexOf(m), 1); clearTimeout(timer); res(m); return true; });
  });
  ws.json = (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m));
  return ws;
}
const opened = (ws) => new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

async function startDev() {
  const dir = '.e2e-state/' + process.pid;
  mkdirSync(dir, { recursive: true });
  const p = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', dir], { shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  let log = '';
  p.stdout.on('data', (d) => { log += d; }); p.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    try { if ((await fetch(BASE + '/health')).ok) return { p, dir }; } catch { /* not up yet */ }
  }
  console.log(log.slice(-3000));
  throw new Error('wrangler dev did not answer /health in 60 s');
}

async function main() {
  const dev = remote ? null : await startDev();
  const self = new URL(BASE).origin;
  try {
    const health = await (await fetch(BASE + '/health')).json();
    check('health answers', health.ok === true && health.version === 1, JSON.stringify(health));
    const page = await fetch(BASE + '/');
    check('the controller page is served', page.ok && (await page.text()).includes('pad.js'));
    const lib = await fetch(BASE + '/phonepad-host.js');
    check('phonepad-host.js is served to any page (CORS *)', lib.ok && lib.headers.get('access-control-allow-origin') === '*', 'acao=' + lib.headers.get('access-control-allow-origin'));

    // 1a / origins
    const evil = sock('/ws/host', 'https://evil.example');
    check('a host page not on HOST_ORIGINS is refused', (await evil.failed) === 403);
    const strayPhone = sock('/ws/phone/ABCD', 'https://evil.example');
    check('a phone not on the relay\'s own page is refused', (await strayPhone.failed) === 403);

    // UC-1.1
    const host = sock('/ws/host');                 // no Origin, as an Unreal game connects
    await opened(host);
    host.json({ t: 'hello', layout: 'drive', seats: 2, labels: { b4: 'Handbrake', b9: 'Reset' } });
    const room = await host.next('room');
    check('UC-1.1 the room opens with a 4-letter code, a join address and a QR code', /^[A-HJ-NP-Z]{4}$/.test(room.code) && room.join === self + '/#' + room.code && room.qr.bits.length === room.qr.n ** 2, room.code + ' ' + room.join);

    // 2a
    const lost = sock('/ws/phone/' + (room.code === 'ZZZZ' ? 'YYYY' : 'ZZZZ'), self);
    const lostErr = await lost.next('error');
    check('2a a wrong code is told no_room and closed', lostErr.why === 'no_room' && (await lost.closed).code === 4004);

    // UC-1.2
    const p0 = sock('/ws/phone/' + room.code.toLowerCase(), self);
    const seat0 = await p0.next('seat');
    const join0 = await host.next('join');
    check('UC-1.2 a phone gets seat 0 with the layout and labels, and the game hears it join', seat0.seat === 0 && seat0.layout === 'drive' && seat0.labels.b4 === 'Handbrake' && join0.seat === 0 && join0.rejoin === false);

    // UC-1.3
    const state = { t: 's', b: (1 << 4) | (1 << 7), a: [-0.42, 0, 0, 0], p: [0, 0.875] };
    const t0 = performance.now();
    p0.json(state);
    const got = await host.next('s');
    const oneWay = performance.now() - t0;
    check('UC-1.3 the phone\'s state reaches the game whole, with its seat', got.seat === 0 && got.b === state.b && got.a[0] === -0.42 && got.p[1] === 0.875, 'phone->relay->game ' + oneWay.toFixed(1) + ' ms');

    // ping
    host.json({ t: 'ping', seat: 0, id: 11 });
    const ping = await p0.next('ping');
    p0.json({ t: 'pong', id: ping.id });
    const pong = await host.next('pong');
    check('a ping comes back from the phone with its seat', pong.id === 11 && pong.seat === 0);

    // 3a: the direct link's set-up goes both ways through the relay, untouched
    host.json({ t: 'sig', seat: 0, d: { sdp: { type: 'offer', sdp: 'v=0 offer' } } });
    const offer = await p0.next('sig');
    p0.json({ t: 'sig', d: { sdp: { type: 'answer', sdp: 'v=0 answer' } } });
    const answer = await host.next('sig');
    check('3a an offer reaches the phone and its answer reaches the game with the seat', offer.d.sdp.sdp === 'v=0 offer' && answer.seat === 0 && answer.d.sdp.type === 'answer');

    // UC-1.5
    host.json({ t: 'rumble', seat: 0, ms: 120 });
    check('UC-1.5 a rumble reaches the phone', (await p0.next('rumble')).ms === 120);
    host.json({ t: 'rumble', seat: 1, ms: 120 });
    check('a rumble for an empty seat is reported to the game, not dropped', /no phone in seat 1/.test((await host.next('error')).why));

    // second phone, full room
    const p1 = sock('/ws/phone/' + room.code, self);
    const seat1 = await p1.next('seat');
    check('a second phone gets seat 1', seat1.seat === 1 && (await host.next('join')).seat === 1);
    const p2 = sock('/ws/phone/' + room.code, self);
    check('2b a phone over the seat count is told full', (await p2.next('error')).why === 'full' && (await p2.closed).code === 4009);

    // layout change
    host.json({ t: 'layout', layout: 'pad', labels: {} });
    check('the game can switch every phone to another layout', (await p0.next('layout')).layout === 'pad' && (await p1.next('layout')).layout === 'pad');

    // 2c rejoin
    p0.close(1000, 'screen locked');
    check('UC-1.6 the game hears a phone leave', (await host.next('leave')).seat === 0);
    const p0b = sock('/ws/phone/' + room.code + '?token=' + encodeURIComponent(seat0.token), self);
    const back = await p0b.next('seat');
    check('2c the phone that dropped gets its own seat back', back.seat === 0 && (await host.next('join')).rejoin === true);

    // a bad message
    p1.json({ t: 's', b: 0, a: [0, 0, 0], p: [0, 0] });
    const bad = await p1.next('error');
    check('a malformed state is refused with its rule and the phone is cut off', /4 axes/.test(bad.why) && (await p1.closed).code === 4400 && (await host.next('leave')).seat === 1);

    // flood (seat 1 is held for the phone just cut off, so the room is full to anyone else: it comes back with its token)
    const stranger = sock('/ws/phone/' + room.code, self);
    check('a seat held for a dropped phone is not given to another', (await stranger.next('error')).why === 'full');
    const p3 = sock('/ws/phone/' + room.code + '?token=' + encodeURIComponent(seat1.token), self);
    await p3.next('seat'); await host.next('join');
    for (let i = 0; i < 200; i++) p3.json({ t: 's', b: 0, a: [0, 0, 0, 0], p: [0, 0] });
    check('a phone flooding past 120 messages a second is cut off', (await p3.closed).code === 4029);

    // 6a
    host.close(1000, 'game over');
    check('6a when the game closes, its phones are told', (await p0b.next('host_gone')).t === 'host_gone');

    if (remote) {                                  // what a phone on a real relay costs: the round trip game -> phone -> game
      const h = sock('/ws/host');
      await opened(h);
      h.json({ t: 'hello', layout: 'pad', seats: 1 });
      const r = await h.next('room');
      const ph = sock('/ws/phone/' + r.code, new URL(BASE).origin);
      await ph.next('seat');
      ph.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.t === 'ping') ph.json({ t: 'pong', id: m.id }); });
      const rtts = [];
      for (let i = 0; i < 30; i++) { const t = performance.now(); h.json({ t: 'ping', seat: 0, id: i }); await h.next('pong'); rtts.push(performance.now() - t); }
      rtts.sort((a, b) => a - b);
      console.log('LATENCY round trip game->relay->phone->relay->game, 30 pings from this PC: median ' + rtts[15].toFixed(1) + ' ms, worst ' + rtts[29].toFixed(1) + ' ms');
      h.close();
    }
  } finally {
    if (dev) { spawn('taskkill', ['/PID', String(dev.p.pid), '/T', '/F']); await sleep(1500); try { rmSync(dev.dir, { recursive: true, force: true }); } catch { /* workerd still holds it; next run uses its own dir */ } }
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.log('FAIL ' + e.message); process.exit(1); });
