// phonepad-host.js - PhonePad for a web game (UC-1.1-1.3, 1.5, 1.6, UC-2.2). Each phone in the room appears in
// navigator.getGamepads() as an ordinary gamepad of the W3C "standard" layout, so a game that already reads gamepads needs
// no new input code. gamepad.vibrationActuator.playEffect() makes the phone vibrate.
//
//   import { PhonePad } from 'https://<your relay>/phonepad-host.js';
//   const pads = await PhonePad.start({ relay: 'https://<your relay>', layout: 'drive', seats: 4, labels: { b4: 'Handbrake' } });
//   pads.show();   // the QR code and room code over the game; pads.hide() takes it away
//   pads.show(document.body, { qr: 96, compact: true });   // a smaller box: QR width in px (64-320), compact = QR and code only
//
// Classes: PhonePad (the room and its socket), VirtualGamepad (one phone, shaped like a Gamepad), JoinOverlay (the QR box).

const SILENT_MS = 2500;                           // a phone sends at least once a second; silence this long = it slept (UC-1.6)
const BUTTONS = 17;
const ICE = [{ urls: 'stun:stun.cloudflare.com:3478' }];

const isState = (m) => m && m.t === 's' && Number.isInteger(m.b) && m.b >= 0 && m.b < 2 ** BUTTONS &&
  Array.isArray(m.a) && m.a.length === 4 && m.a.every((v) => typeof v === 'number' && v >= -1 && v <= 1) &&
  Array.isArray(m.p) && m.p.length === 2 && m.p.every((v) => typeof v === 'number' && v >= 0 && v <= 1);

// Direct (UC-1.3 alternate 3a): one phone straight to this page over a WebRTC data channel, unordered and without resends
// (every message is the whole pad, so a lost one is replaced by the next). The relay carries only the set-up messages.
class Direct {
  constructor(host, seat) {
    this.host = host; this.seat = seat;
    const pc = this.pc = new RTCPeerConnection({ iceServers: ICE });
    const dc = this.dc = pc.createDataChannel('pad', { ordered: false, maxRetransmits: 0 });
    dc.onopen = () => host.path(seat, 'direct');
    dc.onclose = () => { if (host.directs.get(seat) === this) host.path(seat, 'relay'); };
    dc.onmessage = (e) => host.onMessage({ ...JSON.parse(e.data), seat }, true);
    pc.onicecandidate = (e) => host.send({ t: 'sig', seat, d: { ice: e.candidate ? e.candidate.toJSON() : null } });
  }
  async offer() {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    this.host.send({ t: 'sig', seat: this.seat, d: { sdp: { type: 'offer', sdp: this.pc.localDescription.sdp } } });
  }
  async signal(d) {
    if (d.sdp && d.sdp.type === 'answer') await this.pc.setRemoteDescription(d.sdp);
    else if ('ice' in d) await this.pc.addIceCandidate(d.ice === null ? undefined : d.ice);
  }
  get open() { return this.dc.readyState === 'open'; }
  send(m) { this.dc.send(JSON.stringify(m)); }
  close() { this.pc.close(); }
}

class VirtualGamepad {
  constructor(host, seat) {
    this.host = host; this.seat = seat;
    this.id = 'PhonePad player ' + (seat + 1) + ' (phone, standard layout)';
    this.index = -1; this.mapping = 'standard'; this.connected = false; this.timestamp = 0;
    this.axes = [0, 0, 0, 0];
    this.buttons = Array.from({ length: BUTTONS }, () => ({ pressed: false, touched: false, value: 0 }));
    this.heardAt = 0;
    const self = this;
    this.vibrationActuator = {                    // the Gamepad haptics shape; the relay carries it to the phone (UC-1.5)
      type: 'dual-rumble', effects: ['dual-rumble'],
      playEffect(type, params) { self.host.rumble(self.seat, Math.max(1, Math.min(2000, Math.round((params && params.duration) || 200)))); return Promise.resolve('complete'); },
      reset() { return Promise.resolve('complete'); },
    };
  }
  apply(m, now) {
    for (let i = 0; i < BUTTONS; i++) {
      const on = (m.b >> i) & 1;
      const v = i === 6 ? m.p[0] : i === 7 ? m.p[1] : on;
      const b = this.buttons[i];
      b.value = v; b.pressed = v > 0; b.touched = v > 0;
    }
    for (let i = 0; i < 4; i++) this.axes[i] = m.a[i];
    this.timestamp = now; this.heardAt = now;
  }
  neutral() {
    for (const b of this.buttons) { b.value = 0; b.pressed = false; b.touched = false; }
    this.axes.fill(0);
  }
}

