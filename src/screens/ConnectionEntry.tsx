import {useCallback, useEffect, useRef, useState} from 'preact/hooks';
import {useKeys, type NavKey} from '../hooks/useKeys';

interface Props {
	title: string;
	hint: string;
	current: string;
	placeholder: string;
	maxLength?: number;
	onSave: (value: string) => void;
	onClose: () => void;
}

export function ConnectionEntry ({title, hint, current, placeholder, maxLength, onSave, onClose}: Props) {
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
			onSave(value);
		} else if (e.keyCode === 461 || e.keyCode === 27) {
			e.preventDefault();
			onClose();
		}
	};

	return (
		<div class="screen screen--picker">
			<div class="settings">
				<h1 class="settings__title">{title}</h1>
				<p class="settings__hint">{typing ? 'Type the value, then press OK · Back cancels' : 'OK opens the keyboard · Back returns'}</p>
				<div class="apikey">
					<p class="apikey__desc">{hint}</p>
					<div class="apikey__field">
						{typing
							? <input ref={input} class="picker__input" type="text" defaultValue={current} placeholder={placeholder} maxLength={maxLength || 200} onKeyDown={onFieldKey} />
							: <div class="apikey__current">{current ? 'Current: ' + current : 'Not set'}</div>}
					</div>
				</div>
			</div>
		</div>
	);
}
