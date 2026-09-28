'use strict';

const Homey = require('homey');
const TibberApi = require('../../lib/TibberApi');
const TibberLiveClient = require('../../lib/TibberLiveClient');
const ElviaGridTariff = require('../../lib/ElviaGridTariff');
const { computeMonthCost, splitEnergyAndGridCost, reconcile } = require('../../lib/CostCalculator');
const { zoneNow, monthBoundsMs } = require('../../lib/localClock');
const { estimatePeriodKwh } = require('../../lib/ApplianceAwareEstimate');

const CAPABILITY_UPDATE_INTERVAL_MINUTES = 5;

// The 4 "bursty" appliances excluded from the appliance-aware estimate's
// extrapolation baseline (see _updateApplianceAwareEstimates): their own
// already-known usage is added back afterwards instead of being
// extrapolated, so e.g. the oven running hot for one hour doesn't get
// multiplied into a wildly inflated whole-day/month estimate. powerDeviceId
// is the appliance's own live-power smart plug/reading; meterDeviceId is
// its Power by the Hour companion (tracks its own kWh today/this month).
const EXCLUDED_APPLIANCES = [
  { name: 'LG Vaskemaskin', powerDeviceId: '0c8bf734-8796-4aee-83f4-5fb3d1a15b24', meterDeviceId: 'c6eb0e43-d311-4a85-98ad-b2d2fab964db' },
  { name: 'Oppvaskmaskin', powerDeviceId: '37316697-0702-4b7d-9525-250df55441b1', meterDeviceId: '7849a35a-c11b-4723-aa22-28c7077507f4' },
  { name: 'LG Tørketrommel', powerDeviceId: 'c3793078-008e-4a33-ac9a-457b8b3dcd7e', meterDeviceId: 'b727fc2a-1593-45f3-9859-468f6977985f' },
  { name: 'Stekeovn', powerDeviceId: 'dbff9ec6-0859-47c3-99be-388f50c5f529', meterDeviceId: '468e6005-9020-4e35-9b9b-b14080c91140' },
];

// "Virtuelle Enheter" (Virtual Devices) tiles the appliance-aware estimate is written to.
const ESTIMATE_TODAY_TARGET = { deviceId: 'dbeb5f34-bc4e-48ce-bd1d-959321ffec2d', capabilityId: 'devicecapabilities_number.number1' };
const ESTIMATE_MONTH_TARGET = { deviceId: '37849711-c450-41ec-beb6-336cba4caa49', capabilityId: 'devicecapabilities_number.number1' };

// The elapsed-hours basis for both estimates is still counted from
// midnight (an appliance running at 04:50 should count), but the tiles
// aren't updated until this local hour - before that, too little of the
// day has elapsed for the extrapolation to be anything but a wild swing.
const ESTIMATE_DISPLAY_START_HOUR = 5;
const DEFAULT_ESTIMATE_INTERVAL_MINUTES = 5;
const MIN_ESTIMATE_INTERVAL_MINUTES = 1;

const CURRENT_CAPABILITIES = [
  'measure_power',
  'consumption_current_hour',
  'consumption_today',
  'consumption_estimate_today',
  'consumption_yesterday',
  'consumption_current_month',
  'consumption_estimate_month',
  'consumption_previous_month',
  'consumption_year',
  'cost_current_month',
  'cost_estimate_month',
  'cost_previous_month',
  'cost_year',
  'cost_today',
  'cost_energy_today',
  'cost_grid_today',
  'cost_energy_yesterday',
  'cost_grid_yesterday',
  'cost_energy_month',
  'cost_grid_month',
  'cost_energy_previous_month',
  'cost_grid_previous_month',
  'cost_capacity_month',
  'capacity_level_info',
  'price_energy_now',
  'price_grid_now',
  'price_total_now',
  'cost_rate_now',
  'average_price_today',
  'average_price_month_excl_vat',
];

class StromkostnadDevice extends Homey.Device {
  async onInit() {
    this.log('Strømkostnad device initialized:', this.getName());

    await this._migrateCapabilities();
    await this._healTrackingStartedAt();
    this._priceCache = { spotPriceByHour: new Map(), gridRent: null, capacityChargeMonth: null, capacityLevelInfo: null };
    this._initApiClient();
    await this._ensureHomeId();
    await this._refreshPrices();
    this._scheduleHourlyAlignedPriceRefresh();
    this._scheduleCapabilityUpdates();
    this._scheduleApplianceEstimateUpdates();
    await this._startLiveClient();
  }

