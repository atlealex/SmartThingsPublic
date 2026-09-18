# Elvia for Homey Pro

En Homey Pro-app som henter data fra [Elvia](https://www.elvia.no) sitt API:

- **Nettleiepris** (`grid-tariff`) — offentlig, krever kun en abonnementsnøkkel.
- **Timesforbruk** (`meter values`) — personlig forbruksdata, krever i tillegg
  en personlig tilgangstoken siden dataene er knyttet til ID-porten-innlogging.

## Hvorfor et manuelt token?

Elvia sin API for måleverdier (personlig forbruk) er koblet til innlogging via
ID-porten (BankID/MinID). Homey kan ikke gjennomføre denne interaktive
innloggingen selv, så løsningen som brukes her — i tråd med andre kjente
integrasjoner for Elvia (f.eks. Home Assistant) — er at du logger inn på
[elvid.no](https://elvid.no), henter ut din personlige tilgangstoken, og limer
den inn i enhetsinnstillingene. Tokenet har begrenset levetid og må fornyes
manuelt fra tid til annen. Nettleieprisen (uten personlig forbruk) fungerer
uten dette tokenet.

## Oppsett

1. Registrer deg på [Elvia sin utviklerportal](https://elvia.portal.azure-api.net)
   og abonner på produktet **Grid tariff** for å få en abonnementsnøkkel
   (`Ocp-Apim-Subscription-Key`).
2. Finn målepunkt-ID-en din (står i Elvia sin kundeportal eller på måleren).
3. (Valgfritt) Logg inn på [elvid.no](https://elvid.no) og kopier tilgangstokenet
   ditt hvis du også vil ha timesforbruk.
4. Installer appen på Homey Pro via Homey CLI (se under) og legg til en enhet
   av typen **Elvia målepunkt**. Fyll inn målepunkt-ID, abonnementsnøkkel og
   eventuelt tilgangstoken.

## Kjøre / installere appen (utvikler)

Appen er ikke publisert i Homey App Store — den kjøres lokalt med
[Homey CLI](https://apps.developer.homey.app/the-basics/getting-started):

```bash
npm install -g homey
cd homey-elvia-app
homey login
homey app run      # kjør appen live på din Homey for testing
# eller
homey app install  # installer appen permanent på din Homey
```

## Capabilities og Flow-kort

- `measure_price` — gjeldende nettleiepris (NOK/kWh).
- `measure_power` / `meter_power` — forrige times forbruk, satt kun dersom et
  tilgangstoken er konfigurert.
- **Trigger**: "Nettleieprisen endret seg" — med prisen som token.
- **Condition**: "Nettleieprisen er over ...".
- **Action**: "Oppdater Elvia-data nå" — tvinger et umiddelbart API-kall.

Data hentes automatisk hvert 30. minutt (konfigurerbart per enhet).

## Kjente begrensninger

- Elvia kan endre API-endepunktene sine uten varsel; sjekk
  [utviklerportalen](https://elvia.portal.azure-api.net) om kall begynner å
  feile, og se `lib/ElviaApi.js`. Standard API-URL er
  `https://elvia.azure-api.net` (utledet fra portalens URL-mønster), men den
  kan overstyres per enhet under enhetsinnstillinger → Avansert → API base
  URL, uten å måtte endre kode, dersom Elvia bruker et annet vertsnavn.
- Tilgangstokenet fra elvid.no utløper og må limes inn på nytt manuelt — det
  finnes ingen automatisert fornyelse siden det krever interaktiv
  ID-porten-innlogging.
- Appen er bygget for SDK3 og krever Homey Pro (ikke Homey Bridge).
