import assert from "node:assert/strict";
import test from "node:test";

import {
  getTableManagerStatus,
  installTable,
  normalizeExtensionStatus,
  sendExtensionMessage,
} from "../site/table-manager.mjs";

const online = {
  connectionId: "86b0ce9d-66c2-44db-b654-cbe7d34c75a1",
  name: "Game Room",
  model: "Legends Pinball 4KP",
  shortId: "…c81cfa",
  online: true,
};

test("maps extension responses to hidden, online, and offline modes", () => {
  assert.deepEqual(
    normalizeExtensionStatus({ ok: true, version: 1, devices: [] }),
    {
      mode: "hidden",
      devices: [],
    },
  );
  assert.equal(
    normalizeExtensionStatus({
      ok: true,
      version: 1,
      devices: [{ ...online, online: false }],
    }).mode,
    "offline",
  );
  assert.equal(
    normalizeExtensionStatus({ ok: true, version: 1, devices: [online] }).mode,
    "online",
  );
});

test("drops malformed device records instead of exposing unusable buttons", () => {
  const status = normalizeExtensionStatus({
    ok: true,
    version: 1,
    devices: [online, { ...online, connectionId: "bad" }],
  });
  assert.deepEqual(status.devices, [online]);
});

test("sends messages to the fixed extension ID", async () => {
  let captured;
  const chromeApi = {
    runtime: {
      lastError: null,
      sendMessage(extensionId, message, callback) {
        captured = { extensionId, message };
        callback({ ok: true, version: 1, devices: [online] });
      },
    },
  };
  const status = await getTableManagerStatus({
    chromeApi,
    extensionId: "abcdefghijklmnopabcdefghijklmnop",
  });
  assert.equal(status.mode, "online");
  assert.deepEqual(captured, {
    extensionId: "abcdefghijklmnopabcdefghijklmnop",
    message: { type: "table-manager/status" },
  });
});

test("treats an unavailable extension as an error", async () => {
  await assert.rejects(
    sendExtensionMessage({ type: "table-manager/status" }, { chromeApi: {} }),
    /not installed/,
  );
});

test("validates installs before messaging the extension", async () => {
  await assert.rejects(installTable("../bad", online.connectionId), /Table ID/);
  await assert.rejects(installTable("vpx-afm", "bad"), /Cabinet selection/);
});
