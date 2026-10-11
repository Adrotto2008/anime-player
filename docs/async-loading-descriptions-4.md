# Fase 4 — caricamenti asincroni e descrizioni

Base: `feat/independent-franchise-links-3b` a `1df7bd60ae60c159c114bbf1e566d385cee8dda6` (0.5.39). Prima implementazione: 0.5.40; completamento su base `9b9e4d0a7dabd1d421e6eb848f1a27c94c2b771b`: 0.5.41, branch `feat/async-loading-descriptions-4`.

## Aggiunta e arricchimento

`series:addStart` avvia un’operazione nel processo principale e restituisce il record dopo la classificazione essenziale e il salvataggio locale. Il renderer riceve `addition:progress`; il pannello sulla rail segue le fasi d’identificazione, metadati AniList, relazioni, salvataggio, metadati ulteriori e sorgenti. Le fasi con un totale non noto sono indeterminate. Il task resta visibile durante la navigazione; chiudere il dettaglio non lo annulla. Annullamento, retry e cambio account agiscono sul task; guardie di generazione/scope proteggono gli aggiornamenti tardivi. La cancellazione di serie, franchise o task invalida le richieste correlate.

`src/work-queue.js` applica concorrenza massima 2, deduplica per chiave persistente dello scope e dà precedenza al lavoro interattivo. `src/anilist-client.js` mantiene rate limit/backoff condivisi e consente di elevare richieste pendenti duplicate. Il discovery provider resta serializzato per l’uso delle sessioni condivise. Le API più lente non bloccano la risposta principale; i fallimenti opzionali lasciano il record salvato e lo stato parziale ripetibile. `series:create` resta disponibile con il contratto sincrono per chiamanti e test esistenti.

## Descrizioni

Decisione definitiva di prodotto del 2026-10-11: **solo descrizioni originali**, rinuncia alla traduzione automatica. Il renderer usa descriptionOriginal, con fallback al campo description per i dati legacy. Il selettore è rimosso, l’IPC di traduzione non è esposto e non viene effettuata alcuna richiesta. Nessun provider viene integrato. Non è un requisito aperto.

Descrizione, lingua e provenienza restano separati dalla cache preesistente. Tutte le traduzioni archiviate, anche di una revisione precedente del testo, sono conservate durante refresh, salvataggio/riapertura, import/export e cloud; non sono mostrate. L’hash resta disponibile come provenienza storica. descriptionMode preesistente resta salvato ma non influenza la UI; il default nuovo è original. Nessuna migrazione distruttiva o dipendenza nuova. Il servizio iniettabile precedente resta inutilizzato per evitare una riscrittura, senza un percorso IPC/UI che possa invocarlo. Se un vecchio record non ha un originale distinto, si può mostrare solo il testo disponibile: la sua lingua/provenienza non viene inventata.

## Interfaccia e contenuti

Le aggiunte hanno indicatori non bloccanti, dettagli fase per fase, annullamento e retry. Le descrizioni indicano il testo originale. Task parziali/falliti restano visibili con retry; un job successivo non cancella l’errore precedente. Un task completato non mostra più uno spinner. Il badge franchising mostra «Season N · Part 2» quando il titolo AniList contiene esplicitamente Part 2, senza cambiare identità, categoria o numerazione persistente. Gli OVA con due unità mantengono le identità e i titoli provider già disponibili; non vengono inventati nomi o record.

## Test e benchmark

Nuovi test: `test/addition-operations.js`, `test/work-queue.js`, `test/series-addition-async.js`, `test/descriptions.js`, `test/description-persistence.js`. Verificano risposta prima dei provider opzionali, annullamento con risposte tardive, retry/idempotenza, account scope, priorità e concorrenza, cache/fallback, refresh, riapertura, import/export e merge cloud.

Benchmark sintetico contro `src/series-addition.js` del commit base, con latenza provider simulata di 15 ms per Kitsu e IMDb e grafi AniList locali:

| Opere | Baseline: risposta/completamento | Fase 4: risposta/completamento | Riduzione risposta |
|---:|---:|---:|---:|
| 1 | 69 / 69 ms | 39 / 68 ms | 44% |
| 4 | 168 / 168 ms | 7 / 90 ms | 96% |
| 10 | 568 / 568 ms | 14 / 248 ms | 98% |

Sono misure sintetiche di un singolo processo locale, non tempi di rete reali. La risposta della Fase 4 comprende il lavoro necessario a identificare e salvare; il completamento attende i provider opzionali limitati dalla concorrenza.

## Piano di verifica manuale isolato

