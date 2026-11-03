import {useCallback, useEffect, useMemo, useRef, useState} from 'preact/hooks';
import {useKeys, clamp, type NavKey} from '../hooks/useKeys';
import {useOkPress} from '../hooks/useOkPress';
import {useKeyTrap} from '../hooks/useKeyTrap';
import {
	sonarrConn, radarrConn, sonarrGetSeries, radarrGetMovies,
	sonarrCalendar, sonarrQueue, radarrQueue,
	sonarrCommand, radarrCommand,
	sonarrPutSeries, radarrPutMovie,
	sonarrDeleteSeries, radarrDeleteMovie,
	sonarrGetEpisodes,
	arrPosterUrl, arrFanartUrl,
	downloadMovie, downloadSeriesPrep, downloadSeries, downloadSeriesListEpisodes,
	type SonarrSeries, type RadarrMovie, type SonarrCalendarEntry,
	type QueueRecord, type DlSeasonInfo, type SonarrEpisode, type DownloadScope,
} from '../lib/arrapi';
var WL_CACHE_KEY = 'spoke_wl_cache';
var WL_CACHE_TTL = 600000;

interface WlCache {
	ts: number;
	series: SonarrSeries[];
	movies: RadarrMovie[];
	calendar: SonarrCalendarEntry[];
}

function readCache (): WlCache | null {
	try {
		var raw = localStorage.getItem(WL_CACHE_KEY);
		if (!raw) return null;
		var c: WlCache = JSON.parse(raw);
		if (!c || !c.ts) return null;
		return c;
	} catch { return null; }
}

function writeCache (series: SonarrSeries[], movies: RadarrMovie[], calendar: SonarrCalendarEntry[]): void {
	try {
		localStorage.setItem(WL_CACHE_KEY, JSON.stringify({ts: Date.now(), series: series, movies: movies, calendar: calendar}));
	} catch {}
}

interface Props {
	sonarrUrl: string;
	sonarrKey: string;
	radarrUrl: string;
	radarrKey: string;
	active: boolean;
	onExitLeft: () => void;
	onExitDown?: () => void;
	onToast: (msg: string, kind?: 'info' | 'error') => void;
	enableDelete: boolean;
	onOpenShowDetail?: (title: string, year: number, tvdbId?: number) => void;
}

type WatchZone = 'rows' | 'detail';
type MediaFilter = 'all' | 'tv' | 'movies';

interface WatchItem {
	id: string;
	title: string;
	year: number;
	mediaType: 'tv' | 'movie';
	poster: string | null;
	fanart: string | null;
	overview: string | null;
	status: string;
	sizeOnDisk: number;
	hasFile: boolean;
	monitored: boolean;
	section: 'upcoming' | 'downloading' | 'available' | 'waiting';
	sonarrSeries?: SonarrSeries;
	radarrMovie?: RadarrMovie;
	queueRecord?: QueueRecord;
	calendarEntry?: SonarrCalendarEntry;
	downloadProgress?: number;
	eta?: string;
}

interface ContentRow { title: string; items: WatchItem[] }

interface DetailState {
	item: WatchItem;
	btnIdx: number;
	confirming: null | 'unmonitor' | 'delete' | 'search';
	searchEpCount?: number;
	level?: null | 'dl-scope' | 'dl-seasons' | 'dl-episodes' | 'dl-confirm';
	dlSeasons?: DlSeasonInfo[];
	dlEpisodes?: SonarrEpisode[];
	dlMode?: 'episode' | 'season';
	dlSeasonNumber?: number;
	dlPendingScope?: DownloadScope;
	dlPendingCount?: number;
	dlCounts?: {lastSeason: number; all: number} | null;
	loading?: boolean;
}

var CARD_W = 200;
var CARD_GAP = 20;
var CARD_STEP = CARD_W + CARD_GAP;
var VIEW_W = 1700;
var ROW_SCROLL = 460;
var HERO_DEBOUNCE = 250;
var REFRESH_INTERVAL = 30000;

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