class JoinOverlay {                               // UC-1.1: the QR code, the address and the room code, and who has joined
  constructor(pads, place) {                      // place: CSS for where it sits, e.g. { left: '16px', top: '80px' } (default bottom right)
    this.pads = pads;
    const el = this.el = document.createElement('div');
    el.setAttribute('data-phonepad', '');
    el.style.cssText = 'position:fixed;z-index:2147483000;background:#0d0f14;color:#e9edf5;border:1px solid #2a3040;' +
      'border-radius:12px;padding:12px;font:13px/1.35 system-ui,sans-serif;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.5);max-width:240px';
    Object.assign(el.style, place || { right: '16px', bottom: '16px' });
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'display:block;width:180px;height:180px;margin:0 auto 8px;image-rendering:pixelated;border-radius:6px';
    this.text = document.createElement('div');
    this.seats = document.createElement('div');
    this.seats.style.cssText = 'margin-top:6px;color:#8a93a6';
    el.append(this.canvas, this.text, this.seats);
    this.compact = false;
  }
  size(qr, compact) {                             // the QR code's width; the box is that plus its padding, the text shrinks with it
    this.compact = compact;
    const small = compact || qr < 140;
    this.canvas.style.width = this.canvas.style.height = qr + 'px';
    this.canvas.style.marginBottom = small ? '4px' : '8px';
    this.el.style.padding = small ? '8px' : '12px';
    this.el.style.maxWidth = Math.max(qr + (small ? 16 : 24), compact ? 0 : 200) + 'px';
    this.el.style.fontSize = small ? '11px' : '13px';
  }
  render() {
    const p = this.pads;
    if (p.error) { this.canvas.style.display = 'none'; this.text.textContent = p.error; this.seats.textContent = ''; return; }
    this.canvas.style.display = 'block';
    p.drawQR(this.canvas, 6);
    if (this.compact) {                             // the code alone, for a small corner: a scanner needs no address
      this.text.innerHTML = '<b style="font-size:16px;letter-spacing:.15em"></b>';
      this.text.querySelector('b').textContent = p.code;
    } else {
      this.text.innerHTML = 'Scan with your phone, or open<br><b></b><br>and type <b style="font-size:20px;letter-spacing:.15em"></b>';
      const b = this.text.querySelectorAll('b');
      b[0].textContent = new URL(p.join).host; b[1].textContent = p.code;
    }
    const on = [...p.pads.values()].filter((g) => g.connected).map((g) => {
      const rtt = p.rtt.get(g.seat);
      return 'Player ' + (g.seat + 1) + ': ' + (p.paths.get(g.seat) || 'relay') + (rtt !== undefined ? ', ' + Math.round(rtt) + ' ms round trip' : '');
    });
    this.seats.innerHTML = '';
    if (!on.length) this.seats.textContent = 'No phones yet';
    for (const line of on) this.seats.append(Object.assign(document.createElement('div'), { textContent: line }));
  }
}

export class PhonePad {
  static async start(opts) { const p = new PhonePad(opts); await p.open(); return p; }

