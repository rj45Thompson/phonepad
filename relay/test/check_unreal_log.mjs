// Holds the Unreal test game's log against what the scripted phones sent (unreal_phones.mjs). Every check is a use case step,
// and every key name is Unreal's own (GenericApplication.cpp:12-39). Exit 1 on any failure.
//   node test/check_unreal_log.mjs <game log>
import { readFileSync } from 'node:fs';

const log = readFileSync(process.argv[2], 'utf8').split(/\r?\n/);
let fails = 0;
const check = (name, ok, detail = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : '')); if (!ok) fails++; };
const slate = log.filter((l) => l.includes('TESTSLATE')).map((l) => {
  const m = /TESTSLATE user=(\d+) key=(\S+) (down|up|analog) value=(-?[\d.]+)( repeat)?/.exec(l);
  return m && { user: Number(m[1]), key: m[2], what: m[3], value: Number(m[4]), repeat: !!m[5] };
}).filter(Boolean);
const has = (user, key, what, value) => slate.some((e) => e.user === user && e.key === key && e.what === what && (value === undefined || Math.abs(e.value - value) < 0.002));
const order = (user, key) => slate.filter((e) => e.user === user && e.key === key).map((e) => e.what + (e.repeat ? '*' : '') + (e.what === 'analog' ? e.value : ''));

const room = log.find((l) => /PhonePad: room [A-Z]{4} open/.test(l));
check('UC-1.1 the game opened a room on the relay', !!room, room && room.replace(/.*PhonePad: /, ''));
check('UC-1.2 both phones joined as players 1 and 2', log.some((l) => l.includes('PhonePad: player 1 joined')) && log.some((l) => l.includes('PhonePad: player 2 joined')));
check('UC-1.3 A on phone 1 is Gamepad_FaceButton_Bottom for user 0, pressed then released', has(0, 'Gamepad_FaceButton_Bottom', 'down') && has(0, 'Gamepad_FaceButton_Bottom', 'up'), order(0, 'Gamepad_FaceButton_Bottom').join(' '));
check('UC-1.3 the stick right at 0.8 is Gamepad_LeftX 0.8, then back to 0', has(0, 'Gamepad_LeftX', 'analog', 0.8) && has(0, 'Gamepad_LeftX', 'analog', 0));
check('UC-1.3 the stick UP (W3C -0.9) is Gamepad_LeftY +0.9: Unreal\'s Y is positive up', has(0, 'Gamepad_LeftY', 'analog', 0.9) && !has(0, 'Gamepad_LeftY', 'analog', -0.9));
check('UC-1.3 ... and raises the digital Gamepad_LeftStick_Up as a real pad does', has(0, 'Gamepad_LeftStick_Up', 'down') && has(0, 'Gamepad_LeftStick_Up', 'up'));
check('UC-1.3 the right trigger at 0.6 is Gamepad_RightTriggerAxis 0.6 and Gamepad_RightTrigger pressed', has(0, 'Gamepad_RightTriggerAxis', 'analog', 0.6) && has(0, 'Gamepad_RightTrigger', 'down') && has(0, 'Gamepad_RightTrigger', 'up'));
const dpad = slate.filter((e) => e.user === 0 && e.key === 'Gamepad_DPad_Down' && e.what === 'down');
// 0.75 s held = repeats at 0.2, 0.3 ... 0.7 s (6); the release crosses the relay after the press did, so network jitter can
// stretch the hold the game sees by a repeat or two (measured 6 on 2026-11-08). Fewer than 4 = the timing is not the engine's.
check('UC-1.3 a held D-pad repeats on the engine\'s own timing (0.2 s, then every 0.1 s: 4-8 repeats for 0.75 s)', dpad.filter((e) => !e.repeat).length === 1 && dpad.filter((e) => e.repeat).length >= 4 && dpad.filter((e) => e.repeat).length <= 8, dpad.filter((e) => e.repeat).length + ' repeats');
check('UC-1.2 phone 2 drives user 1: B is Gamepad_FaceButton_Right for user 1 only', has(1, 'Gamepad_FaceButton_Right', 'down') && has(1, 'Gamepad_FaceButton_Right', 'up') && !has(0, 'Gamepad_FaceButton_Right', 'down'));
const left = log.findIndex((l) => l.includes('PhonePad: player 1 left'));
const xUp = log.findIndex((l) => /TESTSLATE user=0 key=Gamepad_FaceButton_Left up/.test(l));
check('UC-1.6 a phone that leaves while holding X: X is released, after the leave, nothing sticks', has(0, 'Gamepad_FaceButton_Left', 'down') && left >= 0 && xUp > left, 'left at line ' + left + ', X up at line ' + xUp);
const status = log.filter((l) => l.includes('TESTSTATUS')).map((l) => /rtt0=(-?[\d.]+)/.exec(l)).filter(Boolean).map((m) => Number(m[1])).filter((v) => v > 0);
check('the plugin measured its round trip to phone 1', status.length > 0, status.length ? 'last ' + status[status.length - 1].toFixed(1) + ' ms (game -> relay -> phone -> relay -> game)' : '');
const pc0 = log.filter((l) => /TESTPC player=0 key=Gamepad_/.test(l)).length, pc1 = log.filter((l) => /TESTPC player=1 key=Gamepad_/.test(l)).length;
console.log('INFO the player controllers saw ' + pc0 + ' gamepad events for player 0 and ' + pc1 + ' for player 1 (they need the game window to have focus; Slate saw every event above)');
const errors = log.filter((l) => /LogPhonePad: Error|Ensure condition failed/.test(l));
check('no PhonePad errors and no engine ensures in the log', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(fails ? fails + ' FAILED' : 'ALL PASS');
process.exit(fails ? 1 : 0);
