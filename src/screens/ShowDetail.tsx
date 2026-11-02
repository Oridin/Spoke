import {useCallback, useEffect, useMemo, useRef, useState} from 'preact/hooks';
import {useKeyTrap} from '../hooks/useKeyTrap';
import {KEY} from '../config/constants';
import {
	fetchTmdbShowDetail, fetchTmdbSeasonDetail, tmdbStillUrl,
	type TmdbShowDetail, type TmdbEpisode, type TmdbSeason,
} from '../lib/tmdb';
import {
	fetchSeasons, fetchEpisodes, fetchShowMeta, plexStillUrl,
	type PlexItem, type PlexIndex,
} from '../lib/plex';
import {backdropUrl, yearOf, providerDef, findProviderApp, type TrendingShow} from '../lib/trending';
import {launchApp} from '../lib/launch';
import {
	sonarrConn, watchlistCheckSeries, watchlistAddSeriesByTmdb, watchlistStopSeries,
	downloadSeries, sonarrQueue,
	type SonarrSeries, type SonarrEpisode, type QueueRecord, type MonitorScope,
} from '../lib/arrapi';

interface Props {
	show: TrendingShow;
	open: boolean;
	active: boolean;
	onClose: () => void;
	onPlayPlex?: (ratingKey: string, title: string) => void;
	onToast: (msg: string, kind?: 'info' | 'error') => void;
	onLaunch: (appId: string) => void;
	apiKey: string;
	allowShell: boolean;
	plexUrl: string;
	plexToken: string;
	plexIdx: PlexIndex | null;
	installedAppIds: string[];
	isOnWatchlist: boolean;
	sonarrUrl: string;
	sonarrKey: string;
	enableDeleteActions: boolean;
	onWatchlistChanged: () => void;
}

interface MergedEpisode {
	epNum: number;
	seasonNum: number;
	name: string;
	overview: string;
	stillUrl: string | null;
	airDate: string | null;
	runtime: number | null;
	onPlex: boolean;
	watched: boolean;
	viewOffset: number;
	duration: number;
	downloading: boolean;
	downloadPct: number;
	unaired: boolean;
	plexRatingKey: string | null;
	sonarrEpId: number | null;
}

type Zone = 'actions' | 'seasons' | 'episodes';
type Overlay = 'more' | 'season-actions' | 'dl-confirm' | 'wl-monitor' | 'wl-stop' | 'remove-confirm' | null;

var PLEX_APP = 'cdp-30';
var EP_ROW_H = 152;
var VISIBLE_EPS = 3;
var BUFFER_EPS = 2;

var MONITOR_OPTS: {key: MonitorScope; label: string}[] = [
	{key: 'future', label: 'Future Episodes'},
	{key: 'lastSeason', label: 'Latest Season'},
	{key: 'all', label: 'All Episodes'},
	{key: 'none', label: 'None (Manual)'},
];

function padTwo(n: number): string {
	return n < 10 ? '0' + n : String(n);
}

function formatEpCode(s: number, e: number): string {
	return 'S' + padTwo(s) + 'E' + padTwo(e);
}

function formatRuntime(mins: number | null): string {
	if (!mins) return '';
	if (mins >= 60) return Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
	return mins + 'm';
}

