# Fase 5 — Home e Libreria personalizzabili (0.5.42)

Base verificata: 0.5.41, `28d18a3affcc6954e52f741bea76fa30ab2a4ab8`. Checkout isolato della Fase 1, branch `feat/home-library-organization-5`. Repository personale e libreria personale non utilizzati. Nessun login, cloud live, push, merge, pubblicazione o installazione.

## Superfici e interazione

La Home è la schermata Libreria già esistente. Le sezioni attuali sono In evidenza, Continua a guardare, Libreria, calendario settimanale e Attività recente. La Fase 5 conserva questa struttura: le sezioni possono essere riordinate; il calendario mantiene il suo significato temporale interno. I franchise e le opere indipendenti restano schede della stessa Libreria. Continua a guardare e Attività recente conservano i loro criteri di disponibilità e il limite di otto schede, con ordine manuale tra le schede disponibili.

**Organizza** espone maniglie separate dai pulsanti delle schede e dalle azioni di gestione. Le schede continuano ad aprire il contenuto. Le categorie vuote dei franchise diventano destinazioni. **Nuova raccolta** crea una sezione visiva esplicita; rinomina/rimozione restano disponibili in Organizza. Rimuovere una raccolta restituisce le schede alla Libreria. Spostare una scheda tra raccolte o Libreria non modifica il record dell’opera/franchise. Un franchise è sempre spostato come intera scheda, senza modificare i suoi membri.

Mouse e Pointer Events touch utilizzano una soglia di 7 px, cattura del puntatore sulla maniglia, anteprima separata e posizione provvisoria nello stesso DOM. Il trascinamento indica destinazione e posizione, sposta i vicini con FLIP/Web Animations a 180 ms (`cubic-bezier(.2,.7,.2,1)`), senza elasticità. La posizione provvisoria occupa spazio reale; non viene sovrapposta agli altri contenuti. Il browser rileva la scheda sotto il puntatore; la geometria viene misurata solo per gli elementi interessati. La modalità ridotta salta le animazioni di riordino. Scorrimento verticale ai bordi e orizzontale nelle strip consentono di raggiungere destinazioni fuori vista.

Esc, pointercancel, perdita del focus della finestra e uscita con Tab dalla selezione da tastiera ripristinano il DOM e non invocano la persistenza. Il rilascio fuori dalle destinazioni compatibili annulla. Un normale click sulla maniglia non apre una scheda; il click prodotto dal rilascio di un drag viene assorbito. Le maniglie supportano Spazio/Invio per selezionare, frecce per cambiare posizione, Ctrl + frecce per cambiare sezione compatibile, Invio per salvare ed Esc per annullare. I pulsanti ↑/↓ già presenti restano un’alternativa accessibile e ora aggiornano solo l’ordine visivo. Focus delle maniglie e annunci `aria-live` sopravvivono al salvataggio e ai refresh.

Per le griglie visive con almeno 80 schede, l’anteprima usa una permutazione in memoria e trasformazioni solo sulle schede spostate. Il DOM viene riordinato al drop; Esc rimuove le trasformazioni senza riscrivere la griglia. Questo evita il costo di un layout completo a ogni inserimento tra centinaia di nodi. Righe a dimensione nota e `content-visibility:auto` rinviano il rendering delle schede fuori vista conservando spazio e contenuto accessibile. Un ResizeObserver reagisce soltanto alle variazioni di larghezza, senza cicli di aggiornamento dell’altezza. Le categorie dei franchise e le strip conservano il normale FLIP, adatto a geometrie variabili.

## Ordine visivo e vera appartenenza

L’ordine non cambia `franchiseMembership`, `franchiseOrder`, numero di stagione, ruolo o metadati delle opere. L’ordine visivo dei membri è indipendente dalla cronologia narrativa. Cambiare una categoria nel medesimo franchise, o trascinare nell’area **Opere indipendenti**, mostra una conferma nell’app; annullare lascia l’appartenenza precedente. La conferma usa il valutatore/validatore `Store.setMembership` già esistente, salva una scelta manuale e mantiene il ruolo corrente. Non si inferiscono nuove relazioni AniList o `franchiseLinks`. Il trascinamento tra franchise differenti è incompatibile; la gestione esplicita esistente rimane il percorso per queste operazioni e per i duplicati AniList.

