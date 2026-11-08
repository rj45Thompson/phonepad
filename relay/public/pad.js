// pad.js - the phone's controller page (UC-1.2-1.6). It holds one gamepad's state in the W3C "standard" layout (17 buttons,
// 4 stick axes, the 2 triggers as analog values) and sends it the moment it changes, at most once every 15 ms, and once a
// second while nothing changes so the game can tell a live phone from a sleeping one. Sending never waits for a screen frame.
// Classes: PadState (the state), Link (the socket), StickControl / ButtonControl / PedalControl / SteerSlider (touch),
// TiltSteer (steering by turning the phone), ControllerPage (screens and layouts).

const $ = (id) => document.getElementById(id);
const q3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const buzz = (ms) => { if (navigator.vibrate) navigator.vibrate(ms); };   // Android browsers vibrate; iPhone Safari has no vibrate

class PadState {
  constructor(onChange) { this.b = 0; this.latch = 0; this.wire = 0; this.a = [0, 0, 0, 0]; this.p = [0, 0]; this.dirty = true; this.onChange = onChange; }
  changed() { this.dirty = true; this.onChange(); }
  button(i, down) {                               // a press is latched until sent, so a tap shorter than a message gap still reaches the game
    const b = down ? this.b | (1 << i) : this.b & ~(1 << i);
    if (down) this.latch |= 1 << i;
    if (b !== this.b) { this.b = b; this.changed(); }
  }
  axis(i, v) { v = q3(clamp(v, -1, 1)); if (v !== this.a[i]) { this.a[i] = v; this.changed(); } }
  trigger(i, v) {                                 // trigger 0 = button 6 (left), 1 = button 7 (right); the bit follows the value
    v = q3(clamp(v, 0, 1));
    if (v !== this.p[i]) { this.p[i] = v; this.changed(); }
    this.button(6 + i, v > 0);
  }
  clear() { this.b = 0; this.latch = 0; this.a = [0, 0, 0, 0]; this.p = [0, 0]; this.dirty = true; }
  message() { this.wire = this.b | this.latch; return JSON.stringify({ t: 's', b: this.wire, a: this.a, p: this.p }); }
  sent() { this.latch = 0; this.dirty = this.wire !== this.b; }   // a tap already let go: its release goes in the next message
}

// DirectLink (UC-1.3 alternate 3a): when a web game offers it, the phone and the game talk straight to each other over
// WebRTC, on the same Wi-Fi without the relay in between. The relay only carries the offer, the answer and the network
// candidates. Until the channel opens, or if it never does, input goes through the relay and the game shows which path.
class DirectLink {
  constructor(link) { this.link = link; this.pc = null; this.dc = null; }
  get open() { return this.dc !== null && this.dc.readyState === 'open'; }
  async signal(d) {
    if (d.sdp && d.sdp.type === 'offer') {
      this.close();
      const pc = this.pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] });
      pc.onicecandidate = (e) => this.link.sendRelay(JSON.stringify({ t: 'sig', d: { ice: e.candidate ? e.candidate.toJSON() : null } }));
      pc.ondatachannel = (e) => {
        const dc = this.dc = e.channel;
        dc.onopen = () => this.link.page.path('direct');
        dc.onclose = () => { if (this.dc === dc) { this.dc = null; this.link.page.path('relay'); } };
        dc.onmessage = (ev) => this.link.onMessage(JSON.parse(ev.data), true);
      };
      await pc.setRemoteDescription(d.sdp);
      await pc.setLocalDescription(await pc.createAnswer());
      this.link.sendRelay(JSON.stringify({ t: 'sig', d: { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } } }));
    } else if ('ice' in d && this.pc) {
      await this.pc.addIceCandidate(d.ice === null ? undefined : d.ice);
    }
  }
  send(s) { this.dc.send(s); }
  close() { if (this.pc) this.pc.close(); this.pc = null; this.dc = null; }
}

