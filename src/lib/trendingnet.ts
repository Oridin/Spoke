import {fetchText} from './weathernet';
import {parseTrendingList, parseProviders, tvTrendingUrl, movieTrendingUrl, watchProvidersUrl, type ShowProvider, type TrendingShow, type TrendingData} from './trending';

function attachProviders (items: TrendingShow[], apiKey: string, allowShell: boolean): Promise<TrendingShow[]> {
	if (items.length === 0) return Promise.resolve([]);
	const promises = items.map((item) =>
		fetchText(watchProvidersUrl(item.id, item.mediaType, apiKey), allowShell)
			.then((pJson) => parseProviders(pJson))
			.catch((): ShowProvider[] => [])
	);
	return Promise.all(promises).then((providerLists) =>
		items.map((item, i) => ({...item, providers: providerLists[i]}))
	);
}

function fetchPages (urlFn: (key: string, page: number) => string, apiKey: string, mediaType: 'tv' | 'movie', limit: number, allowShell: boolean): Promise<TrendingShow[]> {
	const pages = limit > 10 ? 2 : 1;
	const perPage = 20;
	const fetches = Array.from({length: pages}, (_, i) =>
		fetchText(urlFn(apiKey, i + 1), allowShell).then((json) => parseTrendingList(json, mediaType, perPage))
	);
	return Promise.all(fetches).then((lists) => lists.flat());
}

export function fetchTrending (apiKey: string, allowShell: boolean, maxShows: number, maxMovies: number): Promise<TrendingData> {
	return Promise.all([
		fetchPages(tvTrendingUrl, apiKey, 'tv', maxShows, allowShell),
		fetchPages(movieTrendingUrl, apiKey, 'movie', maxMovies, allowShell)
	]).then(([tvRaw, movieRaw]) =>
		Promise.all([
			attachProviders(tvRaw, apiKey, allowShell),
			attachProviders(movieRaw, apiKey, allowShell)
		])
	).then(([shows, movies]) => ({shows: shows.slice(0, maxShows), movies: movies.slice(0, maxMovies)}));
}
