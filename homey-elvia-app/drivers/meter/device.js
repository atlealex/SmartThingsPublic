'use strict';

const Homey = require('homey');
const ElviaApi = require('../../lib/ElviaApi');

const DEFAULT_POLL_INTERVAL_MINUTES = 30;

class ElviaMeterDevice extends Homey.Device {
  async onInit() {
    this.log('Elvia meter device initialized:', this.getName());

    this._initApiClient();
    await this.pollElviaData();
    this._schedulePolling();
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

  async pollElviaData() {
    const meteringPointId = this.getSetting('meteringPointId') || this.getData().id;
    if (!meteringPointId) {
      this.error('No meteringPointId configured, skipping poll');
      return;
    }

    await Promise.allSettled([
      this._updateGridTariff(meteringPointId),
      this._updateMeterValue(meteringPointId),
    ]);
  }

  async _updateGridTariff(meteringPointId) {
    try {
      const price = await this.api.getCurrentGridTariff(meteringPointId);
      const previous = this.getCapabilityValue('measure_price');
      await this.setCapabilityValue('measure_price', price);

      if (typeof previous === 'number' && previous !== price) {
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

  async _updateMeterValue(meteringPointId) {
    const accessToken = this.getSetting('accessToken');
    if (!accessToken) {
      // Personal meter values are optional: many users only want the public
      // grid tariff price and never paste an elvid.no access token.
      return;
    }

    try {
      const kwh = await this.api.getLatestHourlyMeterValue(meteringPointId);
      await this.setCapabilityValue('meter_power', kwh);
      // Hourly kWh consumption approximated as average power over that hour.
      await this.setCapabilityValue('measure_power', kwh * 1000);
    } catch (err) {
      this.error('Failed to update meter value:', err.message);
    }
  }
}

module.exports = ElviaMeterDevice;
