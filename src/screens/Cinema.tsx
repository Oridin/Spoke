import {useCallback, useEffect, useMemo, useRef, useState} from 'preact/hooks';
import {useKeys, clamp, type NavKey} from '../hooks/useKeys';
import {useOkPress} from '../hooks/useOkPress';
import {backdropUrl, posterUrlXL, yearOf, findProviderApp, providerDef, type TrendingShow, type TrendingData} from '../lib/trending';
import {searchSeedbox, grabFromSeedbox, type SearchResult, type SearchSeason, type GrabItem} from '../lib/seedbox';
import {Browse} from './Browse';
import {MyServer} from './MyServer';
import {Watchlist} from './Watchlist';
import {Downloads} from './Downloads';
import {useKeyTrap} from '../hooks/useKeyTrap';
import {launchApp} from '../lib/launch';
import {getPlexIndex, refreshPlexIndex, onPlexIndexChange, type PlexIndex} from '../lib/plex';
import {getHiddenSections} from '../lib/pin';
import {startMonitor, stopMonitor, getUnreadCount, clearUnread, onUnreadChange} from '../lib/dlmonitor';
import {
	sonarrConn, radarrConn,
	watchlistAddSeriesByTmdb, watchlistAddMovie,
	watchlistCheckSeries, watchlistCheckMovie,
	watchlistStopSeries, watchlistStopMovie,
	countEpisodesByScope,
	sonarrGetSeries, radarrGetMovies,
	downloadMovie, downloadSeriesPrep, downloadSeries, downloadSeriesListEpisodes,
	sonarrQueue, radarrQueue,
	type MonitorScope, type WatchlistAddResult,
	type SonarrSeries, type RadarrMovie,
	type DlSeasonInfo, type SonarrEpisode, type DownloadScope,
} from '../lib/arrapi';

interface Props {
	trending: TrendingData;
	installedAppIds: string[];
	onLaunch: (appId: string) => void;
	onToast: (msg: string, kind?: 'info' | 'error') => void;
	active: boolean;
	onExitDown: () => void;
	rowAreaPx?: number;
	apiKey: string;
	allowShell: boolean;
	providerIds: number[];
	plexUrl: string;
	plexToken: string;
	showHidden: boolean;
	onRelockHidden: () => void;
	sonarrUrl: string;
	sonarrKey: string;
	radarrUrl: string;
	radarrKey: string;
	enableDeleteActions: boolean;
	onPlayPlex?: (ratingKey: string, title: string) => void;
}

type TabId = 'home' | 'browse' | 'server' | 'watchlist' | 'downloads';

var BASE_TABS: {id: TabId; label: string}[] = [
	{id: 'home', label: 'Home'},
	{id: 'browse', label: 'Browse'},
	{id: 'server', label: 'My Server'},
	{id: 'watchlist', label: 'Watchlist'},
	{id: 'downloads', label: 'Downloads'},
];

type Zone = 'sidebar' | 'rows';

interface ContentRow {
	title: string;
	items: TrendingShow[];
}

type PanelLevel = 'actions' | 'loading' | 'seasons' | 'episodes' | 'monitor' | 'wl-confirm' | 'wl-stop' | 'dl-scope' | 'dl-seasons' | 'dl-episodes' | 'dl-confirm';

interface PanelState {
	item: TrendingShow;
	level: PanelLevel;
	btnIdx: number;
	search: SearchResult | null;
	seasonIdx: number;
	grabbing: boolean;
	wlScope?: MonitorScope;
	wlCounts?: {future: number; lastSeason: number; all: number; total: number} | null;
	wlExistingSeries?: SonarrSeries | null;
	wlExistingMovie?: RadarrMovie | null;
	dlCounts?: {lastSeason: number; all: number} | null;
	dlSeasons?: DlSeasonInfo[];
	dlEpisodes?: SonarrEpisode[];
	dlMode?: 'episode' | 'season';
	dlSeasonNumber?: number;
	dlPendingScope?: DownloadScope;
	dlPendingCount?: number;
}

var MONITOR_OPTS: {key: MonitorScope; label: string}[] = [
	{key: 'future', label: 'Future Episodes'},
	{key: 'lastSeason', label: 'Latest Season'},
	{key: 'all', label: 'All Episodes'},
	{key: 'none', label: 'None (Manual)'},
];

const CARD_W = 200;
const CARD_GAP = 20;
const CARD_STEP = CARD_W + CARD_GAP;
const VIEW_W = 1700;
const ROW_SCROLL = 460;
const HERO_DEBOUNCE = 250;

function fmtSize (bytes: number | undefined): string {
	if (!bytes) return '';
	if (bytes >= 1073741824) return ' (' + (bytes / 1073741824).toFixed(1) + ' GB)';
	if (bytes >= 1048576) return ' (' + Math.round(bytes / 1048576) + ' MB)';
	return ' (' + Math.round(bytes / 1024) + ' KB)';
}

