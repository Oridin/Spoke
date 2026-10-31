import {useCallback, useEffect, useRef, useState} from 'preact/hooks';
import {useKeys, type NavKey} from '../hooks/useKeys';
import {loadSyncState, saveSyncState, pushConfig, pullConfig, type SyncState} from '../lib/sync';
import {loadConfig, saveConfig} from '../lib/storage';

interface Props {
	onSync: (state: SyncState) => void;
	onClose: () => void;
	onToast: (text: string, kind?: 'error') => void;
}

export function SyncSetup ({onSync, onClose, onToast}: Props) {
	const [typing, setTyping] = useState(false);
	const [busy, setBusy] = useState(false);
	const [sync, setSync] = useState<SyncState>(loadSyncState);
	const input = useRef<HTMLInputElement>(null);

	useEffect(() => { if (typing && input.current) input.current.focus(); }, [typing]);

	const handleKey = useCallback((key: NavKey): boolean => {
		if (busy) return true;
		if (key === 'enter') setTyping(true);
		else if (key === 'back') onClose();
		return true;
	}, [onClose, busy]);

	useKeys(handleKey, !typing);

	const onFieldKey = (e: KeyboardEvent) => {
		if (e.keyCode === 13) {
			e.preventDefault();
			const value = (e.target as HTMLInputElement).value.trim();
			setTyping(false);
			if (value.length > 0) {
				const next = {...sync, token: value};
				setSync(next);
				saveSyncState(next);
				if (next.gistId) {
					doSync(next);
				} else {
					doPush(next);
				}
			}
		} else if (e.keyCode === 461 || e.keyCode === 27) {
			e.preventDefault();
			setTyping(false);
		}
	};

	const doPush = (s: SyncState) => {
		setBusy(true);
		const config = loadConfig();
		pushConfig(config, s)
			.then((updated) => {
				saveSyncState(updated);
				setSync(updated);
				onSync(updated);
				onToast('Settings pushed to cloud');
				setBusy(false);
			})
			.catch((err: Error) => {
				onToast(err.message || 'Sync failed', 'error');
				setBusy(false);
			});
	};

	const doSync = (s: SyncState) => {
		setBusy(true);
		pullConfig(s)
			.then((remote) => {
				if (remote) {
					const config = loadConfig(remote);
					saveConfig(config);
					onSync(s);
					onToast('Settings synced from cloud');
				} else {
					doPush(s);
				}
				setBusy(false);
			})
			.catch(() => {
				onToast('Sync failed', 'error');
				setBusy(false);
			});
	};

	const status = sync.token
		? (sync.gistId ? 'Linked' : 'Token set, not yet synced')
		: 'Not configured';

	return (
		<div class="screen screen--picker">
			<div class="settings">
				<h1 class="settings__title">Settings Sync</h1>
				<p class="settings__hint">{busy ? 'Syncing…' : typing ? 'Paste your GitHub token, then press OK · Back cancels' : 'OK to enter token · Back returns'}</p>
				<div class="apikey">
					<p class="apikey__desc">
						Sync settings across all your TVs using a private GitHub Gist.
						Create a Personal Access Token at github.com → Settings → Developer settings → Tokens (classic) with the <strong>gist</strong> scope only.
						Enter the same token on each TV.
					</p>
					<div class="apikey__field">
						{typing
							? <input ref={input} class="picker__input" type="text" defaultValue={sync.token} placeholder="Paste GitHub token (gist scope)" maxLength={100} onKeyDown={onFieldKey} />
							: <div class="apikey__current">
								{status}
								{sync.gistId && <span style={{opacity: 0.5, marginLeft: '12px'}}>ID: {sync.gistId.slice(0, 8)}…</span>}
							</div>}
					</div>
				</div>
			</div>
		</div>
	);
}