  constructor({ relay, layout = 'pad', seats = 4, labels = {}, direct = true, place = null, onJoin = null, onLeave = null }) {
    if (!relay) throw new Error('PhonePad.start: relay is required (the address of your PhonePad relay)');
    if (direct && typeof RTCPeerConnection === 'undefined') throw new Error('PhonePad.start: this browser has no WebRTC; pass direct: false to send input through the relay');
    this.relay = relay.replace(/\/$/, '');
    this.hello = { t: 'hello', layout, seats, labels };
    this.useDirect = direct;
    this.onJoin = onJoin; this.onLeave = onLeave;
    this.pads = new Map();                        // seat -> VirtualGamepad
    this.directs = new Map();                     // seat -> Direct (the WebRTC link, when it is offered)
    this.paths = new Map();                       // seat -> 'direct' | 'relay': which way its input comes, shown on the overlay
    this.rtt = new Map();                         // seat -> last measured round trip in ms, on the path its input comes by
    this.code = null; this.join = null; this.qr = null; this.error = null;
    const real = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads.bind(navigator) : () => [];
    this.realPads = () => real() || [];            // the browser's own pads, captured before installGamepads replaces getGamepads
    this.overlay = new JoinOverlay(this, place);
    this.pingId = 0; this.pings = new Map();
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.relay.replace(/^http/, 'ws') + '/ws/host');
      this.ws = ws;
      let opened = false;
      ws.onopen = () => ws.send(JSON.stringify(this.hello));
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.t === 'room') { opened = true; this.code = m.code; this.join = m.join; this.qr = m.qr; this.installGamepads(); this.overlay.render(); resolve(this); }
        else if (m.t === 'error' && !opened) { this.fail('The relay refused the room: ' + m.why); reject(new Error(this.error)); }
        else this.onMessage(m);
      };
      ws.onclose = (e) => {
        if (!opened) { this.fail('Could not reach the PhonePad relay at ' + this.relay + ' (closed ' + e.code + ').'); reject(new Error(this.error)); return; }
        this.fail('The PhonePad relay closed the room (' + e.code + ').');
        for (const g of this.pads.values()) this.disconnect(g);
      };
    });
  }

  fail(text) { this.error = text; this.overlay.render(); }

  onMessage(m, direct = false) {
    const now = performance.now();
    if (m.t === 'join') {
      const g = this.pad(m.seat); g.neutral(); g.heardAt = now; this.connect(g);
      this.path(m.seat, 'relay');
      if (this.useDirect) {                       // offer the phone a direct link; input uses the relay until it opens
        this.dropDirect(m.seat);
        const d = new Direct(this, m.seat);
        this.directs.set(m.seat, d);
        d.offer().catch((e) => console.warn('PhonePad direct link for player ' + (m.seat + 1) + ' failed: ' + e.message));
      }
    } else if (m.t === 'leave') { this.dropDirect(m.seat); const g = this.pads.get(m.seat); if (g) this.disconnect(g); }
    else if (m.t === 's') {
      if (direct && !isState(m)) return console.warn('PhonePad: player ' + (m.seat + 1) + ' sent a malformed state on the direct link');
      const g = this.pad(m.seat); g.apply(m, now); if (!g.connected) this.connect(g);
    } else if (m.t === 'pong') { const t = this.pings.get(m.id); if (t !== undefined) { this.rtt.set(m.seat, now - t); this.pings.delete(m.id); this.overlay.render(); } }
    else if (m.t === 'sig') { const d = this.directs.get(m.seat); if (d) d.signal(m.d).catch((e) => console.warn('PhonePad direct link: ' + e.message)); }
    else if (m.t === 'error') console.warn('PhonePad relay: ' + m.why);
  }

  dropDirect(seat) { const d = this.directs.get(seat); if (d) { this.directs.delete(seat); d.close(); } this.path(seat, 'relay'); }
  path(seat, p) { this.paths.set(seat, p); this.rtt.delete(seat); this.overlay.render(); }

  pad(seat) {                                     // a phone's gamepad sits after the real pads, at a fixed index for its seat
    let g = this.pads.get(seat);
    if (!g) { this.pads.set(seat, (g = new VirtualGamepad(this, seat))); g.index = this.base() + seat; }
    return g;
  }
  base() { return Math.max(4, this.realPads().length); }

  connect(g) {
    g.connected = true;
    this.fire('gamepadconnected', g);
    if (this.onJoin) this.onJoin(g.seat);
    this.overlay.render();
  }

  disconnect(g) {                                 // UC-1.6: every input reads zero the moment a phone is gone
    if (!g.connected) return;
    g.neutral(); g.connected = false;
    this.fire('gamepaddisconnected', g);
    if (this.onLeave) this.onLeave(g.seat);
    this.overlay.render();
  }

  fire(type, g) {                                 // a GamepadEvent cannot carry an object that is not a real Gamepad, so an Event with .gamepad
    const ev = new Event(type);
    Object.defineProperty(ev, 'gamepad', { value: g });
    window.dispatchEvent(ev);
  }

  installGamepads() {                             // phones after the real pads, each at a fixed index for its seat
    if (navigator.__phonepad) throw new Error('PhonePad: a second PhonePad is already installed on this page');
    navigator.__phonepad = this;
    this.ownGetGamepads = Object.prototype.hasOwnProperty.call(navigator, 'getGamepads') ? navigator.getGamepads : null;
    navigator.getGamepads = () => {
      const list = [...this.realPads()];
      const base = Math.max(4, list.length);
      while (list.length < base + this.hello.seats) list.push(null);
      const now = performance.now();
      for (const g of this.pads.values()) {
        if (g.connected && now - g.heardAt > SILENT_MS) this.disconnect(g);   // UC-1.6: the phone slept
        g.index = base + g.seat;
        list[g.index] = g.connected ? g : null;
      }
      return list;
    };
    this.pinger = setInterval(() => {             // the latency the game sees, on the path its input comes by, measured, never assumed
      for (const g of this.pads.values()) {
        if (!g.connected) continue;
        const id = ++this.pingId;
        this.pings.set(id, performance.now());
        this.toPhone(g.seat, { t: 'ping', seat: g.seat, id });
      }
    }, 2000);
  }

  send(m) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }
  toPhone(seat, m) { const d = this.directs.get(seat); if (d && d.open) d.send(m); else this.send(m); }
  rumble(seat, ms) { this.toPhone(seat, { t: 'rumble', seat, ms }); }
  layout(layout, labels = {}) { this.hello.layout = layout; this.hello.labels = labels; this.send({ t: 'layout', layout, labels }); }

  drawQR(canvas, scale = 6) {                     // dark modules on white with the 4-module quiet zone a scanner needs
    const { n, bits } = this.qr, quiet = 4, size = (n + quiet * 2) * scale;
    canvas.width = canvas.height = size;
    const c = canvas.getContext('2d');
    c.fillStyle = '#fff'; c.fillRect(0, 0, size, size);
    c.fillStyle = '#000';
    for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (bits[r * n + k] === '1') c.fillRect((k + quiet) * scale, (r + quiet) * scale, scale, scale);
  }

  // show(parent, { qr, compact }): qr = the QR code's width in CSS px (64-320, default 180; the box fits round it), compact = only
  // the QR code and the room code, without the address lines. Calling it again re-sizes the box in place.
  show(parent = document.body, { qr = 180, compact = false } = {}) {
    if (!Number.isFinite(qr) || qr < 64 || qr > 320) throw new Error('PhonePad.show: qr must be a width in px from 64 to 320, not ' + qr);
    this.overlay.size(qr, compact);
    this.overlay.render();
    if (this.overlay.el.parentNode !== parent) parent.append(this.overlay.el);
  }
  hide() { this.overlay.el.remove(); }

  close() {
    clearInterval(this.pinger);
    for (const seat of [...this.directs.keys()]) this.dropDirect(seat);
    for (const g of this.pads.values()) this.disconnect(g);
    if (this.ws) this.ws.close(1000, 'game closed');
    this.hide();
    if (navigator.__phonepad === this) {          // give the page its own getGamepads back, so a later start() can install again
      if (this.ownGetGamepads) navigator.getGamepads = this.ownGetGamepads; else delete navigator.getGamepads;
      delete navigator.__phonepad;
    }
  }
}

globalThis.PhonePad = PhonePad;