class Link {                                      // one socket to the relay; takes its seat back after a drop (alternate 2c)
  constructor(page) { this.page = page; this.ws = null; this.code = null; this.token = null; this.until = 0; this.closedOnPurpose = false; this.direct = new DirectLink(this); }
  open(code) {
    this.code = code;
    try { this.token = sessionStorage.getItem('phonepad:' + code); } catch { this.token = null; }
    this.until = 0;
    this.connect();
  }
  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = proto + '//' + location.host + '/ws/phone/' + encodeURIComponent(this.code) + (this.token ? '?token=' + encodeURIComponent(this.token) : '');
    const ws = new WebSocket(url);
    this.ws = ws;
    this.closedOnPurpose = false;
    ws.onmessage = (e) => this.onMessage(JSON.parse(e.data));
    ws.onclose = (e) => this.onClose(e);
  }
  onMessage(m, direct = false) {
    if (m.t === 'seat') {
      this.token = m.token;
      try { sessionStorage.setItem('phonepad:' + this.code, m.token); } catch { /* private mode: a rejoin gets a new seat */ }
      this.until = 0;
      this.page.seated(m);
    } else if (m.t === 'ping') {                  // answered on the path it came by, so the game measures that path
      const pong = JSON.stringify({ t: 'pong', id: m.id });
      if (direct) this.direct.send(pong); else this.sendRelay(pong);
    } else if (m.t === 'sig') this.direct.signal(m.d).catch((e) => this.page.status('Direct link failed: ' + e.message));
    else if (m.t === 'rumble') buzz(m.ms);
    else if (m.t === 'layout') this.page.layout(m.layout, m.labels);
    else if (m.t === 'host_gone') { this.closedOnPurpose = true; this.page.ended('The game has closed.'); }
    else if (m.t === 'error') {
      this.closedOnPurpose = true;
      const say = { no_room: 'No game with code ' + this.code + ' is open. Check the code on the game\'s screen.', full: 'The game is full.' };
      this.page.ended(say[m.why] || 'The relay refused: ' + m.why);
    }
  }
  onClose(e) {
    this.direct.close();
    if (this.closedOnPurpose) return;
    const now = Date.now();
    if (!this.until) this.until = now + 30000;
    if (now > this.until) return this.page.ended('Lost the connection to the game.');
    this.page.status('Reconnecting...');
    setTimeout(() => this.connect(), 1000);
  }
  send(s) {                                       // the pad's state: straight to the game when the direct link is open
    if (this.direct.open) { this.direct.send(s); return true; }
    return this.sendRelay(s);
  }
  sendRelay(s) { if (this.ws && this.ws.readyState === 1) { this.ws.send(s); return true; } return false; }
  close() { this.closedOnPurpose = true; this.direct.close(); if (this.ws) this.ws.close(1000, 'left'); }
}

class StickControl {                              // a floating stick: it centres where the thumb lands
  constructor(zone, onMove) {
    this.zone = zone; this.onMove = onMove; this.id = null; this.r = 50;
    this.base = Object.assign(document.createElement('div'), { className: 'stickBase' });
    this.knob = Object.assign(document.createElement('div'), { className: 'stickKnob' });
    this.base.hidden = this.knob.hidden = true;
    zone.append(this.base, this.knob);
    zone.addEventListener('pointerdown', (e) => {
      if (this.id !== null) return;
      this.id = e.pointerId; zone.setPointerCapture(e.pointerId);
      const b = zone.getBoundingClientRect();
      this.cx = e.clientX - b.left; this.cy = e.clientY - b.top;
      this.place(this.base, this.cx, this.cy); this.place(this.knob, this.cx, this.cy);
      this.base.hidden = this.knob.hidden = false;
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.id) return;
      const b = zone.getBoundingClientRect();
      let dx = e.clientX - b.left - this.cx, dy = e.clientY - b.top - this.cy;
      const d = Math.hypot(dx, dy);
      if (d > this.r) { dx *= this.r / d; dy *= this.r / d; }
      this.place(this.knob, this.cx + dx, this.cy + dy);
      this.onMove(dx / this.r, dy / this.r);       // W3C: axis 1 is positive DOWN
    });
    const end = (e) => { if (e.pointerId !== this.id) return; this.id = null; this.base.hidden = this.knob.hidden = true; this.onMove(0, 0); };
    zone.addEventListener('pointerup', end); zone.addEventListener('pointercancel', end);
  }
  place(el, x, y) { el.style.left = x + 'px'; el.style.top = y + 'px'; }
}

class ButtonControl {
  constructor(el, onChange) {
    this.ids = new Set();
    const down = (e) => { el.setPointerCapture(e.pointerId); if (!this.ids.size) { el.classList.add('on'); buzz(8); onChange(true); } this.ids.add(e.pointerId); };
    const up = (e) => { if (!this.ids.delete(e.pointerId)) return; if (!this.ids.size) { el.classList.remove('on'); onChange(false); } };
    el.addEventListener('pointerdown', down); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  }
}

