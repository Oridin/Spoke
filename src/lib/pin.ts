var PIN_KEY = 'spoke-pin';

export interface PinData {
	hash: string;
	salt: string;
	hiddenSections: string[];
	attempts: number;
	lockUntil: number;
}

var DEFAULT_PIN: PinData = {
	hash: '74854c03e2e9768de541b6a6819693e6881f0259bdd6c821482c7485525b37e8',
	salt: 'd564f6bd826d25703b59105b559bd75b',
	hiddenSections: ['3'],
	attempts: 0,
	lockUntil: 0
};

export function loadPinData (): PinData {
	try {
		var raw = localStorage.getItem(PIN_KEY);
		if (raw) { var p = JSON.parse(raw) as PinData; if (p.hash && p.salt) return p; }
	} catch { /* */ }
	savePinData(DEFAULT_PIN);
	return DEFAULT_PIN;
}

export function savePinData (d: PinData): void {
	try { localStorage.setItem(PIN_KEY, JSON.stringify(d)); } catch { /* */ }
}

export async function hashPin (pin: string, salt: string): Promise<string> {
	var input = salt + ':' + pin;
	try {
		var data = new TextEncoder().encode(input);
		var buf = await crypto.subtle.digest('SHA-256', data);
		var a = new Uint8Array(buf);
		var hex = '';
		for (var i = 0; i < a.length; i++) hex += ('0' + a[i].toString(16)).slice(-2);
		return hex;
	} catch {
		var h = 0x811c9dc5;
		for (var r = 0; r < 10000; r++) {
			for (var j = 0; j < input.length; j++) { h ^= input.charCodeAt(j); h = Math.imul(h, 0x01000193); }
			h = h >>> 0;
		}
		return (h >>> 0).toString(16).padStart(8, '0');
	}
}

export async function verifyPin (pin: string): Promise<{ok: boolean; attempts: number; locked: boolean; lockMs: number}> {
	var d = loadPinData();
	var now = Date.now();
	if (d.lockUntil > now) return {ok: false, attempts: d.attempts, locked: true, lockMs: d.lockUntil - now};
	var computed = await hashPin(pin, d.salt);
	if (computed === d.hash) { savePinData({...d, attempts: 0, lockUntil: 0}); return {ok: true, attempts: 0, locked: false, lockMs: 0}; }
	var att = d.attempts + 1;
	var lock = att >= 5 ? now + 5 * 60 * 1000 : 0;
	savePinData({...d, attempts: att, lockUntil: lock});
	return {ok: false, attempts: att, locked: att >= 5, lockMs: att >= 5 ? 5 * 60 * 1000 : 0};
}

export async function changePin (newPin: string): Promise<void> {
	var d = loadPinData();
	var chars = 'abcdef0123456789';
	var salt = '';
	for (var i = 0; i < 32; i++) salt += chars[Math.floor(Math.random() * chars.length)];
	var hash = await hashPin(newPin, salt);
	savePinData({...d, hash: hash, salt: salt, attempts: 0, lockUntil: 0});
}

export function getLockState (): {locked: boolean; ms: number} {
	var d = loadPinData();
	var now = Date.now();
	if (d.lockUntil > now) return {locked: true, ms: d.lockUntil - now};
	return {locked: false, ms: 0};
}

export function getHiddenSections (): string[] {
	return loadPinData().hiddenSections;
}
