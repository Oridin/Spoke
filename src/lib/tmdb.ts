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
