import {useState, useRef, useCallback} from 'preact/hooks';
import {yearOf, posterUrl, providerDef, findProviderApp, type TrendingShow} from '../lib/trending';
import type {TrendingConfig} from '../lib/storage';
import type {PlexIndex} from '../lib/plex';

interface Props {
	title: string;
	shows: TrendingShow[];
	side: 'left' | 'right';
	config: TrendingConfig;
	installedAppIds: string[];
	onLaunch: (appId: string) => void;
	onSeedbox: (name: string, year: string, mediaType: string) => void;
	plexIdx?: PlexIndex | null;
}

function largePoster (path: string | null): string | null {
	if (!path) return null;
	return 'https://image.tmdb.org/t/p/w342' + path;
}

export function TrendingSidebar ({title, shows, side, config, installedAppIds, onLaunch, onSeedbox, plexIdx}: Props) {
	if (shows.length === 0) return null;
	const [highlighted, setHighlighted] = useState<number | null>(null);
	const [selected, setSelected] = useState<number | null>(null);
	const leaveTimer = useRef(0);
	const detail = config.detail;
	const nameFontSize = config.fontSize;
	const metaFontSize = Math.round(nameFontSize * 0.8);
	const titleFontSize = Math.round(nameFontSize * 1.2);
	const style: Record<string, string> = {
		top: config.topOffset + 'px',
		maxWidth: config.panelWidth + '%'
	};
	if (side === 'left') style.left = config.sideInset + 'px';
	else style.right = config.sideInset + 'px';
	const listStyle = {
		background: `rgba(0, 0, 0, ${config.panelOpacity / 100})`,
		gap: config.rowGap + 'px'
	};

	const onEnter = useCallback((id: number) => {
		window.clearTimeout(leaveTimer.current);
		setHighlighted(id);
	}, []);
	const onLeave = useCallback(() => {
		leaveTimer.current = window.setTimeout(() => setHighlighted(null), 300);
	}, []);
	const lastActivate = useRef(0);
	const onActivate = useCallback((id: number) => {
		const now = Date.now();
		if (now - lastActivate.current < 300) return;
		lastActivate.current = now;
		setSelected((prev) => prev === id ? null : id);
	}, []);

	const popupShow = selected !== null ? shows.find((s) => s.id === selected) : undefined;

	const appButtons = popupShow ? popupShow.providers.map((sp) => {
		const def = providerDef(sp.id);
		if (!def) return null;
		const appId = findProviderApp(def, installedAppIds);
		if (!appId) return null;
		return {name: def.short, appId};
	}).filter((b): b is {name: string; appId: string} => b !== null) : [];

	return (
		<div class={`trending-sidebar trending-sidebar--${side}`} style={style}>
			<div class="trending-sidebar__title" style={{fontSize: titleFontSize + 'px'}}>{title}</div>
			<div class="trending-sidebar__list" style={listStyle}>
				{shows.map((show) => {
					const year = yearOf(show.firstAir);
					const thumb = posterUrl(show.poster);
					const allProviders = show.providers.map((sp) => {
						const def = providerDef(sp.id);
						return def ? def.short : sp.name;
					});
					const maxInline = 2;
					const providers = allProviders.slice(0, maxInline);
					const extra = allProviders.length - maxInline;
					const isHighlighted = highlighted === show.id || selected === show.id;
					return (
						<div
							key={show.id}
							class={`trending-sidebar__item${isHighlighted ? ' trending-sidebar__item--hovered' : ''}`}
							style={{gap: config.posterGap + 'px'}}
							tabIndex={0}
							onMouseEnter={() => onEnter(show.id)}
							onMouseLeave={onLeave}
							onMouseDown={(e: MouseEvent) => { e.preventDefault(); onActivate(show.id); }}
							onClick={(e: MouseEvent) => { e.preventDefault(); onActivate(show.id); }}
							onKeyDown={(e: KeyboardEvent) => { if (e.keyCode === 13 || e.keyCode === 32) { e.preventDefault(); onActivate(show.id); } }}
						>
							{thumb && (
								<div class="trending-sidebar__poster-wrap">
									<img class="trending-sidebar__poster" src={thumb} alt="" />
									{plexIdx && plexIdx.has(show.mediaType, show.id) && <div class="trending-sidebar__server-dot" />}
								</div>
							)}
							<div class="trending-sidebar__info">
								<div class="trending-sidebar__name" style={{fontSize: nameFontSize + 'px'}}>{show.name}{detail !== 'minimal' && year ? ` (${year})` : ''}</div>
								{detail !== 'minimal' && (
									<div class="trending-sidebar__meta" style={{fontSize: metaFontSize + 'px'}}>
										{detail === 'full' && providers.length > 0 && <span class="trending-sidebar__providers">{providers.join(' · ')}{extra > 0 ? ` +${extra}` : ''}</span>}
										{detail === 'full' && providers.length > 0 && show.rating > 0 && <span class="trending-sidebar__sep"> - </span>}
										{detail === 'full' && show.rating > 0 && <span class="trending-sidebar__rating">{show.rating.toFixed(1)}</span>}
										{detail === 'compact' && providers.length > 0 && <span class="trending-sidebar__providers">{providers.join(' · ')}{extra > 0 ? ` +${extra}` : ''}</span>}
									</div>
								)}
							</div>
						</div>
					);
				})}
			</div>
			{popupShow && (
				<div class={`trending-sidebar__popup trending-sidebar__popup--${side}`}>
					{largePoster(popupShow.poster) && <img class="trending-sidebar__popup-poster" src={largePoster(popupShow.poster)!} alt="" />}
					<div class="trending-sidebar__popup-body">
						<div class="trending-sidebar__popup-title">{popupShow.name}</div>
						<div class="trending-sidebar__popup-meta">
							{yearOf(popupShow.firstAir) && <span>{yearOf(popupShow.firstAir)}</span>}
							{popupShow.rating > 0 && <span>{'★ ' + popupShow.rating.toFixed(1)}</span>}
						</div>
						{popupShow.overview && <div class="trending-sidebar__popup-overview">{popupShow.overview}</div>}
						{appButtons.length > 0 && (
							<div class="trending-sidebar__popup-apps">
								<span class="trending-sidebar__popup-apps-label">Watch on</span>
								<div class="trending-sidebar__popup-apps-list">
									{appButtons.map((b) => (
										<button
											key={b.appId}
											class="trending-sidebar__popup-app-btn"
											tabIndex={0}
											onMouseDown={(e: MouseEvent) => { e.stopPropagation(); e.preventDefault(); onLaunch(b.appId); }}
											onClick={(e: MouseEvent) => { e.stopPropagation(); e.preventDefault(); onLaunch(b.appId); }}
										>{b.name}</button>
									))}
								</div>
							</div>
						)}
						{popupShow.providers.length > 0 && appButtons.length === 0 && (
							<div class="trending-sidebar__popup-providers">
								<span class="trending-sidebar__popup-providers-label">Available on</span>
								{popupShow.providers.map((sp) => {
									const def = providerDef(sp.id);
									return <span key={sp.id} class="trending-sidebar__popup-provider">{def ? def.short : sp.name}</span>;
								})}
							</div>
						)}
						{popupShow.providers.length > 0 && appButtons.length > 0 && appButtons.length < popupShow.providers.length && (
							<div class="trending-sidebar__popup-providers">
								<span class="trending-sidebar__popup-providers-label">Also on</span>
								{popupShow.providers.filter((sp) => !appButtons.some((b) => { const def = providerDef(sp.id); return def && findProviderApp(def, installedAppIds) === b.appId; })).map((sp) => {
									const def = providerDef(sp.id);
									return <span key={sp.id} class="trending-sidebar__popup-provider">{def ? def.short : sp.name}</span>;
								})}
							</div>
						)}
						<div class="trending-sidebar__popup-seedbox">
							<button
								class="trending-sidebar__popup-seedbox-btn"
								tabIndex={0}
								onMouseDown={(e: MouseEvent) => { e.stopPropagation(); e.preventDefault(); onSeedbox(popupShow.name, yearOf(popupShow.firstAir), popupShow.mediaType); }}
								onClick={(e: MouseEvent) => { e.stopPropagation(); e.preventDefault(); onSeedbox(popupShow.name, yearOf(popupShow.firstAir), popupShow.mediaType); }}
							>Send to Seedbox</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
