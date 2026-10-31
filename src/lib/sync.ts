const SYNC_KEY = 'spoke-sync-v1';
const GIST_FILE = 'spoke-config.json';

export interface SyncState {
	token: string;
	gistId: string;
}

export function loadSyncState (): SyncState {
	try {
		const raw = localStorage.getItem(SYNC_KEY);
		if (!raw) return {token: '', gistId: ''};
		const parsed = JSON.parse(raw);
		return {
			token: typeof parsed.token === 'string' ? parsed.token : '',
			gistId: typeof parsed.gistId === 'string' ? parsed.gistId : ''
		};
	} catch {
		return {token: '', gistId: ''};
	}
}

export function saveSyncState (state: SyncState): void {
	localStorage.setItem(SYNC_KEY, JSON.stringify(state));
}

function headers (token: string): Record<string, string> {
	return {
		'Authorization': 'token ' + token,
		'Accept': 'application/vnd.github.v3+json',
		'Content-Type': 'application/json'
	};
}

export async function pushConfig (config: unknown, sync: SyncState): Promise<SyncState> {
	const body = {files: {[GIST_FILE]: {content: JSON.stringify(config, null, 2)}}};
	if (sync.gistId) {
		await fetch('https://api.github.com/gists/' + sync.gistId, {
			method: 'PATCH', headers: headers(sync.token), body: JSON.stringify(body)
		}).then((r) => { if (!r.ok) throw new Error('Gist update failed: ' + r.status); });
		return sync;
	}
	const res = await fetch('https://api.github.com/gists', {
		method: 'POST', headers: headers(sync.token),
		body: JSON.stringify({...body, description: 'Spoke TV launcher settings', public: false})
	});
	if (!res.ok) throw new Error('Gist create failed: ' + res.status);
	const data = await res.json();
	const next = {...sync, gistId: data.id};
	saveSyncState(next);
	return next;
}

export async function pullConfig (sync: SyncState): Promise<Record<string, unknown> | null> {
	if (!sync.token || !sync.gistId) return null;
	const res = await fetch('https://api.github.com/gists/' + sync.gistId, {
		headers: headers(sync.token)
	});
	if (!res.ok) return null;
	const data = await res.json();
	const file = data.files && data.files[GIST_FILE];
	if (!file || !file.content) return null;
	try {
		return JSON.parse(file.content);
	} catch {
		return null;
	}
}