1. Avviare il portable 0.5.41 da Windows Sandbox o da un secondo account Windows usa-e-getta, con profilo Anime Player vuoto. Importare solo una copia sacrificabile della libreria preparata appositamente; non autenticare l’account personale. In questo modo il `userData` predefinito appartiene all’ambiente isolato.
2. Aggiungere un titolo con più stagioni e osservare che la serie appare dopo il salvataggio principale, mentre le fasi restano visibili passando tra home e dettaglio.
3. Simulare offline o bloccare i provider opzionali: verificare stato parziale, contenuto salvato e retry finito. Annullare un task e controllare che una risposta ritardata non modifichi la copia.
4. Chiudere e riaprire il dettaglio; verificare che il task completato/restante sia consultabile finché il processo è attivo. Chiudere l’app e controllare che contenuti essenziali già salvati persistano.
5. Verificare che la descrizione sia sempre originale anche in una copia con cache tradotte o descriptionMode legacy translated. L’impostazione deve essere assente e la cache precedente deve restare nell’export.
6. Aprire Re:Zero nella copia: Season 2 Part 2 deve mostrare la parte e le due unità OVA restare distinte secondo i metadati già presenti.

Non è stata aperta o modificata la libreria personale. Il task manager vive in memoria e i suoi dettagli non sono persistiti tra riavvii; il contenuto già salvato sì. La persistenza delle attività dopo riavvio non è dichiarata come funzionalità.

## Build isolata e configurazione client

npm run dist produce esplicitamente portable e NSIS Windows x64, senza pubblicazione, in dist-phase4-complete. Nessun artefatto precedente viene eliminato. Il checkout avviato da sorgente usa .isolated-user-data e sessionData locale; non apre il profilo dell’app installata e non eredita chiavi Supabase dall’ambiente. Le app pacchettizzate mantengono il normale profilo, quindi per la verifica devono essere eseguite soltanto nell’ambiente Windows isolato indicato sopra.

La build non consulta AppData né chiavi ambiente implicite, e non legge la precedente .build-resources. Senza SUPABASE_CONFIG_FILE fornito esplicitamente scrive {} nella risorsa, sovrascrivendo soltanto la risorsa generata del checkout, e produce una build offline. Se il file è fornito, accetta esattamente url e publishableKey, solo HTTPS senza credenziali/query/frammenti e il progetto previsto. Chiavi secret/service_role, token/sessioni e campi extra bloccano la build senza stamparne i valori. Le chiavi client pubbliche sono intenzionalmente estraibili da un’app desktop ([documentazione Supabase](https://supabase.com/docs/guides/getting-started/api-keys)); nessuna configurazione client è stata inclusa in questo completamento.

Il primo packaging .5.40 era stato interrotto: non esiste evidenza conservata di un errore NSIS da attribuire a una causa specifica. Il completamento conserva stdout/stderr di npm run dist e verifica separatamente gli archivi prodotti; gli esiti definitivi, hash e commit sono nel rapporto di consegna outputs/rapporto-fase-4-completamento.md.

Verifica reale opt-in: node test/phase4-live.js PATH_EVIDENZA_JSON usa solo provider pubblici, una libreria sacrificabile dentro work e timeout finiti; non avvia stream o CloudService e conserva soltanto conteggi/identificatori, senza link, header o cookie nelle evidenze. Your Name. (AniList 21519) è stato identificato/salvato, arricchito con due sorgenti in una sola parte e riaperto con UUID e originale conservati. La disponibilità di ogni provider e la riproducibilità degli stream non sono certificate da questo probe.

## Esito del completamento 0.5.41

npm run check e npm run dist completati con exit code 0; suite 2A/2B/2C/3/3B e legacy passate, senza skip. La build è stata offline. Portable Windows x64 e NSIS Windows x64 estratti senza eseguirli: 39 file applicativi corrispondono al checkout, 15 shader verificati, package versione 0.5.41, payload PE x64, configurazione client vuota e nessun file personale nell’ASAR. I payload app.asar sono identici tra i due pacchetti. Verifica riproducibile: node scripts/verify-windows-packages.js; usa soltanto strumenti già presenti fra le dipendenze di sviluppo.

I primi due check di questa sessione fallivano perché i mock di Electron non esponevano setPath/isPackaged per il nuovo bootstrap isolato. Ora i mock riproducono esplicitamente il percorso pacchettizzato e una regressione separata verifica il profilo sorgente locale. I log falliti sono conservati negli outputs. Il test introdotto sullo stato partial aveva inizialmente riprodotto il difetto e passa dopo la correzione; la prima ispezione del package.json byte-per-byte era una verifica errata, poiché electron-builder rimuove correttamente i campi di sviluppo. La verifica finale confronta semanticamente versione/manifest e byte-per-byte tutti i file applicativi.

L’installer non è stato eseguito/installato; firma Authenticode non configurata e icona Electron predefinita sono avvisi preesistenti di packaging, non errori di build. Le prove umane sulla UI 0.5.41 e la sincronizzazione cloud fra due dispositivi restano non effettuate. I test manuali 1–7 della 3B sono confermati dall’utente; il test 8 di riavvio della 3B resta non eseguito manualmente.

Un rilancio del probe live tramite pipeline PowerShell ha terminato con exit -1073740791 (0xc0000409), senza report finale; causa non attribuita e nessun evento Application pertinente trovato nel breve intervallo controllato. Il rilancio diretto è riuscito: core salvato prima del completamento, progress provider con conteggi reali, due sorgenti e riapertura confermata. Codice d’uscita conservato in phase4-live-final-exit.json; report valido in phase4-live-final.json. Non è stato classificato come incidente mpv o regressione dell’app.
