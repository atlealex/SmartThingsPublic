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

Appen abonnerer derfor på Tibber sin **sanntidsstrøm** (`liveMeasurement`,
oppdateres hvert par sekund når Pulse-en er aktiv), som faktisk gir to
uavhengige kilder til forbrukstall:

- **`accumulatedConsumption`** — forbruk siden midnatt, regnet ut av selve
  Pulse-en (samme tall som Home Assistants "Akkumulert forbruk"-sensor).
  Dette er den **autoritative** kilden for "i dag"/"denne måneden": den
  fortsetter å telle selv om Homey/websocket-tilkoblingen vår er nede, og
  henter seg automatisk inn igjen ved neste tilkoblede måling. Et fall i
  verdien (tilbake mot 0) betyr at døgnet har snudd, og brukes til å
  oppdage månedsskifte.
- **`power`** (effekt, W) — vi integrerer selv time for time, kun for å gi
  forbruket en realistisk fordeling over døgnet (dag/natt) når kostnaden
  skal regnes ut med riktig timepris. Denne kan miste data ved
  tilkoblingsbrudd, men totalsummen skaleres alltid opp/ned til å matche
  `accumulatedConsumption` før kostnaden beregnes — så forbruks- og
  kostnadstallene stemmer alltid overens, selv om timefordelingen er
  upresis i en periode.

Kun ett tall lagres lokalt mellom omstarter: summen av tidligere fullførte
dager denne måneden (fra `accumulatedConsumption`), pluss én frossen sum for
forrige måned.

En dag regnes som fullført når `accumulatedConsumption` faller tilbake mot 0
(midnatt-nullstillingen). Et tilkoblingsbrudd/reconnect kan av og til gi en
forsinket/ute-av-rekkefølge måling med en lavere verdi enn forrige - uten at
det faktisk er midnatt. Før ble enhver nedgang tolket som "dagen er over",
noe som kunne telle en hel dags forbruk dobbelt (bekreftet live: «Forbruk -
denne måneden» viste 102,6 kWh på dag 2 i måneden, mot et forventet ca. 71
kWh ut fra Elvia/Tibber sine egne offisielle tall). Nå kreves det i tillegg
at den nye verdien faktisk er nær null - ikke bare lavere enn før - for at
det regnes som en reell midnatt-nullstilling (`lib/TibberLiveClient.js`,
`DAY_RESET_THRESHOLD_KWH`).

**Konsekvens:** appen må kjøre for at forbruk skal telles i utgangspunktet
(ingen historikk finnes hos Tibber for denne kontoen å hente inn i etterkant
hvis Homey har vært helt av/uten internett en periode), men kortere brudd
(opptil noen timer) fanges nå opp automatisk takket være
`accumulatedConsumption`.

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

**Effekt og forbruk**
- `measure_power` — gjeldende effekt akkurat nå (W), fra live-strømmen.
- `consumption_current_hour` — forbruk så langt i inneværende, ikke fullførte time (kWh).
- `consumption_previous_hour` — frosset forbruk for sist fullførte time (kWh),
  oppdateres idet timen ruller over (samme øyeblikk som
  `consumption_current_hour` nullstilles for den nye timen). Rått,
  ikke-etterjustert tall fra egen effekt-integrasjon - Tibber har ingen egen
  time-for-time-fasit å avstemme mot (kun et døgn-akkumulert tall), i
  motsetning til `consumption_yesterday`/`consumption_previous_month`.
- `consumption_today` — forbruk i dag så langt (kWh).
- `consumption_estimate_today` — estimert forbruk for hele dagen, basert på
  snittforbruk pr. time så langt i dag forlenget til resten av døgnet.
  De første timene av døgnet regnes snittet ut over minimum 4 timer (ikke
  faktisk forløpt tid), slik at en kortvarig forbrukstopp rett etter
  midnatt (f.eks. EV-lading, varmtvannsbereder) ikke ganges opp til et
  urealistisk høyt hele-døgnet-estimat. "Forløpt tid siden midnatt" regnes
  via `lib/localClock.js` (Homeys egen, konfigurerte tidssone), ikke
  Homey Pro sin OS-klokke - den kjører UTC uansett konfigurert tidssone,
  så et rått `new Date()`-regnestykke her ville regnet ut "midnatt" i UTC
  i stedet for lokal tid, og dermed overvurdert estimatet med selve
  UTC-forskjellen (f.eks. ~2 timer/~10 % i norsk sommertid - bekreftet med
  et reelt tilfelle: 38,15 kWh kl. 21:41 lokal tid ga 46,5 kWh i stedet for
  korrekte ~42,2 kWh).
