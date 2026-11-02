import {fetchText} from './weathernet';
import {parseTrendingList, parseProviders, watchProvidersUrl, type TrendingShow, type ShowProvider, type MediaType} from './trending';

export interface Genre {
	id: number;
	name: string;
}

export interface DiscoverParams {
	genreId?: number;
	sortBy?: string;
	page?: number;
	providers?: string;
	minRating?: number;
	minVotes?: number;
	year?: number;
	decadeStart?: number;
}

var movieGenresCache: Genre[] | null = null;
var tvGenresCache: Genre[] | null = null;

function genreListUrl (type: MediaType, apiKey: string): string {
	return 'https://api.themoviedb.org/3/genre/' + type + '/list?api_key=' + encodeURIComponent(apiKey) + '&language=en-US';
}

function discoverUrl (type: MediaType, apiKey: string, params: DiscoverParams): string {
	var url = 'https://api.themoviedb.org/3/discover/' + type + '?api_key=' + encodeURIComponent(apiKey) + '&language=en-US';
	if (params.sortBy) url += '&sort_by=' + params.sortBy;
	if (params.genreId) url += '&with_genres=' + params.genreId;
	if (params.page) url += '&page=' + params.page;
	if (params.providers) url += '&with_watch_providers=' + params.providers + '&watch_region=US';
	if (params.minRating) url += '&vote_average.gte=' + params.minRating;
	if (params.minVotes) url += '&vote_count.gte=' + params.minVotes;
	if (params.decadeStart) {
		var end = params.decadeStart + 9;
		if (type === 'movie') url += '&primary_release_date.gte=' + params.decadeStart + '-01-01&primary_release_date.lte=' + end + '-12-31';
		else url += '&first_air_date.gte=' + params.decadeStart + '-01-01&first_air_date.lte=' + end + '-12-31';
	}
	return url;
}

function searchUrl (type: MediaType, apiKey: string, query: string, page: number): string {
	return 'https://api.themoviedb.org/3/search/' + type + '?api_key=' + encodeURIComponent(apiKey) + '&language=en-US&query=' + encodeURIComponent(query) + '&page=' + page;
}

function parseGenres (json: string): Genre[] {
	try {
		var data = JSON.parse(json);
		return Array.isArray(data.genres) ? data.genres.filter(function (g: Record<string, unknown>) { return typeof g.id === 'number' && typeof g.name === 'string'; }) as Genre[] : [];
	} catch {
		return [];
	}
}

export function fetchGenres (type: MediaType, apiKey: string, allowShell: boolean): Promise<Genre[]> {
	var cached = type === 'movie' ? movieGenresCache : tvGenresCache;
	if (cached) return Promise.resolve(cached);
	return fetchText(genreListUrl(type, apiKey), allowShell).then(function (json) {
		var genres = parseGenres(json);
		if (type === 'movie') movieGenresCache = genres;
		else tvGenresCache = genres;
		return genres;
	});
}

export function fetchDiscover (type: MediaType, apiKey: string, params: DiscoverParams, allowShell: boolean): Promise<{items: TrendingShow[]; totalPages: number}> {
	return fetchText(discoverUrl(type, apiKey, params), allowShell).then(function (json) {
		try {
			var data = JSON.parse(json);
			var totalPages = typeof data.total_pages === 'number' ? Math.min(data.total_pages, 500) : 1;
			var items = parseTrendingList(json, type, 20);
			return {items: items, totalPages: totalPages};
		} catch {
			return {items: [], totalPages: 0};
		}
	});
}

export function fetchSearchResults (type: MediaType, apiKey: string, query: string, page: number, allowShell: boolean): Promise<{items: TrendingShow[]; totalPages: number}> {
	return fetchText(searchUrl(type, apiKey, query, page), allowShell).then(function (json) {
		try {
			var data = JSON.parse(json);
			var totalPages = typeof data.total_pages === 'number' ? Math.min(data.total_pages, 500) : 1;
			var items = parseTrendingList(json, type, 20);
			return {items: items, totalPages: totalPages};
		} catch {
			return {items: [], totalPages: 0};
		}
	});
}

