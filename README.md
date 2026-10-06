# Anime Player

Libreria di anime **a link**, stile Jellyfin ma senza scaricare nulla: poster, trame e titoli degli episodi arrivano da AniList e Kitsu, i video vengono riprodotti da **mpv** con gli shader **Anime4K** già attivi.

## Requisiti
- Windows 10/11 con una GPU recente (preset predefinito *Mode A+A HQ*)
- [Node.js](https://nodejs.org) 20 o più recente (solo per compilare)
- [mpv](https://mpv.io/installation/) installato (es. `winget install mpv` oppure `scoop install mpv`)

## Avvio
Per usarla in sviluppo:
```
npm install
npm start
```
All'avvio l'app cerca `mpv.exe` da sola (PATH, winget, scoop, chocolatey, Program Files). Se non lo trova: *Impostazioni → Sfoglia*.

Per l'uso normale non servono Node.js, `npm install` o `npm start`: esegui `AnimePlayer-portable.exe` dalla cartella `dist/`.
Per rigenerare l'eseguibile portatile dopo modifiche al progetto: `npm run dist`.

## Come si usa
1. **Aggiungi serie** → cerchi il titolo, l'app scarica poster, trama ed elenco episodi.
2. Nella pagina della serie, **Aggiungi link**:
   - *Da un link* (consigliato): incolli il link di **un** episodio e l'app trova da sola il numero dell'episodio (ignora il nome del server, l'estensione, `1080p`, `x264`, la stagione `S02`…), poi crea tutti gli altri nell'intervallo scelto. Se nel link ci sono più numeri puoi scegliere quello giusto, o scrivere tu il numero dell'episodio.
   - *Pattern*: `https://sito/anime/ep{ep:02}.mp4`, dall'episodio 1 al 12 → crea 12 episodi (`{ep}` senza zeri, `{ep:02}` con zeri).
   - *Elenco*: un link per riga, oppure importa una playlist `.m3u`.
   - Un episodio può avere più link: se il primo non parte, l'app prova il successivo.
3. **Guarda / Riprendi**. Il progresso si salva da solo, alla fine parte l'episodio successivo.
4. **Apri un link** (barra laterale) riproduce al volo un link qualsiasi con Anime4K.

Nella home trovi **Continua a guardare**, con il progresso dell'ultimo episodio
e un pulsante rapido per riprenderlo (oppure per passare all'episodio
successivo). La ricerca filtra i titoli della libreria; il menu accanto alla
ricerca permette di mostrare tutte le serie, quelle da riprendere, quelle con
episodi non visti o quelle con episodi già visti.

I pulsanti **Esporta** e **Importa** usano i dialoghi di Windows per salvare o
caricare un file JSON della libreria, inclusi link, progressi, impostazioni e
metadati. Durante l'importazione il file viene controllato: JSON non valido,
strutture incomplete o link non validi vengono rifiutati con un messaggio
esplicito e la libreria attuale resta invariata.

mpv apre link diretti (mp4, mkv…), flussi HLS (.m3u8) e, con [yt-dlp](https://github.com/yt-dlp/yt-dlp) nel PATH, anche le pagine dei siti che yt-dlp supporta. Se il sito richiede un referer, impostalo in *Opzioni avanzate* della serie.

Gli episodi senza anteprima online mostrano l'immagine della serie con il numero sopra.

## Anime4K
Dodici preset ufficiali (Mode A, B, C, A+A, B+B, C+A, ciascuno Fast o HQ) più "Spento", scelti per serie o come predefinito. Le catene di shader sono quelle della documentazione di Anime4K v4.0.1. Il preset predefinito è **Mode A+A HQ**; puoi cambiarlo nelle impostazioni o durante la riproduzione.

Tasti dentro mpv:

| Tasto | Azione |
|---|---|
| Ctrl+1…6 | Anime4K Fast (A, B, C, A+A, B+B, C+A) |
| Alt+1…6 | Anime4K HQ |
| Ctrl+0 | Anime4K spento |
| PgGiù / `>` | episodio successivo |
| PgSu / `<` | episodio precedente |

Se cambi preset dalla pagina della serie mentre guardi, si applica subito.

## Dati
Libreria e impostazioni stanno in `%APPDATA%\Anime Player\library.json`. L'app non include scraper: i link li inserisci tu.

## Test
`npm test` prova pattern, preset, libreria e, se mpv è installato, la riproduzione reale (IPC, autoplay, link rotti).

## Crediti
Shader [Anime4K](https://github.com/bloc97/Anime4K) di bloc97 (licenza MIT, in `shaders/LICENSE-Anime4K.txt`). Metadati da AniList e Kitsu.
