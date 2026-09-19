/**
 * audio.js — Musica di sottofondo di Barbacane.
 *
 * La musica parte al primo gesto dell'utente (il click sulla splash): è l'unico
 * modo in cui i browser consentono l'audio udibile. Nessuna preferenza salvata:
 * entrando in Barbacane la musica c'è sempre, il muto vale per la sessione.
 */

const BgMusic = (() => {

  const GESTURES = ['click', 'pointerup', 'touchend', 'keydown'];

  let audioEl = null;
  let btn = null;
  let wanted = true;
  let playing = false;

  function init() {
    audioEl = document.getElementById('bgm-audio');
    btn = document.getElementById('btn-music-toggle');
    if (!audioEl || !btn) return;

    audioEl.volume = 0.5;
    audioEl.muted = false;

    audioEl.addEventListener('playing', () => { playing = true; });
    audioEl.addEventListener('error', () => report('caricamento fallito', audioEl.error));

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setWanted(!wanted);
    });
    GESTURES.forEach(evt => document.addEventListener(evt, start, true));
    updateButton();
  }

  // Da chiamare dentro un gesto dell'utente.
  function start() {
    if (!audioEl || !wanted || playing) return;
    attemptPlay('gesto utente');
  }

  function attemptPlay(origin) {
    audioEl.muted = false;
    const promise = audioEl.play();
    if (!promise || !promise.then) { playing = true; return; }
    promise.then(() => { playing = true; })
           .catch(err => report('play() rifiutato — ' + origin, err));
  }

  function setWanted(on) {
    wanted = on;
    if (on) {
      attemptPlay('pulsante musica');
    } else {
      audioEl.pause();
      playing = false;
    }
    updateButton();
  }

  function updateButton() {
    // Simbolo piatto (nessuna emoji): acceso/spento si legge dal colore, non dal glifo.
    btn.textContent = '♪';
    btn.classList.toggle('muted', !wanted);
  }

  // Se l'audio non parte, il motivo va detto invece di essere ingoiato in silenzio.
  function report(what, err) {
    console.warn('[Barbacane musica]', what, err ? (err.name || 'codice ' + err.code) : '',
      err && err.message ? err.message : '', {
        muted: audioEl.muted,
        volume: audioEl.volume,
        paused: audioEl.paused,
        readyState: audioEl.readyState,
        networkState: audioEl.networkState,
        src: audioEl.currentSrc,
        supportoOgg: audioEl.canPlayType('audio/ogg; codecs="vorbis"') || '(nessuno)',
      });
  }

  return { init, start };
})();
