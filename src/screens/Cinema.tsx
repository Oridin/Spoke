import {useCallback, useEffect, useMemo, useRef, useState} from 'preact/hooks';
import {useKeys, clamp, type NavKey} from '../hooks/useKeys';
import {useOkPress} from '../hooks/useOkPress';
import {backdropUrl, posterUrlXL, yearOf, type TrendingShow, type TrendingData} from '../lib/trending';
import {sendToSeedbox} from '../lib/seedbox';
import {Browse} from './Browse';
import {MyServer} from './MyServer';
import {Watchlist} from './Watchlist';
import {Downloads} from './Downloads';
import {getPlexIndex, refreshPlexIndex, onPlexIndexChange, type PlexIndex, type PlexItem} from '../lib/plex';
import {findByTvdbId, fetchSearchResults as tmdbSearch} from '../lib/tmdb';
import {getHiddenSections} from '../lib/pin';
import {startMonitor, stopMonitor, getUnreadCount, clearUnread, onUnreadChange} from '../lib/dlmonitor';
import {ShowDetail} from './ShowDetail';
import {
	sonarrConn, radarrConn,
	sonarrGetSeries, radarrGetMovies,
	type SonarrSeries, type RadarrMovie,
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
	hasFetchbox: boolean;
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

const CARD_W = 200;
const CARD_GAP = 20;
const CARD_STEP = CARD_W + CARD_GAP;
const VIEW_W = 1700;
const ROW_SCROLL = 460;
const HERO_DEBOUNCE = 250;

export function CinemaPanel ({trending, installedAppIds, onLaunch, onToast, active, onExitDown, rowAreaPx, apiKey, allowShell, providerIds, plexUrl, plexToken, showHidden, onRelockHidden, sonarrUrl, sonarrKey, radarrUrl, radarrKey, enableDeleteActions, hasFetchbox, onPlayPlex}: Props) {
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

	// Show Detail page — stack supports opening details from inside details (Back pops)
	var [showDetailStack, setShowDetailStack] = useState<TrendingShow[]>([]);
	var showDetail = showDetailStack.length > 0 ? showDetailStack[showDetailStack.length - 1] : null;
	var pushShowDetail = useCallback(function (item: TrendingShow) {
		setShowDetailStack(function (s) { return s.length >= 10 ? s.slice(1).concat(item) : s.concat(item); });
	}, []);
	var popShowDetail = useCallback(function () {
		setShowDetailStack(function (s) { return s.length <= 1 ? [] : s.slice(0, -1); });
	}, []);
	var clearShowDetail = useCallback(function () { setShowDetailStack([]); }, []);

	// Plex library index: lightweight TMDB-id lookup for "Play on Plex"
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
		if (TABS[i] && TABS[i].id === 'downloads') clearUnread();
	}, []);

	const openServerShowDetail = useCallback((item: PlexItem) => {
		if (item.type !== 'show') return;
		var tmdbId = plexIdx ? plexIdx.getTmdbId(item.ratingKey) : null;
		if (tmdbId && tmdbId > 0) {
			pushShowDetail({id: tmdbId, name: item.title, mediaType: 'tv', overview: item.summary || '', firstAir: '', rating: item.rating || 0, poster: null, backdrop: null, providers: []});
			return;
		}
		if (lookingUpRef.current) return;
		lookingUpRef.current = true;
		onToast('Looking up ' + item.title + '…');
		tmdbSearch('tv', apiKey, item.title, 1, allowShell).then(function (result) {
			var match: TrendingShow | null = null;
			for (var i = 0; i < result.items.length; i++) {
				if (item.year && yearOf(result.items[i].firstAir) === String(item.year)) { match = result.items[i]; break; }
			}
			if (match) pushShowDetail(match);
			else onToast("Couldn't identify this show", 'error');
		}).catch(function () { onToast('TMDB lookup failed', 'error'); }).then(function () { lookingUpRef.current = false; });
	}, [plexIdx, apiKey, allowShell, onToast, pushShowDetail]);

	const openWatchlistShowDetail = useCallback((title: string, year: number, tvdbId?: number) => {
		if (lookingUpRef.current) return;
		lookingUpRef.current = true;
		var done = function () { lookingUpRef.current = false; };
		if (tvdbId) {
			findByTvdbId(apiKey, tvdbId, allowShell).then(function (show) {
				if (show && show.id > 0) { pushShowDetail(show); done(); return; }
				tmdbSearch('tv', apiKey, title, 1, allowShell).then(function (result) {
					var match: TrendingShow | null = null;
					for (var i = 0; i < result.items.length; i++) {
						if (year && yearOf(result.items[i].firstAir) === String(year)) { match = result.items[i]; break; }
					}
					if (match) pushShowDetail(match);
					else onToast("Couldn't identify this show", 'error');
				}).catch(function () { onToast('TMDB lookup failed', 'error'); }).then(done);
			}).catch(function () { onToast('TMDB lookup failed', 'error'); done(); });
			return;
		}
		tmdbSearch('tv', apiKey, title, 1, allowShell).then(function (result) {
			var match: TrendingShow | null = null;
			for (var i = 0; i < result.items.length; i++) {
				if (year && yearOf(result.items[i].firstAir) === String(year)) { match = result.items[i]; break; }
			}
			if (match) pushShowDetail(match);
			else onToast("Couldn't identify this show", 'error');
		}).catch(function () { onToast('TMDB lookup failed', 'error'); }).then(done);
	}, [apiKey, allowShell, onToast, pushShowDetail]);

	// --- seedbox handler for ShowDetail fallback ---
	var handleSeedbox = useCallback(function (name: string, year: string, mediaType: string) {
		onToast('Searching seedbox…');
		sendToSeedbox(name, year, mediaType).then(function (result) {
			if (result.grabbed.length > 0) onToast('Sent to seedbox: ' + result.grabbed.join(', '));
			else if (result.errors.length > 0) onToast(result.errors[0], 'error');
			else onToast('Nothing found', 'error');
		}).catch(function (e: Error) { onToast('Seedbox error: ' + e.message, 'error'); });
	}, [onToast]);

	// --- watchlist status ---

	var sConn = useMemo(function () { return sonarrConn({sonarrUrl: sonarrUrl, sonarrKey: sonarrKey}); }, [sonarrUrl, sonarrKey]);
	var rConn = useMemo(function () { return radarrConn({radarrUrl: radarrUrl, radarrKey: radarrKey}); }, [radarrUrl, radarrKey]);

	var lookingUpRef = useRef(false);

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

	// --- keyboard ---

	const handleKey = useCallback((key: NavKey): boolean => {
		if (key === 'back') {
			if (showDetail && zone === 'sidebar') { clearShowDetail(); return true; }
			if (zone !== 'sidebar') setZone('sidebar');
			else onExitDown();
			return true;
		}

		if (zone === 'sidebar') {
			if (key === 'up') { if (tabIdx > 0) { if (showDetail) clearShowDetail(); switchTab(tabIdx - 1); } }
			else if (key === 'down') { if (tabIdx < TABS.length - 1) { if (showDetail) clearShowDetail(); switchTab(tabIdx + 1); } else onExitDown(); }
			else if (key === 'right') {
				if (showDetail) setZone('rows');
				else if (tab.id === 'browse' || tab.id === 'server' || tab.id === 'watchlist' || tab.id === 'downloads' || rows.length > 0) setZone('rows');
			}
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
	}, [zone, tabIdx, rowIdx, cols, rows, onExitDown, switchTab, showDetail, clearShowDetail]);

	const cinemaKeysActive = active && (zone === 'sidebar' || (!showDetail && tab.id === 'home'));
	useKeys(handleKey, cinemaKeysActive);

	useOkPress({
		onPress: () => {
			if (zone === 'sidebar') {
				if (showDetail) setZone('rows');
				else if (tab.id === 'browse' || tab.id === 'server' || rows.length > 0) setZone('rows');
			} else if (zone === 'rows') {
				const r = rows[rowIdx];
				if (!r) return;
				const item = r.items[col];
				if (item) pushShowDetail(item);
			}
		},
		onLongPress: () => {}
	}, cinemaKeysActive);

	const rowScrollY = rowIdx > 0 ? rowIdx * ROW_SCROLL : 0;

	return (
		<div class="cinema" style={rowAreaPx ? 'bottom:' + rowAreaPx + 'px' : undefined}>
			<nav class={'cinema__sidebar' + (zone === 'sidebar' ? ' cinema__sidebar--active' : '')}>
				<div class="cinema__logo"><span class="cinema__monogram">S</span><span class="cinema__wordmark">SPOKE</span></div>
				{TABS.map((t, i) => (
					<div
						key={t.id}
						class={['cinema__nav', i === tabIdx && 'cinema__nav--active', zone === 'sidebar' && i === tabIdx && 'cinema__nav--focused'].filter(Boolean).join(' ')}
						onMouseEnter={() => { setZone('sidebar'); switchTab(i); }}
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
						active={active && zone === 'rows' && !showDetail}
						providerIds={providerIds}
						onOpenPanel={pushShowDetail}
						onExitLeft={() => setZone('sidebar')}
						onToast={onToast}
						plexIdx={plexIdx}
					/>
				) : tab.id === 'server' ? (
					<MyServer
						plexUrl={plexUrl}
						plexToken={plexToken}
						active={active && zone === 'rows' && !showDetail}
						showHidden={showHidden}
						onExitLeft={() => setZone('sidebar')}
						onToast={onToast}
						sonarrUrl={sonarrUrl}
						sonarrKey={sonarrKey}
						radarrUrl={radarrUrl}
						radarrKey={radarrKey}
						onPlayPlex={onPlayPlex}
						onOpenShowDetail={openServerShowDetail}
					/>
				) : tab.id === 'watchlist' ? (
					<Watchlist
						sonarrUrl={sonarrUrl}
						sonarrKey={sonarrKey}
						radarrUrl={radarrUrl}
						radarrKey={radarrKey}
						active={active && zone === 'rows' && !showDetail}
						onExitLeft={() => setZone('sidebar')}
						onToast={onToast}
						enableDelete={enableDeleteActions}
						onOpenShowDetail={openWatchlistShowDetail}
					/>
				) : tab.id === 'downloads' ? (
					<Downloads
						sonarrUrl={sonarrUrl}
						sonarrKey={sonarrKey}
						radarrUrl={radarrUrl}
						radarrKey={radarrKey}
						active={active && zone === 'rows'}
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
												const focused = zone === 'rows' && ri === rowIdx && ci === (cols[ri] || 0);
												const p = posterUrlXL(item.poster);
												return (
													<div
														key={item.id}
														class={'cinema__card' + (focused ? ' cinema__card--focused' : '')}
														onMouseEnter={() => { setZone('rows'); setRowIdx(ri); setCols(function (prev) { return {...prev, [ri]: ci}; }); }}
													onClick={() => { setZone('rows'); setRowIdx(ri); setCols(function (prev) { return {...prev, [ri]: ci}; }); pushShowDetail(item); }}
													>
														<div class="cinema__poster-wrap">
															{p
																? <img class="cinema__poster" src={p} alt="" />
																: <div class="cinema__poster cinema__poster--empty" />}
															{plexIdx && plexIdx.has(item.mediaType, item.id) && <div class="plex-server-badge"><span class="plex-server-badge__icon">✓</span>Server</div>}
														</div>
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
				{rows.length === 0 && <div class="cinema__empty">No trending data — check your TMDB connection in Settings</div>}
				</>
				)}

				{/* Show Detail full-screen overlay */}
				{showDetail && (
					<ShowDetail
						show={showDetail}
						open={!!showDetail}
						active={active && !!(showDetail) && zone !== 'sidebar'}
						onClose={popShowDetail}
						onExitLeft={function () { setZone('sidebar'); }}
						onPlayPlex={onPlayPlex}
						onToast={onToast}
						onLaunch={onLaunch}
						apiKey={apiKey}
						allowShell={allowShell}
						plexUrl={plexUrl}
						plexToken={plexToken}
						plexIdx={plexIdx}
						installedAppIds={installedAppIds}
						isOnWatchlist={!!(showDetail && (showDetail.mediaType === 'movie' ? wlMovieIds.indexOf(showDetail.id) >= 0 : wlSeriesTitles.indexOf(showDetail.name.toLowerCase()) >= 0))}
						sonarrUrl={sonarrUrl}
						sonarrKey={sonarrKey}
						radarrUrl={radarrUrl}
						radarrKey={radarrKey}
						hasFetchbox={hasFetchbox}
						onSeedbox={hasFetchbox ? handleSeedbox : undefined}
						enableDeleteActions={enableDeleteActions}
						onWatchlistChanged={refreshWlStatus}
						onOpenDetail={pushShowDetail}
					/>
				)}
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
