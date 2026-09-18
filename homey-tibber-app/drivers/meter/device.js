'use strict';

const Homey = require('homey');
const TibberApi = require('../../lib/TibberApi');
const { computeMonthCost } = require('../../lib/CostCalculator');

const DEFAULT_POLL_INTERVAL_MINUTES = 30;
const ELVIA_DRIVER_URI = 'homey:app:com.atlealex.elvia';

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
  }

  async onDeleted() {
    if (this._pollTimer) this.homey.clearInterval(this._pollTimer);
    if (this._hourlyTimer) this.homey.clearTimeout(this._hourlyTimer);
  }

  _initApiClient(settings = this.getSettings()) {
    this.api = new TibberApi({ token: settings.tibberToken });
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

  /** Reads live grid rent numbers from the Elvia-Nett app's device, if present. */
  async _getGridRent() {
    const settings = this.getSettings();
    if (!settings.includeGridRent) return null;

    try {
      const devices = await this.homey.devices.getDevices();
      const elviaDevice = Object.values(devices).find((d) => d.driverUri === ELVIA_DRIVER_URI);
      if (!elviaDevice) {
        this.log('Elvia-Nett device not found - grid rent will be excluded from cost.');
        return null;
      }

      const pricePerKwh = elviaDevice.capabilitiesObj?.measure_price?.value;
      const fixedPerHour = elviaDevice.capabilitiesObj?.fixed_price_hourly?.value;

      if (typeof pricePerKwh !== 'number') {
        this.log('Elvia-Nett device found, but measure_price has no value yet.');
        return null;
      }

      return {
        pricePerKwh,
        fixedPerHour: typeof fixedPerHour === 'number' ? fixedPerHour : 0,
      };
    } catch (err) {
      this.error('Could not read grid rent from Elvia-Nett device:', err.message);
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

      const result = computeMonthCost({
        consumptionNodes,
        priceMode: settings.useSpotPrice ? 'spot' : 'fixed',
        fixedPrice: Number(settings.fixedPrice) || 0,
        markupNokPerKwh: (Number(settings.markupOre) || 0) / 100,
        monthlyFee: Number(settings.monthlyFee) || 0,
        includeGridRent: Boolean(gridRent),
        gridRentPricePerKwh: gridRent?.pricePerKwh || 0,
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
