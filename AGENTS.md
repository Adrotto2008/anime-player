# Anime Player: istruzioni per ogni modifica

Prima di modificare il progetto:

1. Controlla branch, commit e working tree con `git status --short --branch` e `git log -5 --oneline`.
2. Leggi questo file, `README.md` e la parte del codice coinvolta. Conserva le modifiche locali già presenti e limita il commit al lavoro richiesto.
3. Se la modifica cambia il comportamento o l'interfaccia dell'app, incrementa la versione in `package.json` e `package-lock.json` e aggiorna versione e note pertinenti in `README.md`.

Prima di concludere una modifica:

1. Esegui `npm run check` (test, controlli di sintassi e `git diff --check`).
2. Se cambia l'app o la versione, esegui `npm run dist`. Lo script ricostruisce gli eseguibili e rimuove prima gli installer `AnimePlayer-Setup-*.exe` delle versioni precedenti: in `dist` deve restare solo l'installer della versione corrente, insieme al portable aggiornato.
3. Controlla i file in `dist`, rivedi `git diff` e crea sempre un commit locale con un messaggio descrittivo.
4. Dopo il commit locale fermati. Non eseguire `git push`, creare tag remoti o pubblicare release su GitHub finché Adriano non lo chiede esplicitamente.

## Comandi utili

- `npm start`: avvia l'app.
- `npm run check`: esegue i test e i controlli senza creare gli eseguibili.
- `npm run dist`: controlla il progetto, elimina gli installer vecchi e genera portable e installer Windows per la versione in `package.json`.

Il terminale può pubblicare su GitHub: `gh` è installato e può avere una sessione autenticata. Verificare l'account con `gh auth status` se Adriano chiede un'operazione remota. L'autenticazione disponibile non equivale al permesso di pubblicare senza richiesta esplicita.
