import {useCallback, useEffect, useMemo, useRef, useState} from 'preact/hooks';
import {useKeys, clamp, type NavKey} from '../hooks/useKeys';
import {useOkPress} from '../hooks/useOkPress';
import {backdropUrl, posterUrlXL, yearOf, type TrendingShow, type ShowProvider, type MediaType} from '../lib/trending';
import {fetchGenres, fetchDiscover, fetchSearchResults, attachItemProviders, sortApiValue, type Genre, type DiscoverParams} from '../lib/tmdb';
import type {PlexIndex} from '../lib/plex';

interface Props {
	apiKey: string;
	allowShell: boolean;
	active: boolean;
	providerIds: number[];
	onOpenPanel: (item: TrendingShow) => void;
	onExitLeft: () => void;
	onExitDown?: () => void;
	onToast: (msg: string, kind?: 'info' | 'error') => void;
	plexIdx?: PlexIndex | null;
}

type BrowseZone = 'bar' | 'rows' | 'sort' | 'filter' | 'search';
type SortKey = 'popular' | 'top_rated' | 'newest';

interface GenreRow {
	genre: Genre;
	items: TrendingShow[];
	page: number;
	totalPages: number;
	loading: boolean;
}

interface FilterState {
	myServices: boolean;
	genreId: number | null;
	minRating: number | null;
	decade: number | null;
}

interface ContentRow {
	title: string;
	items: TrendingShow[];
	isGrid: boolean;
}

const INITIAL_FILTERS: FilterState = {myServices: false, genreId: null, minRating: null, decade: null};

const CARD_W = 200;
const CARD_GAP = 20;
const CARD_STEP = CARD_W + CARD_GAP;
const VIEW_W = 1700;
const GRID_COLS = 7;
const ROW_SCROLL = 460;
const HERO_DEBOUNCE = 250;
const SEARCH_DEBOUNCE = 400;
const MAX_GENRE_ROWS = 8;
const DECADES = [2020, 2010, 2000, 1990, 1980, 1970];

const SORT_OPTIONS: {key: SortKey; label: string}[] = [
	{key: 'popular', label: 'Popular'},
	{key: 'top_rated', label: 'Top Rated'},
	{key: 'newest', label: 'Newest'},
];

