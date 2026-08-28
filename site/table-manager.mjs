export const TABLE_MANAGER_EXTENSION_ID = "cikchpifmoffnengfnadjmfakpjcgpbn";

const CONNECTION_ID_PATTERN = /^[a-z0-9-]{8,80}$/i;
const TABLE_ID_PATTERN = /^[a-z0-9_-]{1,128}$/i;

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

export function normalizeExtensionStatus(response) {
  if (
    !response?.ok ||
    response.version !== 1 ||
    !Array.isArray(response.devices)
  ) {
    throw new Error(
      "The Table Manager extension returned an unsupported response.",
    );
  }
  const devices = response.devices.flatMap((candidate) => {
    const connectionId = cleanText(candidate?.connectionId, 80);
    const name = cleanText(candidate?.name, 60);
    const model = cleanText(candidate?.model, 80);
    const shortId = cleanText(candidate?.shortId, 16);
    if (
      !CONNECTION_ID_PATTERN.test(connectionId) ||
      !name ||
      !model ||
      !shortId
    )
      return [];
    return [
      { connectionId, name, model, shortId, online: candidate.online === true },
    ];
  });
  return {
    mode:
      devices.length === 0
        ? "hidden"
        : devices.some((device) => device.online)
          ? "online"
          : "offline",
    devices,
  };
}

export function sendExtensionMessage(
  message,
  {
    chromeApi = globalThis.chrome,
    extensionId = TABLE_MANAGER_EXTENSION_ID,
    timeoutMs = 3500,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const runtime = chromeApi?.runtime;
    if (typeof runtime?.sendMessage !== "function") {
      reject(new Error("The Table Manager extension is not installed."));
      return;
    }

    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(
      () =>
        finish(() =>
          reject(new Error("The Table Manager extension did not respond.")),
        ),
      timeoutMs,
    );

    try {
      runtime.sendMessage(extensionId, message, (response) => {
        const runtimeError = runtime.lastError;
        if (runtimeError) {
          finish(() => reject(new Error(runtimeError.message)));
          return;
        }
        finish(() => resolve(response));
      });
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

export async function getTableManagerStatus(options) {
  return normalizeExtensionStatus(
    await sendExtensionMessage({ type: "table-manager/status" }, options),
  );
}

export async function installTable(tableId, connectionId, options) {
  if (!TABLE_ID_PATTERN.test(String(tableId)))
    throw new Error("Table ID is invalid.");
  if (!CONNECTION_ID_PATTERN.test(String(connectionId))) {
    throw new Error("Cabinet selection is invalid.");
  }
  const response = await sendExtensionMessage(
    { type: "table-manager/install", tableId, connectionId },
    options,
  );
  if (!response?.ok) {
    const messages = {
      CABINET_OFFLINE: "Table Manager is offline on that cabinet.",
      CABINET_NOT_FOUND: "That cabinet is no longer registered.",
      CABINET_PERMISSION_REQUIRED:
        "Browser access to that cabinet must be granted again.",
    };
    throw new Error(
      messages[response?.error] ||
        "The table could not be opened in Table Manager.",
    );
  }
}

export async function openDeviceManager(options) {
  const response = await sendExtensionMessage(
    { type: "table-manager/open-devices" },
    options,
  );
  if (!response?.ok) throw new Error("Connected cabinets could not be opened.");
}
