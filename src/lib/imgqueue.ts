// Priority image queue for Plex poster loading.
// Limits concurrent requests to protect the seedbox transcoder.
// TMDB images (public CDN) should NOT use this queue — load them directly.
//
// Tuning:  MAX_CONCURRENT controls how many Plex transcoder requests fly at
//          once. Raise to 8 if the seedbox has headroom; lower to 3 if the
//          TV feels sluggish.

var MAX_CONCURRENT = 5;
var MAX_RETRIES = 3;
var TIMEOUT_MS = 15000;
var RETRY_DELAYS = [1000, 3000, 8000];

var _active = 0;
var _queue: {url: string; pri: number; retries: number}[] = [];
var _loaded = new Set<string>();
var _failed = new Set<string>();
var _pending = new Set<string>();
var _cb: (() => void) | null = null;
var _batchTimer = 0;

// debug counters
var _stats = {queued: 0, inflight: 0, completed: 0, failed: 0, retried: 0};

function pump () {
	while (_active < MAX_CONCURRENT && _queue.length > 0) {
		_queue.sort(function (a, b) { return a.pri - b.pri; });
		var next = _queue.shift()!;
		if (_loaded.has(next.url) || _pending.has(next.url)) continue;
		_active++;
		_pending.add(next.url);
		_stats.inflight = _active;
		startLoad(next.url, next.retries);
	}
	_stats.queued = _queue.length;
}

function startLoad (url: string, retries: number) {
	var img = new Image();
	var done = false;
	var timer = window.setTimeout(function () {
		if (done) return;
		done = true;
		img.onload = img.onerror = null;
		img.src = '';
		onFinish(url, false, retries);
	}, TIMEOUT_MS);

	img.onload = function () {
		if (done) return;
		done = true;
		window.clearTimeout(timer);
		onFinish(url, true, retries);
	};
	img.onerror = function () {
		if (done) return;
		done = true;
		window.clearTimeout(timer);
		onFinish(url, false, retries);
	};
	img.src = url;
}

function onFinish (url: string, success: boolean, retries: number) {
	_active--;
	_pending.delete(url);
	if (success) {
		_loaded.add(url);
		_failed.delete(url);
		_stats.completed++;
	} else if (retries < MAX_RETRIES) {
		_stats.retried++;
		var delay = RETRY_DELAYS[retries] || 8000;
		var r = retries;
		window.setTimeout(function () {
			_queue.push({url: url, pri: 0, retries: r + 1});
			pump();
		}, delay);
	} else {
		_failed.add(url);
		_stats.failed++;
	}
	_stats.inflight = _active;
	_stats.queued = _queue.length;
	batchNotify();
	pump();
}

function batchNotify () {
	if (_batchTimer) return;
	_batchTimer = window.setTimeout(function () {
		_batchTimer = 0;
		if (_cb) _cb();
	}, 60);
}

export function enqueue (url: string, priority: number): void {
	if (_loaded.has(url) || _pending.has(url)) return;
	_failed.delete(url);
	for (var i = 0; i < _queue.length; i++) {
		if (_queue[i].url === url) { _queue[i].pri = Math.min(_queue[i].pri, priority); return; }
	}
	_queue.push({url: url, pri: priority, retries: 0});
}

export function flush (): void { pump(); }

export function imgReady (url: string): boolean { return _loaded.has(url); }

export function onImgReady (fn: () => void): void { _cb = fn; }

export function pruneQueue (keep: Set<string>): void {
	_queue = _queue.filter(function (item) { return keep.has(item.url); });
	_stats.queued = _queue.length;
}

export function getStats (): {queued: number; inflight: number; completed: number; failed: number; retried: number} {
	return {queued: _stats.queued, inflight: _stats.inflight, completed: _stats.completed, failed: _stats.failed, retried: _stats.retried};
}
