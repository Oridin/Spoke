import {useCallback, useEffect, useMemo, useRef, useState} from 'preact/hooks';
import {Clock} from '../components/Clock';
import {Row} from '../components/Row';
import type {TileModel} from '../components/Tile';
import {useKeys, type NavKey} from '../hooks/useKeys';
import {useOkPress} from '../hooks/useOkPress';
import {useClock} from '../hooks/useClock';
import type {TimeFormat} from '../lib/clock';
import {clampPosition, initialPosition, movePosition, rowOffsets, splitRows, type RowsPosition} from '../lib/rows';
import {labelColorValue} from '../lib/clockcolor';
import type {ClockConfig} from '../lib/storage';
import type {WeatherView} from '../lib/weather';
import {FONT, LAYOUT} from '../theme/tokens';
import {varScope} from '../lib/cssvars';
import {TrendingSidebar} from '../components/TrendingSidebar';
import type {TrendingData} from '../lib/trending';
import type {TrendingConfig, CinemaConfig} from '../lib/storage';
import {CinemaPanel} from './Cinema';
import {PlexPlayer} from './PlexPlayer';
import {getPlexIndex, refreshPlexIndex, onPlexIndexChange, type PlexIndex} from '../lib/plex';
import {getHiddenSections} from '../lib/pin';

export interface Appearance {
	/** icon size, % of the standard size */
	iconScale: number;
	/** icon opacity, % */
	iconOpacity: number;
	/** colour of the names under the icons ('theme' = the theme's own) */
	labelColor: string;
	/** space between the icons, % of the standard */
	iconGap: number;
	/** icon shape id (see lib/tileshape.ts) */
	tileShape: string;
	/** quiet mode: seconds without a key before the apps hide (0 = off) */
	quietSec: number;
	/** OLED shift on */
	oledShift: boolean;
	/** px at 1080p */
	sideMargin: number;
	bottomMargin: number;
	showLabels: boolean;
	/** 1 or 2 rows of apps */
	rows: number;
	clock: ClockConfig;
}

interface Props {
	/** the tiles: apps, then any chosen inputs, then LG Home and Settings (in one row, or split over two) */
	items: TileModel[];
	timeFormat: TimeFormat;
	appearance: Appearance;
	active: boolean;
	/** the launcher is in the background: stop the clock ticking */
	paused?: boolean;
	onActivate: (item: TileModel) => void;
	/** OK held on a tile */
	onLongPress?: (item: TileModel) => void;
	/** Back pressed on the home screen (opens the Recent apps panel) */
	onBack: () => void;
	/** counts up each time the launcher is brought to the front (Home pressed): the highlight goes back to the first tile */
	wake?: number;
	/** put the highlight on the tile with this key (after it was moved); `seq` changes for each request */
	focus?: {key: string; seq: number};
	/** the weather line under the date, when it is on and known */
	weather?: WeatherView | null;
	/** trending data for both sidebars */
	trending?: TrendingData;
	/** trending display config */
	trendingConfig?: TrendingConfig;
	/** app IDs installed on the TV, for matching streaming providers */
	installedAppIds: string[];
	/** launch a TV app by id */
	onLaunch: (appId: string) => void;
	/** send a show to the seedbox */
	onSeedbox: (name: string, year: string, mediaType: string) => void;
	/** cinema mode config (when on, replaces clock and trending sidebars) */
	cinemaConfig?: CinemaConfig;
	/** toast feedback for the cinema download panel */
	onToast: (msg: string, kind?: 'info' | 'error') => void;
	/** TMDB API key for Browse tab */
	apiKey?: string;
	/** whether to allow shell commands (webOS) */
	allowShell?: boolean;
	/** user's streaming provider IDs for filtering */
	providerIds?: number[];
	/** Plex server URL for My Server tab */
	plexUrl?: string;
	/** Plex auth token for My Server tab */
	plexToken?: string;
	/** whether hidden libraries are unlocked */
	showHidden?: boolean;
	/** lock the hidden libraries again */
	onRelockHidden?: () => void;
	sonarrUrl?: string;
	sonarrKey?: string;
	radarrUrl?: string;
	radarrKey?: string;
	enableDeleteActions?: boolean;
	hasFetchbox?: boolean;
}

