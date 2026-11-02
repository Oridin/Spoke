import {apiCall} from './arrapi';

export interface PlexSection {
	key: string;
	type: 'movie' | 'show';
	title: string;
}

export interface PlexItem {
	ratingKey: string;
	type: 'movie' | 'show' | 'season' | 'episode';
	title: string;
	parentTitle?: string;
	grandparentTitle?: string;
	year?: number;
	rating?: number;
	summary?: string;
	thumb?: string;
	art?: string;
	parentThumb?: string;
	grandparentThumb?: string;
	grandparentArt?: string;
	duration?: number;
	viewOffset?: number;
	viewCount?: number;
	addedAt?: number;
	index?: number;
	parentIndex?: number;
	genres?: string[];
	childCount?: number;
	leafCount?: number;
	viewedLeafCount?: number;
	librarySectionID?: string;
}

export interface PlexGenre {
	key: string;
	title: string;
}

export interface PlexPage {
	items: PlexItem[];
	totalSize: number;
}

var PAGE_SIZE = 20;

function base (url: string): string { return url.replace(/\/+$/, ''); }

function plexFetch (url: string, token: string): Promise<string> {
	var fullUrl = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'X-Plex-Token=' + encodeURIComponent(token);
	return new Promise<string>(function (resolve, reject) {
		try {
			var xhr = new XMLHttpRequest();
			xhr.open('GET', fullUrl);
			xhr.setRequestHeader('Accept', 'application/json');
			xhr.timeout = 15000;
			xhr.onload = function () { xhr.status >= 200 && xhr.status < 400 ? resolve(xhr.responseText) : reject(new Error('HTTP ' + xhr.status)); };
			xhr.onerror = function () { reject(new Error('Network error')); };
			xhr.ontimeout = function () { reject(new Error('Timeout')); };
			xhr.send();
		} catch (e) { reject(e); }
	}).catch(function () {
		return apiCall({url: url, headers: {'X-Plex-Token': token, Accept: 'application/json'}, timeout: 15000});
	});
}

export function plexFetchJson (url: string, token: string): Promise<Record<string, unknown>> {
	return plexFetch(url, token).then(function (json) { return JSON.parse(json) as Record<string, unknown>; });
}

function parseItem (m: Record<string, unknown>): PlexItem {
	var genres: string[] = [];
	var g = m.Genre as Array<{tag?: string}> | undefined;
	if (Array.isArray(g)) for (var i = 0; i < g.length; i++) { if (g[i] && g[i].tag) genres.push(g[i].tag as string); }
	return {
		ratingKey: String(m.ratingKey || ''),
		type: (m.type as PlexItem['type']) || 'movie',
		title: (m.title as string) || '',
		parentTitle: (m.parentTitle as string) || undefined,
		grandparentTitle: (m.grandparentTitle as string) || undefined,
		year: typeof m.year === 'number' ? m.year : undefined,
		rating: typeof m.audienceRating === 'number' ? (m.audienceRating as number) : (typeof m.rating === 'number' ? (m.rating as number) : undefined),
		summary: (m.summary as string) || undefined,
		thumb: (m.thumb as string) || undefined,
		art: (m.art as string) || undefined,
		parentThumb: (m.parentThumb as string) || undefined,
		grandparentThumb: (m.grandparentThumb as string) || undefined,
		grandparentArt: (m.grandparentArt as string) || undefined,
		duration: typeof m.duration === 'number' ? (m.duration as number) : undefined,
		viewOffset: typeof m.viewOffset === 'number' ? (m.viewOffset as number) : undefined,
		viewCount: typeof m.viewCount === 'number' ? (m.viewCount as number) : undefined,
		addedAt: typeof m.addedAt === 'number' ? (m.addedAt as number) : undefined,
		index: typeof m.index === 'number' ? (m.index as number) : undefined,
		parentIndex: typeof m.parentIndex === 'number' ? (m.parentIndex as number) : undefined,
		genres: genres.length > 0 ? genres : undefined,
		childCount: typeof m.childCount === 'number' ? (m.childCount as number) : undefined,
		leafCount: typeof m.leafCount === 'number' ? (m.leafCount as number) : undefined,
		viewedLeafCount: typeof m.viewedLeafCount === 'number' ? (m.viewedLeafCount as number) : undefined,
		librarySectionID: typeof m.librarySectionID === 'number' ? String(m.librarySectionID) : (typeof m.librarySectionID === 'string' ? (m.librarySectionID as string) : undefined),
	};
}

