import {useCallback, useEffect, useMemo, useRef, useState} from 'preact/hooks';
import {useKeyTrap} from '../hooks/useKeyTrap';
import {KEY} from '../config/constants';
import {
	fetchTmdbShowDetail, fetchTmdbSeasonDetail, tmdbStillUrl,
	fetchTmdbMovieDetail, fetchTmdbCollection,
	type TmdbShowDetail, type TmdbEpisode, type TmdbSeason,
	type TmdbMovieDetail, type TmdbCollectionPart,
} from '../lib/tmdb';
import {
	fetchSeasons, fetchEpisodes, fetchShowMeta, plexStillUrl,
	type PlexItem, type PlexIndex,
} from '../lib/plex';
import {backdropUrl, yearOf, providerDef, findProviderApp, profileUrl, posterUrlLarge, type TrendingShow} from '../lib/trending';
import {launchApp} from '../lib/launch';
import {
	sonarrConn, radarrConn, watchlistCheckSeries, watchlistAddSeriesByTmdb, watchlistStopSeries,
	watchlistCheckMovie, watchlistAddMovie, watchlistStopMovie, downloadMovie,
	downloadSeries, sonarrQueue, resolveProfileId,
	type SonarrSeries, type SonarrEpisode, type RadarrMovie, type QueueRecord, type MonitorScope,
} from '../lib/arrapi';

