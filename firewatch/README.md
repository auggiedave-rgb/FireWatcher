# FireWatch – incendi attivi nel mondo su globo 3D

Web app (PWA) per smartphone che mostra su un globo 3D i rilevamenti di incendi e anomalie termiche
di NASA FIRMS degli ultimi 7 giorni, con focus su Italia ed Europa. Interfaccia in inglese.

## Struttura

```
firewatch/
├── netlify.toml                  configurazione Netlify
├── netlify/functions/fires.mjs   proxy FIRMS: nasconde la MAP_KEY, CSV → JSON, cache CDN
└── public/                       front-end statico
    ├── index.html, style.css, app.js
    ├── manifest.webmanifest, sw.js   (installabile + ultimo dato disponibile offline)
    └── icons/
```

## Fonti
- **Rilevamenti**: NASA FIRMS, API `area/csv`, sorgenti VIIRS NOAA-20 / NOAA-21 / Suomi NPP e MODIS (NRT).
  La funzione scarica un giorno UTC alla volta per tutto il mondo e la CDN di Netlify lo tiene in cache
  (oggi 15 min, ieri 1 h, giorni precedenti 12 h). FIRMS viene quindi interrogato pochissime volte,
  indipendentemente dal numero di utenti.
- **Immagini del globo**: NASA GIBS (nessuna chiave richiesta): Blue Marble (senza nuvole),
  VIIRS True Color del giorno (con nuvole e fumo reali), Black Marble (luci notturne, lato notte).
- **Confini e nomi dei Paesi**: Natural Earth (via jsDelivr).
- **Globo**: CesiumJS 1.147 da CDN (nessun token Cesium ion necessario).

## 1. Ottieni la MAP_KEY FIRMS (gratuita)
1. Vai su https://firms.modaps.eosdis.nasa.gov/api/map_key/
2. Inserisci la tua email: la chiave (32 caratteri) arriva subito per posta.

## 2. Pubblica su Netlify
Attenzione: il **drag & drop** della cartella su Netlify pubblica solo i file statici, **non le funzioni**.
Usa uno di questi due metodi.

**A. Netlify CLI (più rapido)**
```bash
npm install -g netlify-cli
cd firewatch
netlify login
netlify init            # crea/collega il sito
netlify env:set FIRMS_MAP_KEY la_tua_chiave
netlify deploy --prod
```

**B. GitHub**
1. Carica la cartella `firewatch` in un repository GitHub.
2. Su Netlify: *Add new project → Import an existing project* e scegli il repo (le impostazioni sono già in `netlify.toml`).
3. Nelle impostazioni del sito, sezione *Environment variables*, aggiungi `FIRMS_MAP_KEY` con la tua chiave, poi rifai il deploy.

## 3. Installa sul telefono
Apri l'URL del sito → menu del browser → *Aggiungi a schermata Home*.

## Test locale
```bash
cd firewatch
FIRMS_MAP_KEY=la_tua_chiave netlify dev
```

## Prossimi passi previsti
- Notifiche push (Italia/Europa): scheduled function ogni 30 min + Web Push (VAPID) + iscrizioni in Netlify Blobs.
  Su iPhone funzionano solo con l'app installata sulla Home.
- Riproduzione animata giorno per giorno degli ultimi 7 giorni.
- Livello EFFIS (aree bruciate e pericolo incendio in Europa).
- Filtro dei siti fissi (vulcani, impianti industriali, torce di gas) per ridurre i falsi positivi.
