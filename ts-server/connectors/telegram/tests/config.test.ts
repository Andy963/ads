import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConnectorConfig, validateConnectorConfig } from "../src/config.js";

describe("TelegramConnectorConfig", () => {
  it("loads connector config from environment variables", () => {
    const config = loadConnectorConfig({
      TELEGRAM_BOT_TOKEN: "1234:token",
      TELEGRAM_ALLOWED_USER_ID: "987654",
      ADS_CORE_URL: "http://10.0.0.1:8080",
      ADS_CONNECTOR_TOKEN: "test-connector-token",
    });

    assert.equal(config.botToken, "1234:token");
    assert.deepEqual(config.allowedUsers, [987654]);
    assert.equal(config.coreUrl, "http://10.0.0.1:8080");
    assert.equal(config.coreWsUrl, "ws://10.0.0.1:8080/ws");
    assert.equal(config.promptIdleTimeoutMs, 180_000);
    assert.equal(config.promptMaxDurationMs, 1_800_000);
    assert.doesNotThrow(() => validateConnectorConfig(config));
  });

  it("loads prompt timeout overrides", () => {
    const config = loadConnectorConfig({
      TELEGRAM_BOT_TOKEN: "1234:token",
      TELEGRAM_ALLOWED_USER_ID: "987654",
      ADS_CONNECTOR_TOKEN: "test-connector-token",
      TELEGRAM_PROMPT_IDLE_TIMEOUT_MS: "60000",
      TELEGRAM_PROMPT_MAX_DURATION_MS: "900000",
    });

    assert.equal(config.promptIdleTimeoutMs, 60_000);
    assert.equal(config.promptMaxDurationMs, 900_000);
    assert.doesNotThrow(() => validateConnectorConfig(config));
  });

  it("rejects a maximum duration shorter than the idle timeout", () => {
    const config = loadConnectorConfig({
      TELEGRAM_BOT_TOKEN: "1234:token",
      TELEGRAM_ALLOWED_USER_ID: "987654",
      ADS_CONNECTOR_TOKEN: "test-connector-token",
      TELEGRAM_PROMPT_IDLE_TIMEOUT_MS: "600000",
      TELEGRAM_PROMPT_MAX_DURATION_MS: "60000",
    });

    assert.throws(
      () => validateConnectorConfig(config),
      /TELEGRAM_PROMPT_MAX_DURATION_MS must be greater than or equal to TELEGRAM_PROMPT_IDLE_TIMEOUT_MS/,
    );
  });

  it("throws validation error when token or allowed user is missing", () => {
    const badConfig = loadConnectorConfig({});
    assert.throws(() => validateConnectorConfig(badConfig), /TELEGRAM_BOT_TOKEN is required/);
  });

  it("defaults to the ADS Core web port", () => {
    const config = loadConnectorConfig({
      TELEGRAM_BOT_TOKEN: "1234:token",
      TELEGRAM_ALLOWED_USER_ID: "987654",
      ADS_CONNECTOR_TOKEN: "test-connector-token",
    });

    assert.equal(config.coreUrl, "http://127.0.0.1:8787");
    assert.equal(config.coreWsUrl, "ws://127.0.0.1:8787/ws");
  });

  it("requires the Core connector credential rather than a legacy API token", () => {
    const config = loadConnectorConfig({
      TELEGRAM_BOT_TOKEN: "1234:token",
      TELEGRAM_ALLOWED_USER_ID: "987654",
      ADS_API_TOKEN: "legacy-token",
    });

    assert.throws(() => validateConnectorConfig(config), /ADS_CONNECTOR_TOKEN is required/);
  });
});