  async _migrateCapabilities() {
    for (const capabilityId of this.getCapabilities()) {
      if (!CURRENT_CAPABILITIES.includes(capabilityId)) {
        await this.removeCapability(capabilityId).catch((err) => this.error(`Failed to remove ${capabilityId}:`, err.message));
      }
    }
    for (const capabilityId of CURRENT_CAPABILITIES) {
      if (!this.hasCapability(capabilityId)) {
        await this.addCapability(capabilityId).catch((err) => this.error(`Failed to add ${capabilityId}:`, err.message));
      }
    }
  }

  /**
   * trackingStartedAt exists to prorate fixed fees (and the simple
   * consumption_estimate_month projection's hours-elapsed denominator) for
   * a device that was only just installed partway through a month - not to
   * be reset every time the app itself restarts/reinstalls. The old
   * migration below stamped "now" unconditionally whenever it was missing,
   * which wrongly reset it on an already-running device too (e.g. after an
   * app update), leaving monthDaysTotal covering the whole month while the
   * "hours tracked" denominator only covered the few days since that
   * reset - inflating consumption_estimate_month by roughly (days in month
   * so far / days since the reset).
   *
   * A missing trackingStartedAt is only genuinely "just installed now" if
   * there's no consumption recorded for this month yet; if monthDaysTotal
   * already has data, tracking clearly started at or before the start of
   * the month, not whenever this happens to run.
   */
  async _healTrackingStartedAt() {
    const currentMonthKey = this.getStoreValue('currentMonthKey');
    if (!currentMonthKey) return;

    const trackingStartedAt = this.getStoreValue('trackingStartedAt');
    const monthDaysTotal = this.getStoreValue('monthDaysTotal') || 0;
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const hasExistingData = monthDaysTotal > 0;

    if (!trackingStartedAt) {
      const value = hasExistingData ? startOfMonth : new Date();
      await this.setStoreValue('trackingStartedAt', value.toISOString());
      return;
    }

    if (hasExistingData && new Date(trackingStartedAt) > startOfMonth) {
      this.log(`Correcting a stale trackingStartedAt (${trackingStartedAt}) back to the start of the month - monthDaysTotal already has ${monthDaysTotal.toFixed(1)} kWh recorded, so tracking must have started earlier than that.`);
      await this.setStoreValue('trackingStartedAt', startOfMonth.toISOString());
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('tibberToken')) {
      this._initApiClient(newSettings);
      await this._ensureHomeId();
      await this._startLiveClient();
    }
    if (changedKeys.includes('elviaSubscriptionKey') || changedKeys.includes('elviaMeteringPointId')) {
      this._initApiClient(newSettings);
      await this._refreshPrices();
    }
    if (changedKeys.includes('estimateIntervalMinutes')) {
      this._scheduleApplianceEstimateUpdates(newSettings);
    }
  }

  async onDeleted() {
    if (this._priceTimer) this.homey.clearTimeout(this._priceTimer);
    if (this._capabilityTimer) this.homey.clearInterval(this._capabilityTimer);
    if (this._estimateTimer) this.homey.clearInterval(this._estimateTimer);
    if (this._liveClient) this._liveClient.stop();
  }

  _initApiClient(settings = this.getSettings()) {
    this.api = new TibberApi({ token: settings.tibberToken });
    this.elviaApi = new ElviaGridTariff({ subscriptionKey: settings.elviaSubscriptionKey });
  }

  async _ensureHomeId() {
    if (this.getStoreValue('homeId')) return;
    try {
      const home = await this.api.getFirstHomeId();
      await this.setStoreValue('homeId', home.id);
    } catch (err) {
      this.error('Failed to look up Tibber home:', err.message);
    }
  }

  async _startLiveClient() {
    if (this._liveClient) this._liveClient.stop();

    const homeId = this.getStoreValue('homeId');
    const settings = this.getSettings();
    if (!homeId || !settings.tibberToken) return;

    this._liveClient = new TibberLiveClient({
      token: settings.tibberToken,
      homeId,
      onHourComplete: (hour) => this._handleHourComplete(hour).catch((err) => this.error('Failed to handle completed hour:', err.message)),
      onDayComplete: (kwh) => this._handleDayComplete(kwh).catch((err) => this.error('Failed to handle completed day:', err.message)),
      onPower: (power) => this._handlePower(power),
      onLog: (msg) => this.log(msg),
      onError: (msg) => this.error(msg),
    });

    try {
      await this._liveClient.start();
    } catch (err) {
      this.error('Failed to start Tibber live connection:', err.message);
    }
  }