export function ShowDetail({show, open, active, onClose, onPlayPlex, onToast, onLaunch, apiKey, allowShell, plexUrl, plexToken, plexIdx, installedAppIds, isOnWatchlist, sonarrUrl, sonarrKey, enableDeleteActions, onWatchlistChanged}: Props) {
	var [tmdbDetail, setTmdbDetail] = useState<TmdbShowDetail | null>(null);
	var [seasonEps, setSeasonEps] = useState<Record<number, TmdbEpisode[]>>({});
	var [plexShowMeta, setPlexShowMeta] = useState<PlexItem | null>(null);
	var [plexSeasons, setPlexSeasons] = useState<PlexItem[] | null>(null);
	var [plexEpMap, setPlexEpMap] = useState<Record<string, PlexItem[]>>({});
	var [sonarrSeries, setSonarrSeries] = useState<SonarrSeries | null>(null);
	var [sonarrEps, setSonarrEps] = useState<SonarrEpisode[]>([]);
	var [queueRecords, setQueueRecords] = useState<QueueRecord[]>([]);
	var [zone, setZone] = useState<Zone>('actions');
	var [actionIdx, setActionIdx] = useState(0);
	var [seasonIdx, setSeasonIdx] = useState(0);
	var [epIdx, setEpIdx] = useState(0);
	var [overlay, setOverlay] = useState<Overlay>(null);
	var [overlayIdx, setOverlayIdx] = useState(0);
	var [dlTarget, setDlTarget] = useState<MergedEpisode | null>(null);
	var [loading, setLoading] = useState(true);
	var [plexError, setPlexError] = useState(false);
	var [sonarrError, setSonarrError] = useState(false);
	var [visible, setVisible] = useState(false);
	var prevShowId = useRef(-1);
	var dlBusy = useRef(false);

	var isOnPlex = !!(plexIdx && plexIdx.has('tv', show.id));
	var plexRk = plexIdx ? plexIdx.getRatingKey('tv', show.id) : null;
	var hasArr = !!(sonarrUrl && sonarrKey);
	var sConn = useMemo(function () {
		return hasArr ? sonarrConn({sonarrUrl: sonarrUrl, sonarrKey: sonarrKey}) : null;
	}, [sonarrUrl, sonarrKey, hasArr]);

	// --- fade-in ---
	useEffect(function () {
		if (open) requestAnimationFrame(function () { requestAnimationFrame(function () { setVisible(true); }); });
		else setVisible(false);
	}, [open]);

	// --- fetch data on open ---
	useEffect(function () {
		if (!open || !apiKey || show.id === prevShowId.current) return;
		prevShowId.current = show.id;
		setLoading(true);
		setTmdbDetail(null);
		setSeasonEps({});
		setPlexShowMeta(null);
		setPlexSeasons(null);
		setPlexEpMap({});
		setSonarrSeries(null);
		setSonarrEps([]);
		setQueueRecords([]);
		setPlexError(false);
		setSonarrError(false);
		setZone('actions');
		setActionIdx(0);
		setSeasonIdx(0);
		setEpIdx(0);
		setOverlay(null);

		fetchTmdbShowDetail(apiKey, show.id, allowShell).then(function (detail) {
			setTmdbDetail(detail);
			setLoading(false);
			// Default season: will be corrected by on-deck effect once Plex data arrives
			var real = detail.seasons.filter(function (s) { return s.season_number > 0; });
			if (real.length === 0) real = detail.seasons;
			var lastIdx = 0;
			for (var i = 0; i < detail.seasons.length; i++) {
				if (detail.seasons[i].season_number === real[real.length - 1].season_number) { lastIdx = i; break; }
			}
			setSeasonIdx(lastIdx);
			// Pre-fetch default season episodes
			if (detail.seasons[lastIdx]) {
				fetchTmdbSeasonDetail(apiKey, show.id, detail.seasons[lastIdx].season_number, allowShell).then(function (sd) {
					setSeasonEps(function (prev) { var n: Record<number, TmdbEpisode[]> = {}; for (var k in prev) n[k] = prev[k]; n[sd.season_number] = sd.episodes; return n; });
				});
			}
		});

		if (isOnPlex && plexRk && plexUrl && plexToken) {
			fetchShowMeta(plexUrl, plexToken, plexRk).then(function (meta) { setPlexShowMeta(meta); }).catch(function () { setPlexError(true); });
			fetchSeasons(plexUrl, plexToken, plexRk).then(function (s) { setPlexSeasons(s); }).catch(function () { setPlexError(true); });
		}

		if (sConn) {
			watchlistCheckSeries(sConn, show.id).then(function (check) {
				setSonarrSeries(check.existing);
				setSonarrEps(check.episodes);
				if (check.existing) {
					sonarrQueue(sConn!).then(function (q) {
						var recs: QueueRecord[] = [];
						for (var i = 0; i < q.records.length; i++) {
							if (q.records[i].seriesId === check.existing!.id) recs.push(q.records[i]);
						}
						setQueueRecords(recs);
					}).catch(function () { setSonarrError(true); });
				}
			}).catch(function () { setSonarrError(true); });
		}
	}, [open, show.id, apiKey, allowShell, isOnPlex, plexRk, plexUrl, plexToken, sConn]);

	useEffect(function () { if (!open) prevShowId.current = -1; }, [open]);

	// --- display seasons (skip S0 unless it's the only one) ---
	var displaySeasons: TmdbSeason[] = useMemo(function () {
		if (!tmdbDetail) return [];
		var real = tmdbDetail.seasons.filter(function (s) { return s.season_number > 0; });
		return real.length > 0 ? real : tmdbDetail.seasons;
	}, [tmdbDetail]);

	var currentSeason = displaySeasons[seasonIdx] || null;
	var currentSeasonNum = currentSeason ? currentSeason.season_number : -1;

	// --- on-deck: auto-select first season with unwatched episodes ---
	var onDeckDone = useRef(false);
	useEffect(function () {
		if (onDeckDone.current || !plexSeasons || displaySeasons.length === 0) return;
		onDeckDone.current = true;
		for (var i = 0; i < displaySeasons.length; i++) {
			var sn = displaySeasons[i].season_number;
			for (var j = 0; j < plexSeasons.length; j++) {
				if (plexSeasons[j].index === sn) {
					var viewed = plexSeasons[j].viewedLeafCount || 0;
					var total = plexSeasons[j].leafCount || 0;
					if (total > 0 && viewed < total) { setSeasonIdx(i); setEpIdx(0); return; }
				}
			}
		}
	}, [plexSeasons, displaySeasons]);

	// --- fetch TMDB episodes for current season ---
	useEffect(function () {
		if (!open || !apiKey || currentSeasonNum < 0 || seasonEps[currentSeasonNum]) return;
		fetchTmdbSeasonDetail(apiKey, show.id, currentSeasonNum, allowShell).then(function (sd) {
			setSeasonEps(function (prev) { var n: Record<number, TmdbEpisode[]> = {}; for (var k in prev) n[k] = prev[k]; n[sd.season_number] = sd.episodes; return n; });
		}).catch(function () { onToast('Failed to load episodes', 'error'); });
	}, [open, apiKey, show.id, currentSeasonNum, allowShell]);

	// --- fetch Plex episodes for current season ---
	var plexSeasonItem = useMemo(function () {
		if (!plexSeasons || currentSeasonNum < 0) return null;
		for (var i = 0; i < plexSeasons.length; i++) {
			if (plexSeasons[i].index === currentSeasonNum) return plexSeasons[i];
		}
		return null;
	}, [plexSeasons, currentSeasonNum]);

	useEffect(function () {
		if (!plexSeasonItem || !plexUrl || !plexToken || plexEpMap[plexSeasonItem.ratingKey]) return;
		fetchEpisodes(plexUrl, plexToken, plexSeasonItem.ratingKey).then(function (eps) {
			setPlexEpMap(function (prev) { var n: Record<string, PlexItem[]> = {}; for (var k in prev) n[k] = prev[k]; n[plexSeasonItem!.ratingKey] = eps; return n; });
		}).catch(function () { setPlexError(true); });
	}, [plexSeasonItem, plexUrl, plexToken]);

	// --- Plex re-fetch on return from player ---
	var prevActive = useRef(active);
	useEffect(function () {
		if (active && !prevActive.current && open && plexSeasonItem && plexUrl && plexToken) {
			fetchEpisodes(plexUrl, plexToken, plexSeasonItem.ratingKey).then(function (eps) {
				setPlexEpMap(function (prev) { var n: Record<string, PlexItem[]> = {}; for (var k in prev) n[k] = prev[k]; n[plexSeasonItem!.ratingKey] = eps; return n; });
			}).catch(function () { setPlexError(true); });
			if (plexRk) {
				fetchShowMeta(plexUrl, plexToken, plexRk).then(function (meta) { setPlexShowMeta(meta); }).catch(function () { setPlexError(true); });
				fetchSeasons(plexUrl, plexToken, plexRk).then(function (s) { setPlexSeasons(s); }).catch(function () { setPlexError(true); });
			}
		}
		prevActive.current = active;
	});

	// --- merge TMDB + Plex + Sonarr episodes ---
	var sonarrEpMap: Record<string, SonarrEpisode> = useMemo(function () {
		var m: Record<string, SonarrEpisode> = {};
		for (var i = 0; i < sonarrEps.length; i++) m[sonarrEps[i].seasonNumber + ':' + sonarrEps[i].episodeNumber] = sonarrEps[i];
		return m;
	}, [sonarrEps]);

	var queueByEpId: Record<number, QueueRecord> = useMemo(function () {
		var m: Record<number, QueueRecord> = {};
		for (var i = 0; i < queueRecords.length; i++) {
			if (queueRecords[i].episodeId) m[queueRecords[i].episodeId!] = queueRecords[i];
		}
		return m;
	}, [queueRecords]);

	var episodes: MergedEpisode[] = useMemo(function () {
		var tmdbEps = currentSeasonNum >= 0 ? (seasonEps[currentSeasonNum] || []) : [];
		var plexEps = plexSeasonItem ? (plexEpMap[plexSeasonItem.ratingKey] || []) : [];
		var plexByIdx: Record<number, PlexItem> = {};
		for (var i = 0; i < plexEps.length; i++) {
			if (plexEps[i].index != null) plexByIdx[plexEps[i].index!] = plexEps[i];
		}
		var now = new Date().toISOString().slice(0, 10);
		var usedPlex: Record<string, true> = {};
		var result: MergedEpisode[] = [];

		for (var t = 0; t < tmdbEps.length; t++) {
			var te = tmdbEps[t];
			var pep = plexByIdx[te.episode_number] || null;
			if (pep) usedPlex[pep.ratingKey] = true;
			// Fallback match by title
			if (!pep) {
				var norm = te.name.toLowerCase().trim();
				for (var p2 = 0; p2 < plexEps.length; p2++) {
					if (!usedPlex[plexEps[p2].ratingKey] && plexEps[p2].title.toLowerCase().trim() === norm) {
						pep = plexEps[p2];
						usedPlex[pep.ratingKey] = true;
						break;
					}
				}
			}
			var snKey = te.season_number + ':' + te.episode_number;
			var se = sonarrEpMap[snKey] || null;
			var qr = se ? (queueByEpId[se.id] || null) : null;
			var still: string | null = null;
			if (pep && pep.thumb) still = plexStillUrl(plexUrl, plexToken, pep.thumb, 300);
			else still = tmdbStillUrl(te.still_path, 300);
			result.push({
				epNum: te.episode_number,
				seasonNum: te.season_number,
				name: te.name || 'Episode ' + te.episode_number,
				overview: te.overview || '',
				stillUrl: still,
				airDate: te.air_date,
				runtime: te.runtime,
				onPlex: !!pep,
				watched: !!(pep && pep.viewCount != null && pep.viewCount > 0),
				viewOffset: pep && pep.viewOffset != null ? pep.viewOffset : 0,
				duration: pep && pep.duration != null ? pep.duration : 0,
				downloading: !!qr,
				downloadPct: qr && qr.size > 0 ? Math.round((1 - qr.sizeleft / qr.size) * 100) : 0,
				unaired: !!(te.air_date && te.air_date > now),
				plexRatingKey: pep ? pep.ratingKey : null,
				sonarrEpId: se ? se.id : null,
			});
		}

		// Append Plex episodes not in TMDB
		for (var px = 0; px < plexEps.length; px++) {
			if (!usedPlex[plexEps[px].ratingKey]) {
				result.push({
					epNum: plexEps[px].index || 0,
					seasonNum: plexEps[px].parentIndex || 0,
					name: plexEps[px].title,
					overview: plexEps[px].summary || '',
					stillUrl: plexStillUrl(plexUrl, plexToken, plexEps[px].thumb, 300),
					airDate: null,
					runtime: plexEps[px].duration ? Math.round(plexEps[px].duration! / 60000) : null,
					onPlex: true,
					watched: !!(plexEps[px].viewCount && plexEps[px].viewCount! > 0),
					viewOffset: plexEps[px].viewOffset || 0,
					duration: plexEps[px].duration || 0,
					downloading: false,
					downloadPct: 0,
					unaired: false,
					plexRatingKey: plexEps[px].ratingKey,
					sonarrEpId: null,
				});
			}
		}
		return result;
	}, [currentSeasonNum, seasonEps, plexSeasonItem, plexEpMap, plexUrl, plexToken, sonarrEpMap, queueByEpId]);

	// --- Sonarr queue polling ---
	var hasDownloads = useMemo(function () {
		for (var i = 0; i < episodes.length; i++) { if (episodes[i].downloading) return true; }
		return false;
	}, [episodes]);

	useEffect(function () {
		if (!sConn || !sonarrSeries || !hasDownloads || !open) return;
		var sid = sonarrSeries.id;
		var iv = window.setInterval(function () {
			sonarrQueue(sConn!).then(function (q) {
				var recs: QueueRecord[] = [];
				for (var i = 0; i < q.records.length; i++) { if (q.records[i].seriesId === sid) recs.push(q.records[i]); }
				setQueueRecords(recs);
			}).catch(function () { setSonarrError(true); });
		}, 10000);
		return function () { window.clearInterval(iv); };
	}, [sConn, sonarrSeries, hasDownloads, open]);

	// --- resume / first unwatched detection ---
	var resumeEp = useMemo(function () {
		for (var i = 0; i < episodes.length; i++) {
			if (episodes[i].viewOffset > 0 && episodes[i].plexRatingKey) return episodes[i];
		}
		return null;
	}, [episodes]);

	var firstUnwatched = useMemo(function () {
		for (var i = 0; i < episodes.length; i++) {
			if (episodes[i].onPlex && !episodes[i].watched && !episodes[i].unaired) return episodes[i];
		}
		return null;
	}, [episodes]);

	// --- action buttons ---
	var actionBtns: {label: string; action: string; primary: boolean}[] = useMemo(function () {
		var btns: {label: string; action: string; primary: boolean}[] = [];
		if (isOnPlex) {
			if (resumeEp) btns.push({label: 'Resume ' + formatEpCode(resumeEp.seasonNum, resumeEp.epNum), action: 'resume', primary: true});
			else if (firstUnwatched && firstUnwatched.plexRatingKey) btns.push({label: 'Play ' + formatEpCode(firstUnwatched.seasonNum, firstUnwatched.epNum), action: 'play-next', primary: true});
			else btns.push({label: 'Play', action: 'play-first', primary: true});
		} else {
			var provBtn: typeof btns[0] | null = null;
			for (var i = 0; i < show.providers.length; i++) {
				var def = providerDef(show.providers[i].id);
				if (!def) continue;
				var appId = findProviderApp(def, installedAppIds);
				if (appId) { provBtn = {label: 'Watch on ' + def.short, action: 'launch:' + appId, primary: true}; break; }
			}
			if (provBtn) btns.push(provBtn);
		}
		// Additional provider buttons (max 2, skip if already primary)
		var pc = 0;
		for (var j = 0; j < show.providers.length && pc < 2; j++) {
			var def2 = providerDef(show.providers[j].id);
			if (!def2) continue;
			var aid = findProviderApp(def2, installedAppIds);
			if (!aid) continue;
			var dup = false;
			for (var b = 0; b < btns.length; b++) { if (btns[b].action === 'launch:' + aid) { dup = true; break; } }
			if (!dup) { btns.push({label: def2.short, action: 'launch:' + aid, primary: false}); pc++; }
		}
		if (isOnWatchlist) btns.push({label: 'On Watchlist ✓', action: 'wl-status', primary: false});
		else btns.push({label: 'Add to Watchlist', action: 'wl-add', primary: false});
		if (plexError || sonarrError) btns.push({label: 'Retry', action: 'retry', primary: false});
		btns.push({label: 'More ⋯', action: 'more', primary: false});
		return btns;
	}, [isOnPlex, resumeEp, firstUnwatched, show.providers, installedAppIds, isOnWatchlist, plexError, sonarrError]);

	// --- more menu items ---
	var moreItems: {label: string; action: string}[] = useMemo(function () {
		var items: {label: string; action: string}[] = [];
		if (hasArr && sonarrSeries) items.push({label: 'Search Now', action: 'search'});
		if (isOnPlex) items.push({label: 'Open in Plex', action: 'open-plex'});
		if (enableDeleteActions && sonarrSeries) items.push({label: 'Remove from Library', action: 'remove'});
		items.push({label: 'Cancel', action: 'cancel'});
		return items;
	}, [hasArr, sonarrSeries, isOnPlex, enableDeleteActions]);

	// --- season action items ---
	var seasonActionItems: {label: string; action: string}[] = useMemo(function () {
		var items: {label: string; action: string}[] = [];
		if (currentSeason) items.push({label: 'Download Season ' + currentSeason.season_number, action: 'dl-season'});
		items.push({label: 'Cancel', action: 'cancel'});
		return items;
	}, [currentSeason]);

	// --- scroll offsets ---
	var scrollY = useMemo(function () {
		var maxScroll = Math.max(0, episodes.length - VISIBLE_EPS);
		var s = Math.max(0, Math.min(epIdx - 1, maxScroll));
		return s * EP_ROW_H;
	}, [epIdx, episodes.length]);

	var seasonScrollX = useMemo(function () {
		if (displaySeasons.length <= 6) return 0;
		var tabW = 140;
		var viewW = 1760;
		var idx = seasonIdx;
		var off = idx * tabW - viewW / 2 + tabW / 2;
		return Math.max(0, Math.min(off, (displaySeasons.length + 1) * tabW - viewW));
	}, [seasonIdx, displaySeasons.length, zone]);

	// --- hero URL ---
	var heroUrl = useMemo(function () {
		if (tmdbDetail && tmdbDetail.backdrop_path) return backdropUrl(tmdbDetail.backdrop_path);
		return backdropUrl(show.backdrop);
	}, [tmdbDetail, show.backdrop]);

	// --- action handlers ---
	var playEpisode = useCallback(function (ep: MergedEpisode) {
		if (!ep.plexRatingKey || !onPlayPlex) return;
		var title = show.name + ' — ' + formatEpCode(ep.seasonNum, ep.epNum) + ' ' + ep.name;
		onPlayPlex(ep.plexRatingKey, title);
	}, [show.name, onPlayPlex]);

	var retryFetch = useCallback(function () {
		if (plexError && isOnPlex && plexRk && plexUrl && plexToken) {
			setPlexError(false);
			fetchShowMeta(plexUrl, plexToken, plexRk).then(function (meta) { setPlexShowMeta(meta); }).catch(function () { setPlexError(true); });
			fetchSeasons(plexUrl, plexToken, plexRk).then(function (s) { setPlexSeasons(s); }).catch(function () { setPlexError(true); });
		}
		if (sonarrError && sConn) {
			setSonarrError(false);
			watchlistCheckSeries(sConn, show.id).then(function (check) {
				setSonarrSeries(check.existing);
				setSonarrEps(check.episodes);
			}).catch(function () { setSonarrError(true); });
		}
	}, [plexError, sonarrError, isOnPlex, plexRk, plexUrl, plexToken, sConn, show.id]);

	var doAction = useCallback(function (action: string) {
		if (action === 'resume' && resumeEp && resumeEp.plexRatingKey) {
			playEpisode(resumeEp);
		} else if (action === 'play-next' && firstUnwatched) {
			playEpisode(firstUnwatched);
		} else if (action === 'play-first') {
			for (var i = 0; i < episodes.length; i++) {
				if (episodes[i].plexRatingKey) { playEpisode(episodes[i]); return; }
			}
			launchApp(PLEX_APP).catch(function () { onToast("Couldn't open Plex", 'error'); });
		} else if (action === 'wl-add') {
			if (hasArr) { setOverlay('wl-monitor'); setOverlayIdx(0); }
			else onToast('Connect Sonarr in Settings to add to Watchlist', 'info');
		} else if (action === 'wl-status') {
			setOverlay('wl-stop');
			setOverlayIdx(0);
		} else if (action === 'more') {
			setOverlay('more');
			setOverlayIdx(0);
		} else if (action === 'retry') {
			retryFetch();
		} else if (action.indexOf('launch:') === 0) {
			onLaunch(action.slice(7));
		}
	}, [resumeEp, firstUnwatched, episodes, playEpisode, hasArr, onLaunch, onToast, retryFetch]);

	var doMoreAction = useCallback(function (action: string) {
		setOverlay(null);
		if (action === 'open-plex') {
			launchApp(PLEX_APP).catch(function () { onToast("Couldn't open Plex", 'error'); });
		} else if (action === 'search' && sConn && sonarrSeries) {
			onToast('Searching for ' + show.name + '...');
			downloadSeries(sConn, show.id, 'all').then(function (r) {
				onToast('Searching ' + r.monitoredCount + ' episodes');
			}).catch(function (e) { onToast(e && e.message || 'Search failed', 'error'); });
		} else if (action === 'remove') {
			setOverlay('remove-confirm');
			setOverlayIdx(0);
		}
	}, [sConn, sonarrSeries, show, onToast]);

	var doRemove = useCallback(function () {
		if (!sConn || !sonarrSeries) return;
		setOverlay(null);
		watchlistStopSeries(sConn, sonarrSeries).then(function () {
			onToast(show.name + ' removed');
			setSonarrSeries(null);
			setSonarrEps([]);
			onWatchlistChanged();
		}).catch(function (e) { onToast(e && e.message || 'Failed to remove', 'error'); });
	}, [sConn, sonarrSeries, show, onToast, onWatchlistChanged]);

	var doWlAdd = useCallback(function (scope: MonitorScope) {
		if (!sConn) return;
		setOverlay(null);
		onToast('Adding ' + show.name + '...');
		watchlistAddSeriesByTmdb(sConn, show.id, scope).then(function (result) {
			var msg = result.monitoredCount >= 0
				? 'Monitoring ' + result.monitoredCount + ' episode' + (result.monitoredCount !== 1 ? 's' : '') + ' of ' + result.title
				: result.title + ' added to watchlist';
			onToast(msg);
			onWatchlistChanged();
			watchlistCheckSeries(sConn!, show.id).then(function (check) {
				setSonarrSeries(check.existing);
				setSonarrEps(check.episodes);
			}).catch(function () { setSonarrError(true); });
		}).catch(function (e) { onToast(e && e.message || 'Failed to add', 'error'); });
	}, [sConn, show, onToast, onWatchlistChanged]);

	var doWlStop = useCallback(function () {
		if (!sConn || !sonarrSeries) return;
		setOverlay(null);
		watchlistStopSeries(sConn, sonarrSeries).then(function () {
			onToast(show.name + ' — stopped monitoring');
			onWatchlistChanged();
			setSonarrSeries(null);
			setSonarrEps([]);
		}).catch(function (e) { onToast(e && e.message || 'Failed', 'error'); });
	}, [sConn, sonarrSeries, show, onToast, onWatchlistChanged]);

	var doEpisodeDownload = useCallback(function (ep: MergedEpisode) {
		if (!sConn || dlBusy.current) return;
		setOverlay(null);
		setDlTarget(null);
		dlBusy.current = true;
		onToast('Downloading ' + formatEpCode(ep.seasonNum, ep.epNum) + '...');
		if (ep.sonarrEpId) {
			downloadSeries(sConn, show.id, {episode: ep.sonarrEpId}).then(function () {
				dlBusy.current = false;
				onToast(formatEpCode(ep.seasonNum, ep.epNum) + ' queued');
				// Refresh queue
				if (sonarrSeries) {
					sonarrQueue(sConn!).then(function (q) {
						var recs: QueueRecord[] = [];
						for (var i = 0; i < q.records.length; i++) { if (q.records[i].seriesId === sonarrSeries!.id) recs.push(q.records[i]); }
						setQueueRecords(recs);
					}).catch(function () {});
				}
			}).catch(function (e) { dlBusy.current = false; onToast(e && e.message || 'Download failed', 'error'); });
		} else {
			downloadSeries(sConn, show.id, {season: ep.seasonNum}).then(function () {
				dlBusy.current = false;
				onToast('Season ' + ep.seasonNum + ' queued');
			}).catch(function (e) { dlBusy.current = false; onToast(e && e.message || 'Download failed', 'error'); });
		}
	}, [sConn, show.id, sonarrSeries, onToast]);

	var doSeasonDownload = useCallback(function () {
		if (!sConn || !currentSeason || dlBusy.current) return;
		setOverlay(null);
		dlBusy.current = true;
		onToast('Downloading Season ' + currentSeason.season_number + '...');
		downloadSeries(sConn, show.id, {season: currentSeason.season_number}).then(function (r) {
			dlBusy.current = false;
			onToast('Monitoring ' + r.monitoredCount + ' episodes of ' + r.title);
			onWatchlistChanged();
			if (sonarrSeries) {
				sonarrQueue(sConn!).then(function (q) {
					var recs: QueueRecord[] = [];
					for (var i = 0; i < q.records.length; i++) { if (q.records[i].seriesId === sonarrSeries!.id) recs.push(q.records[i]); }
					setQueueRecords(recs);
				}).catch(function () {});
			}
		}).catch(function (e) { dlBusy.current = false; onToast(e && e.message || 'Download failed', 'error'); });
	}, [sConn, currentSeason, show.id, sonarrSeries, onToast, onWatchlistChanged]);

	// --- episode OK handler ---
	var handleEpisodeOk = useCallback(function (ep: MergedEpisode) {
		if (ep.unaired) {
			if (ep.airDate) onToast('Airs ' + ep.airDate, 'info');
			return;
		}
		if (ep.plexRatingKey) { playEpisode(ep); return; }
		if (hasArr) { setDlTarget(ep); setOverlay('dl-confirm'); setOverlayIdx(0); }
	}, [playEpisode, hasArr, onToast]);

	// --- key handling ---
	var handleKey = useCallback(function (e: KeyboardEvent) {
		var code = e.keyCode;

		// Overlay key handling
		if (overlay === 'more') {
			e.preventDefault();
			if (code === KEY.back || code === KEY.escape) { setOverlay(null); return; }
			if (code === KEY.up) { setOverlayIdx(function (i) { return Math.max(0, i - 1); }); return; }
			if (code === KEY.down) { setOverlayIdx(function (i) { return Math.min(moreItems.length - 1, i + 1); }); return; }
			if (code === KEY.enter) { doMoreAction(moreItems[overlayIdx] ? moreItems[overlayIdx].action : ''); return; }
			return;
		}
		if (overlay === 'season-actions') {
			e.preventDefault();
			if (code === KEY.back || code === KEY.escape) { setOverlay(null); return; }
			if (code === KEY.up) { setOverlayIdx(function (i) { return Math.max(0, i - 1); }); return; }
			if (code === KEY.down) { setOverlayIdx(function (i) { return Math.min(seasonActionItems.length - 1, i + 1); }); return; }
			if (code === KEY.enter) {
				var sa = seasonActionItems[overlayIdx];
				if (sa && sa.action === 'dl-season') doSeasonDownload();
				else setOverlay(null);
				return;
			}
			return;
		}
		if (overlay === 'dl-confirm') {
			e.preventDefault();
			if (code === KEY.back || code === KEY.escape) { setOverlay(null); setDlTarget(null); return; }
			if (code === KEY.left || code === KEY.right) { setOverlayIdx(function (i) { return i === 0 ? 1 : 0; }); return; }
			if (code === KEY.enter) {
				if (overlayIdx === 1 && dlTarget) doEpisodeDownload(dlTarget);
				else { setOverlay(null); setDlTarget(null); }
				return;
			}
			return;
		}
		if (overlay === 'wl-monitor') {
			e.preventDefault();
			if (code === KEY.back || code === KEY.escape) { setOverlay(null); return; }
			if (code === KEY.up) { setOverlayIdx(function (i) { return Math.max(0, i - 1); }); return; }
			if (code === KEY.down) { setOverlayIdx(function (i) { return Math.min(MONITOR_OPTS.length - 1, i + 1); }); return; }
			if (code === KEY.enter) { doWlAdd(MONITOR_OPTS[overlayIdx].key); return; }
			return;
		}
		if (overlay === 'wl-stop') {
			e.preventDefault();
			if (code === KEY.back || code === KEY.escape) { setOverlay(null); return; }
			if (code === KEY.left || code === KEY.right) { setOverlayIdx(function (i) { return i === 0 ? 1 : 0; }); return; }
			if (code === KEY.enter) {
				if (overlayIdx === 1) doWlStop();
				else setOverlay(null);
				return;
			}
			return;
		}
		if (overlay === 'remove-confirm') {
			e.preventDefault();
			if (code === KEY.back || code === KEY.escape) { setOverlay(null); return; }
			if (code === KEY.left || code === KEY.right) { setOverlayIdx(function (i) { return i === 0 ? 1 : 0; }); return; }
			if (code === KEY.enter) {
				if (overlayIdx === 1) doRemove();
				else setOverlay(null);
				return;
			}
			return;
		}

		// Main page
		e.preventDefault();
		if (code === KEY.back || code === KEY.escape) { onClose(); return; }

		if (zone === 'actions') {
			if (code === KEY.left) setActionIdx(function (i) { return Math.max(0, i - 1); });
			else if (code === KEY.right) setActionIdx(function (i) { return Math.min(actionBtns.length - 1, i + 1); });
			else if (code === KEY.down) {
				if (displaySeasons.length > 0) { setZone('seasons'); }
				else if (episodes.length > 0) { setZone('episodes'); setEpIdx(0); }
			}
			else if (code === KEY.enter) {
				var btn = actionBtns[actionIdx];
				if (btn) doAction(btn.action);
			}
			return;
		}

		if (zone === 'seasons') {
			var tabCount = displaySeasons.length + (hasArr ? 1 : 0);
			if (code === KEY.left) {
				if (seasonIdx > 0) { setSeasonIdx(seasonIdx - 1); setEpIdx(0); }
			}
			else if (code === KEY.right) {
				if (seasonIdx < tabCount - 1) setSeasonIdx(seasonIdx + 1);
			}
			else if (code === KEY.up) { setZone('actions'); }
			else if (code === KEY.down) {
				if (episodes.length > 0) { setZone('episodes'); setEpIdx(0); }
			}
			else if (code === KEY.enter) {
				if (seasonIdx >= displaySeasons.length) {
					setOverlay('season-actions');
					setOverlayIdx(0);
				}
			}
			return;
		}

		if (zone === 'episodes') {
			if (code === KEY.up) {
				if (epIdx > 0) setEpIdx(epIdx - 1);
				else setZone('seasons');
			}
			else if (code === KEY.down) { setEpIdx(function (i) { return Math.min(episodes.length - 1, i + 1); }); }
			else if (code === KEY.enter) {
				var ep = episodes[epIdx];
				if (ep) handleEpisodeOk(ep);
			}
			return;
		}
	}, [zone, actionIdx, seasonIdx, epIdx, overlay, overlayIdx, actionBtns, displaySeasons, episodes, moreItems, seasonActionItems, dlTarget, doAction, doMoreAction, doSeasonDownload, doEpisodeDownload, doWlAdd, doWlStop, doRemove, playEpisode, handleEpisodeOk, onClose, hasArr]);

	useKeyTrap(handleKey, open && active);

	if (!open) return null;

	var detail = tmdbDetail;
	var statusLabel = detail ? (detail.status === 'Returning Series' ? 'RETURNING' : detail.status === 'Ended' ? 'ENDED' : detail.status === 'Canceled' ? 'CANCELED' : detail.status ? detail.status.toUpperCase() : '') : '';
	var statusCls = detail && detail.status === 'Returning Series' ? ' show-detail__status--returning' : ' show-detail__status--ended';

	return (
		<div class={'show-detail' + (visible ? ' show-detail--open' : '')}>
			{/* Hero */}
			<div class="show-detail__hero">
				<div class="show-detail__hero-bd" style={heroUrl ? 'background-image:url(' + heroUrl + ')' : undefined} />
				<div class="show-detail__hero-scrim" />
				<div class="show-detail__hero-info">
					<h1 class="show-detail__title">{show.name}</h1>
					<div class="show-detail__meta">
						{yearOf(show.firstAir) && <span>{yearOf(show.firstAir)}</span>}
						{(detail ? detail.vote_average : show.rating) > 0 && <span>{'★ ' + (detail ? detail.vote_average : show.rating).toFixed(1)}</span>}
						{detail && detail.content_rating && <span class="show-detail__badge">{detail.content_rating}</span>}
						{statusLabel && <span class={'show-detail__status' + statusCls}>{statusLabel}</span>}
					</div>
					{isOnPlex && !plexError && plexShowMeta && (
						<div class="show-detail__server-badge">{'On your server · ' + (plexShowMeta.viewedLeafCount || 0) + '/' + (plexShowMeta.leafCount || 0) + ' watched'}</div>
					)}
					{plexError && (
						<div class="show-detail__server-badge show-detail__server-badge--error">Status unknown — Plex unreachable</div>
					)}
					{sonarrError && (
						<div class="show-detail__server-badge show-detail__server-badge--error">Sonarr unreachable</div>
					)}
					<p class="show-detail__synopsis">{detail ? detail.overview : show.overview}</p>
					<div class="show-detail__actions">
						{actionBtns.map(function (btn, i) {
							var cls = 'show-detail__action-btn';
							if (btn.primary) cls += ' show-detail__action-btn--primary';
							if (zone === 'actions' && i === actionIdx) cls += ' show-detail__action-btn--focused';
							return <button key={btn.action + i} class={cls}>{btn.primary ? '▶ ' + btn.label : btn.label}</button>;
						})}
					</div>
				</div>
			</div>

			{/* Season tabs */}
			{displaySeasons.length > 0 && (
				<div class="show-detail__seasons">
					<div class="show-detail__seasons-track" style={'transform:translate3d(' + (-seasonScrollX) + 'px,0,0)'}>
						{displaySeasons.map(function (s, i) {
							var cls = 'show-detail__season-tab';
							if (i === seasonIdx && (zone === 'seasons' || zone === 'episodes')) cls += ' show-detail__season-tab--active';
							if (zone === 'seasons' && i === seasonIdx) cls += ' show-detail__season-tab--focused';
							return <button key={s.season_number} class={cls}>{'Season ' + s.season_number}</button>;
						})}
						{hasArr && (
							<button class={'show-detail__season-tab show-detail__season-tab--actions' + (zone === 'seasons' && seasonIdx === displaySeasons.length ? ' show-detail__season-tab--focused' : '')}>
								{'⋯'}
							</button>
						)}
					</div>
				</div>
			)}

			{/* Episodes */}
			<div class="show-detail__episodes">
				{loading && <div class="show-detail__loading">Loading…</div>}
				{!loading && episodes.length === 0 && currentSeason && <div class="show-detail__loading">No episodes</div>}
				<div class="show-detail__episodes-inner" style={'transform:translate3d(0,' + (-scrollY) + 'px,0)'}>
					{episodes.map(function (ep, i) {
						var inView = i >= Math.max(0, epIdx - BUFFER_EPS - 1) && i <= epIdx + VISIBLE_EPS + BUFFER_EPS;
						if (!inView) return <div key={i} style={'height:' + (EP_ROW_H - 12) + 'px;margin-bottom:12px'} />;
						var cls = 'show-detail__episode';
						if (zone === 'episodes' && i === epIdx) cls += ' show-detail__episode--focused';
						if (ep.unaired) cls += ' show-detail__episode--unaired';
						var pct = ep.viewOffset > 0 && ep.duration > 0 ? Math.round(ep.viewOffset / ep.duration * 100) : 0;
						return (
							<div key={ep.seasonNum + ':' + ep.epNum} class={cls}>
								<div class="show-detail__ep-still">
									{ep.stillUrl
										? <img src={ep.stillUrl} alt="" loading="lazy" />
										: <div class="show-detail__ep-placeholder">{'S'}</div>}
								</div>
								<div class="show-detail__ep-info">
									<p class="show-detail__ep-title">{'E' + padTwo(ep.epNum) + ' — ' + ep.name}</p>
									{ep.overview && <p class="show-detail__ep-desc">{ep.overview}</p>}
									<p class="show-detail__ep-meta">
										{formatRuntime(ep.runtime)}
										{ep.airDate ? (ep.runtime ? ' · ' : '') + ep.airDate : ''}
									</p>
								</div>
								<div class="show-detail__ep-status">
									{ep.watched && <span class="show-detail__ep-watched">{'✓ Watched'}</span>}
									{!ep.watched && ep.onPlex && <span class="show-detail__ep-on-server">On server</span>}
									{ep.downloading && <span class="show-detail__ep-downloading">{'Downloading' + (ep.downloadPct > 0 ? ' ' + ep.downloadPct + '%' : '')}</span>}
									{ep.unaired && ep.airDate && <span class="show-detail__ep-airdate">{ep.airDate}</span>}
									{pct > 0 && (
										<div class="show-detail__ep-progress">
											<div class="show-detail__ep-progress-fill" style={'width:' + pct + '%'} />
										</div>
									)}
									{pct > 0 && <span class="show-detail__ep-progress-pct">{pct + '%'}</span>}
								</div>
							</div>
						);
					})}
				</div>
			</div>

			{/* Overlay scrim + dialogs */}
			{overlay && <div class="show-detail__overlay-scrim" />}

			{overlay === 'more' && (
				<div class="show-detail__overlay-center">
					{moreItems.map(function (item, i) {
						var cls = 'show-detail__action-btn';
						if (i === overlayIdx) cls += ' show-detail__action-btn--focused';
						return <button key={item.action} class={cls} style="display:block;width:100%;margin:0 0 8px">{item.label}</button>;
					})}
				</div>
			)}

			{overlay === 'season-actions' && (
				<div class="show-detail__overlay-center">
					{seasonActionItems.map(function (item, i) {
						var cls = 'show-detail__action-btn';
						if (i === overlayIdx) cls += ' show-detail__action-btn--focused';
						return <button key={item.action} class={cls} style="display:block;width:100%;margin:0 0 8px">{item.label}</button>;
					})}
				</div>
			)}

			{overlay === 'dl-confirm' && dlTarget && (
				<div class="show-detail__overlay-center">
					<p class="show-detail__overlay-title">{'Download ' + formatEpCode(dlTarget.seasonNum, dlTarget.epNum) + ' ' + dlTarget.name + '?'}</p>
					<div class="show-detail__overlay-row">
						<button class={'show-detail__action-btn' + (overlayIdx === 0 ? ' show-detail__action-btn--focused' : '')}>Cancel</button>
						<button class={'show-detail__action-btn show-detail__action-btn--primary' + (overlayIdx === 1 ? ' show-detail__action-btn--focused' : '')}>Download</button>
					</div>
				</div>
			)}

			{overlay === 'wl-monitor' && (
				<div class="show-detail__overlay-center">
					<p class="show-detail__overlay-title">Monitor which episodes?</p>
					{MONITOR_OPTS.map(function (opt, i) {
						var cls = 'show-detail__action-btn';
						if (i === overlayIdx) cls += ' show-detail__action-btn--focused';
						return <button key={opt.key} class={cls} style="display:block;width:100%;margin:0 0 8px">{opt.label}</button>;
					})}
				</div>
			)}

			{overlay === 'wl-stop' && (
				<div class="show-detail__overlay-center">
					<p class="show-detail__overlay-title">{'Stop monitoring ' + show.name + '?'}</p>
					<div class="show-detail__overlay-row">
						<button class={'show-detail__action-btn' + (overlayIdx === 0 ? ' show-detail__action-btn--focused' : '')}>Cancel</button>
						<button class={'show-detail__action-btn show-detail__action-btn--primary' + (overlayIdx === 1 ? ' show-detail__action-btn--focused' : '')}>Stop</button>
					</div>
				</div>
			)}

			{overlay === 'remove-confirm' && (
				<div class="show-detail__overlay-center">
					<p class="show-detail__overlay-title">{'Remove ' + show.name + '?'}</p>
					<p class="show-detail__overlay-warn">This is the only copy on your server. Downloaded files will be deleted. Torrents are not affected.</p>
					<div class="show-detail__overlay-row">
						<button class={'show-detail__action-btn' + (overlayIdx === 0 ? ' show-detail__action-btn--focused' : '')}>Cancel</button>
						<button class={'show-detail__action-btn show-detail__action-btn--primary' + (overlayIdx === 1 ? ' show-detail__action-btn--focused' : '')}>Remove</button>
					</div>
				</div>
			)}
		</div>
	);
}
