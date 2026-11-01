// Shared modal key barrier. When an overlay pushes a handler, all keyboard
// events are captured at the document level (capture phase) before they can
// reach any bubble-phase listeners on window. The topmost handler receives
// keydown events; keyup events are swallowed. A brief guard after pop
// prevents the closing key-release from reaching the screen underneath.

var _stack: ((e: KeyboardEvent) => void)[] = [];
var _installed = false;
var _removeTimer = 0;

function onCapture (e: KeyboardEvent) {
	e.stopImmediatePropagation();
	e.preventDefault();
	if (_stack.length > 0 && e.type === 'keydown') {
		_stack[_stack.length - 1](e);
	}
}

export function pushKeyTrap (handler: (e: KeyboardEvent) => void): void {
	window.clearTimeout(_removeTimer);
	_stack.push(handler);
	if (!_installed) {
		document.addEventListener('keydown', onCapture, true);
		document.addEventListener('keyup', onCapture, true);
		_installed = true;
	}
}

export function popKeyTrap (): void {
	_stack.pop();
	if (_stack.length === 0) {
		window.clearTimeout(_removeTimer);
		_removeTimer = window.setTimeout(function () {
			if (_stack.length === 0 && _installed) {
				document.removeEventListener('keydown', onCapture, true);
				document.removeEventListener('keyup', onCapture, true);
				_installed = false;
			}
		}, 150);
	}
}
