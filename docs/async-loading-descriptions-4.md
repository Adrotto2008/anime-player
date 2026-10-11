# Fase 4 — caricamenti asincroni e descrizioni

Base: `feat/independent-franchise-links-3b` a `1df7bd60ae60c159c114bbf1e566d385cee8dda6` (0.5.39). Risultato: 0.5.40, branch `feat/async-loading-descriptions-4`.

## Aggiunta e arricchimento

`series:addStart` avvia un’operazione nel processo principale e restituisce il record dopo la classificazione essenziale e il salvataggio locale. Il renderer riceve `addition:progress`; il pannello sulla rail segue le fasi d’identificazione, metadati AniList, relazioni, salvataggio, metadati ulteriori e sorgenti. Le fasi con un totale non noto sono indeterminate. Il task resta visibile durante la navigazione; chiudere il dettaglio non lo annulla. Annullamento, retry e cambio account agiscono sul task; guardie di generazione/scope proteggono gli aggiornamenti tardivi. La cancellazione di serie, franchise o task invalida le richieste correlate.

`src/work-queue.js` applica concorrenza massima 2, deduplica per chiave persistente dello scope e dà precedenza al lavoro interattivo. `src/anilist-client.js` mantiene rate limit/backoff condivisi e consente di elevare richieste pendenti duplicate. Il discovery provider resta serializzato per l’uso delle sessioni condivise. Le API più lente non bloccano la risposta principale; i fallimenti opzionali lasciano il record salvato e lo stato parziale ripetibile. `series:create` resta disponibile con il contratto sincrono per chiamanti e test esistenti.

## Descrizioni

La descrizione sorgente, lingua e provenienza sono conservate separatamente dalle traduzioni. La cache è keyed su SHA-256 del testo originale esatto e lingua; un refresh con testo diverso invalida solo le traduzioni obsolete. Import/export e cloud mantengono descrizione, cache valida e `descriptionMode`. L’impostazione `translated` mostra una cache disponibile oppure il testo originale con indicazione di fallback; `original` seleziona esplicitamente il testo sorgente. Le descrizioni non sono troncate.

Non è stato attivato un provider in produzione. Il vecchio URL Google Translate non documentato è rimosso. Il servizio accetta un provider iniettabile, con deduplica, timeout, cooldown errori e fallback, ma richiede una configurazione/provider approvati prima di effettuare traduzioni reali. Google Cloud Translation prevede prezzi per caratteri e autenticazione configurata ([prezzi](https://cloud.google.com/products/translate/pricing?hl=en), [autenticazione](https://docs.cloud.google.com/translate/docs/authentication?hl=en)); LibreTranslate documenta che l’uso pubblico può richiedere chiavi e che i mirror hanno disponibilità indipendente ([chiavi](https://github.com/LibreTranslate/Documentation/blob/main/src/content/docs/guides/manage_api_keys.md), [mirror](https://github.com/LibreTranslate/Documentation/blob/main/src/content/docs/community/mirrors.md)). Nessuna dipendenza o chiave è stata aggiunta.

## Interfaccia e contenuti

Le aggiunte hanno indicatori non bloccanti, dettagli fase per fase, annullamento e retry. Le descrizioni indicano traduzione automatica o fallback al sorgente. Il badge franchising mostra «Season N · Part 2» quando il titolo AniList contiene esplicitamente Part 2, senza cambiare identità, categoria o numerazione persistente. Gli OVA con due unità mantengono le identità e i titoli provider già disponibili; non vengono inventati nomi o record.

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

1. Avviare il portable 0.5.40 da Windows Sandbox o da un secondo account Windows usa-e-getta, con profilo Anime Player vuoto. Importare solo una copia sacrificabile della libreria preparata appositamente; non autenticare l’account personale. In questo modo il `userData` predefinito appartiene all’ambiente isolato.
2. Aggiungere un titolo con più stagioni e osservare che la serie appare dopo il salvataggio principale, mentre le fasi restano visibili passando tra home e dettaglio.
3. Simulare offline o bloccare i provider opzionali: verificare stato parziale, contenuto salvato e retry finito. Annullare un task e controllare che una risposta ritardata non modifichi la copia.
4. Chiudere e riaprire il dettaglio; verificare che il task completato/restante sia consultabile finché il processo è attivo. Chiudere l’app e controllare che contenuti essenziali già salvati persistano.
5. Verificare `descriptionMode` originale/tradotta con cache sintetica di test e refresh che cambia il testo. Senza provider, attendersi il testo originale e l’indicazione di traduzione non disponibile.
6. Aprire Re:Zero nella copia: Season 2 Part 2 deve mostrare la parte e le due unità OVA restare distinte secondo i metadati già presenti.

Non è stata aperta o modificata la libreria personale. Il task manager vive in memoria e i suoi dettagli non sono persistiti tra riavvii; il contenuto già salvato sì. La persistenza delle attività dopo riavvio non è dichiarata come funzionalità.
