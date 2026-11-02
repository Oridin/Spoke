// Trending TV shows and movies from TMDB (The Movie Database): types, API addresses, parsing and the saved copy.
// trendingnet.ts does the fetching. The user's TMDB API key and enabled providers live in the config.

export type MediaType = 'tv' | 'movie';

export interface TrendingShow {
	id: number;
	name: string;
	mediaType: MediaType;
	overview: string;
	firstAir: string;
	rating: number;
	poster: string | null;
	backdrop: string | null;
	providers: ShowProvider[];
}

export interface TrendingData {
	shows: TrendingShow[];
	movies: TrendingShow[];
}

export interface ShowProvider {
	id: number;
	name: string;
}

export interface ProviderDef {
	tmdbId: number;
	name: string;
	short: string;
	appPatterns: string[];
}

export const PROVIDERS: ProviderDef[] = [
	{tmdbId: 8, name: 'Netflix', short: 'Netflix', appPatterns: ['netflix']},
	{tmdbId: 9, name: 'Amazon Prime Video', short: 'Prime', appPatterns: ['amazon', 'prime']},
	{tmdbId: 337, name: 'Disney+', short: 'Disney+', appPatterns: ['disney']},
	{tmdbId: 15, name: 'Hulu', short: 'Hulu', appPatterns: ['hulu']},
	{tmdbId: 1899, name: 'Max', short: 'Max', appPatterns: ['hbo', 'max']},
	{tmdbId: 350, name: 'Apple TV+', short: 'Apple TV+', appPatterns: ['apple']},
	{tmdbId: 531, name: 'Paramount+', short: 'Paramount+', appPatterns: ['paramount', 'cbs']},
	{tmdbId: 386, name: 'Peacock', short: 'Peacock', appPatterns: ['peacock']},
	{tmdbId: 73, name: 'Tubi', short: 'Tubi', appPatterns: ['tubi']},
	{tmdbId: 257, name: 'fuboTV', short: 'fuboTV', appPatterns: ['fubo']},
	{tmdbId: 43, name: 'Starz', short: 'Starz', appPatterns: ['starz']},
	{tmdbId: 37, name: 'Showtime', short: 'Showtime', appPatterns: ['showtime', 'sho']},
	{tmdbId: 300, name: 'Pluto TV', short: 'Pluto', appPatterns: ['pluto']},
	{tmdbId: 387, name: 'BET+', short: 'BET+', appPatterns: ['bet']},
	{tmdbId: 1770, name: 'Crunchyroll', short: 'Crunchyroll', appPatterns: ['crunchyroll']},
	{tmdbId: 283, name: 'Crackle', short: 'Crackle', appPatterns: ['crackle']}
];

export const ALL_PROVIDER_IDS: number[] = PROVIDERS.map((p) => p.tmdbId);

export const TRENDING_CACHE_KEY = 'spoke-trending-v4';
export const FRESH_MS = 6 * 60 * 60 * 1000;  // default, overridden by config.trending.refreshHours

export function tvTrendingUrl (apiKey: string, page = 1): string {
	return 'https://api.themoviedb.org/3/trending/tv/week?api_key=' + encodeURIComponent(apiKey) + '&language=en-US&page=' + page;
}

export function movieTrendingUrl (apiKey: string, page = 1): string {
	return 'https://api.themoviedb.org/3/trending/movie/week?api_key=' + encodeURIComponent(apiKey) + '&language=en-US&page=' + page;
}

export function watchProvidersUrl (id: number, mediaType: MediaType, apiKey: string): string {
	return 'https://api.themoviedb.org/3/' + mediaType + '/' + id + '/watch/providers?api_key=' + encodeURIComponent(apiKey);
}

export function posterUrl (path: string | null): string | null {
	if (!path) return null;
	return 'https://image.tmdb.org/t/p/w92' + path;
}

export function posterUrlLarge (path: string | null): string | null {
	if (!path) return null;
	return 'https://image.tmdb.org/t/p/w185' + path;
}

export function posterUrlXL (path: string | null): string | null {
	if (!path) return null;
	return 'https://image.tmdb.org/t/p/w342' + path;
}

