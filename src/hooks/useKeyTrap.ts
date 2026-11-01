import {useLayoutEffect, useRef} from 'preact/hooks';
import {pushKeyTrap, popKeyTrap} from '../lib/keytrap';

/** Capture all keyboard events while `active`, routing them through `handler`
 *  and preventing anything underneath from seeing them.  Uses useLayoutEffect
 *  so the trap installs synchronously after the DOM update, before the browser
 *  can dispatch the keyup from the press that opened the overlay. */
export function useKeyTrap (handler: (e: KeyboardEvent) => void, active: boolean): void {
	var ref = useRef(handler);
	ref.current = handler;
	useLayoutEffect(function () {
		if (!active) return undefined;
		pushKeyTrap(function (e) { ref.current(e); });
		return function () { popKeyTrap(); };
	}, [active]);
}
