// Every rule in src/rules.js. Run: node --test test/rules.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../src/rules.js';

test('UC-1.1: a room code is 4 letters with no look-alikes, and a typed code is forgiven case and spaces only', () => {
  const c = R.makeCode(new Uint8Array([0, 23, 24, 255]));
  assert.equal(c, 'AZAR');                         // 0->A, 23->Z, 24 wraps to A, 255 % 24 = 15 -> R (the 16th letter once I and O are gone)
  assert.ok(!/[IO]/.test(R.CODE_LETTERS));
  assert.equal(R.readCode(' k d r x '), 'KDRX');
  assert.equal(R.readCode('KDR'), null);
  assert.equal(R.readCode('KDRI'), null, 'I is not a code letter');
  assert.equal(R.readCode('KD1X'), null);
  assert.throws(() => R.makeCode(new Uint8Array(2)), /random bytes/);
});

test('UC-1.1: the join address carries the code in the hash, and the QR code is square 0/1 rows', () => {
  assert.equal(R.joinUrl('https://r.example/', 'KDRX'), 'https://r.example/#KDRX');
  const q = R.qrBits('https://r.example/#KDRX');
  assert.ok(q.n >= 21 && (q.n - 17) % 4 === 0, 'a QR side is 17 + 4 x version modules');
  assert.equal(q.bits.length, q.n * q.n);
  assert.match(q.bits, /^[01]+$/);
  assert.equal(q.bits.slice(0, 7), '1111111', 'the top-left finder pattern starts with 7 dark modules');
});

test('UC-1.1: the host\'s hello is read, and each broken rule is named', () => {
  const ok = R.readHello(JSON.stringify({ t: 'hello', layout: 'drive', seats: 4, labels: { b4: 'Handbrake', b9: 'Reset' } }));
  assert.deepEqual(ok, { ok: true, hello: { layout: 'drive', seats: 4, labels: { b4: 'Handbrake', b9: 'Reset' } } });
  const why = (m) => R.readHello(typeof m === 'string' ? m : JSON.stringify(m)).why;
  assert.match(why('{'), /not JSON/);
  assert.match(why({ t: 'ping' }), /first message must be hello/);
  assert.match(why({ t: 'hello', layout: 'wheel', seats: 2 }), /layout must be/);
  assert.match(why({ t: 'hello', layout: 'pad', seats: 0 }), /seats must be/);
  assert.match(why({ t: 'hello', layout: 'pad', seats: 9 }), /seats must be/);
  assert.match(why({ t: 'hello', layout: 'pad', seats: 2, labels: { b17: 'x' } }), /b0-b16/);
  assert.match(why({ t: 'hello', layout: 'pad', seats: 2, labels: { b4: 'a label far too long' } }), /1-16 characters/);
  assert.match(why('x'.repeat(R.LIMITS.hostBytes + 1)), /longer than/);
});

test('UC-1.3: a phone\'s state is read whole, or refused with the rule it broke', () => {
  const s = R.readPhone(JSON.stringify({ t: 's', b: 2 ** 16 + 1, a: [0, -1, 0.5, 1], p: [0, 0.75] }));
  assert.deepEqual(s, { ok: true, msg: { t: 's', b: 2 ** 16 + 1, a: [0, -1, 0.5, 1], p: [0, 0.75] } });
  const why = (m) => R.readPhone(JSON.stringify(m)).why;
  assert.match(why({ t: 's', b: 2 ** 17, a: [0, 0, 0, 0], p: [0, 0] }), /17-bit/);
  assert.match(why({ t: 's', b: 1.5, a: [0, 0, 0, 0], p: [0, 0] }), /17-bit/);
  assert.match(why({ t: 's', b: 0, a: [0, 0, 0], p: [0, 0] }), /4 axes/);
  assert.match(why({ t: 's', b: 0, a: [0, 0, 0, 1.01], p: [0, 0] }), /4 axes/);
  assert.match(why({ t: 's', b: 0, a: [0, 0, 0, 0], p: [-0.1, 0] }), /2 triggers/);
  assert.match(why({ t: 's', b: 0, a: [0, 0, 0, 0], p: [0, null] }), /2 triggers/);
  assert.match(why({ t: 'rumble', seat: 0, ms: 5 }), /phone cannot send rumble/);
  assert.equal(R.readPhone(JSON.stringify({ t: 'pong', id: 7 })).msg.id, 7);
  assert.match(R.readPhone(JSON.stringify({ t: 's', b: 0, a: [0, 0, 0, 0], p: [0, 0], pad: 'x'.repeat(R.LIMITS.phoneBytes) })).why, /longer than 300/);
  assert.match(R.readPhone('x'.repeat(R.LIMITS.sigBytes + 1)).why, /longer than 8000/, 'nothing past the signal limit is even parsed');
});

test('UC-1.5: what a host may send, and to which seats', () => {
  assert.deepEqual(R.readHost(JSON.stringify({ t: 'rumble', seat: 1, ms: 200 }), 2).msg, { t: 'rumble', seat: 1, ms: 200 });
  assert.match(R.readHost(JSON.stringify({ t: 'rumble', seat: 2, ms: 200 }), 2).why, /seat 0-1/);
  assert.match(R.readHost(JSON.stringify({ t: 'rumble', seat: 0, ms: 0 }), 2).why, /ms must be/);
  assert.deepEqual(R.readHost(JSON.stringify({ t: 'ping', seat: 0, id: 3 }), 1).msg, { t: 'ping', seat: 0, id: 3 });
  assert.deepEqual(R.readHost(JSON.stringify({ t: 'layout', layout: 'pad' }), 1).msg, { t: 'layout', layout: 'pad', labels: {} });
  assert.match(R.readHost(JSON.stringify({ t: 's', b: 0 }), 1).why, /host cannot send s/);
});

