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

  /** Current hour's Tibber-reported price (NOK/kWh, incl. VAT). */
  async getCurrentPrice(homeId) {
    const data = await this._query(
      `query($homeId: ID!) {
        viewer {
          home(id: $homeId) {
            currentSubscription {
              priceInfo {
                current { total energy tax startsAt }
              }
            }
          }
        }
      }`,
      { homeId },
    );
    return data?.viewer?.home?.currentSubscription?.priceInfo?.current || null;
  }

  /**
   * Hourly consumption + price for the given number of past hours.
   * Tibber keeps this history on their own servers, so we don't need to
   * store it ourselves - just ask for as many hours as we need each time
   * (e.g. hours elapsed so far this month).
   */
  async _fetchConsumptionNodes(homeId, hours) {
    const data = await this._query(
      `query($homeId: ID!, $hours: Int!) {
        viewer {
          home(id: $homeId) {
            consumption(resolution: HOURLY, last: $hours) {
              nodes {
                from
                to
                consumption
                unitPrice
                unitPriceVAT
              }
            }
          }
        }
      }`,
      { homeId, hours },
    );
    return data?.viewer?.home?.consumption?.nodes ?? null;
  }

  async getHourlyConsumption(homeId, hours) {
    let nodes = await this._fetchConsumptionNodes(homeId, hours);

    // Tibber returned `consumption: null` for the full range. Retry with a
    // small window as a diagnostic: if that also comes back null, this home
    // likely has no consumption history in Tibber's cloud at all; if it
    // succeeds, the full range was probably too large for a single query.
    if (nodes === null && hours > 48) {
      this.lastDiagnostic = `Full range (${hours}h) returned null, retrying with 48h`;
      nodes = await this._fetchConsumptionNodes(homeId, 48);
      if (nodes !== null) {
        this.lastDiagnostic += ' - 48h succeeded, so the full range was likely too large for one query';
      } else {
        this.lastDiagnostic += ' - 48h also returned null, likely no consumption history for this home yet';
      }
    }

    if (!Array.isArray(nodes)) {
      throw new Error(
        `Tibber consumption is null for this home (tried ${hours}h${this.lastDiagnostic ? `; ${this.lastDiagnostic}` : ''}). `
        + 'Check that the Tibber app itself shows an hourly consumption graph for this home.',
      );
    }
    // Tibber may not have a finished reading for the current, still-running
    // hour yet - filter those out rather than treating them as zero.
    return nodes.filter((node) => typeof node.consumption === 'number');
  }
}

module.exports = TibberApi;
