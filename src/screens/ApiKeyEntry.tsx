import {useCallback, useEffect, useRef, useState} from 'preact/hooks';
import {useKeys, type NavKey} from '../hooks/useKeys';

interface Props {
	current: string;
	onSave: (key: string) => void;
	onClose: () => void;
}

export function ApiKeyEntry ({current, onSave, onClose}: Props) {
	const [typing, setTyping] = useState(false);
	const input = useRef<HTMLInputElement>(null);

	useEffect(() => { if (typing && input.current) input.current.focus(); }, [typing]);
	useEffect(() => { setTyping(true); }, []);

	const handleKey = useCallback((key: NavKey): boolean => {
		if (key === 'enter') setTyping(true);
		else if (key === 'back') onClose();
		return true;
	}, [onClose]);

	useKeys(handleKey, !typing);

	const onFieldKey = (e: KeyboardEvent) => {
		if (e.keyCode === 13) {
			e.preventDefault();
			const value = (e.target as HTMLInputElement).value.trim();
			if (value.length > 0) onSave(value);
			else onClose();
		} else if (e.keyCode === 461 || e.keyCode === 27) {
			e.preventDefault();
			onClose();
		}
	};

	return (
		<div class="screen screen--picker">
			<div class="settings">
				<h1 class="settings__title">TMDB API Key</h1>
				<p class="settings__hint">{typing ? 'Type your API key, then press OK · Back cancels' : 'OK opens the keyboard · Back returns'}</p>
				<div class="apikey">
					<p class="apikey__desc">
						Get a free API key at themoviedb.org: sign up, then go to Account → Settings → API.
						Copy the "API Key (v3 auth)" value.
					</p>
					<div class="apikey__field">
						{typing
							? <input ref={input} class="picker__input" type="text" defaultValue={current} placeholder="Paste or type your TMDB API key" maxLength={64} onKeyDown={onFieldKey} />
							: <div class="apikey__current">{current ? 'Current: ' + current.slice(0, 8) + '…' : 'No key set'}</div>}
					</div>
				</div>
			</div>
		</div>
	);
}
