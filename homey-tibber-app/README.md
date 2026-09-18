# Strømkostnad (Tibber) for Homey Pro

En Homey Pro-app som følger strømkostnaden din **denne måneden**, med et
estimat for hele måneden, basert på **live effektdata** fra
[Tibber](https://tibber.com) sin Pulse (på HAN-porten).

## Hvorfor live strømming i stedet for historikk?

Testet direkte mot Tibber sitt eget GraphQL-API (developer.tibber.com/explorer):
`consumption`-spørringen returnerer `null` for denne kontoen, uansett
oppløsning (time, dag, osv.) — Tibber har rett og slett ingen spørrbar
forbrukshistorikk lagret for dette målepunktet, selv om Tibber-appen viser
fine grafer (den bruker trolig data internt appen ikke deler via det
offentlige API-et) og `realTimeConsumptionEnabled` er `true`.

Appen abonnerer derfor på Tibber sin **sanntids effektstrøm**
(`liveMeasurement`, oppdateres hvert par sekund når Pulse-en er aktiv) og
regner selv ut kWh time for time ved å integrere effekt (W) over tid. Dette
lagres lokalt på Homey-enheten (kun inneværende måneds timer + én frossen
sum for forrige måned) — ikke fordi vi ønsket det slik opprinnelig, men fordi
det er den eneste kilden til forbrukstall Tibber faktisk gir oss for denne
kontoen.

**Konsekvens:** appen må kjøre (Homey på, appen aktiv) for at forbruk skal
telles. Nedetid (Homey-restart, tilkoblingsbrudd) gir tapte timer som ikke
kan hentes inn igjen i etterkant — det finnes ingen historikk å falle
tilbake på.

## Oppsett

1. Logg inn på [developer.tibber.com](https://developer.tibber.com) og
   generer et personlig API-token.
2. Installer appen på Homey Pro (se under) og legg til en **Strømkostnad**-enhet.
   Lim inn Tibber-tokenet.
3. Åpne enhetsinnstillingene og fyll inn:
   - **Spotpris** (huk av, standard) eller **Fastpris** (NOK/kWh)
   - **Påslag** på spotprisen, hvis strømleverandøren din tar det (øre/kWh)
   - **Fast månedsgebyr** fra strømleverandøren (NOK/måned)
   - **Elvia API-abonnementsnøkkel og målepunkt-ID** (valgfritt) — samme
     nøkkel som i [Elvia-Nett-appen](../homey-elvia-app). Helt uavhengig
     kobling; la feltene stå tomme for å utelate nettleie fra kostnaden.

## Kjøre / installere appen (utvikler)

```bash
npm install -g homey
cd homey-tibber-app
homey login
homey app run      # kjør appen live på din Homey for testing
# eller
homey app install  # installer appen permanent
```

`homey app run`/`install` kjører `npm install` for appens egne avhengigheter
(`graphql-ws`, `ws`) automatisk.

## Capabilities

- `measure_power` — gjeldende effekt akkurat nå (W), fra live-strømmen.
- `consumption_today` — forbruk i dag så langt (kWh).
- `consumption_current_month` / `cost_current_month` — forbruk/kostnad denne
  måneden så langt.
- `consumption_estimate_month` / `cost_estimate_month` — estimat for hele
  måneden.
- `consumption_previous_month` / `cost_previous_month` — frosset sum fra
  forrige måned.

## Hvordan kostnaden regnes ut

Hver fullførte time (integrert fra live effekt) multipliseres med den timens
pris (spotpris/fastpris + eventuell nettleie), summert for måneden så langt.
Inneværende, ikke-fullførte time telles også med (delvis integrert).
Faste gebyrer (månedsgebyr, fastledd) regnes forholdsmessig etter hvor langt
inn i måneden vi er.

**Estimatet for hele måneden** forlenger snittet av kostnad-per-time du har
hatt så langt, til resten av månedens timer, pluss fulle faste gebyrer for
hele måneden.

## Om pris-nøyaktigheten

Både spotpris og nettleiepris hentes som **dagens** døgnkurve (24 timer) og
brukes med riktig time-på-døgnet-sats for hver loggført time. Nettleie er
stabil gjennom en tariffsesong, så det er presist. Spotpris endrer seg
derimot hver dag, så eldre dager denne måneden (fra før akkurat den prisen
gjaldt) får en tilnærmet, ikke eksakt, spotpris — merket som «estimat» av en
grunn.

## Kjente begrensninger

- Krever et Tibber-abonnement/-konto med en aktiv Tibber Pulse med
  `realTimeConsumptionEnabled`.
- Forbruk telles kun mens appen kjører — ingen bakoverfylling ved nedetid.
- Bruker samme Elvia-nøkkel/målepunkt-ID som Elvia-Nett-appen, men er en
  helt separat kobling til Elvia sitt API.
- Appen er bygget for SDK3 og krever Homey Pro (ikke Homey Bridge).
- Denne websocket-baserte tilnærmingen er ny og uprøvd i praksis — forvent
  en runde eller to med feilsøking mot ekte Tibber-tilkobling, i likhet med
  Elvia-appens tidlige runder.
