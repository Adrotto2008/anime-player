# Aggiornamenti integrati — Anime Player 0.5.48

## Analisi e architettura

Base locale: main 0.5.46, commit 7f94600, working tree inizialmente pulito. Electron 44.7.0, electron-builder 26.15.3; nessun updater/workflow preesistente. Distribuzioni conservate: Windows portable/NSIS x64, Linux AppImage/DEB, macOS DMG/ZIP. L'app mantiene appId com.adriano.animeplayer e productName Anime Player.

main.js gestisce Store, PlayerManager/mpv e CloudService; preload espone una allowlist e ogni handler applica requireTrustedSender (finestra, main frame, entry locale). Il renderer HTML/JS usa CSP, sandbox e contextIsolation. La nuova sezione usa gli stessi componenti e controlli; i changelog sono testo, mai HTML eseguibile.

Libreria e preferenze esistenti sono JSON atomici in userData, con librerie per account library-<id>.json e outbox di sincronizzazione. Le sessioni Supabase cifrate con safeStorage sono in supabase-session.json; anche i file di sync restano nel profilo. Le preferenze dell'updater sono globali e atomiche in updates.json, separate dalle impostazioni sincronizzate della libreria. File illeggibili non vengono sovrascritti; startup automatico disattivato in caso di corruzione.

