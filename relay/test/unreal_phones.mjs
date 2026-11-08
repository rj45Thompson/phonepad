// Two scripted phones against a running Unreal game with the PhonePad plugin (unreal/PhonePadTest), through the real relay.
// It waits for the game's log to name its room, joins as two phones, plays a fixed script, and writes what it sent.
// unreal/test/run_unreal_test.ps1 starts this, runs the game headless, then checks the game's log against the script.
//   node test/unreal_phones.mjs <game log> <relay url> <result json>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import WebSocket from 'ws';

const [logPath, relay, out] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const origin = new URL(relay).origin;
const steps = [];

async function roomCode() {
  for (let i = 0; i < 240; i++) {
    if (existsSync(logPath)) {
      const m = /PhonePad: room ([A-Z]{4}) open/.exec(readFileSync(logPath, 'utf8'));
      if (m) return m[1];
    }
    await sleep(500);
  }
  throw new Error('the game never logged a room in 120 s');
}

function phone(code) {
  const ws = new WebSocket(relay.replace(/^http/, 'ws') + '/ws/phone/' + code, { origin });
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', id: m.id })); if (m.t === 'seat') ws.seat = m.seat; });
  ws.ready = new Promise((res, rej) => { ws.on('message', (d) => { if (JSON.parse(d.toString()).t === 'seat') res(); }); ws.on('error', rej); });
  ws.pad = (name, b, a = [0, 0, 0, 0], p = [0, 0]) => { ws.send(JSON.stringify({ t: 's', b, a, p })); steps.push({ seat: ws.seat, name, b, a, p, at: Date.now() }); };
  return ws;
}

const code = await roomCode();
console.log('room ' + code);
const p0 = phone(code); await p0.ready;
const p1 = phone(code); await p1.ready;
await sleep(1500);                                 // the engine maps each seat's device on its next poll
const hold = async (ws, name, b, a, p, ms) => { const end = Date.now() + ms; while (Date.now() < end) { ws.pad(name, b, a, p); await sleep(100); } };
const idle = (ws) => ws.pad('release', 0);

await hold(p0, 'A', 1, undefined, undefined, 300); idle(p0); await sleep(300);
await hold(p0, 'stick right 0.8', 0, [0.8, 0, 0, 0], undefined, 300); idle(p0); await sleep(300);
await hold(p0, 'stick up 0.9', 0, [0, -0.9, 0, 0], undefined, 300); idle(p0); await sleep(300);
await hold(p0, 'right trigger 0.6', 1 << 7, undefined, [0, 0.6], 300); idle(p0); await sleep(300);
await hold(p0, 'dpad down held', 1 << 13, undefined, undefined, 750); idle(p0); await sleep(300);
await hold(p1, 'B on seat 1', 1 << 1, undefined, undefined, 300); idle(p1); await sleep(300);
await hold(p0, 'X then the phone leaves', 1 << 2, undefined, undefined, 300);
p0.close(1000, 'phone left while holding X');
await sleep(4000);                                 // two status lines: the plugin's measured round trips
p1.close();
writeFileSync(out, JSON.stringify({ code, steps }, null, 1));
console.log('script done: ' + steps.length + ' messages');
process.exit(0);
