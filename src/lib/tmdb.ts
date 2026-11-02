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