class PedalControl {                              // the higher the thumb on the pedal, the harder it presses: 0.25 at the foot, 1 at the top
  constructor(el, onChange) {
    this.id = null;
    const fill = el.querySelector('.fill');
    const set = (v) => { fill.style.height = (v * 100) + '%'; onChange(v); };
    const at = (e) => { const b = el.getBoundingClientRect(); return 0.25 + 0.75 * (1 - clamp((e.clientY - b.top) / b.height, 0, 1)); };
    el.addEventListener('pointerdown', (e) => { if (this.id !== null) return; this.id = e.pointerId; el.setPointerCapture(e.pointerId); buzz(8); set(at(e)); });
    el.addEventListener('pointermove', (e) => { if (e.pointerId === this.id) set(at(e)); });
    const end = (e) => { if (e.pointerId !== this.id) return; this.id = null; set(0); };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  }
}

class SteerSlider {                               // on-screen steering: drag left or right, springs back to centre on release
  constructor(el, onChange) {
    this.el = el; this.mark = el.querySelector('.mark'); this.id = null; this.tilt = false; this.onChange = onChange;
    const at = (e) => { const b = el.getBoundingClientRect(); return clamp((e.clientX - (b.left + b.width / 2)) / (b.width / 2 - 24), -1, 1); };
    el.addEventListener('pointerdown', (e) => { if (this.tilt || this.id !== null) return; this.id = e.pointerId; el.setPointerCapture(e.pointerId); this.set(at(e)); });
    el.addEventListener('pointermove', (e) => { if (e.pointerId === this.id) this.set(at(e)); });
    const end = (e) => { if (e.pointerId !== this.id) return; this.id = null; this.set(0); };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  }
  show(v) { this.mark.style.left = 'calc(50% + ' + (v * (this.el.clientWidth / 2 - 24)) + 'px)'; }
  set(v) { this.show(v); this.onChange(v); }
}

// TiltSteer (UC-1.4): steering from gravity, with no assumption about the phone's axes or the browser's signs (iPhone and
// Android report gravity with opposite signs). The player holds the phone as they will play and taps: that gravity is the
// centre. Then they turn it right: the direction gravity moved is "right". Steering is how far gravity has moved along that
// direction, full lock at 30 degrees (9.81 m/s2 x sin 30).
class TiltSteer {
  constructor(onSteer) { this.onSteer = onSteer; this.g = null; this.centre = null; this.right = null; this.on = false; this.seen = false; }
  async ask() {                                   // must run inside the tap: iPhone only asks for motion access from a gesture
    if (typeof DeviceMotionEvent === 'undefined') return 'This browser gives no motion readings.';
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      const r = await DeviceMotionEvent.requestPermission();
      if (r !== 'granted') return 'Motion access was refused, so steering stays on the screen.';
    }
    if (!this.listening) { window.addEventListener('devicemotion', (e) => this.read(e)); this.listening = true; }
    await new Promise((res) => setTimeout(res, 600));
    return this.seen ? null : 'This phone gives no motion readings, so steering stays on the screen.';
  }
  read(e) {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x === null) return;
    this.seen = true;
    const raw = [a.x, a.y, a.z];
    this.g = this.g ? this.g.map((v, i) => v * 0.7 + raw[i] * 0.3) : raw;   // a low-pass: the hand's shake out, gravity kept
    if (this.on) {
      const d = this.g.map((v, i) => v - this.centre[i]);
      this.onSteer(clamp((d[0] * this.right[0] + d[1] * this.right[1] + d[2] * this.right[2]) / (9.81 * 0.5), -1, 1));
    }
  }
  setCentre() { this.centre = this.g.slice(); this.on = false; }
  learnRight() {                                  // true once the phone has turned far enough (about 15 degrees) to tell right
    const d = this.g.map((v, i) => v - this.centre[i]);
    const len = Math.hypot(...d);
    if (len < 2.5) return false;
    this.right = d.map((v) => v / len);
    this.on = true;
    return true;
  }
  stop() { this.on = false; this.onSteer(0); }
}