export function CinemaPanel ({trending, installedAppIds, onLaunch, onToast, active, onExitDown, rowAreaPx, apiKey, allowShell, providerIds, plexUrl, plexToken, showHidden, onRelockHidden, sonarrUrl, sonarrKey, radarrUrl, radarrKey, enableDeleteActions, onPlayPlex}: Props) {
	var TABS = BASE_TABS;
	const [tabIdx, setTabIdx] = useState(0);
	const [zone, setZone] = useState<Zone>('rows');
	const [rowIdx, setRowIdx] = useState(0);
	const [cols, setCols] = useState<Record<number, number>>({});

	// Hero: display-only, reflects focused card with debounced crossfade
	const [heroItem, setHeroItem] = useState<TrendingShow | null>(null);
	const [bdSlot, setBdSlot] = useState(0);
	const bdSlotRef = useRef(0);
	const [bdUrl0, setBdUrl0] = useState<string | null>(null);
	const [bdUrl1, setBdUrl1] = useState<string | null>(null);
	const debounceRef = useRef(0);
	const heroInitRef = useRef(false);
	const focusedItemRef = useRef<TrendingShow | null>(null);

	// Action / download panel
	const [panel, setPanel] = useState<PanelState | null>(null);

	// Plex library index: lightweight TMDB-id lookup for "Play on Plex"
	var PLEX_APP = 'cdp-30';
	var hiddenSections = useMemo(function () { return showHidden ? [] as string[] : getHiddenSections(); }, [showHidden]);
	var [plexIdx, setPlexIdx] = useState<PlexIndex | null>(function () { return getPlexIndex(plexUrl, plexToken, hiddenSections); });
	useEffect(function () {
		setPlexIdx(getPlexIndex(plexUrl, plexToken, hiddenSections));
		return onPlexIndexChange(function () { setPlexIdx(getPlexIndex(plexUrl, plexToken, hiddenSections)); });
	}, [plexUrl, plexToken, hiddenSections]);
	useEffect(function () {
		if (active && plexUrl && plexToken) refreshPlexIndex(plexUrl, plexToken, hiddenSections);
	}, [active, plexUrl, plexToken, hiddenSections]);

	var [dlUnread, setDlUnread] = useState(getUnreadCount);
	useEffect(function () {
		startMonitor(sonarrUrl, sonarrKey, radarrUrl, radarrKey, onToast);
		return stopMonitor;
	}, [sonarrUrl, sonarrKey, radarrUrl, radarrKey]);
	useEffect(function () {
		return onUnreadChange(function () { setDlUnread(getUnreadCount()); });
	}, []);

	const tab = TABS[tabIdx];
	const col = cols[rowIdx] || 0;

	const rows: ContentRow[] = useMemo(() => {
		if (tab.id === 'browse') return [];
		const s = trending.shows;
		const m = trending.movies;
		return [
			...(s.length > 0 ? [{title: 'Trending TV Shows', items: s}] : []),
			...(m.length > 0 ? [{title: 'Trending Movies', items: m}] : []),
		];
	}, [tab.id, trending]);

	// The item the hero should reflect
	const focusedItem: TrendingShow | null = useMemo(() => {
		if (rows.length === 0) return null;
		if (zone === 'rows') {
			const r = rows[rowIdx];
			if (r) return r.items[col] || r.items[0] || null;
		}
		return rows[0] ? rows[0].items[0] || null : null;
	}, [zone, rows, rowIdx, col]);

	focusedItemRef.current = focusedItem;
	const focusedId = focusedItem ? focusedItem.id : -1;

	// Debounced hero update with backdrop crossfade
	useEffect(() => {
		if (!focusedItem) return;
		if (!heroInitRef.current) {
			heroInitRef.current = true;
			setHeroItem(focusedItem);
			var url = backdropUrl(focusedItem.backdrop);
			setBdUrl0(url);
			setBdSlot(0);
			bdSlotRef.current = 0;
			return;
		}
		window.clearTimeout(debounceRef.current);
		debounceRef.current = window.setTimeout(function () {
			var item = focusedItemRef.current;
			if (!item) return;
			setHeroItem(item);
			var url = backdropUrl(item.backdrop);
			var next = bdSlotRef.current === 0 ? 1 : 0;
			if (next === 0) setBdUrl0(url);
			else setBdUrl1(url);
			setBdSlot(next);
			bdSlotRef.current = next;
		}, HERO_DEBOUNCE);
		return () => window.clearTimeout(debounceRef.current);
	}, [focusedId]);

	// Preload adjacent backdrops
	useEffect(() => {
		if (zone !== 'rows') return;
		var r = rows[rowIdx];
		if (!r) return;
		for (var d = -1; d <= 2; d++) {
			var item = r.items[col + d];
			if (item && item.backdrop) {
				var img = new Image();
				img.src = backdropUrl(item.backdrop) || '';
			}
		}
	}, [zone, rowIdx, col]);

	// Provider buttons for the action panel
	var isOnPlex = !!(panel && plexIdx && plexIdx.has(panel.item.mediaType, panel.item.id));
	const panelBtns: {label: string; action: string}[] = useMemo(() => {
		if (!panel) return [];
		var btns: {label: string; action: string}[] = [];
		if (isOnPlex) btns.push({label: onPlayPlex ? 'Play' : 'Play on Plex', action: 'launch-plex'});
		for (var i = 0; i < panel.item.providers.length; i++) {
			var sp = panel.item.providers[i];
			var def = providerDef(sp.id);
			if (!def) continue;
			var appId = findProviderApp(def, installedAppIds);
			if (appId) btns.push({label: def.short, action: 'launch:' + appId});
		}
		if (isOnWatchlist) btns.push({label: 'On your Watchlist ✓', action: 'on-watchlist'});
		else btns.push({label: 'Add to Watchlist', action: 'watchlist'});
		if (isOnPlex && panel.item.mediaType === 'movie') btns.push({label: 'On your server', action: 'on-server'});
		else btns.push({label: 'Download', action: 'download'});
		if (isOnPlex && panel.item.mediaType === 'tv') btns.push({label: 'On your server', action: 'on-server'});
		return btns;
	}, [panel ? panel.item.id : 0, installedAppIds, isOnPlex]);

	const seasonList: SearchSeason[] = useMemo(() => {
		if (!panel || !panel.search) return [];
		return panel.search.shows.length > 0 ? panel.search.shows[0].seasons : [];
	}, [panel ? panel.search : null]);

	const prevTabRef = useRef(tab.id);
	useEffect(() => {
		if (prevTabRef.current === 'server' && tab.id !== 'server' && showHidden) onRelockHidden();
		prevTabRef.current = tab.id;
	}, [tab.id, showHidden, onRelockHidden]);

	const switchTab = useCallback((i: number) => {
		setTabIdx(i);
		setRowIdx(0);
		setCols({});
		setZone('sidebar');
		setPanel(null);
		if (TABS[i] && TABS[i].id === 'downloads') clearUnread();
	}, []);

	const openBrowsePanel = useCallback((item: TrendingShow) => {
		setPanel({item, level: 'actions', btnIdx: 0, search: null, seasonIdx: 0, grabbing: false});
	}, []);

	// --- download flow ---

	const doGrab = useCallback((items: GrabItem[], label: string) => {
		if (items.length === 0) { onToast('No files found', 'error'); return; }
		onToast('Sending ' + label + '…');
		setPanel(function (p) { return p ? {...p, grabbing: true} : null; });
		grabFromSeedbox(items)
			.then(function (r) {
				if (r.errors.length > 0) onToast(r.errors.join(', '), 'error');
				else if (r.grabbed.length > 0) onToast('Sent: ' + r.grabbed.join(', '));
				setPanel(null);
			})
			.catch(function () {
				onToast("Couldn't reach seedbox", 'error');
				setPanel(function (p) { return p ? {...p, grabbing: false} : null; });
			});
	}, [onToast]);

	const startDownload = useCallback(() => {
		if (!panel) return;
		var item = panel.item;
		setPanel({...panel, level: 'loading', btnIdx: 0, grabbing: false});
		onToast('Looking for ' + item.name + '…');
		searchSeedbox(item.name, yearOf(item.firstAir))
			.then(function (result) {
				if (item.mediaType === 'movie') {
					var movies = result.movies;
					if (movies.length === 0 || movies[0].options.length === 0) {
						onToast('Nothing found for ' + item.name, 'error');
						setPanel(function (p) { return p ? {...p, level: 'actions', grabbing: false} : null; });
						return;
					}
					var opt = movies[0].options[0];
					onToast('Sending ' + movies[0].title + '…');
					setPanel(function (p) { return p ? {...p, grabbing: true} : null; });
					grabFromSeedbox([{fid: opt.fid, filename: opt.filename, name: movies[0].title}])
						.then(function (r) {
							if (r.errors.length > 0) onToast(r.errors.join(', '), 'error');
							else if (r.grabbed.length > 0) onToast('Sent: ' + r.grabbed.join(', '));
							else onToast('Nothing grabbed', 'error');
							setPanel(null);
						})
						.catch(function () {
							onToast("Couldn't reach seedbox", 'error');
							setPanel(function (p) { return p ? {...p, level: 'actions', grabbing: false} : null; });
						});
				} else {
					if (result.shows.length === 0) {
						onToast('Nothing found for ' + item.name, 'error');
						setPanel(function (p) { return p ? {...p, level: 'actions'} : null; });
						return;
					}
					setPanel(function (p) { return p ? {...p, level: 'seasons', search: result, btnIdx: 0} : null; });
				}
			})
			.catch(function () {
				onToast("Couldn't reach seedbox", 'error');
				setPanel(function (p) { return p ? {...p, level: 'actions', grabbing: false} : null; });
			});
	}, [panel, onToast, doGrab]);

	// --- watchlist ---

	var sConn = useMemo(function () { return sonarrConn({sonarrUrl: sonarrUrl, sonarrKey: sonarrKey}); }, [sonarrUrl, sonarrKey]);
	var rConn = useMemo(function () { return radarrConn({radarrUrl: radarrUrl, radarrKey: radarrKey}); }, [radarrUrl, radarrKey]);

	var hasArr = !!(sonarrUrl && sonarrKey && radarrUrl && radarrKey);
	var dlBusyRef = useRef(false);
	var dlPollRef = useRef(0);

	var [wlMovieIds, setWlMovieIds] = useState<number[]>([]);
	var [wlSeriesTitles, setWlSeriesTitles] = useState<string[]>([]);

	var refreshWlStatus = useCallback(function () {
		if (!sonarrUrl || !radarrUrl) return;
		Promise.all([
			sonarrGetSeries(sConn).catch(function () { return [] as SonarrSeries[]; }),
			radarrGetMovies(rConn).catch(function () { return [] as RadarrMovie[]; }),
		]).then(function (results) {
			var ids: number[] = [];
			var titles: string[] = [];
			for (var i = 0; i < results[1].length; i++) { if (results[1][i].monitored) ids.push(results[1][i].tmdbId); }
			for (var j = 0; j < results[0].length; j++) { if (results[0][j].monitored) titles.push(results[0][j].title.toLowerCase()); }
			setWlMovieIds(ids);
			setWlSeriesTitles(titles);
		});
	}, [sConn, rConn, sonarrUrl, radarrUrl]);

	useEffect(function () { refreshWlStatus(); }, [refreshWlStatus]);

	var isOnWatchlist = useMemo(function () {
		if (!panel) return false;
		if (panel.item.mediaType === 'movie') return wlMovieIds.indexOf(panel.item.id) >= 0;
		return wlSeriesTitles.indexOf(panel.item.name.toLowerCase()) >= 0;
	}, [panel ? panel.item.id : 0, wlMovieIds, wlSeriesTitles]);

	const startWatchlist = useCallback(() => {
		if (!panel) return;
		var item = panel.item;
		if (item.mediaType === 'tv') {
			setPanel({...panel, level: 'loading', btnIdx: 0, grabbing: true});
			watchlistCheckSeries(sConn, item.id).then(function (check) {
				var counts = check.episodes.length > 0 ? countEpisodesByScope(check.episodes) : null;
				setPanel(function (p) {
					return p ? {...p, level: 'monitor', btnIdx: 0, grabbing: false, wlCounts: counts, wlExistingSeries: check.existing} : null;
				});
			}).catch(function () {
				setPanel(function (p) { return p ? {...p, level: 'monitor', btnIdx: 0, grabbing: false, wlCounts: null, wlExistingSeries: null} : null; });
			});
		} else {
			setPanel({...panel, level: 'loading', btnIdx: 0, grabbing: true});
			watchlistCheckMovie(rConn, item.id).then(function (existing) {
				setPanel(function (p) { return p ? {...p, level: 'wl-confirm', btnIdx: 0, grabbing: false, wlExistingMovie: existing} : null; });
			}).catch(function () {
				setPanel(function (p) { return p ? {...p, level: 'wl-confirm', btnIdx: 0, grabbing: false, wlExistingMovie: null} : null; });
			});
		}
	}, [panel, sConn, rConn]);

	const selectMonitorScope = useCallback((scope: MonitorScope) => {
		if (!panel) return;
		setPanel({...panel, level: 'wl-confirm', btnIdx: 0, wlScope: scope});
	}, [panel]);

	const doWatchlistConfirm = useCallback(() => {
		if (!panel) return;
		var item = panel.item;
		setPanel({...panel, level: 'loading', btnIdx: 0, grabbing: true});
		if (item.mediaType === 'tv' && panel.wlScope) {
			onToast('Adding ' + item.name + '…');
			watchlistAddSeriesByTmdb(sConn, item.id, panel.wlScope)
				.then(function (result: WatchlistAddResult) {
					var msg = result.monitoredCount >= 0
						? 'Monitoring ' + result.monitoredCount + ' episode' + (result.monitoredCount !== 1 ? 's' : '') + ' of ' + result.title
						: result.title + ' added to watchlist';
					onToast(msg);
					setPanel(null);
					refreshWlStatus();
				})
				.catch(function (e) {
					onToast(e && e.message || 'Failed to add', 'error');
					setPanel(function (p) { return p ? {...p, level: 'actions', grabbing: false} : null; });
				});
		} else {
			onToast('Adding ' + item.name + '…');
			watchlistCheckMovie(rConn, item.id).then(function (existing) {
				return watchlistAddMovie(rConn, item.id, existing);
			}).then(function (result: WatchlistAddResult) {
				onToast(result.title + ' added to watchlist');
				setPanel(null);
				refreshWlStatus();
			}).catch(function (e) {
				onToast(e && e.message || 'Failed to add', 'error');
				setPanel(function (p) { return p ? {...p, level: 'actions', grabbing: false} : null; });
			});
		}
	}, [panel, sConn, rConn, onToast, refreshWlStatus]);

	const startStopWatchlist = useCallback(() => {
		if (!panel) return;
		var item = panel.item;
		setPanel({...panel, level: 'loading', btnIdx: 0, grabbing: true});
		if (item.mediaType === 'tv') {
			watchlistCheckSeries(sConn, item.id).then(function (check) {
				if (check.existing) {
					setPanel(function (p) { return p ? {...p, level: 'wl-stop', btnIdx: 0, grabbing: false, wlExistingSeries: check.existing} : null; });
				} else {
					onToast('Not on watchlist');
					setPanel(function (p) { return p ? {...p, level: 'actions', grabbing: false} : null; });
				}
			});
		} else {
			watchlistCheckMovie(rConn, item.id).then(function (existing) {
				if (existing && existing.monitored) {
					setPanel(function (p) { return p ? {...p, level: 'wl-stop', btnIdx: 0, grabbing: false, wlExistingMovie: existing} : null; });
				} else {
					onToast('Not on watchlist');
					setPanel(function (p) { return p ? {...p, level: 'actions', grabbing: false} : null; });
				}
			});
		}
	}, [panel, sConn, rConn, onToast]);

	const doStopMonitoring = useCallback(() => {
		if (!panel) return;
		var item = panel.item;
		setPanel({...panel, level: 'loading', btnIdx: 0, grabbing: true});
		if (item.mediaType === 'tv' && panel.wlExistingSeries) {
			watchlistStopSeries(sConn, panel.wlExistingSeries).then(function () {
				onToast(item.name + ' removed from watchlist');
				setPanel(null);
				refreshWlStatus();
			}).catch(function () { onToast('Failed to update', 'error'); setPanel(function (p) { return p ? {...p, level: 'actions', grabbing: false} : null; }); });
		} else if (panel.wlExistingMovie) {
			watchlistStopMovie(rConn, panel.wlExistingMovie).then(function () {
				onToast(item.name + ' removed from watchlist');
				setPanel(null);
				refreshWlStatus();
			}).catch(function () { onToast('Failed to update', 'error'); setPanel(function (p) { return p ? {...p, level: 'actions', grabbing: false} : null; }); });
		}
	}, [panel, sConn, rConn, onToast, refreshWlStatus]);

	// --- download via arr ---

	var startArrDownload = useCallback(function () {
		if (!panel || dlBusyRef.current) {
			if (dlBusyRef.current) onToast('A download is already in progress');
			return;
		}
		var item = panel.item;
		if (item.mediaType === 'movie') {
			dlBusyRef.current = true;
			setPanel(function (p) { return p ? {...p, level: 'loading', grabbing: true} : null; });
			downloadMovie(rConn, item.id)
				.then(function (result) {
					if (result.alreadyHasFile) {
						onToast(result.title + ' is already downloaded');
						setPanel(null);
						dlBusyRef.current = false;
						return;
					}
					if (result.qualityUpgraded) onToast('Quality upgraded to HD-1080p');
					onToast('Searching for ' + result.title + '…');
					setPanel(null);
					refreshWlStatus();
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
				})
				.catch(function (e) {
					onToast(e && e.message || 'Download failed', 'error');
					setPanel(null);
					dlBusyRef.current = false;
				});
		} else {
			setPanel(function (p) { return p ? {...p, level: 'loading', grabbing: true} : null; });
			downloadSeriesPrep(sConn, item.id)
				.then(function (prep) {
					setPanel(function (p) {
						return p ? {...p, level: 'dl-scope', btnIdx: 4, grabbing: false, dlCounts: prep, dlSeasons: prep.seasons} : null;
					});
				})
				.catch(function (e) {
					onToast(e && e.message || 'Lookup failed', 'error');
					setPanel(function (p) { return p ? {...p, level: 'actions', grabbing: false} : null; });
				});
		}
	}, [panel, sConn, rConn, onToast, refreshWlStatus]);

	var executeDlScope = useCallback(function (scope: DownloadScope) {
		if (!panel || dlBusyRef.current) return;
		var item = panel.item;
		dlBusyRef.current = true;
		setPanel(function (p) { return p ? {...p, level: 'loading', grabbing: true} : null; });
		downloadSeries(sConn, item.id, scope)
			.then(function (result) {
				if (result.qualityUpgraded) onToast('Quality upgraded to HD-1080p');
				onToast('Monitoring ' + result.monitoredCount + ' episode' + (result.monitoredCount !== 1 ? 's' : '') + ' of ' + result.title);
				onToast('Searching…');
				setPanel(null);
				refreshWlStatus();
				var count = 0;
				dlPollRef.current = window.setInterval(function () {
					count++;
					if (count > 10) {
						window.clearInterval(dlPollRef.current);
						dlBusyRef.current = false;
						onToast('No releases found yet. ' + result.title + ' stays on your Watchlist and will download when one appears.');
						return;
					}
					sonarrQueue(sConn).then(function (q) {
						for (var i = 0; i < q.records.length; i++) {
							if (q.records[i].seriesId === result.seriesId) {
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
			})
			.catch(function (e) {
				onToast(e && e.message || 'Download failed', 'error');
				setPanel(null);
				dlBusyRef.current = false;
			});
	}, [panel, sConn, onToast, refreshWlStatus]);

	var selectDlScope = useCallback(function (scope: DownloadScope, episodeCount: number) {
		if (episodeCount > 30) {
			setPanel(function (p) { return p ? {...p, level: 'dl-confirm', btnIdx: 0, dlPendingScope: scope, dlPendingCount: episodeCount} : null; });
			return;
		}
		executeDlScope(scope);
	}, [executeDlScope]);

	useEffect(function () {
		return function () {
			if (dlPollRef.current) window.clearInterval(dlPollRef.current);
		};
	}, []);

	var handleWlConfirmTrap = useCallback(function (e: KeyboardEvent) {
		if (!panel) return;
		var code = e.keyCode;
		if (code === 461 || code === 27) {
			if (panel.level === 'wl-stop') setPanel({...panel, level: 'actions', btnIdx: 0});
			else if (panel.item.mediaType === 'tv') setPanel({...panel, level: 'monitor', btnIdx: 0});
			else setPanel({...panel, level: 'actions', btnIdx: 0});
			return;
		}
		if (code === 37 || code === 39) {
			setPanel(function (p) { return p ? {...p, btnIdx: p.btnIdx === 0 ? 1 : 0} : null; });
			return;
		}
		if (code === 13) {
			if (panel.btnIdx === 0) {
				if (panel.level === 'wl-stop') setPanel({...panel, level: 'actions', btnIdx: 0});
				else if (panel.item.mediaType === 'tv') setPanel({...panel, level: 'monitor', btnIdx: 0});
				else setPanel({...panel, level: 'actions', btnIdx: 0});
			} else {
				if (panel.level === 'wl-stop') doStopMonitoring();
				else doWatchlistConfirm();
			}
		}
	}, [panel, doWatchlistConfirm, doStopMonitoring]);

	useKeyTrap(handleWlConfirmTrap, !!(panel && (panel.level === 'wl-confirm' || panel.level === 'wl-stop')));

	// --- keyboard ---

	const handleKey = useCallback((key: NavKey): boolean => {
		// Panel navigation
		if (panel) {
			if (panel.grabbing || panel.level === 'loading') return true;

			if (key === 'back' || key === 'left') {
				if (panel.level === 'episodes') setPanel({...panel, level: 'seasons', btnIdx: panel.seasonIdx + 1});
				else if (panel.level === 'seasons') setPanel({...panel, level: 'actions', btnIdx: panelBtns.length - 1, search: panel.search});
				else if (panel.level === 'monitor') setPanel({...panel, level: 'actions', btnIdx: 0});
				else if (panel.level === 'dl-scope') setPanel({...panel, level: 'actions', btnIdx: panelBtns.length - 1});
				else if (panel.level === 'dl-seasons') setPanel({...panel, level: 'dl-scope', btnIdx: panel.dlMode === 'episode' ? 0 : 1});
				else if (panel.level === 'dl-episodes') setPanel({...panel, level: 'dl-seasons', btnIdx: 0, dlEpisodes: undefined});
				else if (panel.level === 'dl-confirm') setPanel({...panel, level: 'dl-scope', btnIdx: 4});
				else setPanel(null);
				return true;
			}

			if (panel.level === 'actions') {
				var mx = panelBtns.length - 1;
				if (key === 'up') setPanel({...panel, btnIdx: Math.max(0, panel.btnIdx - 1)});
				else if (key === 'down') setPanel({...panel, btnIdx: Math.min(mx, panel.btnIdx + 1)});
				return true;
			}

			if (panel.level === 'monitor') {
				var mCnt = MONITOR_OPTS.length;
				if (key === 'up') setPanel({...panel, btnIdx: Math.max(0, panel.btnIdx - 1)});
				else if (key === 'down') setPanel({...panel, btnIdx: Math.min(mCnt - 1, panel.btnIdx + 1)});
				return true;
			}

			if (panel.level === 'dl-scope') {
				if (key === 'up') setPanel({...panel, btnIdx: Math.max(0, panel.btnIdx - 1)});
				else if (key === 'down') setPanel({...panel, btnIdx: Math.min(4, panel.btnIdx + 1)});
				return true;
			}

			if (panel.level === 'dl-seasons') {
				var dlSnCnt = (panel.dlSeasons ? panel.dlSeasons.length : 0) + 1;
				if (key === 'up') setPanel({...panel, btnIdx: Math.max(0, panel.btnIdx - 1)});
				else if (key === 'down') setPanel({...panel, btnIdx: Math.min(dlSnCnt - 1, panel.btnIdx + 1)});
				return true;
			}

			if (panel.level === 'dl-episodes') {
				var dlEpCnt = (panel.dlEpisodes ? panel.dlEpisodes.length : 0) + 1;
				if (key === 'up') setPanel({...panel, btnIdx: Math.max(0, panel.btnIdx - 1)});
				else if (key === 'down') setPanel({...panel, btnIdx: Math.min(dlEpCnt - 1, panel.btnIdx + 1)});
				return true;
			}

			if (panel.level === 'dl-confirm') {
				if (key === 'up' || key === 'down') setPanel({...panel, btnIdx: panel.btnIdx === 0 ? 1 : 0});
				return true;
			}

			if (panel.level === 'seasons') {
				var cnt = seasonList.length + 1;
				if (key === 'up') setPanel({...panel, btnIdx: Math.max(0, panel.btnIdx - 1)});
				else if (key === 'down') setPanel({...panel, btnIdx: Math.min(cnt - 1, panel.btnIdx + 1)});
				return true;
			}

			if (panel.level === 'episodes') {
				var season = seasonList[panel.seasonIdx];
				var epCnt = (season && season.pack ? 1 : 0) + (season ? season.episodes.length : 0);
				if (key === 'up') setPanel({...panel, btnIdx: Math.max(0, panel.btnIdx - 1)});
				else if (key === 'down') setPanel({...panel, btnIdx: Math.min(epCnt - 1, panel.btnIdx + 1)});
				return true;
			}

			return true;
		}

		// Normal navigation
		if (key === 'back') {
			if (zone !== 'sidebar') setZone('sidebar');
			else onExitDown();
			return true;
		}

		if (zone === 'sidebar') {
			if (key === 'up') { if (tabIdx > 0) switchTab(tabIdx - 1); }
			else if (key === 'down') { if (tabIdx < TABS.length - 1) switchTab(tabIdx + 1); else onExitDown(); }
			else if (key === 'right') { if (tab.id === 'browse' || tab.id === 'server' || tab.id === 'watchlist' || tab.id === 'downloads' || rows.length > 0) setZone('rows'); }
			return true;
		}

		if (zone === 'rows') {
			var c = cols[rowIdx] || 0;
			var r = rows[rowIdx];
			if (key === 'left') {
				if (c > 0) setCols(function (p) { return {...p, [rowIdx]: c - 1}; });
				else setZone('sidebar');
			}
			else if (key === 'right' && r) setCols(function (p) { return {...p, [rowIdx]: clamp(c + 1, 0, r.items.length - 1)}; });
			else if (key === 'up') {
				if (rowIdx > 0) setRowIdx(rowIdx - 1);
				else setZone('sidebar');
			}
			else if (key === 'down') {
				if (rowIdx < rows.length - 1) setRowIdx(rowIdx + 1);
				else onExitDown();
			}
			return true;
		}

		return true;
	}, [zone, tabIdx, rowIdx, cols, rows, panel, panelBtns, seasonList, onExitDown, switchTab]);

	const cinemaKeysActive = active && (zone === 'sidebar' || !!panel || tab.id === 'home');
	useKeys(handleKey, cinemaKeysActive);

	useOkPress({
		onPress: () => {
			if (panel) {
				if (panel.grabbing || panel.level === 'loading') return;

				if (panel.level === 'actions') {
					const btn = panelBtns[panel.btnIdx];
					if (!btn) return;
					if (btn.action === 'launch-plex') {
						if (onPlayPlex && panel && plexIdx) {
							var rk = plexIdx.getRatingKey(panel.item.mediaType, panel.item.id);
							if (rk) { onPlayPlex(rk, panel.item.name); setPanel(null); return; }
						}
						launchApp(PLEX_APP).catch(function () { onToast("Couldn't open Plex", 'error'); }); setPanel(null);
					}
					else if (btn.action === 'on-server') { /* label only, no action */ }
					else if (btn.action.indexOf('launch:') === 0) { onLaunch(btn.action.slice(7)); setPanel(null); }
					else if (btn.action === 'watchlist') startWatchlist();
					else if (btn.action === 'on-watchlist') startStopWatchlist();
					else if (btn.action === 'download') { if (hasArr) startArrDownload(); else startDownload(); }
					return;
				}

				if (panel.level === 'monitor') {
					const opt = MONITOR_OPTS[panel.btnIdx];
					if (opt) selectMonitorScope(opt.key);
					return;
				}

				if (panel.level === 'dl-scope') {
					if (panel.btnIdx === 0) {
						setPanel({...panel, level: 'dl-seasons', btnIdx: 0, dlMode: 'episode'});
					} else if (panel.btnIdx === 1) {
						setPanel({...panel, level: 'dl-seasons', btnIdx: 0, dlMode: 'season'});
					} else if (panel.btnIdx === 2) {
						selectDlScope('lastSeason', panel.dlCounts ? panel.dlCounts.lastSeason : 0);
					} else if (panel.btnIdx === 3) {
						selectDlScope('all', panel.dlCounts ? panel.dlCounts.all : 0);
					} else {
						setPanel({...panel, level: 'actions', btnIdx: panelBtns.length - 1});
					}
					return;
				}

				if (panel.level === 'dl-seasons') {
					var dlSeasonsArr = panel.dlSeasons || [];
					var lastDlIdx = dlSeasonsArr.length;
					if (panel.btnIdx === lastDlIdx) {
						setPanel({...panel, level: 'dl-scope', btnIdx: panel.dlMode === 'episode' ? 0 : 1});
					} else {
						var picked = dlSeasonsArr[panel.btnIdx];
						if (!picked) return;
						if (panel.dlMode === 'season') {
							selectDlScope({season: picked.number}, picked.count);
						} else {
							setPanel(function (p) { return p ? {...p, level: 'loading', grabbing: true, dlSeasonNumber: picked.number, dlEpisodes: undefined} : null; });
							downloadSeriesListEpisodes(sConn, panel.item.id, picked.number)
								.then(function (eps) {
									setPanel(function (p) { return p ? {...p, level: 'dl-episodes', btnIdx: 0, grabbing: false, dlEpisodes: eps} : null; });
								})
								.catch(function (e) {
									onToast(e && e.message || 'Failed to load episodes', 'error');
									setPanel(function (p) { return p ? {...p, level: 'dl-seasons', btnIdx: 0, grabbing: false} : null; });
								});
						}
					}
					return;
				}

				if (panel.level === 'dl-episodes') {
					var dlEpsArr = panel.dlEpisodes || [];
					var lastEpIdx = dlEpsArr.length;
					if (panel.btnIdx === lastEpIdx) {
						setPanel({...panel, level: 'dl-seasons', btnIdx: 0, dlEpisodes: undefined});
					} else {
						var ep = dlEpsArr[panel.btnIdx];
						if (ep) selectDlScope({episode: ep.id}, 1);
					}
					return;
				}

				if (panel.level === 'dl-confirm') {
					if (panel.btnIdx === 0) {
						setPanel({...panel, level: 'dl-scope', btnIdx: 4});
					} else if (panel.dlPendingScope) {
						executeDlScope(panel.dlPendingScope);
					}
					return;
				}

				if (panel.level === 'seasons' && panel.search && panel.search.shows.length > 0) {
					const show = panel.search.shows[0];
					if (panel.btnIdx === 0) {
						const items: GrabItem[] = [];
						for (const season of show.seasons) {
							if (season.pack) items.push({fid: season.pack.fid, filename: season.pack.filename, name: show.title});
							else for (const ep of season.episodes) items.push({fid: ep.fid, filename: ep.filename, name: show.title});
						}
						doGrab(items, 'all seasons');
					} else {
						setPanel({...panel, level: 'episodes', seasonIdx: panel.btnIdx - 1, btnIdx: 0});
					}
					return;
				}

				if (panel.level === 'episodes' && panel.search && panel.search.shows.length > 0) {
					const show = panel.search.shows[0];
					const season = show.seasons[panel.seasonIdx];
					if (!season) return;
					const hasPack = !!season.pack;
					if (hasPack && panel.btnIdx === 0) {
						const items: GrabItem[] = season.pack ? [{fid: season.pack.fid, filename: season.pack.filename, name: show.title}] : [];
						doGrab(items, season.label);
					} else {
						const epIdx = hasPack ? panel.btnIdx - 1 : panel.btnIdx;
						const ep = season.episodes[epIdx];
						if (ep) doGrab([{fid: ep.fid, filename: ep.filename, name: show.title}], ep.name || ep.filename);
					}
					return;
				}
				return;
			}

			if (zone === 'sidebar') {
				if (tab.id === 'browse' || tab.id === 'server' || rows.length > 0) setZone('rows');
			} else if (zone === 'rows') {
				const r = rows[rowIdx];
				if (!r) return;
				const item = r.items[col];
				if (!item) return;
				setPanel({item, level: 'actions', btnIdx: 0, search: null, seasonIdx: 0, grabbing: false});
			}
		},
		onLongPress: () => {}
	}, cinemaKeysActive);

	const rowScrollY = rowIdx > 0 ? rowIdx * ROW_SCROLL : 0;

	return (
		<div class="cinema" style={rowAreaPx ? 'bottom:' + rowAreaPx + 'px' : undefined}>
			<nav class={'cinema__sidebar' + (zone === 'sidebar' && !panel ? ' cinema__sidebar--active' : '')}>
				<div class="cinema__logo"><span class="cinema__monogram">S</span><span class="cinema__wordmark">SPOKE</span></div>
				{TABS.map((t, i) => (
					<div
						key={t.id}
						class={['cinema__nav', i === tabIdx && 'cinema__nav--active', zone === 'sidebar' && !panel && i === tabIdx && 'cinema__nav--focused'].filter(Boolean).join(' ')}
						onMouseEnter={() => { if (!panel) { setZone('sidebar'); switchTab(i); } }}
					>
						<NavIcon id={t.id} />
						<span>{t.label}</span>
						{t.id === 'downloads' && dlUnread > 0 && <span class="cinema__nav-badge">{dlUnread > 99 ? '99+' : dlUnread}</span>}
					</div>
				))}
			</nav>

			<div class="cinema__main">
				{tab.id === 'browse' ? (
					<Browse
						apiKey={apiKey}
						allowShell={allowShell}
						active={active && zone === 'rows' && !panel}
						providerIds={providerIds}
						onOpenPanel={openBrowsePanel}
						onExitLeft={() => setZone('sidebar')}
						onToast={onToast}
						plexIdx={plexIdx}
					/>
				) : tab.id === 'server' ? (
					<MyServer
						plexUrl={plexUrl}
						plexToken={plexToken}
						active={active && zone === 'rows' && !panel}
						showHidden={showHidden}
						onExitLeft={() => setZone('sidebar')}
						onToast={onToast}
						sonarrUrl={sonarrUrl}
						sonarrKey={sonarrKey}
						radarrUrl={radarrUrl}
						radarrKey={radarrKey}
						onPlayPlex={onPlayPlex}
					/>
				) : tab.id === 'watchlist' ? (
					<Watchlist
						sonarrUrl={sonarrUrl}
						sonarrKey={sonarrKey}
						radarrUrl={radarrUrl}
						radarrKey={radarrKey}
						active={active && zone === 'rows' && !panel}
						onExitLeft={() => setZone('sidebar')}
						onToast={onToast}
						enableDelete={enableDeleteActions}
					/>
				) : tab.id === 'downloads' ? (
					<Downloads
						sonarrUrl={sonarrUrl}
						sonarrKey={sonarrKey}
						radarrUrl={radarrUrl}
						radarrKey={radarrKey}
						active={active && zone === 'rows' && !panel}
						onExitLeft={() => setZone('sidebar')}
						onToast={onToast}
					/>
				) : (
				<>
				<div class="cinema__hero">
					<div class="cinema__hero-bd" style={'background-image:' + (bdUrl0 ? 'url(' + bdUrl0 + ')' : 'none') + ';opacity:' + (bdSlot === 0 ? 1 : 0)} />
					<div class="cinema__hero-bd" style={'background-image:' + (bdUrl1 ? 'url(' + bdUrl1 + ')' : 'none') + ';opacity:' + (bdSlot === 1 ? 1 : 0)} />
					<div class="cinema__hero-scrim" />
					{heroItem && (
						<div class="cinema__hero-info">
							<h1 class="cinema__hero-title">{heroItem.name}</h1>
							<div class="cinema__hero-meta">
								{yearOf(heroItem.firstAir) && <span class="cinema__badge">{yearOf(heroItem.firstAir)}</span>}
								{heroItem.rating > 0 && <span class="cinema__badge">{heroItem.rating.toFixed(1)}</span>}
								<span class="cinema__badge">{heroItem.mediaType === 'tv' ? 'TV Series' : 'Movie'}</span>
							</div>
							{heroItem.overview && <p class="cinema__hero-desc">{heroItem.overview}</p>}
						</div>
					)}
				</div>

				<div class="cinema__rows">
					<div class="cinema__rows-inner" style={'transform:translate3d(0,' + (-rowScrollY) + 'px,0)'}>
						{rows.map((r, ri) => {
							const c = cols[ri] || 0;
							const total = r.items.length * CARD_STEP;
							const fits = total <= VIEW_W;
							const off = fits ? 0 : clamp(c * CARD_STEP + CARD_W / 2 - VIEW_W / 2, 0, Math.max(0, total - VIEW_W));
							return (
								<div key={ri} class={'cinema__row' + (zone === 'rows' && ri === rowIdx ? ' cinema__row--active' : '')}>
									<h2 class="cinema__row-title">{r.title}</h2>
									<div class="cinema__row-viewport">
										<div class="cinema__row-track" style={'transform:translate3d(' + (-off) + 'px,0,0)'}>
											{r.items.map((item, ci) => {
												const focused = zone === 'rows' && ri === rowIdx && ci === (cols[ri] || 0) && !panel;
												const p = posterUrlXL(item.poster);
												return (
													<div
														key={item.id}
														class={'cinema__card' + (focused ? ' cinema__card--focused' : '')}
														onMouseEnter={() => { if (!panel) { setZone('rows'); setRowIdx(ri); setCols(function (prev) { return {...prev, [ri]: ci}; }); } }}
													>
														{p
															? <img class="cinema__poster" src={p} alt="" />
															: <div class="cinema__poster cinema__poster--empty" />}
														{plexIdx && plexIdx.has(item.mediaType, item.id) && <div class="plex-server-badge"><span class="plex-server-badge__icon">✓</span>Server</div>}
														<div class="cinema__card-title">{item.name}</div>
														<div class="cinema__card-year">{yearOf(item.firstAir)}</div>
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
				</>
				)}

				{/* scrim behind panel */}
				<div class={'cinema__scrim' + (panel ? ' cinema__scrim--active' : '')} />

				{/* action / download panel */}
				<div class={'cinema__panel' + (panel ? ' cinema__panel--open' : '')}>
					{panel && panel.level === 'actions' && (
						<div class="cinema__panel-content">
							<h2 class="cinema__panel-title">{panel.item.name}</h2>
							<p class="cinema__panel-sub">{yearOf(panel.item.firstAir)}{panel.item.rating > 0 ? ' · ' + panel.item.rating.toFixed(1) : ''} {'· '}{panel.item.mediaType === 'tv' ? 'TV Series' : 'Movie'}</p>
							{panelBtns.map((btn, i) => (
								<button key={i} class={'cinema__panel-btn' + (i === panel.btnIdx ? ' cinema__panel-btn--focused' : '')}>
									<span class="cinema__panel-btn-icon">{btn.action === 'download' ? '↓' : btn.action === 'watchlist' ? '+' : btn.action === 'on-watchlist' ? '✓' : btn.action === 'on-server' ? '✓' : '▶'}</span>
									{btn.label}
								</button>
							))}
							<div class="cinema__panel-credit">Streaming data by JustWatch</div>
						</div>
					)}
					{panel && panel.level === 'loading' && (
						<div class="cinema__panel-loading">{panel.grabbing ? 'Adding…' : 'Searching…'}</div>
					)}
					{panel && panel.level === 'monitor' && (
						<div class="cinema__panel-content">
							<div class="cinema__panel-back">{'← ' + panel.item.name}</div>
							<h2 class="cinema__panel-title">Monitor</h2>
							<p class="cinema__panel-sub">Which episodes should be monitored?</p>
							{MONITOR_OPTS.map((opt, i) => {
								var countStr = '';
								if (panel.wlCounts && opt.key !== 'none') {
									var n = opt.key === 'future' ? panel.wlCounts.future : opt.key === 'lastSeason' ? panel.wlCounts.lastSeason : panel.wlCounts.all;
									countStr = ' (' + n + ' episode' + (n !== 1 ? 's' : '') + ')';
								}
								return (
									<button key={opt.key} class={'cinema__panel-btn' + (i === panel.btnIdx ? ' cinema__panel-btn--focused' : '')}>
										{opt.label + countStr}
									</button>
								);
							})}
							<p class="cinema__panel-note">Monitored titles are picked up by RSS sync. New matching releases may download automatically.</p>
						</div>
					)}
					{panel && panel.level === 'wl-confirm' && (
						<div class="cinema__panel-content watchlist__confirm">
							<h2 class="cinema__panel-title">Add to Watchlist?</h2>
							<div class="watchlist__confirm-warn">
								<p><strong>{panel.item.name}</strong></p>
								{panel.wlScope && panel.wlCounts && (function () {
									var key = panel.wlScope === 'future' ? 'future' : panel.wlScope === 'lastSeason' ? 'lastSeason' : 'all';
									var n = panel.wlCounts[key as keyof typeof panel.wlCounts];
									return panel.wlScope !== 'none' ? <p>{n + ' episode' + (n !== 1 ? 's' : '') + ' will be monitored'}</p> : null;
								})()}
								{panel.wlScope && !panel.wlCounts && <p>{'Scope: ' + (MONITOR_OPTS.find(function (o) { return o.key === panel.wlScope; }) || {label: ''}).label}</p>}
								{!panel.wlScope && <p>{'Movie will be monitored'}</p>}
								<p>Monitored titles are picked up by RSS sync. New matching releases may download automatically.</p>
							</div>
							<div class="watchlist__confirm-btns">
								<button class={'cinema__panel-btn' + (panel.btnIdx === 0 ? ' cinema__panel-btn--focused' : '')}>Cancel</button>
								<button class={'cinema__panel-btn' + (panel.btnIdx === 1 ? ' cinema__panel-btn--focused' : '')}>Add</button>
							</div>
						</div>
					)}
					{panel && panel.level === 'wl-stop' && (
						<div class="cinema__panel-content watchlist__confirm">
							<h2 class="cinema__panel-title">Stop Monitoring?</h2>
							<div class="watchlist__confirm-warn">
								<p><strong>{panel.item.name}</strong> will stop being monitored. No files will be deleted.</p>
							</div>
							<div class="watchlist__confirm-btns">
								<button class={'cinema__panel-btn' + (panel.btnIdx === 0 ? ' cinema__panel-btn--focused' : '')}>Cancel</button>
								<button class={'cinema__panel-btn' + (panel.btnIdx === 1 ? ' cinema__panel-btn--focused' : '')}>Stop Monitoring</button>
							</div>
						</div>
					)}
					{panel && panel.level === 'dl-scope' && (
						<div class="cinema__panel-content">
							<div class="cinema__panel-back">{'← ' + panel.item.name}</div>
							<h2 class="cinema__panel-title">Download</h2>
							<p class="cinema__panel-sub">What do you want to download?</p>
							<button class={'cinema__panel-btn' + (panel.btnIdx === 0 ? ' cinema__panel-btn--focused' : '')}>Episode…</button>
							<button class={'cinema__panel-btn' + (panel.btnIdx === 1 ? ' cinema__panel-btn--focused' : '')}>Season…</button>
							<button class={'cinema__panel-btn' + (panel.btnIdx === 2 ? ' cinema__panel-btn--focused' : '')}>
								{'Latest Season' + (panel.dlCounts ? ' (' + panel.dlCounts.lastSeason + ' ep' + (panel.dlCounts.lastSeason !== 1 ? 's' : '') + ')' : '')}
							</button>
							<button class={'cinema__panel-btn' + (panel.btnIdx === 3 ? ' cinema__panel-btn--focused' : '')}>
								{'All Episodes' + (panel.dlCounts ? ' (' + panel.dlCounts.all + ' ep' + (panel.dlCounts.all !== 1 ? 's' : '') + ')' : '')}
							</button>
							<button class={'cinema__panel-btn' + (panel.btnIdx === 4 ? ' cinema__panel-btn--focused' : '')}>Cancel</button>
						</div>
					)}
					{panel && panel.level === 'dl-seasons' && (
						<div class="cinema__panel-content">
							<div class="cinema__panel-back">{'← ' + (panel.dlMode === 'episode' ? 'Episode' : 'Season')}</div>
							<h2 class="cinema__panel-title">{panel.dlMode === 'episode' ? 'Pick a Season' : 'Pick a Season'}</h2>
							{(panel.dlSeasons || []).map(function (s, i) {
								return (
									<button key={s.number} class={'cinema__panel-btn' + (panel.btnIdx === i ? ' cinema__panel-btn--focused' : '')}>
										{'Season ' + s.number + ' (' + s.count + ' ep' + (s.count !== 1 ? 's' : '') + ')'}
									</button>
								);
							})}
							<button class={'cinema__panel-btn' + (panel.btnIdx === (panel.dlSeasons || []).length ? ' cinema__panel-btn--focused' : '')}>Cancel</button>
						</div>
					)}
					{panel && panel.level === 'dl-episodes' && (
						<div class="cinema__panel-content">
							<div class="cinema__panel-back">{'← Season ' + (panel.dlSeasonNumber || '')}</div>
							<h2 class="cinema__panel-title">{'Season ' + (panel.dlSeasonNumber || '')}</h2>
							{(panel.dlEpisodes || []).map(function (ep, i) {
								return (
									<button key={ep.id} class={'cinema__panel-btn' + (panel.btnIdx === i ? ' cinema__panel-btn--focused' : '')}>
										{'S' + (ep.seasonNumber < 10 ? '0' : '') + ep.seasonNumber + 'E' + (ep.episodeNumber < 10 ? '0' : '') + ep.episodeNumber + ' — ' + (ep.title || 'TBA')}
									</button>
								);
							})}
							<button class={'cinema__panel-btn' + (panel.btnIdx === (panel.dlEpisodes || []).length ? ' cinema__panel-btn--focused' : '')}>Cancel</button>
						</div>
					)}
					{panel && panel.level === 'dl-confirm' && (
						<div class="cinema__panel-content watchlist__confirm">
							<h2 class="cinema__panel-title">Large Download</h2>
							<div class="watchlist__confirm-warn">
								<p>{'This will search ' + (panel.dlPendingCount || 0) + ' episodes and may download a lot of data.'}</p>
								<p>Continue?</p>
							</div>
							<div class="watchlist__confirm-btns">
								<button class={'cinema__panel-btn' + (panel.btnIdx === 0 ? ' cinema__panel-btn--focused' : '')}>Cancel</button>
								<button class={'cinema__panel-btn' + (panel.btnIdx === 1 ? ' cinema__panel-btn--focused' : '')}>Continue</button>
							</div>
						</div>
					)}
					{panel && panel.level === 'seasons' && (
						<div class="cinema__panel-content">
							<div class="cinema__panel-back">{'← ' + panel.item.name}</div>
							<h2 class="cinema__panel-title">Download</h2>
							<button class={'cinema__panel-btn' + (panel.btnIdx === 0 ? ' cinema__panel-btn--focused' : '')}>All Seasons</button>
							{seasonList.map((s, i) => (
								<button key={i} class={'cinema__panel-btn' + (panel.btnIdx === i + 1 ? ' cinema__panel-btn--focused' : '')}>{s.label}</button>
							))}
						</div>
					)}
					{panel && panel.level === 'episodes' && seasonList[panel.seasonIdx] && (
						<div class="cinema__panel-content">
							<div class="cinema__panel-back">{'← ' + seasonList[panel.seasonIdx].label}</div>
							<h2 class="cinema__panel-title">{seasonList[panel.seasonIdx].label}</h2>
							{seasonList[panel.seasonIdx].pack && (
								<button class={'cinema__panel-btn' + (panel.btnIdx === 0 ? ' cinema__panel-btn--focused' : '')}>
									{'Download All' + fmtSize(seasonList[panel.seasonIdx].pack!.size)}
								</button>
							)}
							{seasonList[panel.seasonIdx].episodes.map((ep, i) => {
								var idx = seasonList[panel.seasonIdx].pack ? i + 1 : i;
								return (
									<button key={i} class={'cinema__panel-btn' + (panel.btnIdx === idx ? ' cinema__panel-btn--focused' : '')}>
										{(ep.name || ep.filename) + fmtSize(ep.size)}
									</button>
								);
							})}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

function NavIcon ({id}: {id: string}) {
	return (
		<svg class="cinema__nav-icon" viewBox="0 0 24 24" aria-hidden="true">
			{id === 'home' && <path d="M3 11.5 12 4l9 7.5M5.5 9.8V20h13V9.8M10 20v-6h4v6" />}
			{id === 'movies' && <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M4 8h16M4 16h16M8 3v5M8 16v5" /></>}
			{id === 'shows' && <><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M10 9l5 3-5 3z" /></>}
			{id === 'server' && <><rect x="4" y="3" width="16" height="7" rx="1.5" /><rect x="4" y="14" width="16" height="7" rx="1.5" /><circle cx="8" cy="6.5" r="1" /><circle cx="8" cy="17.5" r="1" /></>}
			{id === 'browse' && <><circle cx="11" cy="11" r="7" /><path d="M16 16l5 5" /><path d="M8 11h6M11 8v6" /></>}
			{id === 'watchlist' && <><path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" /></>}
			{id === 'downloads' && <><path d="M12 3v12M8 11l4 4 4-4" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></>}
		</svg>
	);
}