export function backdropUrl (path: string | null): string | null {
	if (!path) return null;
	return 'https://image.tmdb.org/t/p/w1280' + path;
}

export function profileUrl (path: string | null): string | null {
	if (!path) return null;
	return 'https://image.tmdb.org/t/p/w185' + path;
}

export function parseTrendingList (json: string, mediaType: MediaType, limit: number): TrendingShow[] {
	try {
		const data = JSON.parse(json);
		const results = data && Array.isArray(data.results) ? data.results : [];
		return results
			.slice(0, limit)
			.map((r: Record<string, unknown>): TrendingShow => {
				const isMovie = mediaType === 'movie';
				return {
					id: typeof r.id === 'number' ? r.id : 0,
					name: isMovie
						? (typeof r.title === 'string' ? r.title : '')
						: (typeof r.name === 'string' ? r.name : ''),
					mediaType,
					overview: typeof r.overview === 'string' ? r.overview.slice(0, 200) : '',
					firstAir: isMovie
						? (typeof r.release_date === 'string' ? r.release_date : '')
						: (typeof r.first_air_date === 'string' ? r.first_air_date : ''),
					rating: typeof r.vote_average === 'number' ? Math.round(r.vote_average * 10) / 10 : 0,
					poster: typeof r.poster_path === 'string' ? r.poster_path : null,
					backdrop: typeof r.backdrop_path === 'string' ? r.backdrop_path : null,
					providers: []
				};
			})
			.filter((s: TrendingShow) => s.id > 0 && s.name);
	} catch {
		return [];
	}
}

export function parseProviders (json: string): ShowProvider[] {
	try {
		const data = JSON.parse(json);
		const us = data && data.results && data.results.US;
		if (!us) return [];
		const flatrate = Array.isArray(us.flatrate) ? us.flatrate as Record<string, unknown>[] : [];
		const seen = new Set<number>();
		const all: ShowProvider[] = [];
		for (const p of flatrate) {
			const id = p.provider_id as number;
			if (typeof id === 'number' && !seen.has(id)) {
				seen.add(id);
				const name = typeof p.provider_name === 'string' ? p.provider_name : '';
				if (name) all.push({id, name});
			}
		}
		return all;
	} catch {
		return [];
	}
}

export function providerDef (tmdbId: number): ProviderDef | undefined {
	return PROVIDERS.find((p) => p.tmdbId === tmdbId);
}

export function findProviderApp (provider: ProviderDef, installedAppIds: string[]): string | undefined {
	for (const pattern of provider.appPatterns) {
		const found = installedAppIds.find((id) => id.toLowerCase().indexOf(pattern) !== -1);
		if (found) return found;
	}
	return undefined;
}

export function yearOf (dateStr: string): string {
	return dateStr && dateStr.length >= 4 ? dateStr.slice(0, 4) : '';
}

export interface TrendingCache {
	data: TrendingData;
	at: number;
}

export function readTrendingCache (): TrendingCache | null {
	try {
		const raw = localStorage.getItem(TRENDING_CACHE_KEY);
		if (!raw) return null;
		const d = JSON.parse(raw);
		if (!d.data || !Array.isArray(d.data.shows) || !Array.isArray(d.data.movies) || typeof d.at !== 'number') return null;
		return {data: d.data, at: d.at};
	} catch {
		return null;
	}
}

export function writeTrendingCache (data: TrendingData): void {
	try { localStorage.setItem(TRENDING_CACHE_KEY, JSON.stringify({data, at: Date.now()})); }
	catch { /* storage full */ }
}

export function isTrendingFresh (cache: TrendingCache | null, freshMs?: number): boolean {
	const ms = freshMs || FRESH_MS;
	return !!cache && Date.now() - cache.at < ms && (cache.data.shows.length > 0 || cache.data.movies.length > 0);
}

export function trendingLine (shows: TrendingShow[], max: number): string {
	if (shows.length === 0) return '';
	return shows.slice(0, max).map((s) => s.name).join('  ·  ');
}