interface Props {
	show: TrendingShow;
	open: boolean;
	active: boolean;
	onClose: () => void;
	onExitLeft?: () => void;
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
	radarrUrl: string;
	radarrKey: string;
	hasFetchbox: boolean;
	onSeedbox?: (name: string, year: string, mediaType: string) => void;
	enableDeleteActions: boolean;
	onWatchlistChanged: () => void;
	onOpenDetail?: (item: TrendingShow) => void;
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

type Zone = 'actions' | 'seasons' | 'episodes' | 'cast' | 'collection' | 'recs';
type Overlay = 'season-actions' | 'dl-confirm' | 'wl-monitor' | 'wl-stop' | 'remove-confirm' | null;

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

function formatSize(bytes: number | undefined): string {
	if (!bytes) return '';
	if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
	if (bytes >= 1048576) return Math.round(bytes / 1048576) + ' MB';
	return Math.round(bytes / 1024) + ' KB';
}

function formatRuntime(mins: number | null): string {
	if (!mins) return '';
	if (mins >= 60) return Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
	return mins + 'm';
}

export function ShowDetail({show, open, active, onClose, onExitLeft, onPlayPlex, onToast, onLaunch, apiKey, allowShell, plexUrl, plexToken, plexIdx, installedAppIds, isOnWatchlist, sonarrUrl, sonarrKey, radarrUrl, radarrKey, hasFetchbox, onSeedbox, enableDeleteActions, onWatchlistChanged, onOpenDetail}: Props) {
	var isMovie = show.mediaType === 'movie';
	var [tmdbDetail, setTmdbDetail] = useState<TmdbShowDetail | null>(null);
	var [seasonEps, setSeasonEps] = useState<Record<number, TmdbEpisode[]>>({});
	var [plexShowMeta, setPlexShowMeta] = useState<PlexItem | null>(null);
	var [plexSeasons, setPlexSeasons] = useState<PlexItem[] | null>(null);
	var [plexEpMap, setPlexEpMap] = useState<Record<string, PlexItem[]>>({});
	var [sonarrSeries, setSonarrSeries] = useState<SonarrSeries | null>(null);
	var [sonarrEps, setSonarrEps] = useState<SonarrEpisode[]>([]);
	var [radarrMovie, setRadarrMovie] = useState<RadarrMovie | null>(null);
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
	var [radarrError, setRadarrError] = useState(false);
	var [idMismatch, setIdMismatch] = useState(false);
	var [profileError, setProfileError] = useState(false);
	var [visible, setVisible] = useState(false);
	var [movieDetail, setMovieDetail] = useState<TmdbMovieDetail | null>(null);
	var [collectionParts, setCollectionParts] = useState<TmdbCollectionPart[] | null>(null);
	var [castIdx, setCastIdx] = useState(0);
	var [collectionIdx, setCollectionIdx] = useState(0);
	var [recsIdx, setRecsIdx] = useState(0);
	var prevShowId = useRef(-1);
	var dlBusy = useRef(false);

	var plexType = isMovie ? 'movie' : 'tv';
	var isOnPlex = !!(plexIdx && plexIdx.has(plexType as 'tv' | 'movie', show.id));
	var plexRk = plexIdx ? plexIdx.getRatingKey(plexType as 'tv' | 'movie', show.id) : null;
	var hasArr = isMovie ? !!(radarrUrl && radarrKey) : !!(sonarrUrl && sonarrKey);
	var sConn = useMemo(function () {
		return sonarrUrl && sonarrKey ? sonarrConn({sonarrUrl: sonarrUrl, sonarrKey: sonarrKey}) : null;
	}, [sonarrUrl, sonarrKey]);
	var rConn = useMemo(function () {
		return radarrUrl && radarrKey ? radarrConn({radarrUrl: radarrUrl, radarrKey: radarrKey}) : null;
	}, [radarrUrl, radarrKey]);

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
		setRadarrMovie(null);
		setQueueRecords([]);
		setPlexError(false);
		setSonarrError(false);
		setRadarrError(false);
		setIdMismatch(false);
		setProfileError(false);
		setZone('actions');
		setActionIdx(0);
		setSeasonIdx(0);
		setEpIdx(0);
		setOverlay(null);
		setMovieDetail(null);
		setCollectionParts(null);
		setCastIdx(0);
		setCollectionIdx(0);
		setRecsIdx(0);

		if (isMovie) {
			fetchTmdbMovieDetail(apiKey, show.id, allowShell).then(function (md) {
				setMovieDetail(md);
				setLoading(false);
				if (md.collection) {
					fetchTmdbCollection(apiKey, md.collection.id, allowShell).then(function (coll) {
						setCollectionParts(coll.parts);
					});
				}
			}).catch(function () { setLoading(false); });
			if (isOnPlex && plexRk && plexUrl && plexToken) {
				fetchShowMeta(plexUrl, plexToken, plexRk).then(function (meta) { setPlexShowMeta(meta); }).catch(function () { setPlexError(true); });
			}
			if (rConn) {
				resolveProfileId(rConn).catch(function () { setProfileError(true); });
				watchlistCheckMovie(rConn, show.id).then(function (existing) {
					setRadarrMovie(existing);
				}).catch(function () { setRadarrError(true); });
			}
		} else {
			fetchTmdbShowDetail(apiKey, show.id, allowShell).then(function (detail) {
				setTmdbDetail(detail);
				setLoading(false);
				var real = detail.seasons.filter(function (s) { return s.season_number > 0; });
				if (real.length === 0) real = detail.seasons;
				var lastIdx = 0;
				for (var i = 0; i < detail.seasons.length; i++) {
					if (detail.seasons[i].season_number === real[real.length - 1].season_number) { lastIdx = i; break; }
				}
				setSeasonIdx(lastIdx);
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
				resolveProfileId(sConn).catch(function () { setProfileError(true); });
				watchlistCheckSeries(sConn, show.id).then(function (check) {
					setSonarrSeries(check.existing);
					setSonarrEps(check.episodes);
					if (check.existing && check.existing.title.toLowerCase() !== show.name.toLowerCase() && check.existing.year !== (parseInt(show.firstAir, 10) || 0)) {
						setIdMismatch(true);
					}
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
		}
	}, [open, show.id, apiKey, allowShell, isMovie, isOnPlex, plexRk, plexUrl, plexToken, sConn, rConn]);

	useEffect(function () { if (!open) prevShowId.current = -1; }, [open]);

	// --- display seasons (skip S0 unless it's the only one) ---
	var displaySeasons: TmdbSeason[] = useMemo(function () {
		if (!tmdbDetail) return [];
		var real = tmdbDetail.seasons.filter(function (s) { return s.season_number > 0; });
		return real.length > 0 ? real : tmdbDetail.seasons;
	}, [tmdbDetail]);

	var currentSeason = displaySeasons[seasonIdx] || null;
	var currentSeasonNum = currentSeason ? currentSeason.season_number : -1;

	var seasonProgress: {total: number; watched: number}[] = useMemo(function () {
		return displaySeasons.map(function (s) {
			var total = s.episode_count || 0;
			var watched = 0;
			if (plexSeasons) {
				for (var i = 0; i < plexSeasons.length; i++) {
					if (plexSeasons[i].index === s.season_number) {
						watched = plexSeasons[i].viewedLeafCount || 0;
						if (plexSeasons[i].leafCount) total = Math.max(total, plexSeasons[i].leafCount!);
						break;
					}
				}
			}
			return {total: total, watched: watched};
		});
	}, [displaySeasons, plexSeasons]);

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
		var provSource = isMovie && movieDetail && movieDetail.providers.length > 0 ? movieDetail.providers : show.providers;
		if (isMovie) {
			if (isOnPlex) {
				btns.push({label: 'Play', action: 'play-movie', primary: true});
			} else {
				var provBtn: typeof btns[0] | null = null;
				for (var i = 0; i < provSource.length; i++) {
					var def = providerDef(provSource[i].id);
					if (!def) continue;
					var appId = findProviderApp(def, installedAppIds);
					if (appId) { provBtn = {label: 'Watch on ' + def.short, action: 'launch:' + appId, primary: true}; break; }
				}
				if (provBtn) btns.push(provBtn);
			}
		} else {
			if (isOnPlex) {
				if (resumeEp) btns.push({label: 'Resume ' + formatEpCode(resumeEp.seasonNum, resumeEp.epNum), action: 'resume', primary: true});
				else if (firstUnwatched && firstUnwatched.plexRatingKey) btns.push({label: 'Play ' + formatEpCode(firstUnwatched.seasonNum, firstUnwatched.epNum), action: 'play-next', primary: true});
				else btns.push({label: 'Play', action: 'play-first', primary: true});
			} else {
				var provBtn2: typeof btns[0] | null = null;
				for (var i2 = 0; i2 < provSource.length; i2++) {
					var def2 = providerDef(provSource[i2].id);
					if (!def2) continue;
					var appId2 = findProviderApp(def2, installedAppIds);
					if (appId2) { provBtn2 = {label: 'Watch on ' + def2.short, action: 'launch:' + appId2, primary: true}; break; }
				}
				if (provBtn2) btns.push(provBtn2);
			}
		}
		// Additional provider buttons (max 2, skip if already primary)
		var pc = 0;
		for (var j = 0; j < provSource.length && pc < 2; j++) {
			var pdef = providerDef(provSource[j].id);
			if (!pdef) continue;
			var aid = findProviderApp(pdef, installedAppIds);
			if (!aid) continue;
			var dup = false;
			for (var b = 0; b < btns.length; b++) { if (btns[b].action === 'launch:' + aid) { dup = true; break; } }
			if (!dup) { btns.push({label: pdef.short, action: 'launch:' + aid, primary: false}); pc++; }
		}
		if (isOnWatchlist) btns.push({label: 'On Watchlist ✓', action: 'wl-status', primary: false});
		else btns.push({label: 'Add to Watchlist', action: 'wl-add', primary: false});
		if (!isMovie && hasArr && sonarrSeries && !idMismatch && !profileError) btns.push({label: 'Search Now', action: 'search', primary: false});
		if (isMovie && hasArr && radarrMovie && !profileError) btns.push({label: 'Search Now', action: 'search-movie', primary: false});
		if (isMovie && hasArr && !isOnPlex && !profileError) btns.push({label: 'Download', action: 'dl-movie', primary: false});
		if (!hasArr && hasFetchbox && onSeedbox) btns.push({label: 'Seedbox', action: 'seedbox', primary: false});
		if (plexError || sonarrError || radarrError) btns.push({label: 'Retry', action: 'retry', primary: false});
		return btns;
	}, [isMovie, isOnPlex, resumeEp, firstUnwatched, show.providers, installedAppIds, isOnWatchlist, plexError, sonarrError, radarrError, hasArr, hasFetchbox, onSeedbox, sonarrSeries, radarrMovie, idMismatch, profileError, movieDetail]);


	// --- season action items ---
	var seasonActionItems: {label: string; action: string}[] = useMemo(function () {
		var items: {label: string; action: string}[] = [];
		if (currentSeason && !idMismatch && !profileError) items.push({label: 'Download Season ' + currentSeason.season_number, action: 'dl-season'});
		if (enableDeleteActions && sonarrSeries && !idMismatch) items.push({label: 'Remove from Library', action: 'remove'});
		items.push({label: 'Cancel', action: 'cancel'});
		return items;
	}, [currentSeason, idMismatch, profileError, enableDeleteActions, sonarrSeries]);

	// --- scroll offsets ---
	var scrollY = useMemo(function () {
		var maxScroll = Math.max(0, episodes.length - VISIBLE_EPS);
		var s = Math.max(0, Math.min(epIdx - 1, maxScroll));
		return s * EP_ROW_H;
	}, [epIdx, episodes.length]);

	var SEASON_ITEM_H = 80;
	var SEASON_VISIBLE = 7;
	var seasonScrollY = useMemo(function () {
		if (displaySeasons.length + (hasArr ? 1 : 0) <= SEASON_VISIBLE) return 0;
		var maxScroll = Math.max(0, (displaySeasons.length + (hasArr ? 1 : 0)) - SEASON_VISIBLE);
		var s = Math.max(0, Math.min(seasonIdx - 2, maxScroll));
		return s * SEASON_ITEM_H;
	}, [seasonIdx, displaySeasons.length, hasArr]);

	// --- hero URL ---
	var heroUrl = useMemo(function () {
		if (movieDetail && movieDetail.backdrop_path) return backdropUrl(movieDetail.backdrop_path);
		if (tmdbDetail && tmdbDetail.backdrop_path) return backdropUrl(tmdbDetail.backdrop_path);
		return backdropUrl(show.backdrop);
	}, [movieDetail, tmdbDetail, show.backdrop]);

	// --- movie body zones and scroll ---
	var movieZones: Zone[] = useMemo(function () {
		if (!isMovie || !movieDetail) return [];
		var zones: Zone[] = [];
		if (movieDetail.cast.length > 0) zones.push('cast');
		if (collectionParts && collectionParts.length > 1) zones.push('collection');
		if (movieDetail.recommendations.length > 0) zones.push('recs');
		return zones;
	}, [isMovie, movieDetail, collectionParts]);

	var MOVIE_CARD_W = 146;
	var MOVIE_SECTION_H = 280;
	var MOVIE_ROW_W = 1780;

	var movieBodyScrollY = useMemo(function () {
		if (!isMovie) return 0;
		var idx = movieZones.indexOf(zone);
		if (idx <= 0) return 0;
		return idx * MOVIE_SECTION_H;
	}, [zone, movieZones, isMovie]);

	var castScrollX = useMemo(function () {
		if (!movieDetail || movieDetail.cast.length === 0) return 0;
		var visible = Math.floor(MOVIE_ROW_W / MOVIE_CARD_W);
		var maxScroll = Math.max(0, movieDetail.cast.length - visible);
		return Math.max(0, Math.min(castIdx - 2, maxScroll)) * MOVIE_CARD_W;
	}, [castIdx, movieDetail]);

	var collectionScrollX = useMemo(function () {
		if (!collectionParts || collectionParts.length === 0) return 0;
		var visible = Math.floor(MOVIE_ROW_W / MOVIE_CARD_W);
		var maxScroll = Math.max(0, collectionParts.length - visible);
		return Math.max(0, Math.min(collectionIdx - 2, maxScroll)) * MOVIE_CARD_W;
	}, [collectionIdx, collectionParts]);

	var recsScrollX = useMemo(function () {
		if (!movieDetail || movieDetail.recommendations.length === 0) return 0;
		var visible = Math.floor(MOVIE_ROW_W / MOVIE_CARD_W);
		var maxScroll = Math.max(0, movieDetail.recommendations.length - visible);
		return Math.max(0, Math.min(recsIdx - 2, maxScroll)) * MOVIE_CARD_W;
	}, [recsIdx, movieDetail]);

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
			if (!isMovie) fetchSeasons(plexUrl, plexToken, plexRk).then(function (s) { setPlexSeasons(s); }).catch(function () { setPlexError(true); });
		}
		if (sonarrError && sConn && !isMovie) {
			setSonarrError(false);
			watchlistCheckSeries(sConn, show.id).then(function (check) {
				setSonarrSeries(check.existing);
				setSonarrEps(check.episodes);
			}).catch(function () { setSonarrError(true); });
		}
		if (radarrError && rConn && isMovie) {
			setRadarrError(false);
			watchlistCheckMovie(rConn, show.id).then(function (existing) {
				setRadarrMovie(existing);
			}).catch(function () { setRadarrError(true); });
		}
	}, [plexError, sonarrError, radarrError, isMovie, isOnPlex, plexRk, plexUrl, plexToken, sConn, rConn, show.id]);

	var doAction = useCallback(function (action: string) {
		if (action === 'play-movie') {
			if (plexRk && onPlayPlex) onPlayPlex(plexRk, show.name);
			else launchApp(PLEX_APP).catch(function () { onToast("Couldn't open Plex", 'error'); });
		} else if (action === 'resume' && resumeEp && resumeEp.plexRatingKey) {
			playEpisode(resumeEp);
		} else if (action === 'play-next' && firstUnwatched) {
			playEpisode(firstUnwatched);
		} else if (action === 'play-first') {
			for (var i = 0; i < episodes.length; i++) {
				if (episodes[i].plexRatingKey) { playEpisode(episodes[i]); return; }
			}
			launchApp(PLEX_APP).catch(function () { onToast("Couldn't open Plex", 'error'); });
		} else if (action === 'wl-add') {
			if (!isMovie && idMismatch) { onToast("Couldn't verify this show", 'error'); return; }
			if (profileError) { onToast("Quality profile 'HD-1080p' not found (Settings → Connections)", 'error'); return; }
			if (isMovie) {
				if (rConn) {
					onToast('Adding ' + show.name + '...');
					watchlistCheckMovie(rConn, show.id).then(function (existing) {
						watchlistAddMovie(rConn!, show.id, existing).then(function (result) {
							onToast(result.title + ' added to watchlist');
							setRadarrMovie(existing || ({tmdbId: show.id, monitored: true} as RadarrMovie));
							onWatchlistChanged();
						}).catch(function (e) { onToast(e && e.message || 'Failed to add', 'error'); });
					}).catch(function (e) { onToast(e && e.message || 'Failed to add', 'error'); });
				} else { onToast('Connect Radarr in Settings to add movies', 'info'); }
			} else {
				if (hasArr) { setOverlay('wl-monitor'); setOverlayIdx(0); }
				else onToast('Connect Sonarr in Settings to add to Watchlist', 'info');
			}
		} else if (action === 'wl-status') {
			setOverlay('wl-stop');
			setOverlayIdx(0);
		} else if (action === 'search' && sConn && sonarrSeries) {
			onToast('Searching for ' + show.name + '...');
			downloadSeries(sConn, {tvdbId: sonarrSeries.tvdbId}, 'all').then(function (r) {
				onToast('Searching ' + r.monitoredCount + ' episodes');
			}).catch(function (e) { onToast(e && e.message || 'Search failed', 'error'); });
		} else if (action === 'search-movie' && rConn) {
			onToast('Searching for ' + show.name + '...');
			downloadMovie(rConn, show.id).then(function (r) {
				onToast(r.title + ' search started');
			}).catch(function (e) { onToast(e && e.message || 'Search failed', 'error'); });
		} else if (action === 'dl-movie' && rConn) {
			if (profileError) { onToast("Quality profile 'HD-1080p' not found (Settings → Connections)", 'error'); return; }
			onToast('Downloading ' + show.name + '...');
			downloadMovie(rConn, show.id).then(function (r) {
				onToast(r.title + (r.alreadyHasFile ? ' already on server' : ' download started'));
				onWatchlistChanged();
			}).catch(function (e) { onToast(e && e.message || 'Download failed', 'error'); });
		} else if (action === 'seedbox' && onSeedbox) {
			onSeedbox(show.name, yearOf(show.firstAir), show.mediaType);
		} else if (action === 'retry') {
			retryFetch();
		} else if (action.indexOf('launch:') === 0) {
			onLaunch(action.slice(7));
		}
	}, [isMovie, plexRk, resumeEp, firstUnwatched, episodes, playEpisode, hasArr, hasFetchbox, idMismatch, profileError, onLaunch, onToast, onPlayPlex, onSeedbox, retryFetch, sConn, rConn, sonarrSeries, radarrMovie, show, onWatchlistChanged]);


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
		if (isMovie) {
			if (!rConn || !radarrMovie) return;
			setOverlay(null);
			watchlistStopMovie(rConn, radarrMovie).then(function () {
				onToast(show.name + ' — stopped monitoring');
				onWatchlistChanged();
				setRadarrMovie(null);
			}).catch(function (e) { onToast(e && e.message || 'Failed', 'error'); });
		} else {
			if (!sConn || !sonarrSeries) return;
			setOverlay(null);
			watchlistStopSeries(sConn, sonarrSeries).then(function () {
				onToast(show.name + ' — stopped monitoring');
				onWatchlistChanged();
				setSonarrSeries(null);
				setSonarrEps([]);
			}).catch(function (e) { onToast(e && e.message || 'Failed', 'error'); });
		}
	}, [isMovie, sConn, rConn, sonarrSeries, radarrMovie, show, onToast, onWatchlistChanged]);

	var doEpisodeDownload = useCallback(function (ep: MergedEpisode) {
		if (!sConn || dlBusy.current) return;
		var dlId: number | {tvdbId: number} = sonarrSeries ? {tvdbId: sonarrSeries.tvdbId} : show.id;
		setOverlay(null);
		setDlTarget(null);
		dlBusy.current = true;
		onToast('Downloading ' + formatEpCode(ep.seasonNum, ep.epNum) + '...');
		if (ep.sonarrEpId) {
			downloadSeries(sConn, dlId, {episode: ep.sonarrEpId}).then(function () {
				dlBusy.current = false;
				onToast(formatEpCode(ep.seasonNum, ep.epNum) + ' queued');
				if (sonarrSeries) {
					sonarrQueue(sConn!).then(function (q) {
						var recs: QueueRecord[] = [];
						for (var i = 0; i < q.records.length; i++) { if (q.records[i].seriesId === sonarrSeries!.id) recs.push(q.records[i]); }
						setQueueRecords(recs);
					}).catch(function () { setSonarrError(true); });
				}
			}).catch(function (e) { dlBusy.current = false; onToast(e && e.message || 'Download failed', 'error'); });
		} else {
			downloadSeries(sConn, dlId, {season: ep.seasonNum}).then(function () {
				dlBusy.current = false;
				onToast('Season ' + ep.seasonNum + ' queued');
			}).catch(function (e) { dlBusy.current = false; onToast(e && e.message || 'Download failed', 'error'); });
		}
	}, [sConn, show.id, sonarrSeries, onToast]);

	var doSeasonDownload = useCallback(function () {
		if (!sConn || !currentSeason || dlBusy.current) return;
		var dlId: number | {tvdbId: number} = sonarrSeries ? {tvdbId: sonarrSeries.tvdbId} : show.id;
		setOverlay(null);
		dlBusy.current = true;
		onToast('Downloading Season ' + currentSeason.season_number + '...');
		downloadSeries(sConn, dlId, {season: currentSeason.season_number}).then(function (r) {
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
		if (idMismatch) { onToast("Couldn't verify this show", 'error'); return; }
		if (profileError) { onToast("Quality profile 'HD-1080p' not found in Sonarr (Settings → Connections)", 'error'); return; }
		if (hasArr) { setDlTarget(ep); setOverlay('dl-confirm'); setOverlayIdx(0); return; }
		onToast("Sonarr isn't configured (Settings → Connections)", 'info');
	}, [playEpisode, hasArr, idMismatch, profileError, onToast]);

	// --- key handling ---
	var handleKey = useCallback(function (e: KeyboardEvent) {
		var code = e.keyCode;

		// Overlay key handling
		if (overlay === 'season-actions') {
			e.preventDefault();
			if (code === KEY.back || code === KEY.escape) { setOverlay(null); return; }
			if (code === KEY.up) { setOverlayIdx(function (i) { return Math.max(0, i - 1); }); return; }
			if (code === KEY.down) { setOverlayIdx(function (i) { return Math.min(seasonActionItems.length - 1, i + 1); }); return; }
			if (code === KEY.enter) {
				var sa = seasonActionItems[overlayIdx];
				if (sa && sa.action === 'dl-season') doSeasonDownload();
				else if (sa && sa.action === 'remove') { setOverlay('remove-confirm'); setOverlayIdx(0); }
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
			if (code === KEY.left) {
				if (actionIdx === 0 && onExitLeft) onExitLeft();
				else setActionIdx(function (i) { return Math.max(0, i - 1); });
			}
			else if (code === KEY.right) setActionIdx(function (i) { return Math.min(actionBtns.length - 1, i + 1); });
			else if (code === KEY.down) {
				if (isMovie) {
					if (movieZones.length > 0) setZone(movieZones[0]);
				} else {
					if (displaySeasons.length > 0) { setZone('seasons'); }
					else if (episodes.length > 0) { setZone('episodes'); setEpIdx(0); }
				}
			}
			else if (code === KEY.enter) {
				var btn = actionBtns[actionIdx];
				if (btn) doAction(btn.action);
			}
			return;
		}

		if (zone === 'cast' || zone === 'collection' || zone === 'recs') {
			var mzIdx = movieZones.indexOf(zone);
			if (code === KEY.up) {
				if (mzIdx > 0) setZone(movieZones[mzIdx - 1]);
				else setZone('actions');
			} else if (code === KEY.down) {
				if (mzIdx < movieZones.length - 1) setZone(movieZones[mzIdx + 1]);
			} else if (code === KEY.left) {
				if (zone === 'cast') setCastIdx(function (i) { return Math.max(0, i - 1); });
				else if (zone === 'collection') setCollectionIdx(function (i) { return Math.max(0, i - 1); });
				else setRecsIdx(function (i) { return Math.max(0, i - 1); });
			} else if (code === KEY.right) {
				if (zone === 'cast' && movieDetail) setCastIdx(function (i) { return Math.min(movieDetail!.cast.length - 1, i + 1); });
				else if (zone === 'collection' && collectionParts) setCollectionIdx(function (i) { return Math.min(collectionParts!.length - 1, i + 1); });
				else if (zone === 'recs' && movieDetail) setRecsIdx(function (i) { return Math.min(movieDetail!.recommendations.length - 1, i + 1); });
			} else if (code === KEY.enter) {
				if (zone === 'collection' && collectionParts && onOpenDetail) {
					var cPart = collectionParts[collectionIdx];
					if (cPart && cPart.id !== show.id) {
						onOpenDetail({id: cPart.id, name: cPart.title, mediaType: 'movie', overview: '', firstAir: cPart.release_date, rating: cPart.vote_average, poster: cPart.poster_path, backdrop: null, providers: []});
					}
				} else if (zone === 'recs' && movieDetail && onOpenDetail) {
					var recItem = movieDetail.recommendations[recsIdx];
					if (recItem) onOpenDetail(recItem);
				}
			}
			return;
		}

		if (zone === 'seasons') {
			var tabCount = displaySeasons.length + (hasArr ? 1 : 0);
			if (code === KEY.up) {
				if (seasonIdx > 0) { setSeasonIdx(seasonIdx - 1); setEpIdx(0); }
				else setZone('actions');
			}
			else if (code === KEY.down) {
				if (seasonIdx < tabCount - 1) { setSeasonIdx(seasonIdx + 1); setEpIdx(0); }
			}
			else if (code === KEY.right) {
				if (episodes.length > 0) { setZone('episodes'); setEpIdx(0); }
			}
			else if (code === KEY.left) {
				if (onExitLeft) onExitLeft();
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
			if (code === KEY.left) {
				setZone('seasons');
			}
			else if (code === KEY.up) {
				if (epIdx > 0) setEpIdx(epIdx - 1);
				else setZone('actions');
			}
			else if (code === KEY.down) { setEpIdx(function (i) { return Math.min(episodes.length - 1, i + 1); }); }
			else if (code === KEY.enter) {
				var ep = episodes[epIdx];
				if (ep) handleEpisodeOk(ep);
			}
			return;
		}
	}, [zone, actionIdx, seasonIdx, epIdx, overlay, overlayIdx, actionBtns, displaySeasons, episodes, seasonActionItems, dlTarget, doAction, doSeasonDownload, doEpisodeDownload, doWlAdd, doWlStop, doRemove, playEpisode, handleEpisodeOk, onClose, onExitLeft, hasArr, isMovie, movieZones, movieDetail, collectionParts, castIdx, collectionIdx, recsIdx, onOpenDetail, show.id]);

	useKeyTrap(handleKey, open && active);

	if (!open) return null;

	var detail = tmdbDetail;
	var statusLabel = !isMovie && detail ? (detail.status === 'Returning Series' ? 'RETURNING' : detail.status === 'Ended' ? 'ENDED' : detail.status === 'Canceled' ? 'CANCELED' : detail.status ? detail.status.toUpperCase() : '') : '';
	var statusCls = detail && detail.status === 'Returning Series' ? ' show-detail__status--returning' : ' show-detail__status--ended';
	var displayRating = isMovie ? (movieDetail ? movieDetail.vote_average : show.rating) : (detail ? detail.vote_average : show.rating);
	var displayCert = isMovie ? (movieDetail ? movieDetail.certification : null) : (detail ? detail.content_rating : null);
	var displayOverview = isMovie ? (movieDetail ? movieDetail.overview : show.overview) : (detail ? detail.overview : show.overview);

	return (
		<div class={'show-detail' + (visible ? ' show-detail--open' : '') + (overlay ? ' show-detail--overlay' : '')}>
			{/* Hero */}
			<div class="show-detail__hero">
				<div class="show-detail__hero-bd" style={heroUrl ? 'background-image:url(' + heroUrl + ')' : undefined} />
				<div class="show-detail__hero-scrim" />
				<div class="show-detail__hero-info">
					<h1 class="show-detail__title">{show.name}</h1>
					<div class="show-detail__meta">
						{yearOf(show.firstAir) && <span>{yearOf(show.firstAir)}</span>}
						{displayRating > 0 && <span>{'★ ' + displayRating.toFixed(1)}</span>}
						{isMovie && movieDetail && movieDetail.runtime > 0 && <span>{formatRuntime(movieDetail.runtime)}</span>}
						{displayCert && <span class="show-detail__badge">{displayCert}</span>}
						{statusLabel && <span class={'show-detail__status' + statusCls}>{statusLabel}</span>}
					</div>
					{isOnPlex && !plexError && isMovie && (
						<div class="show-detail__server-badge">On your server</div>
					)}
					{isOnPlex && !plexError && !isMovie && plexShowMeta && (
						<div class="show-detail__server-badge">{'On your server · ' + (plexShowMeta.viewedLeafCount || 0) + '/' + (plexShowMeta.leafCount || 0) + ' watched'}</div>
					)}
					{plexError && (
						<div class="show-detail__server-badge show-detail__server-badge--error">Status unknown — Plex unreachable</div>
					)}
					{sonarrError && (
						<div class="show-detail__server-badge show-detail__server-badge--error">Sonarr unreachable</div>
					)}
					{radarrError && (
						<div class="show-detail__server-badge show-detail__server-badge--error">Radarr unreachable</div>
					)}
					{idMismatch && (
						<div class="show-detail__server-badge show-detail__server-badge--error">{"Couldn't verify this show — Sonarr actions disabled"}</div>
					)}
					{profileError && !idMismatch && (
						<div class="show-detail__server-badge show-detail__server-badge--error">{"Quality profile 'HD-1080p' not found — downloads disabled (Settings → Connections)"}</div>
					)}
					<p class="show-detail__synopsis">{displayOverview}</p>
					<div class="show-detail__actions">
						{actionBtns.map(function (btn, i) {
							var cls = 'show-detail__action-btn';
							if (btn.primary) cls += ' show-detail__action-btn--primary';
							if (zone === 'actions' && i === actionIdx) cls += ' show-detail__action-btn--focused';
							return <button key={btn.action + i} class={cls} onClick={function () { setZone('actions'); setActionIdx(i); doAction(btn.action); }}>{btn.primary ? '▶ ' + btn.label : btn.label}</button>;
						})}
					</div>
				</div>
			</div>

			{/* Two-column body: seasons left, episodes right (TV only) */}
			{!isMovie && <div class="show-detail__body">
				{displaySeasons.length > 0 && (
					<div class="show-detail__seasons">
						<div class="show-detail__seasons-track" style={'transform:translate3d(0,' + (-seasonScrollY) + 'px,0)'}>
							{displaySeasons.map(function (s, i) {
								var prog = seasonProgress[i];
								var cls = 'show-detail__season-item';
								if (i === seasonIdx && (zone === 'seasons' || zone === 'episodes')) cls += ' show-detail__season-item--active';
								if (zone === 'seasons' && i === seasonIdx) cls += ' show-detail__season-item--focused';
								var pctW = prog && prog.total > 0 ? Math.round(prog.watched / prog.total * 100) : 0;
								return (
									<div key={s.season_number} class={cls} onClick={function () { setZone('seasons'); setSeasonIdx(i); setEpIdx(0); }}>
										<p class="show-detail__season-label">{'Season ' + s.season_number}</p>
										<p class="show-detail__season-count">{(prog ? prog.total : s.episode_count || 0) + ' episodes' + (prog && prog.watched > 0 ? ' · ' + prog.watched + ' watched' : '')}</p>
										{prog && prog.watched > 0 && (
											<div class="show-detail__season-progress">
												<div class="show-detail__season-progress-fill" style={'width:' + pctW + '%'} />
											</div>
										)}
									</div>
								);
							})}
							{hasArr && (
								<div class={'show-detail__season-item show-detail__season-item--actions' + (zone === 'seasons' && seasonIdx === displaySeasons.length ? ' show-detail__season-item--focused' : '')} onClick={function () { setZone('seasons'); setSeasonIdx(displaySeasons.length); setOverlay('season-actions'); setOverlayIdx(0); }}>
									<p class="show-detail__season-label">{'Actions ⋯'}</p>
								</div>
							)}
						</div>
					</div>
				)}

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
								<div key={ep.seasonNum + ':' + ep.epNum} class={cls} onClick={function () { setZone('episodes'); setEpIdx(i); handleEpisodeOk(ep); }}>
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
			</div>}

			{/* Movie body: tagline, genres, cast, collection, recommendations */}
			{isMovie && movieDetail && (
				<div class="show-detail__movie-body">
					<div class="show-detail__movie-track" style={'transform:translate3d(0,' + (-movieBodyScrollY) + 'px,0)'}>
						{movieDetail.tagline && <p class="show-detail__tagline">{movieDetail.tagline}</p>}
						{movieDetail.genres.length > 0 && (
							<p class="show-detail__genres">{movieDetail.genres.map(function (g) { return g.name; }).join(' · ')}</p>
						)}
						{movieDetail.cast.length > 0 && (
							<div class="show-detail__section">
								<p class="show-detail__section-title">Cast</p>
								<div class="show-detail__row-wrap">
									<div class="show-detail__row-track" style={'transform:translate3d(' + (-castScrollX) + 'px,0,0)'}>
										{movieDetail.cast.map(function (c, i) {
											var cls = 'show-detail__card show-detail__card--cast';
											if (zone === 'cast' && i === castIdx) cls += ' show-detail__card--focused';
											return (
												<div key={c.id} class={cls}>
													<div class="show-detail__card-photo">
														{c.profile_path ? <img src={profileUrl(c.profile_path) || ''} alt="" loading="lazy" /> : <div class="show-detail__card-photo-empty" />}
													</div>
													<p class="show-detail__card-name">{c.name}</p>
													<p class="show-detail__card-sub">{c.character}</p>
												</div>
											);
										})}
									</div>
								</div>
							</div>
						)}
						{collectionParts && collectionParts.length > 1 && movieDetail.collection && (
							<div class="show-detail__section">
								<p class="show-detail__section-title">{movieDetail.collection.name}</p>
								<div class="show-detail__row-wrap">
									<div class="show-detail__row-track" style={'transform:translate3d(' + (-collectionScrollX) + 'px,0,0)'}>
										{collectionParts.map(function (p, i) {
											var cls = 'show-detail__card show-detail__card--poster';
											if (zone === 'collection' && i === collectionIdx) cls += ' show-detail__card--focused';
											if (p.id === show.id) cls += ' show-detail__card--current';
											return (
												<div key={p.id} class={cls}>
													<div class="show-detail__card-poster">
														{p.poster_path ? <img src={posterUrlLarge(p.poster_path) || ''} alt="" loading="lazy" /> : <div class="show-detail__card-poster-empty" />}
													</div>
													<p class="show-detail__card-name">{p.title}</p>
													<p class="show-detail__card-sub">{yearOf(p.release_date) + (p.vote_average > 0 ? ' · ★ ' + p.vote_average.toFixed(1) : '')}</p>
												</div>
											);
										})}
									</div>
								</div>
							</div>
						)}
						{movieDetail.recommendations.length > 0 && (
							<div class="show-detail__section">
								<p class="show-detail__section-title">More Like This</p>
								<div class="show-detail__row-wrap">
									<div class="show-detail__row-track" style={'transform:translate3d(' + (-recsScrollX) + 'px,0,0)'}>
										{movieDetail.recommendations.map(function (r, i) {
											var cls = 'show-detail__card show-detail__card--poster';
											if (zone === 'recs' && i === recsIdx) cls += ' show-detail__card--focused';
											return (
												<div key={r.id} class={cls}>
													<div class="show-detail__card-poster">
														{r.poster ? <img src={posterUrlLarge(r.poster) || ''} alt="" loading="lazy" /> : <div class="show-detail__card-poster-empty" />}
													</div>
													<p class="show-detail__card-name">{r.name}</p>
													<p class="show-detail__card-sub">{yearOf(r.firstAir) + (r.rating > 0 ? ' · ★ ' + r.rating.toFixed(1) : '')}</p>
												</div>
											);
										})}
									</div>
								</div>
							</div>
						)}
					</div>
				</div>
			)}

			{/* Overlay scrim + dialogs */}
			{overlay && <div class="show-detail__overlay-scrim" />}

			{overlay === 'season-actions' && (
				<div class="show-detail__overlay-center">
					{seasonActionItems.map(function (item, i) {
						var cls = 'show-detail__action-btn';
						if (i === overlayIdx) cls += ' show-detail__action-btn--focused';
						return <button key={item.action} class={cls} style="display:block;width:100%;margin:0 0 8px" onClick={function () {
						if (item.action === 'cancel') setOverlay(null);
						else if (item.action === 'dl-season') doSeasonDownload();
						else if (item.action === 'remove') { setOverlay('remove-confirm'); setOverlayIdx(0); }
					}}>{item.label}</button>;
					})}
				</div>
			)}

			{overlay === 'dl-confirm' && dlTarget && (
				<div class="show-detail__overlay-center">
					<p class="show-detail__overlay-title">{'Download ' + formatEpCode(dlTarget.seasonNum, dlTarget.epNum) + ' ' + dlTarget.name + '?'}</p>
					<div class="show-detail__overlay-row">
						<button class={'show-detail__action-btn' + (overlayIdx === 0 ? ' show-detail__action-btn--focused' : '')} onClick={function () { setOverlay(null); setDlTarget(null); }}>Cancel</button>
						<button class={'show-detail__action-btn show-detail__action-btn--primary' + (overlayIdx === 1 ? ' show-detail__action-btn--focused' : '')} onClick={function () { if (dlTarget) doEpisodeDownload(dlTarget); }}>Download</button>
					</div>
				</div>
			)}

			{overlay === 'wl-monitor' && (
				<div class="show-detail__overlay-center">
					<p class="show-detail__overlay-title">Monitor which episodes?</p>
					{MONITOR_OPTS.map(function (opt, i) {
						var cls = 'show-detail__action-btn';
						if (i === overlayIdx) cls += ' show-detail__action-btn--focused';
						return <button key={opt.key} class={cls} style="display:block;width:100%;margin:0 0 8px" onClick={function () { doWlAdd(opt.key); }}>{opt.label}</button>;
					})}
				</div>
			)}

			{overlay === 'wl-stop' && (
				<div class="show-detail__overlay-center">
					<p class="show-detail__overlay-title">{'Stop monitoring ' + show.name + '?'}</p>
					<div class="show-detail__overlay-row">
						<button class={'show-detail__action-btn' + (overlayIdx === 0 ? ' show-detail__action-btn--focused' : '')} onClick={function () { setOverlay(null); }}>Cancel</button>
						<button class={'show-detail__action-btn show-detail__action-btn--primary' + (overlayIdx === 1 ? ' show-detail__action-btn--focused' : '')} onClick={function () { doWlStop(); }}>Stop</button>
					</div>
				</div>
			)}

			{overlay === 'remove-confirm' && (
				<div class="show-detail__overlay-center">
					<p class="show-detail__overlay-title">{'Remove ' + show.name + (sonarrSeries && sonarrSeries.statistics && sonarrSeries.statistics.sizeOnDisk ? ' (' + formatSize(sonarrSeries.statistics.sizeOnDisk) + ')' : '') + '?'}</p>
					<p class="show-detail__overlay-warn">This may be the only copy of this file if the torrent is no longer in Deluge. The torrent itself isn't touched.</p>
					<div class="show-detail__overlay-row">
						<button class={'show-detail__action-btn' + (overlayIdx === 0 ? ' show-detail__action-btn--focused' : '')} onClick={function () { setOverlay(null); }}>Cancel</button>
						<button class={'show-detail__action-btn show-detail__action-btn--primary' + (overlayIdx === 1 ? ' show-detail__action-btn--focused' : '')} onClick={function () { doRemove(); }}>Remove</button>
					</div>
				</div>
			)}
		</div>
	);
}
