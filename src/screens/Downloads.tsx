import {useCallback, useEffect, useMemo, useState} from 'preact/hooks';
import {useKeys, type NavKey} from '../hooks/useKeys';
import {useOkPress} from '../hooks/useOkPress';
import {useKeyTrap} from '../hooks/useKeyTrap';
import {
	sonarrConn, radarrConn,
	sonarrQueue, radarrQueue, sonarrHistory, radarrHistory,
	sonarrDeleteQueue, radarrDeleteQueue,
	type QueueRecord, type HistoryRecord,
} from '../lib/arrapi';

interface Props {
	sonarrUrl: string;
	sonarrKey: string;
	radarrUrl: string;
	radarrKey: string;
	active: boolean;
	onExitLeft: () => void;
	onExitDown?: () => void;
	onToast: (msg: string, kind?: 'info' | 'error') => void;
}

type TabId = 'queue' | 'history';

interface ListItem {
	id: string;
	queueId?: number;
	title: string;
	status: string;
	progress: number;
	eta: string;
	size: string;
	sizeleft: string;
	source: 'sonarr' | 'radarr';
	protocol: string;
	indexer: string;
	messages: string[];
	isHistory: boolean;
	historyEvent?: string;
	historyDate?: string;
	quality?: string;
	historyTimeline?: string;
}

interface ConfirmState {
	item: ListItem;
	btnIdx: number;
}

var REFRESH_INTERVAL = 10000;
var ROW_H = 56;
var VISIBLE_ROWS = 17;

function fmtSize (bytes: number): string {
	if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
	if (bytes >= 1048576) return Math.round(bytes / 1048576) + ' MB';
	if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
	return bytes + ' B';
}

function fmtEta (iso: string | undefined): string {
	if (!iso) return '';
	try {
		var ms = new Date(iso).getTime() - Date.now();
		if (ms < 0) return 'soon';
		var min = Math.ceil(ms / 60000);
		if (min < 60) return min + 'm';
		var h = Math.floor(min / 60);
		if (h < 24) return h + 'h ' + (min % 60) + 'm';
		return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
	} catch { return ''; }
}

function fmtDate (iso: string): string {
	try {
		var d = new Date(iso);
		var month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
		return month + ' ' + d.getDate();
	} catch { return ''; }
}

function eventLabel (t: string): string {
	if (t === 'grabbed') return 'Grabbed';
	if (t === 'downloadFolderImported') return 'Imported';
	if (t === 'downloadFailed') return 'Failed';
	if (t === 'episodeFileDeleted' || t === 'movieFileDeleted') return 'Deleted';
	if (t === 'episodeFileRenamed' || t === 'movieFileRenamed') return 'Renamed';
	return t;
}

var EVENT_PRIORITY: Record<string, number> = {
	'grabbed': 1,
	'episodeFileRenamed': 2,
	'movieFileRenamed': 2,
	'downloadFolderImported': 3,
	'episodeFileDeleted': 4,
	'movieFileDeleted': 4,
	'downloadFailed': 5,
};

