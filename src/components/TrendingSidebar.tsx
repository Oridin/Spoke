import {yearOf, posterUrl, providerDef, type TrendingShow} from '../lib/trending';
import type {TrendingConfig} from '../lib/storage';

interface Props {
	title: string;
	shows: TrendingShow[];
	side: 'left' | 'right';
	config: TrendingConfig;
}

export function TrendingSidebar ({title, shows, side, config}: Props) {
	if (shows.length === 0) return null;
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
		gap: config.posterGap + 'px'
	};
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
						<div key={show.id} class="trending-sidebar__item" style={{gap: Math.max(8, Math.round(config.posterGap * 0.75)) + 'px'}}>
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
		</div>
	);
}
