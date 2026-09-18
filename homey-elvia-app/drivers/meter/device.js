'use strict';

const Homey = require('homey');
const ElviaApi = require('../../lib/ElviaApi');

const DEFAULT_POLL_INTERVAL_MINUTES = 30;
const MAX_HOUR_MONTHS = [
  { suffix: 'current_month', rankSuffix: 'current', monthsBack: 0 },
  { suffix: 'previous_month', rankSuffix: 'previous', monthsBack: 1 },
];

const CURRENT_CAPABILITIES = [
  'measure_price',
  'fixed_price_hourly',
  'fixed_price_monthly',
  'fixed_price_level_info',
  'max_hours_average.current_month',
  'max_hours_average.previous_month',
  'max_hour_rank.current_1',
  'max_hour_rank.current_2',
  'max_hour_rank.current_3',
  'max_hour_rank.previous_1',
  'max_hour_rank.previous_2',
  'max_hour_rank.previous_3',
];

class ElviaMeterDevice extends Homey.Device {
  async onInit() {
    this.log('Elvia meter device initialized:', this.getName());

    await this._migrateCapabilities();
    this._initApiClient();
    await this.pollElviaData();
    this._schedulePolling();
    this._scheduleHourlyAlignedPoll();
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
    if (changedKeys.includes('subscriptionKey') || changedKeys.includes('accessToken') || changedKeys.includes('baseUrl')) {
      this._initApiClient(newSettings);
    }
    if (changedKeys.includes('pollIntervalMinutes')) {
      this._schedulePolling(newSettings.pollIntervalMinutes);
    }
  }

  async onDeleted() {
    if (this._pollTimer) {
      this.homey.clearInterval(this._pollTimer);
    }
    if (this._hourlyTimer) {
      this.homey.clearTimeout(this._hourlyTimer);
    }
  }

  _initApiClient(settings = this.getSettings()) {
    this.api = new ElviaApi({
      subscriptionKey: settings.subscriptionKey,
      accessToken: settings.accessToken,
      baseUrl: settings.baseUrl || undefined,
    });
  }

  _schedulePolling(intervalMinutes = this.getSetting('pollIntervalMinutes')) {
    if (this._pollTimer) {
      this.homey.clearInterval(this._pollTimer);
    }
    const minutes = Number(intervalMinutes) > 0 ? Number(intervalMinutes) : DEFAULT_POLL_INTERVAL_MINUTES;
    this._pollTimer = this.homey.setInterval(() => {
      this.pollElviaData().catch((err) => this.error('Scheduled poll failed:', err.message));
    }, minutes * 60 * 1000);
  }

  /**
   * Grid tariff prices change exactly on the hour (including weekday/
   * weekend and day/night rate transitions), so a fixed poll interval can
   * show a stale price for up to that whole interval after the change.
   * Refresh everything a few seconds after every hour boundary, in
   * addition to the regular interval poll.
   */
  _scheduleHourlyAlignedPoll() {
    if (this._hourlyTimer) {
      this.homey.clearTimeout(this._hourlyTimer);
    }
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setHours(now.getHours() + 1, 0, 5, 0);
    const delay = nextHour.getTime() - now.getTime();

    this._hourlyTimer = this.homey.setTimeout(() => {
      this.pollElviaData()
        .catch((err) => this.error('Hourly-aligned poll failed:', err.message))
        .finally(() => this._scheduleHourlyAlignedPoll());
    }, delay);
  }

  async pollElviaData() {
    const meteringPointId = this.getSetting('meteringPointId') || this.getData().id;
    if (!meteringPointId) {
      this.error('No meteringPointId configured, skipping poll');
      return;
    }

    await Promise.allSettled([
      this._updateGridTariff(meteringPointId),
      this._updateMaxHours(meteringPointId),
    ]);
  }

  async _setCapabilitySafely(capabilityId, value) {
    if (value === null || value === undefined) return;
    await this.setCapabilityValue(capabilityId, value).catch((err) => {
      this.error(`Failed to set ${capabilityId}:`, err.message);
    });
  }

  async _updateGridTariff(meteringPointId) {
    try {
      const collection = await this.api.getGridTariffData(meteringPointId);

      const price = this.api.extractEnergyPrice(collection);
      const previous = this.getCapabilityValue('measure_price');
      await this._setCapabilitySafely('measure_price', price);
      await this._setCapabilitySafely('fixed_price_hourly', this.api.extractFixedPriceHourly(collection));
      await this._setCapabilitySafely('fixed_price_monthly', this.api.extractFixedPriceMonthly(collection));
      await this._setCapabilitySafely('fixed_price_level_info', this.api.extractFixedPriceLevelInfo(collection));

      if (typeof previous === 'number' && typeof price === 'number' && previous !== price) {
        await this.homey.flow
          .getDeviceTriggerCard('grid_tariff_price_changed')
          .trigger(this, { price }, {})
          .catch((err) => this.error('Failed to trigger price_changed:', err.message));
      }

      await this.setAvailable();
    } catch (err) {
      this.error('Failed to update grid tariff:', err.message);
      await this.setUnavailable(err.message).catch(() => {});
    }
  }

  async _updateMaxHours(meteringPointId) {
    if (!this.getSetting('accessToken')) {
      // Max hours are personal data and need the optional elvid.no token.
      return;
    }

    try {
      const aggregates = await this.api.getMaxHours(meteringPointId);

      for (const { suffix, rankSuffix, monthsBack } of MAX_HOUR_MONTHS) {
        await this._setCapabilitySafely(
          `max_hours_average.${suffix}`,
          this.api.extractMaxHoursAverage(aggregates, monthsBack),
        );
        for (const rank of [1, 2, 3]) {
          await this._setCapabilitySafely(
            `max_hour_rank.${rankSuffix}_${rank}`,
            this.api.extractMaxHourRank(aggregates, monthsBack, rank),
          );
        }
      }
    } catch (err) {
      this.error('Failed to update max hours:', err.message);
    }
  }
}

module.exports = ElviaMeterDevice;