export function attachItemProviders (items: TrendingShow[], apiKey: string, allowShell: boolean): Promise<TrendingShow[]> {
	if (items.length === 0) return Promise.resolve([]);
	var promises = items.map(function (item) {
		return fetchText(watchProvidersUrl(item.id, item.mediaType, apiKey), allowShell)
			.then(function (pJson) { return parseProviders(pJson); })
			.catch(function (): ShowProvider[] { return []; });
	});
	return Promise.all(promises).then(function (providerLists) {
		return items.map(function (item, i) { return {...item, providers: providerLists[i]}; });
	});
}

export function sortApiValue (key: string, type: MediaType): string {
	if (key === 'popular') return 'popularity.desc';
	if (key === 'top_rated') return 'vote_average.desc';
	return type === 'movie' ? 'primary_release_date.desc' : 'first_air_date.desc';
}

// --- TMDB show/season detail types and fetchers ---

export interface TmdbSeason {
	season_number: number;
	name: string;
	episode_count: number;
	air_date: string | null;
}

export interface TmdbShowDetail {
	id: number;
	name: string;
	overview: string;
	status: string;
	number_of_seasons: number;
	seasons: TmdbSeason[];
	vote_average: number;
	first_air_date: string;
	backdrop_path: string | null;
	content_rating: string | null;
}

export interface TmdbEpisode {
	episode_number: number;
	season_number: number;
	name: string;
	overview: string;
	still_path: string | null;
	air_date: string | null;
	runtime: number | null;
	vote_average: number;
}

export interface TmdbSeasonDetail {
	season_number: number;
	name: string;
	episodes: TmdbEpisode[];
}

function showDetailUrl (apiKey: string, tmdbId: number): string {
	return 'https://api.themoviedb.org/3/tv/' + tmdbId + '?api_key=' + encodeURIComponent(apiKey) + '&language=en-US&append_to_response=content_ratings';
}

function seasonDetailUrl (apiKey: string, tmdbId: number, seasonNumber: number): string {
	return 'https://api.themoviedb.org/3/tv/' + tmdbId + '/season/' + seasonNumber + '?api_key=' + encodeURIComponent(apiKey) + '&language=en-US';
}

function parseContentRating (data: Record<string, unknown>): string | null {
	try {
		var cr = data.content_ratings as Record<string, unknown> | undefined;
		if (!cr) return null;
		var results = cr.results as Array<Record<string, unknown>> | undefined;
		if (!Array.isArray(results)) return null;
		for (var i = 0; i < results.length; i++) {
			if (results[i].iso_3166_1 === 'US' && typeof results[i].rating === 'string') return results[i].rating as string;
		}
		return null;
	} catch { return null; }
}

function parseTmdbSeason (s: Record<string, unknown>): TmdbSeason {
	return {
		season_number: typeof s.season_number === 'number' ? s.season_number : 0,
		name: typeof s.name === 'string' ? s.name : 'Season ' + (s.season_number || 0),
		episode_count: typeof s.episode_count === 'number' ? s.episode_count : 0,
		air_date: typeof s.air_date === 'string' ? s.air_date : null,
	};
}

export function fetchTmdbShowDetail (apiKey: string, tmdbId: number, allowShell: boolean): Promise<TmdbShowDetail> {
	return fetchText(showDetailUrl(apiKey, tmdbId), allowShell).then(function (json) {
		try {
			var data = JSON.parse(json) as Record<string, unknown>;
			var rawSeasons = Array.isArray(data.seasons) ? data.seasons as Array<Record<string, unknown>> : [];
			var seasons: TmdbSeason[] = [];
			for (var i = 0; i < rawSeasons.length; i++) seasons.push(parseTmdbSeason(rawSeasons[i]));
			return {
				id: typeof data.id === 'number' ? data.id : tmdbId,
				name: typeof data.name === 'string' ? data.name : '',
				overview: typeof data.overview === 'string' ? data.overview : '',
				status: typeof data.status === 'string' ? data.status : '',
				number_of_seasons: typeof data.number_of_seasons === 'number' ? data.number_of_seasons : 0,
				seasons: seasons,
				vote_average: typeof data.vote_average === 'number' ? Math.round(data.vote_average * 10) / 10 : 0,
				first_air_date: typeof data.first_air_date === 'string' ? data.first_air_date : '',
				backdrop_path: typeof data.backdrop_path === 'string' ? data.backdrop_path : null,
				content_rating: parseContentRating(data),
			};
		} catch {
			return {id: tmdbId, name: '', overview: '', status: '', number_of_seasons: 0, seasons: [], vote_average: 0, first_air_date: '', backdrop_path: null, content_rating: null};
		}
	});
}

