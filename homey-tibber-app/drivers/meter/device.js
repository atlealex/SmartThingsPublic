'use strict';

const Homey = require('homey');
const TibberApi = require('../../lib/TibberApi');
const TibberLiveClient = require('../../lib/TibberLiveClient');
const ElviaGridTariff = require('../../lib/ElviaGridTariff');
const { computeMonthCost } = require('../../lib/CostCalculator');

const CAPABILITY_UPDATE_INTERVAL_MINUTES = 5;

const CURRENT_CAPABILITIES = [
  'measure_power',
  'consumption_today',
  'consumption_current_month',
  'consumption_estimate_month',
  'consumption_previous_month',
  'cost_current_month',
  'cost_estimate_month',
  'cost_previous_month',
];

class StromkostnadDevice extends Homey.Device {
  async onInit() {
    this.log('Strømkostnad device initialized:', this.getName());

    await this._migrateCapabilities();
    if (this.getStoreValue('currentMonthKey') && !this.getStoreValue('trackingStartedAt')) {
      // Existing device from before trackingStartedAt existed - without this,
      // fixed fees would be prorated over the whole calendar month elapsed
      // instead of just the time we've actually been recording consumption.
      await this.setStoreValue('trackingStartedAt', new Date().toISOString());
    }
    this._priceCache = { spotPriceByHour: new Map(), gridRent: null };
    this._initApiClient();
    await this._ensureHomeId();
    await this._refreshPrices();
    this._scheduleHourlyAlignedPriceRefresh();
    this._scheduleCapabilityUpdates();
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
  }

  async onDeleted() {
    if (this._priceTimer) this.homey.clearTimeout(this._priceTimer);
    if (this._capabilityTimer) this.homey.clearInterval(this._capabilityTimer);
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

  /** Tibber pushes a reading roughly every 2s - throttle capability writes to avoid hammering Homey. */
  _handlePower(power) {
    const now = Date.now();
    if (this._lastPowerUpdate && now - this._lastPowerUpdate < 5000) return;
    this._lastPowerUpdate = now;
    this._setCapabilitySafely('measure_power', power).catch(() => {});
  }

  /**
   * Called when Tibber's own daily accumulator resets at local midnight,
   * with the finalized total for the day that just ended. This is the
   * authoritative kWh source (immune to our own connection gaps) - see
   * _updateCapabilities for how it's combined with the hourly power
   * integration.
   */
  async _handleDayComplete(dayTotalKwh) {
    const monthDaysTotal = (this.getStoreValue('monthDaysTotal') || 0) + dayTotalKwh;
    await this.setStoreValue('monthDaysTotal', monthDaysTotal);
    this.log(`Day complete: ${dayTotalKwh.toFixed(3)} kWh (month total so far: ${monthDaysTotal.toFixed(3)} kWh)`);
  }

  /** Called once an hour's worth of live power readings has been integrated into kWh. */
  async _handleHourComplete(hour) {
    const hourMonthKey = hour.startedAt.slice(0, 7); // "YYYY-MM"
    await this._handleMonthRollover(hourMonthKey);

    const monthHours = this.getStoreValue('monthHours') || [];
    monthHours.push(hour);
    await this.setStoreValue('monthHours', monthHours);

    this.log(`Hour complete: ${hour.startedAt} = ${hour.kwh.toFixed(3)} kWh`);
    await this._updateCapabilities();
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

    await this._setCapabilitySafely('cost_previous_month', result.cost);
    await this._setCapabilitySafely('consumption_previous_month', consumptionKwh);
    this.log(`Month rolled over from ${currentMonthKey} to ${newMonthKey}, archived: ${consumptionKwh.toFixed(1)} kWh / ${result.cost.toFixed(2)} NOK`);

    await this.setStoreValue('monthHours', []);
    await this.setStoreValue('monthDaysTotal', 0);
    await this.setStoreValue('currentMonthKey', newMonthKey);
    await this.setStoreValue('trackingStartedAt', new Date().toISOString());
  }

  _scheduleCapabilityUpdates() {
    if (this._capabilityTimer) this.homey.clearInterval(this._capabilityTimer);
    this._capabilityTimer = this.homey.setInterval(() => {
      this._updateCapabilities().catch((err) => this.error('Failed to update capabilities:', err.message));
    }, CAPABILITY_UPDATE_INTERVAL_MINUTES * 60 * 1000);
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
      } catch (err) {
        this.error('Could not fetch grid rent from Elvia:', err.message);
        this._priceCache.gridRent = null;
      }
    } else {
      this._priceCache.gridRent = null;
    }
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

    const consumptionNodes = monthHours.map((h) => ({ from: `${h.startedAt}:00:00`, consumption: h.kwh }));
    if (partialHourKwh > 0) {
      consumptionNodes.push({ from: now.toISOString(), consumption: partialHourKwh });
    }

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

  async _updateCapabilities() {
    try {
      const monthHours = this.getStoreValue('monthHours') || [];
      const partialHourKwh = this._liveClient ? this._liveClient.getCurrentPartialHourKwh() : 0;
      const todayAccumulated = this._liveClient ? this._liveClient.getTodayAccumulated() : null;
      const monthDaysTotal = this.getStoreValue('monthDaysTotal') || 0;

      // Prefer Tibber's own daily accumulator (authoritative, gap-immune)
      // over our hourly power integration, once we've received at least
      // one reading with it.
      const todayKwh = typeof todayAccumulated === 'number'
        ? todayAccumulated
        : monthHours
          .filter((h) => h.startedAt.startsWith(this._todayKey()))
          .reduce((sum, h) => sum + h.kwh, 0) + partialHourKwh;

      const consumptionSoFar = typeof todayAccumulated === 'number'
        ? monthDaysTotal + todayAccumulated
        : monthHours.reduce((sum, h) => sum + h.kwh, 0) + partialHourKwh;

      const result = this._computeCost(monthHours, partialHourKwh, typeof todayAccumulated === 'number' ? consumptionSoFar : undefined);

      await this._setCapabilitySafely('consumption_today', todayKwh);
      await this._setCapabilitySafely('consumption_current_month', consumptionSoFar);
      await this._setCapabilitySafely('consumption_estimate_month', result.estimatedConsumptionKwh);
      await this._setCapabilitySafely('cost_current_month', result.cost);
      await this._setCapabilitySafely('cost_estimate_month', result.estimatedCost);

      await this.setAvailable();
    } catch (err) {
      this.error('Failed to update capabilities:', err.message);
      await this.setUnavailable(err.message).catch(() => {});
    }
  }
}

module.exports = StromkostnadDevice;
