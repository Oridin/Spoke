import {useCallback, useEffect, useRef, useState} from 'preact/hooks';
import {useKeyTrap} from '../hooks/useKeyTrap';
import {plexFetchJson} from '../lib/plex';

interface Props {
	plexUrl: string;
	plexToken: string;
	ratingKey: string;
	title: string;
	onClose: () => void;
	onToast: (msg: string, kind?: 'info' | 'error') => void;
}

interface PartInfo {
	partId: string;
	partKey: string;
	duration: number;
	resumeOffset: number;
	subtitles: SubTrack[];
}

interface SubTrack {
	id: number;
	language: string;
	codec: string;
	key: string | null;
}

var OVERLAY_TIMEOUT = 4000;
var SEEK_STEP = 30;
var PROGRESS_INTERVAL = 10000;

function fmtTime (ms: number): string {
	var s = Math.floor(ms / 1000);
	var h = Math.floor(s / 3600);
	var m = Math.floor((s % 3600) / 60);
	var sec = s % 60;
	if (h > 0) return h + ':' + (m < 10 ? '0' : '') + m + ':' + (sec < 10 ? '0' : '') + sec;
	return m + ':' + (sec < 10 ? '0' : '') + sec;
}

function base (url: string): string { return url.replace(/\/+$/, ''); }

