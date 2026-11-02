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

export function Downloads ({sonarrUrl, sonarrKey, radarrUrl, radarrKey, active, onExitLeft, onToast}: Props) {
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
			var items: ListItem[] = [];
			var sr = results[0].records;
			for (var i = 0; i < sr.length; i++) {
				var h = sr[i];
				items.push({
					id: 'sh-' + h.id,
					title: h.sourceTitle || (h.series ? h.series.title : 'Unknown'),
					status: eventLabel(h.eventType),
					progress: 100,
					eta: '',
					size: '',
					sizeleft: '',
					source: 'sonarr',
					protocol: '',
					indexer: '',
					messages: [],
					isHistory: true,
					historyEvent: h.eventType,
					historyDate: h.date,
					quality: h.quality && h.quality.quality ? h.quality.quality.name : undefined,
				});
			}
			var rr = results[1].records;
			for (var j = 0; j < rr.length; j++) {
				var rh = rr[j];
				items.push({
					id: 'rh-' + rh.id,
					title: rh.sourceTitle || (rh.movie ? rh.movie.title : 'Unknown'),
					status: eventLabel(rh.eventType),
					progress: 100,
					eta: '',
					size: '',
					sizeleft: '',
					source: 'radarr',
					protocol: '',
					indexer: '',
					messages: [],
					isHistory: true,
					historyEvent: rh.eventType,
					historyDate: rh.date,
					quality: rh.quality && rh.quality.quality ? rh.quality.quality.name : undefined,
				});
			}
			items.sort(function (a, b) {
				if (!a.historyDate || !b.historyDate) return 0;
				return b.historyDate < a.historyDate ? -1 : b.historyDate > a.historyDate ? 1 : 0;
			});
			setHistoryItems(items);
		});
	}, [sConn, rConn]);

	useEffect(function () {
		Promise.all([fetchQueue(), fetchHistory()])
			.then(function () { setLoading(false); setError(null); })
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
	}, [idx, items, tab, onExitLeft]);

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