export function Browse ({apiKey, allowShell, active, providerIds, onOpenPanel, onExitLeft, onExitDown, onToast, plexIdx}: Props) {
	const [mediaType, setMediaType] = useState<MediaType>('movie');
	const [zone, setZone] = useState<BrowseZone>('rows');
	const [barIdx, setBarIdx] = useState(0);

	const [genres, setGenres] = useState<Genre[]>([]);
	const [genreRows, setGenreRows] = useState<GenreRow[]>([]);
	const [genresLoading, setGenresLoading] = useState(false);

	const [sortKey, setSortKey] = useState<SortKey | null>(null);
	const [filters, setFilters] = useState<FilterState>(INITIAL_FILTERS);
	const [sortPanelIdx, setSortPanelIdx] = useState(0);
	const [filterPanelIdx, setFilterPanelIdx] = useState(0);

	const [filteredItems, setFilteredItems] = useState<TrendingShow[]>([]);
	const [filteredPage, setFilteredPage] = useState(1);
	const [filteredTotalPages, setFilteredTotalPages] = useState(0);
	const [filteredLoading, setFilteredLoading] = useState(false);

	const [searchQuery, setSearchQuery] = useState('');
	const [searchResults, setSearchResults] = useState<TrendingShow[]>([]);
	const [searchIdx, setSearchIdx] = useState(0);
	const [searchTyping, setSearchTyping] = useState(false);
	const searchRef = useRef<HTMLInputElement>(null);
	const searchDebounceRef = useRef(0);

	const [rowIdx, setRowIdx] = useState(0);
	const [cols, setCols] = useState<Record<number, number>>({});

	const [heroItem, setHeroItem] = useState<TrendingShow | null>(null);
	const [bdSlot, setBdSlot] = useState(0);
	const bdSlotRef = useRef(0);
	const [bdUrl0, setBdUrl0] = useState<string | null>(null);
	const [bdUrl1, setBdUrl1] = useState<string | null>(null);
	const debounceRef = useRef(0);
	const heroInitRef = useRef(false);
	const focusedItemRef = useRef<TrendingShow | null>(null);

	const providersCache = useRef<Map<number, ShowProvider[]>>(new Map());

	const isFiltered = sortKey !== null || filters.myServices || filters.genreId !== null || filters.minRating !== null || filters.decade !== null;
	const hasActiveFilter = filters.myServices || filters.genreId !== null || filters.minRating !== null || filters.decade !== null;

	const barBtns = useMemo(function () {
		var btns: {id: string; label: string}[] = [
			{id: 'toggle', label: mediaType === 'movie' ? 'Movies' : 'TV Shows'},
		];
		if (isFiltered) btns.push({id: 'clear', label: 'Clear'});
		var sortLabel = sortKey ? 'Sort: ' + ((SORT_OPTIONS.find(function (s) { return s.key === sortKey; }) || {label: ''}).label) : 'Sort';
		btns.push({id: 'sort', label: sortLabel});
		btns.push({id: 'filter', label: hasActiveFilter ? 'Filter (on)' : 'Filter'});
		btns.push({id: 'search', label: 'Search'});
		return btns;
	}, [mediaType, isFiltered, sortKey, hasActiveFilter]);

	const contentRows: ContentRow[] = useMemo(function () {
		if (isFiltered) {
			if (filteredItems.length === 0) return [];
			var rows: ContentRow[] = [];
			for (var i = 0; i < filteredItems.length; i += GRID_COLS) {
				rows.push({title: i === 0 ? 'Results' : '', items: filteredItems.slice(i, i + GRID_COLS), isGrid: true});
			}
			return rows;
		}
		return genreRows.map(function (gr) { return {title: gr.genre.name, items: gr.items, isGrid: false}; });
	}, [isFiltered, filteredItems, genreRows]);

	var col = cols[rowIdx] || 0;
	var currentRow = contentRows[rowIdx];

	var focusedItem: TrendingShow | null = useMemo(function () {
		if (zone === 'rows' && currentRow) return currentRow.items[col] || currentRow.items[0] || null;
		if (contentRows.length > 0 && contentRows[0].items.length > 0) return contentRows[0].items[0];
		return null;
	}, [zone, currentRow, col, contentRows]);

	focusedItemRef.current = focusedItem;
	var focusedId = focusedItem ? focusedItem.id : -1;

	// --- effects ---

	useEffect(function () {
		setGenreRows([]);
		setRowIdx(0);
		setCols({});
		setGenresLoading(true);
		heroInitRef.current = false;
		fetchGenres(mediaType, apiKey, allowShell)
			.then(function (g) {
				setGenres(g);
				var top = g.slice(0, MAX_GENRE_ROWS);
				return Promise.all(top.map(function (genre) {
					return fetchDiscover(mediaType, apiKey, {genreId: genre.id, sortBy: 'popularity.desc', page: 1}, allowShell)
						.then(function (result) { return {genre: genre, items: result.items, page: 1, totalPages: result.totalPages, loading: false} as GenreRow; })
						.catch(function () { return {genre: genre, items: [], page: 1, totalPages: 0, loading: false} as GenreRow; });
				}));
			})
			.then(function (rows) {
				setGenreRows(rows.filter(function (r) { return r.items.length > 0; }));
				setGenresLoading(false);
			})
			.catch(function () {
				setGenresLoading(false);
				onToast('Failed to load genres', 'error');
			});
	}, [mediaType, apiKey]);

	useEffect(function () {
		if (!isFiltered) { setFilteredItems([]); return; }
		setFilteredLoading(true);
		setRowIdx(0);
		setCols({});
		var params: DiscoverParams = {sortBy: sortKey ? sortApiValue(sortKey, mediaType) : 'popularity.desc', page: 1};
		if (sortKey === 'top_rated') params.minVotes = 200;
		if (filters.myServices && providerIds.length > 0) params.providers = providerIds.join('|');
		if (filters.genreId) params.genreId = filters.genreId;
		if (filters.minRating) params.minRating = filters.minRating;
		if (filters.decade) params.decadeStart = filters.decade;
		fetchDiscover(mediaType, apiKey, params, allowShell)
			.then(function (result) {
				setFilteredItems(result.items);
				setFilteredPage(1);
				setFilteredTotalPages(result.totalPages);
				setFilteredLoading(false);
			})
			.catch(function () {
				setFilteredItems([]);
				setFilteredLoading(false);
				onToast('Failed to load results', 'error');
			});
	}, [isFiltered, sortKey, filters, mediaType, apiKey, providerIds]);

	useEffect(function () {
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
		return function () { window.clearTimeout(debounceRef.current); };
	}, [focusedId]);

	useEffect(function () {
		if (zone !== 'rows') return;
		var r = currentRow;
		if (!r) return;
		for (var d = -1; d <= 2; d++) {
			var item = r.items[col + d];
			if (item && item.backdrop) { var img = new Image(); img.src = backdropUrl(item.backdrop) || ''; }
		}
	}, [zone, rowIdx, col]);

	useEffect(function () {
		if (!focusedItem || providersCache.current.has(focusedItem.id)) return;
		attachItemProviders([focusedItem], apiKey, allowShell).then(function (enriched) {
			if (enriched[0]) providersCache.current.set(enriched[0].id, enriched[0].providers);
		}).catch(function () {});
	}, [focusedId, apiKey]);

	useEffect(function () {
		if (!searchQuery || searchQuery.length < 2) { setSearchResults([]); return; }
		window.clearTimeout(searchDebounceRef.current);
		searchDebounceRef.current = window.setTimeout(function () {
			fetchSearchResults(mediaType, apiKey, searchQuery, 1, allowShell)
				.then(function (result) { setSearchResults(result.items); setSearchIdx(0); })
				.catch(function () { setSearchResults([]); });
		}, SEARCH_DEBOUNCE);
		return function () { window.clearTimeout(searchDebounceRef.current); };
	}, [searchQuery, mediaType, apiKey]);

	// --- load more ---

	var loadMoreForRow = useCallback(function (ri: number) {
		setGenreRows(function (prev) {
			var row = prev[ri];
			if (!row || row.loading || row.page >= row.totalPages) return prev;
			var next = prev.map(function (r, i) { return i === ri ? {...r, loading: true} : r; });
			fetchDiscover(mediaType, apiKey, {genreId: row.genre.id, sortBy: 'popularity.desc', page: row.page + 1}, allowShell)
				.then(function (result) {
					setGenreRows(function (p) { return p.map(function (r, i) {
						return i === ri ? {...r, items: r.items.concat(result.items), page: r.page + 1, loading: false} : r;
					}); });
				})
				.catch(function () {
					setGenreRows(function (p) { return p.map(function (r, i) { return i === ri ? {...r, loading: false} : r; }); });
				});
			return next;
		});
	}, [mediaType, apiKey, allowShell]);

	var loadMoreFiltered = useCallback(function () {
		if (filteredLoading || filteredPage >= filteredTotalPages) return;
		setFilteredLoading(true);
		var params: DiscoverParams = {sortBy: sortKey ? sortApiValue(sortKey, mediaType) : 'popularity.desc', page: filteredPage + 1};
		if (sortKey === 'top_rated') params.minVotes = 200;
		if (filters.myServices && providerIds.length > 0) params.providers = providerIds.join('|');
		if (filters.genreId) params.genreId = filters.genreId;
		if (filters.minRating) params.minRating = filters.minRating;
		if (filters.decade) params.decadeStart = filters.decade;
		fetchDiscover(mediaType, apiKey, params, allowShell)
			.then(function (result) {
				setFilteredItems(function (prev) { return prev.concat(result.items); });
				setFilteredPage(function (p) { return p + 1; });
				setFilteredLoading(false);
			})
			.catch(function () { setFilteredLoading(false); });
	}, [filteredLoading, filteredPage, filteredTotalPages, sortKey, filters, mediaType, apiKey, providerIds, allowShell]);

	var handleOpenPanel = useCallback(function (item: TrendingShow) {
		var cached = providersCache.current.get(item.id);
		onOpenPanel(cached ? {...item, providers: cached} : item);
	}, [onOpenPanel]);

	// --- filter items for the panel ---

	var filterPanelItems = useMemo(function () {
		return [
			{id: 'services', label: 'Services', value: filters.myServices ? 'My Services' : 'All'},
			{id: 'genre', label: 'Genre', value: filters.genreId ? ((genres.find(function (g) { return g.id === filters.genreId; }) || {name: 'Selected'}).name || 'Selected') : 'Any'},
			{id: 'rating', label: 'Min Rating', value: filters.minRating ? filters.minRating + '+' : 'Any'},
			{id: 'era', label: 'Era', value: filters.decade ? filters.decade + 's' : 'Any'},
		];
	}, [filters, genres]);

	var cycleFilterValue = useCallback(function (idx: number) {
		var item = filterPanelItems[idx];
		if (!item) return;
		setFilters(function (prev) {
			if (item.id === 'services') return {...prev, myServices: !prev.myServices};
			if (item.id === 'genre') {
				var options: (number | null)[] = [null];
				for (var i = 0; i < genres.length; i++) options.push(genres[i].id);
				var cur = options.indexOf(prev.genreId);
				return {...prev, genreId: options[(cur + 1) % options.length]};
			}
			if (item.id === 'rating') {
				var rOpts: (number | null)[] = [null, 5, 6, 7, 8];
				var curR = rOpts.indexOf(prev.minRating);
				return {...prev, minRating: rOpts[(curR + 1) % rOpts.length]};
			}
			if (item.id === 'era') {
				var eOpts: (number | null)[] = [null];
				for (var d = 0; d < DECADES.length; d++) eOpts.push(DECADES[d]);
				var curE = eOpts.indexOf(prev.decade);
				return {...prev, decade: eOpts[(curE + 1) % eOpts.length]};
			}
			return prev;
		});
	}, [filterPanelItems, genres]);

	// --- search input ---

	var onSearchKey = useCallback(function (e: KeyboardEvent) {
		if (e.keyCode === 13 || e.keyCode === 40) {
			e.preventDefault();
			if (searchResults.length > 0) {
				(e.target as HTMLInputElement).blur();
				setSearchTyping(false);
				setSearchIdx(0);
			}
		} else if (e.keyCode === 461 || e.keyCode === 27) {
			e.preventDefault();
			setZone('bar');
			setSearchQuery('');
			setSearchResults([]);
			setSearchTyping(false);
		}
	}, [searchResults]);

	var onSearchInput = useCallback(function (e: Event) {
		setSearchQuery((e.target as HTMLInputElement).value);
	}, []);

	// --- keyboard ---

	var handleKey = useCallback(function (key: NavKey): boolean {
		if (zone === 'search' && !searchTyping) {
			if (key === 'back') {
				setSearchTyping(true);
				setTimeout(function () { if (searchRef.current) searchRef.current.focus(); }, 50);
				return true;
			}
			if (key === 'up') {
				if (searchIdx > 0) setSearchIdx(searchIdx - 1);
				else { setSearchTyping(true); setTimeout(function () { if (searchRef.current) searchRef.current.focus(); }, 50); }
			}
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
			if (key === 'left') {
				if (barIdx > 0) setBarIdx(barIdx - 1);
				else onExitLeft();
			}
			else if (key === 'right') setBarIdx(Math.min(barBtns.length - 1, barIdx + 1));
			else if (key === 'down') { if (contentRows.length > 0) setZone('rows'); }
			else if (key === 'back') onExitLeft();
			return true;
		}

		if (zone === 'rows') {
			var c = cols[rowIdx] || 0;
			var r = contentRows[rowIdx];
			if (key === 'left') {
				if (c > 0) setCols(function (p) { return {...p, [rowIdx]: c - 1}; });
				else onExitLeft();
			}
			else if (key === 'right' && r) {
				var nc = clamp(c + 1, 0, r.items.length - 1);
				setCols(function (p) { return {...p, [rowIdx]: nc}; });
				if (!isFiltered && nc >= r.items.length - 4) loadMoreForRow(rowIdx);
			}
			else if (key === 'up') {
				if (rowIdx > 0) setRowIdx(rowIdx - 1);
				else setZone('bar');
			}
			else if (key === 'down') {
				if (rowIdx < contentRows.length - 1) {
					setRowIdx(rowIdx + 1);
					if (isFiltered && rowIdx >= contentRows.length - 3) loadMoreFiltered();
				} else {
					if (isFiltered && filteredPage < filteredTotalPages) loadMoreFiltered();
					else if (onExitDown) onExitDown();
				}
			}
			else if (key === 'back') setZone('bar');
			return true;
		}

		return true;
	}, [zone, barIdx, barBtns, sortPanelIdx, filterPanelIdx, filterPanelItems, searchIdx, searchTyping, searchResults, rowIdx, cols, contentRows, isFiltered, filteredPage, filteredTotalPages, onExitLeft, onExitDown, loadMoreForRow, loadMoreFiltered]);

	var keysActive = active && !(zone === 'search' && searchTyping);
	useKeys(handleKey, keysActive);

	useOkPress({
		onPress: function () {
			if (zone === 'search' && !searchTyping) {
				var si = searchResults[searchIdx];
				if (si) handleOpenPanel(si);
				return;
			}
			if (zone === 'sort') {
				var opt = SORT_OPTIONS[sortPanelIdx];
				if (opt) {
					setSortKey(opt.key === sortKey ? null : opt.key);
					setZone('bar');
				}
				return;
			}
			if (zone === 'filter') {
				cycleFilterValue(filterPanelIdx);
				return;
			}
			if (zone === 'bar') {
				var btn = barBtns[barIdx];
				if (!btn) return;
				if (btn.id === 'toggle') setMediaType(mediaType === 'movie' ? 'tv' : 'movie');
				else if (btn.id === 'clear') { setSortKey(null); setFilters(INITIAL_FILTERS); }
				else if (btn.id === 'sort') { setZone('sort'); setSortPanelIdx(sortKey ? Math.max(0, SORT_OPTIONS.findIndex(function (s) { return s.key === sortKey; })) : 0); }
				else if (btn.id === 'filter') { setZone('filter'); setFilterPanelIdx(0); }
				else if (btn.id === 'search') {
					setZone('search');
					setSearchTyping(true);
					setSearchQuery('');
					setSearchResults([]);
					setTimeout(function () { if (searchRef.current) searchRef.current.focus(); }, 100);
				}
				return;
			}
			if (zone === 'rows') {
				var row = contentRows[rowIdx];
				if (!row) return;
				var item = row.items[cols[rowIdx] || 0];
				if (item) handleOpenPanel(item);
				return;
			}
		},
		onLongPress: function () {}
	}, keysActive);

	// --- render ---

	var contentRef = useRef<HTMLDivElement>(null);
	var rowsInnerRef = useRef<HTMLDivElement>(null);
	var [contentH, setContentH] = useState(648);
	useEffect(function () {
		if (contentRef.current) {
			var h = contentRef.current.clientHeight;
			if (h > 0) setContentH(h);
		}
	});
	var innerH = rowsInnerRef.current ? rowsInnerRef.current.scrollHeight : contentRows.length * ROW_SCROLL;
	var maxScrollY = Math.max(0, innerH - contentH);
	var rowScrollY = rowIdx > 0 ? Math.min(rowIdx * ROW_SCROLL, maxScrollY) : 0;

	return (
		<div class="browse">
			{/* Hero */}
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

			{/* Control bar */}
			<div class="browse__bar">
				{barBtns.map(function (btn, i) {
					return (
						<button
							key={btn.id}
							class={'browse__bar-btn' + (zone === 'bar' && i === barIdx ? ' browse__bar-btn--focused' : '') + (btn.id === 'clear' ? ' browse__bar-btn--clear' : '')}
						>
							{btn.label}
						</button>
					);
				})}
			</div>

			{/* Content */}
			<div class="browse__content" ref={contentRef}>
				{genresLoading && !isFiltered && contentRows.length === 0 && <div class="browse__empty">Loading...</div>}
				{filteredLoading && isFiltered && contentRows.length === 0 && <div class="browse__empty">Loading...</div>}
				{!genresLoading && !filteredLoading && contentRows.length === 0 && (
					<div class="browse__empty">{isFiltered ? 'No results — try different filters' : 'No content available'}</div>
				)}
				<div class="browse__rows-inner" ref={rowsInnerRef} style={'transform:translate3d(0,' + (-rowScrollY) + 'px,0)'}>
					{contentRows.map(function (r, ri) {
						var c = cols[ri] || 0;
						if (r.isGrid) {
							return (
								<div key={ri} class={'browse__grid-row' + (zone === 'rows' && ri === rowIdx ? ' browse__grid-row--active' : '')}>
									{r.title && <h2 class="cinema__row-title">{r.title}</h2>}
									<div class="browse__grid-track">
										{r.items.map(function (item, ci) {
											var focused = zone === 'rows' && ri === rowIdx && ci === c;
											var p = posterUrlXL(item.poster);
											return (
												<div key={item.id} class={'cinema__card' + (focused ? ' cinema__card--focused' : '')}>
													<div class="cinema__poster-wrap">
														{p ? <img class="cinema__poster" src={p} alt="" /> : <div class="cinema__poster cinema__poster--empty" />}
														{plexIdx && plexIdx.has(item.mediaType, item.id) && <div class="plex-server-badge"><span class="plex-server-badge__icon">✓</span>Server</div>}
													</div>
													<div class="cinema__card-title">{item.name}</div>
													<div class="cinema__card-year">{yearOf(item.firstAir)}</div>
												</div>
											);
										})}
									</div>
								</div>
							);
						}
						var total = r.items.length * CARD_STEP;
						var fits = total <= VIEW_W;
						var off = fits ? 0 : clamp(c * CARD_STEP + CARD_W / 2 - VIEW_W / 2, 0, Math.max(0, total - VIEW_W));
						return (
							<div key={ri} class={'cinema__row' + (zone === 'rows' && ri === rowIdx ? ' cinema__row--active' : '')}>
								<h2 class="cinema__row-title">{r.title}</h2>
								<div class="cinema__row-viewport">
									<div class="cinema__row-track" style={'transform:translate3d(' + (-off) + 'px,0,0)'}>
										{r.items.map(function (item, ci) {
											var focused = zone === 'rows' && ri === rowIdx && ci === (cols[ri] || 0);
											var p = posterUrlXL(item.poster);
											return (
												<div key={item.id} class={'cinema__card' + (focused ? ' cinema__card--focused' : '')}>
													<div class="cinema__poster-wrap">
														{p ? <img class="cinema__poster" src={p} alt="" /> : <div class="cinema__poster cinema__poster--empty" />}
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
				{isFiltered && filteredLoading && contentRows.length > 0 && (
					<div class="browse__loading-more">Loading more...</div>
				)}
			</div>

			{/* Sort panel */}
			{zone === 'sort' && (
				<>
					<div class="browse__panel-scrim" />
					<div class="browse__side-panel">
						<div class="cinema__panel-content">
							<h2 class="cinema__panel-title">Sort By</h2>
							{SORT_OPTIONS.map(function (opt, i) {
								return (
									<button key={opt.key} class={'cinema__panel-btn' + (i === sortPanelIdx ? ' cinema__panel-btn--focused' : '') + (opt.key === sortKey ? ' browse__active-opt' : '')}>
										{opt.label}
										{opt.key === sortKey ? ' (active)' : ''}
									</button>
								);
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
								return (
									<button key={fi.id} class={'cinema__panel-btn browse__filter-btn' + (i === filterPanelIdx ? ' cinema__panel-btn--focused' : '')}>
										<span class="browse__filter-label">{fi.label}</span>
										<span class="browse__filter-value">{fi.value}</span>
									</button>
								);
							})}
							<div class="cinema__panel-credit">Streaming data by JustWatch</div>
						</div>
					</div>
				</>
			)}

			{/* Search overlay */}
			{zone === 'search' && (
				<div class="browse__search-overlay">
					<input
						ref={searchRef}
						class="browse__search-input"
						type="text"
						placeholder={'Search ' + (mediaType === 'movie' ? 'movies' : 'TV shows') + '...'}
						value={searchQuery}
						onInput={onSearchInput}
						onKeyDown={onSearchKey}
					/>
					<div class="browse__search-results">
						{searchResults.length === 0 && searchQuery.length >= 2 && (
							<div class="browse__search-empty">No results found</div>
						)}
						{searchResults.map(function (item, i) {
							var focused = !searchTyping && i === searchIdx;
							var p = posterUrlXL(item.poster);
							return (
								<div key={item.id} class={'browse__search-item' + (focused ? ' browse__search-item--focused' : '')}>
									{p ? <img class="browse__search-poster" src={p} alt="" /> : <div class="browse__search-poster browse__search-poster--empty" />}
									<div class="browse__search-info">
										<div class="browse__search-name">{item.name}</div>
										<div class="browse__search-meta">{yearOf(item.firstAir)}{item.rating > 0 ? ' · ' + item.rating.toFixed(1) : ''}{' · '}{item.mediaType === 'tv' ? 'TV Series' : 'Movie'}</div>
									</div>
								</div>
							);
						})}
					</div>
				</div>
			)}
		</div>
	);
}
