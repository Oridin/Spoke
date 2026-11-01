import {useCallback, useEffect, useMemo, useRef, useState} from 'preact/hooks';
import {useKeys, clamp, type NavKey} from '../hooks/useKeys';
import {useOkPress} from '../hooks/useOkPress';
import {useKeyTrap} from '../hooks/useKeyTrap';
import {launchApp} from '../lib/launch';
import {
	fetchSections, fetchOnDeck, fetchRecentlyAdded, fetchSectionAll,
	fetchGenres, fetchSeasons, fetchEpisodes, plexSearch,
	plexPosterUrl, plexPosterUrlSmall, plexBackdropUrl, plexSortValue, safeError,
	type PlexSection, type PlexItem, type PlexGenre,
} from '../lib/plex';
import {getHiddenSections} from '../lib/pin';
import {enqueue, flush, imgReady, onImgReady, pruneQueue} from '../lib/imgqueue';
import {
	sonarrConn, radarrConn,
	sonarrGetSeries, radarrGetMovies,
	sonarrLookupByTitle, radarrLookupByTitle,
	watchlistAddSeries, watchlistAddMovie,
	countEpisodesByScope, sonarrGetEpisodes,
	downloadMovie, downloadSeriesPrep, downloadSeries, downloadSeriesListEpisodes,
	sonarrQueue, radarrQueue,
	type SonarrSeries, type RadarrMovie, type MonitorScope, type WatchlistAddResult,
	type DlSeasonInfo, type SonarrEpisode, type DownloadScope,
} from '../lib/arrapi';

interface Props {
	plexUrl: string;
	plexToken: string;
	active: boolean;
	showHidden: boolean;
	onExitLeft: () => void;
	onToast: (msg: string, kind?: 'info' | 'error') => void;
	sonarrUrl?: string;
	sonarrKey?: string;
	radarrUrl?: string;
	radarrKey?: string;
	onPlayPlex?: (ratingKey: string, title: string) => void;
}

type ServerZone = 'bar' | 'rows' | 'sort' | 'filter' | 'search' | 'detail';
type SortKey = 'recent' | 'title' | 'year' | 'rating';
type ViewMode = 'cinema' | 'compact' | 'grid';

interface GenreRow { genre: PlexGenre; items: PlexItem[]; page: number; totalSize: number; loading: boolean; }
interface ContentRow { title: string; items: PlexItem[]; isGrid: boolean; }
interface DetailState {
	item: PlexItem; level: 'info' | 'episodes' | 'monitor' | 'wl-confirm' | 'dl-scope' | 'dl-seasons' | 'dl-episodes' | 'dl-confirm'; btnIdx: number;
	seasons: PlexItem[]; episodes: PlexItem[]; seasonIdx: number; loading: boolean;
	wlScope?: MonitorScope;
	wlCounts?: {future: number; lastSeason: number; all: number; total: number} | null;
	dlCounts?: {lastSeason: number; all: number} | null;
	dlSeasons?: DlSeasonInfo[];
	dlEpisodes?: SonarrEpisode[];
	dlMode?: 'episode' | 'season';
	dlSeasonNumber?: number;
	dlPendingScope?: DownloadScope;
	dlPendingCount?: number;
	dlTvdbId?: number;
	dlTmdbId?: number;
}

var MONITOR_OPTS: {key: MonitorScope; label: string}[] = [
	{key: 'future', label: 'Future Episodes'},
	{key: 'lastSeason', label: 'Latest Season'},
	{key: 'all', label: 'All Episodes'},
	{key: 'none', label: 'None (Manual)'},
];

var PLEX_APP = 'cdp-30';
var CARD_W = 200;
var CARD_GAP = 20;
var CARD_STEP = CARD_W + CARD_GAP;
var VIEW_W = 1700;
var ROW_SCROLL = 420;
var HERO_DEBOUNCE = 250;
var SEARCH_DEBOUNCE = 400;
var MAX_GENRE_ROWS = 8;

var COMPACT_CARD_W = 140;
var COMPACT_CARD_GAP = 14;
var COMPACT_CARD_STEP = COMPACT_CARD_W + COMPACT_CARD_GAP;
var COMPACT_ROW_SCROLL = 280;

var GRID_V_COLS = 10;
var GRID_CINEMA_COLS = 7;

var VIEW_MODES: ViewMode[] = ['cinema', 'compact', 'grid'];
var VIEW_LABELS: Record<ViewMode, string> = {cinema: 'Cinema', compact: 'Compact', grid: 'Grid'};
var VIEW_KEY = 'spoke-view-mode';

function loadViewMode (): ViewMode {
	try { var v = localStorage.getItem(VIEW_KEY); if (v === 'compact' || v === 'grid') return v; } catch { /* */ }
	return 'cinema';
}
function saveViewMode (mode: ViewMode): void {
	try { localStorage.setItem(VIEW_KEY, mode); } catch { /* */ }
}

var ENQUEUE_COLS = 20;
var ENQUEUE_ROWS = 3;

var SORT_OPTIONS: {key: SortKey; label: string}[] = [
	{key: 'recent', label: 'Recently Added'},
	{key: 'title', label: 'Title'},
	{key: 'year', label: 'Year'},
	{key: 'rating', label: 'Rating'},
];

function cardTitle (item: PlexItem): string { return item.type === 'episode' ? (item.grandparentTitle || item.title) : item.title; }
function cardSub (item: PlexItem): string {
	if (item.type === 'episode') { var s = item.parentIndex != null ? 'S' + item.parentIndex : ''; var e = item.index != null ? 'E' + item.index : ''; return s + e || item.parentTitle || ''; }
	return item.year ? String(item.year) : '';
}
function cardThumb (item: PlexItem): string | undefined { return item.type === 'episode' ? (item.grandparentThumb || item.thumb) : item.thumb; }
function cardArt (item: PlexItem): string | undefined { return item.art || item.grandparentArt; }

