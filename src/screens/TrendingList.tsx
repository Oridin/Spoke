import {useCallback, useState} from 'preact/hooks';
import {useKeys, clamp, type NavKey} from '../hooks/useKeys';
import {useOkPress} from '../hooks/useOkPress';
import {providerDef, yearOf, type TrendingShow} from '../lib/trending';

interface Props {
	shows: TrendingShow[];
	installedAppIds: string[];
	onLaunch: (appId: string, showName: string) => void;
	onClose: () => void;
}

const VISIBLE_ROWS = 7;

export function TrendingList ({shows, installedAppIds, onLaunch, onClose}: Props) {
	const [index, setIndex] = useState(0);
	const [providerIndex, setProviderIndex] = useState(0);
	const selected = shows[index];

	const matchedProviders = selected ? selected.providers.map((sp) => {
		const def = providerDef(sp.id);
		if (!def) return null;
		for (const pattern of def.appPatterns) {
			const found = installedAppIds.find((id) => id.toLowerCase().indexOf(pattern) !== -1);
			if (found) return {name: def.short, appId: found};
		}
		return {name: def.short, appId: null as string | null};
	}).filter((p): p is {name: string; appId: string | null} => p !== null) : [];

	const handleKey = useCallback((key: NavKey): boolean => {
		if (key === 'up') { setIndex((i) => { const n = clamp(i - 1, 0, Math.max(0, shows.length - 1)); setProviderIndex(0); return n; }); }
		else if (key === 'down') { setIndex((i) => { const n = clamp(i + 1, 0, Math.max(0, shows.length - 1)); setProviderIndex(0); return n; }); }
		else if (key === 'left') { setProviderIndex((i) => clamp(i - 1, 0, Math.max(0, matchedProviders.length - 1))); }
		else if (key === 'right') { setProviderIndex((i) => clamp(i + 1, 0, Math.max(0, matchedProviders.length - 1))); }
		else if (key === 'back') { onClose(); }
		return true;
	}, [shows.length, matchedProviders.length, onClose]);

	useKeys(handleKey, true);
	useOkPress({
		onPress: () => {
			const p = matchedProviders[providerIndex];
			if (p && p.appId && selected) onLaunch(p.appId, selected.name);
		},
		onLongPress: () => { /* no long-press action */ }
	}, true);

	if (shows.length === 0) {
		return (
			<div class="screen screen--picker">
				<div class="settings">
					<h1 class="settings__title">Trending</h1>
					<p class="settings__hint">No trending shows yet. Check your TMDB API key in Settings → Trending.</p>
				</div>
			</div>
		);
	}

	const start = clamp(index - Math.floor(VISIBLE_ROWS / 2), 0, Math.max(0, shows.length - VISIBLE_ROWS));
	const visible = shows.slice(start, start + VISIBLE_ROWS);

	return (
		<div class="screen screen--picker">
			<div class="settings">
				<h1 class="settings__title">Trending This Week</h1>
				<p class="settings__hint">OK opens the app · ← → pick a service · Back returns home</p>
				<div class="trending">
					{visible.map((show, n) => {
						const i = start + n;
						const year = yearOf(show.firstAir);
						const providers = show.providers.map((sp) => {
							const def = providerDef(sp.id);
							return def ? def.short : sp.name;
						});
						return (
							<div key={show.id} class={`trending__row${i === index ? ' trending__row--focused' : ''}`}>
								<div class="trending__info">
									<div class="trending__name">{show.name}{year ? ` (${year})` : ''}</div>
									<div class="trending__meta">
										{show.rating > 0 && <span class="trending__rating">{show.rating.toFixed(1)}</span>}
										{providers.length > 0 && <span class="trending__providers">
											{providers.map((name, pi) => (
												<span key={pi} class={`trending__provider${i === index && pi === providerIndex ? ' trending__provider--active' : ''}`}>{name}</span>
											))}
										</span>}
										{providers.length === 0 && <span class="trending__unavail">Not on your services</span>}
									</div>
									{i === index && show.overview && <div class="trending__overview">{show.overview}</div>}
								</div>
							</div>
						);
					})}
				</div>
				<p class="settings__about">Powered by TMDB</p>
			</div>
		</div>
	);
}
