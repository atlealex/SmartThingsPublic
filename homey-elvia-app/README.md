# Elvia-Nett for Homey Pro

En Homey Pro-app som henter data fra [Elvia](https://www.elvia.no) sitt API:

- **Nettleiepris og fastpris** (`grid-tariff`) — offentlig, krever kun en
  abonnementsnøkkel.
- **Makseffekt / makstimer** (`meter values` → maxhours) — personlig data
  (brukes til å avgjøre hvilket fastprisnivå du ligger på), krever i tillegg
  en personlig tilgangstoken siden dataene er knyttet til ID-porten-innlogging.

## Hvorfor et manuelt token?

Elvia sin API for måleverdier (makstimer) er koblet til innlogging via
ID-porten (BankID/MinID). Homey kan ikke gjennomføre denne interaktive
innloggingen selv, så løsningen som brukes her — i tråd med andre kjente
integrasjoner for Elvia (f.eks. Home Assistant) — er at du logger inn på
[elvid.no](https://elvid.no), henter ut din personlige tilgangstoken, og limer
den inn i enhetsinnstillingene. Tokenet har begrenset levetid og må fornyes
manuelt fra tid til annen. Nettleiepris og fastpris (uten makstimer) fungerer
uten dette tokenet.

## Oppsett

1. Registrer deg på [Elvia sin utviklerportal](https://elvia.portal.azure-api.net)
   og abonner på produktet **Grid tariff** for å få en abonnementsnøkkel
   (sendes som `X-API-Key`-header).
2. Finn målepunkt-ID-en din (står i Elvia sin kundeportal eller på måleren).
3. (Valgfritt) Logg inn på [elvid.no](https://elvid.no) og kopier tilgangstokenet
   ditt hvis du også vil ha makseffekt/makstimer.
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

Fungerer uten tilgangstoken (kun abonnementsnøkkel):
- `measure_price` — gjeldende nettleiepris (NOK/kWh).
- `fixed_price_hourly` — fastpris for gjeldende time (NOK/t).
- `fixed_price_monthly` — fastpris for måneden på ditt nivå (NOK/mnd).
- `fixed_price_level_info` — tekstbeskrivelse av effektnivået ditt (f.eks.
  "Effektforbruk: 2-5 kWh/t").

Krever i tillegg tilgangstoken fra elvid.no:
- `consumption_previous_hour` — forbruk forrige time (kWh).
- `max_hours_average` — snitt av makseffekt, for inneværende og forrige måned.
- `max_hour_rank` — makstime 1, 2 og 3 (høyest til lavest av de tre høyeste
  timene), for inneværende og forrige måned.

Flow-kort:
- **Trigger**: "Nettleieprisen endret seg" — med prisen som token.
- **Condition**: "Nettleieprisen er over ...".
- **Action**: "Oppdater Elvia-data nå" — tvinger et umiddelbart API-kall.

Data hentes automatisk hvert 30. minutt (konfigurerbart per enhet).

## Om API-endepunktene

Elvia sin egen dokumentasjon var ikke tilgjengelig da denne appen ble laget,
så endepunktene i `lib/ElviaApi.js` er hentet fra to fungerende
åpen-kildekode-klienter:
[sindrebroch/ha-elvia](https://github.com/sindrebroch/ha-elvia) (Home
Assistant) og [andersem/elvia-python](https://github.com/andersem/elvia-python).
Nettleiepris/fastpris hentes via
`POST /grid-tariff/digin/api/1/tariffquery/meteringpointsgridtariffs` med
`X-API-Key`-header, og makstimer via
`GET /customer/metervalues/api/v2/maxhours` med `Authorization: Bearer`-header.
Feltnavnene for fastpris/makstimer i responsen er rekonstruert fra
`ha-elvia` sin `coordinator.py` og kan i verste fall avvike noe fra det
virkelige API-et; se `this.error(...)`-loggene i Homey CLI-terminalen
(`homey app run`) om noen av disse verdiene ikke dukker opp.

## Kjente begrensninger

- Elvia kan endre API-endepunktene sine uten varsel; sjekk kildene nevnt over
  eller [utviklerportalen](https://elvia.portal.azure-api.net) om kall
  begynner å feile. Standard API-URL er `https://elvia.azure-api.net`, men
  den kan overstyres per enhet under enhetsinnstillinger → Avansert → API
  base URL, uten å måtte endre kode, dersom Elvia bruker et annet vertsnavn.
- Tilgangstokenet fra elvid.no utløper og må limes inn på nytt manuelt — det
  finnes ingen automatisert fornyelse siden det krever interaktiv
  ID-porten-innlogging.
- Appen er bygget for SDK3 og krever Homey Pro (ikke Homey Bridge).
