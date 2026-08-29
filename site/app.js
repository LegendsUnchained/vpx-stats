import {
  getTableManagerStatus,
  installTable,
  openDeviceManager,
} from "./table-manager.mjs";

const PERIODS = ["day", "week", "month", "year", "all"];
const MODELS = ["all", "HA9919", "HA9920"];
const DEFAULT_PERIOD = "month";
const DEFAULT_MODEL = "all";
const AUTO_REFRESH_MS = 5 * 60 * 1000;
const TABLE_MANAGER_REFRESH_MS = 20 * 1000;

const elements = {
  totalPlays: document.querySelector("#total-plays"),
  activeTables: document.querySelector("#active-tables"),
  lastRefreshed: document.querySelector("#last-refreshed"),
  periodLabel: document.querySelector("#period-label"),
  periodWindow: document.querySelector("#period-window"),
  loading: document.querySelector("#loading-state"),
  error: document.querySelector("#error-state"),
  errorMessage: document.querySelector("#error-message"),
  retry: document.querySelector("#retry-button"),
  content: document.querySelector("#leaderboard-content"),
  podiumSection: document.querySelector("#podium-section"),
  podium: document.querySelector("#podium"),
  rankingList: document.querySelector("#ranking-list"),
  search: document.querySelector("#table-search"),
  noResults: document.querySelector("#no-results"),
  tabs: [...document.querySelectorAll("[data-period]")],
  modelTabs: [...document.querySelectorAll("[data-model]")],
  cabinetDialog: document.querySelector("#cabinet-dialog"),
  cabinetDialogTable: document.querySelector("#cabinet-dialog-table"),
  cabinetList: document.querySelector("#cabinet-list"),
  manageCabinets: document.querySelector("#manage-cabinets"),
  installStatus: document.querySelector("#install-status"),
};

const state = {
  data: null,
  period: initialPeriod(),
  model: initialModel(),
  query: "",
  tableManager: { mode: "hidden", devices: [] },
};

let tableManagerFailures = 0;
let tableManagerRefresh;
let installStatusTimer;

function initialPeriod() {
  const requested = new URLSearchParams(window.location.search).get("period");
  return PERIODS.includes(requested) ? requested : DEFAULT_PERIOD;
}

function initialModel() {
  const requested = new URLSearchParams(window.location.search).get("model");
  return MODELS.includes(requested) ? requested : DEFAULT_MODEL;
}

function formatNumber(value) {
  return new Intl.NumberFormat(undefined).format(value);
}

