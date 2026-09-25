'use strict';

const ModbusRTU = require('modbus-serial');

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Thin Modbus TCP client for the Systemair SAVE register map, built with
 * the same real-world gateway quirk the reference Home Assistant
 * integration (Howard0000/home-assistant-systemair-modbus) works around:
 * the Systemair IAM / "SAVE Connect" module can return "Illegal function"
 * for FC04 (read input registers), so in safe mode every "input" register
 * is instead read via FC03 (read holding registers) - the SAVE firmware
 * answers both function codes with the same data for these addresses.
 *
 * Registers are read one at a time (not batched) with a small pacing delay
 * and a retry/backoff, matching that integration's "save_connect" profile.
 * This is slower than aggressive batching, but far more reliable against
 * this specific gateway - and a full ~70-register poll still comfortably
 * fits inside a 30s cycle.
 */
class ModbusClient {
  constructor({
    host, port = 502, slaveId = 1, safeMode = true,
    pacingMs = 100, retries = 5, backoffBaseMs = 200,
  }) {
    this.host = host;
    this.port = port;
    this.slaveId = slaveId;
    this.safeMode = safeMode;
    this.pacingMs = pacingMs;
    this.retries = retries;
    this.backoffBaseMs = backoffBaseMs;
    this._client = new ModbusRTU();
    this._connected = false;
  }

  async connect() {
    if (this._connected) return;
    this._client.setTimeout(DEFAULT_TIMEOUT_MS);
    await this._client.connectTCP(this.host, { port: this.port });
    this._client.setID(this.slaveId);
    this._connected = true;
  }

  async close() {
    if (!this._connected) return;
    try {
      await this._client.close();
    } catch (err) {
      // best-effort
    }
    this._connected = false;
  }

  async _sleep(ms) {
    if (ms <= 0) return;
    await new Promise((resolve) => { setTimeout(resolve, ms); });
  }

  /** Reads one 16-bit register (or two, for uint32) at `address`, with retry/backoff. */
  async _readRaw(address, inputType, wordCount) {
    const useHolding = inputType === 'holding' || this.safeMode;
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        await this.connect();
        const result = useHolding
          ? await this._client.readHoldingRegisters(address, wordCount)
          : await this._client.readInputRegisters(address, wordCount);
        if (this.pacingMs > 0) await this._sleep(this.pacingMs);
        return result.data;
      } catch (err) {
        lastErr = err;
        this._connected = false;
        if (attempt < this.retries) {
          await this._sleep(this.backoffBaseMs * 2 ** attempt);
        }
      }
    }
    throw new Error(`Modbus read failed at register ${address} (${inputType}): ${lastErr && lastErr.message}`);
  }

  /**
   * Reads and decodes a single register definition (see SystemairRegisters.js).
   * @param {{address:number, inputType:string, dataType:string, scale?:number}} def
   */
  async readRegister(def) {
    const wordCount = def.dataType === 'uint32' ? 2 : 1;
    const words = await this._readRaw(def.address, def.inputType, wordCount);

    let raw;
    if (def.dataType === 'uint32') {
      // Low word at the base address, high word at address+1 (confirmed
      // against the reference integration's filter-timer registers).
      raw = words[0] + (words[1] << 16);
    } else if (def.dataType === 'int16') {
      raw = words[0] > 0x7fff ? words[0] - 0x10000 : words[0];
    } else {
      raw = words[0];
    }

    return def.scale ? raw * def.scale : raw;
  }

  /** Reads a whole map of {key: registerDef} sequentially, tolerating individual failures. */
  async readAll(registerDefs) {
    const values = {};
    const errors = {};
    for (const [key, def] of Object.entries(registerDefs)) {
      try {
        values[key] = await this.readRegister(def);
      } catch (err) {
        errors[key] = err.message;
      }
    }
    return { values, errors };
  }

  /** Writes a single 16-bit holding register (FC06), applying the definition's scale in reverse. */
  async writeRegister(def, value) {
    const raw = def.scale ? Math.round(value / def.scale) : Math.round(value);
    const unsigned = raw < 0 ? raw + 0x10000 : raw;
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        await this.connect();
        await this._client.writeRegister(def.address, unsigned);
        if (this.pacingMs > 0) await this._sleep(this.pacingMs);
        return;
      } catch (err) {
        lastErr = err;
        this._connected = false;
        if (attempt < this.retries) {
          await this._sleep(this.backoffBaseMs * 2 ** attempt);
        }
      }
    }
    throw new Error(`Modbus write failed at register ${def.address}: ${lastErr && lastErr.message}`);
  }

  /** Writes a raw integer value directly to a holding register address (no def/scale). */
  async writeRawAddress(address, rawValue) {
    const unsigned = rawValue < 0 ? rawValue + 0x10000 : rawValue;
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        await this.connect();
        await this._client.writeRegister(address, unsigned);
        if (this.pacingMs > 0) await this._sleep(this.pacingMs);
        return;
      } catch (err) {
        lastErr = err;
        this._connected = false;
        if (attempt < this.retries) {
          await this._sleep(this.backoffBaseMs * 2 ** attempt);
        }
      }
    }
    throw new Error(`Modbus write failed at register ${address}: ${lastErr && lastErr.message}`);
  }
}

module.exports = ModbusClient;
