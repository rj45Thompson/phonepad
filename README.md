# PhonePad

Phones as gamepads, for web games and Unreal games. Players scan a QR code on the game's screen and their phone's browser
becomes a controller. No app to install, on Android or iPhone.

The game sees each phone as an ordinary gamepad:
- **in a browser**, a W3C "standard" gamepad in `navigator.getGamepads()`;
- **in Unreal**, the usual `Gamepad_*` keys for local player N.

A game that already reads gamepads needs no new input code.

## How it works

```
phone (browser) ──┐                        ┌── web game: phonepad-host.js
                  ├── relay (Cloudflare) ──┤
phone (browser) ──┘   rooms, QR, phone page └── Unreal game: PhonePad plugin
```

- **The relay** (`relay/`) is a Cloudflare Worker.
  - It opens a room for a game, gives it a 4-letter code and a QR code, and serves the phone's controller page.
  - It forwards between phones and the game.
  - Each room is one Durable Object using the hibernation API, so a quiet room costs nothing.
  - It keeps nothing once the room closes.
- **Web games** get a direct link. The relay introduces the phone and the page, then they talk straight to each other over a
  WebRTC data channel (unordered, no resends: every message is the whole pad). If the direct link can't be made, input keeps
  going through the relay, and the join box says which path each player is on and the measured round trip.
- **Unreal games** go through the relay. The plugin is an `IInputDevice`: it raises button presses and releases with the
  engine's own repeat timing, the digital stick directions, and the analog sticks and triggers, the same way Unreal's own pad
  code does.

## Measured

- **Web, direct link:** about 1 ms round trip between two browser tabs on one PC. A phone on Wi-Fi is not measured yet.
- **Through the relay**, from one PC (30 pings): median 127.5 ms round trip, worst 380 ms. One input message from phone to
  game took 68 ms.
- **The Unreal plugin's own measure:** 133-185 ms round trip over four runs, through the relay.
- **Tests:** the relay passes 21 end-to-end checks locally and against the deployed Worker. A headless Unreal 5.7 game passes
  12 checks with two scripted phones: each phone drives its own player, the keys are right, the stick's up is up, held buttons
  repeat, and a phone that leaves mid-press lets go of the button.

## Quick start

### 1. Deploy the relay (once)

```
cd relay
npm install
# put your game's origin in wrangler.jsonc > vars > HOST_ORIGINS, e.g. "https://you.github.io"
npx wrangler deploy
```

You get `https://phonepad-relay.<your account>.workers.dev`. The phone page is at its root.

### 2a. A web game

```js
import { PhonePad } from 'https://phonepad-relay.<your account>.workers.dev/phonepad-host.js';

const pads = await PhonePad.start({
  relay: 'https://phonepad-relay.<your account>.workers.dev',
  layout: 'pad',                  // or 'drive': gas and brake pedals, tilt or on-screen steering
  seats: 4,                       // 1-8 phones
  labels: { b4: 'Handbrake' },    // optional names for buttons, keyed by W3C standard index
});
pads.show();                      // the QR box (pass place: { left: '16px', top: '16px' } to move it)
pads.show(document.body, { qr: 96, compact: true });   // smaller: the QR width in px (64-320), compact = QR and code only
```

- Each phone then appears in `navigator.getGamepads()` with `mapping === 'standard'`, after the browser's own pad slots: index 4 +
  seat where the browser lists 4 slots, higher where it lists more (measured 8 in one headless Chrome). Find a phone by its
  `id` (`PhonePad player N ...`), or read `pads.pads.get(seat).index`.
- `gamepadconnected` and `gamepaddisconnected` fire as usual.
- `gamepad.vibrationActuator.playEffect('dual-rumble', { duration: 200 })` vibrates the phone.
- `pads.paths` and `pads.rtt` give each seat's path and measured round trip.
- `pads.close()` ends the room.

### 2b. An Unreal game (5.7)

1. Copy `unreal/PhonePad` into your project's `Plugins/` folder and enable it.
2. Set the relay in Project Settings > Plugins > PhonePad. In an .ini, quote it:
   ```
   [/Script/PhonePad.PhonePadSettings]
   RelayUrl="https://phonepad-relay.<your account>.workers.dev"
   Layout=pad
   Seats=4
   ```
   Unquoted, Unreal's config reader takes the `//` for a comment and leaves `https:`. The plugin then refuses to start, and
   says why.
3. Run the game. The QR code shows in the corner until a phone joins.
   - Phone N drives local player N: create the local players as you would for pads.
   - `UPhonePadSubsystem` gives Blueprints the room code, who has joined, round trips and `Rumble`.
   - Force feedback reaches the phone as vibration pulses.

## The phone

- **pad:** a floating stick (it centres where your thumb lands), A/B/X/Y, LB/RB/LT/RT, Back and Start.
- **drive:**
  - gas and brake pedals: the higher you press, the harder;
  - steering: an on-screen slider, or "Tilt to steer". You hold the phone as you will play and tap Centre, then turn it a little
    to the right. That calibration works whatever the phone's axes, and on both iPhone and Android, which report motion with
    opposite signs;
  - the game's own buttons, named from `labels`.
- **Rejoins:** a phone that drops gets its seat back if it returns within 30 s.
- **Sleeping phones:** a phone that goes quiet for 2.5 s reads as neutral; nothing sticks down.
- **Platform limits:** iPhone browsers cannot vibrate. Tilt needs HTTPS and one tap to allow motion (iPhone asks).

## Tests

```
cd relay
node --test test/rules.test.mjs                   # every relay rule
node test/e2e.mjs                                 # the real Worker under wrangler dev, two scripted phones
node test/e2e.mjs --remote https://<your relay>   # the same against a deployed relay, plus latency figures
node test/serve.mjs                               # test/host_page.html on :8833: a game page that shows what it receives
pwsh -File ../unreal/test/run_unreal_test.ps1 -Relay https://<your relay> -Engine "C:\Program Files\Epic Games\UE_5.7"
```

The Unreal test runs the game off-screen (no window), with two scripted phones, and checks the game's log against the script.

## Notes

- Room codes are 4 letters from 24 (I and O are left out), about 330,000 codes. A stranger who guesses a live code could join
  a free seat. Rooms last only while the game is open.
- `HOST_ORIGINS` decides which web pages may open rooms on your relay. `ALLOW_NO_ORIGIN_HOSTS` lets programs that are not web
  pages, such as an Unreal game, open them too.
- `USE_CASES.md` has the use cases and which code serves each step.

## License

MIT.