  /**
   * Tibber pushes a reading roughly every 2s - throttle capability writes to
   * avoid hammering Homey. consumption_today/consumption_current_hour are
   * updated on this same fast cadence (not just the 5-minute
   * _updateCapabilities cycle) since they're just reading an already-known
   * value with no network call involved, and the user wants them to track
   * as closely as the official Tibber app does.
   */
  /**
   * Tibber pushes a reading roughly every 2s - throttle to avoid hammering
   * Homey. Every figure this device shows other than the Elvia capacity
   * charge/level is a pure computation over already-known local data (no
   * network call), so it's cheap to recompute the whole set on this same
   * fast cadence instead of leaving most of it to the 5-minute
   * _updateCapabilities timer - that's what caused cost_*_today and
   * cost_*_month to visibly lag behind measure_power by minutes.
   */
  _handlePower(power) {
    const now = Date.now();
    if (this._lastPowerUpdate && now - this._lastPowerUpdate < 5000) return;
    this._lastPowerUpdate = now;
    this._setCapabilitySafely('measure_power', power).catch(() => {});
    this._updateCapabilities(power).catch((err) => this.error('Failed to update capabilities:', err.message));
  }

  /** Recomputes and writes cost_energy_today/cost_grid_today/average_price_today. */
  async _updateTodaySplitCapabilities() {
    const monthHours = this.getStoreValue('monthHours') || [];
    const partialHourKwh = this._liveClient ? this._liveClient.getCurrentPartialHourKwh() : 0;
    const todayAccumulated = this._liveClient ? this._liveClient.getTodayAccumulated() : null;
    const todayHours = monthHours.filter((h) => h.startedAt.startsWith(this._todayKey()));
    const todaySplit = this._computeSplit(todayHours, partialHourKwh, typeof todayAccumulated === 'number' ? todayAccumulated : undefined);

    await this._setCapabilitySafely('cost_energy_today', todaySplit.energyCost);
    await this._setCapabilitySafely('cost_grid_today', todaySplit.gridCost);
    await this._setCapabilitySafely('cost_today', todaySplit.energyCost + todaySplit.gridCost);
    const avgToday = todaySplit.kwh > 0.001 ? (todaySplit.energyCost + todaySplit.gridCost) / todaySplit.kwh : 0;
    await this._setCapabilitySafely('average_price_today', avgToday);
  }

  /** Current hour's energy + grid rent price (NOK/kWh), used for the price_*_now sensors and the live cost-rate gauge. */
  _currentPrices() {
    const settings = this.getSettings();
    const hourOfDay = new Date().getHours();
    const spotFallback = this._averageOfMap(this._priceCache.spotPriceByHour);
    const energy = settings.useSpotPrice
      ? (this._priceCache.spotPriceByHour.get(hourOfDay) ?? spotFallback) + (Number(settings.markupOre) || 0) / 100
      : Number(settings.fixedPrice) || 0;
    const gridFallback = this._priceCache.gridRent ? this._averageOfMap(this._priceCache.gridRent.priceByHour) : 0;
    const grid = this._priceCache.gridRent
      ? (this._priceCache.gridRent.priceByHour.get(hourOfDay) ?? gridFallback)
      : 0;
    return { energy, grid, total: energy + grid };
  }

  /**
   * Called when Tibber's own daily accumulator resets at local midnight,
   * with the finalized total for the day that just ended. This is the
   * authoritative kWh source (immune to our own connection gaps) - see
   * _updateCapabilities/_computeSplit for how it's combined with the hourly
   * power integration. The energy/grid cost split for the day is filed
   * later, once the outgoing day's last hour has actually been pushed into
   * monthHours (see _handleHourComplete) - lastCompletedDayKwh is the
   * authoritative total that split gets reconciled against.
   */
  async _handleDayComplete(dayTotalKwh) {
    const monthDaysTotal = (this.getStoreValue('monthDaysTotal') || 0) + dayTotalKwh;
    await this.setStoreValue('monthDaysTotal', monthDaysTotal);
    await this.setStoreValue('lastCompletedDayKwh', dayTotalKwh);
    this.log(`Day complete: ${dayTotalKwh.toFixed(3)} kWh (month total so far: ${monthDaysTotal.toFixed(3)} kWh)`);
  }