function groupHistory (records: HistoryRecord[], source: 'sonarr' | 'radarr'): ListItem[] {
	var groups: Record<string, HistoryRecord[]> = {};
	var ungrouped: HistoryRecord[] = [];
	for (var i = 0; i < records.length; i++) {
		var h = records[i];
		if (h.downloadId) {
			if (!groups[h.downloadId]) groups[h.downloadId] = [];
			groups[h.downloadId].push(h);
		} else {
			ungrouped.push(h);
		}
	}
	var items: ListItem[] = [];
	var keys = Object.keys(groups);
	for (var k = 0; k < keys.length; k++) {
		var events = groups[keys[k]];
		events.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
		var best = events[0];
		var bestP = EVENT_PRIORITY[best.eventType] || 0;
		for (var e = 1; e < events.length; e++) {
			var p = EVENT_PRIORITY[events[e].eventType] || 0;
			if (p > bestP) { best = events[e]; bestP = p; }
		}
		var title = '';
		for (var t = 0; t < events.length; t++) {
			var rec = events[t];
			if (source === 'sonarr' && rec.series && rec.series.title) { title = rec.series.title; break; }
			if (source === 'radarr' && rec.movie && rec.movie.title) { title = rec.movie.title; break; }
		}
		if (!title) title = best.sourceTitle || 'Unknown';
		var hasImport = false;
		var timelineParts: string[] = [];
		for (var tl = 0; tl < events.length; tl++) {
			var et = events[tl].eventType;
			if (et === 'downloadFolderImported') hasImport = true;
			if (hasImport && (et === 'episodeFileRenamed' || et === 'movieFileRenamed')) continue;
			timelineParts.push(eventLabel(et));
		}
		var quality: string | undefined;
		for (var q = 0; q < events.length; q++) {
			if (events[q].quality && events[q].quality!.quality && events[q].quality!.quality!.name) { quality = events[q].quality!.quality!.name; break; }
		}
		items.push({
			id: (source === 'sonarr' ? 'sh-' : 'rh-') + best.id,
			title: title,
			status: eventLabel(best.eventType),
			progress: 100, eta: '', size: '', sizeleft: '',
			source: source, protocol: '', indexer: '', messages: [],
			isHistory: true,
			historyEvent: best.eventType,
			historyDate: events[events.length - 1].date,
			quality: quality,
			historyTimeline: timelineParts.length > 1 ? timelineParts.join(' → ') : undefined,
		});
	}
	for (var u = 0; u < ungrouped.length; u++) {
		var uh = ungrouped[u];
		var uTitle = source === 'sonarr'
			? (uh.series && uh.series.title ? uh.series.title : uh.sourceTitle || 'Unknown')
			: (uh.movie && uh.movie.title ? uh.movie.title : uh.sourceTitle || 'Unknown');
		items.push({
			id: (source === 'sonarr' ? 'sh-' : 'rh-') + uh.id,
			title: uTitle,
			status: eventLabel(uh.eventType),
			progress: 100, eta: '', size: '', sizeleft: '',
			source: source, protocol: '', indexer: '', messages: [],
			isHistory: true,
			historyEvent: uh.eventType,
			historyDate: uh.date,
			quality: uh.quality && uh.quality.quality ? uh.quality.quality.name : undefined,
		});
	}
	return items;
}