function parsePage (json: string): PlexPage {
	try {
		var data = JSON.parse(json);
		var mc = data.MediaContainer || {};
		var totalSize = typeof mc.totalSize === 'number' ? mc.totalSize : (typeof mc.size === 'number' ? mc.size : 0);
		var items: PlexItem[] = [];
		var meta = mc.Metadata;
		if (Array.isArray(meta)) for (var i = 0; i < meta.length; i++) items.push(parseItem(meta[i] as Record<string, unknown>));
		return {items: items, totalSize: totalSize};
	} catch { return {items: [], totalSize: 0}; }
}

export function fetchMachineId (plexUrl: string, token: string): Promise<string> {
	return plexFetch(base(plexUrl) + '/identity', token).then(function (json) {
		try {
			var mc = JSON.parse(json).MediaContainer || {};
			return (mc.machineIdentifier as string) || '';
		} catch { return ''; }
	});
}

export function fetchSections (plexUrl: string, token: string): Promise<PlexSection[]> {
	return plexFetch(base(plexUrl) + '/library/sections', token).then(function (json) {
		try {
			var data = JSON.parse(json);
			var dirs = (data.MediaContainer || {}).Directory || [];
			var out: PlexSection[] = [];
			for (var i = 0; i < dirs.length; i++) {
				var d = dirs[i] as Record<string, unknown>;
				if (d.type === 'movie' || d.type === 'show') out.push({key: String(d.key), type: d.type as 'movie' | 'show', title: (d.title as string) || 'Section ' + d.key});
			}
			return out;
		} catch { return []; }
	});
}

export function fetchOnDeck (plexUrl: string, token: string, start?: number, size?: number): Promise<PlexPage> {
	return plexFetch(base(plexUrl) + '/library/onDeck?X-Plex-Container-Start=' + (start || 0) + '&X-Plex-Container-Size=' + (size || PAGE_SIZE), token).then(parsePage);
}

export function fetchRecentlyAdded (plexUrl: string, token: string, sectionId: string, start?: number, size?: number): Promise<PlexPage> {
	return plexFetch(base(plexUrl) + '/library/sections/' + encodeURIComponent(sectionId) + '/recentlyAdded?X-Plex-Container-Start=' + (start || 0) + '&X-Plex-Container-Size=' + (size || PAGE_SIZE), token).then(parsePage);
}

export function fetchSectionAll (plexUrl: string, token: string, sectionId: string, sort?: string, genre?: string, unwatched?: boolean, start?: number, size?: number): Promise<PlexPage> {
	var url = base(plexUrl) + '/library/sections/' + encodeURIComponent(sectionId) + '/all?X-Plex-Container-Start=' + (start || 0) + '&X-Plex-Container-Size=' + (size || PAGE_SIZE);
	if (sort) url += '&sort=' + encodeURIComponent(sort);
	if (genre) url += '&genre=' + encodeURIComponent(genre);
	if (unwatched) url += '&unwatched=1';
	return plexFetch(url, token).then(parsePage);
}

var genreCache: Record<string, PlexGenre[]> = {};

export function fetchGenres (plexUrl: string, token: string, sectionId: string): Promise<PlexGenre[]> {
	if (genreCache[sectionId]) return Promise.resolve(genreCache[sectionId]);
	return plexFetch(base(plexUrl) + '/library/sections/' + encodeURIComponent(sectionId) + '/genre', token).then(function (json) {
		try {
			var dirs = (JSON.parse(json).MediaContainer || {}).Directory || [];
			var out: PlexGenre[] = [];
			for (var i = 0; i < dirs.length; i++) { var d = dirs[i] as Record<string, unknown>; if (d.key && d.title) out.push({key: String(d.key), title: d.title as string}); }
			genreCache[sectionId] = out;
			return out;
		} catch { return []; }
	});
}

export function fetchSeasons (plexUrl: string, token: string, showKey: string): Promise<PlexItem[]> {
	return plexFetch(base(plexUrl) + '/library/metadata/' + encodeURIComponent(showKey) + '/children', token).then(function (json) { return parsePage(json).items; });
}

export function fetchEpisodes (plexUrl: string, token: string, seasonKey: string): Promise<PlexItem[]> {
	return plexFetch(base(plexUrl) + '/library/metadata/' + encodeURIComponent(seasonKey) + '/children', token).then(function (json) { return parsePage(json).items; });
}

