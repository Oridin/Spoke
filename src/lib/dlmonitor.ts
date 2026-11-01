import {
	sonarrConn, radarrConn,
	sonarrQueue, radarrQueue, sonarrHistory, radarrHistory,
	type HistoryRecord,
} from './arrapi';

type Conn = ReturnType<typeof sonarrConn>;

interface DlEvent {
	title: string;
	kind: 'finished' | 'failed';
}

interface MonitorState {
	sConn: Conn;
	rConn: Conn;
	timer: number;
	knownIds: Record<string, true>;
	seeded: boolean;
	queueActive: boolean;
	batchTimer: number;
	batch: DlEvent[];
}

var POLL_ACTIVE = 20000;
var POLL_IDLE = 60000;
var BATCH_WINDOW = 5000;
var LAST_OPEN_KEY = 'spoke-last-open';

var _state: MonitorState | null = null;
var _unread = 0;
var _onToast: ((msg: string, kind?: 'info' | 'error') => void) | null = null;
var _listeners: Array<() => void> = [];

function notify (): void {
	for (var i = 0; i < _listeners.length; i++) { try { _listeners[i](); } catch { /* */ } }
}

function flushBatch (): void {
	if (!_state || _state.batch.length === 0) return;
	var batch = _state.batch;
	_state.batch = [];
	_state.batchTimer = 0;

	var finished: string[] = [];
	var failed: string[] = [];
	for (var i = 0; i < batch.length; i++) {
		if (batch[i].kind === 'finished') finished.push(batch[i].title);
		else failed.push(batch[i].title);
	}

	_unread += batch.length;
	notify();

	if (!_onToast) return;
	if (finished.length === 1 && failed.length === 0) {
		_onToast('Finished: ' + finished[0]);
	} else if (failed.length === 1 && finished.length === 0) {
		_onToast('Download failed: ' + failed[0], 'error');
	} else {
		var parts: string[] = [];
		if (finished.length > 0) parts.push(finished.length + ' finished');
		if (failed.length > 0) parts.push(failed.length + ' failed');
		_onToast(parts.join(', '));
	}
}

function queueEvent (ev: DlEvent): void {
	if (!_state) return;
	_state.batch.push(ev);
	if (!_state.batchTimer) {
		_state.batchTimer = window.setTimeout(flushBatch, BATCH_WINDOW);
	}
}

function historyTitle (r: HistoryRecord): string {
	if (r.series) return r.series.title;
	if (r.movie) return r.movie.title;
	return r.sourceTitle || 'Unknown';
}

function isRelevant (eventType: string): 'finished' | 'failed' | null {
	if (eventType === 'downloadFolderImported') return 'finished';
	if (eventType === 'downloadFailed') return 'failed';
	return null;
}

function poll (): void {
	if (!_state) return;
	var s = _state;

	Promise.all([
		sonarrQueue(s.sConn).catch(function () { return {records: []}; }),
		radarrQueue(s.rConn).catch(function () { return {records: []}; }),
		sonarrHistory(s.sConn).catch(function () { return {records: []}; }),
		radarrHistory(s.rConn).catch(function () { return {records: []}; }),
	]).then(function (results) {
		if (!_state || _state !== s) return;

		var qLen = results[0].records.length + results[1].records.length;
		s.queueActive = qLen > 0;

		var allHistory = (results[2].records as HistoryRecord[]).concat(results[3].records as HistoryRecord[]);

		if (!s.seeded) {
			s.seeded = true;
			for (var i = 0; i < allHistory.length; i++) {
				var key = (allHistory[i].seriesId ? 's' : 'r') + allHistory[i].id;
				s.knownIds[key] = true;
			}
			checkAwayFinishes(allHistory);
		} else {
			for (var j = 0; j < allHistory.length; j++) {
				var rec = allHistory[j];
				var k = (rec.seriesId ? 's' : 'r') + rec.id;
				if (s.knownIds[k]) continue;
				s.knownIds[k] = true;
				var kind = isRelevant(rec.eventType);
				if (kind) queueEvent({title: historyTitle(rec), kind: kind});
			}
		}

		schedule();
	}).catch(function () {
		schedule();
	});
}

function schedule (): void {
	if (!_state) return;
	var ms = _state.queueActive ? POLL_ACTIVE : POLL_IDLE;
	_state.timer = window.setTimeout(poll, ms);
}

function checkAwayFinishes (records: HistoryRecord[]): void {
	var raw: string | null = null;
	try { raw = localStorage.getItem(LAST_OPEN_KEY); } catch { /* */ }

	try { localStorage.setItem(LAST_OPEN_KEY, String(Date.now())); } catch { /* */ }

	if (!raw || !_onToast) return;
	var lastOpen = parseInt(raw, 10);
	if (isNaN(lastOpen) || lastOpen <= 0) return;

	var finished = 0;
	var failed = 0;
	for (var i = 0; i < records.length; i++) {
		var rec = records[i];
		var kind = isRelevant(rec.eventType);
		if (!kind) continue;
		try {
			var ts = new Date(rec.date).getTime();
			if (ts > lastOpen) {
				if (kind === 'finished') finished++;
				else failed++;
			}
		} catch { /* */ }
	}

	var total = finished + failed;
	if (total === 0) return;

	_unread += total;
	notify();

	var parts: string[] = [];
	if (finished > 0) parts.push(finished + ' download' + (finished !== 1 ? 's' : '') + ' finished');
	if (failed > 0) parts.push(failed + ' failed');
	_onToast(parts.join(', ') + ' while you were away');
}

export function startMonitor (
	sonarrUrl: string, sonarrKey: string,
	radarrUrl: string, radarrKey: string,
	onToast: (msg: string, kind?: 'info' | 'error') => void
): void {
	stopMonitor();
	if (!sonarrUrl || !sonarrKey || !radarrUrl || !radarrKey) return;
	_onToast = onToast;
	_state = {
		sConn: sonarrConn({sonarrUrl: sonarrUrl, sonarrKey: sonarrKey}),
		rConn: radarrConn({radarrUrl: radarrUrl, radarrKey: radarrKey}),
		timer: 0,
		knownIds: {},
		seeded: false,
		queueActive: false,
		batchTimer: 0,
		batch: [],
	};
	poll();
}

export function stopMonitor (): void {
	if (!_state) return;
	window.clearTimeout(_state.timer);
	window.clearTimeout(_state.batchTimer);
	_state = null;
	_onToast = null;
}

export function getUnreadCount (): number { return _unread; }

export function clearUnread (): void {
	if (_unread === 0) return;
	_unread = 0;
	notify();
}

export function onUnreadChange (fn: () => void): () => void {
	_listeners.push(fn);
	return function () { _listeners = _listeners.filter(function (f) { return f !== fn; }); };
}