/** OLED shift: the offset (px at 1080p) of the clock and the apps, changed once a minute through a small cycle. null = off. */
const SHIFT_STEPS = [{x: 0, y: 0}, {x: 4, y: 2}, {x: 8, y: 0}, {x: 4, y: -2}, {x: 0, y: -4}, {x: -4, y: -2}, {x: -8, y: 0}, {x: -4, y: 2}];
export const SHIFT_EVERY_MS = 60000;
function useShift (on: boolean): {x: number; y: number} | null {
	const [i, setI] = useState(0);
	useEffect(() => {
		if (!on) return undefined;
		const timer = window.setInterval(() => setI((n) => (n + 1) % SHIFT_STEPS.length), SHIFT_EVERY_MS);
		return () => window.clearInterval(timer);
	}, [on]);
	return on ? SHIFT_STEPS[i] : null;
}

/** The home screen: a clock and the tiles along the bottom, in one row or two.
 *  Left/Right move along a row, Up/Down change row (two rows), OK opens, holding OK opens the app's menu.
 *  Back opens the Recent apps panel. */
export function Home ({items, timeFormat, appearance, active, paused, onActivate, onLongPress, onBack, wake, focus, weather, trending, trendingConfig, installedAppIds, onLaunch, onSeedbox, cinemaConfig, onToast, apiKey, allowShell, providerIds, plexUrl, plexToken, showHidden, onRelockHidden, sonarrUrl, sonarrKey, radarrUrl, radarrKey, enableDeleteActions, hasFetchbox}: Props) {
	const cinemaOn = !!(cinemaConfig && cinemaConfig.on && trending && trending.shows.length + trending.movies.length > 0);
	const autoHide = cinemaOn && !!(cinemaConfig && cinemaConfig.autoHideBar);
	const [cinemaActive, setCinemaActive] = useState(false);
	const [barHidden, setBarHidden] = useState(false);
	const [hintVisible, setHintVisible] = useState(false);
	const hintTimer = useRef(0);
	const [plexPlay, setPlexPlay] = useState<{ratingKey: string; title: string} | null>(null);
	const now = useClock(paused);
	const [position, setPosition] = useState<RowsPosition>(initialPosition);
	const sizes = splitRows(items.length, appearance.rows);
	const offsets = rowOffsets(sizes);
	const at = clampPosition(sizes, position);
	const selectedItem = items[offsets[at.row] + at.cols[at.row]];
	const sizeKey = sizes.join(',');
	const quietRef = useRef(false);                       // true while the apps are hidden and for the key press that woke them
	const [quiet, setQuiet] = useState(false);
	const shift = useShift(appearance.oledShift && !paused);

	var hiddenSections = useMemo(function () { return showHidden ? [] as string[] : getHiddenSections(); }, [showHidden]);
	var [plexIdx, setPlexIdx] = useState<PlexIndex | null>(function () { return getPlexIndex(plexUrl || '', plexToken || '', hiddenSections); });
	useEffect(function () {
		setPlexIdx(getPlexIndex(plexUrl || '', plexToken || '', hiddenSections));
		return onPlexIndexChange(function () { setPlexIdx(getPlexIndex(plexUrl || '', plexToken || '', hiddenSections)); });
	}, [plexUrl, plexToken, hiddenSections]);
	useEffect(function () {
		if (active && plexUrl && plexToken) refreshPlexIndex(plexUrl, plexToken, hiddenSections);
	}, [active, plexUrl, plexToken, hiddenSections]);

	// Quiet mode: hide the apps after quietSec without a key; the first key (or pointer move) brings them back and is used up.
	useEffect(() => {
		const secs = appearance.quietSec;
		quietRef.current = false;
		setQuiet(false);
		if (!secs || !active || paused) return undefined;       // while another app is in front nothing is armed; coming back starts fresh with the apps shown
		let timer = 0;
		let hidden = false;
		let swallow = false;
		const arm = () => {
			window.clearTimeout(timer);
			timer = window.setTimeout(() => { hidden = true; quietRef.current = true; setQuiet(true); }, secs * 1000);
		};
		const wake = () => { hidden = false; setQuiet(false); };
		const onDown = () => { if (hidden) { swallow = true; wake(); } arm(); };
		const onUp = () => { if (swallow) window.setTimeout(() => { swallow = false; quietRef.current = false; }, 0); };
		const onPointer = () => { if (hidden) { wake(); quietRef.current = false; } arm(); };
		window.addEventListener('keydown', onDown, true);
		window.addEventListener('keyup', onUp, true);
		window.addEventListener('mousemove', onPointer, true);
		window.addEventListener('click', onPointer, true);
		arm();
		return () => {
			window.clearTimeout(timer);
			window.removeEventListener('keydown', onDown, true);
			window.removeEventListener('keyup', onUp, true);
			window.removeEventListener('mousemove', onPointer, true);
			window.removeEventListener('click', onPointer, true);
			quietRef.current = false;
		};
	}, [appearance.quietSec, active, paused, wake]);

	// Auto-hide bar: slide out 300ms after Cinema takes focus, slide in immediately when bar regains focus
	useEffect(() => {
		if (!autoHide) { setBarHidden(false); return undefined; }
		if (cinemaActive) {
			const t = window.setTimeout(() => setBarHidden(true), 300);
			return () => window.clearTimeout(t);
		}
		setBarHidden(false);
		return undefined;
	}, [cinemaActive, autoHide]);

	// Hint chevron: flash briefly on mount and when cinemaActive changes to true
	useEffect(() => {
		if (!autoHide || !cinemaActive) return undefined;
		setHintVisible(true);
		window.clearTimeout(hintTimer.current);
		hintTimer.current = window.setTimeout(() => setHintVisible(false), 3000);
		return () => window.clearTimeout(hintTimer.current);
	}, [cinemaActive, autoHide]);

	// Home pressed (the launcher comes to the front): start again at the first tile.
	useEffect(() => { setCinemaActive(false); setPosition(initialPosition()); }, [wake]);

	// A tile was moved: the highlight follows it to its new place.
	useEffect(() => {
		if (!focus) return;
		const index = items.findIndex((item) => item.key === focus.key);
		if (index === -1) return;
		let row = 0;
		while (row < sizes.length - 1 && index >= offsets[row] + sizes[row]) row++;
		setPosition((p) => ({row, cols: clampPosition(sizes, p).cols.map((c, r) => (r === row ? index - offsets[row] : c))}));
	}, [focus && focus.seq]);

	const handleKey = useCallback((key: NavKey): boolean => {
		if (quietRef.current) return true;
		if (key === 'up' && cinemaOn) {
			setPosition((p) => {
				const cur = clampPosition(sizes, p);
				if (cur.row === 0) { setCinemaActive(true); return p; }
				return movePosition(sizes, p, key);
			});
			return true;
		}
		if (key === 'left' || key === 'right' || key === 'up' || key === 'down') setPosition((p) => movePosition(sizes, p, key));
		else if (key === 'back') {
			if (cinemaOn) setCinemaActive(true);
			else onBack();
		}
		return true;
	}, [sizeKey, onBack, cinemaOn]);

	const rowsActive = active && !(cinemaOn && cinemaActive);
	useKeys(handleKey, rowsActive);
	useOkPress({
		onPress: () => { if (selectedItem && !quietRef.current) onActivate(selectedItem); },
		onLongPress: () => { if (selectedItem && onLongPress && !quietRef.current) onLongPress(selectedItem); }
	}, rowsActive);

	// The row's sizes are set on the row itself (not on :root), so the Settings grid keeps its own.
	const scale = appearance.iconScale / 100;
	const tileSize = Math.round(LAYOUT.tileSize * scale);
	const tileGap = Math.round(LAYOUT.tileGap * scale * appearance.iconGap / 100);
	const rowVars = varScope('rows', {
		'--icon-opacity': String(appearance.iconOpacity / 100),
		'--label-color': labelColorValue(appearance.labelColor) || undefined,
		'--layout-tile-size': `${tileSize}px`,
		'--layout-tile-gap': `${tileGap}px`,
		'--layout-tile-radius': `${Math.round(LAYOUT.tileRadius * scale)}px`,
		'--font-tile-label': `${Math.min(24, Math.max(15, Math.round(FONT.tileLabel * scale)))}px`
	});
	const rowStyle = [`left:${appearance.sideMargin}px`, `right:${appearance.sideMargin}px`, `bottom:${appearance.bottomMargin}px`, rowVars.css].filter(Boolean).join(';');
	const shiftVars = varScope('shift', shift ? {'--shift-x': `${shift.x}px`, '--shift-y': `${shift.y}px`} : {});
	const classes = [rowVars.cls, 'rows', !appearance.showLabels && 'rows--no-labels', sizes.length > 1 && 'rows--multi', appearance.iconOpacity < 100 && 'rows--dim', quiet && 'rows--quiet', labelColorValue(appearance.labelColor) && 'rows--label-color', appearance.tileShape !== 'rounded' && `rows--shape-${appearance.tileShape}`, cinemaOn && 'rows--cinema', barHidden && 'rows--bar-hidden'].filter(Boolean).join(' ');

	return (
		<div class={`screen${active ? '' : ' screen--away'}${shift ? ' screen--shift' : ''}${shiftVars.cls ? ' ' + shiftVars.cls : ''}`} style={shiftVars.css || undefined}>
			{cinemaOn && trending ? (
				<CinemaPanel trending={trending} installedAppIds={installedAppIds} onLaunch={onLaunch} onToast={onToast} active={active && cinemaActive && !plexPlay} onExitDown={() => setCinemaActive(false)} rowAreaPx={autoHide ? 0 : appearance.bottomMargin + tileSize + (appearance.showLabels ? 32 : 8) + 24} apiKey={apiKey || ''} allowShell={!!allowShell} providerIds={providerIds || []} plexUrl={plexUrl || ''} plexToken={plexToken || ''} showHidden={!!showHidden} onRelockHidden={onRelockHidden || (() => {})} sonarrUrl={sonarrUrl || ''} sonarrKey={sonarrKey || ''} radarrUrl={radarrUrl || ''} radarrKey={radarrKey || ''} enableDeleteActions={!!enableDeleteActions} hasFetchbox={!!hasFetchbox} onPlayPlex={function (rk, t) { setPlexPlay({ratingKey: rk, title: t}); }} />
			) : (
				<>
					<Clock now={now} format={timeFormat} config={appearance.clock} weather={weather} />
					{trending && trendingConfig && trending.shows.length > 0 && <TrendingSidebar title="Trending Shows" shows={trending.shows.slice(0, trendingConfig.maxShows)} side="left" config={trendingConfig} installedAppIds={installedAppIds} onLaunch={onLaunch} onSeedbox={onSeedbox} plexIdx={plexIdx} />}
					{trending && trendingConfig && trending.movies.length > 0 && <TrendingSidebar title="Trending Movies" shows={trending.movies.slice(0, trendingConfig.maxMovies)} side="right" config={trendingConfig} installedAppIds={installedAppIds} onLaunch={onLaunch} onSeedbox={onSeedbox} plexIdx={plexIdx} />}
				</>
			)}
			{autoHide && !barHidden && <div class="rows-scrim" />}
			<div class={classes} style={rowStyle} aria-hidden={barHidden || undefined}>
				{sizes.map((size, r) => {
					const start = offsets[r];
					return (
						<Row
							key={r}
							items={items.slice(start, start + size)}
							focused={!cinemaActive && r === at.row}
							selected={at.cols[r]}
							onSelect={(col) => setPosition({row: r, cols: at.cols.map((c, i) => (i === r ? col : c))})}
							onActivate={(col) => onActivate(items[start + col])}
							tileSize={tileSize}
							tileGap={tileGap}
							viewportWidth={LAYOUT.screenWidth - 2 * appearance.sideMargin}
						/>
					);
				})}
			</div>
			{autoHide && <div class={'rows-hint' + (hintVisible ? ' rows-hint--visible' : '')} />}
			{plexPlay && <PlexPlayer plexUrl={plexUrl || ''} plexToken={plexToken || ''} ratingKey={plexPlay.ratingKey} title={plexPlay.title} onClose={function () { setPlexPlay(null); }} onToast={onToast} />}
		</div>
	);
}
