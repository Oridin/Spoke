import {exec} from './apps';

const FETCHBOX = 'https://fetchbox-two.vercel.app';
const COOKIE = '/tmp/fetchbox.cookie';
const PASSCODE = '150277';

function curlPost (path: string, body: string, timeout = 30000): Promise<string> {
	const safeBody = body.replace(/'/g, "'\\''");
	return exec(`curl -s -b ${COOKIE} -c ${COOKIE} -X POST -H 'Content-Type: application/json' -d '${safeBody}' '${FETCHBOX}${path}'`, timeout);
}

function login (): Promise<void> {
	return curlPost('/api/login', JSON.stringify({passcode: PASSCODE})).then(() => undefined);
}

interface SearchOption { fid: string; filename: string; name?: string; size?: number }
interface SearchMovie { title: string; year?: number; exact?: boolean; options: SearchOption[] }
interface SearchSeason { label: string; pack?: SearchOption; episodes: SearchOption[] }
interface SearchShow { title: string; seasons: SearchSeason[] }
interface SearchResult { movies: SearchMovie[]; shows: SearchShow[]; preselect: string[] }
interface GrabItem { fid: string; filename: string; name: string }
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
