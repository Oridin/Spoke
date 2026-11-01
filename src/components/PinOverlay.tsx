import {useCallback, useEffect, useRef, useState} from 'preact/hooks';
import {useKeyTrap} from '../hooks/useKeyTrap';
import {verifyPin, changePin, getLockState} from '../lib/pin';

interface Props {
	mode: 'verify' | 'change';
	active: boolean;
	onSuccess: () => void;
	onCancel: () => void;
	onToast: (msg: string, kind?: 'info' | 'error') => void;
}

type Phase = 'enter' | 'new' | 'confirm';

var PAD = [
	['1', '2', '3'],
	['4', '5', '6'],
	['7', '8', '9'],
	['⌫', '0', 'OK'],
];

export function PinOverlay ({mode, active, onSuccess, onCancel, onToast}: Props) {
	var [phase, setPhase] = useState<Phase>('enter');
	var [digits, setDigits] = useState('');
	var [newPin, setNewPin] = useState('');
	var [row, setRow] = useState(0);
	var [col, setCol] = useState(1);
	var [error, setError] = useState<string | null>(null);
	var [lockMsg, setLockMsg] = useState<string | null>(null);
	var [busy, setBusy] = useState(false);
	var lockRef = useRef(0);

	useEffect(function () {
		var tick = function () {
			var s = getLockState();
			if (s.locked) {
				var sec = Math.ceil(s.ms / 1000); var m = Math.floor(sec / 60); var ss = sec % 60;
				setLockMsg('Locked. Try again in ' + m + ':' + (ss < 10 ? '0' : '') + ss);
			} else { setLockMsg(null); }
		};
		tick();
		lockRef.current = window.setInterval(tick, 1000);
		return function () { window.clearInterval(lockRef.current); };
	}, []);

	var title = phase === 'enter' ? (mode === 'change' ? 'Enter current PIN' : 'Enter PIN')
		: phase === 'new' ? 'Enter new PIN' : 'Confirm new PIN';

	var addDigit = useCallback(function (d: string) {
		if (lockMsg || busy) return;
		setError(null);
		setDigits(function (p) { return p.length < 4 ? p + d : p; });
	}, [lockMsg, busy]);

	var bksp = useCallback(function () {
		if (lockMsg || busy) return;
		setError(null);
		setDigits(function (p) { return p.slice(0, -1); });
	}, [lockMsg, busy]);

	var submit = useCallback(function () {
		if (lockMsg || busy || digits.length < 4) return;
		setBusy(true);
		if (phase === 'enter') {
			verifyPin(digits).then(function (r) {
				setBusy(false);
				if (r.ok) {
					if (mode === 'change') { setPhase('new'); setDigits(''); setError(null); }
					else onSuccess();
				} else if (r.locked) { setDigits(''); }
				else { setError('Wrong PIN. ' + (5 - r.attempts) + ' left'); setDigits(''); }
			});
		} else if (phase === 'new') {
			setNewPin(digits); setPhase('confirm'); setDigits(''); setError(null); setBusy(false);
		} else {
			if (digits === newPin) {
				changePin(digits).then(function () { setBusy(false); onToast('PIN changed'); onSuccess(); });
			} else {
				setError("PINs don't match"); setPhase('new'); setDigits(''); setNewPin(''); setBusy(false);
			}
		}
	}, [digits, phase, mode, lockMsg, busy, newPin, onSuccess, onToast]);

	var handleTrap = useCallback(function (e: KeyboardEvent) {
		var code = e.keyCode;
		if (code >= 48 && code <= 57) { addDigit(String(code - 48)); return; }
		if (code === 38) { setRow(function (r) { return Math.max(0, r - 1); }); return; }
		if (code === 40) { setRow(function (r) { return Math.min(3, r + 1); }); return; }
		if (code === 37) { setCol(function (c) { return Math.max(0, c - 1); }); return; }
		if (code === 39) { setCol(function (c) { return Math.min(2, c + 1); }); return; }
		if (code === 13) {
			var k = PAD[row][col];
			if (k === '⌫') bksp();
			else if (k === 'OK') submit();
			else addDigit(k);
			return;
		}
		if (code === 461 || code === 27) onCancel();
	}, [row, col, addDigit, bksp, submit, onCancel]);

	useKeyTrap(handleTrap, active && !busy);

	return (
		<div class="pin-overlay">
			<div class="pin-overlay__backdrop" />
			<div class="pin-overlay__box">
				<h2 class="pin-overlay__title">{title}</h2>
				<div class="pin-overlay__dots">
					{[0, 1, 2, 3].map(function (i) {
						return <span key={i} class={'pin-overlay__dot' + (i < digits.length ? ' pin-overlay__dot--filled' : '')} />;
					})}
				</div>
				{lockMsg && <div class="pin-overlay__error">{lockMsg}</div>}
				{error && !lockMsg && <div class="pin-overlay__error">{error}</div>}
				<div class="pin-overlay__grid">
					{PAD.map(function (rk, ri) {
						return (
							<div key={ri} class="pin-overlay__row">
								{rk.map(function (k, ci) {
									var f = ri === row && ci === col;
									return <button key={k} class={'pin-overlay__key' + (f ? ' pin-overlay__key--focused' : '') + (k === '⌫' || k === 'OK' ? ' pin-overlay__key--action' : '')}>{k}</button>;
								})}
							</div>
						);
					})}
				</div>
				<div class="pin-overlay__hint">Back to cancel</div>
			</div>
		</div>
	);
}