function parseTmdbEpisode (e: Record<string, unknown>): TmdbEpisode {
	return {
		episode_number: typeof e.episode_number === 'number' ? e.episode_number : 0,
		season_number: typeof e.season_number === 'number' ? e.season_number : 0,
		name: typeof e.name === 'string' ? e.name : '',
		overview: typeof e.overview === 'string' ? e.overview : '',
		still_path: typeof e.still_path === 'string' ? e.still_path : null,
		air_date: typeof e.air_date === 'string' ? e.air_date : null,
		runtime: typeof e.runtime === 'number' ? e.runtime : null,
		vote_average: typeof e.vote_average === 'number' ? Math.round(e.vote_average * 10) / 10 : 0,
	};
}

export function fetchTmdbSeasonDetail (apiKey: string, tmdbId: number, seasonNumber: number, allowShell: boolean): Promise<TmdbSeasonDetail> {
	return fetchText(seasonDetailUrl(apiKey, tmdbId, seasonNumber), allowShell).then(function (json) {
		try {
			var data = JSON.parse(json) as Record<string, unknown>;
			var rawEps = Array.isArray(data.episodes) ? data.episodes as Array<Record<string, unknown>> : [];
			var episodes: TmdbEpisode[] = [];
			for (var i = 0; i < rawEps.length; i++) episodes.push(parseTmdbEpisode(rawEps[i]));
			return {
				season_number: typeof data.season_number === 'number' ? data.season_number : seasonNumber,
				name: typeof data.name === 'string' ? data.name : 'Season ' + seasonNumber,
				episodes: episodes,
			};
		} catch {
			return {season_number: seasonNumber, name: 'Season ' + seasonNumber, episodes: []};
		}
	});
}

export function findByTvdbId (apiKey: string, tvdbId: number, allowShell: boolean): Promise<TrendingShow | null> {
	var url = 'https://api.themoviedb.org/3/find/' + tvdbId + '?api_key=' + encodeURIComponent(apiKey) + '&external_source=tvdb_id';
	return fetchText(url, allowShell).then(function (json) {
		try {
			var data = JSON.parse(json);
			var results = data && Array.isArray(data.tv_results) ? data.tv_results : [];
			if (results.length === 0) return null;
			var r = results[0] as Record<string, unknown>;
			return {
				id: typeof r.id === 'number' ? r.id : 0,
				name: typeof r.name === 'string' ? r.name : '',
				mediaType: 'tv' as MediaType,
				overview: typeof r.overview === 'string' ? r.overview.slice(0, 200) : '',
				firstAir: typeof r.first_air_date === 'string' ? r.first_air_date : '',
				rating: typeof r.vote_average === 'number' ? Math.round(r.vote_average * 10) / 10 : 0,
				poster: typeof r.poster_path === 'string' ? r.poster_path : null,
				backdrop: typeof r.backdrop_path === 'string' ? r.backdrop_path : null,
				providers: []
			};
		} catch { return null; }
	});
}

export function tmdbStillUrl (stillPath: string | null, width?: number): string | null {
	if (!stillPath) return null;
	var w = width || 300;
	return 'https://image.tmdb.org/t/p/w' + w + stillPath;
}

// --- TMDB movie detail types and fetchers ---

export interface TmdbCastMember {
	id: number;
	name: string;
	character: string;
	profile_path: string | null;
	order: number;
}

export interface TmdbCollectionPart {
	id: number;
	title: string;
	poster_path: string | null;
	release_date: string;
	vote_average: number;
}

export interface TmdbCollectionInfo {
	id: number;
	name: string;
	poster_path: string | null;
	parts: TmdbCollectionPart[];
}

export interface TmdbMovieDetail {
	id: number;
	title: string;
	overview: string;
	status: string;
	runtime: number;
	genres: {id: number; name: string}[];
	vote_average: number;
	release_date: string;
	backdrop_path: string | null;
	poster_path: string | null;
	tagline: string;
	budget: number;
	revenue: number;
	collection: {id: number; name: string; poster_path: string | null} | null;
	cast: TmdbCastMember[];
	certification: string | null;
	recommendations: TrendingShow[];
	providers: ShowProvider[];
	imdb_id: string | null;
}

