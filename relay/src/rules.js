// rules.js - every check the relay makes, as pure functions (no Worker APIs), so each is tested on its own
// (test/rules.test.mjs). Which use case step each serves is named beside it (USE_CASES.md).
import qrcode from 'qrcode-generator';

// room codes: 4 letters with no look-alikes (no I, O), easy to read off a TV and type on a phone (UC-1.1, UC-1.2)
export const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const CODE_LENGTH = 4;
export const LAYOUTS = ['pad', 'drive'];
export const BUTTONS = 17;                       // the W3C standard gamepad: buttons 0-16 (16 = home)
export const MAX_SEATS = 8;
export const REJOIN_MS = 30000;                  // UC-1 alternate 2c: a phone that drops gets its seat back within this
export const LIMITS = { phoneBytes: 300, hostBytes: 2000, sigBytes: 8000, labelChars: 16, phoneMsgsPerSecond: 120, rumbleMs: 2000 };

export function makeCode(randomBytes) {
  if (!(randomBytes instanceof Uint8Array) || randomBytes.length < CODE_LENGTH) throw new Error('makeCode: needs ' + CODE_LENGTH + ' random bytes');
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_LETTERS[randomBytes[i] % CODE_LETTERS.length];
  return s;
}

export function readCode(s) {                    // a typed code: case and spaces forgiven, anything else refused
  const c = String(s || '').toUpperCase().replace(/\s+/g, '');
  if (c.length !== CODE_LENGTH || [...c].some((ch) => !CODE_LETTERS.includes(ch))) return null;
  return c;
}

export function joinUrl(origin, code) {          // the address the QR code holds; the code rides in the hash, never sent to a server
  return origin.replace(/\/$/, '') + '/#' + code;
}

export function qrBits(text) {                   // UC-1.1: the QR code as rows of 0/1, drawn by each host its own way
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  let bits = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) bits += q.isDark(r, c) ? '1' : '0';
  return { n, bits };
}

const fail = (why) => ({ ok: false, why });

function parse(raw, maxBytes) {
  if (typeof raw !== 'string') return fail('not text');
  if (raw.length > maxBytes) return fail('longer than ' + maxBytes + ' bytes');
  let m;
  try { m = JSON.parse(raw); } catch { return fail('not JSON'); }
  if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') return fail('no message type');
  return { ok: true, m };
}

export function readLabels(labels) {             // { b4: "Handbrake", ... }: which buttons the phone shows, and their names
  if (labels === undefined) return { ok: true, labels: {} };
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return fail('labels is not an object');
  const out = {};
  for (const [k, v] of Object.entries(labels)) {
    const i = /^b(\d{1,2})$/.exec(k);
    if (!i || Number(i[1]) >= BUTTONS) return fail('label key ' + k + ' is not b0-b' + (BUTTONS - 1));
    if (typeof v !== 'string' || !v.trim() || v.length > LIMITS.labelChars) return fail('label ' + k + ' must be 1-' + LIMITS.labelChars + ' characters');
    out[k] = v.trim();
  }
  return { ok: true, labels: out };
}

export function readHello(raw) {                 // UC-1.1: the host's first message sets the room up
  const p = parse(raw, LIMITS.hostBytes);
  if (!p.ok) return p;
  const m = p.m;
  if (m.t !== 'hello') return fail('the first message must be hello');
  if (!LAYOUTS.includes(m.layout)) return fail('layout must be one of ' + LAYOUTS.join(', '));
  if (!Number.isInteger(m.seats) || m.seats < 1 || m.seats > MAX_SEATS) return fail('seats must be a whole number 1-' + MAX_SEATS);
  const l = readLabels(m.labels);
  if (!l.ok) return l;
  return { ok: true, hello: { layout: m.layout, seats: m.seats, labels: l.labels } };
}

const unit = (v, lo) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= 1;

// UC-1.3 alternate 3a: the relay introduces a phone and a web game so they can talk directly (WebRTC). It carries their
// offer, answer and network candidates without reading them beyond their shape.
export function readSignal(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return fail('sig needs a d object');
  if ('sdp' in d) {
    const s = d.sdp;
    if (!s || !['offer', 'answer'].includes(s.type) || typeof s.sdp !== 'string') return fail('sig sdp must be an offer or answer with sdp text');
    return { ok: true, d: { sdp: { type: s.type, sdp: s.sdp } } };
  }
  if ('ice' in d) {
    const c = d.ice;
    if (c === null) return { ok: true, d: { ice: null } };   // the end of the candidates
    if (!c || typeof c.candidate !== 'string') return fail('sig ice must be a candidate or null');
    return { ok: true, d: { ice: { candidate: c.candidate, sdpMid: typeof c.sdpMid === 'string' ? c.sdpMid : null, sdpMLineIndex: Number.isInteger(c.sdpMLineIndex) ? c.sdpMLineIndex : null } } };
  }
  return fail('sig d must hold sdp or ice');
}