  /** Called once an hour's worth of live power readings has been integrated into kWh. */
  async _handleHourComplete(hour) {
    const hourDayKey = hour.startedAt.slice(0, 10); // "YYYY-MM-DD"
    const hourMonthKey = hour.startedAt.slice(0, 7); // "YYYY-MM"

    // Checked first, deliberately, mirroring TibberLiveClient's own
    // day-before-month ordering: on the last day of a month, monthHours is
    // about to be cleared by _handleMonthRollover below, so the outgoing
    // day's split must be filed from monthHours as it stands right now.
    const currentDayKey = this.getStoreValue('currentDayKey');
    if (currentDayKey && currentDayKey !== hourDayKey) {
      const monthHoursBeforeRollover = this.getStoreValue('monthHours') || [];
      await this._handleDayRollover(currentDayKey, monthHoursBeforeRollover);
    }
    await this.setStoreValue('currentDayKey', hourDayKey);

    await this._handleMonthRollover(hourMonthKey);

    const monthHours = this.getStoreValue('monthHours') || [];
    monthHours.push(hour);
    await this.setStoreValue('monthHours', monthHours);

    this.log(`Hour complete: ${hour.startedAt} = ${hour.kwh.toFixed(3)} kWh`);
    await this._updateCapabilities();
  }

  /** When a new day starts, freeze the completed day's energy/grid cost split. */
  async _handleDayRollover(outgoingDayKey, monthHoursSnapshot) {
    const dayHours = monthHoursSnapshot.filter((h) => h.startedAt.startsWith(outgoingDayKey));
    const accurateKwh = this.getStoreValue('lastCompletedDayKwh');
    const split = this._computeSplit(dayHours, 0, typeof accurateKwh === 'number' ? accurateKwh : undefined);

    await this._setCapabilitySafely('consumption_yesterday', split.kwh);
    await this._setCapabilitySafely('cost_energy_yesterday', split.energyCost);
    await this._setCapabilitySafely('cost_grid_yesterday', split.gridCost);
    this.log(`Day rolled over (${outgoingDayKey}): ${split.kwh.toFixed(2)} kWh, energy ${split.energyCost.toFixed(2)} / grid ${split.gridCost.toFixed(2)} NOK`);
  }

  /** When a new month starts, freeze the completed month's totals before clearing. */
  async _handleMonthRollover(newMonthKey) {
    const currentMonthKey = this.getStoreValue('currentMonthKey');
    if (!currentMonthKey) {
      await this.setStoreValue('currentMonthKey', newMonthKey);
      await this.setStoreValue('trackingStartedAt', new Date().toISOString());
      return;
    }
    if (currentMonthKey === newMonthKey) return;

    const monthHours = this.getStoreValue('monthHours') || [];
    // monthDaysTotal is the authoritative figure (Tibber's own daily
    // accumulator) - by the time this runs, onDayComplete has already
    // folded in the outgoing month's last day (see the comment in
    // TibberLiveClient._handleReading about check ordering at midnight).
    // Fall back to the hourly integration only if it's somehow unset.
    const monthDaysTotal = this.getStoreValue('monthDaysTotal');
    const consumptionKwh = typeof monthDaysTotal === 'number' ? monthDaysTotal : monthHours.reduce((sum, h) => sum + h.kwh, 0);
    const result = this._computeCost(monthHours, 0, consumptionKwh);
    const split = this._computeSplit(monthHours, 0, consumptionKwh);

    await this._setCapabilitySafely('cost_previous_month', result.cost);
    await this._setCapabilitySafely('consumption_previous_month', consumptionKwh);
    await this._setCapabilitySafely('cost_energy_previous_month', split.energyCost);
    await this._setCapabilitySafely('cost_grid_previous_month', split.gridCost);
    this.log(`Month rolled over from ${currentMonthKey} to ${newMonthKey}, archived: ${consumptionKwh.toFixed(1)} kWh / ${result.cost.toFixed(2)} NOK`);

    await this._updateYearAccumulation(currentMonthKey, consumptionKwh, result.cost);

    await this.setStoreValue('monthHours', []);
    await this.setStoreValue('monthDaysTotal', 0);
    await this.setStoreValue('currentMonthKey', newMonthKey);
    await this.setStoreValue('trackingStartedAt', new Date().toISOString());
  }

