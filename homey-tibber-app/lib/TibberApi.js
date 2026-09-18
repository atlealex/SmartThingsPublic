'use strict';

const API_URL = 'https://api.tibber.com/v1-beta/gql';

/**
 * Client for Tibber's public GraphQL API (https://developer.tibber.com).
 * Unlike Elvia's API, this one is officially documented and stable.
 */
class TibberApi {
  constructor({ token } = {}) {
    this.token = token;
  }

  async _query(query, variables) {
    if (!this.token) throw new Error('A Tibber API token is required');

    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      const cause = err.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : '';
      throw new Error(`Tibber API request failed: ${err.message}${cause}`);
    }

    const body = await res.json().catch(() => null);
    if (!res.ok || !body) {
      throw new Error(`Tibber API error ${res.status} ${res.statusText}`);
    }
    if (body.errors?.length) {
      throw new Error(`Tibber API error: ${body.errors.map((e) => e.message).join('; ')}`);
    }
    return body.data;
  }

  /** First home on the account. Most personal Tibber accounts only have one. */
  async getFirstHomeId() {
    const data = await this._query('{ viewer { homes { id address { address1 } } } }');
    const home = data?.viewer?.homes?.[0];
    if (!home) throw new Error(`No homes found on this Tibber account: ${JSON.stringify(data).slice(0, 500)}`);
    return home;
  }

  /**
   * Today's hourly spot price curve, as hour-of-day (0-23) -> NOK/kWh
   * (incl. VAT). Available even without an active Tibber power
   * subscription, unlike the per-consumption-node unitPrice field.
   */
  async getTodaysSpotPriceByHour(homeId) {
    const data = await this._query(
      `query($homeId: ID!) {
        viewer {
          home(id: $homeId) {
            currentSubscription {
              priceInfo {
                today { total startsAt }
              }
            }
          }
        }
      }`,
      { homeId },
    );

    const today = data?.viewer?.home?.currentSubscription?.priceInfo?.today;
    const map = new Map();
    if (!Array.isArray(today)) return map;

    for (const entry of today) {
      const start = entry?.startsAt && new Date(entry.startsAt);
      if (typeof entry.total === 'number' && start && !Number.isNaN(start.getTime())) {
        map.set(start.getHours(), entry.total);
      }
    }
    return map;
  }

  /**
   * Hourly consumption (kWh) for the given number of past hours. Tibber
   * keeps this history on their own servers, so we don't need to store it
   * ourselves - just ask for as many hours as we need each time (e.g.
   * hours elapsed so far this month).
   *
   * Deliberately does NOT request unitPrice/unitPriceVAT/cost: those
   * fields come back null (collapsing the whole `consumption` field to
   * null, with no GraphQL error) for homes without an active Tibber power
   * subscription - i.e. Pulse-only monitoring setups like this one. Spot
   * price is fetched separately via getTodaysSpotPriceByHour() instead.
   */
  async getHourlyConsumption(homeId, hours) {
    const data = await this._query(
      `query($homeId: ID!, $hours: Int!) {
        viewer {
          home(id: $homeId) {
            consumption(resolution: HOURLY, last: $hours) {
              nodes {
                from
                to
                consumption
              }
            }
          }
        }
      }`,
      { homeId, hours },
    );

    const nodes = data?.viewer?.home?.consumption?.nodes;
    if (!Array.isArray(nodes)) {
      throw new Error(`Unexpected Tibber consumption response shape: ${JSON.stringify(data).slice(0, 500)}`);
    }
    // Tibber may not have a finished reading for the current, still-running
    // hour yet - filter those out rather than treating them as zero.
    return nodes.filter((node) => typeof node.consumption === 'number');
  }
}

module.exports = TibberApi;
