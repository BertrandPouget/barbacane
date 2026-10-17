/**
 * audio.js — Musica di sottofondo di Barbacane.
 *
 * La musica è spenta di default e parte solo dal suo pulsante: il file pesa
 * ~6 MB e, con preload="none" negli index.html, lo scarica solo chi la accende.
 * Nessuna preferenza salvata: la scelta vale per la sessione.
 */

const BgMusic = (() => {

  let audioEl = null;
  let btn = null;
  let wanted = false;

  function init() {
    audioEl = document.getElementById('bgm-audio');
    btn = document.getElementById('btn-music-toggle');
    if (!audioEl || !btn) return;

    audioEl.volume = 0.05;
    audioEl.muted = false;

    audioEl.addEventListener('error', () => report('caricamento fallito', audioEl.error));

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setWanted(!wanted);
    });
    updateButton();
  }

  function attemptPlay(origin) {
    audioEl.muted = false;
    const promise = audioEl.play();
    if (promise && promise.catch) promise.catch(err => report('play() rifiutato — ' + origin, err));
  }

  function setWanted(on) {
    wanted = on;
    if (on) {
      attemptPlay('pulsante musica');
    } else {
      audioEl.pause();
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

  return { init };
})();