  /** Rolls a just-completed month's totals into the running "this year" sums, resetting them on Jan 1st. */
  async _updateYearAccumulation(completedMonthKey, consumptionKwh, cost) {
    const monthYearKey = completedMonthKey.slice(0, 4);
    const storedYearKey = this.getStoreValue('yearKey');
    let yearConsumptionKwh = storedYearKey === monthYearKey ? (this.getStoreValue('yearConsumptionKwh') || 0) : 0;
    let yearCost = storedYearKey === monthYearKey ? (this.getStoreValue('yearCost') || 0) : 0;

    yearConsumptionKwh += consumptionKwh;
    yearCost += cost;

    await this.setStoreValue('yearKey', monthYearKey);
    await this.setStoreValue('yearConsumptionKwh', yearConsumptionKwh);
    await this.setStoreValue('yearCost', yearCost);
  }

  _scheduleCapabilityUpdates() {
    if (this._capabilityTimer) this.homey.clearInterval(this._capabilityTimer);
    this._capabilityTimer = this.homey.setInterval(() => {
      this._updateCapabilities().catch((err) => this.error('Failed to update capabilities:', err.message));
    }, CAPABILITY_UPDATE_INTERVAL_MINUTES * 60 * 1000);
  }

  _scheduleApplianceEstimateUpdates(settingsOverride) {
    if (this._estimateTimer) this.homey.clearInterval(this._estimateTimer);
    const settings = settingsOverride || this.getSettings();
    const minutes = Math.max(MIN_ESTIMATE_INTERVAL_MINUTES, Number(settings.estimateIntervalMinutes) || DEFAULT_ESTIMATE_INTERVAL_MINUTES);
    this._estimateTimer = this.homey.setInterval(() => {
      this._updateApplianceAwareEstimates().catch((err) => this.error('Failed to update appliance-aware estimates:', err.message));
    }, minutes * 60 * 1000);
  }

  /** Sum of one capability across the excluded appliances, from a single already-fetched devices snapshot. */
  _sumApplianceCapability(devices, deviceKey, capabilityId) {
    return EXCLUDED_APPLIANCES.reduce((sum, appliance) => {
      const device = devices[appliance[deviceKey]];
      const capability = device && device.capabilitiesObj && device.capabilitiesObj[capabilityId];
      return sum + (typeof capability?.value === 'number' ? capability.value : 0);
    }, 0);
  }