function movieDetailUrl (apiKey: string, tmdbId: number): string {
	return 'https://api.themoviedb.org/3/movie/' + tmdbId + '?api_key=' + encodeURIComponent(apiKey) + '&language=en-US&append_to_response=credits,release_dates,recommendations,watch%2Fproviders,external_ids';
}

function collectionUrl (apiKey: string, collectionId: number): string {
	return 'https://api.themoviedb.org/3/collection/' + collectionId + '?api_key=' + encodeURIComponent(apiKey) + '&language=en-US';
}

function parseCast (data: Record<string, unknown>): TmdbCastMember[] {
	try {
		var credits = data.credits as Record<string, unknown> | undefined;
		if (!credits) return [];
		var cast = credits.cast as Array<Record<string, unknown>> | undefined;
		if (!Array.isArray(cast)) return [];
		var result: TmdbCastMember[] = [];
		for (var i = 0; i < Math.min(cast.length, 15); i++) {
			var c = cast[i];
			result.push({
				id: typeof c.id === 'number' ? c.id : 0,
				name: typeof c.name === 'string' ? c.name : '',
				character: typeof c.character === 'string' ? c.character : '',
				profile_path: typeof c.profile_path === 'string' ? c.profile_path : null,
				order: typeof c.order === 'number' ? c.order : i,
			});
		}
		return result;
	} catch { return []; }
}

function parseMovieCertification (data: Record<string, unknown>): string | null {
	try {
		var rd = data.release_dates as Record<string, unknown> | undefined;
		if (!rd) return null;
		var results = rd.results as Array<Record<string, unknown>> | undefined;
		if (!Array.isArray(results)) return null;
		for (var i = 0; i < results.length; i++) {
			if (results[i].iso_3166_1 === 'US') {
				var dates = results[i].release_dates as Array<Record<string, unknown>> | undefined;
				if (!Array.isArray(dates)) continue;
				for (var j = 0; j < dates.length; j++) {
					if (typeof dates[j].certification === 'string' && dates[j].certification) return dates[j].certification as string;
				}
			}
		}
		return null;
	} catch { return null; }
}

function parseMovieProviders (data: Record<string, unknown>): ShowProvider[] {
	try {
		var wp = data['watch/providers'] as Record<string, unknown> | undefined;
		if (!wp) return [];
		var wResults = wp.results as Record<string, unknown> | undefined;
		if (!wResults) return [];
		var us = wResults.US as Record<string, unknown> | undefined;
		if (!us) return [];
		var flatrate = Array.isArray(us.flatrate) ? us.flatrate as Record<string, unknown>[] : [];
		var providers: ShowProvider[] = [];
		var seen: Record<number, boolean> = {};
		for (var i = 0; i < flatrate.length; i++) {
			var id = flatrate[i].provider_id;
			if (typeof id === 'number' && !seen[id]) {
				seen[id] = true;
				var name = typeof flatrate[i].provider_name === 'string' ? flatrate[i].provider_name as string : '';
				if (name) providers.push({id: id, name: name});
			}
		}
		return providers;
	} catch { return []; }
}

function parseMovieRecommendations (data: Record<string, unknown>): TrendingShow[] {
	try {
		var recs = data.recommendations as Record<string, unknown> | undefined;
		if (!recs) return [];
		var results = recs.results as Array<Record<string, unknown>> | undefined;
		if (!Array.isArray(results)) return [];
		var out: TrendingShow[] = [];
		for (var i = 0; i < Math.min(results.length, 15); i++) {
			var r = results[i];
			if (typeof r.id !== 'number' || r.id <= 0) continue;
			out.push({
				id: r.id as number,
				name: typeof r.title === 'string' ? r.title as string : '',
				mediaType: 'movie' as MediaType,
				overview: typeof r.overview === 'string' ? (r.overview as string).slice(0, 200) : '',
				firstAir: typeof r.release_date === 'string' ? r.release_date as string : '',
				rating: typeof r.vote_average === 'number' ? Math.round((r.vote_average as number) * 10) / 10 : 0,
				poster: typeof r.poster_path === 'string' ? r.poster_path as string : null,
				backdrop: typeof r.backdrop_path === 'string' ? r.backdrop_path as string : null,
				providers: [],
			});
		}
		return out;
	} catch { return []; }
}