export function PlexPlayer ({plexUrl, plexToken, ratingKey, title, onClose, onToast}: Props) {
	var videoRef = useRef<HTMLVideoElement>(null);
	var [partInfo, setPartInfo] = useState<PartInfo | null>(null);
	var [error, setError] = useState('');
	var [showOverlay, setShowOverlay] = useState(true);
	var [paused, setPaused] = useState(false);
	var [currentTime, setCurrentTime] = useState(0);
	var [duration, setDuration] = useState(0);
	var [buffering, setBuffering] = useState(true);
	var overlayTimer = useRef(0);
	var progressTimer = useRef(0);
	var sessionId = useRef('spoke-' + Date.now());

	useEffect(function () {
		plexFetchJson(base(plexUrl) + '/library/metadata/' + encodeURIComponent(ratingKey), plexToken)
			.then(function (data: Record<string, unknown>) {
				var mc = (data as Record<string, unknown>).MediaContainer as Record<string, unknown> || {};
				var meta = ((mc.Metadata as Array<Record<string, unknown>>) || [])[0];
				if (!meta) { setError('Title not found'); return; }
				var media = ((meta.Media as Array<Record<string, unknown>>) || [])[0];
				if (!media) { setError('No media available'); return; }
				var part = ((media.Part as Array<Record<string, unknown>>) || [])[0];
				if (!part) { setError('No file available'); return; }
				var subs: SubTrack[] = [];
				var streams = (part.Stream as Array<Record<string, unknown>>) || [];
				for (var i = 0; i < streams.length; i++) {
					if (streams[i].streamType === 3) {
						subs.push({
							id: streams[i].id as number,
							language: (streams[i].displayTitle as string) || '',
							codec: (streams[i].codec as string) || '',
							key: (streams[i].key as string) || null
						});
					}
				}
				setPartInfo({
					partId: String(part.id),
					partKey: (part.key as string) || '',
					duration: (meta.duration as number) || 0,
					resumeOffset: (meta.viewOffset as number) || 0,
					subtitles: subs
				});
			})
			.catch(function (e: unknown) {
				var msg = (e && typeof e === 'object' && 'message' in e) ? (e as Error).message : String(e);
				if (plexToken) msg = msg.split(plexToken).join('***');
				setError(msg || 'Failed to load');
			});
	}, [plexUrl, plexToken, ratingKey]);

	var streamUrl = partInfo ? base(plexUrl) + partInfo.partKey + '?X-Plex-Token=' + encodeURIComponent(plexToken) : '';

	useEffect(function () {
		if (!partInfo || !videoRef.current) return;
		var v = videoRef.current;
		v.src = streamUrl;
		if (partInfo.resumeOffset > 0) {
			v.currentTime = partInfo.resumeOffset / 1000;
			onToast('Resuming from ' + fmtTime(partInfo.resumeOffset));
		}
		v.play().catch(function () { /* autoplay may be blocked */ });
	}, [partInfo, streamUrl]);

	useEffect(function () {
		if (!videoRef.current) return;
		var el = videoRef.current as HTMLVideoElement;
		var onPlay = function () { setPaused(false); setBuffering(false); };
		var onPause = function () { setPaused(true); };
		var onTime = function () { setCurrentTime(el.currentTime * 1000); };
		var onDur = function () { setDuration(el.duration * 1000); };
		var onWait = function () { setBuffering(true); };
		var onPlaying = function () { setBuffering(false); };
		var onErr = function () {
			var code = el.error ? el.error.code : 0;
			var msg = el.error ? el.error.message || '' : '';
			if (plexToken) msg = msg.split(plexToken).join('***');
			setError('Playback error (code ' + code + ')' + (msg ? ': ' + msg : ''));
		};
		el.addEventListener('play', onPlay);
		el.addEventListener('pause', onPause);
		el.addEventListener('timeupdate', onTime);
		el.addEventListener('durationchange', onDur);
		el.addEventListener('waiting', onWait);
		el.addEventListener('playing', onPlaying);
		el.addEventListener('error', onErr);
		return function () {
			el.removeEventListener('play', onPlay);
			el.removeEventListener('pause', onPause);
			el.removeEventListener('timeupdate', onTime);
			el.removeEventListener('durationchange', onDur);
			el.removeEventListener('waiting', onWait);
			el.removeEventListener('playing', onPlaying);
			el.removeEventListener('error', onErr);
		};
	}, [partInfo, plexToken]);

	// Report progress to Plex
	useEffect(function () {
		if (!partInfo) return;
		var report = function () {
			var v = videoRef.current;
			if (!v || v.paused) return;
			var offset = Math.floor(v.currentTime * 1000);
			var dur = partInfo ? partInfo.duration : 0;
			var url = base(plexUrl) + '/:/timeline?ratingKey=' + ratingKey + '&key=%2Flibrary%2Fmetadata%2F' + ratingKey + '&state=playing&time=' + offset + '&duration=' + dur + '&X-Plex-Client-Identifier=' + sessionId.current + '&X-Plex-Token=' + encodeURIComponent(plexToken);
			var xhr = new XMLHttpRequest();
			xhr.open('GET', url);
			xhr.timeout = 5000;
			xhr.send();
		};
		progressTimer.current = window.setInterval(report, PROGRESS_INTERVAL);
		return function () { window.clearInterval(progressTimer.current); };
	}, [partInfo, plexUrl, plexToken, ratingKey]);

	// Report stop on unmount
	useEffect(function () {
		return function () {
			if (!partInfo || !videoRef.current) return;
			var offset = Math.floor(videoRef.current.currentTime * 1000);
			var url = base(plexUrl) + '/:/timeline?ratingKey=' + ratingKey + '&key=%2Flibrary%2Fmetadata%2F' + ratingKey + '&state=stopped&time=' + offset + '&duration=' + partInfo.duration + '&X-Plex-Client-Identifier=' + sessionId.current + '&X-Plex-Token=' + encodeURIComponent(plexToken);
			var xhr = new XMLHttpRequest();
			xhr.open('GET', url);
			xhr.timeout = 5000;
			xhr.send();
		};
	}, [partInfo, plexUrl, plexToken, ratingKey]);

	var flashOverlay = useCallback(function () {
		setShowOverlay(true);
		window.clearTimeout(overlayTimer.current);
		overlayTimer.current = window.setTimeout(function () { setShowOverlay(false); }, OVERLAY_TIMEOUT);
	}, []);

	useEffect(function () {
		flashOverlay();
		return function () { window.clearTimeout(overlayTimer.current); };
	}, []);

	var handleKey = useCallback(function (e: KeyboardEvent) {
		var v = videoRef.current;
		if (!v) return;
		var code = e.keyCode;
		if (code === 461 || code === 27) { // Back or Escape
			e.preventDefault();
			e.stopPropagation();
			v.pause();
			onClose();
			return;
		}
		flashOverlay();
		if (code === 13) { // OK / Enter
			e.preventDefault();
			if (v.paused) v.play(); else v.pause();
		} else if (code === 37) { // Left
			e.preventDefault();
			v.currentTime = Math.max(0, v.currentTime - SEEK_STEP);
		} else if (code === 39) { // Right
			e.preventDefault();
			v.currentTime = Math.min(v.duration || 0, v.currentTime + SEEK_STEP);
		}
	}, [onClose, flashOverlay]);

	useKeyTrap(handleKey, true);

	var progress = duration > 0 ? (currentTime / duration) * 100 : 0;

	if (error) {
		return (
			<div class="plex-player">
				<div class="plex-player__error">
					<h2>{title}</h2>
					<p>{error}</p>
					<p class="plex-player__hint">Press Back to return</p>
				</div>
			</div>
		);
	}

	if (!partInfo) {
		return (
			<div class="plex-player">
				<div class="plex-player__spoke-loader">
					<div class="plex-player__spoke-ring" />
					<div class="plex-player__spoke-text">Spoke</div>
				</div>
			</div>
		);
	}

	return (
		<div class="plex-player">
			<video ref={videoRef} class="plex-player__video" />
			{buffering && !paused && <div class="plex-player__buffer-spinner"><div class="plex-player__spoke-ring" /></div>}
			{showOverlay && (
				<div class="plex-player__overlay">
					<div class="plex-player__watermark">Spoke</div>
					<div class="plex-player__title">{title}</div>
					<div class="plex-player__controls">
						<span class="plex-player__time">{fmtTime(currentTime)}</span>
						<div class="plex-player__bar">
							<div class="plex-player__bar-fill" style={'width:' + progress + '%'} />
						</div>
						<span class="plex-player__time">{fmtTime(duration)}</span>
					</div>
					{paused && !buffering && <div class="plex-player__paused">Paused</div>}
					<div class="plex-player__hint">OK: play/pause · ◀▶: skip 30s · Back: exit</div>
				</div>
			)}
		</div>
	);
}
