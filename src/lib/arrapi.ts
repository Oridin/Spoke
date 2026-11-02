import {exec} from './apps';

const TMP_BODY = '/tmp/spoke-api-body.json';
const TMP_RESP = '/tmp/spoke-api-resp.json';

function shellQuote (s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

function writeTemp (json: string): Promise<void> {
	return exec('printf %s ' + shellQuote(json) + ' > ' + TMP_BODY, 5000).then(() => undefined);
}

export interface ApiCallOptions {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: unknown;
	timeout?: number;
}

export function apiCall (opts: ApiCallOptions): Promise<string> {
	const method = opts.method || 'GET';
	const timeout = opts.timeout || 30000;
	const headerArgs = Object.entries(opts.headers || {}).map(([k, v]) => `-H ${shellQuote(k + ': ' + v)}`).join(' ');
	const prepare = opts.body !== undefined
		? writeTemp(JSON.stringify(opts.body))
		: Promise.resolve();
	return prepare.then(() => {
		const bodyArg = opts.body !== undefined ? ` -d @${TMP_BODY}` : '';
		const cmd = `curl -s -X ${method} ${headerArgs}${bodyArg} ${shellQuote(opts.url)}`;
		return exec(cmd, timeout);
	});
}

export function apiCallLarge (opts: ApiCallOptions): Promise<string> {
	const method = opts.method || 'GET';
	const timeout = opts.timeout || 30000;
	const headerArgs = Object.entries(opts.headers || {}).map(([k, v]) => `-H ${shellQuote(k + ': ' + v)}`).join(' ');
	const bodyArg = opts.body !== undefined ? ` -d @${TMP_BODY}` : '';
	const prepare = opts.body !== undefined
		? writeTemp(JSON.stringify(opts.body))
		: Promise.resolve();
	return prepare.then(() => {
		return exec(`curl -s -X ${method} ${headerArgs}${bodyArg} ${shellQuote(opts.url)} > ${TMP_RESP} && echo OK`, timeout);
	}).then(function (result) {
		if (result.trim() !== 'OK') return Promise.reject(new Error('curl failed'));
		return exec('wc -c < ' + TMP_RESP, 5000);
	}).then(function (sizeStr) {
		var size = parseInt(sizeStr.trim(), 10) || 0;
		if (size === 0) return '';
		if (size <= 60000) return exec('cat ' + TMP_RESP, timeout);
		var parts: string[] = [];
		var offset = 0;
		function next (): Promise<string> {
			if (offset >= size) return Promise.resolve(parts.join(''));
			var end = offset + 60000;
			return exec('tail -c +' + (offset + 1) + ' ' + TMP_RESP + ' | head -c 60000', timeout).then(function (chunk) {
				parts.push(chunk);
				offset = end;
				return next();
			});
		}
		return next();
	});
}

export interface TestResult { ok: boolean; message: string }

export function testSonarr (url: string, key: string): Promise<TestResult> {
	const base = url.replace(/\/+$/, '');
	return apiCall({url: `${base}/api/v3/system/status`, headers: {'X-Api-Key': key}})
		.then((text) => {
			const data = JSON.parse(text) as {version?: string};
			return data.version
				? {ok: true, message: `Sonarr v${data.version}`}
				: {ok: false, message: 'Unexpected response'};
		})
		.catch((e: Error) => ({ok: false, message: e.message || 'Connection failed'}));
}

export function testRadarr (url: string, key: string): Promise<TestResult> {
	const base = url.replace(/\/+$/, '');
	return apiCall({url: `${base}/api/v3/system/status`, headers: {'X-Api-Key': key}})
		.then((text) => {
			const data = JSON.parse(text) as {version?: string};
			return data.version
				? {ok: true, message: `Radarr v${data.version}`}
				: {ok: false, message: 'Unexpected response'};
		})
		.catch((e: Error) => ({ok: false, message: e.message || 'Connection failed'}));
}

export function testPlex (url: string, token: string): Promise<TestResult> {
	const base = url.replace(/\/+$/, '');
	return apiCall({url: `${base}/identity`, headers: {'X-Plex-Token': token, Accept: 'application/json'}})
		.then((text) => {
			const data = JSON.parse(text) as {MediaContainer?: {machineIdentifier?: string; version?: string}};
			const mc = data.MediaContainer;
			return mc && mc.version
				? {ok: true, message: `Plex v${mc.version}`}
				: {ok: false, message: 'Unexpected response'};
		})
		.catch((e: Error) => ({ok: false, message: e.message || 'Connection failed'}));
}

export function testTmdb (key: string): Promise<TestResult> {
	return apiCall({url: `https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(key)}`})
		.then((text) => {
			const data = JSON.parse(text) as {images?: {base_url?: string}; status_message?: string};
			return data.images
				? {ok: true, message: 'TMDB OK'}
				: {ok: false, message: data.status_message || 'Invalid key'};
		})
		.catch((e: Error) => ({ok: false, message: e.message || 'Connection failed'}));
}

export function testFetchbox (url: string, passcode: string): Promise<TestResult> {
	const base = url.replace(/\/+$/, '');
	return apiCall({url: `${base}/api/login`, method: 'POST', headers: {'Content-Type': 'application/json'}, body: {passcode}})
		.then((text) => {
			const data = JSON.parse(text) as {ok?: boolean; error?: string};
			return data.ok
				? {ok: true, message: 'Fetchbox OK'}
				: {ok: false, message: data.error || 'Login failed'};
		})
		.catch((e: Error) => ({ok: false, message: e.message || 'Connection failed'}));
}

// ---------------------------------------------------------------------------
// Sonarr / Radarr types
// ---------------------------------------------------------------------------

export interface ArrImage {
	coverType: string;
	remoteUrl?: string;
	url?: string;
}

export interface SonarrSeries {
	id: number;
	title: string;
	sortTitle?: string;
	status: string;
	overview?: string;
	year: number;
	tvdbId: number;
	imdbId?: string;
	monitored: boolean;
	qualityProfileId: number;
	seasonFolder: boolean;
	rootFolderPath: string;
	path: string;
	added: string;
	genres?: string[];
	runtime?: number;
	network?: string;
	images: ArrImage[];
	seasons?: SonarrSeason[];
	statistics?: {episodeFileCount?: number; episodeCount?: number; totalEpisodeCount?: number; sizeOnDisk?: number; percentOfEpisodes?: number};
	titleSlug?: string;
	seriesType?: string;
	languageProfileId?: number;
}

export interface SonarrSeason {
	seasonNumber: number;
	monitored: boolean;
	statistics?: {episodeFileCount?: number; episodeCount?: number; totalEpisodeCount?: number; sizeOnDisk?: number; percentOfEpisodes?: number};
}

export interface SonarrEpisode {
	id: number;
	seriesId: number;
	seasonNumber: number;
	episodeNumber: number;
	title: string;
	airDateUtc?: string;
	overview?: string;
	hasFile: boolean;
	monitored: boolean;
	episodeFileId?: number;
}

export interface SonarrCalendarEntry {
	id: number;
	seriesId: number;
	seasonNumber: number;
	episodeNumber: number;
	title: string;
	airDateUtc: string;
	hasFile: boolean;
	monitored: boolean;
	series: SonarrSeries;
}

export interface RadarrMovie {
	id: number;
	title: string;
	sortTitle?: string;
	status: string;
	overview?: string;
	year: number;
	tmdbId: number;
	imdbId?: string;
	monitored: boolean;
	qualityProfileId: number;
	rootFolderPath: string;
	path: string;
	added: string;
	hasFile: boolean;
	genres?: string[];
	runtime?: number;
	studio?: string;
	images: ArrImage[];
	sizeOnDisk?: number;
	titleSlug?: string;
	movieFile?: {size?: number; dateAdded?: string; relativePath?: string};
}

export interface QueueRecord {
	id: number;
	title: string;
	status: string;
	trackedDownloadStatus?: string;
	trackedDownloadState?: string;
	statusMessages?: {title?: string; messages?: string[]}[];
	sizeleft: number;
	size: number;
	timeleft?: string;
	estimatedCompletionTime?: string;
	downloadId?: string;
	protocol: string;
	indexer?: string;
	outputPath?: string;
	seriesId?: number;
	episodeId?: number;
	movieId?: number;
	series?: SonarrSeries;
	movie?: RadarrMovie;
	episode?: SonarrEpisode;
}

export interface QueuePage {
	page: number;
	pageSize: number;
	totalRecords: number;
	records: QueueRecord[];
}

export interface HistoryRecord {
	id: number;
	date: string;
	eventType: string;
	sourceTitle?: string;
	quality?: {quality?: {name?: string}};
	seriesId?: number;
	episodeId?: number;
	movieId?: number;
	series?: SonarrSeries;
	movie?: RadarrMovie;
}

export interface HistoryPage {
	page: number;
	pageSize: number;
	totalRecords: number;
	records: HistoryRecord[];
}

export type MonitorScope = 'all' | 'future' | 'missing' | 'existing' | 'firstSeason' | 'lastSeason' | 'none';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ArrConn { url: string; key: string }

function arrGet<T> (conn: ArrConn, path: string, timeout?: number): Promise<T> {
	var base = conn.url.replace(/\/+$/, '');
	return apiCall({url: base + path, headers: {'X-Api-Key': conn.key}, timeout: timeout || 30000})
		.then(function (text) { return JSON.parse(text) as T; });
}

function arrGetLarge<T> (conn: ArrConn, path: string, timeout?: number): Promise<T> {
	var base = conn.url.replace(/\/+$/, '');
	return apiCallLarge({url: base + path, headers: {'X-Api-Key': conn.key}, timeout: timeout || 30000})
		.then(function (text) { return JSON.parse(text) as T; });
}

function arrPost<T> (conn: ArrConn, path: string, body: unknown, timeout?: number): Promise<T> {
	var base = conn.url.replace(/\/+$/, '');
	return apiCall({url: base + path, method: 'POST', headers: {'X-Api-Key': conn.key, 'Content-Type': 'application/json'}, body: body, timeout: timeout || 30000})
		.then(function (text) { return JSON.parse(text) as T; });
}

function arrPut<T> (conn: ArrConn, path: string, body: unknown, timeout?: number): Promise<T> {
	var base = conn.url.replace(/\/+$/, '');
	return apiCall({url: base + path, method: 'PUT', headers: {'X-Api-Key': conn.key, 'Content-Type': 'application/json'}, body: body, timeout: timeout || 30000})
		.then(function (text) { return JSON.parse(text) as T; });
}

function arrDelete (conn: ArrConn, path: string): Promise<void> {
	var base = conn.url.replace(/\/+$/, '');
	return apiCall({url: base + path, method: 'DELETE', headers: {'X-Api-Key': conn.key}})
		.then(function () { return undefined; });
}

// ---------------------------------------------------------------------------
// Sonarr API
// ---------------------------------------------------------------------------

export function sonarrGetSeries (conn: ArrConn): Promise<SonarrSeries[]> {
	return arrGet<SonarrSeries[]>(conn, '/api/v3/series');
}

export function sonarrGetSeriesById (conn: ArrConn, id: number): Promise<SonarrSeries> {
	return arrGet<SonarrSeries>(conn, '/api/v3/series/' + id);
}

export function sonarrPutSeries (conn: ArrConn, series: SonarrSeries): Promise<SonarrSeries> {
	return arrPut<SonarrSeries>(conn, '/api/v3/series/' + series.id, series);
}

export function sonarrLookup (conn: ArrConn, tvdbId: number): Promise<SonarrSeries[]> {
	return arrGet<SonarrSeries[]>(conn, '/api/v3/series/lookup?term=tvdb%3A' + tvdbId);
}

export function sonarrLookupByTmdb (conn: ArrConn, tmdbId: number): Promise<SonarrSeries[]> {
	return arrGet<SonarrSeries[]>(conn, '/api/v3/series/lookup?term=tmdb%3A' + tmdbId);
}

export function sonarrLookupByTitle (conn: ArrConn, title: string): Promise<SonarrSeries[]> {
	return arrGet<SonarrSeries[]>(conn, '/api/v3/series/lookup?term=' + encodeURIComponent(title));
}

export function radarrLookupByTitle (conn: ArrConn, title: string): Promise<RadarrMovie[]> {
	return arrGet<RadarrMovie[]>(conn, '/api/v3/movie/lookup?term=' + encodeURIComponent(title));
}

function sonarrRootFolder (conn: ArrConn): Promise<string> {
	return arrGet<{path: string}[]>(conn, '/api/v3/rootfolder').then(function (folders) {
		if (!folders.length) return Promise.reject(new Error('No root folder configured in Sonarr'));
		return folders[0].path;
	});
}

function radarrRootFolder (conn: ArrConn): Promise<string> {
	return arrGet<{path: string}[]>(conn, '/api/v3/rootfolder').then(function (folders) {
		if (!folders.length) return Promise.reject(new Error('No root folder configured in Radarr'));
		return folders[0].path;
	});
}

export function sonarrAddSeries (conn: ArrConn, series: SonarrSeries, monitor: MonitorScope): Promise<SonarrSeries> {
	return sonarrRootFolder(conn).then(function (rootPath) {
		var body = Object.assign({}, series, {
			rootFolderPath: series.rootFolderPath || rootPath,
			addOptions: {monitor: monitor, searchForMissingEpisodes: false, searchForCutoffUnmetEpisodes: false}
		});
		return arrPost<SonarrSeries>(conn, '/api/v3/series', body);
	});
}

export function sonarrDeleteSeries (conn: ArrConn, id: number, deleteFiles: boolean): Promise<void> {
	return arrDelete(conn, '/api/v3/series/' + id + '?deleteFiles=' + deleteFiles);
}

export function sonarrGetEpisodes (conn: ArrConn, seriesId: number): Promise<SonarrEpisode[]> {
	return arrGet<SonarrEpisode[]>(conn, '/api/v3/episode?seriesId=' + seriesId);
}

export function sonarrMonitorEpisodes (conn: ArrConn, episodeIds: number[], monitored: boolean): Promise<SonarrEpisode[]> {
	return arrPut<SonarrEpisode[]>(conn, '/api/v3/episode/monitor', {episodeIds: episodeIds, monitored: monitored});
}

export function sonarrCalendar (conn: ArrConn, startDate: string, endDate: string): Promise<SonarrCalendarEntry[]> {
	return arrGet<SonarrCalendarEntry[]>(conn, '/api/v3/calendar?start=' + encodeURIComponent(startDate) + '&end=' + encodeURIComponent(endDate) + '&includeSeries=true');
}

export function sonarrQueue (conn: ArrConn, page?: number): Promise<QueuePage> {
	var p = page || 1;
	return arrGet<QueuePage>(conn, '/api/v3/queue?page=' + p + '&pageSize=50&includeSeries=true&includeEpisode=true&sortKey=timeleft&sortDirection=ascending');
}

export function sonarrDeleteQueue (conn: ArrConn, id: number, removeFromClient: boolean): Promise<void> {
	return arrDelete(conn, '/api/v3/queue/' + id + '?removeFromClient=' + removeFromClient + '&blocklist=false');
}

export function sonarrHistory (conn: ArrConn, page?: number): Promise<HistoryPage> {
	var p = page || 1;
	return arrGet<HistoryPage>(conn, '/api/v3/history?page=' + p + '&pageSize=50&sortKey=date&sortDirection=descending&includeSeries=true');
}

export function sonarrCommand (conn: ArrConn, name: string, body?: Record<string, unknown>): Promise<{id: number}> {
	return arrPost<{id: number}>(conn, '/api/v3/command', Object.assign({name: name}, body || {}));
}

export function sonarrRootFolders (conn: ArrConn): Promise<{id: number; path: string; freeSpace?: number}[]> {
	return arrGet(conn, '/api/v3/rootfolder');
}

export function sonarrQualityProfiles (conn: ArrConn): Promise<{id: number; name: string}[]> {
	return arrGet(conn, '/api/v3/qualityprofile');
}

// ---------------------------------------------------------------------------
// Radarr API
// ---------------------------------------------------------------------------

export function radarrGetMovies (conn: ArrConn): Promise<RadarrMovie[]> {
	return arrGetLarge<RadarrMovie[]>(conn, '/api/v3/movie');
}

export function radarrGetMovieById (conn: ArrConn, id: number): Promise<RadarrMovie> {
	return arrGet<RadarrMovie>(conn, '/api/v3/movie/' + id);
}

export function radarrPutMovie (conn: ArrConn, movie: RadarrMovie): Promise<RadarrMovie> {
	return arrPut<RadarrMovie>(conn, '/api/v3/movie/' + movie.id, movie);
}

export function radarrLookup (conn: ArrConn, tmdbId: number): Promise<RadarrMovie[]> {
	return arrGet<RadarrMovie[]>(conn, '/api/v3/movie/lookup?term=tmdb%3A' + tmdbId);
}

export function radarrAddMovie (conn: ArrConn, movie: RadarrMovie, searchNow: boolean): Promise<RadarrMovie> {
	return radarrRootFolder(conn).then(function (rootPath) {
		var body = Object.assign({}, movie, {
			rootFolderPath: movie.rootFolderPath || rootPath,
			addOptions: {searchForMovie: searchNow, monitor: 'movieOnly'}
		});
		return arrPost<RadarrMovie>(conn, '/api/v3/movie', body);
	});
}

export function radarrDeleteMovie (conn: ArrConn, id: number, deleteFiles: boolean): Promise<void> {
	return arrDelete(conn, '/api/v3/movie/' + id + '?deleteFiles=' + deleteFiles);
}

export function radarrQueue (conn: ArrConn, page?: number): Promise<QueuePage> {
	var p = page || 1;
	return arrGet<QueuePage>(conn, '/api/v3/queue?page=' + p + '&pageSize=50&includeMovie=true&sortKey=timeleft&sortDirection=ascending');
}

export function radarrDeleteQueue (conn: ArrConn, id: number, removeFromClient: boolean): Promise<void> {
	return arrDelete(conn, '/api/v3/queue/' + id + '?removeFromClient=' + removeFromClient + '&blocklist=false');
}

export function radarrHistory (conn: ArrConn, page?: number): Promise<HistoryPage> {
	var p = page || 1;
	return arrGet<HistoryPage>(conn, '/api/v3/history?page=' + p + '&pageSize=50&sortKey=date&sortDirection=descending&includeMovie=true');
}

export function radarrCommand (conn: ArrConn, name: string, body?: Record<string, unknown>): Promise<{id: number}> {
	return arrPost<{id: number}>(conn, '/api/v3/command', Object.assign({name: name}, body || {}));
}

export function radarrRootFolders (conn: ArrConn): Promise<{id: number; path: string; freeSpace?: number}[]> {
	return arrGet(conn, '/api/v3/rootfolder');
}

export function radarrQualityProfiles (conn: ArrConn): Promise<{id: number; name: string}[]> {
	return arrGet(conn, '/api/v3/qualityprofile');
}

// ---------------------------------------------------------------------------
// Quality profile resolution
// ---------------------------------------------------------------------------

var PROFILE_NAME = 'HD-1080p';
var profileCache: Record<string, Promise<number>> = {};

function resolveProfileId (conn: ArrConn): Promise<number> {
	var cacheKey = conn.url;
	if (cacheKey in profileCache) return profileCache[cacheKey];
	profileCache[cacheKey] = arrGet<{id: number; name: string}[]>(conn, '/api/v3/qualityprofile').then(function (profiles) {
		var matches: {id: number; name: string}[] = [];
		for (var i = 0; i < profiles.length; i++) {
			if (profiles[i].name === PROFILE_NAME) matches.push(profiles[i]);
		}
		if (matches.length === 1) return matches[0].id;
		delete profileCache[cacheKey];
		if (matches.length === 0) return Promise.reject(new Error("Quality profile '" + PROFILE_NAME + "' not found"));
		return Promise.reject(new Error("Quality profile '" + PROFILE_NAME + "' is ambiguous (" + matches.length + " matches)"));
	}).catch(function (e: Error) {
		delete profileCache[cacheKey];
		return Promise.reject(e);
	}) as Promise<number>;
	return profileCache[cacheKey];
}

export {resolveProfileId};

// ---------------------------------------------------------------------------
// Watchlist helpers
// ---------------------------------------------------------------------------

export function sonarrConn (connections: {sonarrUrl: string; sonarrKey: string}): ArrConn {
	return {url: connections.sonarrUrl, key: connections.sonarrKey};
}

export function radarrConn (connections: {radarrUrl: string; radarrKey: string}): ArrConn {
	return {url: connections.radarrUrl, key: connections.radarrKey};
}

export interface WatchlistAddResult {
	title: string;
	monitoredCount: number;
	totalCount: number;
	isNew: boolean;
}

export function countEpisodesByScope (episodes: SonarrEpisode[]): {future: number; lastSeason: number; all: number; total: number} {
	var now = new Date().toISOString();
	var maxSn = 0;
	for (var i = 0; i < episodes.length; i++) {
		if (episodes[i].seasonNumber > maxSn) maxSn = episodes[i].seasonNumber;
	}
	var future = 0;
	var lastSeason = 0;
	for (var j = 0; j < episodes.length; j++) {
		var ep = episodes[j];
		if (!ep.airDateUtc || ep.airDateUtc > now) future++;
		if (ep.seasonNumber === maxSn) lastSeason++;
	}
	return {future: future, lastSeason: lastSeason, all: episodes.length, total: episodes.length};
}

function episodeIdsForScope (episodes: SonarrEpisode[], scope: MonitorScope): {monitor: number[]; unmonitor: number[]} {
	var now = new Date().toISOString();
	var maxSn = 0;
	for (var i = 0; i < episodes.length; i++) {
		if (episodes[i].seasonNumber > maxSn) maxSn = episodes[i].seasonNumber;
	}
	var monitor: number[] = [];
	var unmonitor: number[] = [];
	for (var j = 0; j < episodes.length; j++) {
		var ep = episodes[j];
		var want = false;
		if (scope === 'all') want = true;
		else if (scope === 'none') want = false;
		else if (scope === 'future') want = !ep.airDateUtc || ep.airDateUtc > now;
		else if (scope === 'lastSeason') want = ep.seasonNumber === maxSn;
		else if (scope === 'firstSeason') want = ep.seasonNumber === 1;
		if (want && !ep.monitored) monitor.push(ep.id);
		else if (!want && ep.monitored) unmonitor.push(ep.id);
	}
	return {monitor: monitor, unmonitor: unmonitor};
}

function applyEpisodeMonitoring (conn: ArrConn, seriesId: number, scope: MonitorScope): Promise<{monitoredCount: number; totalCount: number}> {
	return sonarrGetEpisodes(conn, seriesId).then(function (episodes) {
		var ids = episodeIdsForScope(episodes, scope);
		var proms: Promise<unknown>[] = [];
		if (ids.monitor.length > 0) proms.push(sonarrMonitorEpisodes(conn, ids.monitor, true));
		if (ids.unmonitor.length > 0) proms.push(sonarrMonitorEpisodes(conn, ids.unmonitor, false));
		var counts = countEpisodesByScope(episodes);
		var monitoredCount = scope === 'future' ? counts.future
			: scope === 'lastSeason' ? counts.lastSeason
			: scope === 'all' ? counts.all
			: 0;
		return Promise.all(proms).then(function () {
			return {monitoredCount: monitoredCount, totalCount: episodes.length};
		});
	});
}

function seasonFlagsForScope (seasons: SonarrSeason[], scope: MonitorScope): SonarrSeason[] {
	var maxSn = 0;
	for (var i = 0; i < seasons.length; i++) {
		if (seasons[i].seasonNumber > maxSn) maxSn = seasons[i].seasonNumber;
	}
	return seasons.map(function (s) {
		if (scope === 'all') return Object.assign({}, s, {monitored: true});
		if (scope === 'none') return Object.assign({}, s, {monitored: false});
		if (scope === 'future') return Object.assign({}, s, {monitored: s.seasonNumber >= maxSn});
		if (scope === 'lastSeason') return Object.assign({}, s, {monitored: s.seasonNumber === maxSn});
		if (scope === 'firstSeason') return Object.assign({}, s, {monitored: s.seasonNumber === 1});
		return s;
	});
}

export function watchlistAddSeries (conn: ArrConn, tvdbId: number, existing: SonarrSeries | null, monitor: MonitorScope): Promise<WatchlistAddResult> {
	return resolveProfileId(conn).then(function (profileId) {
		if (existing) {
			var updated = Object.assign({}, existing, {monitored: true});
			if (existing.qualityProfileId === 1) updated.qualityProfileId = profileId;
			if (updated.seasons) updated.seasons = seasonFlagsForScope(updated.seasons, monitor);
			return sonarrPutSeries(conn, updated).then(function (series) {
				return applyEpisodeMonitoring(conn, series.id, monitor).then(function (counts) {
					return {title: series.title, monitoredCount: counts.monitoredCount, totalCount: counts.totalCount, isNew: false};
				});
			});
		}
		return sonarrLookup(conn, tvdbId).then(function (results) {
			if (!results.length) return Promise.reject(new Error('Series not found in Sonarr'));
			var series = results[0];
			series.qualityProfileId = profileId;
			series.monitored = true;
			return sonarrAddSeries(conn, series, monitor).then(function (added) {
				return sonarrGetEpisodes(conn, added.id).then(function (episodes) {
					var monitoredCount = 0;
					for (var i = 0; i < episodes.length; i++) { if (episodes[i].monitored) monitoredCount++; }
					return {title: added.title, monitoredCount: monitoredCount, totalCount: episodes.length, isNew: true};
				}).catch(function () {
					return {title: added.title, monitoredCount: -1, totalCount: -1, isNew: true};
				});
			});
		});
	});
}

export function watchlistAddSeriesByTmdb (conn: ArrConn, tmdbId: number, monitor: MonitorScope): Promise<WatchlistAddResult> {
	return sonarrGetSeries(conn).then(function (all) {
		return sonarrLookupByTmdb(conn, tmdbId).then(function (results) {
			if (!results.length) return Promise.reject(new Error('Series not found in Sonarr'));
			var looked = results[0];
			var existing: SonarrSeries | null = null;
			for (var j = 0; j < all.length; j++) {
				if (all[j].tvdbId === looked.tvdbId) { existing = all[j]; break; }
			}
			return watchlistAddSeries(conn, looked.tvdbId, existing, monitor);
		});
	});
}

export function watchlistAddMovie (conn: ArrConn, tmdbId: number, existing: RadarrMovie | null): Promise<WatchlistAddResult> {
	return resolveProfileId(conn).then(function (profileId) {
		if (existing) {
			var updated = Object.assign({}, existing, {monitored: true});
			if (existing.qualityProfileId === 1) updated.qualityProfileId = profileId;
			return radarrPutMovie(conn, updated).then(function (movie) {
				return {title: movie.title, monitoredCount: 1, totalCount: 1, isNew: false};
			});
		}
		return radarrLookup(conn, tmdbId).then(function (results) {
			if (!results.length) return Promise.reject(new Error('Movie not found in Radarr'));
			var movie = results[0];
			movie.qualityProfileId = profileId;
			movie.monitored = true;
			return radarrAddMovie(conn, movie, false).then(function (added) {
				return {title: added.title, monitoredCount: 1, totalCount: 1, isNew: true};
			});
		});
	});
}

export function watchlistCheckSeries (conn: ArrConn, tmdbId: number): Promise<{existing: SonarrSeries | null; episodes: SonarrEpisode[]}> {
	return sonarrGetSeries(conn).then(function (all) {
		return sonarrLookupByTmdb(conn, tmdbId).then(function (results) {
			if (!results.length) return {existing: null, episodes: []};
			var looked = results[0];
			var existing: SonarrSeries | null = null;
			for (var j = 0; j < all.length; j++) {
				if (all[j].tvdbId === looked.tvdbId) { existing = all[j]; break; }
			}
			if (!existing) return {existing: null, episodes: []};
			return sonarrGetEpisodes(conn, existing.id).then(function (eps) {
				return {existing: existing, episodes: eps};
			});
		}).catch(function () { return {existing: null, episodes: []}; });
	});
}

export function watchlistCheckMovie (conn: ArrConn, tmdbId: number): Promise<RadarrMovie | null> {
	return radarrGetMovies(conn).then(function (all) {
		for (var i = 0; i < all.length; i++) {
			if (all[i].tmdbId === tmdbId) return all[i];
		}
		return null;
	}).catch(function () { return null; });
}

export function watchlistStopSeries (conn: ArrConn, series: SonarrSeries): Promise<void> {
	var updated = Object.assign({}, series, {monitored: false});
	return sonarrPutSeries(conn, updated).then(function () { return undefined; });
}

export function watchlistStopMovie (conn: ArrConn, movie: RadarrMovie): Promise<void> {
	var updated = Object.assign({}, movie, {monitored: false});
	return radarrPutMovie(conn, updated).then(function () { return undefined; });
}

// ---------------------------------------------------------------------------
// Download helpers
// ---------------------------------------------------------------------------

export interface CommandStatus {
	id: number;
	name: string;
	status: string;
}

export function sonarrCommandStatus (conn: ArrConn, commandId: number): Promise<CommandStatus> {
	return arrGet<CommandStatus>(conn, '/api/v3/command/' + commandId);
}

export function radarrCommandStatus (conn: ArrConn, commandId: number): Promise<CommandStatus> {
	return arrGet<CommandStatus>(conn, '/api/v3/command/' + commandId);
}

export interface DownloadMovieResult {
	title: string;
	movieId: number;
	commandId: number;
	alreadyHasFile: boolean;
	qualityUpgraded: boolean;
}

export function downloadMovie (conn: ArrConn, tmdbId: number): Promise<DownloadMovieResult> {
	return resolveProfileId(conn).then(function (profileId) {
		return radarrLookup(conn, tmdbId).then(function (results) {
			if (!results.length) return Promise.reject(new Error('Movie not found'));
			var looked = results[0];
			var existingProm: Promise<RadarrMovie | null> = looked.id && looked.id > 0
				? radarrGetMovieById(conn, looked.id)
				: Promise.resolve(null);
			return existingProm.then(function (existing) {
				if (existing && existing.hasFile) {
					return {title: existing.title, movieId: existing.id, commandId: 0, alreadyHasFile: true, qualityUpgraded: false};
				}
				var qualityUpgraded = false;
				var addProm: Promise<RadarrMovie>;
				if (existing) {
					var updated = Object.assign({}, existing, {monitored: true});
					if (existing.qualityProfileId === 1) { updated.qualityProfileId = profileId; qualityUpgraded = true; }
					addProm = radarrPutMovie(conn, updated);
				} else {
					looked.qualityProfileId = profileId;
					looked.monitored = true;
					addProm = radarrAddMovie(conn, looked, false);
				}
				return addProm.then(function (added) {
					return radarrCommand(conn, 'MoviesSearch', {movieIds: [added.id]}).then(function (cmd) {
						return {title: added.title, movieId: added.id, commandId: cmd.id, alreadyHasFile: false, qualityUpgraded: qualityUpgraded};
					});
				});
			});
		});
	});
}

export interface DlSeasonInfo { number: number; count: number }

export interface DownloadSeriesPrep {
	seasons: DlSeasonInfo[];
	lastSeason: number;
	all: number;
}

function dlLookup (conn: ArrConn, id: number | {tvdbId: number}): Promise<SonarrSeries[]> {
	if (typeof id === 'object') return sonarrLookup(conn, id.tvdbId);
	return sonarrLookupByTmdb(conn, id);
}

export function downloadSeriesPrep (conn: ArrConn, id: number | {tvdbId: number}): Promise<DownloadSeriesPrep> {
	return sonarrGetSeries(conn).then(function (allSeries) {
		return dlLookup(conn, id).then(function (results) {
			if (!results.length) return Promise.reject(new Error('Series not found'));
			var looked = results[0];
			var existing: SonarrSeries | null = null;
			for (var j = 0; j < allSeries.length; j++) {
				if (allSeries[j].tvdbId === looked.tvdbId) { existing = allSeries[j]; break; }
			}
			if (existing) {
				return sonarrGetEpisodes(conn, existing.id).then(function (episodes) {
					var bySeason: Record<number, number> = {};
					var maxSn = 0;
					for (var i = 0; i < episodes.length; i++) {
						var sn = episodes[i].seasonNumber;
						if (sn === 0) continue;
						bySeason[sn] = (bySeason[sn] || 0) + 1;
						if (sn > maxSn) maxSn = sn;
					}
					var seasons: DlSeasonInfo[] = [];
					var keys = Object.keys(bySeason);
					keys.sort(function (a, b) { return Number(a) - Number(b); });
					var total = 0;
					for (var k = 0; k < keys.length; k++) {
						var n = Number(keys[k]);
						seasons.push({number: n, count: bySeason[n]});
						total += bySeason[n];
					}
					return {seasons: seasons, lastSeason: bySeason[maxSn] || 0, all: total};
				});
			}
			var lookSeasons = looked.seasons || [];
			var maxSn = 0;
			for (var i = 0; i < lookSeasons.length; i++) {
				if (lookSeasons[i].seasonNumber > maxSn) maxSn = lookSeasons[i].seasonNumber;
			}
			var seasons: DlSeasonInfo[] = [];
			var total = 0;
			for (var k = 0; k < lookSeasons.length; k++) {
				var sn = lookSeasons[k].seasonNumber;
				if (sn === 0) continue;
				var epCount = lookSeasons[k].statistics && lookSeasons[k].statistics!.totalEpisodeCount || 0;
				seasons.push({number: sn, count: epCount});
				total += epCount;
			}
			seasons.sort(function (a, b) { return a.number - b.number; });
			return {seasons: seasons, lastSeason: seasons.length > 0 ? seasons[seasons.length - 1].count : 0, all: total};
		});
	});
}

export function downloadSeriesListEpisodes (conn: ArrConn, id: number | {tvdbId: number}, seasonNumber: number): Promise<SonarrEpisode[]> {
	return resolveProfileId(conn).then(function (profileId) {
		return sonarrGetSeries(conn).then(function (allSeries) {
			return dlLookup(conn, id).then(function (results) {
				if (!results.length) return Promise.reject(new Error('Series not found'));
				var looked = results[0];
				var existing: SonarrSeries | null = null;
				for (var j = 0; j < allSeries.length; j++) {
					if (allSeries[j].tvdbId === looked.tvdbId) { existing = allSeries[j]; break; }
				}
				var seriesProm: Promise<SonarrSeries>;
				if (existing) {
					seriesProm = Promise.resolve(existing);
				} else {
					looked.qualityProfileId = profileId;
					looked.monitored = false;
					seriesProm = sonarrAddSeries(conn, looked, 'none');
				}
			return seriesProm.then(function (series) {
				return sonarrGetEpisodes(conn, series.id).then(function (episodes) {
					var filtered: SonarrEpisode[] = [];
					for (var i = 0; i < episodes.length; i++) {
						if (episodes[i].seasonNumber === seasonNumber) filtered.push(episodes[i]);
					}
					filtered.sort(function (a, b) { return a.episodeNumber - b.episodeNumber; });
					return filtered;
				});
			});
		});
	});
	});
}

export type DownloadScope = 'lastSeason' | 'all' | {season: number} | {episode: number};

export interface DownloadSeriesResult {
	title: string;
	seriesId: number;
	commandId: number;
	monitoredCount: number;
	qualityUpgraded: boolean;
}

export function downloadSeries (conn: ArrConn, id: number | {tvdbId: number}, scope: DownloadScope): Promise<DownloadSeriesResult> {
	return resolveProfileId(conn).then(function (profileId) {
		return sonarrGetSeries(conn).then(function (allSeries) {
			return dlLookup(conn, id).then(function (results) {
				if (!results.length) return Promise.reject(new Error('Series not found'));
				var looked = results[0];
				var existing: SonarrSeries | null = null;
				for (var j = 0; j < allSeries.length; j++) {
					if (allSeries[j].tvdbId === looked.tvdbId) { existing = allSeries[j]; break; }
				}
				var qualityUpgraded = false;
				var isSeason = typeof scope === 'object' && 'season' in scope;
				var isEpisode = typeof scope === 'object' && 'episode' in scope;
				var seasonScope: MonitorScope = scope === 'lastSeason' ? 'lastSeason' : scope === 'all' ? 'all' : 'none';
				var ensureProm: Promise<SonarrSeries>;
				if (existing) {
					var updated = Object.assign({}, existing, {monitored: true});
					if (existing.qualityProfileId === 1) { updated.qualityProfileId = profileId; qualityUpgraded = true; }
					if (!isSeason && !isEpisode && updated.seasons) updated.seasons = seasonFlagsForScope(updated.seasons, seasonScope);
					if (isSeason && updated.seasons) {
						var targetSn = (scope as {season: number}).season;
						updated.seasons = updated.seasons.map(function (s) {
							return Object.assign({}, s, {monitored: s.seasonNumber === targetSn ? true : s.monitored});
						});
					}
					ensureProm = sonarrPutSeries(conn, updated);
				} else {
					looked.qualityProfileId = profileId;
					looked.monitored = true;
					ensureProm = sonarrAddSeries(conn, looked, isSeason || isEpisode ? 'none' : seasonScope);
				}
				return ensureProm.then(function (series) {
				return sonarrGetEpisodes(conn, series.id).then(function (episodes) {
					var toMonitor: number[] = [];
					var toUnmonitor: number[] = [];
					var monitoredCount = 0;
					if (isSeason) {
						var sn = (scope as {season: number}).season;
						for (var i = 0; i < episodes.length; i++) {
							if (episodes[i].seasonNumber === sn) {
								monitoredCount++;
								if (!episodes[i].monitored) toMonitor.push(episodes[i].id);
							}
						}
					} else if (isEpisode) {
						var epId = (scope as {episode: number}).episode;
						for (var i = 0; i < episodes.length; i++) {
							if (episodes[i].id === epId) {
								monitoredCount = 1;
								if (!episodes[i].monitored) toMonitor.push(episodes[i].id);
							}
						}
					} else {
						var ids = episodeIdsForScope(episodes, seasonScope);
						toMonitor = ids.monitor;
						toUnmonitor = ids.unmonitor;
						var counts = countEpisodesByScope(episodes);
						monitoredCount = scope === 'lastSeason' ? counts.lastSeason : counts.all;
					}
					var proms: Promise<unknown>[] = [];
					if (toMonitor.length > 0) proms.push(sonarrMonitorEpisodes(conn, toMonitor, true));
					if (toUnmonitor.length > 0) proms.push(sonarrMonitorEpisodes(conn, toUnmonitor, false));
					return Promise.all(proms).then(function () {
						return sonarrGetEpisodes(conn, series.id).then(function (verified) {
							var actualMonitored = 0;
							for (var v = 0; v < verified.length; v++) {
								if (verified[v].monitored) actualMonitored++;
							}
							var maxSn = 0;
							if (series.seasons) {
								for (var si = 0; si < series.seasons.length; si++) {
									if (series.seasons[si].seasonNumber > maxSn) maxSn = series.seasons[si].seasonNumber;
								}
							}
							var searchProm: Promise<{id: number}>;
							if (isEpisode) {
								searchProm = sonarrCommand(conn, 'EpisodeSearch', {episodeIds: [(scope as {episode: number}).episode]});
							} else if (isSeason) {
								searchProm = sonarrCommand(conn, 'SeasonSearch', {seriesId: series.id, seasonNumber: (scope as {season: number}).season});
							} else if (scope === 'lastSeason') {
								searchProm = sonarrCommand(conn, 'SeasonSearch', {seriesId: series.id, seasonNumber: maxSn});
							} else {
								searchProm = sonarrCommand(conn, 'SeriesSearch', {seriesId: series.id});
							}
							return searchProm.then(function (cmd) {
								return {title: series.title, seriesId: series.id, commandId: cmd.id, monitoredCount: actualMonitored, qualityUpgraded: qualityUpgraded};
							});
						});
					});
				});
			});
		});
	});
	});
}

export function arrPosterUrl (images: ArrImage[]): string | null {
	for (var i = 0; i < images.length; i++) {
		if (images[i].coverType === 'poster') return images[i].remoteUrl || images[i].url || null;
	}
	return null;
}

export function arrFanartUrl (images: ArrImage[]): string | null {
	for (var i = 0; i < images.length; i++) {
		if (images[i].coverType === 'fanart') return images[i].remoteUrl || images[i].url || null;
	}
	return null;
}
