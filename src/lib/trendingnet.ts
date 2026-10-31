import {fetchText} from './weathernet';
import {parseTrendingList, parseProviders, tvTrendingUrl, movieTrendingUrl, watchProvidersUrl, type ShowProvider, type TrendingShow, type TrendingData} from './trending';

function attachProviders (items: TrendingShow[], apiKey: string, enabledProviderIds: number[], allowShell: boolean): Promise<TrendingShow[]> {
	if (items.length === 0) return Promise.resolve([]);
	const promises = items.map((item) =>
		fetchText(watchProvidersUrl(item.id, item.mediaType, apiKey), allowShell)
			.then((pJson) => parseProviders(pJson, enabledProviderIds))
			.catch((): ShowProvider[] => [])
	);
	return Promise.all(promises).then((providerLists) =>
		items.map((item, i) => ({...item, providers: providerLists[i]}))
			.filter((item) => item.providers.length > 0)
	);
}

export function fetchTrending (apiKey: string, enabledProviderIds: number[], allowShell: boolean, maxShows: number, maxMovies: number): Promise<TrendingData> {
	const fetchBatch = Math.max(maxShows, maxMovies) + 10;
	return Promise.all([
		fetchText(tvTrendingUrl(apiKey), allowShell).then((json) => parseTrendingList(json, 'tv', fetchBatch)),
		fetchText(movieTrendingUrl(apiKey), allowShell).then((json) => parseTrendingList(json, 'movie', fetchBatch))
	]).then(([tvRaw, movieRaw]) =>
		Promise.all([
			attachProviders(tvRaw, apiKey, enabledProviderIds, allowShell),
			attachProviders(movieRaw, apiKey, enabledProviderIds, allowShell)
		])
	).then(([shows, movies]) => ({shows: shows.slice(0, maxShows), movies: movies.slice(0, maxMovies)}));
}