export function MyServer ({plexUrl, plexToken, active, showHidden, onExitLeft, onToast, sonarrUrl, sonarrKey, radarrUrl, radarrKey, onPlayPlex}: Props) {
	var [allSections, setAllSections] = useState<PlexSection[]>([]);
	var [sectionIdx, setSectionIdx] = useState(0);
	var [zone, setZone] = useState<ServerZone>('rows');
	var [barIdx, setBarIdx] = useState(0);

	var [onDeckAll, setOnDeckAll] = useState<PlexItem[]>([]);
	var [recentItems, setRecentItems] = useState<PlexItem[]>([]);
	var [genreRows, setGenreRows] = useState<GenreRow[]>([]);
	var [genres, setGenres] = useState<PlexGenre[]>([]);
	var [loading, setLoading] = useState(true);
	var [error, setError] = useState<string | null>(null);

	var [sortKey, setSortKey] = useState<SortKey | null>(null);
	var [filterGenre, setFilterGenre] = useState<string | null>(null);
	var [unwatchedOnly, setUnwatchedOnly] = useState(false);
	var [sortPanelIdx, setSortPanelIdx] = useState(0);
	var [filterPanelIdx, setFilterPanelIdx] = useState(0);

	var [filteredItems, setFilteredItems] = useState<PlexItem[]>([]);
	var [filteredPage, setFilteredPage] = useState(0);
	var [filteredTotal, setFilteredTotal] = useState(0);
	var [filteredLoading, setFilteredLoading] = useState(false);

	var [searchQuery, setSearchQuery] = useState('');
	var [searchResults, setSearchResults] = useState<PlexItem[]>([]);
	var [searchIdx, setSearchIdx] = useState(0);
	var [searchTyping, setSearchTyping] = useState(false);
	var searchRef = useRef<HTMLInputElement>(null);
	var searchDebounceRef = useRef(0);

	var [rowIdx, setRowIdx] = useState(0);
	var [cols, setCols] = useState<Record<number, number>>({});

	var [detail, setDetail] = useState<DetailState | null>(null);

	var [heroItem, setHeroItem] = useState<PlexItem | null>(null);
	var [bdSlot, setBdSlot] = useState(0);
	var bdSlotRef = useRef(0);
	var [bdUrl0, setBdUrl0] = useState<string | null>(null);
	var [bdUrl1, setBdUrl1] = useState<string | null>(null);
	var debounceRef = useRef(0);
	var heroInitRef = useRef(false);
	var focusedItemRef = useRef<PlexItem | null>(null);

	var [imgTick, setImgTick] = useState(0);

	// --- hidden sections ---
	var hiddenKeys = useMemo(function () { return getHiddenSections(); }, []);
	var sections = useMemo(function () {
		if (showHidden) return allSections;
		return allSections.filter(function (s) { return hiddenKeys.indexOf(s.key) === -1; });
	}, [allSections, showHidden, hiddenKeys]);
	var onDeckItems = useMemo(function () {
		if (showHidden) return onDeckAll;
		return onDeckAll.filter(function (item) { return !item.librarySectionID || hiddenKeys.indexOf(item.librarySectionID) === -1; });
	}, [onDeckAll, showHidden, hiddenKeys]);

	var section = sections[sectionIdx] || null;
	var isFiltered = sortKey !== null || filterGenre !== null || unwatchedOnly;
	var hasActiveFilter = filterGenre !== null || unwatchedOnly;

	// --- view mode (global, shared across all sections) ---
	var [viewMode, setViewMode] = useState<ViewMode>(loadViewMode);
	var isCompact = viewMode === 'compact';
	var isGrid = viewMode === 'grid';
	var gridCols = isGrid ? GRID_V_COLS : GRID_CINEMA_COLS;

	// --- bar ---
	var barBtns = useMemo(function () {
		var btns: {id: string; label: string}[] = [{id: 'toggle', label: section ? section.title : 'Loading…'}];
		btns.push({id: 'view', label: 'View: ' + VIEW_LABELS[viewMode]});
		if (isFiltered) btns.push({id: 'clear', label: 'Clear'});
		var sortLabel = sortKey ? 'Sort: ' + ((SORT_OPTIONS.find(function (s) { return s.key === sortKey; }) || {label: ''}).label) : 'Sort';
		btns.push({id: 'sort', label: sortLabel});
		btns.push({id: 'filter', label: hasActiveFilter ? 'Filter (on)' : 'Filter'});
		btns.push({id: 'search', label: 'Search'});
		return btns;
	}, [section, viewMode, isFiltered, sortKey, hasActiveFilter]);

	// --- content rows ---
	var contentRows: ContentRow[] = useMemo(function () {
		if (isGrid && !isFiltered) {
			var seen: Record<string, boolean> = {};
			var all: PlexItem[] = [];
			var addItem = function (item: PlexItem) { if (!seen[item.ratingKey]) { seen[item.ratingKey] = true; all.push(item); } };
			for (var k = 0; k < onDeckItems.length; k++) addItem(onDeckItems[k]);
			for (var k2 = 0; k2 < recentItems.length; k2++) addItem(recentItems[k2]);
			for (var g = 0; g < genreRows.length; g++) for (var k3 = 0; k3 < genreRows[g].items.length; k3++) addItem(genreRows[g].items[k3]);
			var out: ContentRow[] = [];
			for (var i = 0; i < all.length; i += gridCols) out.push({title: i === 0 ? 'All Items' : '', items: all.slice(i, i + gridCols), isGrid: true});
			return out;
		}
		if (isFiltered) {
			if (filteredItems.length === 0) return [];
			var outF: ContentRow[] = [];
			for (var i2 = 0; i2 < filteredItems.length; i2 += gridCols) outF.push({title: i2 === 0 ? 'Results' : '', items: filteredItems.slice(i2, i2 + gridCols), isGrid: true});
			return outF;
		}
		var rows: ContentRow[] = [];
		if (onDeckItems.length > 0) rows.push({title: 'Continue Watching', items: onDeckItems, isGrid: false});
		if (recentItems.length > 0) rows.push({title: 'Recently Added', items: recentItems, isGrid: false});
		for (var g2 = 0; g2 < genreRows.length; g2++) { if (genreRows[g2].items.length > 0) rows.push({title: genreRows[g2].genre.title, items: genreRows[g2].items, isGrid: false}); }
		return rows;
	}, [isGrid, isFiltered, filteredItems, onDeckItems, recentItems, genreRows, gridCols]);

	var col = cols[rowIdx] || 0;
	var currentRow = contentRows[rowIdx];

	// --- focused item (for hero / info bar) ---
	var focusedItem: PlexItem | null = useMemo(function () {
		if (zone === 'rows' && currentRow) return currentRow.items[col] || currentRow.items[0] || null;
		if (contentRows.length > 0 && contentRows[0].items.length > 0) return contentRows[0].items[0];
		return null;
	}, [zone, currentRow, col, contentRows]);

	focusedItemRef.current = focusedItem;
	var focusedKey = focusedItem ? focusedItem.ratingKey : '';

	// --- filter panel items ---
	var filterPanelItems = useMemo(function () {
		return [
			{id: 'genre', label: 'Genre', value: filterGenre ? ((genres.find(function (g) { return g.key === filterGenre; }) || {title: 'Selected'}).title) : 'Any'},
			{id: 'unwatched', label: 'Unwatched Only', value: unwatchedOnly ? 'Yes' : 'All'},
		];
	}, [filterGenre, unwatchedOnly, genres]);

	var hasArr = !!(sonarrUrl && sonarrKey && radarrUrl && radarrKey);
	var sConn = useMemo(function () { return sonarrConn({sonarrUrl: sonarrUrl || '', sonarrKey: sonarrKey || ''}); }, [sonarrUrl, sonarrKey]);
	var rConn = useMemo(function () { return radarrConn({radarrUrl: radarrUrl || '', radarrKey: radarrKey || ''}); }, [radarrUrl, radarrKey]);

	// --- detail panel button count ---
	var detailBtnCount = useMemo(function () {
		if (!detail) return 0;
		if (detail.level === 'episodes') return detail.episodes.length;
		if (detail.level === 'monitor') return MONITOR_OPTS.length;
		if (detail.level === 'wl-confirm') return 2;
		if (detail.level === 'dl-scope') return 5;
		if (detail.level === 'dl-seasons') return (detail.dlSeasons ? detail.dlSeasons.length : 0) + 1;
		if (detail.level === 'dl-episodes') return (detail.dlEpisodes ? detail.dlEpisodes.length : 0) + 1;
		if (detail.level === 'dl-confirm') return 2;
		var count = 1;
		if (hasArr && (detail.item.type === 'show' || detail.item.type === 'movie')) count += 2;
		if (detail.item.type === 'show') count += detail.seasons.length;
		return count;
	}, [detail, hasArr]);

	// --- load sections + on-deck ---
	useEffect(function () {
		if (!plexUrl || !plexToken) { setLoading(false); setError('Plex not configured. Add your server in Settings → Connections'); return; }
		setLoading(true); setError(null);
		Promise.all([fetchSections(plexUrl, plexToken), fetchOnDeck(plexUrl, plexToken)])
			.then(function (results) {
				var secs = results[0]; var deck = results[1];
				if (secs.length === 0) { setError('No libraries found. Check Settings → Connections'); setLoading(false); return; }
				setAllSections(secs); setSectionIdx(0); setOnDeckAll(deck.items); setLoading(false);
			})
			.catch(function (e) { setError('Could not reach Plex server. ' + safeError(e, plexToken)); setLoading(false); });
	}, [plexUrl, plexToken]);

	// --- image queue callback ---
	useEffect(function () {
		onImgReady(function () { setImgTick(function (n) { return n + 1; }); });
	}, []);

	// --- enqueue nearby posters ---
	useEffect(function () {
		var keep = new Set<string>();
		for (var ri = 0; ri < contentRows.length; ri++) {
			var rowDist = Math.abs(ri - rowIdx);
			if (rowDist > ENQUEUE_ROWS) continue;
			var r = contentRows[ri];
			var fc = cols[ri] || 0;
			for (var ci = 0; ci < r.items.length; ci++) {
				var colDist = Math.abs(ci - fc);
				if (colDist > ENQUEUE_COLS) continue;
				var pUrl = posterUrl(r.items[ci]);
				if (!pUrl) continue;
				keep.add(pUrl);
				enqueue(pUrl, rowDist * 100 + colDist);
			}
		}
		pruneQueue(keep);
		flush();
	}, [rowIdx, cols, contentRows, viewMode, imgTick]);

	// --- load content for active section ---
	useEffect(function () {
		if (!section || !plexUrl || !plexToken) return;
		setRecentItems([]); setGenreRows([]); setRowIdx(0); setCols({});
		heroInitRef.current = false;
		fetchRecentlyAdded(plexUrl, plexToken, section.key, 0, 20)
			.then(function (page) { setRecentItems(page.items); })
			.catch(function () { onToast('Failed to load recently added', 'error'); });
		fetchGenres(plexUrl, plexToken, section.key)
			.then(function (g) {
				setGenres(g);
				var top = g.slice(0, MAX_GENRE_ROWS);
				return Promise.all(top.map(function (genre) {
					return fetchSectionAll(plexUrl, plexToken, section.key, 'addedAt:desc', genre.key, false, 0, 20)
						.then(function (page) { return {genre: genre, items: page.items, page: 0, totalSize: page.totalSize, loading: false} as GenreRow; })
						.catch(function () { return {genre: genre, items: [], page: 0, totalSize: 0, loading: false} as GenreRow; });
				}));
			})
			.then(function (rows) { setGenreRows(rows.filter(function (r) { return r.items.length > 0; })); })
			.catch(function () { });
	}, [section ? section.key : '', plexUrl, plexToken]);

	// --- filtered results ---
	useEffect(function () {
		if (!isFiltered || !section) { setFilteredItems([]); return; }
		setFilteredLoading(true); setRowIdx(0); setCols({});
		var sort = sortKey ? plexSortValue(sortKey) : 'addedAt:desc';
		fetchSectionAll(plexUrl, plexToken, section.key, sort, filterGenre || undefined, unwatchedOnly, 0, 20)
			.then(function (page) { setFilteredItems(page.items); setFilteredPage(0); setFilteredTotal(page.totalSize); setFilteredLoading(false); })
			.catch(function () { setFilteredItems([]); setFilteredLoading(false); onToast('Failed to load results', 'error'); });
	}, [isFiltered, sortKey, filterGenre, unwatchedOnly, section ? section.key : '', plexUrl, plexToken]);

	// --- hero crossfade (only in cinema mode) ---
	useEffect(function () {
		if (!focusedItem || viewMode !== 'cinema') return;
		var art = cardArt(focusedItem);
		var url = art ? plexBackdropUrl(plexUrl, plexToken, art) : null;
		if (!heroInitRef.current) {
			heroInitRef.current = true;
			setHeroItem(focusedItem); setBdUrl0(url); setBdSlot(0); bdSlotRef.current = 0;
			return;
		}
		window.clearTimeout(debounceRef.current);
		debounceRef.current = window.setTimeout(function () {
			var item = focusedItemRef.current;
			if (!item) return;
			setHeroItem(item);
			var a = cardArt(item);
			var u = a ? plexBackdropUrl(plexUrl, plexToken, a) : null;
			var next = bdSlotRef.current === 0 ? 1 : 0;
			if (next === 0) setBdUrl0(u); else setBdUrl1(u);
			setBdSlot(next); bdSlotRef.current = next;
		}, HERO_DEBOUNCE);
		return function () { window.clearTimeout(debounceRef.current); };
	}, [focusedKey, viewMode]);

	// --- search ---
	useEffect(function () {
		if (!searchQuery || searchQuery.length < 2 || !plexUrl || !plexToken) { setSearchResults([]); return; }
		window.clearTimeout(searchDebounceRef.current);
		searchDebounceRef.current = window.setTimeout(function () {
			plexSearch(plexUrl, plexToken, searchQuery)
				.then(function (items) { setSearchResults(items); setSearchIdx(0); })
				.catch(function () { setSearchResults([]); });
		}, SEARCH_DEBOUNCE);
		return function () { window.clearTimeout(searchDebounceRef.current); };
	}, [searchQuery, plexUrl, plexToken]);

	// --- load more ---
	var loadMoreForRow = useCallback(function (ri: number) {
		if (!section) return;
		var gr = genreRows[ri - (onDeckItems.length > 0 ? 2 : 1)];
		if (!gr || gr.loading || (gr.page + 1) * 20 >= gr.totalSize) return;
		var idx = ri - (onDeckItems.length > 0 ? 2 : 1);
		setGenreRows(function (prev) {
			return prev.map(function (r, i) { return i === idx ? {...r, loading: true} : r; });
		});
		fetchSectionAll(plexUrl, plexToken, section.key, 'addedAt:desc', gr.genre.key, false, (gr.page + 1) * 20, 20)
			.then(function (page) {
				setGenreRows(function (prev) { return prev.map(function (r, i) { return i === idx ? {...r, items: r.items.concat(page.items), page: r.page + 1, loading: false} : r; }); });
			})
			.catch(function () {
				setGenreRows(function (prev) { return prev.map(function (r, i) { return i === idx ? {...r, loading: false} : r; }); });
			});
	}, [genreRows, section, plexUrl, plexToken, onDeckItems.length]);

	var loadMoreFiltered = useCallback(function () {
		if (filteredLoading || !section || (filteredPage + 1) * 20 >= filteredTotal) return;
		setFilteredLoading(true);
		var sort = sortKey ? plexSortValue(sortKey) : 'addedAt:desc';
		fetchSectionAll(plexUrl, plexToken, section.key, sort, filterGenre || undefined, unwatchedOnly, (filteredPage + 1) * 20, 20)
			.then(function (page) { setFilteredItems(function (prev) { return prev.concat(page.items); }); setFilteredPage(function (p) { return p + 1; }); setFilteredLoading(false); })
			.catch(function () { setFilteredLoading(false); });
	}, [filteredLoading, filteredPage, filteredTotal, sortKey, filterGenre, unwatchedOnly, section, plexUrl, plexToken]);

	// --- actions ---
	var launchPlex = useCallback(function () {
		launchApp(PLEX_APP).catch(function () { onToast("Couldn't open Plex", 'error'); });
	}, [onToast]);

	var openDetail = useCallback(function (item: PlexItem) {
		var state: DetailState = {item: item, level: 'info', btnIdx: 0, seasons: [], episodes: [], seasonIdx: 0, loading: item.type === 'show'};
		setDetail(state); setZone('detail');
		if (item.type === 'show') {
			fetchSeasons(plexUrl, plexToken, item.ratingKey)
				.then(function (seasons) { setDetail(function (d) { return d ? {...d, seasons: seasons, loading: false} : null; }); })
				.catch(function () { setDetail(function (d) { return d ? {...d, loading: false} : null; }); onToast('Failed to load seasons', 'error'); });
		}
	}, [plexUrl, plexToken, onToast]);

	var cycleSection = useCallback(function () {
		if (sections.length < 2) return;
		var next = (sectionIdx + 1) % sections.length;
		setSectionIdx(next);
		setSortKey(null); setFilterGenre(null); setUnwatchedOnly(false);
	}, [sections, sectionIdx]);

	var cycleView = useCallback(function () {
		var cur = VIEW_MODES.indexOf(viewMode);
		var next = VIEW_MODES[(cur + 1) % VIEW_MODES.length];
		setViewMode(next);
		saveViewMode(next);
		setTimeout(function () { setRowIdx(0); setCols({}); }, 0);
	}, [viewMode]);

	var cycleFilterValue = useCallback(function (idx: number) {
		var item = filterPanelItems[idx];
		if (!item) return;
		if (item.id === 'genre') {
			var opts: (string | null)[] = [null];
			for (var i = 0; i < genres.length; i++) opts.push(genres[i].key);
			var cur = opts.indexOf(filterGenre);
			setFilterGenre(opts[(cur + 1) % opts.length]);
		} else if (item.id === 'unwatched') {
			setUnwatchedOnly(!unwatchedOnly);
		}
	}, [filterPanelItems, genres, filterGenre, unwatchedOnly]);

	// --- search input ---
	var onSearchKey = useCallback(function (e: KeyboardEvent) {
		if (e.keyCode === 13 || e.keyCode === 40) {
			e.preventDefault();
			if (searchResults.length > 0) { (e.target as HTMLInputElement).blur(); setSearchTyping(false); setSearchIdx(0); }
		} else if (e.keyCode === 461 || e.keyCode === 27) {
			e.preventDefault(); setZone('bar'); setSearchQuery(''); setSearchResults([]); setSearchTyping(false);
		}
	}, [searchResults]);

	var onSearchInput = useCallback(function (e: Event) { setSearchQuery((e.target as HTMLInputElement).value); }, []);

	// --- poster URL helper (smaller for compact/grid) ---
	function posterUrl (item: PlexItem): string | null {
		var thumb = cardThumb(item);
		if (viewMode === 'cinema') return plexPosterUrl(plexUrl, plexToken, thumb);
		return plexPosterUrlSmall(plexUrl, plexToken, thumb);
	}

	// --- watchlist actions ---
	var prepareShowMonitor = useCallback(function (item: PlexItem) {
		if (!hasArr) return;
		setDetail(function (d) { return d ? {...d, loading: true} : null; });
		sonarrLookupByTitle(sConn, item.title).then(function (results) {
			var match: SonarrSeries | null = null;
			for (var i = 0; i < results.length; i++) {
				if (results[i].year === item.year || (!item.year && results[i].title.toLowerCase() === item.title.toLowerCase())) { match = results[i]; break; }
			}
			if (!match && results.length > 0) match = results[0];
			if (!match) { onToast('Not found in Sonarr', 'error'); setDetail(function (d) { return d ? {...d, loading: false} : null; }); return; }
			return sonarrGetSeries(sConn).then(function (all) {
				var existing: SonarrSeries | null = null;
				for (var j = 0; j < all.length; j++) { if (all[j].tvdbId === match!.tvdbId) { existing = all[j]; break; } }
				if (existing) {
					return sonarrGetEpisodes(sConn, existing.id).then(function (eps) {
						var counts = countEpisodesByScope(eps);
						setDetail(function (d) { return d ? {...d, level: 'monitor', btnIdx: 0, loading: false, wlCounts: counts} : null; });
					});
				} else {
					setDetail(function (d) { return d ? {...d, level: 'monitor', btnIdx: 0, loading: false, wlCounts: null} : null; });
				}
			});
		}).catch(function (e) {
			onToast(e && e.message || 'Lookup failed', 'error');
			setDetail(function (d) { return d ? {...d, loading: false} : null; });
		});
	}, [hasArr, sConn, onToast]);

	var addPlexMovieToWatchlist = useCallback(function (item: PlexItem) {
		if (!hasArr) return;
		onToast('Adding ' + item.title + '…');
		setDetail(function (d) { return d ? {...d, loading: true} : null; });
		radarrLookupByTitle(rConn, item.title).then(function (results) {
			var match: RadarrMovie | null = null;
			for (var i = 0; i < results.length; i++) {
				if (results[i].year === item.year || (!item.year && results[i].title.toLowerCase() === item.title.toLowerCase())) { match = results[i]; break; }
			}
			if (!match && results.length > 0) match = results[0];
			if (!match) { onToast('Not found in Radarr', 'error'); setDetail(function (d) { return d ? {...d, loading: false} : null; }); return; }
			return radarrGetMovies(rConn).then(function (all) {
				var existing: RadarrMovie | null = null;
				for (var j = 0; j < all.length; j++) { if (all[j].tmdbId === match!.tmdbId) { existing = all[j]; break; } }
				return watchlistAddMovie(rConn, match!.tmdbId, existing);
			}).then(function (result: WatchlistAddResult) {
				onToast(result.title + ' added to watchlist');
				setDetail(null); setZone('rows');
			});
		}).catch(function (e) {
			onToast(e && e.message || 'Failed to add', 'error');
			setDetail(function (d) { return d ? {...d, loading: false} : null; });
		});
	}, [hasArr, rConn, onToast]);

	var addPlexShowToWatchlist = useCallback(function (item: PlexItem, scope: MonitorScope) {
		if (!hasArr) return;
		onToast('Adding ' + item.title + '…');
		setDetail(function (d) { return d ? {...d, loading: true} : null; });
		sonarrLookupByTitle(sConn, item.title).then(function (results) {
			var match: SonarrSeries | null = null;
			for (var i = 0; i < results.length; i++) {
				if (results[i].year === item.year || (!item.year && results[i].title.toLowerCase() === item.title.toLowerCase())) { match = results[i]; break; }
			}
			if (!match && results.length > 0) match = results[0];
			if (!match) { onToast('Not found in Sonarr', 'error'); setDetail(function (d) { return d ? {...d, loading: false} : null; }); return; }
			return sonarrGetSeries(sConn).then(function (all) {
				var existing: SonarrSeries | null = null;
				for (var j = 0; j < all.length; j++) { if (all[j].tvdbId === match!.tvdbId) { existing = all[j]; break; } }
				return watchlistAddSeries(sConn, match!.tvdbId, existing, scope);
			}).then(function (result: WatchlistAddResult) {
				var msg = result.monitoredCount >= 0
					? 'Monitoring ' + result.monitoredCount + ' episode' + (result.monitoredCount !== 1 ? 's' : '') + ' of ' + result.title
					: result.title + ' added to watchlist';
				onToast(msg);
				setDetail(null); setZone('rows');
			});
		}).catch(function (e) {
			onToast(e && e.message || 'Failed to add', 'error');
			setDetail(function (d) { return d ? {...d, loading: false} : null; });
		});
	}, [hasArr, sConn, onToast]);

	// --- download via arr ---

	var dlBusyRef = useRef(false);
	var dlPollRef = useRef(0);

	var startPlexDownload = useCallback(function () {
		if (!detail || !hasArr || dlBusyRef.current) return;
		var item = detail.item;
		if (item.type === 'movie') {
			dlBusyRef.current = true;
			setDetail(function (d) { return d ? {...d, loading: true} : null; });
			radarrLookupByTitle(rConn, item.title).then(function (results) {
				var match: RadarrMovie | null = null;
				for (var i = 0; i < results.length; i++) {
					if (results[i].year === item.year || (!item.year && results[i].title.toLowerCase() === item.title.toLowerCase())) { match = results[i]; break; }
				}
				if (!match && results.length > 0) match = results[0];
				if (!match) { onToast('Not found in Radarr', 'error'); setDetail(function (d) { return d ? {...d, loading: false} : null; }); dlBusyRef.current = false; return; }
				return downloadMovie(rConn, match.tmdbId).then(function (result) {
					if (result.alreadyHasFile) {
						onToast(result.title + ' is already downloaded');
						setDetail(null); setZone('rows');
						dlBusyRef.current = false;
						return;
					}
					if (result.qualityUpgraded) onToast('Quality upgraded to HD-1080p');
					onToast('Searching for ' + result.title + '…');
					setDetail(null); setZone('rows');
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
				});
			}).catch(function (e) {
				onToast(e && e.message || 'Download failed', 'error');
				setDetail(function (d) { return d ? {...d, loading: false} : null; });
				dlBusyRef.current = false;
			});
		} else if (item.type === 'show') {
			setDetail(function (d) { return d ? {...d, loading: true} : null; });
			sonarrLookupByTitle(sConn, item.title).then(function (results) {
				var match: SonarrSeries | null = null;
				for (var i = 0; i < results.length; i++) {
					if (results[i].year === item.year || (!item.year && results[i].title.toLowerCase() === item.title.toLowerCase())) { match = results[i]; break; }
				}
				if (!match && results.length > 0) match = results[0];
				if (!match) { onToast('Not found in Sonarr', 'error'); setDetail(function (d) { return d ? {...d, loading: false} : null; }); return; }
				return downloadSeriesPrep(sConn, {tvdbId: match.tvdbId}).then(function (prep) {
					setDetail(function (d) { return d ? {...d, level: 'dl-scope', btnIdx: 4, loading: false, dlCounts: prep, dlSeasons: prep.seasons, dlTvdbId: match!.tvdbId} : null; });
				});
			}).catch(function (e) {
				onToast(e && e.message || 'Lookup failed', 'error');
				setDetail(function (d) { return d ? {...d, loading: false} : null; });
			});
		}
	}, [detail, hasArr, sConn, rConn, onToast]);

	var executePlexDlScope = useCallback(function (scope: DownloadScope) {
		if (!detail || dlBusyRef.current || !detail.dlTvdbId) return;
		dlBusyRef.current = true;
		setDetail(function (d) { return d ? {...d, loading: true} : null; });
		downloadSeries(sConn, {tvdbId: detail.dlTvdbId}, scope)
			.then(function (result) {
				if (result.qualityUpgraded) onToast('Quality upgraded to HD-1080p');
				onToast('Monitoring ' + result.monitoredCount + ' episode' + (result.monitoredCount !== 1 ? 's' : '') + ' of ' + result.title);
				onToast('Searching…');
				setDetail(null); setZone('rows');
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
				setDetail(function (d) { return d ? {...d, loading: false} : null; });
				dlBusyRef.current = false;
			});
	}, [detail, sConn, onToast]);

	var selectPlexDlScope = useCallback(function (scope: DownloadScope, episodeCount: number) {
		if (episodeCount > 30) {
			setDetail(function (d) { return d ? {...d, level: 'dl-confirm', btnIdx: 0, dlPendingScope: scope, dlPendingCount: episodeCount} : null; });
			return;
		}
		executePlexDlScope(scope);
	}, [executePlexDlScope]);

	useEffect(function () {
		return function () { if (dlPollRef.current) window.clearInterval(dlPollRef.current); };
	}, []);

	var handleWlConfirmTrap = useCallback(function (e: KeyboardEvent) {
		if (!detail || detail.level !== 'wl-confirm') return;
		var code = e.keyCode;
		if (code === 461 || code === 27) {
			if (detail.item.type === 'show') setDetail({...detail, level: 'monitor', btnIdx: 0});
			else setDetail({...detail, level: 'info', btnIdx: 1});
			return;
		}
		if (code === 37 || code === 39) {
			setDetail(function (d) { return d ? {...d, btnIdx: d.btnIdx === 0 ? 1 : 0} : null; });
			return;
		}
		if (code === 13) {
			if (detail.btnIdx === 0) {
				if (detail.item.type === 'show') setDetail({...detail, level: 'monitor', btnIdx: 0});
				else setDetail({...detail, level: 'info', btnIdx: 1});
			} else {
				if (detail.wlScope && detail.item.type === 'show') addPlexShowToWatchlist(detail.item, detail.wlScope);
				else addPlexMovieToWatchlist(detail.item);
			}
		}
	}, [detail, addPlexMovieToWatchlist, addPlexShowToWatchlist]);

	useKeyTrap(handleWlConfirmTrap, active && !!detail && detail.level === 'wl-confirm');

	// --- keyboard ---
	var handleKey = useCallback(function (key: NavKey): boolean {
		if (zone === 'detail' && detail) {
			if (detail.loading) return true;
			if (key === 'back') {
				if (detail.level === 'episodes') { setDetail({...detail, level: 'info', btnIdx: detail.seasonIdx + 1, episodes: [], loading: false}); }
				else if (detail.level === 'wl-confirm') {
					if (detail.item.type === 'show') setDetail({...detail, level: 'monitor', btnIdx: 0});
					else setDetail({...detail, level: 'info', btnIdx: 1});
				}
				else if (detail.level === 'monitor') { setDetail({...detail, level: 'info', btnIdx: 1}); }
				else if (detail.level === 'dl-scope') { setDetail({...detail, level: 'info', btnIdx: 2}); }
				else if (detail.level === 'dl-seasons') { setDetail({...detail, level: 'dl-scope', btnIdx: detail.dlMode === 'episode' ? 0 : 1}); }
				else if (detail.level === 'dl-episodes') { setDetail({...detail, level: 'dl-seasons', btnIdx: 0, dlEpisodes: undefined}); }
				else if (detail.level === 'dl-confirm') { setDetail({...detail, level: 'dl-scope', btnIdx: 4}); }
				else { setDetail(null); setZone('rows'); }
				return true;
			}
			if (key === 'up') setDetail({...detail, btnIdx: Math.max(0, detail.btnIdx - 1)});
			else if (key === 'down') setDetail({...detail, btnIdx: Math.min(detailBtnCount - 1, detail.btnIdx + 1)});
			return true;
		}

		if (zone === 'search' && !searchTyping) {
			if (key === 'back') { setSearchTyping(true); setTimeout(function () { if (searchRef.current) searchRef.current.focus(); }, 50); return true; }
			if (key === 'up') { if (searchIdx > 0) setSearchIdx(searchIdx - 1); else { setSearchTyping(true); setTimeout(function () { if (searchRef.current) searchRef.current.focus(); }, 50); } }
			else if (key === 'down') setSearchIdx(Math.min(searchResults.length - 1, searchIdx + 1));
			return true;
		}

		if (zone === 'sort') {
			if (key === 'up') setSortPanelIdx(Math.max(0, sortPanelIdx - 1));
			else if (key === 'down') setSortPanelIdx(Math.min(SORT_OPTIONS.length - 1, sortPanelIdx + 1));
			else if (key === 'back' || key === 'left') setZone('bar');
			return true;
		}

		if (zone === 'filter') {
			if (key === 'up') setFilterPanelIdx(Math.max(0, filterPanelIdx - 1));
			else if (key === 'down') setFilterPanelIdx(Math.min(filterPanelItems.length - 1, filterPanelIdx + 1));
			else if (key === 'back' || key === 'left') setZone('bar');
			return true;
		}

		if (zone === 'bar') {
			if (key === 'left') { if (barIdx > 0) setBarIdx(barIdx - 1); else onExitLeft(); }
			else if (key === 'right') setBarIdx(Math.min(barBtns.length - 1, barIdx + 1));
			else if (key === 'down') { if (contentRows.length > 0) setZone('rows'); }
			else if (key === 'back') onExitLeft();
			return true;
		}

		if (zone === 'rows') {
			var c = cols[rowIdx] || 0;
			var r = contentRows[rowIdx];
			if (key === 'left') { if (c > 0) setCols(function (p) { return {...p, [rowIdx]: c - 1}; }); else onExitLeft(); }
			else if (key === 'right' && r) {
				var nc = clamp(c + 1, 0, r.items.length - 1);
				setCols(function (p) { return {...p, [rowIdx]: nc}; });
				if (!isFiltered && !isGrid && nc >= r.items.length - 4) loadMoreForRow(rowIdx);
			}
			else if (key === 'up') { if (rowIdx > 0) setRowIdx(rowIdx - 1); else setZone('bar'); }
			else if (key === 'down') {
				if (rowIdx < contentRows.length - 1) {
					setRowIdx(rowIdx + 1);
					if ((isFiltered || isGrid) && rowIdx >= contentRows.length - 3) loadMoreFiltered();
				}
			}
			else if (key === 'back') setZone('bar');
			return true;
		}

		return true;
	}, [zone, detail, detailBtnCount, searchTyping, searchIdx, searchResults, sortPanelIdx, filterPanelIdx, filterPanelItems, barIdx, barBtns, rowIdx, cols, contentRows, isFiltered, isGrid, onExitLeft, loadMoreForRow, loadMoreFiltered]);

	var keysActive = active && !(zone === 'search' && searchTyping);
	useKeys(handleKey, keysActive);

	useOkPress({
		onPress: function () {
			if (zone === 'detail' && detail) {
				if (detail.loading) return;
				if (detail.level === 'info') {
					if (detail.btnIdx === 0) {
						if (onPlayPlex) { onPlayPlex(detail.item.ratingKey, detail.item.title); setDetail(null); setZone('rows'); return; }
						launchPlex(); setDetail(null); setZone('rows'); return;
					}
					var hasArrBtns = hasArr && (detail.item.type === 'show' || detail.item.type === 'movie');
					if (hasArrBtns && detail.btnIdx === 1) {
						if (detail.item.type === 'show') {
							prepareShowMonitor(detail.item);
						} else {
							setDetail({...detail, level: 'wl-confirm', btnIdx: 0, wlScope: undefined, wlCounts: undefined});
						}
						return;
					}
					if (hasArrBtns && detail.btnIdx === 2) {
						startPlexDownload();
						return;
					}
					var seasonOffset = hasArrBtns ? 3 : 1;
					var season = detail.seasons[detail.btnIdx - seasonOffset];
					if (!season) return;
					setDetail({...detail, level: 'episodes', seasonIdx: detail.btnIdx - seasonOffset, btnIdx: 0, loading: true, episodes: []});
					fetchEpisodes(plexUrl, plexToken, season.ratingKey)
						.then(function (eps) { setDetail(function (d) { return d ? {...d, episodes: eps, loading: false} : null; }); })
						.catch(function () { setDetail(function (d) { return d ? {...d, loading: false} : null; }); onToast('Failed to load episodes', 'error'); });
					return;
				}
				if (detail.level === 'dl-scope') {
					if (detail.btnIdx === 0) {
						setDetail({...detail, level: 'dl-seasons', btnIdx: 0, dlMode: 'episode'});
					} else if (detail.btnIdx === 1) {
						setDetail({...detail, level: 'dl-seasons', btnIdx: 0, dlMode: 'season'});
					} else if (detail.btnIdx === 2) {
						selectPlexDlScope('lastSeason', detail.dlCounts ? detail.dlCounts.lastSeason : 0);
					} else if (detail.btnIdx === 3) {
						selectPlexDlScope('all', detail.dlCounts ? detail.dlCounts.all : 0);
					} else {
						setDetail({...detail, level: 'info', btnIdx: 2});
					}
					return;
				}
				if (detail.level === 'dl-seasons') {
					var dlSnArr = detail.dlSeasons || [];
					if (detail.btnIdx === dlSnArr.length) {
						setDetail({...detail, level: 'dl-scope', btnIdx: detail.dlMode === 'episode' ? 0 : 1});
					} else {
						var picked = dlSnArr[detail.btnIdx];
						if (!picked) return;
						if (detail.dlMode === 'season') {
							selectPlexDlScope({season: picked.number}, picked.count);
						} else {
							setDetail(function (d) { return d ? {...d, loading: true, dlSeasonNumber: picked.number, dlEpisodes: undefined} : null; });
							downloadSeriesListEpisodes(sConn, {tvdbId: detail.dlTvdbId!}, picked.number)
								.then(function (eps) {
									setDetail(function (d) { return d ? {...d, level: 'dl-episodes', btnIdx: 0, loading: false, dlEpisodes: eps} : null; });
								})
								.catch(function (e) {
									onToast(e && e.message || 'Failed to load episodes', 'error');
									setDetail(function (d) { return d ? {...d, level: 'dl-seasons', btnIdx: 0, loading: false} : null; });
								});
						}
					}
					return;
				}
				if (detail.level === 'dl-episodes') {
					var dlEpArr = detail.dlEpisodes || [];
					if (detail.btnIdx === dlEpArr.length) {
						setDetail({...detail, level: 'dl-seasons', btnIdx: 0, dlEpisodes: undefined});
					} else {
						var ep = dlEpArr[detail.btnIdx];
						if (ep) selectPlexDlScope({episode: ep.id}, 1);
					}
					return;
				}
				if (detail.level === 'dl-confirm') {
					if (detail.btnIdx === 0) {
						setDetail({...detail, level: 'dl-scope', btnIdx: 4});
					} else if (detail.dlPendingScope) {
						executePlexDlScope(detail.dlPendingScope);
					}
					return;
				}
				if (detail.level === 'monitor') {
					var mopt = MONITOR_OPTS[detail.btnIdx];
					if (mopt) {
						setDetail({...detail, level: 'wl-confirm', btnIdx: 0, wlScope: mopt.key, wlCounts: detail.wlCounts || undefined});
					}
					return;
				}
				if (detail.level === 'wl-confirm') {
					if (detail.btnIdx === 0) {
						if (detail.item.type === 'show') setDetail({...detail, level: 'monitor', btnIdx: 0});
						else setDetail({...detail, level: 'info', btnIdx: 1});
					} else {
						if (detail.wlScope && detail.item.type === 'show') addPlexShowToWatchlist(detail.item, detail.wlScope);
						else addPlexMovieToWatchlist(detail.item);
					}
					return;
				}
				if (detail.level === 'episodes') { launchPlex(); setDetail(null); setZone('rows'); return; }
				return;
			}
			if (zone === 'search' && !searchTyping) {
				var si = searchResults[searchIdx]; if (si) openDetail(si); return;
			}
			if (zone === 'sort') {
				var opt = SORT_OPTIONS[sortPanelIdx];
				if (opt) { setSortKey(opt.key === sortKey ? null : opt.key); setZone('bar'); } return;
			}
			if (zone === 'filter') { cycleFilterValue(filterPanelIdx); return; }
			if (zone === 'bar') {
				var btn = barBtns[barIdx]; if (!btn) return;
				if (btn.id === 'toggle') cycleSection();
				else if (btn.id === 'view') cycleView();
				else if (btn.id === 'clear') { setSortKey(null); setFilterGenre(null); setUnwatchedOnly(false); }
				else if (btn.id === 'sort') { setZone('sort'); setSortPanelIdx(sortKey ? Math.max(0, SORT_OPTIONS.findIndex(function (s) { return s.key === sortKey; })) : 0); }
				else if (btn.id === 'filter') { setZone('filter'); setFilterPanelIdx(0); }
				else if (btn.id === 'search') { setZone('search'); setSearchTyping(true); setSearchQuery(''); setSearchResults([]); setTimeout(function () { if (searchRef.current) searchRef.current.focus(); }, 100); }
				return;
			}
			if (zone === 'rows') {
				var row = contentRows[rowIdx]; if (!row) return;
				var item = row.items[cols[rowIdx] || 0]; if (item) openDetail(item);
				return;
			}
		},
		onLongPress: function () {}
	}, keysActive);

	// --- render ---
	if (!plexUrl || !plexToken || error) {
		return (<div class="browse"><div class="browse__empty">{error || 'Plex not configured. Add your server in Settings → Connections'}</div></div>);
	}
	if (loading && contentRows.length === 0) {
		return (<div class="browse"><div class="browse__empty">Loading…</div></div>);
	}

	var scrollStep = isCompact ? COMPACT_ROW_SCROLL : ROW_SCROLL;
	var rowScrollY = rowIdx > 0 ? rowIdx * scrollStep : 0;
	var cardStep = isCompact ? COMPACT_CARD_STEP : CARD_STEP;
	var cardW = isCompact ? COMPACT_CARD_W : CARD_W;

	return (
		<div class={'browse' + (isCompact ? ' browse--compact' : '') + (isGrid ? ' browse--grid' : '')}>
			{/* Hero (cinema only) */}
			{viewMode === 'cinema' && (
				<div class="cinema__hero">
					<div class="cinema__hero-bd" style={'background-image:' + (bdUrl0 ? 'url(' + bdUrl0 + ')' : 'none') + ';opacity:' + (bdSlot === 0 ? 1 : 0)} />
					<div class="cinema__hero-bd" style={'background-image:' + (bdUrl1 ? 'url(' + bdUrl1 + ')' : 'none') + ';opacity:' + (bdSlot === 1 ? 1 : 0)} />
					<div class="cinema__hero-scrim" />
					{heroItem && (
						<div class="cinema__hero-info">
							<h1 class="cinema__hero-title">{cardTitle(heroItem)}</h1>
							<div class="cinema__hero-meta">
								{heroItem.type === 'episode' && <span class="cinema__badge">{cardSub(heroItem)}</span>}
								{heroItem.year && heroItem.type !== 'episode' && <span class="cinema__badge">{heroItem.year}</span>}
								{heroItem.rating != null && heroItem.rating > 0 && <span class="cinema__badge">{heroItem.rating.toFixed(1)}</span>}
								<span class="cinema__badge">{heroItem.type === 'show' ? 'TV Show' : heroItem.type === 'episode' ? 'Episode' : 'Movie'}</span>
							</div>
							{heroItem.summary && <p class="cinema__hero-desc">{heroItem.summary.length > 200 ? heroItem.summary.slice(0, 200) + '…' : heroItem.summary}</p>}
						</div>
					)}
				</div>
			)}

			{/* Info bar (compact/grid: shows focused item info) */}
			{viewMode !== 'cinema' && focusedItem && (
				<div class="server-info-bar">
					<span class="server-info-bar__title">{cardTitle(focusedItem)}</span>
					{focusedItem.year && <span class="server-info-bar__year">{focusedItem.year}</span>}
					{focusedItem.rating != null && focusedItem.rating > 0 && <span class="server-info-bar__rating">{focusedItem.rating.toFixed(1)}</span>}
				</div>
			)}

			{/* Control bar */}
			<div class="browse__bar">
				{barBtns.map(function (btn, i) {
					return (<button key={btn.id} class={'browse__bar-btn' + (zone === 'bar' && i === barIdx ? ' browse__bar-btn--focused' : '') + (btn.id === 'clear' ? ' browse__bar-btn--clear' : '')}>{btn.label}</button>);
				})}
			</div>

			{/* Content */}
			<div class="browse__content">
				{!isFiltered && !isGrid && contentRows.length === 0 && !loading && <div class="browse__empty">No content in this library</div>}
				{filteredLoading && isFiltered && contentRows.length === 0 && <div class="browse__empty">Loading…</div>}
				{!filteredLoading && isFiltered && contentRows.length === 0 && <div class="browse__empty">No results — try different filters</div>}
				<div class="browse__rows-inner" style={'transform:translate3d(0,' + (-rowScrollY) + 'px,0)'}>
					{contentRows.map(function (r, ri) {
						var c = cols[ri] || 0;
						if (r.isGrid) {
							return (
								<div key={ri} class={'browse__grid-row' + (zone === 'rows' && ri === rowIdx ? ' browse__grid-row--active' : '')}>
									{r.title && <h2 class="cinema__row-title">{r.title}</h2>}
									<div class={'browse__grid-track' + (isGrid ? ' browse__grid-track--wide' : '')}>
										{r.items.map(function (item, ci) {
											var focused = zone === 'rows' && ri === rowIdx && ci === c && !detail;
											var pUrl = posterUrl(item);
											var ready = pUrl && imgReady(pUrl);
											return (
												<div key={item.ratingKey} class={'cinema__card' + (focused ? ' cinema__card--focused' : '')}>
													{ready ? <img class="cinema__poster cinema__poster--queued cinema__poster--ready" src={pUrl!} alt="" /> : <div class="cinema__poster cinema__poster--empty" />}
													{item.viewCount != null && item.viewCount > 0 && <div class="plex-watched" />}
													{item.viewOffset != null && item.viewOffset > 0 && item.duration != null && item.duration > 0 && (
														<div class="plex-progress"><div class="plex-progress-fill" style={'width:' + Math.round(item.viewOffset / item.duration * 100) + '%'} /></div>
													)}
													<div class="cinema__card-title">{cardTitle(item)}</div>
													<div class="cinema__card-year">{cardSub(item)}</div>
												</div>
											);
										})}
									</div>
								</div>
							);
						}
						var total = r.items.length * cardStep;
						var fits = total <= VIEW_W;
						var off = fits ? 0 : clamp(c * cardStep + cardW / 2 - VIEW_W / 2, 0, Math.max(0, total - VIEW_W));
						return (
							<div key={ri} class={'cinema__row' + (zone === 'rows' && ri === rowIdx ? ' cinema__row--active' : '')}>
								<h2 class="cinema__row-title">{r.title}</h2>
								<div class="cinema__row-viewport">
									<div class="cinema__row-track" style={'transform:translate3d(' + (-off) + 'px,0,0)'}>
										{r.items.map(function (item, ci) {
											var focused = zone === 'rows' && ri === rowIdx && ci === (cols[ri] || 0) && !detail;
											var pUrl = posterUrl(item);
											var ready = pUrl && imgReady(pUrl);
											return (
												<div key={item.ratingKey} class={'cinema__card' + (focused ? ' cinema__card--focused' : '')}>
													{ready ? <img class="cinema__poster cinema__poster--queued cinema__poster--ready" src={pUrl!} alt="" /> : <div class="cinema__poster cinema__poster--empty" />}
													{item.viewCount != null && item.viewCount > 0 && <div class="plex-watched" />}
													{item.viewOffset != null && item.viewOffset > 0 && item.duration != null && item.duration > 0 && (
														<div class="plex-progress"><div class="plex-progress-fill" style={'width:' + Math.round(item.viewOffset / item.duration * 100) + '%'} /></div>
													)}
													<div class="cinema__card-title">{cardTitle(item)}</div>
													<div class="cinema__card-year">{cardSub(item)}</div>
												</div>
											);
										})}
									</div>
								</div>
							</div>
						);
					})}
				</div>
				{(isFiltered || isGrid) && filteredLoading && contentRows.length > 0 && <div class="browse__loading-more">Loading more…</div>}
			</div>

			{/* Sort panel */}
			{zone === 'sort' && (
				<>
					<div class="browse__panel-scrim" />
					<div class="browse__side-panel">
						<div class="cinema__panel-content">
							<h2 class="cinema__panel-title">Sort By</h2>
							{SORT_OPTIONS.map(function (opt, i) {
								return (<button key={opt.key} class={'cinema__panel-btn' + (i === sortPanelIdx ? ' cinema__panel-btn--focused' : '') + (opt.key === sortKey ? ' browse__active-opt' : '')}>{opt.label}{opt.key === sortKey ? ' (active)' : ''}</button>);
							})}
						</div>
					</div>
				</>
			)}

			{/* Filter panel */}
			{zone === 'filter' && (
				<>
					<div class="browse__panel-scrim" />
					<div class="browse__side-panel">
						<div class="cinema__panel-content">
							<h2 class="cinema__panel-title">Filter</h2>
							<p class="cinema__panel-sub">OK cycles values</p>
							{filterPanelItems.map(function (fi, i) {
								return (<button key={fi.id} class={'cinema__panel-btn browse__filter-btn' + (i === filterPanelIdx ? ' cinema__panel-btn--focused' : '')}>
									<span class="browse__filter-label">{fi.label}</span>
									<span class="browse__filter-value">{fi.value}</span>
								</button>);
							})}
						</div>
					</div>
				</>
			)}

			{/* Search overlay */}
			{zone === 'search' && (
				<div class="browse__search-overlay">
					<input ref={searchRef} class="browse__search-input" type="text" placeholder={'Search ' + (section ? section.title : 'library') + '…'} value={searchQuery} onInput={onSearchInput} onKeyDown={onSearchKey} />
					<div class="browse__search-results">
						{searchResults.length === 0 && searchQuery.length >= 2 && <div class="browse__search-empty">No results found</div>}
						{searchResults.map(function (item, i) {
							var focused = !searchTyping && i === searchIdx;
							var pUrl = plexPosterUrl(plexUrl, plexToken, cardThumb(item));
							return (
								<div key={item.ratingKey} class={'browse__search-item' + (focused ? ' browse__search-item--focused' : '')}>
									{pUrl ? <img class="browse__search-poster" src={pUrl} alt="" /> : <div class="browse__search-poster browse__search-poster--empty" />}
									<div class="browse__search-info">
										<div class="browse__search-name">{cardTitle(item)}</div>
										<div class="browse__search-meta">{cardSub(item)}{item.rating != null && item.rating > 0 ? ' · ' + item.rating.toFixed(1) : ''}{' · '}{item.type === 'show' ? 'TV Show' : 'Movie'}</div>
									</div>
								</div>
							);
						})}
					</div>
				</div>
			)}

			{/* Detail panel */}
			<div class={'cinema__scrim' + (detail ? ' cinema__scrim--active' : '')} />
			<div class={'cinema__panel' + (detail ? ' cinema__panel--open' : '')}>
				{detail && detail.level === 'info' && (
					<div class="cinema__panel-content">
						<h2 class="cinema__panel-title">{detail.item.title}</h2>
						<p class="cinema__panel-sub">
							{detail.item.year ? detail.item.year : ''}{detail.item.rating != null && detail.item.rating > 0 ? ' · ' + detail.item.rating.toFixed(1) : ''}
							{' · '}{detail.item.type === 'show' ? 'TV Show' : detail.item.type === 'episode' ? 'Episode' : 'Movie'}
						</p>
						<button class={'cinema__panel-btn' + (detail.btnIdx === 0 ? ' cinema__panel-btn--focused' : '')}>
							<span class="cinema__panel-btn-icon">{'▶'}</span>{onPlayPlex ? 'Play' : 'Play on Plex'}
						</button>
						{hasArr && (detail.item.type === 'show' || detail.item.type === 'movie') && (
							<button class={'cinema__panel-btn' + (detail.btnIdx === 1 ? ' cinema__panel-btn--focused' : '')}>
								<span class="cinema__panel-btn-icon">{'+'}</span>Add to Watchlist
							</button>
						)}
						{hasArr && (detail.item.type === 'show' || detail.item.type === 'movie') && (
							<button class={'cinema__panel-btn' + (detail.btnIdx === 2 ? ' cinema__panel-btn--focused' : '')}>
								<span class="cinema__panel-btn-icon">{'↓'}</span>Download
							</button>
						)}
						{detail.item.summary && <p class="plex-detail-summary">{detail.item.summary}</p>}
						{detail.loading && <div class="cinema__panel-loading">Loading…</div>}
						{(function () {
							var seasonOffset = hasArr && (detail!.item.type === 'show' || detail!.item.type === 'movie') ? 3 : 1;
							return detail!.seasons.map(function (s, i) {
								var focused = detail!.btnIdx === i + seasonOffset;
								var watched = s.viewedLeafCount != null && s.leafCount != null && s.viewedLeafCount >= s.leafCount && s.leafCount > 0;
								return (
									<button key={s.ratingKey} class={'cinema__panel-btn' + (focused ? ' cinema__panel-btn--focused' : '')}>
										{s.title}{s.leafCount ? ' (' + s.leafCount + ' episodes)' : ''}
										{watched ? ' ✓' : s.viewedLeafCount != null && s.viewedLeafCount > 0 ? ' (' + s.viewedLeafCount + '/' + s.leafCount + ')' : ''}
									</button>
								);
							});
						})()}
					</div>
				)}
				{detail && detail.level === 'monitor' && (
					<div class="cinema__panel-content">
						<h2 class="cinema__panel-title">{detail.item.title}</h2>
						<p class="cinema__panel-sub">Which episodes should be monitored?</p>
						{MONITOR_OPTS.map(function (opt, i) {
							var focused = detail!.btnIdx === i;
							var cnt = detail!.wlCounts ? (opt.key === 'future' ? detail!.wlCounts.future : opt.key === 'lastSeason' ? detail!.wlCounts.lastSeason : detail!.wlCounts.all) : null;
							return (
								<button key={opt.key} class={'cinema__panel-btn' + (focused ? ' cinema__panel-btn--focused' : '')}>
									{opt.label}{cnt != null ? ' (' + cnt + ' episode' + (cnt !== 1 ? 's' : '') + ')' : ''}
								</button>
							);
						})}
						<p class="cinema__panel-note">Monitored episodes are picked up by RSS sync. New matching releases may download automatically.</p>
					</div>
				)}
				{detail && detail.level === 'episodes' && (
					<div class="cinema__panel-content">
						<div class="cinema__panel-back">{'← ' + (detail.seasons[detail.seasonIdx] ? detail.seasons[detail.seasonIdx].title : 'Back')}</div>
						<h2 class="cinema__panel-title">{detail.seasons[detail.seasonIdx] ? detail.seasons[detail.seasonIdx].title : 'Episodes'}</h2>
						{detail.loading && <div class="cinema__panel-loading">Loading episodes…</div>}
						{detail.episodes.map(function (ep, i) {
							var focused = detail!.btnIdx === i;
							var watched = ep.viewCount != null && ep.viewCount > 0;
							var progress = ep.viewOffset != null && ep.viewOffset > 0 && ep.duration != null && ep.duration > 0 ? Math.round(ep.viewOffset / ep.duration * 100) : 0;
							return (
								<button key={ep.ratingKey} class={'cinema__panel-btn' + (focused ? ' cinema__panel-btn--focused' : '')}>
									{'E' + (ep.index != null ? ep.index : i + 1) + ' — ' + ep.title}
									{watched ? ' ✓' : progress > 0 ? ' (' + progress + '%)' : ''}
								</button>
							);
						})}
					</div>
				)}
				{detail && detail.level === 'wl-confirm' && (
					<div class="cinema__panel-content watchlist__confirm">
						<h2 class="cinema__panel-title">Add to Watchlist?</h2>
						<div class="watchlist__confirm-warn">
							<p><strong>{detail.item.title}</strong></p>
							{detail.wlScope && detail.wlCounts && (function () {
								var n = detail!.wlScope === 'future' ? detail!.wlCounts!.future : detail!.wlScope === 'lastSeason' ? detail!.wlCounts!.lastSeason : detail!.wlCounts!.all;
								return detail!.wlScope !== 'none' ? <p>{n + ' episode' + (n !== 1 ? 's' : '') + ' will be monitored'}</p> : null;
							})()}
							{!detail.wlScope && <p>Movie will be monitored</p>}
							<p class="cinema__panel-note">Monitored titles are picked up by RSS sync. New matching releases may download automatically.</p>
						</div>
						<div class="watchlist__confirm-btns">
							<button class={'cinema__panel-btn' + (detail.btnIdx === 0 ? ' cinema__panel-btn--focused' : '')}>Cancel</button>
							<button class={'cinema__panel-btn' + (detail.btnIdx === 1 ? ' cinema__panel-btn--focused' : '')}>Add</button>
						</div>
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
			</div>
		</div>
	);
}