export function fetchTmdbMovieDetail (apiKey: string, tmdbId: number, allowShell: boolean): Promise<TmdbMovieDetail> {
	return fetchText(movieDetailUrl(apiKey, tmdbId), allowShell).then(function (json) {
		try {
			var data = JSON.parse(json) as Record<string, unknown>;
			var genres: {id: number; name: string}[] = [];
			if (Array.isArray(data.genres)) {
				var rawGenres = data.genres as Array<Record<string, unknown>>;
				for (var i = 0; i < rawGenres.length; i++) {
					var g = rawGenres[i];
					if (typeof g.id === 'number' && typeof g.name === 'string') genres.push({id: g.id, name: g.name});
				}
			}
			var collection: TmdbMovieDetail['collection'] = null;
			if (data.belongs_to_collection && typeof data.belongs_to_collection === 'object') {
				var coll = data.belongs_to_collection as Record<string, unknown>;
				if (typeof coll.id === 'number') {
					collection = {
						id: coll.id,
						name: typeof coll.name === 'string' ? coll.name : '',
						poster_path: typeof coll.poster_path === 'string' ? coll.poster_path : null,
					};
				}
			}
			var externalIds = data.external_ids as Record<string, unknown> | undefined;
			return {
				id: typeof data.id === 'number' ? data.id : tmdbId,
				title: typeof data.title === 'string' ? data.title : '',
				overview: typeof data.overview === 'string' ? data.overview : '',
				status: typeof data.status === 'string' ? data.status : '',
				runtime: typeof data.runtime === 'number' ? data.runtime : 0,
				genres: genres,
				vote_average: typeof data.vote_average === 'number' ? Math.round(data.vote_average * 10) / 10 : 0,
				release_date: typeof data.release_date === 'string' ? data.release_date : '',
				backdrop_path: typeof data.backdrop_path === 'string' ? data.backdrop_path : null,
				poster_path: typeof data.poster_path === 'string' ? data.poster_path : null,
				tagline: typeof data.tagline === 'string' ? data.tagline : '',
				budget: typeof data.budget === 'number' ? data.budget : 0,
				revenue: typeof data.revenue === 'number' ? data.revenue : 0,
				collection: collection,
				cast: parseCast(data),
				certification: parseMovieCertification(data),
				recommendations: parseMovieRecommendations(data),
				providers: parseMovieProviders(data),
				imdb_id: externalIds && typeof externalIds.imdb_id === 'string' ? externalIds.imdb_id : null,
			};
		} catch {
			return {id: tmdbId, title: '', overview: '', status: '', runtime: 0, genres: [], vote_average: 0, release_date: '', backdrop_path: null, poster_path: null, tagline: '', budget: 0, revenue: 0, collection: null, cast: [], certification: null, recommendations: [], providers: [], imdb_id: null};
		}
	});
}

export function fetchTmdbCollection (apiKey: string, collectionId: number, allowShell: boolean): Promise<TmdbCollectionInfo> {
	return fetchText(collectionUrl(apiKey, collectionId), allowShell).then(function (json) {
		try {
			var data = JSON.parse(json) as Record<string, unknown>;
			var parts: TmdbCollectionPart[] = [];
			if (Array.isArray(data.parts)) {
				var rawParts = data.parts as Array<Record<string, unknown>>;
				for (var i = 0; i < rawParts.length; i++) {
					var p = rawParts[i];
					parts.push({
						id: typeof p.id === 'number' ? p.id : 0,
						title: typeof p.title === 'string' ? p.title : '',
						poster_path: typeof p.poster_path === 'string' ? p.poster_path : null,
						release_date: typeof p.release_date === 'string' ? p.release_date : '',
						vote_average: typeof p.vote_average === 'number' ? Math.round(p.vote_average * 10) / 10 : 0,
					});
				}
				parts.sort(function (a, b) { return (a.release_date || '').localeCompare(b.release_date || ''); });
			}
			return {
				id: typeof data.id === 'number' ? data.id : collectionId,
				name: typeof data.name === 'string' ? data.name : '',
				poster_path: typeof data.poster_path === 'string' ? data.poster_path : null,
				parts: parts,
			};
		} catch {
			return {id: collectionId, name: '', poster_path: null, parts: []};
		}
	});
}