export function Watchlist ({sonarrUrl, sonarrKey, radarrUrl, radarrKey, active, onExitLeft, onExitDown, onToast, enableDelete, onOpenShowDetail}: Props) {
	var cached = useMemo(readCache, []);
	var [series, setSeries] = useState<SonarrSeries[]>(function () { return cached ? cached.series : []; });
	var [movies, setMovies] = useState<RadarrMovie[]>(function () { return cached ? cached.movies : []; });
	var [calendar, setCalendar] = useState<SonarrCalendarEntry[]>(function () { return cached ? cached.calendar : []; });
	var [sonarrQ, setSonarrQ] = useState<QueueRecord[]>([]);
	var [radarrQ, setRadarrQ] = useState<QueueRecord[]>([]);
	var [loading, setLoading] = useState(!cached);
	var [updating, setUpdating] = useState(false);
	var [error, setError] = useState<string | null>(null);
	var [mediaFilter] = useState<MediaFilter>('all');
	var lastFullFetch = useRef(cached ? cached.ts : 0);

	var [zone, setZone] = useState<WatchZone>('rows');
	var [rowIdx, setRowIdx] = useState(0);
	var [cols, setCols] = useState<Record<number, number>>({});
	var [detail, setDetail] = useState<DetailState | null>(null);

	var [heroItem, setHeroItem] = useState<WatchItem | null>(null);
	var [bdSlot, setBdSlot] = useState(0);
	var bdSlotRef = useRef(0);
	var [bdUrl0, setBdUrl0] = useState<string | null>(null);
	var [bdUrl1, setBdUrl1] = useState<string | null>(null);
	var debounceRef = useRef(0);
	var heroInitRef = useRef(false);
	var focusedItemRef = useRef<WatchItem | null>(null);

	var sConn = useMemo(function () { return sonarrConn({sonarrUrl: sonarrUrl, sonarrKey: sonarrKey}); }, [sonarrUrl, sonarrKey]);
	var rConn = useMemo(function () { return radarrConn({radarrUrl: radarrUrl, radarrKey: radarrKey}); }, [radarrUrl, radarrKey]);

	var fetchFull = useCallback(function () {
		var now = new Date();
		var start = now.toISOString().slice(0, 10);
		var end = new Date(now.getTime() + 30 * 86400000).toISOString().slice(0, 10);
		setUpdating(true);
		return Promise.all([
			sonarrGetSeries(sConn).catch(function () { return [] as SonarrSeries[]; }),
			radarrGetMovies(rConn).catch(function () { return [] as RadarrMovie[]; }),
			sonarrCalendar(sConn, start, end).catch(function () { return [] as SonarrCalendarEntry[]; }),
			sonarrQueue(sConn).catch(function () { return {records: []} as {records: QueueRecord[]}; }),
			radarrQueue(rConn).catch(function () { return {records: []} as {records: QueueRecord[]}; }),
		]).then(function (results) {
			setSeries(results[0]);
			setMovies(results[1]);
			setCalendar(results[2]);
			setSonarrQ(results[3].records);
			setRadarrQ(results[4].records);
			setLoading(false);
			setUpdating(false);
			setError(null);
			lastFullFetch.current = Date.now();
			writeCache(results[0], results[1], results[2]);
		}).catch(function (e) {
			setError(e && e.message || 'Failed to load');
			setLoading(false);
			setUpdating(false);
		});
	}, [sConn, rConn, onToast]);

	var fetchQueue = useCallback(function () {
		return Promise.all([
			sonarrQueue(sConn).catch(function () { return {records: []} as {records: QueueRecord[]}; }),
			radarrQueue(rConn).catch(function () { return {records: []} as {records: QueueRecord[]}; }),
		]).then(function (r) {
			setSonarrQ(r[0].records);
			setRadarrQ(r[1].records);
		});
	}, [sConn, rConn]);

	useEffect(function () {
		fetchFull();
	}, [fetchFull]);

	useEffect(function () {
		if (!active) return;
		if (Date.now() - lastFullFetch.current > WL_CACHE_TTL) fetchFull();
		else fetchQueue();
	}, [active]);

	useEffect(function () {
		if (!active) return undefined;
		var t = window.setInterval(function () {
			fetchQueue();
		}, REFRESH_INTERVAL);
		return function () { window.clearInterval(t); };
	}, [active, fetchQueue]);

	var watchItems: WatchItem[] = useMemo(function () {
		var items: WatchItem[] = [];
		var calendarSeriesEps = new Set<string>();
		for (var c = 0; c < calendar.length; c++) {
			calendarSeriesEps.add(calendar[c].seriesId + '-' + calendar[c].seasonNumber + '-' + calendar[c].episodeNumber);
		}

		var queueSeriesIds = new Set<number>();
		for (var q = 0; q < sonarrQ.length; q++) {
			if (sonarrQ[q].seriesId) queueSeriesIds.add(sonarrQ[q].seriesId!);
		}
		var queueMovieIds = new Set<number>();
		for (var q2 = 0; q2 < radarrQ.length; q2++) {
			if (radarrQ[q2].movieId) queueMovieIds.add(radarrQ[q2].movieId!);
		}

		var calendarSeriesIds = new Set<number>();
		for (var c2 = 0; c2 < calendar.length; c2++) {
			if (!calendar[c2].hasFile) calendarSeriesIds.add(calendar[c2].seriesId);
		}

		for (var i = 0; i < series.length; i++) {
			var s = series[i];
			if (!s.monitored) continue;
			if (mediaFilter === 'movies') continue;
			var section: WatchItem['section'] = 'waiting';
			var qr: QueueRecord | undefined;
			if (queueSeriesIds.has(s.id)) {
				section = 'downloading';
				for (var qi = 0; qi < sonarrQ.length; qi++) { if (sonarrQ[qi].seriesId === s.id) { qr = sonarrQ[qi]; break; } }
			} else if (calendarSeriesIds.has(s.id)) {
				section = 'upcoming';
			} else if (s.statistics && s.statistics.episodeFileCount && s.statistics.episodeFileCount > 0) {
				section = 'available';
			}
			var calEntry: SonarrCalendarEntry | undefined;
			for (var ci = 0; ci < calendar.length; ci++) { if (calendar[ci].seriesId === s.id && !calendar[ci].hasFile) { calEntry = calendar[ci]; break; } }
			var progress = qr ? (qr.size > 0 ? Math.round((1 - qr.sizeleft / qr.size) * 100) : 0) : undefined;
			items.push({
				id: 'sonarr-' + s.id,
				title: s.title,
				year: s.year,
				mediaType: 'tv',
				poster: arrPosterUrl(s.images),
				fanart: arrFanartUrl(s.images),
				overview: s.overview || null,
				status: s.status,
				sizeOnDisk: s.statistics && s.statistics.sizeOnDisk || 0,
				hasFile: !!(s.statistics && s.statistics.episodeFileCount && s.statistics.episodeFileCount > 0),
				monitored: s.monitored,
				section: section,
				sonarrSeries: s,
				queueRecord: qr,
				calendarEntry: calEntry,
				downloadProgress: progress,
				eta: qr ? fmtEta(qr.estimatedCompletionTime) : undefined,
			});
		}

		for (var j = 0; j < movies.length; j++) {
			var m = movies[j];
			if (!m.monitored) continue;
			if (mediaFilter === 'tv') continue;
			var mSection: WatchItem['section'] = 'waiting';
			var mqr: QueueRecord | undefined;
			if (queueMovieIds.has(m.id)) {
				mSection = 'downloading';
				for (var mqi = 0; mqi < radarrQ.length; mqi++) { if (radarrQ[mqi].movieId === m.id) { mqr = radarrQ[mqi]; break; } }
			} else if (m.hasFile) {
				mSection = 'available';
			}
			var mProgress = mqr ? (mqr.size > 0 ? Math.round((1 - mqr.sizeleft / mqr.size) * 100) : 0) : undefined;
			items.push({
				id: 'radarr-' + m.id,
				title: m.title,
				year: m.year,
				mediaType: 'movie',
				poster: arrPosterUrl(m.images),
				fanart: arrFanartUrl(m.images),
				overview: m.overview || null,
				status: m.status,
				sizeOnDisk: m.sizeOnDisk || 0,
				hasFile: m.hasFile,
				monitored: m.monitored,
				section: mSection,
				radarrMovie: m,
				queueRecord: mqr,
				downloadProgress: mProgress,
				eta: mqr ? fmtEta(mqr.estimatedCompletionTime) : undefined,
			});
		}

		return items;
	}, [series, movies, calendar, sonarrQ, radarrQ, mediaFilter]);

	var contentRows: ContentRow[] = useMemo(function () {
		var downloading = watchItems.filter(function (w) { return w.section === 'downloading'; });
		var upcoming = watchItems.filter(function (w) { return w.section === 'upcoming'; });
		var available = watchItems.filter(function (w) { return w.section === 'available'; });
		available.sort(function (a, b) { return b.sizeOnDisk - a.sizeOnDisk; });
		var waiting = watchItems.filter(function (w) { return w.section === 'waiting'; });
		waiting.sort(function (a, b) { return a.title < b.title ? -1 : a.title > b.title ? 1 : 0; });

		var rows: ContentRow[] = [];
		if (downloading.length > 0) rows.push({title: 'Downloading', items: downloading});
		if (upcoming.length > 0) rows.push({title: 'Upcoming', items: upcoming});
		if (available.length > 0) rows.push({title: 'Available', items: available});
		if (waiting.length > 0) rows.push({title: 'Waiting', items: waiting});
		return rows;
	}, [watchItems]);

	var col = cols[rowIdx] || 0;
	var currentRow = contentRows[rowIdx];

	var focusedItem: WatchItem | null = useMemo(function () {
		if (zone === 'rows' && currentRow) return currentRow.items[col] || currentRow.items[0] || null;
		if (contentRows.length > 0 && contentRows[0].items.length > 0) return contentRows[0].items[0];
		return null;
	}, [zone, currentRow, col, contentRows]);

	focusedItemRef.current = focusedItem;
	var focusedId = focusedItem ? focusedItem.id : '';

	useEffect(function () {
		if (!focusedItem) return;
		if (!heroInitRef.current) {
			heroInitRef.current = true;
			setHeroItem(focusedItem);
			setBdUrl0(focusedItem.fanart);
			setBdSlot(0);
			bdSlotRef.current = 0;
			return;
		}
		window.clearTimeout(debounceRef.current);
		debounceRef.current = window.setTimeout(function () {
			var item = focusedItemRef.current;
			if (!item) return;
			setHeroItem(item);
			var url = item.fanart;
			var next = bdSlotRef.current === 0 ? 1 : 0;
			if (next === 0) setBdUrl0(url);
			else setBdUrl1(url);
			setBdSlot(next);
			bdSlotRef.current = next;
		}, HERO_DEBOUNCE);
		return function () { window.clearTimeout(debounceRef.current); };
	}, [focusedId]);

	// --- detail panel actions ---

	var detailBtns: {label: string; action: string}[] = useMemo(function () {
		if (!detail) return [];
		var btns: {label: string; action: string}[] = [];
		var item = detail.item;
		if (item.section === 'waiting' || item.section === 'upcoming') {
			btns.push({label: 'Search Now', action: 'search'});
		}
		btns.push({label: 'Download', action: 'download'});
		btns.push({label: 'Stop Monitoring', action: 'unmonitor'});
		if (enableDelete && item.hasFile) {
			btns.push({label: 'Remove from Library', action: 'delete'});
		}
		return btns;
	}, [detail, enableDelete]);

	var doSearch = useCallback(function () {
		if (!detail) return;
		var item = detail.item;
		if (item.sonarrSeries) {
			onToast('Searching for ' + item.title + '…');
			sonarrCommand(sConn, 'SeriesSearch', {seriesId: item.sonarrSeries.id})
				.then(function () { onToast('Search started for ' + item.title); setDetail(null); })
				.catch(function () { onToast('Search failed', 'error'); });
		} else if (item.radarrMovie) {
			onToast('Searching for ' + item.title + '…');
			radarrCommand(rConn, 'MoviesSearch', {movieIds: [item.radarrMovie.id]})
				.then(function () { onToast('Search started for ' + item.title); setDetail(null); })
				.catch(function () { onToast('Search failed', 'error'); });
		}
	}, [detail, sConn, rConn, onToast]);

	var doUnmonitor = useCallback(function () {
		if (!detail) return;
		var item = detail.item;
		if (item.sonarrSeries) {
			var updated = Object.assign({}, item.sonarrSeries, {monitored: false});
			sonarrPutSeries(sConn, updated)
				.then(function () { onToast(item.title + ' removed from watchlist'); setDetail(null); fetchFull(); })
				.catch(function () { onToast('Failed to update', 'error'); });
		} else if (item.radarrMovie) {
			var updatedM = Object.assign({}, item.radarrMovie, {monitored: false});
			radarrPutMovie(rConn, updatedM)
				.then(function () { onToast(item.title + ' removed from watchlist'); setDetail(null); fetchFull(); })
				.catch(function () { onToast('Failed to update', 'error'); });
		}
	}, [detail, sConn, rConn, onToast, fetchFull]);

	var doDelete = useCallback(function () {
		if (!detail) return;
		var item = detail.item;
		if (item.sonarrSeries) {
			sonarrDeleteSeries(sConn, item.sonarrSeries.id, true)
				.then(function () { onToast(item.title + ' removed'); setDetail(null); fetchFull(); })
				.catch(function () { onToast('Delete failed', 'error'); });
		} else if (item.radarrMovie) {
			radarrDeleteMovie(rConn, item.radarrMovie.id, true)
				.then(function () { onToast(item.title + ' removed'); setDetail(null); fetchFull(); })
				.catch(function () { onToast('Delete failed', 'error'); });
		}
	}, [detail, sConn, rConn, onToast, fetchFull]);

	// --- download ---

	var dlBusyRef = useRef(false);
	var dlPollRef = useRef(0);

	var startWlDownload = useCallback(function () {
		if (!detail || dlBusyRef.current) return;
		var item = detail.item;
		if (item.radarrMovie) {
			dlBusyRef.current = true;
			setDetail(function (d) { return d ? Object.assign({}, d, {loading: true}) : null; });
			downloadMovie(rConn, item.radarrMovie.tmdbId).then(function (result) {
				if (result.alreadyHasFile) {
					onToast(result.title + ' is already downloaded');
					setDetail(null); dlBusyRef.current = false;
					return;
				}
				if (result.qualityUpgraded) onToast('Quality upgraded to HD-1080p');
				onToast('Searching for ' + result.title + '…');
				setDetail(null);
				var count = 0;
				dlPollRef.current = window.setInterval(function () {
					count++;
					if (count > 10) {
						window.clearInterval(dlPollRef.current);
						dlBusyRef.current = false;
						onToast('No releases found yet. ' + result.title + ' stays on your Watchlist and will download when one appears.');
						return;
					}
					radarrQueue(rConn).then(function (q) {
						for (var i = 0; i < q.records.length; i++) {
							if (q.records[i].movieId === result.movieId) {
								var rec = q.records[i];
								window.clearInterval(dlPollRef.current);
								dlBusyRef.current = false;
								var sz = rec.size >= 1073741824 ? (rec.size / 1073741824).toFixed(1) + ' GB' : Math.round(rec.size / 1048576) + ' MB';
								onToast('Grabbed: ' + rec.title + ' (' + sz + ')');
								return;
							}
						}
					}).catch(function () { });
				}, 3000);
			}).catch(function (e) {
				onToast(e && e.message || 'Download failed', 'error');
				setDetail(function (d) { return d ? Object.assign({}, d, {loading: false}) : null; });
				dlBusyRef.current = false;
			});
		} else if (item.sonarrSeries) {
			setDetail(function (d) { return d ? Object.assign({}, d, {loading: true}) : null; });
			downloadSeriesPrep(sConn, {tvdbId: item.sonarrSeries.tvdbId}).then(function (prep) {
				setDetail(function (d) { return d ? Object.assign({}, d, {level: 'dl-scope', btnIdx: 4, loading: false, dlCounts: prep, dlSeasons: prep.seasons}) : null; });
			}).catch(function (e) {
				onToast(e && e.message || 'Lookup failed', 'error');
				setDetail(function (d) { return d ? Object.assign({}, d, {loading: false}) : null; });
			});
		}
	}, [detail, sConn, rConn, onToast]);

	var executeWlDlScope = useCallback(function (scope: DownloadScope) {
		if (!detail || dlBusyRef.current || !detail.item.sonarrSeries) return;
		dlBusyRef.current = true;
		setDetail(function (d) { return d ? Object.assign({}, d, {loading: true}) : null; });
		var tvdbId = detail.item.sonarrSeries.tvdbId;
		var title = detail.item.title;
		downloadSeries(sConn, {tvdbId: tvdbId}, scope)
			.then(function (result) {
				onToast('Searching for ' + title + '…');
				setDetail(null);
				if (result.monitoredCount > 0) onToast('Monitoring ' + result.monitoredCount + ' episode' + (result.monitoredCount !== 1 ? 's' : '') + ' of ' + title);
				var count = 0;
				dlPollRef.current = window.setInterval(function () {
					count++;
					if (count > 10) {
						window.clearInterval(dlPollRef.current);
						dlBusyRef.current = false;
						onToast('No releases found yet. ' + title + ' stays on your Watchlist and will download when one appears.');
						return;
					}
					sonarrQueue(sConn).then(function (q) {
						for (var i = 0; i < q.records.length; i++) {
							if (q.records[i].seriesId != null) {
								var rec = q.records[i];
								window.clearInterval(dlPollRef.current);
								dlBusyRef.current = false;
								var sz = rec.size >= 1073741824 ? (rec.size / 1073741824).toFixed(1) + ' GB' : Math.round(rec.size / 1048576) + ' MB';
								onToast('Grabbed: ' + rec.title + ' (' + sz + ')');
								return;
							}
						}
					}).catch(function () { });
				}, 3000);
			}).catch(function (e) {
				onToast(e && e.message || 'Download failed', 'error');
				setDetail(function (d) { return d ? Object.assign({}, d, {loading: false}) : null; });
				dlBusyRef.current = false;
			});
	}, [detail, sConn, onToast]);

	var selectWlDlScope = useCallback(function (scope: DownloadScope, count: number) {
		if (count > 30) {
			setDetail(function (d) { return d ? Object.assign({}, d, {level: 'dl-confirm', btnIdx: 0, dlPendingScope: scope, dlPendingCount: count}) : null; });
		} else {
			executeWlDlScope(scope);
		}
	}, [executeWlDlScope]);

	useEffect(function () {
		return function () { if (dlPollRef.current) window.clearInterval(dlPollRef.current); };
	}, []);

	// --- confirm dialog key trap ---

	var handleConfirmTrap = useCallback(function (e: KeyboardEvent) {
		if (!detail || !detail.confirming) return;
		var code = e.keyCode;
		if (code === 461 || code === 27) {
			setDetail(function (d) { return d ? Object.assign({}, d, {confirming: null, btnIdx: 0}) : null; });
			return;
		}
		if (code === 37 || code === 39) {
			setDetail(function (d) { return d ? Object.assign({}, d, {btnIdx: d.btnIdx === 0 ? 1 : 0}) : null; });
			return;
		}
		if (code === 13) {
			if (detail.btnIdx === 0) {
				setDetail(function (d) { return d ? Object.assign({}, d, {confirming: null, btnIdx: 0}) : null; });
			} else {
				if (detail.confirming === 'unmonitor') doUnmonitor();
				else if (detail.confirming === 'delete') doDelete();
				else if (detail.confirming === 'search') doSearch();
			}
		}
	}, [detail, doUnmonitor, doDelete, doSearch]);

	useKeyTrap(handleConfirmTrap, active && !!detail && !!detail.confirming);

	// --- keyboard navigation ---

	var handleKey = useCallback(function (key: NavKey): boolean {
		if (detail && !detail.confirming) {
			if (key === 'back' || key === 'left') {
				if (detail.level === 'dl-scope') { setDetail(function (d) { return d ? Object.assign({}, d, {level: null, btnIdx: 0}) : null; }); }
				else if (detail.level === 'dl-seasons') { setDetail(function (d) { return d ? Object.assign({}, d, {level: 'dl-scope', btnIdx: d.dlMode === 'episode' ? 0 : 1}) : null; }); }
				else if (detail.level === 'dl-episodes') { setDetail(function (d) { return d ? Object.assign({}, d, {level: 'dl-seasons', btnIdx: 0, dlEpisodes: undefined}) : null; }); }
				else if (detail.level === 'dl-confirm') { setDetail(function (d) { return d ? Object.assign({}, d, {level: 'dl-scope', btnIdx: 4}) : null; }); }
				else { setDetail(null); }
				return true;
			}
			var mx: number;
			if (detail.level === 'dl-scope') mx = 4;
			else if (detail.level === 'dl-seasons') mx = (detail.dlSeasons ? detail.dlSeasons.length : 0);
			else if (detail.level === 'dl-episodes') mx = (detail.dlEpisodes ? detail.dlEpisodes.length : 0);
			else if (detail.level === 'dl-confirm') mx = 1;
			else mx = detailBtns.length - 1;
			if (key === 'up') setDetail(function (d) { return d ? Object.assign({}, d, {btnIdx: Math.max(0, d.btnIdx - 1)}) : null; });
			else if (key === 'down') setDetail(function (d) { return d ? Object.assign({}, d, {btnIdx: Math.min(mx, d.btnIdx + 1)}) : null; });
			return true;
		}

		if (key === 'back') {
			if (zone !== 'rows') setZone('rows');
			else onExitLeft();
			return true;
		}

		if (zone === 'rows') {
			var c = cols[rowIdx] || 0;
			var r = contentRows[rowIdx];
			if (key === 'left') {
				if (c > 0) setCols(function (p) { var n: Record<number, number> = {}; for (var k in p) n[k] = p[k]; n[rowIdx] = c - 1; return n; });
				else onExitLeft();
			}
			else if (key === 'right' && r) setCols(function (p) { var n: Record<number, number> = {}; for (var k in p) n[k] = p[k]; n[rowIdx] = clamp(c + 1, 0, r.items.length - 1); return n; });
			else if (key === 'up') {
				if (rowIdx > 0) setRowIdx(rowIdx - 1);
			}
			else if (key === 'down') {
				if (rowIdx < contentRows.length - 1) setRowIdx(rowIdx + 1);
				else if (onExitDown) onExitDown();
			}
			return true;
		}

		return true;
	}, [zone, rowIdx, cols, contentRows, detail, detailBtns, onExitLeft, onExitDown]);

	useKeys(handleKey, active && !(detail && detail.confirming));

	useOkPress({
		onPress: function () {
			if (detail) {
				if (detail.confirming) return;
				if (detail.level === 'dl-scope') {
					if (detail.btnIdx === 0) {
						setDetail(function (d) { return d ? Object.assign({}, d, {level: 'dl-seasons', btnIdx: 0, dlMode: 'episode'}) : null; });
					} else if (detail.btnIdx === 1) {
						setDetail(function (d) { return d ? Object.assign({}, d, {level: 'dl-seasons', btnIdx: 0, dlMode: 'season'}) : null; });
					} else if (detail.btnIdx === 2) {
						selectWlDlScope('lastSeason', detail.dlCounts ? detail.dlCounts.lastSeason : 0);
					} else if (detail.btnIdx === 3) {
						selectWlDlScope('all', detail.dlCounts ? detail.dlCounts.all : 0);
					} else {
						setDetail(function (d) { return d ? Object.assign({}, d, {level: null, btnIdx: 0}) : null; });
					}
					return;
				}
				if (detail.level === 'dl-seasons') {
					var dlSnArr = detail.dlSeasons || [];
					if (detail.btnIdx === dlSnArr.length) {
						setDetail(function (d) { return d ? Object.assign({}, d, {level: 'dl-scope', btnIdx: d.dlMode === 'episode' ? 0 : 1}) : null; });
					} else {
						var picked = dlSnArr[detail.btnIdx];
						if (!picked) return;
						if (detail.dlMode === 'season') {
							selectWlDlScope({season: picked.number}, picked.count);
						} else {
							setDetail(function (d) { return d ? Object.assign({}, d, {loading: true, dlSeasonNumber: picked.number, dlEpisodes: undefined}) : null; });
							var tvdbId = detail.item.sonarrSeries!.tvdbId;
							downloadSeriesListEpisodes(sConn, {tvdbId: tvdbId}, picked.number)
								.then(function (eps) {
									setDetail(function (d) { return d ? Object.assign({}, d, {level: 'dl-episodes', btnIdx: 0, loading: false, dlEpisodes: eps}) : null; });
								})
								.catch(function (e) {
									onToast(e && e.message || 'Failed to load episodes', 'error');
									setDetail(function (d) { return d ? Object.assign({}, d, {level: 'dl-seasons', btnIdx: 0, loading: false}) : null; });
								});
						}
					}
					return;
				}
				if (detail.level === 'dl-episodes') {
					var dlEpArr = detail.dlEpisodes || [];
					if (detail.btnIdx === dlEpArr.length) {
						setDetail(function (d) { return d ? Object.assign({}, d, {level: 'dl-seasons', btnIdx: 0, dlEpisodes: undefined}) : null; });
					} else {
						var ep = dlEpArr[detail.btnIdx];
						if (ep) selectWlDlScope({episode: ep.id}, 1);
					}
					return;
				}
				if (detail.level === 'dl-confirm') {
					if (detail.btnIdx === 0) {
						setDetail(function (d) { return d ? Object.assign({}, d, {level: 'dl-scope', btnIdx: 4}) : null; });
					} else if (detail.dlPendingScope) {
						executeWlDlScope(detail.dlPendingScope);
					}
					return;
				}
				var btn = detailBtns[detail.btnIdx];
				if (!btn) return;
				if (btn.action === 'download') {
					startWlDownload();
				} else if (btn.action === 'search') {
					if (detail.item.sonarrSeries) {
						sonarrGetEpisodes(sConn, detail.item.sonarrSeries.id).then(function (eps) {
							var monitored = 0;
							for (var i = 0; i < eps.length; i++) { if (eps[i].monitored && !eps[i].hasFile) monitored++; }
							setDetail(function (d) { return d ? Object.assign({}, d, {confirming: 'search', btnIdx: 0, searchEpCount: monitored}) : null; });
						}).catch(function () {
							setDetail(function (d) { return d ? Object.assign({}, d, {confirming: 'search', btnIdx: 0}) : null; });
						});
					} else {
						setDetail(function (d) { return d ? Object.assign({}, d, {confirming: 'search', btnIdx: 0}) : null; });
					}
				} else if (btn.action === 'unmonitor') {
					setDetail(function (d) { return d ? Object.assign({}, d, {confirming: 'unmonitor', btnIdx: 0}) : null; });
				} else if (btn.action === 'delete') {
					setDetail(function (d) { return d ? Object.assign({}, d, {confirming: 'delete', btnIdx: 0}) : null; });
				}
				return;
			}
			if (zone === 'rows') {
				var r = contentRows[rowIdx];
				if (!r) return;
				var item = r.items[col];
				if (!item) return;
				if (item.mediaType === 'tv' && onOpenShowDetail) {
					onOpenShowDetail(item.title, item.year, item.sonarrSeries ? item.sonarrSeries.tvdbId : undefined);
					return;
				}
				setDetail({item: item, btnIdx: 0, confirming: null});
			}
		},
		onLongPress: function () {}
	}, active && !(detail && detail.confirming));

	var rowsRef = useRef<HTMLDivElement>(null);
	var rowsInnerRef = useRef<HTMLDivElement>(null);
	var [rowsH, setRowsH] = useState(648);
	useEffect(function () {
		if (rowsRef.current) {
			var h = rowsRef.current.clientHeight;
			if (h > 0) setRowsH(h);
		}
	});
	var innerH = rowsInnerRef.current ? rowsInnerRef.current.scrollHeight : contentRows.length * ROW_SCROLL;
	var maxScrollY = Math.max(0, innerH - rowsH);
	var rowScrollY = rowIdx > 0 ? Math.min(rowIdx * ROW_SCROLL, maxScrollY) : 0;

	if (loading) {
		return <div class="cinema__empty">Loading watchlist…</div>;
	}
	if (error) {
		return <div class="cinema__empty">{'Error: ' + error}</div>;
	}
	if (contentRows.length === 0) {
		return <div class="cinema__empty">No monitored titles. Use "Add to Watchlist" from Browse or My Server.</div>;
	}

	return (
		<div class="watchlist">
			{updating && <div class="watchlist__updating">Updating…</div>}
			{/* hero */}
			<div class="cinema__hero">
				<div class="cinema__hero-bd" style={'background-image:' + (bdUrl0 ? 'url(' + bdUrl0 + ')' : 'none') + ';opacity:' + (bdSlot === 0 ? 1 : 0)} />
				<div class="cinema__hero-bd" style={'background-image:' + (bdUrl1 ? 'url(' + bdUrl1 + ')' : 'none') + ';opacity:' + (bdSlot === 1 ? 1 : 0)} />
				<div class="cinema__hero-scrim" />
				{heroItem && (
					<div class="cinema__hero-info">
						<h1 class="cinema__hero-title">{heroItem.title}</h1>
						<div class="cinema__hero-meta">
							{heroItem.year > 0 && <span class="cinema__badge">{heroItem.year}</span>}
							<span class="cinema__badge">{heroItem.mediaType === 'tv' ? 'TV Series' : 'Movie'}</span>
							<span class={'cinema__badge cinema__badge--' + heroItem.section}>{heroItem.section === 'downloading' && heroItem.downloadProgress != null ? 'Downloading ' + heroItem.downloadProgress + '%' : heroItem.section.charAt(0).toUpperCase() + heroItem.section.slice(1)}</span>
						</div>
						{heroItem.overview && <p class="cinema__hero-desc">{heroItem.overview}</p>}
					</div>
				)}
			</div>

			{/* rows */}
			<div class="cinema__rows" ref={rowsRef}>
				<div class="cinema__rows-inner" ref={rowsInnerRef} style={'transform:translate3d(0,' + (-rowScrollY) + 'px,0)'}>
					{contentRows.map(function (r, ri) {
						var c = cols[ri] || 0;
						var total = r.items.length * CARD_STEP;
						var fits = total <= VIEW_W;
						var off = fits ? 0 : clamp(c * CARD_STEP + CARD_W / 2 - VIEW_W / 2, 0, Math.max(0, total - VIEW_W));
						return (
							<div key={ri} class={'cinema__row' + (zone === 'rows' && ri === rowIdx ? ' cinema__row--active' : '')}>
								<h2 class="cinema__row-title">{r.title}</h2>
								<div class="cinema__row-viewport">
									<div class="cinema__row-track" style={'transform:translate3d(' + (-off) + 'px,0,0)'}>
										{r.items.map(function (item, ci) {
											var focused = zone === 'rows' && ri === rowIdx && ci === (cols[ri] || 0) && !detail;
											return (
												<div key={item.id} class={'cinema__card' + (focused ? ' cinema__card--focused' : '')}>
													{item.poster
														? <img class="cinema__poster" src={item.poster} alt="" />
														: <div class="cinema__poster cinema__poster--empty" />}
													<div class="cinema__card-title">{item.title}</div>
													<div class="cinema__card-year">
														{item.section === 'downloading' && item.downloadProgress != null
															? item.downloadProgress + '%' + (item.eta ? ' · ' + item.eta : '')
															: item.year > 0 ? String(item.year) : ''}
													</div>
												</div>
											);
										})}
									</div>
								</div>
							</div>
						);
					})}
				</div>
			</div>

			{/* scrim behind detail panel */}
			<div class={'cinema__scrim' + (detail ? ' cinema__scrim--active' : '')} />

			{/* detail panel */}
			<div class={'cinema__panel' + (detail ? ' cinema__panel--open' : '')}>
				{detail && !detail.confirming && !detail.level && (
					<div class="cinema__panel-content">
						<h2 class="cinema__panel-title">{detail.item.title}</h2>
						<p class="cinema__panel-sub">
							{detail.item.year > 0 ? detail.item.year : ''}
							{' · '}
							{detail.item.mediaType === 'tv' ? 'TV Series' : 'Movie'}
							{detail.item.hasFile && detail.item.sizeOnDisk > 0 ? ' · ' + fmtSize(detail.item.sizeOnDisk) : ''}
						</p>
						{detail.item.section === 'downloading' && detail.item.downloadProgress != null && (
							<div class="watchlist__progress">
								<div class="watchlist__progress-bar" style={'width:' + detail.item.downloadProgress + '%'} />
								<span class="watchlist__progress-text">{detail.item.downloadProgress + '%'}{detail.item.eta ? ' · ' + detail.item.eta + ' left' : ''}</span>
							</div>
						)}
						{detail.loading && <div class="cinema__panel-loading">Loading…</div>}
						{detailBtns.map(function (btn, i) {
							return (
								<button key={i} class={'cinema__panel-btn' + (i === detail!.btnIdx ? ' cinema__panel-btn--focused' : '') + (btn.action === 'delete' ? ' cinema__panel-btn--danger' : '')}>
									{btn.label}
								</button>
							);
						})}
					</div>
				)}
				{detail && detail.level === 'dl-scope' && (
					<div class="cinema__panel-content">
						<h2 class="cinema__panel-title">Download {detail.item.title}</h2>
						<p class="cinema__panel-sub">Choose download scope</p>
						<button class={'cinema__panel-btn' + (detail.btnIdx === 0 ? ' cinema__panel-btn--focused' : '')}>
							{'Episode…'}
						</button>
						<button class={'cinema__panel-btn' + (detail.btnIdx === 1 ? ' cinema__panel-btn--focused' : '')}>
							{'Season…'}
						</button>
						<button class={'cinema__panel-btn' + (detail.btnIdx === 2 ? ' cinema__panel-btn--focused' : '')}>
							{'Latest Season' + (detail.dlCounts ? ' (' + detail.dlCounts.lastSeason + ' episode' + (detail.dlCounts.lastSeason !== 1 ? 's' : '') + ')' : '')}
						</button>
						<button class={'cinema__panel-btn' + (detail.btnIdx === 3 ? ' cinema__panel-btn--focused' : '')}>
							{'All Episodes' + (detail.dlCounts ? ' (' + detail.dlCounts.all + ' episode' + (detail.dlCounts.all !== 1 ? 's' : '') + ')' : '')}
						</button>
						<button class={'cinema__panel-btn' + (detail.btnIdx === 4 ? ' cinema__panel-btn--focused' : '')}>
							Cancel
						</button>
					</div>
				)}
				{detail && detail.level === 'dl-seasons' && (
					<div class="cinema__panel-content">
						<h2 class="cinema__panel-title">{detail.dlMode === 'episode' ? 'Pick a season' : 'Download season'}</h2>
						{(detail.dlSeasons || []).map(function (s, i) {
							return (
								<button key={s.number} class={'cinema__panel-btn' + (detail!.btnIdx === i ? ' cinema__panel-btn--focused' : '')}>
									{'Season ' + s.number + ' (' + s.count + ' episode' + (s.count !== 1 ? 's' : '') + ')'}
								</button>
							);
						})}
						<button class={'cinema__panel-btn' + (detail.btnIdx === (detail.dlSeasons || []).length ? ' cinema__panel-btn--focused' : '')}>
							Cancel
						</button>
						{detail.loading && <div class="cinema__panel-loading">Loading…</div>}
					</div>
				)}
				{detail && detail.level === 'dl-episodes' && (
					<div class="cinema__panel-content">
						<h2 class="cinema__panel-title">{'Season ' + (detail.dlSeasonNumber || '?')}</h2>
						{(detail.dlEpisodes || []).map(function (ep, i) {
							var sn = ep.seasonNumber;
							var en = ep.episodeNumber;
							var sStr = (sn < 10 ? '0' : '') + sn;
							var eStr = (en < 10 ? '0' : '') + en;
							return (
								<button key={ep.id} class={'cinema__panel-btn' + (detail!.btnIdx === i ? ' cinema__panel-btn--focused' : '')}>
									{'S' + sStr + 'E' + eStr + ' — ' + (ep.title || 'Episode ' + en)}
								</button>
							);
						})}
						<button class={'cinema__panel-btn' + (detail.btnIdx === (detail.dlEpisodes || []).length ? ' cinema__panel-btn--focused' : '')}>
							Cancel
						</button>
					</div>
				)}
				{detail && detail.level === 'dl-confirm' && (
					<div class="cinema__panel-content watchlist__confirm">
						<h2 class="cinema__panel-title">Download {detail.item.title}</h2>
						<div class="watchlist__confirm-warn">
							<p>{'This will search for ' + (detail.dlPendingCount || 0) + ' episode' + ((detail.dlPendingCount || 0) !== 1 ? 's' : '') + '. Continue?'}</p>
						</div>
						<div class="watchlist__confirm-btns">
							<button class={'cinema__panel-btn' + (detail.btnIdx === 0 ? ' cinema__panel-btn--focused' : '')}>Cancel</button>
							<button class={'cinema__panel-btn' + (detail.btnIdx === 1 ? ' cinema__panel-btn--focused' : '')}>Continue</button>
						</div>
					</div>
				)}
				{detail && detail.confirming && (
					<div class="cinema__panel-content watchlist__confirm">
						<h2 class="cinema__panel-title">
							{detail.confirming === 'delete' ? 'Remove from Library?' : detail.confirming === 'unmonitor' ? 'Stop Monitoring?' : 'Search Again?'}
						</h2>
						{detail.confirming === 'delete' && (
							<div class="watchlist__confirm-warn">
								<p>This will delete the files for <strong>{detail.item.title}</strong>{detail.item.sizeOnDisk > 0 ? ' (' + fmtSize(detail.item.sizeOnDisk) + ')' : ''}.</p>
								<p>This may be the only copy if the torrent is no longer in Deluge. The torrent itself is not touched.</p>
							</div>
						)}
						{detail.confirming === 'search' && (
							<div class="watchlist__confirm-warn">
								<p>Search for <strong>{detail.item.title}</strong>?</p>
								{detail.searchEpCount != null && detail.searchEpCount > 0 && (
									<p>{detail.searchEpCount + ' monitored episode' + (detail.searchEpCount !== 1 ? 's' : '') + ' missing files.'}</p>
								)}
								<p>This will look for releases and grab the best match automatically.</p>
							</div>
						)}
						{detail.confirming === 'unmonitor' && (
							<div class="watchlist__confirm-warn">
								<p><strong>{detail.item.title}</strong> will stop being monitored. No files will be deleted.</p>
							</div>
						)}
						<div class="watchlist__confirm-btns">
							<button class={'cinema__panel-btn' + (detail.btnIdx === 0 ? ' cinema__panel-btn--focused' : '')}>Cancel</button>
							<button class={'cinema__panel-btn' + (detail.btnIdx === 1 ? ' cinema__panel-btn--focused' : '') + (detail.confirming === 'delete' ? ' cinema__panel-btn--danger' : '')}>
								{detail.confirming === 'delete' ? 'Delete' : detail.confirming === 'search' ? 'Search' : 'Stop Monitoring'}
							</button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
