# PhonePad: use cases

PhonePad turns phones into gamepads for a game on another screen: a web page (WebGPU or not) or an Unreal game. The phone
needs only its browser. The game sees each phone as an ordinary gamepad (the W3C "standard" layout in a browser, Unreal's
Gamepad_* keys in Unreal), so a game that already reads gamepads needs no new input code.

## UC-1: a player uses their phone as a gamepad

Primary actor: a player with an Android phone or an iPhone. Supporting actors: the game (the host), the relay (a Cloudflare
Worker the game's owner deploys).

Precondition: the game is running with PhonePad on and can reach the relay; the phone and the game are online.

1. The game starts PhonePad -> the relay opens a room and the game shows its QR code and a 4-letter room code.
2. The player scans the QR code (or opens the relay's address and types the code) -> the controller page opens in the phone's
   browser and the player gets the lowest free seat; the game shows "Player N joined" and a gamepad N connects.
3. The player presses buttons, moves the stick or squeezes a pedal -> gamepad N shows the same values on the game's next frame
   after the message arrives (browser: `navigator.getGamepads()[...]`; Unreal: controller events for local player N).
   - 3a A web game offers a direct link (WebRTC); until it opens, or if it never does, input goes through the relay, and the
     join box shows each player's path and measured round trip.
4. Drive layout only: the player taps "Tilt to steer" -> the phone asks for motion access (iPhone) and tilting the phone moves
   the left stick's X axis, centred on how the player held it when they tapped.
5. The game asks for a rumble -> the phone vibrates (where the phone's browser can).
6. The player closes the page or the phone sleeps -> gamepad N disconnects and every input on it reads zero; nothing sticks.

Alternates:
- 1a The relay cannot be reached -> the game shows the relay's address and the error in plain words; no room, no QR.
- 2a The room code is wrong or the game has closed -> the phone says so and offers to type a code again.
- 2b Every seat is taken -> the phone says "the game is full (N players)".
- 2c The phone reconnects within 30 s (a network blip, the screen woke) -> it gets its old seat back.
- 4a The phone has no motion sensor or the player refuses access -> the page says so and steering stays on the on-screen stick.
- 6a The game closes -> every phone shows "the game has closed".

Postcondition: the relay keeps nothing once the room closes. No names, no IP addresses, no input history are stored.

## UC-2: a developer adds PhonePad to their game

Primary actor: a game developer.

1. Deploy the relay once: `cd relay && npx wrangler deploy` -> a relay address (`https://<name>.<account>.workers.dev`).
2. Web game: import `phonepad-host.js` from the relay, call `PhonePad.start({ relay, layout })` -> step UC-1.1 happens in their page.
   Unreal game: copy `unreal/PhonePad` into `Plugins/`, set the relay in `Config/DefaultGame.ini` -> UC-1.1 happens on start.
3. Run the game, scan the code with a phone -> UC-1 runs with no change to the game's input code.

## Which code serves which step

- `relay/src/room.js` (Room): UC-1.1, 1.2, 1.6, 2a-2c, 6a. `relay/src/rules.js`: every message check.
- `relay/public/pad.js` (ControllerPage, PadState, Link, DirectLink, StickControl, ButtonControl, PedalControl, SteerSlider,
  TiltSteer): UC-1.2-1.6 on the phone.
- `relay/public/phonepad-host.js` (PhonePad, Direct, VirtualGamepad, JoinOverlay): UC-1.1-1.3, 1.5, 1.6 in a browser game.
- `unreal/PhonePad`: FPhonePadRoom (the relay socket and seats), FPhonePadDevice (seats -> gamepad events), PhonePadProtocol
  (messages and the W3C -> Unreal key map), UPhonePadSubsystem (start, join overlay, Blueprint API): UC-1.1-1.3, 1.5, 1.6.