electron-updater 6.8.10 è fissato per compatibilità con builder 26; semver valida confronti e prerelease. js-yaml 4.3.2 è usato dal verificatore di build, con lockfile e audit senza vulnerabilità al momento delle prove. La documentazione consultata è quella [electron-builder v26](https://www.electron.build/v26/docs/features/auto-update/), coerente con le API autoInstallOnAppQuit e quitAndInstall utilizzate. Non migrare alle API v27 senza aggiornare il modulo e i test.

## Comportamento implementato

- Controllo all'avvio dopo 10 secondi, senza await nell'avvio, configurabile. Controllo manuale e ultima verifica persistente; una sola operazione di rete alla volta.
- Feed pubblico fisso Adrotto2008/anime-player. Nessun URL, comando, percorso installer, token o header dal renderer. Nessuna autenticazione GitHub richiesta nei client distribuiti.
- Versione/data/changelog quando disponibili. A ogni avvio con controllo automatico abilitato, una release valida maggiore apre un popup modale che blocca clic e focus sullo sfondo; nessun popup per versione corrente o errore di rete. Una sola apertura per sessione, anche se lo stato viene notificato più volte; nessuna preferenza persistente nasconde le versioni già rifiutate. Il controllo manuale mantiene la notifica discreta.
- Nel popup «Aggiorna» scarica e richiede il riavvio se la riproduzione è ferma. Durante mpv scarica senza riavviare; dopo aver fermato la riproduzione serve un'azione esplicita per installare. «Chiudi» ripristina lo sfondo e annulla il riavvio richiesto anche se il download continua: non arma installOnQuit. Portable/DEB aprono la release ufficiale. Note come testo, progresso e stato visibili; focus da tastiera confinato al popup.
- Download esplicito con percentuale, velocità e byte; errori oscurati e possibilità di riprovare. Un trasferimento interrotto non abilita l'installazione. Nessun download di episodi introdotto.
- Scaricamento permesso durante mpv; riavvio vietato con sessione, richiesta Play o fallback lingua pendenti. Interrompere volontariamente la riproduzione prima di riavviare.
- Dopo il download, l'installazione resta disarmata. «Più tardi» arma l'installazione alla prossima chiusura volontaria; la casella consente di revocarla. Nessun timer chiude mpv. Chiudere l'app è la scelta volontaria di terminare la sessione.
- «Aggiorna e riavvia» verifica cache, salva e fa un backup prima di richiedere app.quit; lo shutdown esistente attende stop/flush del player, ferma sync, salva il progresso finale e verifica di nuovo cache/backup prima di chiamare quitAndInstall. Un errore blocca l'installer. La normale chiusura non forza il rilancio; il riavvio esplicito lo richiede.
- Windows query-session-end/session-end disarma l'installazione per non lanciare NSIS durante logout/spegnimento del sistema. Questo non protegge da un'interruzione forzata mentre l'installer è già in esecuzione.
- Manifest con versione stabile maggiore, file, dimensioni e SHA-512 obbligatori. URL esterni, traversal, downgrade e prerelease rifiutati. Web installer disabilitato. electron-updater controlla hash durante download; l'app verifica nuovamente il file in cache prima di installarlo.

## Conservazione e recupero

Nessuna migrazione di schema introdotta. Le migrazioni esistenti del Store continuano a effettuare backup e a fallire se il backup non riesce. Non introdurre cambi di formato in future release senza regressioni e procedure di rollback dedicate.

Backup in userData/update-backups/<versione>-<timestamp>-<uuid>: copie byte per byte di tutti i file durevoli presenti al primo livello, inclusi librerie/account/outbox/sessioni cifrate, preferenze e configurazioni mpv; manifest con SHA-256. Cache Chromium, sessionData e sottocartelle di shader/mpv non vengono copiate: l'updater non le modifica. I backup non vengono eliminati automaticamente. File simbolici nel profilo bloccano il backup. Non spostare il profilo su un'altra macchina presumendo che safeStorage possa decifrarne le sessioni.

Per recuperare: chiudere app/mpv, conservare una copia del profilo corrente, verificare gli hash del backup, ripristinare solo i file corretti nel medesimo profilo e riaprire una versione compatibile. Non automatizzare reset o rollback distruttivi. Errori di scrittura/backup annullano l'aggiornamento; all'uscita normale può comunque chiudersi l'app senza installare. Non certificata resistenza a spegnimento forzato del sistema durante l'esecuzione dell'installer NSIS.

## Formati e confini verificati

| Formato | Implementazione | Evidenza in questo ambiente |
| --- | --- | --- |
| Windows NSIS x64 | Controllo/download/installazione tramite NsisUpdater; rilevamento installazione tramite uninstaller. AppId/per-user e cancellazione AppData disattivata conservati | Suite Node/Electron, downloader e hash reali su fixture inerte, build/estrazione; installer di upgrade reale non eseguito |
| Windows Portable | Rilevamento PORTABLE_EXECUTABLE_FILE/DIR, controllo release; niente download/installazione automatica. Link alla release ufficiale e invito a passare a NSIS | Capability e rifiuti IPC testati; portable generato/estratto, non avviato su profilo personale |
| Windows unpacked | Non presentato come NSIS aggiornabile | Guardie di capability testate |
| Linux AppImage | AppImageUpdater soltanto con APPIMAGE reale; normali verifiche/file permissions della libreria | Branch/capability testati; nessun build/runtime Linux locale |
| Linux DEB | Controllo release con DebUpdater, link ufficiale e istruzione sudo apt install ./pacchetto.deb | Nessuna elevazione dal renderer. Gestore pacchetti e DEB reali non provati |
| macOS | MacUpdater con DMG+ZIP; pipeline opzionale richiede firma Developer ID e notarizzazione | Branch/capability testati; firma/notarizzazione/upgrade reali non provati |

La provenienza si fonda sul repository GitHub ufficiale, HTTPS e metadati/hash ottenuti dallo stesso repository. Windows funziona anche con installer non firmati, ma senza certificato non esiste una verifica Authenticode indipendente: non equiparare SHA-512 a firma dell'editore. Con certificati configurati, builder inserisce publisherName e NsisUpdater verifica la firma. macOS richiede la firma. Non usare segreti distribuiti ai client; nessun segreto è aggiunto al repository.

## Configurazione GitHub iniziale

Workflow .github/workflows/release.yml attivato soltanto dal push di un tag stabile v<package.version>. Il solo commit locale non pubblica nulla. Il tag è un'autorizzazione operativa a eseguire il workflow quando viene effettivamente pubblicato; non viene creato da questa sessione.

1. Abilitare GitHub Actions. Il job publish usa GITHUB_TOKEN con contents:write; gli altri job hanno soltanto contents:read. Non serve un PAT nel codice.
2. Repository variable SUPABASE_PUBLIC_CONFIG: JSON con soltanto url e publishableKey del progetto corretto. Il validatore esistente rifiuta segreti/service_role/sessioni. Senza configurazione il workflow fallisce, salvo scelta esplicita OFFLINE_RELEASE=true. Le build locali continuano a essere offline per default; per preservare il cloud impostare SUPABASE_CONFIG_FILE al file pubblico esplicito già validato.
3. Windows, consigliato per provenienza Authenticode: Secrets WINDOWS_CSC_LINK (certificato/base64 o riferimento supportato da builder) e WINDOWS_CSC_KEY_PASSWORD. Verificare publisherName nel resources/app-update.yml firmato. I candidati locali senza certificato non certificano la firma.
4. macOS disabilitato finché ENABLE_MAC_RELEASE non è true. Per abilitarlo configurare Secrets MAC_CSC_LINK, MAC_CSC_KEY_PASSWORD, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID secondo la [configurazione macOS v26](https://www.electron.build/v26/docs/api/app-builder-lib.interface.macconfiguration/). Il job esige i campi obbligatori e verifica codesign e stapler. Il workflow iniziale genera x64 sul [runner macos-15-intel](https://docs.github.com/en/actions/reference/runners/github-hosted-runners); altre architetture richiedono matrice, nomi/manifests dedicati e test.

Windows/Linux sono obbligatori; macOS partecipa solo quando configurato. Ogni build esegue npm ci, npm run dist (include tutta la suite check), genera installer/manifest/hash/blockmap e ne verifica corrispondenza. Il job aggregato verifica tutti i manifest e i pacchetti richiesti, crea una bozza, carica tutti i file e confronta elenco/dimensioni/digest GitHub quando disponibile prima di renderla pubblica. Un fallimento lascia una bozza incompleta non visibile all'updater; un rilancio con lo stesso tag può richiedere gestione manuale della bozza, non viene cancellata automaticamente.

## Prima release compatibile

Prima risolvere/accettare i gate di release precedenti ancora documentati (cloud live, migrazioni/RLS/Watch Room e installazione interattiva). Questo lavoro non li dichiara risolti.

1. Rivedere codice e prove, configurare le variabili/segreti necessari e autorizzare la pubblicazione separatamente.
2. Pubblicare il codice e il tag v0.5.48 quando autorizzato. Per una successiva versione: npm version <nuova-versione> --no-git-tag-version, aggiornare README/changelog, commit, tag corrispondente e push autorizzato.
3. Controllare workflow e release: Windows richiede AnimePlayer-Setup-<versione>.exe, .exe.blockmap e latest.yml; Linux latest-linux.yml, AppImage e DEB; macOS latest-mac.yml, DMG e ZIP quando abilitato. La portable resta disponibile. Non pubblicare soltanto l'EXE.
4. Le versioni vecchie prive di updater devono installare manualmente la prima NSIS compatibile una volta. Conservare lo stesso profilo. Dopo quel passaggio le versioni successive vengono proposte dentro l'app.
5. Prova obbligatoria prima di affermare il funzionamento completo: VM/utente Windows separato, installer versione A, dati sintetici con progressi/preferenze/account di test, release ufficiale B autorizzata, verifica/download/rinvio/riavvio, confronto dati dopo upgrade, riapertura e uninstall senza cancellazione dati. Ripetere su AppImage e Mac firmato; DEB con apt/privilegi.

## File e prove

Nuovi: src/updates.js, renderer/updates.js, scripts/release-verify.js, .github/workflows/release.yml, test/updates.js, test/updates-transfer.js, test/updates-electron.js, test/updates-renderer.js, docs/automatic-updates.md.

Modificati: main.js, preload.js, src/shutdown.js, renderer/app.js, renderer/index.html, renderer/style.css, package.json, package-lock.json, scripts/check.js, scripts/build.js, README.md; test/organization-electron.js sincronizza sempre le sequenze temporali con il compositor reale, anche senza esportazione PNG, con asserzioni precedenti conservate. test/capture-surface.js evita di rifocalizzare finestre già focalizzate e di alterare il puntatore nativo fra catture. test/renderer-electron.js aggiorna il mock dello stato updater e identifica il pannello diagnostico specifico, invece del primo pre (ora anche il changelog usa pre).

Test specifici 0.5.48: 21 regressioni Node, 2 trasferimenti HTTP con il vero updater/downloader/hash (trasporto Node isolato, byte inerti, nessuna esecuzione installer), 17 gruppi Electron su finestra/renderer/preload/handler di produzione con updater simulato. Il trasferimento valido verifica anche il rifiuto di una cache manomessa prima dell'installazione. Lo shutdown attende progresso/salvataggio prima dell'installer. Un feed privo del primo manifest compatibile mostra una spiegazione specifica, senza fingere un aggiornamento riuscito.

I file di evidenza e il resoconto finale registrano esiti effettivi di check/dist e verifica dei pacchetti. Le simulazioni non dimostrano un upgrade NSIS, una release GitHub pubblicata, una firma, cloud live o Linux/macOS. Nessuna libreria/sessione personale letta o modificata durante i test; nessuna installazione, login, push, tag o release effettuati.

### Esiti locali 0.5.48 — popup all'avvio

- Check completo PASS; build Windows PASS con ripetizione della suite. 21 test Node updater, 2 trasferimenti/hash/cache con vero updater e 17 gruppi Electron di produzione con dati sintetici. Verificati popup automatico, focus confinato, ripristino dello sfondo, riapertura al nuovo renderer, assenza per versione corrente/errore/controllo manuale, aggiornamento con un clic, playback guard e chiusura durante download senza riavvio.
- Portable/NSIS x64 estratti: 50 sorgenti e 15 shader uguali al checkout, configurazione pubblica confrontata con input esplicito; ASAR comune acd045aa7d4ebc120a58e0b3e3c926aa3a749fc4d10d1746a0006d441b69eb4f. Manifest e copie in outputs/popup-0.5.48 verificati con hash. Electron carica updater/dipendenze dal bundle .48 senza rete/installazione.
- Portable .47 conservata come AnimePlayer-portable-0.5.47.exe, SHA-256 80326c863c1e9ae44842f1f27d8c9784582bfa74df7b6360d19ccacb538fbb4f. NSIS .47 e pacchetti .46 conservati. Installer .48 NotSigned; nessun upgrade reale, installazione, cloud live o pubblicazione. Restano i limiti esterni precedenti.

### Esiti locali storici 0.5.47 — 12 ottobre 2026

- npm run check: PASS. npm run dist: PASS; include di nuovo la suite completa. Tutti i test specifici finali: 20 Node + 2 trasferimenti con il vero updater + 8 gruppi Electron, senza fail/skip. npm audit: zero vulnerabilità riportate.
- Portable e NSIS x64 .47 estratti senza esecuzione/installazione: 50 sorgenti e 15 shader uguali al checkout, manifest versione corretta, ASAR comune 6050e2331af882d38bb5c6d291fc5f1f87222ef8ad66a4c3a9c6d004b994e9c6, configurazione pubblica confrontata con l'input esplicito, nessun file personale nel bundle.
- latest.yml e blockmap generati; dimensioni/SHA-512 del manifest confrontati con l'installer. Probe Electron 44.7.0 carica electron-updater 6.8.10 e semver 7.7.3 dal vero app.asar, con versione .47 e provider ufficiale; nessuna richiesta di rete/installer in quel probe.
- Installer locale NotSigned. La menzione di signtool nel log di builder non equivale a firma Authenticode verificata.
- Portable .46 conservata come AnimePlayer-portable-0.5.46.exe, SHA-256 D9C92AECEA2B9E8316531B2F1227ECA9C7A78383F0F7FDCFB044B4C5F0D01209; NSIS .46 conservato. I pacchetti .47 precedenti alla correzione finale sono stati rigenerati e il confronto dei sorgenti ha verificato quelli finali.
- Le prove iniziali hanno rilevato interferenze di timing/focus nelle catture delle schede, il selettore diagnostico troppo generico dopo l'aggiunta del changelog e il riuso in memoria di una cache alterata in updater v6. Le correzioni mantengono le asserzioni e il nuovo test verifica il vero scaricamento dopo il rifiuto della cache. Un processo Node di una prova intermedia è terminato per memoria esaurita; le prove finali passano, senza attribuirlo al runtime installato.
- Linux/macOS e la pipeline GitHub restano configurati ma non eseguiti in questo ambiente Windows. Upgrade NSIS reale, firma/notarizzazione, logout del sistema reale, cloud live e autorizzazione della prima release restano da verificare esternamente.