export function readPhone(raw) {                 // UC-1.3, 1.5: what a phone may send
  const p = parse(raw, LIMITS.sigBytes);
  if (!p.ok) return p;
  const m = p.m;
  if (m.t === 'sig') { const s = readSignal(m.d); return s.ok ? { ok: true, msg: { t: 'sig', d: s.d } } : s; }
  if (raw.length > LIMITS.phoneBytes) return fail('longer than ' + LIMITS.phoneBytes + ' bytes');
  if (m.t === 's') {                             // the pad's whole state: buttons as bits, 4 stick axes, 2 analog triggers
    if (!Number.isInteger(m.b) || m.b < 0 || m.b >= 2 ** BUTTONS) return fail('b must be a ' + BUTTONS + '-bit button mask');
    if (!Array.isArray(m.a) || m.a.length !== 4 || !m.a.every((v) => unit(v, -1))) return fail('a must be 4 axes in -1..1');
    if (!Array.isArray(m.p) || m.p.length !== 2 || !m.p.every((v) => unit(v, 0))) return fail('p must be 2 triggers in 0..1');
    return { ok: true, msg: { t: 's', b: m.b, a: m.a, p: m.p } };
  }
  if (m.t === 'pong') {
    if (!Number.isInteger(m.id)) return fail('pong needs a whole-number id');
    return { ok: true, msg: { t: 'pong', id: m.id } };
  }
  return fail('a phone cannot send ' + m.t);
}

export function readHost(raw, seats) {           // UC-1.5 and the latency ping: what a host may send once the room is open
  const p = parse(raw, LIMITS.sigBytes);
  if (!p.ok) return p;
  const m = p.m;
  const seatOk = Number.isInteger(m.seat) && m.seat >= 0 && m.seat < seats;
  if (m.t === 'sig') {
    if (!seatOk) return fail('sig needs a seat 0-' + (seats - 1));
    const s = readSignal(m.d);
    return s.ok ? { ok: true, msg: { t: 'sig', seat: m.seat, d: s.d } } : s;
  }
  if (raw.length > LIMITS.hostBytes) return fail('longer than ' + LIMITS.hostBytes + ' bytes');
  if (m.t === 'rumble') {
    if (!seatOk) return fail('rumble needs a seat 0-' + (seats - 1));
    if (!Number.isInteger(m.ms) || m.ms < 1 || m.ms > LIMITS.rumbleMs) return fail('rumble ms must be 1-' + LIMITS.rumbleMs);
    return { ok: true, msg: { t: 'rumble', seat: m.seat, ms: m.ms } };
  }
  if (m.t === 'ping') {
    if (!seatOk) return fail('ping needs a seat 0-' + (seats - 1));
    if (!Number.isInteger(m.id)) return fail('ping needs a whole-number id');
    return { ok: true, msg: { t: 'ping', seat: m.seat, id: m.id } };
  }
  if (m.t === 'layout') {
    if (!LAYOUTS.includes(m.layout)) return fail('layout must be one of ' + LAYOUTS.join(', '));
    const l = readLabels(m.labels);
    if (!l.ok) return l;
    return { ok: true, msg: { t: 'layout', layout: m.layout, labels: l.labels } };
  }
  return fail('a host cannot send ' + m.t);
}

// UC-1.2 and 2c: the seat a joining phone gets. taken = seats with a live phone; held = { seat: { token, leftAt } } for phones
// that dropped. A matching token within REJOIN_MS gets its own seat back; otherwise the lowest seat neither taken nor held.
export function pickSeat({ seats, taken, held, token, now }) {
  for (const [s, h] of Object.entries(held)) {
    const seat = Number(s);
    if (token && h.token === token && now - h.leftAt <= REJOIN_MS && !taken.has(seat)) return { ok: true, seat, rejoin: true };
  }
  for (let seat = 0; seat < seats; seat++) {
    if (taken.has(seat)) continue;
    const h = held[seat];
    if (h && now - h.leftAt <= REJOIN_MS) continue;
    return { ok: true, seat, rejoin: false };
  }
  return { ok: false, why: 'full' };
}

// who may open a socket. Phones: only the relay's own page. Hosts: the listed origins ("*" = any), and, when allowed, a
// program that is not a web page (an Unreal game). Such a program sends no Origin, or the relay's own address as one:
// Unreal's libwebsockets client sets origin = the address it connects to (LwsWebSocket.cpp:805) and sends it with an http://
// prefix whatever the scheme (measured 2026-11-08 with wrangler tail: "http://<relay host>").
// No web page of another site can send this relay's own name, and this relay serves no game page, so that is "not a web page".
export function allowedHost(origin, list, allowNoOrigin, selfOrigin) {
  if (origin && selfOrigin) {
    const host = new URL(selfOrigin).host;
    if (origin === host || origin === 'http://' + host || origin === 'https://' + host) origin = null;
  }
  if (!origin) return allowNoOrigin === true;
  const names = String(list || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!names.length) throw new Error('HOST_ORIGINS is empty');
  return names.includes('*') || names.includes(origin);
}

export function allowedPhone(origin, selfOrigin) {
  return origin === selfOrigin;
}

// a phone that floods is cut off, not slowed: count one second at a time
export function rateOk(counter, now, max) {
  if (now - counter.start >= 1000) { counter.start = now; counter.n = 0; }
  counter.n += 1;
  return counter.n <= max;
}
