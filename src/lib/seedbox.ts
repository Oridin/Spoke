import {exec} from './apps';

const COOKIE = '/tmp/fetchbox.cookie';
const TMP_BODY = '/tmp/fetchbox-body.json';

let fetchboxUrl = 'https://fetchbox-two.vercel.app';
let fetchboxPasscode = '';

export function configureFetchbox (url: string, passcode: string): void {
	if (url) fetchboxUrl = url.replace(/\/+$/, '');
	fetchboxPasscode = passcode;
}

function shellQuote (s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

function curlPost (path: string, body: string, timeout = 30000): Promise<string> {
	return exec('printf %s ' + shellQuote(body) + ' > ' + TMP_BODY, 5000)
		.then(() => exec(`curl -s -b ${COOKIE} -c ${COOKIE} -X POST -H 'Content-Type: application/json' -d @${TMP_BODY} ${shellQuote(fetchboxUrl + path)}`, timeout));
}

function login (): Promise<void> {
	if (!fetchboxPasscode) return Promise.reject(new Error('Fetchbox passcode not set — enter it in Settings → Connections'));
	return curlPost('/api/login', JSON.stringify({passcode: fetchboxPasscode})).then(() => undefined);
}

export interface SearchOption { fid: string; filename: string; name?: string; size?: number }
export interface SearchMovie { title: string; year?: number; exact?: boolean; options: SearchOption[] }
export interface SearchSeason { label: string; pack?: SearchOption; episodes: SearchOption[] }
export interface SearchShow { title: string; seasons: SearchSeason[] }
export interface SearchResult { movies: SearchMovie[]; shows: SearchShow[]; preselect: string[] }
export interface GrabItem { fid: string; filename: string; name: string }
interface GrabResult { name: string; hash?: string; already?: boolean; error?: string }

function findByFid (result: SearchResult, fid: string): GrabItem | null {
	for (const m of result.movies) {
		for (const o of m.options) {
			if (o.fid === fid) return {fid: o.fid, filename: o.filename, name: m.title};
		}
	}
	for (const s of result.shows) {
		for (const season of s.seasons) {
			if (season.pack && season.pack.fid === fid) return {fid: season.pack.fid, filename: season.pack.filename, name: s.title};
			for (const e of season.episodes) {
				if (e.fid === fid) return {fid: e.fid, filename: e.filename, name: s.title};
			}
		}
	}
	return null;
}

function pickBest (result: SearchResult, mediaType: string): GrabItem[] {
	if (result.preselect && result.preselect.length > 0) {
		const items: GrabItem[] = [];
		for (const fid of result.preselect) {
			const item = findByFid(result, fid);
			if (item) items.push(item);
		}
		if (items.length > 0) return items;
	}
	if (mediaType === 'movie' && result.movies.length > 0) {
		const movie = result.movies[0];
		if (movie.options.length > 0) {
			const o = movie.options[0];
			return [{fid: o.fid, filename: o.filename, name: movie.title}];
		}
	}
	if (result.shows.length > 0) {
		const show = result.shows[0];
		for (const season of show.seasons) {
			if (season.pack) return [{fid: season.pack.fid, filename: season.pack.filename, name: show.title}];
			if (season.episodes.length > 0) {
				const e = season.episodes[0];
				return [{fid: e.fid, filename: e.filename, name: show.title}];
			}
		}
	}
	if (result.movies.length > 0 && result.movies[0].options.length > 0) {
		const o = result.movies[0].options[0];
		return [{fid: o.fid, filename: o.filename, name: result.movies[0].title}];
	}
	return [];
}

export interface SeedboxResult { grabbed: string[]; errors: string[] }

export function searchSeedbox (name: string, year: string): Promise<SearchResult> {
	const query = year ? name + ' ' + year : name;
	return login()
		.then(() => curlPost('/api/search', JSON.stringify({query, browse: true})))
		.then((text) => JSON.parse(text) as SearchResult);
}

export function grabFromSeedbox (items: GrabItem[]): Promise<SeedboxResult> {
	return login()
		.then(() => curlPost('/api/grab', JSON.stringify({items})))
		.then((grabText) => {
			const r = JSON.parse(grabText) as {results: GrabResult[]};
			return {
				grabbed: r.results.filter((i) => !i.error).map((i) => i.name),
				errors: r.results.filter((i) => i.error).map((i) => i.name + ': ' + i.error)
			};
		});
}

export function sendToSeedbox (name: string, year: string, mediaType: string): Promise<SeedboxResult> {
	const query = year ? name + ' ' + year : name;
	return login()
		.then(() => curlPost('/api/search', JSON.stringify({query, browse: true})))
		.then((text) => {
			const result = JSON.parse(text) as SearchResult;
			const items = pickBest(result, mediaType);
			if (items.length === 0) return {grabbed: [], errors: ['No results found for ' + query]};
			return curlPost('/api/grab', JSON.stringify({items}))
				.then((grabText) => {
					const r = JSON.parse(grabText) as {results: GrabResult[]};
					return {
						grabbed: r.results.filter((i) => !i.error).map((i) => i.name),
						errors: r.results.filter((i) => i.error).map((i) => i.name + ': ' + i.error)
					};
				});
		});
}