- `consumption_yesterday` — frosset forbruk for i går (kWh), oppdateres ca.
  én time etter midnatt.
- `consumption_current_month` — forbruk denne måneden så langt.
- `consumption_estimate_month` — estimert forbruk for hele måneden.
- `consumption_previous_month` — frosset forbruk fra forrige måned.
- `consumption_year` — forbruk hittil i år (fullførte måneder + inneværende måned).

**Kostnad, totalt**
- `cost_today` — kostnad i dag (strøm + nettleie).
- `cost_current_month` — kostnad denne måneden så langt (strøm + nettleie +
  faste gebyrer, forholdsmessig).
- `cost_estimate_month` — estimert kostnad for hele måneden.
- `cost_previous_month` — frosset totalkostnad fra forrige måned.
- `cost_year` — totalkostnad hittil i år.

**Kostnad, splittet på strøm og nettleie**

Disse viser kun de variable, forbruksavhengige kostnadene (øre/kWh × kWh) —
faste gebyr og kapasitetsledd holdes utenfor og vises som egne tall under, i
tråd med hvordan referanseappen "Strømregning" viser det:
- `cost_energy_today` / `cost_grid_today` — strøm-/nettleiekostnad i dag.
- `cost_energy_yesterday` / `cost_grid_yesterday` — frosset strøm-/nettleiekostnad i går.
- `cost_energy_month` / `cost_grid_month` — strøm-/nettleiekostnad denne måneden så langt.
- `cost_energy_previous_month` / `cost_grid_previous_month` — frosset strøm-/nettleiekostnad forrige måned.

Alle de "så langt"-tallene over (`consumption_current_hour`, `consumption_today`,
`consumption_current_month`/`_estimate_month`, `cost_current_month`/`_estimate_month`,
`cost_energy_today`/`cost_grid_today`, `cost_energy_month`/`cost_grid_month`,
`consumption_year`/`cost_year`, `price_*_now`, `cost_rate_now`) er rene
utregninger over data vi allerede har lokalt (ingen nettverkskall), og
oppdateres derfor på samme 5-sekunders-rytme som `measure_power` — ikke bare
hvert 5. minutt. De frosne "i går"/"forrige måned"-tallene oppdateres først
når dagen/måneden faktisk ruller over, som forventet.

**Kapasitetsledd (fastledd)**
- `cost_capacity_month` — Elvias kapasitetsledd for måneden, hentet direkte
  fra Elvia sitt API (ikke forholdsmessig — dette er beløpet Elvia fakturerer
  for gjeldende effekttrinn).
- `capacity_level_info` — tekstbeskrivelse av gjeldende effekttrinn (f.eks. «2-5 kWh/h»).

Disse to oppdateres kun når Elvia-kallet i `_refreshPrices()` lykkes (ca. en
gang i timen). Feiler kallet (f.eks. Elvia nede, utgått nøkkel), beholdes
siste kjente verdi uendret og enheten får et **synlig varsel**
(enhetens advarselsikon) med feilmeldingen, i stedet for at det bare logges
stille i `homey app run`. Varselet forsvinner automatisk neste gang et
Elvia-kall lykkes. Bruk Flow-handlingen under for å tvinge et nytt forsøk med
en gang, f.eks. hvis Elvia har nullstilt effekttrinnet for en ny måned men
appen ennå ikke har hentet det inn.

**Priser og snitt**
- `price_energy_now` / `price_grid_now` / `price_total_now` — gjeldende times
  strømpris / nettleiepris / totalpris (NOK/kWh).
- `cost_rate_now` — gjeldende kostnad akkurat nå (kr/t), regnet ut som
  `measure_power` (kW) × totalpris (NOK/kWh). Oppdateres på samme raske,
  5-sekunders-taktede rytme som `measure_power`.