test('UC-1.2 and alternate 2c: seats go lowest-free, a dropped phone gets its own seat back in time, a full room says so', () => {
  const now = 100000;
  assert.deepEqual(R.pickSeat({ seats: 4, taken: new Set(), held: {}, token: '', now }), { ok: true, seat: 0, rejoin: false });
  assert.deepEqual(R.pickSeat({ seats: 4, taken: new Set([0, 1]), held: {}, token: '', now }), { ok: true, seat: 2, rejoin: false });
  const held = { 0: { token: 'T0', leftAt: now - 1000 } };
  assert.deepEqual(R.pickSeat({ seats: 4, taken: new Set(), held, token: 'T0', now }), { ok: true, seat: 0, rejoin: true });
  assert.deepEqual(R.pickSeat({ seats: 4, taken: new Set(), held, token: 'other', now }), { ok: true, seat: 1, rejoin: false }, 'a held seat is kept for its owner');
  const stale = { 0: { token: 'T0', leftAt: now - R.REJOIN_MS - 1 } };
  assert.deepEqual(R.pickSeat({ seats: 4, taken: new Set(), held: stale, token: 'other', now }), { ok: true, seat: 0, rejoin: false }, 'after REJOIN_MS the seat is free');
  assert.deepEqual(R.pickSeat({ seats: 4, taken: new Set(), held: stale, token: 'T0', now }), { ok: true, seat: 0, rejoin: false }, 'too late to rejoin: a new seat, not a rejoin');
  assert.deepEqual(R.pickSeat({ seats: 2, taken: new Set([0]), held: { 1: { token: 'T1', leftAt: now } }, token: '', now }), { ok: false, why: 'full' });
});

test('alternate 3a: the direct link\'s set-up messages are carried by shape, both ways, and only to a real seat', () => {
  const offer = { t: 'sig', seat: 0, d: { sdp: { type: 'offer', sdp: 'v=0\r\n' + 'a'.repeat(3000) } } };
  assert.deepEqual(R.readHost(JSON.stringify(offer), 1).msg, offer, 'an SDP is longer than an ordinary host message and still passes');
  assert.match(R.readHost(JSON.stringify({ ...offer, seat: 1 }), 1).why, /seat 0-0/);
  assert.match(R.readHost(JSON.stringify({ t: 'sig', seat: 0, d: { sdp: { type: 'pranswer', sdp: '' } } }), 1).why, /offer or answer/);
  const ice = { t: 'sig', d: { ice: { candidate: 'candidate:1 1 udp 2122260223 abc.local 50000 typ host', sdpMid: '0', sdpMLineIndex: 0 } } };
  assert.deepEqual(R.readPhone(JSON.stringify(ice)).msg, ice);
  assert.deepEqual(R.readPhone(JSON.stringify({ t: 'sig', d: { ice: null } })).msg, { t: 'sig', d: { ice: null } }, 'null ends the candidates');
  assert.match(R.readPhone(JSON.stringify({ t: 'sig', d: { other: 1 } })).why, /sdp or ice/);
  assert.match(R.readPhone(JSON.stringify({ t: 'sig', d: { sdp: { type: 'answer', sdp: 'x'.repeat(R.LIMITS.sigBytes) } } })).why, /longer than 8000/);
  assert.match(R.readPhone(JSON.stringify({ t: 'pong', id: 1, pad: 'x'.repeat(R.LIMITS.phoneBytes) })).why, /longer than 300/, 'only sig gets the bigger limit');
});

test('who may open a socket', () => {
  assert.equal(R.allowedHost('https://game.example', 'https://game.example, http://localhost:8080', false), true);
  assert.equal(R.allowedHost('https://evil.example', 'https://game.example', false), false);
  assert.equal(R.allowedHost('https://game.example.evil.example', 'https://game.example', false), false);
  assert.equal(R.allowedHost('https://any.example', '*', false), true);
  assert.equal(R.allowedHost(null, 'https://a.example', true), true, 'an Unreal game sends no Origin');
  assert.equal(R.allowedHost(null, 'https://a.example', false), false);
  assert.throws(() => R.allowedHost('https://a.example', ' ', false), /HOST_ORIGINS is empty/);
  const self = 'https://relay.example';
  assert.equal(R.allowedHost('relay.example', 'https://a.example', true, self), true, 'Unreal (libwebsockets) sends the relay\'s host as its Origin');
  assert.equal(R.allowedHost('https://relay.example', 'https://a.example', true, self), true);
  assert.equal(R.allowedHost('http://relay.example', 'https://a.example', true, self), true, 'measured: Unreal sends http://<relay host> over wss');
  assert.equal(R.allowedHost('relay.example', 'https://a.example', false, self), false, 'still only when programs are allowed');
  assert.equal(R.allowedHost('https://relay.example.evil', 'https://a.example', true, self), false);
  assert.equal(R.allowedPhone('https://relay.example', 'https://relay.example'), true);
  assert.equal(R.allowedPhone('https://other.example', 'https://relay.example'), false);
  assert.equal(R.allowedPhone(null, 'https://relay.example'), false);
});

test('a phone over the message rate is cut off within the second', () => {
  const c = { start: 0, n: 0 };
  let last = true;
  for (let i = 0; i < R.LIMITS.phoneMsgsPerSecond; i++) last = R.rateOk(c, 500, R.LIMITS.phoneMsgsPerSecond);
  assert.equal(last, true);
  assert.equal(R.rateOk(c, 600, R.LIMITS.phoneMsgsPerSecond), false);
  assert.equal(R.rateOk(c, 1000, R.LIMITS.phoneMsgsPerSecond), true, 'a new second starts the count again');
});
