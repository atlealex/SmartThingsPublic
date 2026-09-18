# Strømkostnad (Tibber) for Homey Pro

En Homey Pro-app som følger strømkostnaden din **denne måneden**, med et
estimat for hele måneden, basert på forbruksdata fra [Tibber](https://tibber.com)
(Tibber Pulse på HAN-porten).

## Hvorfor ingen lang historikk?

Appen lagrer ikke egen forbrukshistorikk — Tibber beholder allerede
timesforbruket ditt på sine servere, så appen henter bare "timer så langt
denne måneden" på nytt ved hver oppdatering. Det eneste som lagres lokalt er
ett tall: totalsummen fra **forrige måned**, som fryses automatisk når en ny
måned starter. Lenger tilbake enn det går appen ikke.

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
     nøkkel som i [Elvia-Nett-appen](../homey-elvia-app). Appen henter da
     nettleie direkte fra Elvia selv (ikke via Elvia-Nett-appen), så den
     kan brukes helt uavhengig av om Elvia-Nett er installert. La feltene
     stå tomme for å utelate nettleie fra kostnaden.

## Kjøre / installere appen (utvikler)

```bash
npm install -g homey
cd homey-tibber-app
homey login
homey app run      # kjør appen live på din Homey for testing
# eller
homey app install  # installer appen permanent
```

## Hvordan kostnaden regnes ut

For hver time så langt denne måneden: `forbruk (kWh) × (strømpris + nettleiepris)`,
summert, pluss faste gebyrer forholdsmessig etter hvor langt inn i måneden vi er
(månedsgebyr og fastledd regnes time for time).

**Estimatet for hele måneden** forlenger snittet av kostnad-per-time du har
hatt så langt, til resten av månedens timer, pluss fulle faste gebyrer for
hele måneden. Det er altså en enkel fremskrivning basert på ditt eget snitt-
forbruk hittil — ikke en værmelding-aktig prognose med sesongjustering.

## Om nettleie-delen

Appen henter Elvia sin **hele døgnkurve** for nettleiepris i dag (24 timer,
time for time), og bruker riktig time-på-døgnet-pris for hver time så langt
denne måneden — ikke bare én flat gjennomsnittspris. Siden nettleiesatsene
(dag/natt) normalt ikke endrer seg i løpet av en måned (kun ved
sesongskifte), er dette presist for de fleste dager. Én gjenstående
unøyaktighet: dagens kurve gjenspeiler dagens ukedagstype, så helgedager
tidligere i måneden får samme dag/natt-mønster som en vanlig ukedag, selv om
Elvia noen steder skiller helg fra hverdag. Fastledd (nettleiens faste
månedsbeløp) regnes time for time med gjeldende sats, som er stabil gjennom
måneden.

## Kjente begrensninger

- Krever et Tibber-abonnement/-konto med en aktiv Tibber Pulse.
- Bruker samme Elvia-nøkkel/målepunkt-ID som Elvia-Nett-appen, men er en
  helt separat kobling til Elvia sitt API — fungerer uavhengig av om
  Elvia-Nett er installert.
- Appen er bygget for SDK3 og krever Homey Pro (ikke Homey Bridge).
