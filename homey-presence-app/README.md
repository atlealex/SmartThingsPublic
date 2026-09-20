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
   til et bilde av personen (f.eks. et du allerede har liggende på en
   Synology NAS med Web Station, eller i Home Assistant sitt lokale
   nettverk, som `http://192.168.1.220/avatars/dad.jpg`).
2. Bygg en Homey Flow som setter enhetens tilstedeværelse basert på kilden du
   allerede har (se over).
3. For å vise bildet et sted du faktisk ser det til vanlig: legg til
   **«Personbilde»**-widgeten på et Homey-dashbord (se under) — én widget pr.
   person, side om side.

## Personbilde-widgeten

Selve enhetskortet i rom-/enhetsoversikten viser bare et generisk ikon (det
er en begrensning i Homey — det kompakte kortet bruker alltid driverens
statiske ikon, uansett enhetsklasse). Homeys innebygde **Kamera**-widget
*kan* vise bildet, men er laget for videobilder og er for stor til at flere
personer får plass ved siden av hverandre.

Denne appen leverer derfor sin egen, kompakte dashbord-widget
(**«Personbilde»**): en liten sirkel med bildet og fargeringen, akkurat som
avatar-kortene i Home Assistant. Legg til én widget pr. person på
dashbordet, og velg riktig enhet i widget-innstillingene — flere slike
widgets kan stå side om side.

Widgeten henter bildet direkte fra bilde-URL-en (samme lenke som i
enhetsinnstillingene) og tegner fargeringen med CSS, og sjekker
hjemme/borte-status på nytt hvert 10. sekund.

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
(`jimp`, for bildekomposisjon) automatisk. `jimp` er ren JavaScript uten
kompilerte binærfiler, med vilje — appen skal fungere likt uansett om
`npm install` kjøres på en Windows-PC eller direkte på Homey-en, uten risiko
for at feil plattforms binærfil følger med i pakken.

## Capabilities

- `home` — boolsk, om personen er hjemme (`true`) eller borte (`false`).
  Kan settes manuelt fra enhetskortet, eller fra en Flow.

## Flow-kort

- **Trigger**: «Person kom hjem» / «Person dro hjemmefra».
- **Condition**: «Person er / er ikke hjemme».
- **Action**: «Sett person som hjemme» / «Sett person som borte».

## Kjente begrensninger

- Enhetens kort i rom-/enhetsoversikten viser et generisk ikon, ikke bildet —
  bekreftet på ekte maskinvare at Homeys kompakte kort alltid bruker
  driverens statiske ikon uansett enhetsklasse. Bruk «Personbilde»-widgeten
  (se over) for å faktisk se bildet med fargering i det daglige.
- Bilde-URL-en må være tilgjengelig fra Homey Pro sitt nettverk (typisk en
  lokal adresse på hjemmenettverket, f.eks. en Synology NAS med Web
  Station, eller en offentlig URL). Må være en direkte, autentiseringsfri
  lenke til selve bildefilen.
- Ingen egen tilstedeværelsesdeteksjon — krever at du kobler på en Flow fra en
  kilde du allerede har (Homeys egen, eller Home Assistant via webhook).
- Krever Homey-firmware `>=12.3.0` (for widget-støtte).