## Persistenza e concorrenza

Campo aggiuntivo top-level `organization`, versione 1, nello stesso JSON della libreria:

- `lists[key] = { ids, updatedAt }`: ordine per Libreria, sezioni Home, Continua/Recenti, raccolta o categoria del franchise.
- `sections[id] = { title, deleted, updatedAt }`: raccolte visive con ID persistente e tombstone logica della raccolta.
- `placements[entryId] = { section, updatedAt }`: collocazione visiva della scheda; `null` significa Libreria. Nessun campo di identità o tombstone del contenuto viene cambiato.

Le liste usano UUID/ID persistenti, mai titoli o numeri come identità. ID non più disponibili vengono ignorati dalla vista senza far risorgere record eliminati; gli elementi nuovi si aggiungono all’ordine esistente. La vista applica l’ordine manuale di default, anche dopo un riavvio. Gli ordinamenti automatici per titolo/aggiunta/voto sono viste temporanee; Organizza torna a **Il mio ordine**. Il refresh automatico non scrive le preferenze.

`src/organization.js` fornisce validazione, applicazione dell’ordine, merge e rebase condivisi tra main e renderer. `src/organization-service.js` valida destinazioni, ID, appartenenza attuale e contesto del file/account. Un comando di drop indica l’elemento e un vicino prima/dopo, invece di inviare un vecchio array completo. Così filtri, nuove aggiunte e dati aggiornati durante un drag non vengono eliminati o riscritti. Un elemento/categoria/ancora scomparso richiede un nuovo trascinamento. Una sessione precedente non può scrivere nel nuovo account.

Ogni comando valido usa una transazione sincrona con un solo salvataggio atomico e una sola revisione. Prima della prima scrittura strutturale su un file legacy, il guardiano 2A crea una copia esclusiva dei byte originali. Import mantiene il suo backup separato. Una preferenza persistita/importata non valida viene rifiutata senza azzerare il file. Backup/scrittura falliti ripristinano dati, revisione e timestamp; soltanto eventuali modifiche già pendenti prima della transazione vengono riprogrammate.

La sync privata esistente comprime/espande il campo aggiuntivo. Il merge sceglie ogni lista, raccolta e collocazione per il proprio timestamp; a pari timestamp applica un confronto deterministico del contenuto normalizzato. Operazioni su liste/collocazioni diverse sono indipendenti. Durante l’upload, il rebase ripristina la decisione locale intera e aumenta il timestamp oltre quello osservato nel merge remoto; resta `cloudDirty` fino alla conferma successiva. Anche una membership cambiata durante l’upload è ribasata atomicamente, conservando insieme categoria, ruolo e distacco. I guardiani di scope/revisione e il compare-and-swap 2A restano attivi. Trasporto, auth, tabelle, RLS e schema Supabase non cambiano.

**Limite esplicito:** due dispositivi che riordinano simultaneamente la stessa lista convergono scegliendo una delle due liste complete per timestamp/tie-break. Non è un CRDT o un vector clock; non viene promessa la composizione di tutte le permutazioni concorrenti. Il rebase protegge in particolare le modifiche locali successive allo snapshot inviato. Binari precedenti non gestiscono questa preferenza aggiuntiva; uso simultaneo di versioni vecchie e nuove sullo stesso account non supportato.

## Aggiornamenti del renderer

`renderer/sortable.js` modifica soltanto la posizione DOM e lo stile dell’anteprima durante i movimenti. Nessun rerender della libreria o scrittura Store per movimento. Le notifiche di metadati/sorgenti aggiornano lo snapshot in memoria; `render` resta sospeso fino al drop/annullamento, quindi la maniglia e il nodo selezionato non spariscono. Il comando finale viene validato sullo Store corrente. Una navigazione esplicita annulla prima il drag. Le notifiche delle attività e del player restano indipendenti.

