'use strict';

const Homey = require('homey');
const TibberApi = require('../../lib/TibberApi');
const ElviaGridTariff = require('../../lib/ElviaGridTariff');
const { computeMonthCost } = require('../../lib/CostCalculator');

const DEFAULT_POLL_INTERVAL_MINUTES = 30;

class StromkostnadDevice extends Homey.Device {
  async onInit() {
    this.log('Strømkostnad device initialized:', this.getName());

    this._initApiClient();
    await this._ensureHomeId();
    await this.pollCost();
    this._schedulePolling();
    this._scheduleHourlyAlignedPoll();
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('tibberToken')) {
      this._initApiClient(newSettings);
      await this._ensureHomeId();
    }
    if (changedKeys.includes('elviaSubscriptionKey')) {
      this._initApiClient(newSettings);
    }
  }

  async onDeleted() {
    if (this._pollTimer) this.homey.clearInterval(this._pollTimer);
    if (this._hourlyTimer) this.homey.clearTimeout(this._hourlyTimer);
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

  _schedulePolling(intervalMinutes = DEFAULT_POLL_INTERVAL_MINUTES) {
    if (this._pollTimer) this.homey.clearInterval(this._pollTimer);
    this._pollTimer = this.homey.setInterval(() => {
      this.pollCost().catch((err) => this.error('Scheduled poll failed:', err.message));
    }, intervalMinutes * 60 * 1000);
  }

  /** Prices/consumption settle on the hour, so refresh right after every hour boundary too. */
  _scheduleHourlyAlignedPoll() {
    if (this._hourlyTimer) this.homey.clearTimeout(this._hourlyTimer);
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setHours(now.getHours() + 1, 0, 10, 0);
    const delay = nextHour.getTime() - now.getTime();

    this._hourlyTimer = this.homey.setTimeout(() => {
      this.pollCost()
        .catch((err) => this.error('Hourly-aligned poll failed:', err.message))
        .finally(() => this._scheduleHourlyAlignedPoll());
    }, delay);
  }

  async _setCapabilitySafely(capabilityId, value) {
    if (typeof value !== 'number' || Number.isNaN(value)) return;
    await this.setCapabilityValue(capabilityId, value).catch((err) => {
      this.error(`Failed to set ${capabilityId}:`, err.message);
    });
  }

  /** Fetches today's hourly grid-rent price curve directly from Elvia, if configured. */
  async _getGridRent() {
    const settings = this.getSettings();
    if (!settings.elviaSubscriptionKey || !settings.elviaMeteringPointId) return null;

    try {
      const collection = await this.elviaApi.getTodaysGridTariff(settings.elviaMeteringPointId);
      return {
        priceByHour: this.elviaApi.extractHourlyEnergyPriceByHour(collection),
        fixedPerHour: this.elviaApi.extractFixedPriceHourly(collection),
      };
    } catch (err) {
      this.error('Could not fetch grid rent from Elvia:', err.message);
      return null;
    }
  }

  async pollCost() {
    const homeId = this.getStoreValue('homeId');
    if (!homeId) {
      this.error('No Tibber home configured yet, skipping poll');
      return;
    }

    try {
      await this._handleMonthRollover();

      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const hoursElapsed = Math.max(1, Math.ceil((now - startOfMonth) / (60 * 60 * 1000)));

      const consumptionNodes = await this.api.getHourlyConsumption(homeId, hoursElapsed);
      const gridRent = await this._getGridRent();
      const settings = this.getSettings();

      let spotPriceByHour = new Map();
      if (settings.useSpotPrice) {
        spotPriceByHour = await this.api.getTodaysSpotPriceByHour(homeId).catch((err) => {
          this.error('Could not fetch spot price:', err.message);
          return new Map();
        });
      }

      const result = computeMonthCost({
        consumptionNodes,
        priceMode: settings.useSpotPrice ? 'spot' : 'fixed',
        fixedPrice: Number(settings.fixedPrice) || 0,
        markupNokPerKwh: (Number(settings.markupOre) || 0) / 100,
        spotPriceByHour,
        monthlyFee: Number(settings.monthlyFee) || 0,
        includeGridRent: Boolean(gridRent),
        gridRentPriceByHour: gridRent?.priceByHour || new Map(),
        gridRentFixedPerHour: gridRent?.fixedPerHour || 0,
        now,
      });

      await this._setCapabilitySafely('consumption_current_month', result.consumptionKwh);
      await this._setCapabilitySafely('consumption_estimate_month', result.estimatedConsumptionKwh);
      await this._setCapabilitySafely('cost_current_month', result.cost);
      await this._setCapabilitySafely('cost_estimate_month', result.estimatedCost);

      await this.setAvailable();
    } catch (err) {
      this.error('Failed to update cost:', err.message);
      await this.setUnavailable(err.message).catch(() => {});
    }
  }

  /** When a new month starts, freeze last month's totals before recalculating. */
  async _handleMonthRollover() {
    const now = new Date();
    const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const lastKnownMonth = this.getStoreValue('lastKnownMonth');

    if (lastKnownMonth && lastKnownMonth !== currentMonthKey) {
      const previousCost = this.getCapabilityValue('cost_current_month');
      const previousConsumption = this.getCapabilityValue('consumption_current_month');
      await this._setCapabilitySafely('cost_previous_month', previousCost);
      await this._setCapabilitySafely('consumption_previous_month', previousConsumption);
      this.log(`Month rolled over from ${lastKnownMonth} to ${currentMonthKey}, archived previous month totals.`);
    }

    await this.setStoreValue('lastKnownMonth', currentMonthKey);
  }
}

module.exports = StromkostnadDevice;