export function plexSearch (plexUrl: string, token: string, query: string): Promise<PlexItem[]> {
	return plexFetch(base(plexUrl) + '/hubs/search?query=' + encodeURIComponent(query) + '&limit=20', token).then(function (json) {
		try {
			var hubs = (JSON.parse(json).MediaContainer || {}).Hub || [];
			var out: PlexItem[] = [];
			for (var h = 0; h < hubs.length; h++) {
				var hub = hubs[h] as Record<string, unknown>;
				if (hub.type !== 'movie' && hub.type !== 'show') continue;
				var meta = (hub as Record<string, unknown>).Metadata;
				if (Array.isArray(meta)) for (var i = 0; i < meta.length; i++) out.push(parseItem(meta[i] as Record<string, unknown>));
			}
			return out;
		} catch { return []; }
	});
}

export function plexPosterUrl (plexUrl: string, token: string, thumb: string | undefined): string | null {
	if (!thumb) return null;
	return base(plexUrl) + '/photo/:/transcode?width=342&height=513&minSize=1&url=' + encodeURIComponent(thumb) + '&X-Plex-Token=' + encodeURIComponent(token);
}

export function plexPosterUrlSmall (plexUrl: string, token: string, thumb: string | undefined): string | null {
	if (!thumb) return null;
	return base(plexUrl) + '/photo/:/transcode?width=185&height=278&minSize=1&url=' + encodeURIComponent(thumb) + '&X-Plex-Token=' + encodeURIComponent(token);
}

export function plexBackdropUrl (plexUrl: string, token: string, art: string | undefined): string | null {
	if (!art) return null;
	return base(plexUrl) + '/photo/:/transcode?width=1280&height=720&minSize=1&url=' + encodeURIComponent(art) + '&X-Plex-Token=' + encodeURIComponent(token);
}

export function plexSortValue (key: string): string {
	if (key === 'title') return 'titleSort:asc';
	if (key === 'year') return 'year:desc';
	if (key === 'rating') return 'audienceRating:desc';
	return 'addedAt:desc';
}

export function safeError (e: unknown, token: string): string {
	var msg = (e && typeof e === 'object' && 'message' in e) ? (e as Error).message : String(e);
	if (token) msg = msg.split(token).join('***');
	return msg || 'Connection failed';
}

export function fetchShowMeta (plexUrl: string, token: string, ratingKey: string): Promise<PlexItem> {
	return plexFetch(base(plexUrl) + '/library/metadata/' + encodeURIComponent(ratingKey), token).then(function (json) {
		var page = parsePage(json);
		if (page.items.length > 0) return page.items[0];
		return {ratingKey: ratingKey, type: 'show' as const, title: ''};
	});
}

export function plexStillUrl (plexUrl: string, token: string, thumb: string | undefined, width?: number): string | null {
	if (!thumb) return null;
	var w = width || 300;
	var h = Math.round(w * 9 / 16);
	return base(plexUrl) + '/photo/:/transcode?width=' + w + '&height=' + h + '&minSize=1&url=' + encodeURIComponent(thumb) + '&X-Plex-Token=' + encodeURIComponent(token);
}

// --- Plex TMDB index: lightweight in-memory map of tmdb IDs on the server ---

export interface PlexIndex {
	has (mediaType: 'tv' | 'movie', tmdbId: number): boolean;
	getRatingKey (mediaType: 'tv' | 'movie', tmdbId: number): string | null;
	getTmdbId (ratingKey: string): number | null;
}

var INDEX_TTL = 10 * 60 * 1000;
var INDEX_PAGE = 500;

interface IndexState {
	url: string;
	token: string;
	hiddenKeys: string;
	set: Record<string, string>;
	at: number;
	loading: boolean;
}

var _idx: IndexState | null = null;
var _listeners: Array<() => void> = [];

function indexKey (type: 'tv' | 'movie', tmdbId: number): string { return type + ':' + tmdbId; }

function parseTmdbEntries (json: string, sectionType: 'movie' | 'show'): Array<{key: string; rk: string}> {
	try {
		var mc = JSON.parse(json).MediaContainer || {};
		var meta = mc.Metadata;
		if (!Array.isArray(meta)) return [];
		var out: Array<{key: string; rk: string}> = [];
		for (var i = 0; i < meta.length; i++) {
			var rk = String((meta[i] as Record<string, unknown>).ratingKey || '');
			if (!rk) continue;
			var guids = (meta[i] as Record<string, unknown>).Guid;
			if (!Array.isArray(guids)) continue;
			for (var g = 0; g < guids.length; g++) {
				var id = (guids[g] as Record<string, unknown>).id;
				if (typeof id === 'string' && id.indexOf('tmdb://') === 0) {
					var num = parseInt(id.slice(7), 10);
					if (num > 0) out.push({key: indexKey(sectionType === 'show' ? 'tv' : 'movie', num), rk: rk});
				}
			}
		}
		return out;
	} catch { return []; }
}