- `average_price_today` — snittpris i dag (strøm + nettleie, NOK/kWh).
- `average_price_month_excl_vat` — snittpris denne måneden, eks. mva (NOK/kWh).

## Forbruksapparat-bevisst kWh-estimat

`consumption_estimate_today`, `consumption_estimate_month` og
`cost_estimate_month` regnes ut med en mer nøyaktig metode enn en ren
"snitt hittil × resten av perioden"-fremskrivning: et fast sett med
"byktunge" apparater (vaskemaskin, tørketrommel, oppvaskmaskin, stekeovn)
holdes utenfor selve fremskrivningen:

1. Regn ut en "grunnlinje" = husets forbruk hittil minus de 4 apparatenes
   eget forbruk hittil.
2. Fremskriv KUN grunnlinjen lineært over resten av perioden (døgnet/måneden).
3. Legg apparatenes eget, faktiske (ikke fremskrevne) forbruk til på slutten.
4. `cost_estimate_month` bruker samme kr/kWh-snitt som er observert så
   langt denne måneden, ganget med det forbruksapparat-bevisste
   kWh-estimatet (i stedet for et time-for-time kostnadssnitt), pluss faste
   gebyrer for hele måneden.

Uten dette ville f.eks. en stekeovn som brukte 500 W i én time blitt
fremskrevet til 12 kWh for hele døgnet (500 W × 24 t), selv om den ikke
kommer til å stå på resten av dagen. Formelen ligger i
`lib/ApplianceAwareEstimate.js` (med enhetstester), og apparat-listen
(med device-ID-er for både deres live-effekt og deres Power by the
Hour-kWh) i `drivers/meter/device.js` (`EXCLUDED_APPLIANCES`).

Grunnlinjens forløpte tid telles fra midnatt, men selve kapabilitetene
oppdateres først fra kl. 05:00 - før det har for lite av døgnet gått til
at fremskrivningen er noe annet enn store, misvisende svingninger (før
kl. 05:00 vises i stedet den enkle projeksjonen). Oppdateringsintervallet
for selve apparat-uttrekket er en egen enhetsinnstilling
("Oppdateringsintervall (minutter)", standard 5 min) - resultatet caches i
minnet og skrives inn i disse kapabilitetene på samme raske rytme som
resten av tallene (se over), slik at det ikke lager et eget, separat sett
med tall.

Estimatet leses altså direkte av **Strømkostnad**-enheten selv - de to
Virtuelle Enhetene ("Estimert kWh idag" / "Estimert kWh denne måned") som
tidligere ble brukt til dette, brukes ikke lenger av appen. Vil du speile
tallet på en egen dashord-flis, bruk et "Statusindikatorfelt" i Virtuelle
Enheter-appen med "Reflekter: Enheter" satt til **Strømkostnad**-enheten
og ønsket egenskap (`Forbruksestimat - i dag`/`- denne måned` eller
`Estimert kostnad - denne måned`).

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

## Vedlikeholdshandling: «Reparer forbruk denne måneden»

Hvis `consumption_current_month`/`cost_current_month` ser for høye ut (f.eks.
på grunn av feilen beskrevet over, fra før v1.4.1), finnes det en
vedlikeholdshandling under enhetens **Innstillinger → Vedlikehold** som
nullstiller den løpende månedstotalen tilbake til kun sist fullførte dag.
Korrekt så lenge kun én dag faktisk har fullført denne måneden ennå (altså
tidlig i måneden); uansett et bedre utgangspunkt enn en kjent oppblåst
verdi. (Implementert som en `button`-capability flagget
`maintenanceAction: true` - SDK3-måten å lage denne typen knapp på; v1.4.1
brukte ved en feil den gamle SDK2-syntaksen og kunne ikke installeres.)

## Flow-kort

- **Action**: "Oppdater priser nå" — tvinger et umiddelbart forsøk på å
  hente spotpris og nettleie/kapasitetsledd fra Tibber/Elvia, uten å vente
  på den vanlige, timeplanlagte oppdateringen.

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
