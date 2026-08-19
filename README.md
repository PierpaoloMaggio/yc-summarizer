# Y Combinator Summarizer

Cron GitHub Actions che ogni ora controlla il canale YouTube di [Y Combinator](https://www.youtube.com/@ycombinator) (startup, prodotto, tecnologia, AI), riassume i nuovi video **lunghi** via Claude Sonnet 4.5 e manda la sintesi strutturata via mail.

Sesto membro della flotta summarizer (dopo lenny, nate-herk, omar-bragantini, the-neuron, carl-weische). Due differenze rispetto agli altri, dovute al volume e al tipo di contenuto del canale:

- **Filtro durata a 30 minuti.** YC pubblica ~5 video/settimana tra podcast lunghi, talk e clip brevi. Passano solo i video da 30 minuti in su, il resto viene marcato come processato senza generare mail.
- **Prompt filtrante, non riassuntivo.** Il taglio è "cosa di questo video è trasferibile al lavoro sui clienti PMI/e-commerce". Il contenuto puramente da founder (fundraising, cap table, equity, dinamiche tra cofondatori) viene scartato e dichiarato nella sezione finale.

## Struttura del riassunto (5 sezioni)

1. **Riassunto** — argomento principale + una riga onesta sulla rilevanza per il lettore
2. **Tesi e argomenti principali** — 5-8 punti
3. **Trasferibile al lavoro sui clienti** — principio + traduzione operativa (oppure dichiarazione esplicita che non c'è nulla di trasferibile)
4. **Segnali su AI, strumenti e mercato** — nome + perché conta, con numeri quando citati
5. **Da scartare** — cosa nel video è contesto startup non applicabile

## Filtro durata

La durata si legge da `lengthSeconds` sulla pagina del video, prima della chiamata Apify: i video corti non consumano transcript. Se YouTube serve una consent page all'IP del runner e il dato non è leggibile, si ricade sui timestamp del transcript (`start` + `dur` dell'ultimo segmento), quindi il filtro scatta comunque prima della chiamata a Sonnet.

## Canale

- Handle: `@ycombinator`
- Channel ID: `UCcefcZRL2oaA_uBNeo5UOWg`

## Secrets

Stessi 4 degli altri summarizer: `APIFY_TOKEN`, `OPENROUTER_KEY`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`.

## Primo avvio

1. Push del repo con i secrets configurati.
2. Actions → "Y Combinator Summarizer" → Run workflow.
3. Prima run = seed dei videoId correnti senza mandare mail. Dalla seconda processa i nuovi.

## Costo

Transcript lunghi (30-90 minuti) pesano di più di quelli degli altri canali: ~$0.10-0.20/video Sonnet 4.5. Con il filtro a 30 minuti passano ~2-3 video/settimana, quindi ~$1-2/mese.
