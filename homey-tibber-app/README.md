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
   - **Inkluder nettleie** (huk av, standard) — henter nettleiepris og
     fastledd live fra [Elvia-Nett-appen](../homey-elvia-app), hvis den er
     installert og paret. Helt valgfritt; fungerer fint uten.

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

Nettleiepris varierer time for time (dag/natt), men Elvia-Nett-appen
eksponerer kun **gjeldende** nettleiepris som capability, ikke hele
døgnkurven historisk. Denne appen bruker derfor gjeldende kjente nettleiepris
som et rimelig anslag for alle timer denne måneden (nettleiesatsene endrer
seg normalt ikke i løpet av en måned, kun ved sesongskifte), fremfor å kreve
nøyaktig historisk nettleiepris time for time. Presist for strømdelen
(fra Tibber), tilnærmet for nettleiedelen — merket som «estimat» av en grunn.

## Kjente begrensninger

- Krever et Tibber-abonnement/-konto med en aktiv Tibber Pulse.
- Nettleie-integrasjonen leser Elvia-Nett-appens enhet på tvers av apper via
  Homeys enhets-API (`homey.devices`); dette er ikke fullt utprøvd ennå og
  kan trenge justering.
- Appen er bygget for SDK3 og krever Homey Pro (ikke Homey Bridge).
