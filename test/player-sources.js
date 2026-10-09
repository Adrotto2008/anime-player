'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const { PlayerManager } = require('../src/player');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-player-sources-'));
  try {
    const store = new Store(path.join(directory, 'library.json'));
    const series = store.addSeries({ title: 'Fallback sorgenti' });
    store.addSources(series.id, [
      { number: 1, url: 'https://au.example/embed/1', provider: 'animeunity', referer: 'https://au.example/embed/1' },
      { number: 1, url: 'https://aw.example/watch/1', provider: 'animeworld', referer: 'https://www.animeworld.ac/' },
    ]);
    const episode = store.getSeries(series.id).episodes[0];
    const player = new PlayerManager({ store, paths: { shaderDir: '', userData: directory }, notify: () => {} });
    let launch;
    player._launch = async (args) => { launch = args; };
    await player.play(series.id, episode.id);
    assert.strictEqual(launch.referer, 'https://au.example/embed/1', 'il player applica il Referer specifico per la sorgente');

    let attemptedSource = null;
    player.play = async (_sid, _eid, options) => { attemptedSource = options.sourceIndex; };
    player.cur = {
      series: store.getSeries(series.id), ep: episode, pos: 5, dur: 120,
      sourceIndex: 0, session: {}, stopping: false, nav: null, startedAt: Date.now(), playedSeconds: 1,
    };
    player._onExit(player.cur, { eof: false, error: 'network error' });
    assert.strictEqual(attemptedSource, 1, 'un errore del primo link avvia la sorgente successiva');
    console.log('Player: Referer specifico e fallback AnimeUnity → AnimeWorld verificati.');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
