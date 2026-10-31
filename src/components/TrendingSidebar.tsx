import {useState, useRef, useCallback} from 'preact/hooks';
import {yearOf, posterUrl, providerDef, type TrendingShow} from '../lib/trending';
import type {TrendingConfig} from '../lib/storage';

interface Props {
	title: string;
	shows: TrendingShow[];
	side: 'left' | 'right';
	config: TrendingConfig;
}

function largePoster (path: string | null): string | null {
	if (!path) return null;
	return 'https://image.tmdb.org/t/p/w342' + path;
}

export function TrendingSidebar ({title, shows, side, config}: Props) {
	if (shows.length === 0) return null;
	const [hovered, setHovered] = useState<number | null>(null);
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
		setHovered(id);
	}, []);
	const onLeave = useCallback(() => {
		leaveTimer.current = window.setTimeout(() => setHovered(null), 300);
	}, []);
	const onClick = useCallback((id: number) => {
		setHovered((prev) => prev === id ? null : id);
	}, []);

	const hoveredShow = hovered !== null ? shows.find((s) => s.id === hovered) : undefined;

	return (
		<div class={`trending-sidebar trending-sidebar--${side}`} style={style}>
			<div class="trending-sidebar__title" style={{fontSize: titleFontSize + 'px'}}>{title}</div>
			<div class="trending-sidebar__list" style={listStyle}>
				{shows.map((show) => {
					const year = yearOf(show.firstAir);
					const thumb = posterUrl(show.poster);
					const providers = show.providers.map((sp) => {
						const def = providerDef(sp.id);
						return def ? def.short : sp.name;
					});
					return (
						<div
							key={show.id}
							class={`trending-sidebar__item${hovered === show.id ? ' trending-sidebar__item--hovered' : ''}`}
							style={{gap: config.posterGap + 'px'}}
							onMouseEnter={() => onEnter(show.id)}
							onMouseLeave={onLeave}
							onClick={() => onClick(show.id)}
						>
							{thumb && <img class="trending-sidebar__poster" src={thumb} alt="" />}
							<div class="trending-sidebar__info">
								<div class="trending-sidebar__name" style={{fontSize: nameFontSize + 'px'}}>{show.name}{detail !== 'minimal' && year ? ` (${year})` : ''}</div>
								{detail !== 'minimal' && (
									<div class="trending-sidebar__meta" style={{fontSize: metaFontSize + 'px'}}>
										{detail === 'full' && providers.length > 0 && <span class="trending-sidebar__providers">{providers.join(' · ')}</span>}
										{detail === 'full' && providers.length > 0 && show.rating > 0 && <span class="trending-sidebar__sep"> - </span>}
										{detail === 'full' && show.rating > 0 && <span class="trending-sidebar__rating">{show.rating.toFixed(1)}</span>}
										{detail === 'compact' && providers.length > 0 && <span class="trending-sidebar__providers">{providers.join(' · ')}</span>}
									</div>
								)}
							</div>
						</div>
					);
				})}
			</div>
			{hoveredShow && (
				<div
					class={`trending-sidebar__popup trending-sidebar__popup--${side}`}
					onMouseEnter={() => onEnter(hoveredShow.id)}
					onMouseLeave={onLeave}
					onClick={() => setHovered(null)}
				>
					{largePoster(hoveredShow.poster) && <img class="trending-sidebar__popup-poster" src={largePoster(hoveredShow.poster)!} alt="" />}
					<div class="trending-sidebar__popup-body">
						<div class="trending-sidebar__popup-title">{hoveredShow.name}</div>
						<div class="trending-sidebar__popup-meta">
							{yearOf(hoveredShow.firstAir) && <span>{yearOf(hoveredShow.firstAir)}</span>}
							{hoveredShow.rating > 0 && <span>★ {hoveredShow.rating.toFixed(1)}</span>}
						</div>
						{hoveredShow.overview && <div class="trending-sidebar__popup-overview">{hoveredShow.overview}</div>}
						{hoveredShow.providers.length > 0 && (
							<div class="trending-sidebar__popup-providers">
								<span class="trending-sidebar__popup-providers-label">Available on</span>
								{hoveredShow.providers.map((sp) => {
									const def = providerDef(sp.id);
									return <span key={sp.id} class="trending-sidebar__popup-provider">{def ? def.short : sp.name}</span>;
								})}
							</div>
						)}
						{hoveredShow.providers.length === 0 && (
							<div class="trending-sidebar__popup-providers">
								<span class="trending-sidebar__popup-providers-label">Not on your services</span>
							</div>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
