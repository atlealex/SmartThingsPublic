# Familie hjemme (Family presence) for Homey Pro

En Homey Pro-app som viser hvert familiemedlems bilde med en grønn ring når de
er hjemme, og grå når de er borte — samme visuelle stil som avatar-kortene i
Home Assistant.

## Hvordan det fungerer

Denne appen gjør **ikke** sin egen geofencing/tilstedeværelsesdeteksjon — den
lener seg på tilstedeværelse Homey (eller Home Assistant) allerede sporer, og
legger til det visuelle laget:

1. Du legger til én **Person**-enhet pr. familiemedlem, med et bilde-URL.
2. Appen komponerer bildet til en sirkel med en fargeranding (grønn/grå)
   basert på enhetens `home`-status.
3. Du kobler denne statusen til tilstedeværelsen du allerede har, med en
   vanlig Homey Flow, f.eks.:
   - **NÅR** «Den første brukeren kommer hjem» (Homeys innebygde
     tilstedeværelse) **DA** «Sett person som hjemme» (denne appen)
   - **NÅR** «Den siste brukeren drar hjemmefra» **DA** «Sett person som
     borte»
   - Har du tilstedeværelse i Home Assistant i stedet: bruk en HA-automasjon
     som kaller Homeys Flow-webhook, eller `Homey Bridge for HA`-integrasjonen
     til å trigge disse Flow-ene derfra.

Du kan også bare dra bryteren på enhetens kort manuelt (nyttig for å teste at
bildet og ringen oppdaterer seg riktig, før du kobler på ekte Flow-er).

## Oppsett

1. Legg til en **Person**-enhet, gi den et navn, og lim inn en direkte lenke
   til et bilde av personen (f.eks. et du allerede har liggende i Home
   Assistant sitt lokale nettverk, som `http://homeassistant.local:8123/local/people/dad.png`).
2. Bygg en Homey Flow som setter enhetens tilstedeværelse basert på kilden du
   allerede har (se over).

## Kjøre / installere appen (utvikler)

```bash
npm install -g homey
cd homey-presence-app
homey login
homey app run      # kjør appen live på din Homey for testing
# eller
homey app install  # installer appen permanent
```

`homey app run`/`install` kjører `npm install` for appens egen avhengighet
(`sharp`, for bildekomposisjon) automatisk.

## Capabilities

- `home` — boolsk, om personen er hjemme (`true`) eller borte (`false`).
  Kan settes manuelt fra enhetskortet, eller fra en Flow.

## Flow-kort

- **Trigger**: «Person kom hjem» / «Person dro hjemmefra».
- **Condition**: «Person er / er ikke hjemme».
- **Action**: «Sett person som hjemme» / «Sett person som borte».

## Kjente begrensninger / usikkerhet

- **Bildet som enhets-«ikon»**: dette er ny, uprøvd bruk av Homeys
  bilde-API (`homey.images.createImage()` + `setCameraImage()`) i denne
  appserien — mekanismen er godt dokumentert for kamera/dørklokke-apper
  (viser et bilde/miniatyrbilde på enhetskortet), men akkurat hvor og hvor
  stort bildet vises for en ikke-kamera-enhet er ikke bekreftet på ekte
  maskinvare ennå. Sannsynlig at dette trenger en runde justering når du har
  testet det, omtrent som ikonet i Elvia-Nett-appen gjorde.
- Bilde-URL-en må være tilgjengelig fra Homey Pro sitt nettverk (typisk en
  lokal adresse på hjemmenettverket, eller en offentlig URL).
- Ingen egen tilstedeværelsesdeteksjon — krever at du kobler på en Flow fra en
  kilde du allerede har (Homeys egen, eller Home Assistant via webhook).