function fetchSectionEntries (plexUrl: string, token: string, sectionId: string, sectionType: 'movie' | 'show'): Promise<Array<{key: string; rk: string}>> {
	var all: Array<{key: string; rk: string}> = [];
	function page (start: number): Promise<Array<{key: string; rk: string}>> {
		var url = base(plexUrl) + '/library/sections/' + encodeURIComponent(sectionId) + '/all?includeGuids=1&X-Plex-Container-Start=' + start + '&X-Plex-Container-Size=' + INDEX_PAGE;
		return plexFetch(url, token).then(function (json) {
			var entries = parseTmdbEntries(json, sectionType);
			for (var i = 0; i < entries.length; i++) all.push(entries[i]);
			var mc = (JSON.parse(json) || {}).MediaContainer || {};
			var total = typeof mc.totalSize === 'number' ? mc.totalSize : 0;
			if (start + INDEX_PAGE < total) return page(start + INDEX_PAGE);
			return all;
		});
	}
	return page(0);
}

function buildIndex (plexUrl: string, token: string, hiddenSections: string[]): Promise<Record<string, string>> {
	return fetchSections(plexUrl, token).then(function (sections) {
		var hiddenSet: Record<string, true> = {};
		for (var h = 0; h < hiddenSections.length; h++) hiddenSet[hiddenSections[h]] = true;
		var tasks: Array<Promise<Array<{key: string; rk: string}>>> = [];
		for (var i = 0; i < sections.length; i++) {
			if (hiddenSet[sections[i].key]) continue;
			tasks.push(fetchSectionEntries(plexUrl, token, sections[i].key, sections[i].type));
		}
		return Promise.all(tasks).then(function (results) {
			var set: Record<string, string> = {};
			for (var r = 0; r < results.length; r++) {
				for (var j = 0; j < results[r].length; j++) set[results[r][j].key] = results[r][j].rk;
			}
			return set;
		});
	});
}

function notifyListeners (): void {
	for (var i = 0; i < _listeners.length; i++) { try { _listeners[i](); } catch { /* */ } }
}

export function refreshPlexIndex (plexUrl: string, token: string, hiddenSections: string[]): void {
	if (!plexUrl || !token) return;
	var hk = hiddenSections.slice().sort().join(',');
	if (_idx && _idx.loading && _idx.url === plexUrl && _idx.hiddenKeys === hk) return;
	if (_idx) _idx.loading = true;
	buildIndex(plexUrl, token, hiddenSections).then(function (set) {
		_idx = {url: plexUrl, token: token, hiddenKeys: hk, set: set, at: Date.now(), loading: false};
		notifyListeners();
	}).catch(function () {
		if (_idx) _idx.loading = false;
	});
}

export function getPlexIndex (plexUrl: string, token: string, hiddenSections: string[]): PlexIndex | null {
	if (!plexUrl || !token) return null;
	var hk = hiddenSections.slice().sort().join(',');
	if (!_idx || _idx.url !== plexUrl || _idx.hiddenKeys !== hk) {
		refreshPlexIndex(plexUrl, token, hiddenSections);
		return null;
	}
	if (Date.now() - _idx.at > INDEX_TTL && !_idx.loading) {
		refreshPlexIndex(plexUrl, token, hiddenSections);
	}
	var set = _idx.set;
	var rev: Record<string, number> | null = null;
	function reverseMap (): Record<string, number> {
		if (rev) return rev;
		rev = {};
		for (var k in set) {
			var parts = k.split(':');
			if (parts.length === 2) rev[set[k]] = parseInt(parts[1], 10);
		}
		return rev;
	}
	return {
		has: function (mediaType, tmdbId) { return indexKey(mediaType, tmdbId) in set; },
		getRatingKey: function (mediaType, tmdbId) { var k = indexKey(mediaType, tmdbId); return k in set ? set[k] : null; },
		getTmdbId: function (ratingKey) { var r = reverseMap(); return ratingKey in r ? r[ratingKey] : null; }
	};
}

export function onPlexIndexChange (fn: () => void): () => void {
	_listeners.push(fn);
	return function () { _listeners = _listeners.filter(function (f) { return f !== fn; }); };
}