## Test e verifiche

- `node --test test/organization.js`: ordine, raccolte, categorie/detach, validazione, riapertura, refresh, export/import, compressione, merge deterministico, backup e rollback, scope, aggiunte concorrenti, richieste CloudService fermate su barriere (ordine/collocazione/membership/account/conflitto).
- `node test/organization-renderer.js`: Electron Windows reale, finestra visibile, preload sandboxed e IPC/Store reali su dati sintetici; mouse e tastiera nativi, touch emulato dal protocollo Chromium, screenshot, animazioni attive, cancel/click ripetuti, conferma, categorie, franchise collegati, refresh durante drag, reload, finestra 800×600, movimento ridotto, autoscroll e benchmark 100/400/1000 opere.
- `npm run check` include i test nuovi e tutte le suite precedenti 2A/2B/2C/3/3B/4 e legacy. `npm run dist` ripete i check e genera portable/NSIS Windows x64 offline in `dist-phase5`, senza cancellare artefatti precedenti.
- `node scripts/verify-windows-packages.js <report.json>` estrae i pacchetti senza eseguirli o installarli e verifica manifest, sorgenti, shader, configurazione offline, payload x64 e ASAR identico.

I benchmark sono sintetici locali con schede e metadati semplici, non una garanzia per qualunque hardware o immagine/remoto. Il touch è emulato, non hardware fisico. I test cloud sono simulati e non un accesso a un account reale. I risultati misurati, comandi, hash e screenshot sono nel rapporto/evidenze della sessione. I limiti già documentati delle fasi precedenti restano validi.

## Piano manuale sicuro

1. Utilizzare Windows Sandbox o un secondo account Windows sacrificabile. Avviare il portable 0.5.42 soltanto in quell’ambiente. Usare una libreria sintetica/esportata appositamente per test; non accedere alla libreria o al cloud personale. Il checkout avviato da sorgente usa già un profilo `.isolated-user-data` locale, distinto dal profilo installato.
2. Preparare alcune opere indipendenti, due franchise collegati, membri in categorie diverse e un’opera con progresso/link/voto/header fittizi. Esportare la copia iniziale.
3. In Organizza, trascinare schede a destra/sinistra e su righe diverse, osservare anteprima e vicini; annullare con Esc e rilasciare fuori dalla griglia. Ripetere e aprire una scheda con click normale. Verificare che Gestisci franchise/menu/ricerca restino utilizzabili.
4. Riordinare le sezioni Home; creare due raccolte, spostare opere e un franchise tra esse e Libreria. Rinominarne una, rimuovere l’altra e verificare il ritorno dei contenuti. Le appartenenze e i collegamenti tra franchise devono restare invariati.
5. Dentro un franchise, riordinare membri, spostare un’opera su una categoria vuota, annullare la conferma, ripetere/confermare e provare il distacco esplicito. Verificare ruolo, formato e UUID; i dati di visione non devono cambiare.
6. Provare Spazio/frecce/Ctrl + frecce/Invio/Esc/Tab; controllare focus e annunci con il lettore schermo. Provare un dispositivo touch fisico, 800×600 e una finestra ridimensionata durante il drag, scorrimento verticale/orizzontale e preferenza Windows di movimento ridotto.
7. Cambiare schermata, refresh della UI, refresh metadati, chiudere/riaprire ed export/import nella copia. Confrontare ordine, ID, progressi, voti, fonti/header e `franchiseLinks` con gli export.
8. Per conflitti cloud usare prima i test simulati. Una prova live richiede un account di test e due profili isolati autorizzati separatamente; non usare implicitamente l’account personale.

Rollback: chiudere l’app nella copia isolata, conservarne JSON e backup, usare il commit base/vecchio eseguibile soltanto con il corrispondente backup. Non aprire contemporaneamente il nuovo JSON/cloud con un vecchio binario. Nessun rollback o trasferimento nella libreria personale viene avviato automaticamente. La Fase 6 non è avviata.