  /**
   * Recomputes the appliance-aware "Estimert kWh" tiles (see
   * lib/ApplianceAwareEstimate.js for the formula) and writes them to the
   * two Virtual Devices set up for this. Both the elapsed-time basis and
   * the tiles' own display are timezone-aware (lib/localClock.js) - Homey
   * Pro's OS clock runs UTC regardless of the configured timezone, and this
   * calculation is exactly the kind of thing that silently breaks if that's
   * not accounted for (see the Wake Clock app's own alarm-timing bug for
   * what that looks like in practice).
   */
  async _updateApplianceAwareEstimates() {
    if (!this.homey.app.homeyApi) return;

    let timeZone;
    try {
      timeZone = this.homey.clock.getTimezone();
    } catch (err) {
      timeZone = undefined;
    }
    const zone = zoneNow(timeZone);

    // Elapsed-hours basis counts from midnight even though the tiles
    // themselves only start updating at ESTIMATE_DISPLAY_START_HOUR (see
    // below) - an appliance run at 04:50 should still count.
    if (zone.hour < ESTIMATE_DISPLAY_START_HOUR) return;

    const devices = await this.homey.app.homeyApi.devices.getDevices();
    const applianceKwhToday = this._sumApplianceCapability(devices, 'meterDeviceId', 'meter_kwh_this_day');
    const applianceKwhMonth = this._sumApplianceCapability(devices, 'meterDeviceId', 'meter_kwh_this_month');

    const houseConsumptionToday = this.getCapabilityValue('consumption_today') || 0;
    const houseConsumptionMonth = this.getCapabilityValue('consumption_current_month') || 0;

    const elapsedHoursToday = (zone.nowMs - zone.midnightMs) / (60 * 60 * 1000);
    const { startMs: monthStartMs, daysInMonth } = monthBoundsMs(timeZone, zone.year, zone.month);
    const elapsedHoursMonth = (zone.nowMs - monthStartMs) / (60 * 60 * 1000);

    const estimateToday = estimatePeriodKwh({
      houseConsumptionSoFarKwh: houseConsumptionToday,
      applianceConsumptionSoFarKwh: applianceKwhToday,
      elapsedHours: elapsedHoursToday,
      periodHours: 24,
    });
    const estimateMonth = estimatePeriodKwh({
      houseConsumptionSoFarKwh: houseConsumptionMonth,
      applianceConsumptionSoFarKwh: applianceKwhMonth,
      elapsedHours: elapsedHoursMonth,
      periodHours: daysInMonth * 24,
    });

    await this.homey.app.homeyApi.devices.setCapabilityValue({
      deviceId: ESTIMATE_TODAY_TARGET.deviceId,
      capabilityId: ESTIMATE_TODAY_TARGET.capabilityId,
      value: Math.round(estimateToday * 100) / 100,
    }).catch((err) => this.error('Failed to write Estimert kWh idag:', err.message));

    await this.homey.app.homeyApi.devices.setCapabilityValue({
      deviceId: ESTIMATE_MONTH_TARGET.deviceId,
      capabilityId: ESTIMATE_MONTH_TARGET.capabilityId,
      value: Math.round(estimateMonth * 100) / 100,
    }).catch((err) => this.error('Failed to write Estimert kWh denne måned:', err.message));
  }

  /** Grid rent and spot price only need refreshing about once an hour. */
  _scheduleHourlyAlignedPriceRefresh() {
    if (this._priceTimer) this.homey.clearTimeout(this._priceTimer);
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setHours(now.getHours() + 1, 0, 10, 0);
    const delay = nextHour.getTime() - now.getTime();

    this._priceTimer = this.homey.setTimeout(() => {
      this._refreshPrices()
        .then(() => this._updateCapabilities())
        .catch((err) => this.error('Price refresh failed:', err.message))
        .finally(() => this._scheduleHourlyAlignedPriceRefresh());
    }, delay);
  }

  async _refreshPrices() {
    const homeId = this.getStoreValue('homeId');
    const settings = this.getSettings();

    if (settings.useSpotPrice && homeId) {
      this._priceCache.spotPriceByHour = await this.api.getTodaysSpotPriceByHour(homeId).catch((err) => {
        this.error('Could not fetch spot price:', err.message);
        return new Map();
      });
    }

    if (settings.elviaSubscriptionKey && settings.elviaMeteringPointId) {
      try {
        const collection = await this.elviaApi.getTodaysGridTariff(settings.elviaMeteringPointId);
        this._priceCache.gridRent = {
          priceByHour: this.elviaApi.extractHourlyEnergyPriceByHour(collection),
          fixedPerHour: this.elviaApi.extractFixedPriceHourly(collection),
        };
        this._priceCache.capacityChargeMonth = this.elviaApi.extractFixedPriceMonthly(collection);
        this._priceCache.capacityLevelInfo = this.elviaApi.extractFixedPriceLevelInfo(collection);
      } catch (err) {
        this.error('Could not fetch grid rent from Elvia:', err.message);
        this._priceCache.gridRent = null;
        this._priceCache.capacityChargeMonth = null;
        this._priceCache.capacityLevelInfo = null;
      }
    } else {
      this._priceCache.gridRent = null;
      this._priceCache.capacityChargeMonth = null;
      this._priceCache.capacityLevelInfo = null;
    }
  }

  /** Turns completed hours (+ an optional partial current hour) into {from, consumption} nodes for CostCalculator. */
  _buildRawNodes(hours, partialHourKwh) {
    const nodes = hours.map((h) => ({ from: `${h.startedAt}:00:00`, consumption: h.kwh }));
    if (partialHourKwh > 0) nodes.push({ from: new Date().toISOString(), consumption: partialHourKwh });
    return nodes;
  }

