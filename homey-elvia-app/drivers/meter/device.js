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
  'consumption_previous_hour',
  'consumption_previous_hour_time_text',
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
      this._updateConsumption(meteringPointId),
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
      await this._updateFixedPriceLevelsTable(collection);

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

  /** Shows the full fastleddstrinn table (all steps, not just yours) in device settings. */
  async _updateFixedPriceLevelsTable(collection) {
    const levels = this.api.extractAllFixedPriceLevels(collection);
    if (levels.length === 0) return;

    const table = levels
      .map((level) => `Trinn ${level.level} (${level.levelInfo}): ${level.monthlyTotal} kr`)
      .join('\n');

    await this.setSettings({ fixedPriceLevelsTable: table }).catch((err) => {
      this.error('Failed to update fixedPriceLevelsTable setting:', err.message);
    });
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

  async _updateConsumption(meteringPointId) {
    if (!this.getSetting('accessToken')) {
      // Hourly consumption is personal data and needs the optional elvid.no token.
      return;
    }

    try {
      const timeSeries = await this.api.getConsumptionHistory(meteringPointId);
      if (timeSeries.length > 0) {
        const latest = timeSeries[timeSeries.length - 1];
        await this._setCapabilitySafely('consumption_previous_hour', latest.value);
        // Elvia's own reporting lags real time by a couple of hours in
        // practice (confirmed live: at 16:08 the latest available entry was
        // for 14:00-15:00, not 15:00-16:00) - "latest reported hour", not
        // literally "the hour before now". This makes that lag visible
        // instead of silently misleading, without needing to open settings.
        const rawTime = latest.startTime || latest.from || latest.timestamp;
        if (rawTime) {
          await this._setCapabilitySafely('consumption_previous_hour_time_text', this._hourFormatter().format(new Date(rawTime)));
        }
      }
      await this._updateConsumptionHistoryTable(timeSeries);
    } catch (err) {
      this.error('Failed to update consumption:', err.message);
    }
  }

  /**
   * Timezone-aware "DD.MM HH:MM" formatter, shared by the latest-hour time
   * text and the settings history table. Homey Pro's OS clock runs UTC
   * regardless of the configured timezone - toLocaleString()/
   * Intl.DateTimeFormat() without an explicit timeZone would silently
   * render every hour label in UTC instead of local time.
   */
  _hourFormatter() {
    let timeZone;
    try {
      timeZone = this.homey.clock.getTimezone();
    } catch (err) {
      timeZone = undefined;
    }
    return new Intl.DateTimeFormat('no-NO', {
      timeZone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  }

  /**
   * Shows the last 24 hours of consumption (newest first) in device
   * settings, same "computed text table" pattern as fixedPriceLevelsTable -
   * Homey's Settings screen has no dynamic per-hour list widget, and
   * Insights can't be backfilled with data from before the app started
   * tracking, so a plain table is the simplest way to actually show a
   * history rather than just the latest hour.
   */
  async _updateConsumptionHistoryTable(timeSeries) {
    if (!Array.isArray(timeSeries) || timeSeries.length === 0) return;

    const formatter = this._hourFormatter();
    const table = [...timeSeries]
      .reverse()
      .map((entry) => {
        const rawTime = entry.startTime || entry.from || entry.timestamp;
        const label = rawTime ? formatter.format(new Date(rawTime)) : '?';
        const value = typeof entry.value === 'number' ? entry.value.toFixed(2) : '?';
        return `${label}  ${value} kWh`;
      })
      .join('\n');

    await this.setSettings({ consumptionHistoryTable: table }).catch((err) => {
      this.error('Failed to update consumptionHistoryTable setting:', err.message);
    });
  }
}

module.exports = ElviaMeterDevice;