function formatUpdated(value) {
  const date = new Date(value);
  const relativeMinutes = Math.max(
    0,
    Math.round((Date.now() - date.getTime()) / 60000),
  );
  if (relativeMinutes < 1) return "Just now";
  if (relativeMinutes < 60) return `${relativeMinutes} min ago`;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatWindow(period) {
  if (state.period === "all") return `Since ${formatDate(period.start)}`;
  return `${formatDate(period.start)} – ${formatDate(period.end)} UTC`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

function metadata(table) {
  const parts = [];
  if (table.manufacturer) parts.push(table.manufacturer);
  if (table.year) parts.push(String(table.year));
  return parts.join(" · ") || "VPX table";
}

function modelLabel(model) {
  return (
    state.data.modelDefinitions.find(({ key }) => key === model)?.label ?? model
  );
}

function tableEntries() {
  return Object.entries(state.data.tables)
    .map(([id, table]) => ({
      id,
      ...table,
      count: Number(
        state.model === "all"
          ? table.counts[state.period]
          : table.modelCounts?.[state.model]?.[state.period],
      ) || 0,
    }))
    .sort(
      (left, right) =>
        right.count - left.count || left.name.localeCompare(right.name),
    );
}

function artwork(table, eager = false) {
  const frame = document.createElement("div");
  frame.className = "artwork-frame";

  const fallback = document.createElement("span");
  fallback.className = "artwork-fallback";
  fallback.textContent = "LU";

  const image = document.createElement("img");
  image.src = table.launcherImage;
  image.alt = `${table.name} launcher artwork`;
  image.loading = eager ? "eager" : "lazy";
  image.decoding = "async";
  image.addEventListener("error", () => {
    image.remove();
    frame.classList.add("artwork-missing");
  });

  frame.append(fallback, image);
  return frame;
}

function showInstallStatus(message, kind = "info") {
  window.clearTimeout(installStatusTimer);
  elements.installStatus.textContent = message;
  elements.installStatus.dataset.kind = kind;
  elements.installStatus.hidden = false;
  installStatusTimer = window.setTimeout(() => {
    elements.installStatus.hidden = true;
  }, 5000);
}

async function installOnCabinet(table, device) {
  showInstallStatus(`Opening ${table.name} on ${device.name}…`);
  try {
    await installTable(table.id, device.connectionId);
    showInstallStatus(`Opened ${table.name} on ${device.name}.`, "success");
  } catch (error) {
    showInstallStatus(
      error instanceof Error ? error.message : String(error),
      "error",
    );
    refreshTableManagerStatus();
  }
}

function chooseCabinet(table) {
  const devices = state.tableManager.devices;
  const online = devices.filter((device) => device.online);
  if (devices.length === 1 && online.length === 1) {
    installOnCabinet(table, online[0]);
    return;
  }

  elements.cabinetDialogTable.textContent = table.name;
  const choices = devices.map((device) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cabinet-choice";
    button.disabled = !device.online;

    const indicator = document.createElement("span");
    indicator.className = `cabinet-status${device.online ? " cabinet-status-online" : ""}`;
    const details = document.createElement("span");
    details.className = "cabinet-choice-details";
    const name = document.createElement("strong");
    name.textContent = device.name;
    const meta = document.createElement("span");
    meta.textContent = `${device.model} · ${device.shortId}`;
    details.append(name, meta);
    const status = document.createElement("span");
    status.className = "cabinet-choice-state";
    status.textContent = device.online ? "Install" : "Offline";
    button.append(indicator, details, status);
    button.addEventListener("click", () => {
      elements.cabinetDialog.close();
      installOnCabinet(table, device);
    });
    return button;
  });
  elements.cabinetList.replaceChildren(...choices);
  elements.cabinetDialog.showModal();
}

function tableInstallButton(table, compact = false) {
  if (state.tableManager.mode === "hidden") return null;
  const button = document.createElement("button");
  button.type = "button";
  button.className = `install-button${compact ? " install-button-compact" : ""}`;
  const online = state.tableManager.mode === "online";
  button.disabled = !online;
  button.textContent = online ? "Install" : "Table Manager Offline";
  button.setAttribute(
    "aria-label",
    online
      ? `Install ${table.name}`
      : `Table Manager is offline for ${table.name}`,
  );
  if (online) button.addEventListener("click", () => chooseCabinet(table));
  return button;
}

function renderPodium(entries) {
  elements.podium.replaceChildren();
  const top = entries.slice(0, 3);
  const displayOrder = top.length === 3 ? [top[1], top[0], top[2]] : top;

  for (const table of displayOrder) {
    const rank = entries.indexOf(table) + 1;
    const card = document.createElement("article");
    card.className = `podium-card podium-rank-${rank}`;

    const image = artwork(table, true);
    const badge = document.createElement("span");
    badge.className = "podium-rank";
    badge.textContent = `#${rank}`;
    image.append(badge);

    const details = document.createElement("div");
    details.className = "podium-details";
    const name = document.createElement("h4");
    name.textContent = table.name;
    const meta = document.createElement("p");
    meta.textContent = metadata(table);
    const count = document.createElement("strong");
    count.innerHTML = `<span>${formatNumber(table.count)}</span> ${table.count === 1 ? "play" : "plays"}`;
    details.append(name, meta, count);
    const install = tableInstallButton(table);
    if (install) details.append(install);
    card.append(image, details);
    elements.podium.append(card);
  }
}

function renderRanking(entries) {
  const normalizedQuery = state.query.trim().toLocaleLowerCase();
  const ranks = new Map(entries.map((table, index) => [table.id, index + 1]));
  const visible = normalizedQuery
    ? entries.filter((table) =>
        `${table.name} ${table.manufacturer ?? ""} ${table.year ?? ""} ${table.id}`
          .toLocaleLowerCase()
          .includes(normalizedQuery),
      )
    : entries.slice(3);
  const maximum = Math.max(1, entries[0]?.count ?? 0);
  const fragment = document.createDocumentFragment();

  for (const table of visible) {
    const item = document.createElement("li");
    item.className = "ranking-row";

    const rank = document.createElement("span");
    rank.className = "row-rank";
    rank.textContent = `#${String(ranks.get(table.id)).padStart(3, "0")}`;

    const art = artwork(table);
    art.classList.add("row-artwork");

    const details = document.createElement("div");
    details.className = "row-details";
    const name = document.createElement("strong");
    name.textContent = table.name;
    const meta = document.createElement("span");
    meta.textContent = metadata(table);
    const bar = document.createElement("span");
    bar.className = "play-bar";
    const fill = document.createElement("span");
    const percentage =
      table.count > 0 ? Math.max(2, (table.count / maximum) * 100) : 0;
    fill.style.width = `${percentage}%`;
    bar.append(fill);
    details.append(name, meta, bar);

    const count = document.createElement("strong");
    count.className = "row-count";
    count.innerHTML = `${formatNumber(table.count)}<span>${table.count === 1 ? "play" : "plays"}</span>`;

    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.append(count);
    const install = tableInstallButton(table, true);
    if (install) actions.append(install);

    item.append(rank, art, details, actions);
    fragment.append(item);
  }

  elements.rankingList.replaceChildren(fragment);
  elements.noResults.hidden = visible.length > 0;
  elements.podiumSection.hidden = Boolean(normalizedQuery);
}

function render() {
  if (!state.data) return;
  const period = state.data.periods[state.period];
  const summary = state.model === "all" ? period : period.models[state.model];
  const entries = tableEntries();

  elements.totalPlays.textContent = formatNumber(summary.totalPlays);
  elements.activeTables.textContent = `${formatNumber(summary.activeTables)} / ${formatNumber(entries.length)}`;
  elements.lastRefreshed.textContent = formatUpdated(state.data.generatedAt);
  elements.periodLabel.textContent =
    state.model === "all"
      ? `${period.label} · All cabinets`
      : `${period.label} · ${modelLabel(state.model)}`;
  elements.periodWindow.textContent = formatWindow(period);

  for (const tab of elements.tabs) {
    const selected = tab.dataset.period === state.period;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const tab of elements.modelTabs) {
    const selected = tab.dataset.model === state.model;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }

  renderPodium(entries);
  renderRanking(entries);
}

function selectPeriod(period) {
  if (!PERIODS.includes(period)) return;
  state.period = period;
  const url = new URL(window.location.href);
  url.searchParams.set("period", period);
  window.history.replaceState({}, "", url);
  render();
}

function selectModel(model) {
  if (!MODELS.includes(model)) return;
  state.model = model;
  const url = new URL(window.location.href);
  if (model === DEFAULT_MODEL) url.searchParams.delete("model");
  else url.searchParams.set("model", model);
  window.history.replaceState({}, "", url);
  render();
}

function validateDataset(data) {
  if (
    data?.schemaVersion !== 2 ||
    typeof data.generatedAt !== "string" ||
    !Array.isArray(data.modelDefinitions) ||
    !data.periods ||
    !data.tables
  ) {
    throw new Error("The published stats file has an unsupported format.");
  }
  for (const period of PERIODS) {
    if (
      !data.periods[period] ||
      !data.periods[period].models?.HA9919 ||
      !data.periods[period].models?.HA9920
    )
      throw new Error(`The stats file is missing ${period} data.`);
  }
  return data;
}

async function loadStats({ silent = false } = {}) {
  if (!silent) {
    elements.loading.hidden = false;
    elements.error.hidden = true;
    elements.content.hidden = true;
  }

  try {
    const response = await fetch(`data/stats.json?ts=${Date.now()}`, {
      cache: "no-store",
    });
    if (!response.ok)
      throw new Error(`The stats service returned HTTP ${response.status}.`);
    const nextData = validateDataset(await response.json());
    if (!state.data || nextData.generatedAt !== state.data.generatedAt) {
      state.data = nextData;
      render();
    }
    elements.loading.hidden = true;
    elements.error.hidden = true;
    elements.content.hidden = false;
  } catch (error) {
    if (silent && state.data) return;
    elements.loading.hidden = true;
    elements.content.hidden = true;
    elements.error.hidden = false;
    elements.errorMessage.textContent =
      error instanceof Error ? error.message : String(error);
  }
}

async function refreshTableManagerStatus() {
  if (tableManagerRefresh) return tableManagerRefresh;
  tableManagerRefresh = (async () => {
    try {
      const next = await getTableManagerStatus();
      tableManagerFailures = 0;
      if (JSON.stringify(next) !== JSON.stringify(state.tableManager)) {
        state.tableManager = next;
        if (state.data) {
          renderPodium(tableEntries());
          renderRanking(tableEntries());
        }
      }
    } catch {
      tableManagerFailures += 1;
      if (tableManagerFailures >= 2 && state.tableManager.mode !== "hidden") {
        state.tableManager = { mode: "hidden", devices: [] };
        if (state.data) {
          renderPodium(tableEntries());
          renderRanking(tableEntries());
        }
      }
    } finally {
      tableManagerRefresh = null;
    }
  })();
  return tableManagerRefresh;
}

for (const tab of elements.tabs) {
  tab.addEventListener("click", () => selectPeriod(tab.dataset.period));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const index = PERIODS.indexOf(state.period);
    const next = PERIODS[(index + direction + PERIODS.length) % PERIODS.length];
    selectPeriod(next);
    elements.tabs
      .find((candidate) => candidate.dataset.period === next)
      ?.focus();
  });
}

for (const tab of elements.modelTabs) {
  tab.addEventListener("click", () => selectModel(tab.dataset.model));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const index = MODELS.indexOf(state.model);
    const next = MODELS[(index + direction + MODELS.length) % MODELS.length];
    selectModel(next);
    elements.modelTabs
      .find((candidate) => candidate.dataset.model === next)
      ?.focus();
  });
}

elements.search.addEventListener("input", () => {
  state.query = elements.search.value;
  if (state.data) renderRanking(tableEntries());
});
elements.retry.addEventListener("click", () => loadStats());
elements.manageCabinets.addEventListener("click", async () => {
  try {
    await openDeviceManager();
  } catch (error) {
    showInstallStatus(
      error instanceof Error ? error.message : String(error),
      "error",
    );
  }
});
window.addEventListener("focus", refreshTableManagerStatus);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshTableManagerStatus();
});

loadStats();
refreshTableManagerStatus();
window.setInterval(() => loadStats({ silent: true }), AUTO_REFRESH_MS);
window.setInterval(refreshTableManagerStatus, TABLE_MANAGER_REFRESH_MS);