  /**
   * @param {Array} monthHours completed hours from our own power integration
   * @param {number} partialHourKwh current, not-yet-complete hour
   * @param {number} [accurateTotalKwh] if given (from Tibber's own daily
   *   accumulator, which is authoritative), the hourly-integration nodes
   *   are scaled proportionally to sum to exactly this - keeping the
   *   hour-of-day price shape from our own integration while correcting
   *   its absolute total, e.g. for periods where a connection gap made
   *   our own integration undercount.
   */
  _computeCost(monthHours, partialHourKwh, accurateTotalKwh) {
    const settings = this.getSettings();
    const now = new Date();

    const consumptionNodes = this._buildRawNodes(monthHours, partialHourKwh);

    if (typeof accurateTotalKwh === 'number') {
      const integratedTotal = consumptionNodes.reduce((sum, n) => sum + n.consumption, 0);
      if (integratedTotal > 0.001) {
        const scale = accurateTotalKwh / integratedTotal;
        for (const node of consumptionNodes) node.consumption *= scale;
      } else if (accurateTotalKwh > 0) {
        // No hourly shape to work with yet - fall back to a single node at
        // the current hour's price rather than losing the consumption entirely.
        consumptionNodes.push({ from: now.toISOString(), consumption: accurateTotalKwh });
      }
    }

    return computeMonthCost({
      consumptionNodes,
      priceMode: settings.useSpotPrice ? 'spot' : 'fixed',
      fixedPrice: Number(settings.fixedPrice) || 0,
      markupNokPerKwh: (Number(settings.markupOre) || 0) / 100,
      spotPriceByHour: this._priceCache.spotPriceByHour,
      monthlyFee: Number(settings.monthlyFee) || 0,
      includeGridRent: Boolean(this._priceCache.gridRent),
      gridRentPriceByHour: this._priceCache.gridRent?.priceByHour || new Map(),
      gridRentFixedPerHour: this._priceCache.gridRent?.fixedPerHour || 0,
      now,
      trackingStartedAt: this.getStoreValue('trackingStartedAt') ? new Date(this.getStoreValue('trackingStartedAt')) : null,
    });
  }

  /**
   * Energy/grid (nettleie) cost split for an arbitrary set of hours - used
   * for today/yesterday/this-month/previous-month breakdowns. Deliberately
   * excludes fixed fees (monthly fee, kapasitetsledd/fastledd), which are
   * shown as their own separate figures, matching the reference app.
   *
   * @param {number} [accurateTotalKwh] authoritative kWh total to reconcile
   *   against (see CostCalculator.reconcile) when available.
   */
  _computeSplit(hours, partialHourKwh, accurateTotalKwh) {
    const settings = this.getSettings();
    const nodes = this._buildRawNodes(hours, partialHourKwh);
    if (nodes.length === 0 && typeof accurateTotalKwh === 'number' && accurateTotalKwh > 0) {
      nodes.push({ from: new Date().toISOString(), consumption: accurateTotalKwh });
    }

    const result = splitEnergyAndGridCost(nodes, {
      priceMode: settings.useSpotPrice ? 'spot' : 'fixed',
      fixedPrice: Number(settings.fixedPrice) || 0,
      markupNokPerKwh: (Number(settings.markupOre) || 0) / 100,
      spotPriceByHour: this._priceCache.spotPriceByHour,
      includeGridRent: Boolean(this._priceCache.gridRent),
      gridRentPriceByHour: this._priceCache.gridRent?.priceByHour || new Map(),
    });

    return reconcile(result, accurateTotalKwh);
  }

  _averageOfMap(map) {
    if (!map || map.size === 0) return 0;
    return [...map.values()].reduce((a, b) => a + b, 0) / map.size;
  }

  _todayKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  async _setCapabilitySafely(capabilityId, value) {
    if (typeof value !== 'number' || Number.isNaN(value)) return;
    await this.setCapabilityValue(capabilityId, value).catch((err) => {
      this.error(`Failed to set ${capabilityId}:`, err.message);
    });
  }

  async _setCapabilityStringSafely(capabilityId, value) {
    if (typeof value !== 'string' || !value) return;
    await this.setCapabilityValue(capabilityId, value).catch((err) => {
      this.error(`Failed to set ${capabilityId}:`, err.message);
    });
  }

