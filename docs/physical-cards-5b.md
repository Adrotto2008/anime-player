# Fase 5B — carte fisiche (0.5.43)

Base: 0.5.42, commit 947f8a98b9668fdd64b8f44c36d7bcaefee767f1.
Branch locale: feat/physical-cards-5b. Solo checkout isolato; nessuna
libreria personale, login cloud, integrazione o pubblicazione.

## Interazione

La presa avviene sulla superficie di anime, franchise, raccolte e membri.
Le intestazioni delle sezioni Home sono trascinabili. Non esiste una modalità
Organizza. Creazione, rinomina e rimozione delle raccolte restano comandi
normali. I pulsanti di azione, input, link, menu e controlli sono esclusi
dalla presa; il pulsante di navigazione della carta è una superficie valida.

Mouse: sotto 8 px resta un click, senza preventDefault sulla pressione.
Superata la soglia viene catturato il puntatore e soltanto il click di
rilascio viene consumato. Touch: 380 ms di pressione ferma; un movimento
prima della soglia annulla la candidatura e lascia lo scroll nativo.
Dopo la presa touchmove viene consumato prima che Chromium inizi il pan.
Esc, pointercancel, perdita del focus e rilascio incompatibile annullano.
Il cursore sulle carte rimane default, anche durante drag e atterraggio.

Ogni carta e sezione conserva un comando di riordino accessibile nel
percorso Tab: è nascosto visivamente fino al focus, senza maniglie negli
angoli. Spazio/Invio seleziona, frecce spostano, Ctrl+frecce cambia lista,
Invio salva, Esc/Tab annulla. Il focus viene ripristinato dopo i salvataggi
da tastiera. Annunci aria-live descrivono posizione ed esito.

## Animazione

card-motion.js integra molle smorzate per i soli elementi attivi, con
velocità conservata fra aggiornamenti e fra animazioni successive.
Stiffness 240, damping 25 per hover/vicini; 300/26 per carta sollevata.
Il passo temporale è limitato a 32 ms per contenere le sospensioni del
renderer. Non sono state aggiunte librerie o dipendenze.

Hover: posizione reale del puntatore normalizzata sulla carta, massimo
4°/5° di rotazione, 5 px di sollevamento, scala 1.016. Il figlio visivo
riceve transform, mentre il contenitore mantiene la geometria della griglia.
La carta sollevata segue direttamente il puntatore a ogni rAF; velocità
e direzione governano rotazioni limitate a 5°/7°, scala 1.035.
La copia inert e aria-hidden è nel body e attraversa le sezioni; ID DOM
duplicati e trasformazioni pregresse vengono rimossi.

I vicini ricevono translate individuale, separato dall'hover. Le molle
mantengono la posizione visiva corrente quando cambia la destinazione.
Griglie da 80 schede usano la permutazione virtuale della Fase 5; al drop
il DOM viene aggiornato con conservazione della posizione visiva. Liste
piccole e categorie usano lo stesso modello dopo inserimenti provvisori.
Il placeholder occupa spazio ma non sovrappone una seconda carta visibile.

Il rilascio attende l'atterraggio della copia, recupera scala e rotazione,
poi rimuove la copia e invia un solo comando relativo. Esc ripristina la
permutazione e anima la copia verso l'origine, senza invocare IPC di
salvataggio. Le geometrie sono invalidate da scroll, resize e ResizeObserver;
le griglie virtuali ricalcolano gli offset quando cambia la dimensione.
Il renderer rinvia sostituzioni complete durante pressione, drag,
atterraggio e salvataggio. prefers-reduced-motion elimina rotazione,
sollevamento e animazione, conservando ordine, click e tastiera.

## Integrità

Nessuna modifica a src/organization.js, organization-service, Store o cloud.
Il campo organization e le transazioni della Fase 5 sono riutilizzati.
Il token del contesto è catturato alla pressione e conservato fino al
comando; aggiornamenti successivi del contesto non autorizzano un drag
iniziato in un altro scope. La vista torna a Il mio ordine dopo il drop.
Collocazione tra raccolte è solo visiva; categoria/distacco continuano a
richiedere conferma e validazione. Nessuna nuova relazione AniList o
modifica automatica di franchiseLinks.

## Verifica ripetibile e limiti

npm run check esegue suite Node, sintassi e regressioni Electron.
test/organization-electron.js usa finestra Windows visibile, input mouse e
tastiera nativi Electron, touch emulato Chromium e Store temporaneo.
PHASE5_EVIDENCE_DIR abilita sequenze PNG, trace delle trasformazioni e
rapporto JSON; la cattura è esclusa dai benchmark.

I benchmark 100/400/1000 schede misurano intervalli rAF reali con
P95, massimo e conteggi oltre 20/33.34 ms, revisioni e sostituzioni del main.
Sono sintetici: asset locali, nessuna rete o libreria personale; non
garantiscono 60 FPS per qualunque GPU, copertina o carico del sistema.
Touch fisico e lettori schermo richiedono prova manuale. Cloud live,
Linux/macOS e regressioni personali intermittenti non sono certificati.
Il rapporto di consegna contiene i risultati effettivi e i log.

## Piano manuale isolato

1. Avviare soltanto il launcher di verifica con profilo locale e fixture
   sintetica, scegliendo Continua offline. Non aprire la libreria personale.
2. Muovere lentamente il mouse fra angoli opposti: tilt progressivo e
   contenuto leggibile; uscire dalla carta e osservare il ritorno.
3. Fare click breve e piccoli movimenti sotto 8 px: apertura normale.
4. Trascinare direttamente anime/franchise, invertire direzione e
   osservare vicini, inclinazione, ombra e cursore normale.
5. Rilasciare su destinazione valida: atterraggio elastico; provare Esc e
   rilascio sulla barra laterale: ritorno e nessuna modifica d'ordine.
6. Creare, rinominare e rimuovere raccolte; spostare carte fra raccolte,
   poi tornare alla Libreria. Non devono cambiare progressi o membership.
7. Trascinare intestazioni Home e opere delle categorie; annullare e poi
   confermare il dialogo di appartenenza, verificando franchiseLinks.
8. Provare input, ricerca, menu, gestione e Tab/Spazio/frecce/Ctrl/Invio/Esc.
9. Provare scroll ai bordi, ridimensionamento durante drag e aggiornamenti.
10. Attivare reduced motion; su dispositivo touch provare scroll breve e
    pressione prolungata. Verificare gli annunci con lettore schermo.
11. Chiudere e riaprire lo stesso profilo isolato: ordine persistente.
12. Provare riproduzione e flussi precedenti nel profilo isolato. Non
    considerare prove automatiche come un risultato manuale dell'utente.