export function Downloads ({sonarrUrl, sonarrKey, radarrUrl, radarrKey, active, onExitLeft, onExitDown, onToast}: Props) {
	var [tab, setTab] = useState<TabId>('queue');
	var [queueItems, setQueueItems] = useState<ListItem[]>([]);
	var [historyItems, setHistoryItems] = useState<ListItem[]>([]);
	var [loading, setLoading] = useState(true);
	var [error, setError] = useState<string | null>(null);

	var [idx, setIdx] = useState(0);
	var [confirm, setConfirm] = useState<ConfirmState | null>(null);

	var sConn = useMemo(function () { return sonarrConn({sonarrUrl: sonarrUrl, sonarrKey: sonarrKey}); }, [sonarrUrl, sonarrKey]);
	var rConn = useMemo(function () { return radarrConn({radarrUrl: radarrUrl, radarrKey: radarrKey}); }, [radarrUrl, radarrKey]);

	var fetchQueue = useCallback(function () {
		return Promise.all([
			sonarrQueue(sConn).catch(function () { return {records: []} as {records: QueueRecord[]}; }),
			radarrQueue(rConn).catch(function () { return {records: []} as {records: QueueRecord[]}; }),
		]).then(function (results) {
			var items: ListItem[] = [];
			var sr = results[0].records;
			for (var i = 0; i < sr.length; i++) {
				var q = sr[i];
				var pct = q.size > 0 ? Math.round((1 - q.sizeleft / q.size) * 100) : 0;
				var msgs: string[] = [];
				if (q.statusMessages) for (var m = 0; m < q.statusMessages.length; m++) {
					if (q.statusMessages[m].messages) for (var mm = 0; mm < q.statusMessages[m].messages!.length; mm++) msgs.push(q.statusMessages[m].messages![mm]);
				}
				items.push({
					id: 'sq-' + q.id,
					queueId: q.id,
					title: q.title || (q.series ? q.series.title : 'Unknown'),
					status: q.trackedDownloadState || q.status,
					progress: pct,
					eta: fmtEta(q.estimatedCompletionTime),
					size: fmtSize(q.size),
					sizeleft: fmtSize(q.sizeleft),
					source: 'sonarr',
					protocol: q.protocol,
					indexer: q.indexer || '',
					messages: msgs,
					isHistory: false,
				});
			}
			var rr = results[1].records;
			for (var j = 0; j < rr.length; j++) {
				var rq = rr[j];
				var rpct = rq.size > 0 ? Math.round((1 - rq.sizeleft / rq.size) * 100) : 0;
				var rmsgs: string[] = [];
				if (rq.statusMessages) for (var rm = 0; rm < rq.statusMessages.length; rm++) {
					if (rq.statusMessages[rm].messages) for (var rmm = 0; rmm < rq.statusMessages[rm].messages!.length; rmm++) rmsgs.push(rq.statusMessages[rm].messages![rmm]);
				}
				items.push({
					id: 'rq-' + rq.id,
					queueId: rq.id,
					title: rq.title || (rq.movie ? rq.movie.title : 'Unknown'),
					status: rq.trackedDownloadState || rq.status,
					progress: rpct,
					eta: fmtEta(rq.estimatedCompletionTime),
					size: fmtSize(rq.size),
					sizeleft: fmtSize(rq.sizeleft),
					source: 'radarr',
					protocol: rq.protocol,
					indexer: rq.indexer || '',
					messages: rmsgs,
					isHistory: false,
				});
			}
			setQueueItems(items);
		});
	}, [sConn, rConn]);

	var fetchHistory = useCallback(function () {
		return Promise.all([
			sonarrHistory(sConn).catch(function () { return {records: []} as {records: HistoryRecord[]}; }),
			radarrHistory(rConn).catch(function () { return {records: []} as {records: HistoryRecord[]}; }),
		]).then(function (results) {
			var items = groupHistory(results[0].records, 'sonarr')
				.concat(groupHistory(results[1].records, 'radarr'));
			items.sort(function (a, b) {
				if (!a.historyDate || !b.historyDate) return 0;
				return b.historyDate < a.historyDate ? -1 : b.historyDate > a.historyDate ? 1 : 0;
			});
			setHistoryItems(items);
		});
	}, [sConn, rConn]);

	var [histPage, setHistPage] = useState(1);
	var [histHasMore, setHistHasMore] = useState(false);

	var loadMoreHistory = useCallback(function () {
		var next = histPage + 1;
		return Promise.all([
			sonarrHistory(sConn, next).catch(function () { return {records: []} as {records: HistoryRecord[]}; }),
			radarrHistory(rConn, next).catch(function () { return {records: []} as {records: HistoryRecord[]}; }),
		]).then(function (results) {
			var more = groupHistory(results[0].records, 'sonarr')
				.concat(groupHistory(results[1].records, 'radarr'));
			more.sort(function (a, b) {
				if (!a.historyDate || !b.historyDate) return 0;
				return b.historyDate < a.historyDate ? -1 : b.historyDate > a.historyDate ? 1 : 0;
			});
			if (more.length === 0) setHistHasMore(false);
			else { setHistoryItems(function (prev) { return prev.concat(more); }); setHistPage(next); }
		});
	}, [sConn, rConn, histPage]);

	useEffect(function () {
		fetchQueue()
			.then(function () {
				setLoading(false); setError(null);
				return fetchHistory().then(function () {
					setHistHasMore(true);
				});
			})
			.catch(function (e) { setError(e && e.message || 'Failed to load'); setLoading(false); });
	}, [fetchQueue, fetchHistory]);

	useEffect(function () {
		if (!active) return undefined;
		var t = window.setInterval(function () { fetchQueue(); }, REFRESH_INTERVAL);
		return function () { window.clearInterval(t); };
	}, [active, fetchQueue]);

	var items = tab === 'queue' ? queueItems : historyItems;
	var scrollOffset = useMemo(function () {
		if (idx < VISIBLE_ROWS) return 0;
		return (idx - VISIBLE_ROWS + 1) * ROW_H;
	}, [idx]);

	var doCancel = useCallback(function () {
		if (!confirm) return;
		var item = confirm.item;
		if (!item.queueId) return;
		var conn = item.source === 'sonarr' ? sConn : rConn;
		var del = item.source === 'sonarr' ? sonarrDeleteQueue : radarrDeleteQueue;
		del(conn, item.queueId, true)
			.then(function () { onToast(item.title + ' cancelled'); setConfirm(null); fetchQueue(); })
			.catch(function () { onToast('Cancel failed', 'error'); });
	}, [confirm, sConn, rConn, onToast, fetchQueue]);

	var handleConfirmTrap = useCallback(function (e: KeyboardEvent) {
		if (!confirm) return;
		var code = e.keyCode;
		if (code === 461 || code === 27) { setConfirm(null); return; }
		if (code === 37 || code === 39) {
			setConfirm(function (c) { return c ? Object.assign({}, c, {btnIdx: c.btnIdx === 0 ? 1 : 0}) : null; });
			return;
		}
		if (code === 13) {
			if (confirm.btnIdx === 0) setConfirm(null);
			else doCancel();
		}
	}, [confirm, doCancel]);

	useKeyTrap(handleConfirmTrap, active && !!confirm);

	var handleKey = useCallback(function (key: NavKey): boolean {
		if (key === 'back') {
			onExitLeft();
			return true;
		}
		if (key === 'up') {
			if (idx > 0) setIdx(idx - 1);
			return true;
		}
		if (key === 'down') {
			if (idx < items.length - 1) setIdx(idx + 1);
			else if (tab === 'history' && histHasMore) loadMoreHistory();
			else if (onExitDown) onExitDown();
			return true;
		}
		if (key === 'left') {
			if (tab === 'history') { setTab('queue'); setIdx(0); }
			else onExitLeft();
			return true;
		}
		if (key === 'right') {
			if (tab === 'queue') { setTab('history'); setIdx(0); }
			return true;
		}
		return true;
	}, [idx, items, tab, onExitLeft, onExitDown, histHasMore, loadMoreHistory]);

	useKeys(handleKey, active && !confirm);

	useOkPress({
		onPress: function () {
			if (confirm) return;
			var item = items[idx];
			if (!item) return;
			if (!item.isHistory && item.queueId) {
				setConfirm({item: item, btnIdx: 0});
			}
		},
		onLongPress: function () {}
	}, active && !confirm);

	if (loading) return <div class="cinema__empty">Loading downloads…</div>;
	if (error) return <div class="cinema__empty">{'Error: ' + error}</div>;

	return (
		<div class="downloads">
			<div class="downloads__tabs">
				<button class={'downloads__tab' + (tab === 'queue' ? ' downloads__tab--active' : '')}>Queue{queueItems.length > 0 ? ' (' + queueItems.length + ')' : ''}</button>
				<button class={'downloads__tab' + (tab === 'history' ? ' downloads__tab--active' : '')}>History</button>
			</div>

			<div class="downloads__list" style={'transform:translate3d(0,' + (-scrollOffset) + 'px,0)'}>
				{items.length === 0 && (
					<div class="downloads__empty">{tab === 'queue' ? 'No active downloads' : 'No history'}</div>
				)}
				{items.map(function (item, i) {
					var focused = i === idx;
					return (
						<div key={item.id} class={'downloads__item' + (focused ? ' downloads__item--focused' : '')}>
							<div class="downloads__item-title">{item.title}</div>
							<div class="downloads__item-meta">
								{!item.isHistory && (
									<>
										<span class={'downloads__status downloads__status--' + item.status}>{item.status}</span>
										{item.progress < 100 && <span class="downloads__pct">{item.progress + '%'}</span>}
										{item.eta && <span class="downloads__eta">{item.eta}</span>}
										{item.size && <span class="downloads__size">{item.size}</span>}
									</>
								)}
								{item.isHistory && (
									<>
										<span class={'downloads__status downloads__status--' + (item.historyEvent || '')}>{item.status}</span>
										{item.historyTimeline && <span class="downloads__timeline">{item.historyTimeline}</span>}
										{item.quality && <span class="downloads__quality">{item.quality}</span>}
										{item.historyDate && <span class="downloads__date">{fmtDate(item.historyDate)}</span>}
									</>
								)}
								<span class="downloads__source">{item.source === 'sonarr' ? 'TV' : 'Movie'}</span>
							</div>
							{!item.isHistory && item.progress < 100 && (
								<div class="downloads__bar">
									<div class="downloads__bar-fill" style={'width:' + item.progress + '%'} />
								</div>
							)}
						</div>
					);
				})}
			</div>
			{tab === 'history' && histHasMore && (
				<div class="downloads__load-more">Load more history…</div>
			)}

			{/* cancel confirm */}
			{confirm && (
				<div class="downloads__confirm-overlay">
					<div class="downloads__confirm-box">
						<h3>Cancel Download?</h3>
						<p>Cancel <strong>{confirm.item.title}</strong>? This will remove it from the download client.</p>
						<div class="watchlist__confirm-btns">
							<button class={'cinema__panel-btn' + (confirm.btnIdx === 0 ? ' cinema__panel-btn--focused' : '')}>Keep</button>
							<button class={'cinema__panel-btn cinema__panel-btn--danger' + (confirm.btnIdx === 1 ? ' cinema__panel-btn--focused' : '')}>Cancel Download</button>
						</div>
					</div>
				</div>
			)}

			<div class="downloads__note">Fetchbox/seedbox grabs are not shown here.</div>
		</div>
	);
}