  /** @param {number} [livePowerOverride] current W reading, when called synchronously from _handlePower (avoids depending on setCapabilityValue's cache having already landed). */
  async _updateCapabilities(livePowerOverride) {
    try {
      const monthHours = this.getStoreValue('monthHours') || [];
      const partialHourKwh = this._liveClient ? this._liveClient.getCurrentPartialHourKwh() : 0;
      const todayAccumulated = this._liveClient ? this._liveClient.getTodayAccumulated() : null;
      const monthDaysTotal = this.getStoreValue('monthDaysTotal') || 0;
      const todayKey = this._todayKey();

      // Prefer Tibber's own daily accumulator (authoritative, gap-immune)
      // over our hourly power integration, once we've received at least
      // one reading with it.
      const todayKwh = typeof todayAccumulated === 'number'
        ? todayAccumulated
        : monthHours
          .filter((h) => h.startedAt.startsWith(todayKey))
          .reduce((sum, h) => sum + h.kwh, 0) + partialHourKwh;

      const consumptionSoFar = typeof todayAccumulated === 'number'
        ? monthDaysTotal + todayAccumulated
        : monthHours.reduce((sum, h) => sum + h.kwh, 0) + partialHourKwh;

      // Simple projection: extend today's average kWh/hour so far to the
      // remaining hours of the day, same approach as consumption_estimate_month.
      // Floored at 4 hours (not just >0) so a short early-morning burst -
      // an EV charge, a water heater cycle - doesn't get divided by a tiny
      // elapsed time and multiplied into a wildly inflated whole-day figure.
      const now = new Date();
      const hoursElapsedToday = Math.max(4, (now - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / (60 * 60 * 1000));
      const estimatedTodayKwh = (todayKwh / hoursElapsedToday) * 24;

      const accurateMonthKwh = typeof todayAccumulated === 'number' ? consumptionSoFar : undefined;
      const result = this._computeCost(monthHours, partialHourKwh, accurateMonthKwh);
      const monthSplit = this._computeSplit(monthHours, partialHourKwh, accurateMonthKwh);

      await this._setCapabilitySafely('consumption_current_hour', partialHourKwh);
      await this._setCapabilitySafely('consumption_today', todayKwh);
      await this._setCapabilitySafely('consumption_estimate_today', estimatedTodayKwh);
      await this._setCapabilitySafely('consumption_current_month', consumptionSoFar);
      await this._setCapabilitySafely('consumption_estimate_month', result.estimatedConsumptionKwh);
      await this._setCapabilitySafely('cost_current_month', result.cost);
      await this._setCapabilitySafely('cost_estimate_month', result.estimatedCost);
      await this._setCapabilitySafely('cost_energy_month', monthSplit.energyCost);
      await this._setCapabilitySafely('cost_grid_month', monthSplit.gridCost);
      await this._updateTodaySplitCapabilities();

      const avgMonthInclVat = monthSplit.kwh > 0.001 ? (monthSplit.energyCost + monthSplit.gridCost) / monthSplit.kwh : 0;
      await this._setCapabilitySafely('average_price_month_excl_vat', avgMonthInclVat / 1.25);

      const yearConsumptionKwh = this.getStoreValue('yearConsumptionKwh') || 0;
      const yearCost = this.getStoreValue('yearCost') || 0;
      await this._setCapabilitySafely('consumption_year', yearConsumptionKwh + consumptionSoFar);
      await this._setCapabilitySafely('cost_year', yearCost + result.cost);

      if (typeof this._priceCache.capacityChargeMonth === 'number') {
        await this._setCapabilitySafely('cost_capacity_month', this._priceCache.capacityChargeMonth);
      }
      if (typeof this._priceCache.capacityLevelInfo === 'string') {
        await this._setCapabilityStringSafely('capacity_level_info', this._priceCache.capacityLevelInfo);
      }

      const prices = this._currentPrices();
      await this._setCapabilitySafely('price_energy_now', prices.energy);
      await this._setCapabilitySafely('price_grid_now', prices.grid);
      await this._setCapabilitySafely('price_total_now', prices.total);

      const currentPower = typeof livePowerOverride === 'number' ? livePowerOverride : this.getCapabilityValue('measure_power');
      if (typeof currentPower === 'number') {
        await this._setCapabilitySafely('cost_rate_now', (currentPower / 1000) * prices.total);
      }

      await this.setAvailable();
    } catch (err) {
      this.error('Failed to update capabilities:', err.message);
      await this.setUnavailable(err.message).catch(() => {});
    }
  }
}

module.exports = StromkostnadDevice;