const NAMES = { 0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT', 8: 'Back', 9: 'Start', 16: 'Home' };

class ControllerPage {
  constructor() {
    this.state = new PadState(() => this.flush());
    this.sentAt = 0; this.timer = null;
    this.link = new Link(this);
    this.tilt = new TiltSteer((v) => { this.state.axis(0, v); if (this.slider) this.slider.show(v); });
    this.wake = null;
    $('joinForm').addEventListener('submit', (e) => { e.preventDefault(); this.join($('code').value); });
    $('tiltBtn').addEventListener('click', () => this.startTilt());
    $('controls').addEventListener('pointerdown', () => this.firstTouch(), { once: true });
    document.addEventListener('visibilitychange', () => this.visibility());
    const fromHash = decodeURIComponent(location.hash.slice(1));
    if (fromHash) { $('code').value = fromHash; this.join(fromHash); }
    setInterval(() => { if (performance.now() - this.sentAt > 900) this.flush(true); }, 250);   // once a second while nothing changes
  }
  join(text) {
    const code = String(text || '').toUpperCase().replace(/\s+/g, '');
    if (!/^[A-HJ-NP-Z]{4}$/.test(code)) { $('joinMsg').textContent = 'A code is 4 letters, like ' + 'KDRX' + '.'; return; }
    $('joinMsg').textContent = 'Joining ' + code + '...';
    this.link.open(code);
  }
  seated(m) {
    this.seat = m.seat;
    $('join').hidden = true; $('pad').hidden = false; $('overlay').hidden = true;
    $('seatTag').textContent = 'Player ' + (m.seat + 1);
    this.path('relay');
    this.layout(m.layout, m.labels);
    this.keepAwake();
  }
  status(s) { $('link').textContent = s; }
  path(p) { this.status('Room ' + this.link.code + (p === 'direct' ? ' - direct' : ' - via relay')); this.state.dirty = true; }
  ended(text) {
    this.tilt.stop(); this.state.clear();
    $('pad').hidden = true; $('join').hidden = false;
    $('joinMsg').textContent = text;
  }
  layout(name, labels) {
    const root = $('controls');
    root.replaceChildren();
    this.slider = null;
    this.state.clear();
    $('tiltBtn').hidden = name !== 'drive';
    if (name === 'drive') this.buildDrive(root, labels || {}); else this.buildPad(root, labels || {});
  }
  key(root, i, label, css, cls = 'key', named = false) {   // named: the game's label is the button's face, not a caption under it
    const el = document.createElement('div');
    el.className = cls; el.textContent = named ? label : (NAMES[i] || ('B' + i));
    if (label && !named) el.append(Object.assign(document.createElement('small'), { textContent: label }));
    Object.assign(el.style, css);
    root.append(el);
    new ButtonControl(el, (down) => this.state.button(i, down));
    return el;
  }
  buildPad(root, labels) {
    const zone = Object.assign(document.createElement('div'), { className: 'zone' });
    Object.assign(zone.style, { left: '0', top: 'calc(env(safe-area-inset-top) + 96px)', width: 'calc(50% - 100px)', bottom: '0' });   // below the shoulders, left of Back
    zone.append(Object.assign(document.createElement('div'), { className: 'hint', textContent: 'stick: put your thumb anywhere here', style: 'left:16px;bottom:12px' }));
    root.append(zone);
    new StickControl(zone, (x, y) => { this.state.axis(0, x); this.state.axis(1, y); });
    const s = 'min(17vh, 76px)';                  // the face buttons in a diamond, 1.15 button-widths apart so no two touch: A below, B right, X left, Y above
    const at = (dx, dy) => ({ left: 'calc(80% + ' + (dx * 1.15) + ' * ' + s + ' - ' + s + ' / 2)', top: 'calc(60% + ' + (dy * 1.15) + ' * ' + s + ' - ' + s + ' / 2)', width: s, height: s });
    const face = [[0, 0, 1, '--a'], [1, 1, 0, '--b'], [2, -1, 0, '--x'], [3, 0, -1, '--y']];
    for (const [i, dx, dy, colour] of face) this.key(root, i, labels['b' + i], at(dx, dy)).style.color = 'var(' + colour + ')';
    const pill = (left, w) => ({ left, top: 'calc(env(safe-area-inset-top) + 40px)', width: w, height: '44px' });
    this.key(root, 6, labels.b6, pill('3%', '17%'), 'key pill');
    this.key(root, 4, labels.b4, pill('22%', '17%'), 'key pill');
    this.key(root, 5, labels.b5, pill('61%', '17%'), 'key pill');
    this.key(root, 7, labels.b7, pill('80%', '17%'), 'key pill');
    this.key(root, 8, labels.b8, { left: 'calc(50% - 92px)', bottom: '18px', width: '80px', height: '38px' }, 'key pill');
    this.key(root, 9, labels.b9, { left: 'calc(50% + 12px)', bottom: '18px', width: '80px', height: '38px' }, 'key pill');
  }
  buildDrive(root, labels) {
    const pedal = (trig, name, colour, side) => {
      const el = document.createElement('div');
      el.className = 'pedal';
      el.innerHTML = '<div class="fill"></div><span></span>';
      el.querySelector('span').textContent = name;
      el.querySelector('.fill').style.background = 'var(' + colour + ')';
      Object.assign(el.style, { [side]: 'calc(env(safe-area-inset-' + side + ') + 3%)', top: '24%', bottom: '6%', width: '20%' });
      root.append(el);
      new PedalControl(el, (v) => this.state.trigger(trig, v));
    };
    pedal(0, labels.b6 || 'Brake', '--brake', 'left');
    pedal(1, labels.b7 || 'Gas', '--gas', 'right');
    const steer = document.createElement('div');
    steer.className = 'steer';
    steer.innerHTML = '<div class="mark"></div>';
    Object.assign(steer.style, { left: '27%', right: '27%', bottom: '8%' });
    root.append(steer);
    this.slider = new SteerSlider(steer, (v) => this.state.axis(0, v));
    const shown = Object.keys(labels).map((k) => Number(k.slice(1))).filter((i) => i !== 6 && i !== 7).sort((a, b) => a - b);
    const perRow = 3;                             // the game's own buttons (handbrake, camera, ...) in rows of 3: four do not fit between the pedals
    shown.forEach((i, n) => {
      const row = Math.floor(n / perRow), inRow = Math.min(perRow, shown.length - row * perRow), col = n % perRow;
      const h = 'min(14vh, 56px)';
      this.key(root, i, labels['b' + i], { left: 'calc(50% + ' + ((col - (inRow - 1) / 2) * 96) + 'px - 46px)',
        top: 'calc(26% + ' + row + ' * (' + h + ' + 10px))', width: '92px', height: h, fontSize: '13px' }, 'key pill', true);
    });
  }
  async startTilt() {
    if (this.tilt.on) { this.tilt.stop(); this.slider.tilt = false; this.slider.el.classList.remove('tilt'); $('tiltBtn').textContent = 'Tilt to steer'; return; }
    const why = await this.tilt.ask();
    if (why) return this.say(why, 'OK', () => {});
    this.say('Hold the phone the way you will drive, then tap Centre.', 'Centre', () => {
      this.tilt.setCentre();
      this.say('Now turn the phone a little to the RIGHT, like a steering wheel.', 'Cancel', () => this.tilt.stop());
      const wait = () => {
        if ($('overlay').hidden) return;          // cancelled
        if (this.tilt.learnRight()) {
          $('overlay').hidden = true;
          this.slider.tilt = true; this.slider.el.classList.add('tilt');
          $('tiltBtn').textContent = 'Steer on screen';
          return;
        }
        setTimeout(wait, 50);
      };
      wait();
    });
  }
  say(text, button, then) {
    $('overlayText').textContent = text;
    $('overlayBtn').textContent = button;
    $('overlayBtn').onclick = () => { $('overlay').hidden = true; then(); };
    $('overlay').hidden = false;
  }
  firstTouch() {                                  // fullscreen and the wake lock need a tap on some browsers
    const el = document.documentElement;
    if (el.requestFullscreen && !document.fullscreenElement) el.requestFullscreen().catch(() => { /* not offered: the page still works */ });
    this.keepAwake();
  }
  async keepAwake() {
    if (!navigator.wakeLock || this.wake) return;
    try { this.wake = await navigator.wakeLock.request('screen'); this.wake.addEventListener('release', () => { this.wake = null; }); }
    catch { this.wake = null; }                   // refused without a tap; firstTouch asks again
  }
  visibility() {                                  // UC-1.6: a hidden page lets go of every input at once
    if (document.hidden) { this.state.clear(); if (this.link.send(this.state.message())) this.state.sent(); }
    else this.keepAwake();
  }
  flush(keepalive = false) {                      // sent the moment input changes, at most once every 15 ms (the relay cuts off past 120 a second)
    if (this.seat === undefined || document.hidden || (!this.state.dirty && !keepalive)) return;
    const since = performance.now() - this.sentAt;
    if (since < 15) { if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 15 - since); return; }
    if (this.link.send(this.state.message())) {
      this.state.sent(); this.sentAt = performance.now();
      if (this.state.dirty) this.flush();         // a latched tap's release follows 15 ms later
    }
  }
}

window.phonePad = new ControllerPage();
