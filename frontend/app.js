const alphabetLetters = Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index));
const internalTreeSequenceLimit = 150;
const metalKtOptions = ["", "14KT", "10KT", "9KT", "18KT", "22KT", "Silver", "Plat"];
const colorOptions = ["", "White", "Yellow", "Pink"];
const fixedWhiteMetals = new Set(["Silver", "Plat"]);
const storageKey = "production-management-state-v1";
const kanbanStorageKey = "production-management-kanban-v1";
const kanbanWorkflowChangedEvent = "productionKanbanWorkflowChanged";
const castingRealtimeRefreshEvent = "productionCastingRealtimeRefresh";
const waxEntriesChangedEvent = "waxEntriesChanged";
const RBAC = window.ProductionRBAC;
const Inventory = window.ProductionInventory;
const Backend = window.CastingAPI;
const currentUser = RBAC
  ? RBAC.currentUser
  : {
      id: "anonymous",
      assignedRoleIds: [],
      roleIds: [],
      isActive: false
    };
const permissionDeniedMessage = "You do not have permission to perform this action.";

const appShell = document.querySelector("#appShell");
const loginRoot = document.querySelector("#loginRoot");
const authUserName = document.querySelector("#authUserName");
const liveSyncStatus = document.querySelector("#liveSyncStatus");
const logoutButton = document.querySelector("#logoutButton");
const entryRows = document.querySelector("#entryRows");
const exportCsvButton = document.querySelector("#exportCsvButton");
const rowCount = document.querySelector("#rowCount");
const saveStatus = document.querySelector("#saveStatus");
const submitEntryButton = document.querySelector("#submitEntryButton");
const inHouseProductionInput = document.querySelector("#inHouseProductionInput");
const clearFiltersButton = document.querySelector("#clearFiltersButton");
const todayDateButton = document.querySelector("#todayDateButton");
const copyLastVendorButton = document.querySelector("#copyLastVendorButton");
const copyLastInvoiceButton = document.querySelector("#copyLastInvoiceButton");
const printArea = document.querySelector("#printArea");
const metalReceivingRoot = document.querySelector("#metalReceivingRoot");
const inventoryRoot = document.querySelector("#inventoryRoot");
const invoicingRoot = document.querySelector("#invoicingRoot");
const roleManagementRoot = document.querySelector("#roleManagementRoot");
const userManagementRoot = document.querySelector("#userManagementRoot");
const auditLogsRoot = document.querySelector("#auditLogsRoot");
const vendorCustomerNameSuggestions = document.querySelector("#vendorCustomerNameSuggestions");
const waxInvoiceNoSuggestions = document.querySelector("#waxInvoiceNoSuggestions");
const moduleTabs = document.querySelectorAll("[data-module-target]");
const modulePanels = document.querySelectorAll("[data-module-panel]");
const moduleScopedElements = document.querySelectorAll("[data-visible-module]");
const moduleResourceByPanel = {
  auditLogsModule: { id: "auditLogs", type: "system" },
  invoicingModule: { id: "invoicing", type: "module" },
  inventoryModule: { id: "inventory", type: "module" },
  metalReceivingModule: { id: "metalReceiving", type: "module" },
  roleManagementModule: { id: "roles", type: "system" },
  secondModule: { id: "castingProcess", type: "module" },
  userManagementModule: { id: "users", type: "system" },
  waxEntriesModule: { id: "waxEntries", type: "module" }
};

const formFields = {
  vendorCustomerName: document.querySelector("#vendorCustomerNameInput"),
  date: document.querySelector("#dateInput"),
  waxInvoiceNo: document.querySelector("#waxInvoiceNoInput"),
  waxWeight: document.querySelector("#waxWeightInput"),
  customerVendorTreeNo: document.querySelector("#customerVendorTreeNoInput"),
  metalKt: document.querySelector("#metalKtInput"),
  color: document.querySelector("#colorInput"),
  internalTreeNumber: document.querySelector("#internalTreeNumberInput")
};

const filterFields = {
  vendorCustomerName: document.querySelector("#vendorCustomerNameFilter"),
  date: document.querySelector("#dateFilter"),
  waxInvoiceNo: document.querySelector("#waxInvoiceNoFilter"),
  waxWeight: document.querySelector("#waxWeightFilter"),
  customerVendorTreeNo: document.querySelector("#customerVendorTreeNoFilter"),
  metalKt: document.querySelector("#metalKtFilter"),
  color: document.querySelector("#colorFilter"),
  internalTreeNumber: document.querySelector("#internalTreeNumberFilter")
};

let state = loadState();
let saveTimer = null;
let sessionTimer = null;
let liveSyncUnsubscribe = null;
let liveSyncRefreshTimer = null;
let liveSyncDeferredTimer = null;
let liveSyncMessageTimer = null;
let liveSyncPendingSelfOnly = true;
let liveSyncRefreshInFlight = false;
let waxEntriesRemoteLoadStarted = false;
let editingEntryId = null;
let selectedRoleId = "role_admin";
let selectedUserId = "user_admin";
let auditFilters = {
  action: "",
  barcodeValue: "",
  dateFrom: "",
  dateTo: "",
  internalTreeNumber: "",
  module: "",
  stage: "",
  user: ""
};
let inventoryFilters = {
  barcodeValue: "",
  dateFrom: "",
  dateTo: "",
  internalTreeNumber: "",
  metalKtColor: "",
  metalType: "",
  transactionType: ""
};
const liveSyncDebounceMs = 800;
const liveSyncDeferredMs = 1500;
const liveSyncTables = [
  "wax_entries",
  "casting_orders",
  "order_stage_history",
  "awaiting_metal_submissions",
  "ready_for_casting_submissions",
  "casting_completed_submissions",
  "quality_check_submissions",
  "order_completed_submissions",
  "damaged_trees",
  "metal_receiving_entries",
  "inventory_ledger",
  "inventory_postings",
  "inventory_balances",
  "audit_logs",
  "users",
  "user_roles",
  "roles",
  "role_permissions"
];
const liveSyncGroupsByTable = {
  audit_logs: ["audit"],
  awaiting_metal_submissions: ["casting"],
  casting_completed_submissions: ["casting"],
  casting_orders: ["casting"],
  damaged_trees: ["casting"],
  inventory_balances: ["inventory"],
  inventory_ledger: ["inventory"],
  inventory_postings: ["inventory"],
  metal_receiving_entries: ["inventory", "metalReceiving"],
  order_completed_submissions: ["casting"],
  order_stage_history: ["casting"],
  quality_check_submissions: ["casting"],
  ready_for_casting_submissions: ["casting"],
  roles: ["rbac"],
  role_permissions: ["rbac"],
  user_roles: ["rbac"],
  users: ["rbac"],
  wax_entries: ["wax", "casting"]
};
const liveSyncGroupsByPanel = {
  auditLogsModule: "audit",
  inventoryModule: "inventory",
  metalReceivingModule: "metalReceiving",
  roleManagementModule: "rbac",
  secondModule: "casting",
  userManagementModule: "rbac",
  waxEntriesModule: "wax"
};
const liveSyncPendingTables = new Set();

function createBlankEntry() {
  return {
    id: createId(),
    vendorCustomerName: "",
    date: "",
    waxInvoiceNo: "",
    waxWeight: "",
    customerVendorTreeNo: "",
    metalKt: "",
    color: "",
    internalTreeNumber: "",
    barcodeValue: "",
    isInHouseProduction: false,
    isRush: false
  };
}

function createId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }

  return `entry-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createInitialState() {
  return {
    entries: [],
    internalTreeSequences: {}
  };
}

function canPerform(action, resource) {
  return RBAC ? RBAC.can(currentUser, action, resource) : true;
}

function canUseModule(moduleId, action = "view") {
  return RBAC ? RBAC.hasModulePermission(currentUser, moduleId, action) : true;
}

function canManageRoles() {
  return canPerform("manage", { id: "roles", type: "system" });
}

function canManageUsers() {
  return canPerform("manage", { id: "users", type: "system" });
}

function canAssignRoles() {
  return canPerform("assign", { id: "roles", type: "system" });
}

function getUserRoleIds(user) {
  return new Set(
    [...(user?.assignedRoleIds || []), ...(user?.roleIds || [])].map((roleId) =>
      roleId === "admin" ? "role_admin" : roleId
    )
  );
}

function isAdminUser(user) {
  return getUserRoleIds(user).has("role_admin");
}

function getAdminUserCount() {
  return RBAC ? RBAC.getUsers().filter((user) => isAdminUser(user)).length : 0;
}

function canDeleteUserAccount(user) {
  if (!user || !canManageUsers() || !isAdminUser(currentUser)) return false;
  if (user.id === currentUser.id) return false;
  if (isAdminUser(user) && getAdminUserCount() <= 1) return false;
  return true;
}

function canViewAuditLogs() {
  return canPerform("view", { id: "auditLogs", type: "system" });
}

function canExportAuditLogs() {
  return canPerform("export", { id: "auditLogs", type: "system" });
}

function canDownloadKtFormulaTable() {
  return canViewAuditLogs() || canExportAuditLogs();
}

function canViewInventoryLedger() {
  return canPerform("view", { id: "inventoryLedger", type: "system" });
}

function canExportInventoryLedger() {
  return canViewInventoryLedger() && canPerform("export", { id: "inventoryLedger", type: "system" });
}

function canMarkRush() {
  return canPerform("markRush", { id: "markRush", type: "special" });
}

function getPanelAccess(panelId) {
  const resource = moduleResourceByPanel[panelId];

  if (!resource) {
    return true;
  }

  if (resource.type === "system") {
    if (resource.id === "roles") return canManageRoles();
    if (resource.id === "users") return canManageUsers();
    if (resource.id === "auditLogs") return canViewAuditLogs();
    return canPerform("view", resource);
  }

  return canUseModule(resource.id);
}

function showAccessMessage(message, details = {}) {
  if (saveStatus) {
    saveStatus.textContent = message;
  }

  if (message === permissionDeniedMessage) {
    recordAudit("Unauthorized access attempt", {
      module: details.module || getActiveModuleLabel(),
      notes: details.notes || ""
    });
  }
}

function recordAudit(action, details = {}) {
  if (!RBAC) return;

  RBAC.recordAuditLog({
    action,
    user: currentUser,
    ...details
  });
}

function useAuth() {
  if (RBAC?.hydrateSession) {
    RBAC.hydrateSession();
  }

  return {
    isAuthenticated: RBAC ? RBAC.isAuthenticated() : true,
    user: RBAC ? RBAC.getCurrentUser() : currentUser
  };
}

function AuthProvider() {
  renderAuthState();
}

function ProtectedRoute(panelId) {
  return getPanelAccess(panelId);
}

const permissionUtils = {
  can: canPerform,
  hasModulePermission: canUseModule,
  hasSystemPermission: canPerform
};

const auditLogger = {
  record: recordAudit
};

function getActiveModuleLabel() {
  const activePanel = getActiveModulePanel();
  if (!activePanel) return "";

  return getModuleLabel(activePanel.id);
}

function getActiveModulePanel() {
  return Array.from(modulePanels).find((panel) => !panel.hidden) || null;
}

function getActiveModuleId() {
  return getActiveModulePanel()?.id || "";
}

function getModuleLabel(panelId) {
  const labels = {
    auditLogsModule: "Audit Logs",
    invoicingModule: "Invoicing",
    inventoryModule: "Inventory",
    metalReceivingModule: "Metal Receiving",
    roleManagementModule: "Role Management",
    secondModule: "Casting Process",
    userManagementModule: "User Management",
    waxEntriesModule: "Wax Entries"
  };

  return labels[panelId] || panelId || "";
}

function setLiveSyncStatus(state, message = "") {
  if (!liveSyncStatus) return;

  const statusMessages = {
    connected: "Live sync connected",
    offline: "Live sync offline",
    reconnecting: "Live sync reconnecting"
  };

  window.clearTimeout(liveSyncMessageTimer);
  liveSyncStatus.dataset.syncState = state;
  liveSyncStatus.textContent = message || statusMessages[state] || statusMessages.offline;
}

function canUseLiveSync() {
  return Boolean(Backend?.isConfigured?.() && Backend?.subscribeToRealtimeChanges && RBAC?.isAuthenticated?.());
}

function startLiveSync() {
  if (liveSyncUnsubscribe || !canUseLiveSync()) {
    if (!canUseLiveSync()) {
      setLiveSyncStatus("offline");
    }
    return;
  }

  try {
    setLiveSyncStatus("reconnecting");
    liveSyncUnsubscribe = Backend.subscribeToRealtimeChanges(liveSyncTables, handleLiveSyncPayload, handleLiveSyncStatus);
  } catch (error) {
    console.warn("Backend realtime subscription failed. App will keep working without live sync.", error);
    liveSyncUnsubscribe = null;
    setLiveSyncStatus("offline");
  }
}

function stopLiveSync() {
  window.clearTimeout(liveSyncRefreshTimer);
  window.clearTimeout(liveSyncDeferredTimer);
  window.clearTimeout(liveSyncMessageTimer);
  liveSyncRefreshTimer = null;
  liveSyncDeferredTimer = null;
  liveSyncMessageTimer = null;
  liveSyncPendingTables.clear();
  liveSyncPendingSelfOnly = true;

  if (liveSyncUnsubscribe) {
    liveSyncUnsubscribe();
    liveSyncUnsubscribe = null;
  } else if (Backend?.unsubscribeFromRealtimeChanges) {
    Backend.unsubscribeFromRealtimeChanges();
  }

  setLiveSyncStatus("offline");
}

function handleLiveSyncStatus(status) {
  if (status === "SUBSCRIBED") {
    setLiveSyncStatus("connected");
    return;
  }

  if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
    setLiveSyncStatus("reconnecting");
    return;
  }

  if (status === "CLOSED") {
    setLiveSyncStatus("offline");
    liveSyncUnsubscribe = null;
    return;
  }

  setLiveSyncStatus("reconnecting");
}

function handleLiveSyncPayload(payload = {}) {
  const table = String(payload.table || "").trim();
  if (!table || !liveSyncGroupsByTable[table]) return;

  liveSyncPendingTables.add(table);
  liveSyncPendingSelfOnly = liveSyncPendingSelfOnly && isCurrentUserRealtimePayload(payload);
  window.clearTimeout(liveSyncRefreshTimer);
  liveSyncRefreshTimer = window.setTimeout(processLiveSyncRefresh, liveSyncDebounceMs);
}

function isCurrentUserRealtimePayload(payload = {}) {
  const row = payload.new || payload.old || {};
  const currentUserId = String(currentUser?.id || "");
  if (!currentUserId) return false;

  return [
    row.actor_user_id,
    row.created_by,
    row.posted_by,
    row.submitted_by,
    row.user_id
  ]
    .map((value) => String(value || ""))
    .some((value) => value === currentUserId);
}

async function processLiveSyncRefresh() {
  if (liveSyncRefreshInFlight || !canUseLiveSync()) return;

  const tables = Array.from(liveSyncPendingTables);
  if (!tables.length) return;

  const groups = getLiveSyncGroups(tables);
  if (shouldDeferLiveSyncRefresh(groups)) {
    window.clearTimeout(liveSyncDeferredTimer);
    liveSyncDeferredTimer = window.setTimeout(processLiveSyncRefresh, liveSyncDeferredMs);
    return;
  }

  const selfOnly = liveSyncPendingSelfOnly;
  liveSyncPendingTables.clear();
  liveSyncPendingSelfOnly = true;
  liveSyncRefreshInFlight = true;

  try {
    if (groups.has("wax")) {
      await ensureWaxEntriesLoadedFromBackend({ force: true });
    }

    if (groups.has("casting")) {
      window.dispatchEvent(new CustomEvent(castingRealtimeRefreshEvent, { detail: { source: "realtime" } }));
    }

    if (groups.has("inventory") || groups.has("metalReceiving")) {
      await ensureInventoryLoadedFromBackend({ force: true });
    }

    if (groups.has("audit") && getActiveModuleId() === "auditLogsModule") {
      await RBAC?.refreshBackendAuditLogs?.();
    }

    if (groups.has("rbac")) {
      await Promise.all([RBAC?.refreshBackendUsers?.(), RBAC?.refreshBackendState?.()]);
      syncModuleAccess();
      syncActionAccess();
    }

    if (!selfOnly) {
      showLiveSyncUpdateMessage(groups);
    }
  } catch (error) {
    console.warn("Backend live sync refresh failed. App state will update on the next refresh.", error);
  } finally {
    liveSyncRefreshInFlight = false;
    if (liveSyncPendingTables.size) {
      window.clearTimeout(liveSyncRefreshTimer);
      liveSyncRefreshTimer = window.setTimeout(processLiveSyncRefresh, liveSyncDebounceMs);
    }
  }
}

function getLiveSyncGroups(tables) {
  const groups = new Set();

  tables.forEach((table) => {
    (liveSyncGroupsByTable[table] || []).forEach((group) => groups.add(group));
  });

  return groups;
}

function shouldDeferLiveSyncRefresh(groups) {
  const activePanelId = getActiveModuleId();
  const activeGroup = liveSyncGroupsByPanel[activePanelId];
  if (!activeGroup || !groups.has(activeGroup)) return false;

  const activeElement = document.activeElement;
  const activePanel = document.getElementById(activePanelId);
  return Boolean(
    activePanel &&
      activeElement &&
      activePanel.contains(activeElement) &&
      activeElement.matches("input, textarea, select, [contenteditable='true']")
  );
}

function showLiveSyncUpdateMessage(groups) {
  const activePanelId = getActiveModuleId();
  const message = "Updated from another user";

  if (liveSyncStatus?.dataset.syncState === "connected") {
    liveSyncStatus.textContent = message;
    window.clearTimeout(liveSyncMessageTimer);
    liveSyncMessageTimer = window.setTimeout(() => {
      setLiveSyncStatus("connected");
    }, 2200);
  }

  if (activePanelId === "waxEntriesModule" && groups.has("wax")) {
    saveStatus.textContent = message;
    return;
  }

  if (activePanelId === "metalReceivingModule" && groups.has("metalReceiving")) {
    setMetalReceivingStatus(message);
    return;
  }

  if (activePanelId === "roleManagementModule" && groups.has("rbac")) {
    setRoleStatus(message);
    return;
  }

  if (activePanelId === "userManagementModule" && groups.has("rbac")) {
    setUserStatus(message);
  }
}

function getDefaultModuleId() {
  const firstAllowedTab = Array.from(moduleTabs).find((tab) => ProtectedRoute(tab.dataset.moduleTarget));
  return firstAllowedTab?.dataset.moduleTarget || "";
}

function loadState() {
  return createInitialState();
}

function normalizeEntry(entry) {
  const metalKt = entry.metalKt || "";
  const internalTreeNumber = getInternalTreeNumber(entry);
  const barcodeValue = getBarcodeValue({ ...entry, internalTreeNumber });

  return {
    id: entry.id || createId(),
    internalTreeNumber,
    barcodeValue,
    vendorCustomerName: entry.vendorCustomerName || "",
    date: entry.date || "",
    waxInvoiceNo: entry.waxInvoiceNo || "",
    waxWeight: entry.waxWeight || "",
    customerVendorTreeNo: entry.customerVendorTreeNo || "",
    metalKt,
    color: getColorForMetal(metalKt, entry.color || ""),
    isInHouseProduction: Boolean(entry.isInHouseProduction),
    isRush: Boolean(entry.isRush),
    createdAt: entry.createdAt || "",
    updatedAt: entry.updatedAt || "",
    createdBy: entry.createdBy || ""
  };
}

function hasEntryData(entry) {
  return Object.entries(entry).some(
    ([key, value]) =>
      !["id", "createdAt", "createdBy", "isRush", "isInHouseProduction", "updatedAt"].includes(key) &&
      String(value || "").trim()
  );
}

function getInternalTreeNumber(entry = {}) {
  const existingValue = String(entry.internalTreeNumber || "").trim().toUpperCase();
  if (existingValue) return existingValue;

  const prefix = getInternalTreePrefix(entry);
  const sequence = getInternalTreeSequence(entry);
  return prefix && sequence ? `${prefix}-${sequence}` : "";
}

function getInternalTreePrefix(entry = {}, parsedParts = null) {
  return String(entry.internalTreePrefix || entry.alphabet || parsedParts?.prefix || "")
    .trim()
    .toUpperCase();
}

function getInternalTreeSequence(entry = {}, parsedParts = null) {
  return String(entry.internalTreeSequence || entry.number || parsedParts?.sequence || "").trim();
}

function parseInternalTreeNumber(value) {
  const [prefix, sequence] = String(value || "")
    .trim()
    .toUpperCase()
    .split("-");

  return {
    prefix: prefix || "",
    sequence: sequence || ""
  };
}

function normalizeInternalTreeSequences(storedSequences = {}, entries = []) {
  const sequences = {};

  Object.entries(storedSequences || {}).forEach(([prefix, sequence]) => {
    const normalizedPrefix = normalizeInternalTreePrefix(prefix);
    const numericSequence = getSequenceNumber(sequence);
    if (normalizedPrefix && numericSequence > 0) {
      sequences[normalizedPrefix] = numericSequence;
    }
  });

  entries.forEach((entry) => {
    const internalTreeNumber = getInternalTreeNumber(entry);
    const treeParts = parseInternalTreeNumber(internalTreeNumber);
    const prefix = getInternalTreePrefix(entry, treeParts);
    const sequence = getSequenceNumber(getInternalTreeSequence(entry, treeParts));
    if (prefix && sequence > (sequences[prefix] || 0)) {
      sequences[prefix] = sequence;
    }
  });

  return sequences;
}

function normalizeInternalTreePrefix(value) {
  return String(value || "").trim().toUpperCase();
}

function getPrefixSortIndex(prefix) {
  const match = normalizeInternalTreePrefix(prefix).match(/^([A-Z])(\d*)$/);
  if (!match) return -1;

  const letterIndex = alphabetLetters.indexOf(match[1]);
  if (letterIndex === -1) return -1;

  const cycle = match[2] ? Number.parseInt(match[2], 10) : 0;
  return Number.isFinite(cycle) && cycle >= 0 ? cycle * alphabetLetters.length + letterIndex : -1;
}

function getPrefixFromSortIndex(index) {
  const safeIndex = Math.max(0, Number.isFinite(index) ? index : 0);
  const letter = alphabetLetters[safeIndex % alphabetLetters.length];
  const cycle = Math.floor(safeIndex / alphabetLetters.length);
  return cycle === 0 ? letter : `${letter}${cycle}`;
}

function getSequenceNumber(value) {
  const sequence = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(sequence) && sequence > 0 ? sequence : 0;
}

function populateDropdowns() {
  formFields.metalKt.innerHTML = renderSelectOptions(metalKtOptions, "");
  formFields.color.innerHTML = renderSelectOptions(colorOptions, "");
  syncColorControl(formFields.metalKt, formFields.color);
}

function getLastInternalTreePosition() {
  return Object.entries(state.internalTreeSequences || {}).reduce(
    (latestPosition, [prefix, sequence]) => {
      const prefixIndex = getPrefixSortIndex(prefix);
      const normalizedSequence = getSequenceNumber(sequence);
      if (prefixIndex < 0 || normalizedSequence <= 0) return latestPosition;

      if (
        prefixIndex > latestPosition.prefixIndex ||
        (prefixIndex === latestPosition.prefixIndex && normalizedSequence > latestPosition.sequence)
      ) {
        return {
          prefixIndex,
          sequence: normalizedSequence
        };
      }

      return latestPosition;
    },
    { prefixIndex: 0, sequence: 0 }
  );
}

function generateInternalTreeNumber() {
  state.internalTreeSequences = normalizeInternalTreeSequences(state.internalTreeSequences, state.entries);
  const lastPosition = getLastInternalTreePosition();
  const nextPosition =
    lastPosition.sequence >= internalTreeSequenceLimit
      ? { prefixIndex: lastPosition.prefixIndex + 1, sequence: 1 }
      : { prefixIndex: lastPosition.prefixIndex, sequence: lastPosition.sequence + 1 };
  const prefix = getPrefixFromSortIndex(nextPosition.prefixIndex);

  state.internalTreeSequences = {
    ...(state.internalTreeSequences || {}),
    [prefix]: nextPosition.sequence
  };

  return {
    internalTreeNumber: `${prefix}-${nextPosition.sequence}`
  };
}

function generateUniqueBarcodeFields(entry) {
  let attempts = 0;

  while (attempts < 1000) {
    attempts += 1;
    const generatedTree = generateInternalTreeNumber();
    const barcodeValue = buildBarcodeValue(entry.date, generatedTree.internalTreeNumber);

    if (barcodeValue && !hasDuplicateBarcodeValue(barcodeValue)) {
      return {
        ...generatedTree,
        barcodeValue
      };
    }
  }

  return null;
}

function buildBarcodeValue(date, internalTreeNumber) {
  const dateCode = getBarcodeDate(date);
  const treeNumber = String(internalTreeNumber || "").trim().toUpperCase();
  return dateCode && treeNumber ? normalizeBarcodeValue(`${dateCode}-${treeNumber}`) : "";
}

function getBarcodeValue(entry = {}) {
  const existingValue = normalizeBarcodeValue(entry.barcodeValue);
  if (existingValue) return existingValue;

  return buildBarcodeValue(entry.date, getInternalTreeNumber(entry));
}

function normalizeBarcodeValue(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9-]/g, "");
}

function normalizeBarcodeSearch(value) {
  return normalizeBarcodeValue(value).replace(/[^A-Z0-9]/g, "");
}

function hasDuplicateBarcodeValue(barcodeValue, excludedEntryId = "") {
  const searchValue = normalizeBarcodeSearch(barcodeValue);
  if (!searchValue) return false;

  return state.entries.some(
    (entry) => entry.id !== excludedEntryId && normalizeBarcodeSearch(getBarcodeValue(entry)) === searchValue
  );
}

const code128Patterns = [
  "212222",
  "222122",
  "222221",
  "121223",
  "121322",
  "131222",
  "122213",
  "122312",
  "132212",
  "221213",
  "221312",
  "231212",
  "112232",
  "122132",
  "122231",
  "113222",
  "123122",
  "123221",
  "223211",
  "221132",
  "221231",
  "213212",
  "223112",
  "312131",
  "311222",
  "321122",
  "321221",
  "312212",
  "322112",
  "322211",
  "212123",
  "212321",
  "232121",
  "111323",
  "131123",
  "131321",
  "112313",
  "132113",
  "132311",
  "211313",
  "231113",
  "231311",
  "112133",
  "112331",
  "132131",
  "113123",
  "113321",
  "133121",
  "313121",
  "211331",
  "231131",
  "213113",
  "213311",
  "213131",
  "311123",
  "311321",
  "331121",
  "312113",
  "312311",
  "332111",
  "314111",
  "221411",
  "431111",
  "111224",
  "111422",
  "121124",
  "121421",
  "141122",
  "141221",
  "112214",
  "112412",
  "122114",
  "122411",
  "142112",
  "142211",
  "241211",
  "221114",
  "413111",
  "241112",
  "134111",
  "111242",
  "121142",
  "121241",
  "114212",
  "124112",
  "124211",
  "411212",
  "421112",
  "421211",
  "212141",
  "214121",
  "412121",
  "111143",
  "111341",
  "131141",
  "114113",
  "114311",
  "411113",
  "411311",
  "113141",
  "114131",
  "311141",
  "411131",
  "211412",
  "211214",
  "211232",
  "2331112"
];

function getCode128BCodePoints(value) {
  const text = normalizeBarcodeValue(value);
  if (!text) return [];

  const startCode = 104;
  const codes = [startCode];
  let checksum = startCode;

  for (let index = 0; index < text.length; index += 1) {
    const charCode = text.charCodeAt(index);
    if (charCode < 32 || charCode > 126) {
      return [];
    }

    const codeValue = charCode - 32;
    codes.push(codeValue);
    checksum += codeValue * (index + 1);
  }

  codes.push(checksum % 103, 106);
  return codes;
}

function renderCode128Svg(value, className = "barcode-svg", height = 48) {
  const barcodeValue = normalizeBarcodeValue(value);
  const codePoints = getCode128BCodePoints(barcodeValue);
  if (!codePoints.length) return "";

  const quietZone = 10;
  let x = quietZone;
  const rects = [];

  codePoints.forEach((codePoint) => {
    const pattern = code128Patterns[codePoint] || "";
    Array.from(pattern).forEach((widthValue, index) => {
      const width = Number(widthValue);
      if (index % 2 === 0) {
        rects.push(`<rect x="${x}" y="0" width="${width}" height="${height}"></rect>`);
      }
      x += width;
    });
  });

  const totalWidth = x + quietZone;
  return `
    <svg class="${escapeAttribute(className)}" viewBox="0 0 ${totalWidth} ${height}" preserveAspectRatio="none" role="img" aria-label="Code 128 barcode ${escapeAttribute(barcodeValue)}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${totalWidth}" height="${height}" fill="#ffffff"></rect>
      <g fill="#000000">${rects.join("")}</g>
    </svg>
  `;
}

function scheduleSave(message = "Saved") {
  saveStatus.textContent = "Saving...";
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    writeLocalWaxEntriesState();
    saveStatus.textContent = message;
  }, 180);
}

function writeLocalWaxEntriesState() {
  emitWaxEntriesChanged();
}

function emitWaxEntriesChanged() {
  window.dispatchEvent(
    new CustomEvent(waxEntriesChangedEvent, {
      detail: {
        entries: state.entries
      }
    })
  );
}

function canUseBackendWaxEntries() {
  return Boolean(Backend?.isConfigured?.() && RBAC?.isAuthenticated?.());
}

async function ensureWaxEntriesLoadedFromBackend(options = {}) {
  if (!canUseBackendWaxEntries()) return false;
  if (waxEntriesRemoteLoadStarted && !options.force) return false;

  waxEntriesRemoteLoadStarted = true;

  try {
    const entries = await Backend.fetchWaxEntries();
    const normalizedEntries = entries.map(normalizeEntry).filter(hasEntryData);

    state = {
      ...state,
      entries: normalizedEntries,
      internalTreeSequences: normalizeInternalTreeSequences(state.internalTreeSequences, normalizedEntries)
    };

    writeLocalWaxEntriesState();
    renderRows();
    renderSuggestions();
    updateRowCount();
    syncActionAccess();
    return true;
  } catch (error) {
    console.warn("Backend Wax Entries load failed.", error);
    return false;
  }
}

async function persistWaxEntryToBackend(entry, options = {}) {
  if (!canUseBackendWaxEntries()) return null;

  try {
    const savedEntry = normalizeEntry(await Backend.saveWaxEntry(entry, currentUser));
    if (options.ensureCastingOrder && Backend.ensureCastingOrderForWaxEntry) {
      await Backend.ensureCastingOrderForWaxEntry(savedEntry, currentUser).catch((error) => {
        console.warn("Backend Casting Order creation failed for Wax Entry.", error);
      });
    }
    replaceWaxEntry(entry.id, savedEntry);
    writeLocalWaxEntriesState();
    render();
    return savedEntry;
  } catch (error) {
    console.warn("Backend Wax Entry save failed.", error);
    saveStatus.textContent = "Saved locally - Backend unavailable";
    return null;
  }
}

async function deleteWaxEntryFromBackend(entry) {
  if (!canUseBackendWaxEntries() || !entry) return;

  try {
    await Backend.deleteWaxEntry(entry);
  } catch (error) {
    console.warn("Backend Wax Entry delete failed. Local fallback state was updated.", error);
    saveStatus.textContent = "Deleted locally - Backend unavailable";
  }
}

async function ensureInventoryLoadedFromBackend(options = {}) {
  if (!Inventory?.ensureBackendInventoryLoaded) return;

  try {
    const loaded = await Inventory.ensureBackendInventoryLoaded(options);
    if (loaded) {
      renderMetalReceiving();
      renderInventory();
    }
    return loaded;
  } catch (error) {
    console.warn("Backend Inventory load failed.", error);
    return false;
  }
}

function replaceWaxEntry(previousEntryId, nextEntry) {
  const normalizedEntry = normalizeEntry(nextEntry);
  const existingIndex = state.entries.findIndex(
    (entry) => entry.id === previousEntryId || entry.id === normalizedEntry.id || entry.barcodeValue === normalizedEntry.barcodeValue
  );

  if (existingIndex === -1) {
    state.entries.unshift(normalizedEntry);
    return;
  }

  state.entries[existingIndex] = normalizedEntry;
}

function renderAuthState() {
  const { isAuthenticated, user } = useAuth();

  if (loginRoot) {
    loginRoot.hidden = isAuthenticated;
  }

  if (appShell) {
    appShell.hidden = !isAuthenticated;
  }

  if (!isAuthenticated) {
    LoginPage();
    window.clearTimeout(sessionTimer);
    waxEntriesRemoteLoadStarted = false;
    stopLiveSync();
    return;
  }

  if (authUserName) {
    authUserName.textContent = user?.name || user?.email || "Signed in";
  }

  render();
  ensureWaxEntriesLoadedFromBackend();
  ensureInventoryLoadedFromBackend();
  startLiveSync();
  scheduleSessionExpiry();

  const activePanelId = Array.from(modulePanels).find((panel) => !panel.hidden)?.id || "";
  const defaultModuleId = getDefaultModuleId();

  if (defaultModuleId && (!activePanelId || !ProtectedRoute(activePanelId))) {
    switchModule(defaultModuleId);
  }
}

function LoginPage(message = "") {
  if (!loginRoot) return;

  loginRoot.innerHTML = `
    <div class="login-card">
      <div class="login-heading">
        <p class="eyebrow">Production Management</p>
        <h1>Sign in</h1>
      </div>
      <form class="login-form" data-login-form>
        <label>
          <span>Email / Username</span>
          <input type="text" data-login-username autocomplete="username" required>
        </label>
        <label>
          <span>Password</span>
          <div class="password-control">
            <input type="password" data-login-password autocomplete="current-password" required>
            <button type="button" data-toggle-password title="Show password" aria-label="Show password">Show</button>
          </div>
        </label>
        <p class="form-message" data-login-message aria-live="polite">${escapeHtml(message)}</p>
        <button class="button" type="submit">Login</button>
        <p class="login-note">Development default admin is available. Change it before production.</p>
      </form>
    </div>
  `;
}

function scheduleSessionExpiry() {
  window.clearTimeout(sessionTimer);

  if (!RBAC?.getSession) return;

  const session = RBAC.getSession();
  if (!session?.expiresAt) return;

  const expiresIn = new Date(session.expiresAt).getTime() - Date.now();
  if (expiresIn <= 0) {
    RBAC.logout({ reason: "Session expired" });
    return;
  }

  sessionTimer = window.setTimeout(() => {
    RBAC.logout({ reason: "Session expired" });
    renderAuthState();
  }, Math.min(expiresIn, 2147483647));
}

function switchModule(targetId) {
  if (!getPanelAccess(targetId)) {
    showAccessMessage(permissionDeniedMessage, {
      module: getModuleLabel(targetId)
    });
    return;
  }

  modulePanels.forEach((panel) => {
    panel.hidden = panel.id !== targetId;
  });

  moduleTabs.forEach((tab) => {
    const isActive = tab.dataset.moduleTarget === targetId;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
  });

  moduleScopedElements.forEach((element) => {
    element.hidden = element.dataset.visibleModule !== targetId;
  });

  if (targetId === "secondModule") {
    emitWaxEntriesChanged();
  }

  if (targetId === "waxEntriesModule") {
    renderRows();
  }

  if (targetId === "auditLogsModule") {
    RBAC?.refreshBackendAuditLogs?.().catch?.((error) => {
      console.warn("Audit logs refresh failed.", error);
    });
  }

  if (targetId === "roleManagementModule" || targetId === "userManagementModule") {
    RBAC?.refreshBackendState?.().catch?.((error) => {
      console.warn("Role state refresh failed.", error);
    });
    RBAC?.refreshBackendUsers?.().catch?.((error) => {
      console.warn("User list refresh failed.", error);
    });
  }

  if (targetId === "inventoryModule" || targetId === "metalReceivingModule") {
    ensureInventoryLoadedFromBackend({ force: true }).catch?.((error) => {
      console.warn("Inventory refresh failed.", error);
    });
  }

  if (targetId === "invoicingModule") {
    window.ProductionInvoicing?.refresh?.().catch?.((error) => {
      console.warn("Invoicing refresh failed.", error);
    });
  }

  syncActionAccess();
}

function syncModuleAccess() {
  let firstAccessiblePanelId = "";
  let activePanelId = "";

  modulePanels.forEach((panel) => {
    if (!panel.hidden) {
      activePanelId = panel.id;
    }
  });

  moduleTabs.forEach((tab) => {
    const panelId = tab.dataset.moduleTarget;
    const hasAccess = getPanelAccess(panelId);
    tab.hidden = !hasAccess;
    tab.disabled = !hasAccess;

    const panel = document.getElementById(panelId);
    if (panel && !hasAccess) {
      panel.hidden = true;
    }

    if (hasAccess && !firstAccessiblePanelId) {
      firstAccessiblePanelId = panelId;
    }
  });

  if (activePanelId && !getPanelAccess(activePanelId) && firstAccessiblePanelId) {
    switchModule(firstAccessiblePanelId);
  }

  const visiblePanelId = Array.from(modulePanels).find((panel) => !panel.hidden)?.id || "";
  moduleScopedElements.forEach((element) => {
    element.hidden = element.dataset.visibleModule !== visiblePanelId || !getPanelAccess(element.dataset.visibleModule);
  });
}

function syncActionAccess() {
  const canCreateWax = canUseModule("waxEntries", "create");
  const canExportWax = canUseModule("waxEntries", "export");

  Object.entries(formFields).forEach(([fieldName, field]) => {
    field.disabled = fieldName === "internalTreeNumber" || !canCreateWax;
  });

  [todayDateButton, copyLastVendorButton, copyLastInvoiceButton, submitEntryButton, inHouseProductionInput].forEach((button) => {
    button.disabled = !canCreateWax;
  });

  todayDateButton.title = canCreateWax ? "Use today's date" : "Create permission required";
  copyLastVendorButton.title = canCreateWax ? "Copy last vendor/customer name" : "Create permission required";
  copyLastInvoiceButton.title = canCreateWax ? "Copy last wax invoice number" : "Create permission required";
  inHouseProductionInput.title = canCreateWax ? "Mark as In-House Production" : "Create permission required";
  submitEntryButton.title = canCreateWax ? "Submit entry" : "Create permission required";

  exportCsvButton.disabled = !canExportWax;
  exportCsvButton.title = canExportWax ? "Export CSV" : "Export permission required";
}

function render() {
  renderRows();
  renderSuggestions();
  updateRowCount();
  renderMetalReceiving();
  renderInventory();
  window.ProductionInvoicing?.render?.();
  renderRoleManagement();
  UserManagement();
  renderAuditLogs();
  syncModuleAccess();
  syncActionAccess();
}

function renderRows() {
  entryRows.innerHTML = "";
  const visibleEntries = getFilteredEntries();

  if (!state.entries.length) {
    const emptyRow = document.createElement("tr");
    emptyRow.className = "data-row-empty";
    emptyRow.innerHTML = `<td colspan="9">No submitted entries yet.</td>`;
    entryRows.appendChild(emptyRow);
    return;
  }

  if (!visibleEntries.length) {
    const emptyRow = document.createElement("tr");
    emptyRow.className = "data-row-empty";
    emptyRow.innerHTML = `<td colspan="9">No entries match the current filters.</td>`;
    entryRows.appendChild(emptyRow);
    return;
  }

  visibleEntries.forEach((entry, index) => {
    const row = document.createElement("tr");
    const isEditing = entry.id === editingEntryId;
    row.className = `${isEditing ? "data-row editing-row" : "data-row"}${entry.isRush ? " rush-row" : ""}`;
    row.dataset.entryId = entry.id;
    row.innerHTML = isEditing ? renderEditableRow(entry, index) : renderReadonlyRow(entry, index);

    entryRows.appendChild(row);
  });
}

function getFilteredEntries() {
  const filters = getFilters();
  return state.entries.filter((entry) => matchesFilters(entry, filters));
}

function getFilters() {
  return Object.fromEntries(
    Object.entries(filterFields).map(([field, input]) => [field, input.value.trim().toLowerCase()])
  );
}

function hasActiveFilters() {
  return Object.values(getFilters()).some(Boolean);
}

function matchesFilters(entry, filters) {
  return Object.entries(filters).every(([field, filterValue]) => {
    if (!filterValue) return true;

    const rawValue = String(entry[field] || "").toLowerCase();
    const displayValue = field === "date" && entry.date ? formatDate(entry.date).toLowerCase() : rawValue;
    const barcodeValue = field === "internalTreeNumber" ? getBarcodeValue(entry).toLowerCase() : "";
    return rawValue.includes(filterValue) || displayValue.includes(filterValue) || barcodeValue.includes(filterValue);
  });
}

function readKanbanWorkflowState() {
  return {};
}

function isEntryInventoryPosted(entryId) {
  return Boolean(readKanbanWorkflowState()[entryId]?.inventoryPosted);
}

function showInventoryLockedMessage(entryId, action) {
  const entry = state.entries.find((item) => item.id === entryId);
  saveStatus.textContent = "Order is locked after inventory posting";
  recordAudit("Unauthorized access attempt", {
    module: "Wax Entries",
    internalTreeNumber: entry ? getInternalTreeNumber(entry) : "",
    notes: `${action} blocked because inventory is posted`
  });
}

function updateRowCount() {
  const visibleCount = getFilteredEntries().length;
  const totalCount = state.entries.length;

  if (hasActiveFilters()) {
    rowCount.textContent = `${visibleCount} of ${totalCount} ${totalCount === 1 ? "row" : "rows"}`;
    return;
  }

  rowCount.textContent = `${totalCount} ${totalCount === 1 ? "row" : "rows"}`;
}

function renderRoleManagement() {
  if (!roleManagementRoot) return;

  if (!RBAC) {
    roleManagementRoot.innerHTML = '<section class="role-panel"><p class="role-status">RBAC is not available.</p></section>';
    return;
  }

  if (!canManageRoles()) {
    roleManagementRoot.innerHTML =
      '<section class="role-panel"><p class="role-status">You do not have permission to perform this action.</p></section>';
    return;
  }

  const roles = RBAC.getRoles();
  const selectedRole = selectedRoleId === null ? null : roles.find((role) => role.id === selectedRoleId) || roles[0] || null;
  if (selectedRole && selectedRoleId !== selectedRole.id) {
    selectedRoleId = selectedRole.id;
  }

  const permissions = new Set(selectedRole ? selectedRole.permissions : []);
  const roleName = selectedRole ? selectedRole.name : "";
  const roleDescription = selectedRole ? selectedRole.description : "";
  const isActive = selectedRole ? selectedRole.isActive !== false : true;
  const isAdminRole = selectedRole?.id === "role_admin" || selectedRole?.id === "admin";

  roleManagementRoot.innerHTML = `
    <section class="role-panel">
      <div class="section-heading">
        <div>
          <h2>Role Management</h2>
          <p class="role-status" data-role-message>Ready</p>
        </div>
        <button class="button button-secondary" type="button" data-new-role>New Role</button>
      </div>
      <div class="role-layout">
        <aside class="role-list" aria-label="Saved roles">
          ${roles
            .map(
              (role) => `
                <button class="role-list-item ${role.id === selectedRoleId ? "is-active" : ""}" type="button" data-select-role="${escapeAttribute(role.id)}">
                  <span>${escapeHtml(role.name)}</span>
                  <small>${role.isActive === false ? "Inactive" : "Active"} - ${role.permissions.length} permissions</small>
                </button>
              `
            )
            .join("")}
        </aside>
        <form class="role-form" data-role-form>
          <div class="role-form-grid">
            <label>
              <span>Role Name</span>
              <input type="text" data-role-name value="${escapeAttribute(roleName)}" placeholder="Casting User">
            </label>
            <label>
              <span>Status</span>
              <select data-role-active-status ${isAdminRole ? "disabled" : ""}>
                <option value="active" ${isActive ? "selected" : ""}>Active</option>
                <option value="inactive" ${!isActive ? "selected" : ""}>Inactive</option>
              </select>
            </label>
            <label>
              <span>Description</span>
              <textarea data-role-description placeholder="Describe what this role can do">${escapeHtml(roleDescription)}</textarea>
            </label>
          </div>
          ${renderPermissionMatrix(
            "Module-level permissions",
            RBAC.resources.modules,
            RBAC.resources.moduleActions,
            (module, action) => RBAC.permissionTokens.module(module.id, action.id),
            permissions,
            isAdminRole
          )}
          ${renderPermissionMatrix(
            "Casting Process stage-level permissions",
            RBAC.resources.stages,
            RBAC.resources.stageActions,
            (stage, action) => RBAC.permissionTokens.stage(stage.id, action.id),
            permissions,
            isAdminRole
          )}
          ${renderPermissionGroup(
            "Special permissions",
            RBAC.resources.specialPermissions.map((permission) => ({
              label: permission.label,
              token: permission.id
            })),
            permissions,
            isAdminRole
          )}
          <div class="role-actions">
            <button class="button" type="submit">${selectedRole ? "Save Role" : "Create Role"}</button>
            <button class="button button-secondary" type="button" data-delete-role ${!selectedRole || isAdminRole ? "disabled" : ""}>Delete Role</button>
          </div>
        </form>
      </div>
    </section>
  `;
}

function renderPermissionMatrix(title, rows, actions, tokenBuilder, selectedPermissions, isDisabled = false) {
  return `
    <section class="permission-matrix-section">
      <h3>${escapeHtml(title)}</h3>
      <div class="permission-matrix-scroll">
        <table class="permission-matrix">
          <thead>
            <tr>
              <th scope="col">Resource</th>
              ${actions.map((action) => `<th scope="col">${escapeHtml(action.label)}</th>`).join("")}
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (row) => `
                  <tr>
                    <th scope="row">${escapeHtml(row.label)}</th>
                    ${actions
                      .map((action) => {
                        const token = tokenBuilder(row, action);
                        return `
                          <td>
                            <label class="permission-check">
                              <input type="checkbox" value="${escapeAttribute(token)}" data-permission-token ${selectedPermissions.has(token) ? "checked" : ""} ${isDisabled ? "disabled" : ""}>
                              <span>${escapeHtml(action.label)}</span>
                            </label>
                          </td>
                        `;
                      })
                      .join("")}
                  </tr>
                `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderPermissionGroup(title, items, selectedPermissions, isDisabled = false) {
  return `
    <fieldset class="permission-group" ${isDisabled ? "disabled" : ""}>
      <legend>${escapeHtml(title)}</legend>
      ${items
        .map(
          (item) => `
            <label class="permission-option">
              <input type="checkbox" value="${escapeAttribute(item.token)}" data-permission-token ${selectedPermissions.has(item.token) ? "checked" : ""}>
              <span>${escapeHtml(item.label)}</span>
            </label>
          `
        )
        .join("")}
    </fieldset>
  `;
}

function saveRoleFromForm() {
  if (!roleManagementRoot || !canManageRoles()) return;

  const name = roleManagementRoot.querySelector("[data-role-name]")?.value.trim() || "";
  const description = roleManagementRoot.querySelector("[data-role-description]")?.value.trim() || "";
  const isActive = roleManagementRoot.querySelector("[data-role-active-status]")?.value !== "inactive";
  const permissions = Array.from(roleManagementRoot.querySelectorAll("[data-permission-token]:checked")).map(
    (input) => input.value
  );

  if (!name) {
    setRoleStatus("Enter a role name.");
    return;
  }

  const previousRole = selectedRoleId ? RBAC.getRole(selectedRoleId) : null;
  const savedRole = RBAC.saveRole({
    id: selectedRoleId || "",
    isActive,
    name,
    description,
    permissions
  });

  selectedRoleId = savedRole.id;
  renderRoleManagement();
  setRoleStatus("Role saved.");
  recordAudit(previousRole ? "Role edited" : "Role created", {
    module: "Role Management",
    oldValue: previousRole || "",
    newValue: savedRole
  });
}

function deleteSelectedRole() {
  if (!selectedRoleId || selectedRoleId === "role_admin" || selectedRoleId === "admin" || !canManageRoles()) return;

  const selectedRole = RBAC.getRole(selectedRoleId);
  if (!selectedRole) return;

  if (!window.confirm(`Delete role "${selectedRole.name}"?`)) {
    return;
  }

  const deleted = RBAC.deleteRole(selectedRoleId);
  selectedRoleId = "role_admin";
  renderRoleManagement();
  setRoleStatus(deleted ? "Role deleted." : "Role could not be deleted.");
  if (deleted) {
    recordAudit("Role deleted", {
      module: "Role Management",
      oldValue: selectedRole
    });
  }
}

function setRoleStatus(message) {
  const statusElement = roleManagementRoot?.querySelector("[data-role-message]");
  if (statusElement) {
    statusElement.textContent = message;
  }
}

function renderMetalReceiving() {
  if (!metalReceivingRoot) return;

  if (!Inventory) {
    metalReceivingRoot.innerHTML =
      '<section class="inventory-panel"><p class="role-status">Inventory is not available.</p></section>';
    return;
  }

  if (!canUseModule("metalReceiving", "view")) {
    metalReceivingRoot.innerHTML =
      '<section class="inventory-panel"><p class="role-status">You do not have permission to perform this action.</p></section>';
    return;
  }

  const canCreateReceiving = canUseModule("metalReceiving", "create");
  const receivingEntries = Inventory.getReceivingEntries();

  metalReceivingRoot.innerHTML = `
    <section class="inventory-panel">
      <div class="section-heading">
        <div>
          <h2>Metal Receiving</h2>
          <p class="role-status" data-metal-receiving-message>Receive metal into inventory.</p>
        </div>
      </div>
      <form class="inventory-form" data-metal-receiving-form>
        <datalist id="receivingPuritySuggestions">
          ${getReceivingPurityOptions("Gold").map((purity) => `<option value="${escapeAttribute(purity)}"></option>`).join("")}
        </datalist>
        <div class="inventory-form-grid">
          <label>
            <span>Metal Type</span>
            <select data-receiving-field="metalType" ${canCreateReceiving ? "" : "disabled"}>
              ${Inventory.metalTypes.map((metalType) => `<option value="${escapeAttribute(metalType)}">${escapeHtml(metalType)}</option>`).join("")}
            </select>
          </label>
          <label>
            <span>Purity / KT</span>
            <input type="text" list="receivingPuritySuggestions" data-receiving-field="purity" value="${escapeAttribute(getReceivingDefaultPurity("Gold"))}" placeholder="24KT" ${canCreateReceiving ? "" : "disabled"}>
          </label>
          <label data-receiving-color-wrapper hidden>
            <span>Color</span>
            <select data-receiving-field="color" disabled>
              ${renderReceivingColorOptions()}
            </select>
          </label>
          <label>
            <span>Weight Received</span>
            <input type="number" min="0" step="0.001" data-receiving-field="weightReceived" placeholder="0.000" ${canCreateReceiving ? "" : "disabled"}>
          </label>
          <label>
            <span>Supplier / Vendor</span>
            <input type="text" data-receiving-field="supplier" placeholder="Supplier name" ${canCreateReceiving ? "" : "disabled"}>
          </label>
          <label>
            <span>Reference Number / Invoice Number</span>
            <input type="text" data-receiving-field="referenceNumber" placeholder="Invoice or reference" ${canCreateReceiving ? "" : "disabled"}>
          </label>
          <label>
            <span>Date and Time</span>
            <input type="datetime-local" data-receiving-field="dateTime" value="${escapeAttribute(getLocalDateTimeValue())}" ${canCreateReceiving ? "" : "disabled"}>
          </label>
          <label class="inventory-form-wide">
            <span>Notes</span>
            <textarea data-receiving-field="notes" placeholder="Optional notes" ${canCreateReceiving ? "" : "disabled"}></textarea>
          </label>
        </div>
        <div class="role-actions">
          <button class="button" type="submit" ${canCreateReceiving ? "" : "disabled"}>Submit Receiving</button>
        </div>
      </form>
      <div class="inventory-table-scroll">
        <table class="audit-table">
          <thead>
            <tr>
              <th>Date and Time</th>
              <th>Metal Type</th>
              <th>Purity / KT</th>
              <th>Color</th>
              <th>Weight Received</th>
              <th>Supplier / Vendor</th>
              <th>Reference</th>
              <th>Status</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            ${
              receivingEntries.length
                ? receivingEntries
                    .map(
                      (entry) => `
                        <tr>
                          <td>${escapeHtml(formatAuditDate(entry.submittedAt))}</td>
                          <td>${escapeHtml(entry.metalType)}</td>
                          <td>${escapeHtml(entry.purity)}</td>
                          <td>${escapeHtml(formatReceivingColor(entry))}</td>
                          <td>${escapeHtml(formatInventoryWeight(entry.weightReceived))}</td>
                          <td>${escapeHtml(entry.supplier)}</td>
                          <td>${escapeHtml(entry.referenceNumber)}</td>
                          <td>${entry.locked ? "Locked" : "Draft"}</td>
                          <td>${escapeHtml(entry.notes)}</td>
                        </tr>
                      `
                    )
                    .join("")
                : '<tr><td colspan="9" class="audit-empty">No metal receiving entries yet.</td></tr>'
            }
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderInventory() {
  if (!inventoryRoot) return;

  if (!Inventory) {
    inventoryRoot.innerHTML =
      '<section class="inventory-panel"><p class="role-status">Inventory is not available.</p></section>';
    return;
  }

  if (!canUseModule("inventory", "view")) {
    inventoryRoot.innerHTML =
      '<section class="inventory-panel"><p class="role-status">You do not have permission to perform this action.</p></section>';
    return;
  }

  const balances = Inventory.getInventoryBalances();
  const ledgerEntries = canViewInventoryLedger() ? getFilteredInventoryLedger() : [];
  const canExportLedger = canExportInventoryLedger();

  inventoryRoot.innerHTML = `
    <section class="inventory-panel">
      <div class="section-heading">
        <div>
          <h2>Inventory</h2>
          <p class="role-status">${balances.length} stock ${balances.length === 1 ? "balance" : "balances"}</p>
        </div>
        <button class="button button-secondary" type="button" data-export-inventory-ledger ${canExportLedger ? "" : "disabled"}>Export Ledger CSV</button>
      </div>
      <div class="inventory-balance-grid">
        ${
          balances.length
            ? balances
                .map(
                  (balance) => `
                    <article class="inventory-balance-card">
                      <p>${escapeHtml(formatInventoryCategory(balance.category))}</p>
                      <h3>${escapeHtml(balance.label)}</h3>
                      <strong>${escapeHtml(formatInventoryWeight(balance.balance))}</strong>
                    </article>
                  `
                )
                .join("")
            : '<p class="role-status">No inventory balances yet.</p>'
        }
      </div>
      <div class="section-heading inventory-ledger-heading">
        <div>
          <h2>Inventory Ledger</h2>
          <p class="role-status">${ledgerEntries.length} ${ledgerEntries.length === 1 ? "entry" : "entries"}</p>
        </div>
      </div>
      ${
        canViewInventoryLedger()
          ? `
            <div class="audit-filters">
              ${renderInventoryFilter("metalType", "Metal Type", "Search metal")}
              ${renderInventoryFilter("metalKtColor", "KT / Color", "Search KT or color")}
              ${renderInventoryFilter("transactionType", "Transaction Type", "Search transaction")}
              ${renderInventoryFilter("internalTreeNumber", "Internal Tree Number", "Search tree")}
              ${renderInventoryFilter("barcodeValue", "Barcode Value", "Search barcode")}
              <label>
                <span>From</span>
                <input type="date" data-inventory-filter="dateFrom" value="${escapeAttribute(inventoryFilters.dateFrom)}">
              </label>
              <label>
                <span>To</span>
                <input type="date" data-inventory-filter="dateTo" value="${escapeAttribute(inventoryFilters.dateTo)}">
              </label>
              <button class="clear-filter-button" type="button" data-clear-inventory-filters>Clear</button>
            </div>
            <div class="inventory-table-scroll">
              <table class="audit-table">
                <thead>
                  <tr>
                    <th>Ledger Number</th>
                    <th>Date and Time</th>
                    <th>Transaction Type</th>
                    <th>Metal Type</th>
                    <th>Metal KT and Color</th>
                    <th>Color</th>
                    <th>In Weight</th>
                    <th>Out Weight</th>
                    <th>Balance After Transaction</th>
                    <th>Internal Tree Number</th>
                    <th>Barcode Value</th>
                    <th>Order ID</th>
                    <th>Source Module</th>
                    <th>Created By User</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  ${
                    ledgerEntries.length
                      ? ledgerEntries
                          .map(
                            (entry) => `
                              <tr>
                                <td>${escapeHtml(formatLedgerNumber(entry))}</td>
                                <td>${escapeHtml(formatAuditDate(entry.createdAt))}</td>
                                <td>${escapeHtml(entry.transactionType)}</td>
                                <td>${escapeHtml(entry.metalType)}</td>
                                <td>${escapeHtml(entry.metalKtColor || entry.purity)}</td>
                                <td>${escapeHtml(formatReceivingColor(entry))}</td>
                                <td>${escapeHtml(formatInventoryWeight(entry.inWeight))}</td>
                                <td>${escapeHtml(formatInventoryWeight(entry.outWeight))}</td>
                                <td>${escapeHtml(formatInventoryWeight(entry.balanceAfterTransaction))}</td>
                                <td>${escapeHtml(entry.relatedInternalTreeNumber)}</td>
                                <td>${escapeHtml(entry.relatedBarcodeValue)}</td>
                                <td>${escapeHtml(entry.relatedOrderId)}</td>
                                <td>${escapeHtml(entry.sourceModule)}</td>
                                <td>${escapeHtml(entry.createdByUsername)}</td>
                                <td>${escapeHtml(entry.notes)}</td>
                              </tr>
                            `
                          )
                          .join("")
                      : '<tr><td colspan="15" class="audit-empty">No inventory ledger entries match the current filters.</td></tr>'
                  }
                </tbody>
              </table>
            </div>
          `
          : '<p class="role-status">You do not have permission to perform this action.</p>'
      }
    </section>
  `;
}

function renderInventoryFilter(field, label, placeholder) {
  return `
    <label>
      <span>${escapeHtml(label)}</span>
      <input type="search" data-inventory-filter="${escapeAttribute(field)}" value="${escapeAttribute(inventoryFilters[field])}" placeholder="${escapeAttribute(placeholder)}">
    </label>
  `;
}

function getFilteredInventoryLedger() {
  const ledgerEntries = Inventory ? Inventory.getInventoryLedger() : [];
  const dateFrom = inventoryFilters.dateFrom ? new Date(`${inventoryFilters.dateFrom}T00:00:00`).getTime() : null;
  const dateTo = inventoryFilters.dateTo ? new Date(`${inventoryFilters.dateTo}T23:59:59`).getTime() : null;

  return ledgerEntries.filter((entry) => {
    const entryTime = new Date(entry.createdAt).getTime() || 0;
    if (dateFrom !== null && entryTime < dateFrom) return false;
    if (dateTo !== null && entryTime > dateTo) return false;

    return (
      matchesAuditFilter(entry.metalType, inventoryFilters.metalType) &&
      matchesAuditFilter(`${entry.metalKtColor} ${entry.purity} ${entry.color}`, inventoryFilters.metalKtColor) &&
      matchesAuditFilter(entry.transactionType, inventoryFilters.transactionType) &&
      matchesAuditFilter(entry.relatedInternalTreeNumber, inventoryFilters.internalTreeNumber) &&
      matchesAuditFilter(entry.relatedBarcodeValue, inventoryFilters.barcodeValue)
    );
  });
}

function renderReceivingColorOptions() {
  const colorOptions = ["", ...(Inventory?.goldColorValues || ["Yellow", "White", "Rose"])];
  return colorOptions
    .map((color) => `<option value="${escapeAttribute(color)}">${escapeHtml(color || "Select color")}</option>`)
    .join("");
}

function getReceivingPurityOptions(metalType) {
  if (metalType === "Platinum") return ["950 Platinum"];
  if (metalType === "Silver") return ["925 Silver"];
  return Inventory?.goldKtValues || ["24KT", "22KT", "18KT", "14KT", "10KT", "9KT"];
}

function getReceivingDefaultPurity(metalType) {
  if (Inventory?.getReceivingDefaultPurity) {
    return Inventory.getReceivingDefaultPurity(metalType);
  }

  if (metalType === "Platinum") return "950 Platinum";
  if (metalType === "Silver") return "925 Silver";
  return "24KT";
}

function syncReceivingPurityOptions(form) {
  const metalType = form?.querySelector('[data-receiving-field="metalType"]')?.value || "Gold";
  const purityInput = form?.querySelector('[data-receiving-field="purity"]');
  const datalist = form?.querySelector("#receivingPuritySuggestions");

  if (datalist) {
    datalist.innerHTML = getReceivingPurityOptions(metalType)
      .map((purity) => `<option value="${escapeAttribute(purity)}"></option>`)
      .join("");
  }

  if (purityInput) {
    purityInput.placeholder = getReceivingDefaultPurity(metalType);
  }
}

async function submitMetalReceivingForm(form) {
  if (!canUseModule("metalReceiving", "create")) {
    showAccessMessage(permissionDeniedMessage, {
      module: "Metal Receiving",
      notes: "Create metal receiving"
    });
    return;
  }

  const getValue = (field) => form.querySelector(`[data-receiving-field="${field}"]`)?.value || "";

  try {
    const result = await Inventory.submitMetalReceiving(
      {
        color: getValue("color"),
        dateTime: toIsoDateTime(getValue("dateTime")),
        metalType: getValue("metalType"),
        notes: getValue("notes"),
        purity: getValue("purity"),
        referenceNumber: getValue("referenceNumber"),
        supplier: getValue("supplier"),
        weightReceived: getValue("weightReceived")
      },
      {
        user: currentUser
      }
    );
    renderMetalReceiving();
    renderInventory();
    setMetalReceivingStatus(
      result?.persistedToBackend === false
        ? "Receiving entry submitted locally. Backend fallback is active."
        : "Receiving entry submitted and locked."
    );
  } catch (error) {
    setMetalReceivingStatus(error.message || "Metal receiving could not be submitted.");
  }
}

function exportInventoryLedgerCsv() {
  if (!canExportInventoryLedger()) {
    showAccessMessage(permissionDeniedMessage, {
      module: "Inventory",
      notes: "Export inventory ledger"
    });
    return;
  }

  const header = [
    "Ledger Number",
    "Date and Time",
    "Transaction Type",
    "Metal Type",
    "Metal KT and Color",
    "Color",
    "In Weight",
    "Out Weight",
    "Balance After Transaction",
    "Related Internal Tree Number",
    "Related Barcode Value",
    "Related Order ID",
    "Source Module",
    "Created By User",
    "Notes"
  ];
  const rows = getFilteredInventoryLedger().map((entry) => [
    formatLedgerNumber(entry),
    formatAuditDate(entry.createdAt),
    entry.transactionType,
    entry.metalType,
    entry.metalKtColor || entry.purity,
    formatReceivingColor(entry),
    entry.inWeight,
    entry.outWeight,
    entry.balanceAfterTransaction,
    entry.relatedInternalTreeNumber,
    entry.relatedBarcodeValue,
    entry.relatedOrderId,
    entry.sourceModule,
    entry.createdByUsername,
    entry.notes
  ]);
  const csv = [header, ...rows].map((row) => row.map(escapeCsvCell).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `production-inventory-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
  recordAudit("Export Inventory Ledger", {
    module: "Inventory",
    notes: `${rows.length} rows exported`
  });
}

function setMetalReceivingStatus(message) {
  const statusElement = metalReceivingRoot?.querySelector("[data-metal-receiving-message]");
  if (statusElement) {
    statusElement.textContent = message;
  }
}

function formatInventoryWeight(value) {
  return Inventory ? Inventory.formatWeight(value) : `${value || 0} g`;
}

function formatInventoryCategory(category) {
  const labels = {
    finished: "Finished product stock",
    goldStock: "Gold stock",
    pureGold: "Pure Gold / 24KT Gold",
    purePlatinum: "Platinum",
    pureSilver: "Fine Silver",
    reusable: "Reusable casting balance",
    scrapLoss: "Scrap / Loss"
  };

  return labels[category] || category || "Inventory";
}

function formatLedgerNumber(entry) {
  const date = new Date(entry?.createdAt || "");
  const datePart = Number.isNaN(date.getTime())
    ? "000000"
    : `${String(date.getFullYear()).slice(-2)}${String(date.getMonth() + 1).padStart(2, "0")}${String(
        date.getDate()
      ).padStart(2, "0")}`;
  const idPart =
    String(entry?.id || "")
      .replace(/^ledger[_-]?/i, "")
      .replace(/[^a-z0-9]/gi, "")
      .slice(-6)
      .toUpperCase() || "000000";

  return `LED-${datePart}-${idPart}`;
}

function formatReceivingColor(entry) {
  if (entry?.color) return entry.color;
  if (entry?.metalType === "Gold" && parseReceivingKt(entry.purity) === 24) return "Pure";
  return "Not applicable";
}

function getLocalDateTimeValue() {
  const date = new Date();
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return offsetDate.toISOString().slice(0, 16);
}

function toIsoDateTime(value) {
  if (!value) return new Date().toISOString();

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function parseReceivingKt(value) {
  const matchedValue = String(value || "").match(/(\d+(?:\.\d+)?)\s*KT/i);
  if (!matchedValue) return null;

  const kt = Number.parseFloat(matchedValue[1]);
  return Number.isFinite(kt) ? kt : null;
}

function refreshReceivingColorField(form) {
  const metalTypeInput = form?.querySelector('[data-receiving-field="metalType"]');
  const purityInput = form?.querySelector('[data-receiving-field="purity"]');
  const colorWrapper = form?.querySelector("[data-receiving-color-wrapper]");
  const colorInput = form?.querySelector('[data-receiving-field="color"]');
  if (!metalTypeInput || !purityInput || !colorWrapper || !colorInput) return;

  const kt = parseReceivingKt(purityInput.value);
  const shouldShowColor = metalTypeInput.value === "Gold" && kt !== null && kt !== 24;
  colorWrapper.hidden = !shouldShowColor;
  colorInput.disabled = !shouldShowColor || metalTypeInput.disabled;
  colorInput.required = shouldShowColor;

  if (!shouldShowColor) {
    colorInput.value = "";
  }
}

function UserManagement() {
  renderUserManagement();
}

function renderUserManagement() {
  if (!userManagementRoot) return;

  if (!RBAC?.getUsers) {
    userManagementRoot.innerHTML = '<section class="user-panel"><p class="role-status">User management is not available.</p></section>';
    return;
  }

  if (!canManageUsers()) {
    userManagementRoot.innerHTML =
      '<section class="user-panel"><p class="role-status">You do not have permission to perform this action.</p></section>';
    return;
  }

  const users = RBAC.getUsers();
  const roles = RBAC.getRoles();
  const selectedUser =
    selectedUserId === null ? null : users.find((user) => user.id === selectedUserId) || users[0] || null;

  if (selectedUser && selectedUserId !== selectedUser.id) {
    selectedUserId = selectedUser.id;
  }

  userManagementRoot.innerHTML = `
    <section class="user-panel">
      <div class="section-heading">
        <div>
          <h2>User Management</h2>
          <p class="role-status" data-user-message>Ready</p>
        </div>
        <button class="button button-secondary" type="button" data-new-user>New User</button>
      </div>
      <div class="role-layout">
        <aside class="role-list" aria-label="Saved users">
          ${users
            .map(
              (user) => `
                <button class="role-list-item ${user.id === selectedUserId ? "is-active" : ""}" type="button" data-select-user="${escapeAttribute(user.id)}">
                  <span>${escapeHtml(user.name || user.email)}</span>
                  <small>${user.isActive ? "Active" : "Inactive"} - ${escapeHtml(user.email)}</small>
                </button>
              `
            )
            .join("")}
        </aside>
        ${UserForm(selectedUser, roles)}
      </div>
    </section>
  `;
}

function UserForm(selectedUser, roles) {
  const assignedRoleIds = new Set(selectedUser?.assignedRoleIds || []);
  const isExistingUser = Boolean(selectedUser);
  const isCurrentUser = selectedUser?.id === currentUser.id;
  const passwordHint = isExistingUser ? "Leave blank unless resetting password" : "Required for new users";
  const canChangeRoles = canAssignRoles();
  const canDeleteSelectedUser = canDeleteUserAccount(selectedUser);

  return `
    <form class="user-form" data-user-form>
      <div class="role-form-grid">
        <label>
          <span>Full Name</span>
          <input type="text" data-user-name value="${escapeAttribute(selectedUser?.name || "")}" placeholder="System Admin">
        </label>
        <label>
          <span>Email / Username</span>
          <input type="email" data-user-email value="${escapeAttribute(selectedUser?.email || "")}" autocomplete="username" placeholder="user@example.com">
        </label>
        <label>
          <span>Status</span>
          <select data-user-status ${isCurrentUser ? "disabled" : ""}>
            <option value="active" ${selectedUser?.isActive !== false ? "selected" : ""}>Active</option>
            <option value="inactive" ${selectedUser?.isActive === false ? "selected" : ""}>Inactive</option>
          </select>
        </label>
        <label>
          <span>Password</span>
          <div class="password-control">
            <input type="password" data-user-password autocomplete="new-password" placeholder="${escapeAttribute(passwordHint)}">
            <button type="button" data-toggle-password title="Show password" aria-label="Show password">Show</button>
          </div>
        </label>
        <label>
          <span>Confirm Password</span>
          <div class="password-control">
            <input type="password" data-user-confirm-password autocomplete="new-password" placeholder="${escapeAttribute(passwordHint)}">
            <button type="button" data-toggle-password title="Show password" aria-label="Show password">Show</button>
          </div>
        </label>
      </div>
      ${RoleAssignment(roles, assignedRoleIds, !canChangeRoles)}
      ${
        selectedUser
          ? `
            <dl class="user-details">
              <div><dt>Created Date</dt><dd>${escapeHtml(formatAuditDate(selectedUser.createdAt) || "Not available")}</dd></div>
              <div><dt>Last Login Date</dt><dd>${escapeHtml(formatAuditDate(selectedUser.lastLoginAt) || "Not available")}</dd></div>
              <div><dt>Assigned Roles</dt><dd>${escapeHtml(formatAssignedRoleNames(selectedUser, roles))}</dd></div>
            </dl>
          `
          : ""
      }
      <div class="role-actions">
        <button class="button" type="submit">${selectedUser ? "Save User" : "Create User"}</button>
        <button class="button button-secondary" type="button" data-reset-password ${selectedUser ? "" : "disabled"}>Reset Password</button>
        <button class="button button-secondary" type="button" data-deactivate-user ${selectedUser && selectedUser.isActive && !isCurrentUser ? "" : "disabled"}>Deactivate User</button>
        <button class="button button-secondary" type="button" data-delete-user ${canDeleteSelectedUser ? "" : "disabled"}>Delete User</button>
      </div>
    </form>
  `;
}

function RoleAssignment(roles, assignedRoleIds, isDisabled = false) {
  return `
    <fieldset class="permission-group" ${isDisabled ? "disabled" : ""}>
      <legend>Assigned Roles</legend>
      ${roles
        .map(
          (role) => `
            <label class="permission-option">
              <input type="checkbox" value="${escapeAttribute(role.id)}" data-user-role ${assignedRoleIds.has(role.id) ? "checked" : ""}>
              <span>${escapeHtml(role.name)}${role.isActive === false ? " (Inactive)" : ""}</span>
            </label>
          `
        )
        .join("")}
    </fieldset>
  `;
}

async function saveUserFromForm() {
  if (!userManagementRoot || !canManageUsers()) return;

  const previousUser = selectedUserId ? RBAC.getUser(selectedUserId) : null;
  const roleIds = canAssignRoles()
    ? Array.from(userManagementRoot.querySelectorAll("[data-user-role]:checked")).map((input) => input.value)
    : previousUser?.assignedRoleIds || [];
  const password = userManagementRoot.querySelector("[data-user-password]")?.value || "";
  const confirmPassword = userManagementRoot.querySelector("[data-user-confirm-password]")?.value || "";
  const selectedStatus = userManagementRoot.querySelector("[data-user-status]")?.value || "active";

  if (selectedUserId === currentUser.id && selectedStatus === "inactive") {
    setUserStatus("You cannot deactivate your own active session.");
    return;
  }

  try {
    const result = await RBAC.saveUser({
      id: selectedUserId || "",
      name: userManagementRoot.querySelector("[data-user-name]")?.value || "",
      email: userManagementRoot.querySelector("[data-user-email]")?.value || "",
      isActive: selectedStatus !== "inactive",
      assignedRoleIds: roleIds,
      password,
      confirmPassword
    });

    selectedUserId = result.user.id;
    renderUserManagement();
    setUserStatus(result.created ? "User created." : "User saved.");

    recordAudit(result.created ? "User created" : "User edited", {
      module: "User Management",
      oldValue: result.previousUser || "",
      newValue: result.user
    });

    if (!result.created && result.passwordChanged) {
      recordAudit("Password reset", {
        module: "User Management",
        newValue: { userId: result.user.id, email: result.user.email }
      });
    }

    if (canAssignRoles() && !sameArray(previousUser?.assignedRoleIds || [], result.user.assignedRoleIds || [])) {
      recordAudit("Roles assigned or removed", {
        module: "User Management",
        oldValue: { userId: result.user.id, assignedRoleIds: previousUser?.assignedRoleIds || [] },
        newValue: { userId: result.user.id, assignedRoleIds: result.user.assignedRoleIds || [] }
      });
    }

    if (previousUser?.isActive && !result.user.isActive) {
      recordAudit("User deactivated", {
        module: "User Management",
        oldValue: previousUser,
        newValue: result.user
      });
    }
  } catch (error) {
    setUserStatus(error.message || "User could not be saved.");
  }
}

async function resetSelectedUserPassword() {
  if (!selectedUserId || !canManageUsers()) return;

  const password = userManagementRoot.querySelector("[data-user-password]")?.value || "";
  const confirmPassword = userManagementRoot.querySelector("[data-user-confirm-password]")?.value || "";

  try {
    const result = await RBAC.resetPassword(selectedUserId, password, confirmPassword);
    renderUserManagement();
    setUserStatus("Password reset.");
    recordAudit("Password reset", {
      module: "User Management",
      oldValue: { userId: result.user.id },
      newValue: { userId: result.user.id, email: result.user.email }
    });
  } catch (error) {
    setUserStatus(error.message || "Password could not be reset.");
  }
}

async function deactivateSelectedUser() {
  if (!selectedUserId || !canManageUsers()) return;

  const selectedUser = RBAC.getUser(selectedUserId);
  if (!selectedUser || !window.confirm(`Deactivate user "${selectedUser.name || selectedUser.email}"?`)) {
    return;
  }

  const result = await RBAC.deactivateUser(selectedUserId);
  if (!result) return;

  renderUserManagement();
  setUserStatus("User deactivated.");
  recordAudit("User deactivated", {
    module: "User Management",
    oldValue: result.previousUser,
    newValue: result.user
  });
}

async function deleteSelectedUser() {
  if (!selectedUserId || !canManageUsers()) return;

  const selectedUser = RBAC.getUser(selectedUserId);
  if (!selectedUser) return;

  if (!isAdminUser(currentUser)) {
    setUserStatus("Only System Admin users can delete users.");
    return;
  }

  if (selectedUser.id === currentUser.id) {
    setUserStatus("You cannot delete your own active session.");
    return;
  }

  if (isAdminUser(selectedUser) && getAdminUserCount() <= 1) {
    setUserStatus("You cannot delete the last remaining admin account.");
    return;
  }

  if (!window.confirm(`Permanently delete user "${selectedUser.name || selectedUser.email}"? This cannot be undone.`)) {
    return;
  }

  const result = await RBAC.deleteUser(selectedUserId);
  if (!result) return;

  const deletedUser = result.previousUser || selectedUser;
  const remainingUsers = RBAC.getUsers().filter((user) => user.id !== deletedUser.id);
  selectedUserId = remainingUsers[0]?.id || null;
  renderUserManagement();
  setUserStatus("User deleted.");
  recordAudit("User deleted", {
    module: "User Management",
    oldValue: deletedUser,
    newValue: { deletedUserId: deletedUser.id, email: deletedUser.email }
  });
}

function setUserStatus(message) {
  const statusElement = userManagementRoot?.querySelector("[data-user-message]");
  if (statusElement) {
    statusElement.textContent = message;
  }
}

function formatAssignedRoleNames(user, roles) {
  const roleNames = (user.assignedRoleIds || [])
    .map((roleId) => roles.find((role) => role.id === roleId)?.name || roleId)
    .filter(Boolean);

  return roleNames.length ? roleNames.join(", ") : "No roles assigned";
}

function sameArray(left, right) {
  const leftValues = [...left].sort();
  const rightValues = [...right].sort();

  return leftValues.length === rightValues.length && leftValues.every((value, index) => value === rightValues[index]);
}

function renderAuditLogs() {
  if (!auditLogsRoot) return;

  if (!RBAC) {
    auditLogsRoot.innerHTML = '<section class="audit-panel"><p class="role-status">Audit logging is not available.</p></section>';
    return;
  }

  if (!canViewAuditLogs()) {
    auditLogsRoot.innerHTML =
      '<section class="audit-panel"><p class="role-status">You do not have permission to perform this action.</p></section>';
    return;
  }

  const filteredLogs = getFilteredAuditLogs();
  const canExportLogs = canExportAuditLogs();
  const canDownloadKtFormula = canDownloadKtFormulaTable();

  auditLogsRoot.innerHTML = `
    <section class="audit-panel">
      <div class="section-heading">
        <div>
          <h2>Audit Logs</h2>
          <p class="role-status">${filteredLogs.length} ${filteredLogs.length === 1 ? "entry" : "entries"}</p>
        </div>
        <div class="role-actions">
          <button class="button button-secondary" type="button" data-download-kt-formula-table ${canDownloadKtFormula ? "" : "disabled"} title="${canDownloadKtFormula ? "Download KT Formula Table" : "Audit Logs permission required"}">Download KT Formula Table</button>
          <button class="button button-secondary" type="button" data-export-audit-logs ${canExportLogs ? "" : "disabled"} title="${canExportLogs ? "Export audit logs" : "Export Audit Logs permission required"}">Export CSV</button>
        </div>
      </div>
      <div class="audit-filters">
        ${renderAuditFilter("user", "User", "Search user")}
        ${renderAuditFilter("module", "Module", "Search module")}
        ${renderAuditFilter("stage", "Stage", "Search stage")}
        ${renderAuditFilter("action", "Action", "Search action")}
        ${renderAuditFilter("internalTreeNumber", "Internal Tree Number", "Search tree")}
        ${renderAuditFilter("barcodeValue", "Barcode Value", "Search barcode")}
        <label>
          <span>From</span>
          <input type="date" data-audit-filter="dateFrom" value="${escapeAttribute(auditFilters.dateFrom)}">
        </label>
        <label>
          <span>To</span>
          <input type="date" data-audit-filter="dateTo" value="${escapeAttribute(auditFilters.dateTo)}">
        </label>
        <button class="clear-filter-button" type="button" data-clear-audit-filters>Clear</button>
      </div>
      <div class="audit-table-scroll">
        <table class="audit-table">
          <thead>
            <tr>
              <th>Date and Time</th>
              <th>User</th>
              <th>Action</th>
              <th>Module</th>
              <th>Stage</th>
              <th>Internal Tree Number</th>
              <th>In-House Production</th>
              <th>Barcode Value</th>
              <th>Old Value</th>
              <th>New Value</th>
              <th>IP / Device</th>
              <th>Notes / Remarks</th>
            </tr>
          </thead>
          <tbody>
            ${
              filteredLogs.length
                ? filteredLogs
                    .map(
                      (log) => `
                        <tr>
                          <td>${escapeHtml(formatAuditDate(log.createdAt))}</td>
                          <td>${escapeHtml(log.username || log.userId)}</td>
                          <td>${escapeHtml(log.action)}</td>
                          <td>${escapeHtml(log.module)}</td>
                          <td>${escapeHtml(log.stage)}</td>
                          <td>${escapeHtml(log.internalTreeNumber)}</td>
                          <td>${escapeHtml(log.isInHouseProduction)}</td>
                          <td>${escapeHtml(log.barcodeValue)}</td>
                          <td>${escapeHtml(log.oldValue)}</td>
                          <td>${escapeHtml(log.newValue)}</td>
                          <td>${escapeHtml(log.device)}</td>
                          <td>${escapeHtml(log.notes)}</td>
                        </tr>
                      `
                    )
                    .join("")
                : '<tr><td colspan="12" class="audit-empty">No audit logs match the current filters.</td></tr>'
            }
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderAuditFilter(field, label, placeholder) {
  return `
    <label>
      <span>${escapeHtml(label)}</span>
      <input type="search" data-audit-filter="${escapeAttribute(field)}" value="${escapeAttribute(auditFilters[field])}" placeholder="${escapeAttribute(placeholder)}">
    </label>
  `;
}

function getFilteredAuditLogs() {
  const logs = RBAC ? RBAC.getAuditLogs() : [];
  const dateFrom = auditFilters.dateFrom ? new Date(`${auditFilters.dateFrom}T00:00:00`).getTime() : null;
  const dateTo = auditFilters.dateTo ? new Date(`${auditFilters.dateTo}T23:59:59`).getTime() : null;

  return logs.filter((log) => {
    const logTime = new Date(log.createdAt).getTime() || 0;
    if (dateFrom !== null && logTime < dateFrom) return false;
    if (dateTo !== null && logTime > dateTo) return false;

    return (
      matchesAuditFilter(log.username || log.userId, auditFilters.user) &&
      matchesAuditFilter(log.module, auditFilters.module) &&
      matchesAuditFilter(log.stage, auditFilters.stage) &&
      matchesAuditFilter(log.action, auditFilters.action) &&
      matchesAuditFilter(log.internalTreeNumber, auditFilters.internalTreeNumber) &&
      matchesAuditFilter(log.barcodeValue, auditFilters.barcodeValue)
    );
  });
}

function matchesAuditFilter(value, filterValue) {
  const needle = String(filterValue || "").trim().toLowerCase();
  if (!needle) return true;

  return String(value || "").toLowerCase().includes(needle);
}

function exportAuditLogsCsv() {
  if (!canExportAuditLogs()) {
    showAccessMessage(permissionDeniedMessage);
    return;
  }

  const header = [
    "Date and Time",
    "User",
    "Action",
    "Module",
    "Stage",
    "Internal Tree Number",
    "In-House Production",
    "Barcode Value",
    "Old Value",
    "New Value",
    "IP / Device",
    "Notes / Remarks"
  ];
  const rows = getFilteredAuditLogs().map((log) => [
    formatAuditDate(log.createdAt),
    log.username || log.userId,
    log.action,
    log.module,
    log.stage,
    log.internalTreeNumber,
    log.isInHouseProduction,
    log.barcodeValue,
    log.oldValue,
    log.newValue,
    log.device,
    log.notes
  ]);
  const csv = [header, ...rows].map((row) => row.map(escapeCsvCell).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `production-audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
  recordAudit("Export Audit Logs", {
    module: "Audit Logs",
    notes: `${rows.length} rows exported`
  });
}

function downloadKtFormulaTableCsv() {
  if (!canDownloadKtFormulaTable()) {
    showAccessMessage(permissionDeniedMessage, {
      module: "Audit Logs",
      notes: "Download KT Formula Table"
    });
    return;
  }

  const header = [
    "Metal",
    "KT",
    "Formula",
    "Pure Metal Percentage",
    "Alloy / Other Percentage",
    "Example Calculation"
  ];
  const rows = getKtFormulaRows().map((row) => [
    row.metal,
    row.kt,
    row.formula,
    row.pureMetalPercentage,
    row.alloyOtherPercentage,
    row.exampleCalculation
  ]);
  const csv = [header, ...rows].map((row) => row.map(escapeCsvCell).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `kt-formula-table-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
  recordAudit("KT Formula Table Downloaded", {
    module: "Audit Logs",
    notes: "KT conversion formula reference downloaded"
  });
}

function getKtFormulaRows() {
  return [24, 22, 18, 14, 10].map((kt) => {
    const purePercentage = (kt / 24) * 100;
    const alloyPercentage = 100 - purePercentage;
    const pureWeight = (100 * kt) / 24;

    return {
      alloyOtherPercentage: formatFormulaPercentage(alloyPercentage),
      exampleCalculation: `For 100g of ${kt}KT Gold: Pure Gold Required = 100 \u00d7 ${kt} / 24 = ${formatFormulaWeight(pureWeight)}`,
      formula: `Weight \u00d7 ${kt} / 24`,
      kt: `${kt}KT`,
      metal: "Gold",
      pureMetalPercentage: formatFormulaPercentage(purePercentage)
    };
  });
}

function formatFormulaPercentage(value) {
  return `${formatFormulaNumber(value)}%`;
}

function formatFormulaWeight(value) {
  return `${formatFormulaNumber(value)}g`;
}

function formatFormulaNumber(value) {
  return Number(value)
    .toFixed(2)
    .replace(/\.?0+$/, "");
}

function formatAuditDate(value) {
  if (!value) return "";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function renderSuggestions() {
  vendorCustomerNameSuggestions.innerHTML = renderSuggestionOptions("vendorCustomerName");
  waxInvoiceNoSuggestions.innerHTML = renderSuggestionOptions("waxInvoiceNo");
}

function renderSuggestionOptions(field) {
  return getUniqueFieldValues(field)
    .map((value) => `<option value="${escapeAttribute(value)}"></option>`)
    .join("");
}

function getUniqueFieldValues(field) {
  const values = state.entries
    .map((entry) => String(entry[field] || "").trim())
    .filter(Boolean);

  return [...new Set(values)].sort((first, second) => first.localeCompare(second));
}

function renderReadonlyRow(entry, index) {
  const isRush = Boolean(entry.isRush);
  const rushBadge = isRush ? '<span class="rush-badge">Rush</span>' : "";
  const isInHouseProduction = Boolean(entry.isInHouseProduction);
  const inHouseProductionBadge = isInHouseProduction ? '<span class="in-house-badge">In-House Prod</span>' : "";
  const isInventoryPosted = isEntryInventoryPosted(entry.id);
  const lockedBadge = isInventoryPosted ? '<span class="locked-badge">Inventory Posted</span>' : "";
  const lockedTitle = "Order locked after inventory posting";
  const rushButtonTitle = isRush ? "Remove Rush" : "Mark Rush";
  const rushButtonLabel = isRush ? `Remove Rush status from row ${index + 1}` : `Mark row ${index + 1} as Rush`;
  const canEditWax = canUseModule("waxEntries", "edit") && !isInventoryPosted;
  const canDeleteWax = canUseModule("waxEntries", "delete") && !isInventoryPosted;
  const canToggleRush = canMarkRush() && !isInventoryPosted;
  const canPrintWax = canUseModule("waxEntries", "print");

  return `
    <td class="name-cell" data-label="Vendor / Customer Name">
      <div class="entry-name-with-badge">
        <span>${escapeHtml(entry.vendorCustomerName)}</span>
        ${rushBadge}
        ${lockedBadge}
      </div>
    </td>
    <td class="date-cell" data-label="Date">${entry.date ? escapeHtml(formatDate(entry.date)) : ""}</td>
    <td class="invoice-cell" data-label="Wax Invoice No.">${escapeHtml(entry.waxInvoiceNo)}</td>
    <td class="tree-cell" data-label="Customer / Vendor Tree No.">${escapeHtml(entry.customerVendorTreeNo)}</td>
    <td class="metal-cell" data-label="Metal KT">${escapeHtml(entry.metalKt)}</td>
    <td class="color-cell" data-label="Color">${escapeHtml(entry.color)}</td>
    <td class="wax-weight-cell" data-label="Wax Weight">${escapeHtml(entry.waxWeight)}</td>
    <td class="tree-cell" data-label="Internal Tree Number">
      <div class="tree-number-with-badge">
        <span class="tree-number-value">${escapeHtml(getInternalTreeNumber(entry) || "Pending")}</span>
        ${inHouseProductionBadge}
      </div>
    </td>
    <td class="action-cell" data-label="Action">
      <div class="row-actions">
        <button class="rush-button ${isRush ? "is-active" : ""}" type="button" data-rush-row title="${isInventoryPosted ? lockedTitle : canToggleRush ? rushButtonTitle : "Mark rush permission required"}" aria-label="${rushButtonLabel}" aria-pressed="${String(isRush)}" ${canToggleRush ? "" : "disabled"}>Rush</button>
        <button class="print-button" type="button" data-print-row title="${canPrintWax ? "Print Barcode" : "Print permission required"}" aria-label="Print Barcode" ${canPrintWax ? "" : "disabled"}>
          <svg class="print-icon" aria-hidden="true" viewBox="0 0 24 24" focusable="false">
            <path d="M6 9V3h12v6"></path>
            <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path>
            <path d="M6 14h12v7H6z"></path>
          </svg>
        </button>
        <button class="edit-button" type="button" data-edit-row title="${isInventoryPosted ? lockedTitle : canEditWax ? "Edit row" : "Edit permission required"}" aria-label="Edit row ${index + 1}" ${canEditWax ? "" : "disabled"}>&#9998;</button>
        <button class="icon-button" type="button" data-delete-row title="${isInventoryPosted ? lockedTitle : canDeleteWax ? "Delete row" : "Delete permission required"}" aria-label="Delete row ${index + 1}" ${canDeleteWax ? "" : "disabled"}>x</button>
      </div>
    </td>
  `;
}

function renderEditableRow(entry, index) {
  const canEditWax = canUseModule("waxEntries", "edit");

  return `
    <td class="name-cell" data-label="Vendor / Customer Name">
      <input type="text" value="${escapeAttribute(entry.vendorCustomerName)}" list="vendorCustomerNameSuggestions" data-edit-field="vendorCustomerName" aria-label="Vendor or customer name for row ${index + 1}">
    </td>
    <td class="date-cell" data-label="Date">
      <div class="date-input-group">
        <input type="date" value="${escapeAttribute(entry.date)}" data-edit-field="date" aria-label="Date for row ${index + 1}">
        <button class="today-button" type="button" data-today-edit title="Use today's date" aria-label="Use today's date for row ${index + 1}">T</button>
      </div>
    </td>
    <td class="invoice-cell" data-label="Wax Invoice No.">
      <input type="text" value="${escapeAttribute(entry.waxInvoiceNo)}" list="waxInvoiceNoSuggestions" data-edit-field="waxInvoiceNo" aria-label="Wax invoice number for row ${index + 1}">
    </td>
    <td class="tree-cell" data-label="Customer / Vendor Tree No.">
      <input type="text" value="${escapeAttribute(entry.customerVendorTreeNo)}" data-edit-field="customerVendorTreeNo" aria-label="Customer or vendor tree number for row ${index + 1}">
    </td>
    <td class="metal-cell" data-label="Metal KT">
      <select data-edit-field="metalKt" aria-label="Metal KT for row ${index + 1}">
        ${renderSelectOptions(metalKtOptions, entry.metalKt)}
      </select>
    </td>
    <td class="color-cell" data-label="Color">
      <select data-edit-field="color" aria-label="Color for row ${index + 1}" ${isWhiteFixedMetal(entry.metalKt) ? "disabled" : ""}>
        ${renderSelectOptions(colorOptions, getColorForMetal(entry.metalKt, entry.color))}
      </select>
    </td>
    <td class="wax-weight-cell" data-label="Wax Weight">
      <input type="number" min="0" step="0.001" value="${escapeAttribute(entry.waxWeight)}" data-edit-field="waxWeight" aria-label="Wax weight for row ${index + 1}">
    </td>
    <td class="tree-cell" data-label="Internal Tree Number">
      <input type="text" value="${escapeAttribute(getInternalTreeNumber(entry) || "Generated")}" aria-label="Internal tree number for row ${index + 1}" readonly disabled>
    </td>
    <td class="action-cell" data-label="Action">
      <div class="row-actions">
        <button class="submit-button" type="button" data-save-edit title="${canEditWax ? "Save row" : "Edit permission required"}" aria-label="Save row ${index + 1}" ${canEditWax ? "" : "disabled"}>&#10003;</button>
        <button class="cancel-button" type="button" data-cancel-edit title="Cancel edit" aria-label="Cancel edit for row ${index + 1}">x</button>
      </div>
    </td>
  `;
}

function renderSelectOptions(options, selectedValue) {
  return options
    .map((letter) => `<option value="${letter}" ${letter === selectedValue ? "selected" : ""}>${letter || "-"}</option>`)
    .join("");
}

function isWhiteFixedMetal(metalKt) {
  return fixedWhiteMetals.has(metalKt);
}

function getColorForMetal(metalKt, color) {
  if (isWhiteFixedMetal(metalKt)) {
    return "White";
  }

  return colorOptions.includes(color) ? color : "";
}

function syncColorControl(metalSelect, colorSelect) {
  if (!metalSelect || !colorSelect) return;

  const fixedWhite = isWhiteFixedMetal(metalSelect.value);
  if (fixedWhite) {
    colorSelect.value = "White";
  }

  colorSelect.disabled = fixedWhite;
}

async function createWaxEntryInBackend(entry) {
  if (!Backend?.createWaxEntryWithNumber) {
    throw new Error("Backend Wax Entry creation is not available.");
  }

  saveStatus.textContent = "Generating barcode...";
  const savedEntry = normalizeEntry(await Backend.createWaxEntryWithNumber(entry, currentUser));

  if (!savedEntry.internalTreeNumber || !savedEntry.barcodeValue) {
    throw new Error("Backend did not return generated barcode values.");
  }

  if (hasDuplicateBarcodeValue(savedEntry.barcodeValue, savedEntry.id)) {
    throw new Error("Duplicate barcode value detected.");
  }

  state.entries = state.entries.filter((existingEntry) => existingEntry.id !== savedEntry.id);
  state.entries.unshift(savedEntry);
  state.internalTreeSequences = normalizeInternalTreeSequences(state.internalTreeSequences, state.entries);
  editingEntryId = null;
  clearEntryForm();
  writeLocalWaxEntriesState();
  render();
  saveStatus.textContent = `Submitted ${savedEntry.barcodeValue}`;
  recordWaxEntryCreatedAudit(savedEntry);
}

function recordWaxEntryCreatedAudit(entry) {
  recordAudit("Internal Tree Number Generated", {
    barcodeValue: entry.barcodeValue,
    isInHouseProduction: entry.isInHouseProduction,
    module: "Wax Entries",
    internalTreeNumber: entry.internalTreeNumber,
    newValue: {
      barcodeValue: entry.barcodeValue,
      internalTreeNumber: entry.internalTreeNumber,
      isInHouseProduction: entry.isInHouseProduction
    }
  });
  recordAudit("Wax Entry created", {
    barcodeValue: entry.barcodeValue,
    isInHouseProduction: entry.isInHouseProduction,
    module: "Wax Entries",
    internalTreeNumber: entry.internalTreeNumber,
    newValue: entry
  });
}

async function submitEntry() {
  if (!canUseModule("waxEntries", "create")) {
    showAccessMessage(permissionDeniedMessage);
    return;
  }

  const metalKt = formFields.metalKt.value;
  const entry = {
    vendorCustomerName: formFields.vendorCustomerName.value.trim(),
    date: formFields.date.value,
    waxInvoiceNo: formFields.waxInvoiceNo.value.trim(),
    waxWeight: formFields.waxWeight.value.trim(),
    customerVendorTreeNo: formFields.customerVendorTreeNo.value.trim(),
    metalKt,
    color: getColorForMetal(metalKt, formFields.color.value),
    isInHouseProduction: Boolean(inHouseProductionInput?.checked),
    isRush: false
  };

  if (!hasEntryData(entry)) {
    saveStatus.textContent = "Enter data first";
    formFields.vendorCustomerName.focus();
    return;
  }

  if (!entry.date) {
    saveStatus.textContent = "Enter date to generate barcode";
    formFields.date.focus();
    return;
  }

  if (canUseBackendWaxEntries()) {
    try {
      await createWaxEntryInBackend(entry);
    } catch (error) {
      console.warn("Backend Wax Entry create failed.", error);
      saveStatus.textContent = error.message || "Wax Entry could not be created.";
    }
    return;
  }

  saveStatus.textContent = "Generating barcode...";
  const generatedTree = generateUniqueBarcodeFields(entry);

  if (!generatedTree) {
    saveStatus.textContent = "Duplicate barcode value detected";
    return;
  }

  const savedEntry = normalizeEntry({
    ...entry,
    ...generatedTree
  });

  if (!savedEntry.barcodeValue || hasDuplicateBarcodeValue(savedEntry.barcodeValue, savedEntry.id)) {
    saveStatus.textContent = "Duplicate barcode value detected";
    return;
  }

  state.entries.unshift(savedEntry);
  editingEntryId = null;
  clearEntryForm();
  render();
  scheduleSave(`Submitted ${savedEntry.barcodeValue}`);
  const persistedEntry = await persistWaxEntryToBackend(savedEntry, { ensureCastingOrder: true });
  const auditedEntry = persistedEntry || savedEntry;
  recordWaxEntryCreatedAudit(auditedEntry);
}

function clearEntryForm() {
  Object.values(formFields).forEach((field) => {
    field.value = "";
  });
  if (inHouseProductionInput) {
    inHouseProductionInput.checked = false;
  }
  syncColorControl(formFields.metalKt, formFields.color);
  formFields.vendorCustomerName.focus();
}

async function deleteRow(entryId) {
  if (!canUseModule("waxEntries", "delete")) {
    showAccessMessage(permissionDeniedMessage);
    return;
  }

  if (isEntryInventoryPosted(entryId)) {
    showInventoryLockedMessage(entryId, "Delete row");
    return;
  }

  const deletedEntry = state.entries.find((entry) => entry.id === entryId);
  state.entries = state.entries.filter((entry) => entry.id !== entryId);
  if (editingEntryId === entryId) {
    editingEntryId = null;
  }
  render();
  scheduleSave("Deleted");
  await deleteWaxEntryFromBackend(deletedEntry);
  if (deletedEntry) {
    recordAudit("Wax Entry deleted", {
      barcodeValue: getBarcodeValue(deletedEntry),
      isInHouseProduction: Boolean(deletedEntry.isInHouseProduction),
      module: "Wax Entries",
      internalTreeNumber: getInternalTreeNumber(deletedEntry),
      oldValue: deletedEntry
    });
  }
}

async function toggleRush(entryId) {
  if (!canMarkRush()) {
    showAccessMessage(permissionDeniedMessage);
    return;
  }

  if (isEntryInventoryPosted(entryId)) {
    showInventoryLockedMessage(entryId, "Mark Rush");
    return;
  }

  const targetEntry = state.entries.find((entry) => entry.id === entryId);
  if (!targetEntry) return;

  const isRush = !targetEntry.isRush;
  const updatedEntry = { ...targetEntry, isRush };
  state.entries = state.entries.map((entry) => (entry.id === entryId ? updatedEntry : entry));
  render();
  scheduleSave(isRush ? "Rush enabled" : "Rush removed");
  await persistWaxEntryToBackend(updatedEntry);
  recordAudit(isRush ? "Rush marked" : "Rush removed", {
    barcodeValue: getBarcodeValue(targetEntry),
    isInHouseProduction: Boolean(targetEntry.isInHouseProduction),
    module: "Wax Entries",
    internalTreeNumber: getInternalTreeNumber(targetEntry),
    oldValue: { isRush: targetEntry.isRush },
    newValue: { isRush }
  });
}

function beginEdit(entryId) {
  if (!canUseModule("waxEntries", "edit")) {
    showAccessMessage(permissionDeniedMessage);
    return;
  }

  if (isEntryInventoryPosted(entryId)) {
    showInventoryLockedMessage(entryId, "Edit row");
    return;
  }

  editingEntryId = entryId;
  render();

  const row = Array.from(entryRows.querySelectorAll("tr")).find((item) => item.dataset.entryId === entryId);
  if (row) {
    const firstInput = row.querySelector("[data-edit-field]");
    if (firstInput) {
      firstInput.focus();
    }
  }
}

function cancelEdit() {
  editingEntryId = null;
  render();
  saveStatus.textContent = "Edit cancelled";
}

async function saveEditedRow(entryId, row) {
  if (!canUseModule("waxEntries", "edit")) {
    showAccessMessage(permissionDeniedMessage);
    return;
  }

  if (isEntryInventoryPosted(entryId)) {
    showInventoryLockedMessage(entryId, "Save row");
    editingEntryId = null;
    render();
    return;
  }

  const entryIndex = state.entries.findIndex((entry) => entry.id === entryId);
  if (entryIndex === -1) return;
  const previousEntry = { ...state.entries[entryIndex] };
  const preservedBarcodeValue = getBarcodeValue(previousEntry);

  const updatedEntry = {
    id: entryId,
    internalTreeNumber: state.entries[entryIndex].internalTreeNumber,
    barcodeValue:
      preservedBarcodeValue ||
      buildBarcodeValue(
        row.querySelector('[data-edit-field="date"]').value,
        state.entries[entryIndex].internalTreeNumber
      ),
    vendorCustomerName: row.querySelector('[data-edit-field="vendorCustomerName"]').value.trim(),
    date: row.querySelector('[data-edit-field="date"]').value,
    waxInvoiceNo: row.querySelector('[data-edit-field="waxInvoiceNo"]').value.trim(),
    waxWeight: row.querySelector('[data-edit-field="waxWeight"]').value.trim(),
    customerVendorTreeNo: row.querySelector('[data-edit-field="customerVendorTreeNo"]').value.trim(),
    metalKt: row.querySelector('[data-edit-field="metalKt"]').value,
    color: getColorForMetal(
      row.querySelector('[data-edit-field="metalKt"]').value,
      row.querySelector('[data-edit-field="color"]').value
    ),
    isInHouseProduction: Boolean(state.entries[entryIndex].isInHouseProduction),
    isRush: Boolean(state.entries[entryIndex].isRush),
    createdAt: state.entries[entryIndex].createdAt || "",
    updatedAt: state.entries[entryIndex].updatedAt || "",
    createdBy: state.entries[entryIndex].createdBy || ""
  };

  if (!hasEntryData(updatedEntry)) {
    saveStatus.textContent = "Keep at least one value";
    return;
  }

  if (updatedEntry.barcodeValue && hasDuplicateBarcodeValue(updatedEntry.barcodeValue, entryId)) {
    saveStatus.textContent = "Duplicate barcode value detected";
    return;
  }

  state.entries[entryIndex] = updatedEntry;
  editingEntryId = null;
  render();
  scheduleSave("Updated");
  const persistedEntry = await persistWaxEntryToBackend(updatedEntry);
  const auditedEntry = persistedEntry || updatedEntry;
  recordAudit("Wax Entry edited", {
    barcodeValue: getBarcodeValue(auditedEntry),
    isInHouseProduction: Boolean(auditedEntry.isInHouseProduction),
    module: "Wax Entries",
    internalTreeNumber: getInternalTreeNumber(auditedEntry),
    oldValue: previousEntry,
    newValue: auditedEntry
  });
}

function exportCsv() {
  if (!canUseModule("waxEntries", "export")) {
    showAccessMessage(permissionDeniedMessage);
    return;
  }

  const header = [
    "Vendor / Customer Name",
    "Date",
    "Wax Invoice No.",
    "Customer / Vendor Tree No.",
    "Metal KT",
    "Color",
    "Wax Weight",
    "Internal Tree Number",
    "In-House Production",
    "Barcode Value"
  ];
  const rows = state.entries.map((entry) => [
    entry.vendorCustomerName,
    entry.date,
    entry.waxInvoiceNo,
    entry.customerVendorTreeNo,
    entry.metalKt,
    entry.color,
    entry.waxWeight,
    getInternalTreeNumber(entry),
    entry.isInHouseProduction ? "Yes" : "No",
    getBarcodeValue(entry)
  ]);
  const csv = [header, ...rows].map((row) => row.map(escapeCsvCell).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `production-entries-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
  recordAudit("Export CSV", {
    module: "Wax Entries",
    notes: `${rows.length} rows exported`
  });
}

function printEntryLabel(entryId) {
  if (!canUseModule("waxEntries", "print")) {
    showAccessMessage(permissionDeniedMessage);
    return;
  }

  const entry = state.entries.find((item) => item.id === entryId);
  if (!entry) return;

  const labelData = buildLabelData(entry);
  if (!labelData) {
    saveStatus.textContent = "Enter date and internal tree number before printing";
    return;
  }

  printArea.innerHTML = renderPrintLabel(labelData);
  printArea.setAttribute("aria-hidden", "false");
  saveStatus.textContent = "Preparing label...";

  requestAnimationFrame(() => {
    waitForBarcodeRender().finally(() => {
      saveStatus.textContent = "Print dialog opened";
      window.print();
      recordAudit("Print", {
        barcodeValue: labelData.barcodeValue,
        isInHouseProduction: labelData.isInHouseProduction,
        module: "Wax Entries",
        internalTreeNumber: getInternalTreeNumber(entry),
        newValue: {
          barcodeValue: labelData.barcodeValue,
          internalTreeNumber: labelData.internalTreeNumber,
          isInHouseProduction: labelData.isInHouseProduction,
          metalDisplay: labelData.metalDisplay,
          waxWeight: labelData.waxWeight
        }
      });
    });
  });
}

function buildLabelData(entry) {
  const internalTreeNumber = getInternalTreeNumber(entry);
  const barcodeValue = getBarcodeValue(entry);

  if (!barcodeValue || !internalTreeNumber) {
    return null;
  }

  return {
    barcodeSvg: renderCode128Svg(barcodeValue, "label-barcode-svg", 64),
    barcodeValue,
    customerVendorTreeNo: formatLabelText(entry.customerVendorTreeNo),
    internalTreeNumber,
    inHouseProductionDisplay: entry.isInHouseProduction ? "Yes" : "No",
    isInHouseProduction: Boolean(entry.isInHouseProduction),
    metalDisplay: formatEntryMetal(entry),
    vendorInvoiceDisplay: formatVendorInvoiceDisplay(entry),
    waxWeight: formatLabelWaxWeight(entry.waxWeight)
  };
}

function getBarcodeDate(date) {
  const [year, month, day] = String(date || "").split("-");
  if (!year || !month || !day) return "";
  return `${year}${month}${day}`;
}

function formatEntryMetal(entry) {
  return [entry.metalKt, entry.color].map((value) => String(value || "").trim()).filter(Boolean).join(" ") || "Metal pending";
}

function formatLabelText(value, fallback = "-") {
  return String(value || "").trim() || fallback;
}

function formatVendorInvoiceDisplay(entry) {
  return `${formatLabelText(entry.vendorCustomerName)} / ${formatLabelText(entry.waxInvoiceNo)}`;
}

function formatLabelWaxWeight(value) {
  const waxWeight = String(value || "").trim();
  return waxWeight ? `${waxWeight} g` : "Wax weight pending";
}

function renderPrintLabel(labelData) {
  return `
    <section class="print-label" aria-label="Barcode label">
      <div class="label-barcode">${labelData.barcodeSvg}</div>
      <div class="label-code">${escapeHtml(labelData.barcodeValue)}</div>
      <div class="label-details">
        <span class="label-detail-label">Internal Tree Number:</span>
        <span class="label-detail-value">${escapeHtml(labelData.internalTreeNumber)}</span>
        <span class="label-detail-label">Customer / Vendor Tree No.:</span>
        <span class="label-detail-value">${escapeHtml(labelData.customerVendorTreeNo)}</span>
        <span class="label-detail-label">Vendor Name / Invoice No.:</span>
        <span class="label-detail-value">${escapeHtml(labelData.vendorInvoiceDisplay)}</span>
        <span class="label-detail-label">Metal KT and Color:</span>
        <span class="label-detail-value">${escapeHtml(labelData.metalDisplay)}</span>
        <span class="label-detail-label">Wax Weight:</span>
        <span class="label-detail-value">${escapeHtml(labelData.waxWeight)}</span>
        <span class="label-detail-label">In-House Production:</span>
        <span class="label-detail-value">${escapeHtml(labelData.inHouseProductionDisplay)}</span>
      </div>
    </section>
  `;
}

function waitForBarcodeRender() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

function getTodayDateValue() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function setDateToToday(input) {
  if (!input) return;

  input.value = getTodayDateValue();
  input.focus();
}

function copyLastColumnValue(field, input, label) {
  const lastValue = getLastColumnValue(field);
  if (!lastValue) {
    saveStatus.textContent = `No previous ${label}`;
    input.focus();
    return;
  }

  input.value = lastValue;
  input.focus();
  saveStatus.textContent = `Copied last ${label}`;
}

function getLastColumnValue(field) {
  const entry = state.entries.find((item) => String(item[field] || "").trim());
  return entry ? String(entry[field]).trim() : "";
}

function formatDate(date) {
  const [year, month, day] = date.split("-");
  if (!year || !month || !day) return date;
  return `${month}/${day}/${year}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function escapeCsvCell(value) {
  const cell = String(value ?? "");
  if (/[",\n]/.test(cell)) {
    return `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}

async function handleLoginSubmit(event) {
  event.preventDefault();

  if (!RBAC?.login) return;

  const usernameInput = loginRoot.querySelector("[data-login-username]");
  const passwordInput = loginRoot.querySelector("[data-login-password]");
  const messageElement = loginRoot.querySelector("[data-login-message]");
  const username = usernameInput?.value.trim() || "";
  const password = passwordInput?.value || "";

  if (!username) {
    messageElement.textContent = "Email/username is required.";
    usernameInput.focus();
    return;
  }

  if (!password) {
    messageElement.textContent = "Password is required.";
    passwordInput.focus();
    return;
  }

  messageElement.textContent = "Signing in...";
  const result = await RBAC.login(username, password);

  if (!result.ok) {
    messageElement.textContent = result.error || "Invalid username or password";
    return;
  }

  renderAuthState();
  const defaultModuleId = getDefaultModuleId();
  if (defaultModuleId) {
    switchModule(defaultModuleId);
  }
}

function togglePasswordVisibility(button) {
  const wrapper = button.closest(".password-control");
  const input = wrapper?.querySelector("input");
  if (!input) return;

  const shouldShow = input.type === "password";
  input.type = shouldShow ? "text" : "password";
  button.textContent = shouldShow ? "Hide" : "Show";
  button.title = shouldShow ? "Hide password" : "Show password";
  button.setAttribute("aria-label", button.title);
}

entryRows.addEventListener("click", (event) => {
  const row = event.target.closest("tr");
  if (!row || !row.dataset.entryId) return;

  const entryId = row.dataset.entryId;

  if (event.target.matches("[data-edit-row]")) {
    beginEdit(entryId);
    return;
  }

  if (event.target.closest("[data-rush-row]")) {
    toggleRush(entryId);
    return;
  }

  if (event.target.closest("[data-print-row]")) {
    printEntryLabel(entryId);
    return;
  }

  if (event.target.matches("[data-today-edit]")) {
    setDateToToday(row.querySelector('[data-edit-field="date"]'));
    return;
  }

  if (event.target.matches("[data-save-edit]")) {
    saveEditedRow(entryId, row);
    return;
  }

  if (event.target.matches("[data-cancel-edit]")) {
    cancelEdit();
    return;
  }

  if (event.target.matches("[data-delete-row]")) {
    deleteRow(entryId);
  }
});

entryRows.addEventListener("keydown", (event) => {
  if (!event.target.matches("[data-edit-field]")) return;

  const row = event.target.closest("tr");
  if (!row || !row.dataset.entryId) return;

  if (event.key === "Enter") {
    event.preventDefault();
    saveEditedRow(row.dataset.entryId, row);
  }

  if (event.key === "Escape") {
    event.preventDefault();
    cancelEdit();
  }
});

entryRows.addEventListener("change", (event) => {
  if (!event.target.matches('[data-edit-field="metalKt"]')) return;

  const row = event.target.closest("tr");
  if (!row) return;

  syncColorControl(
    row.querySelector('[data-edit-field="metalKt"]'),
    row.querySelector('[data-edit-field="color"]')
  );
});

Object.values(formFields).forEach((field) => {
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitEntry();
    }
  });
});

formFields.metalKt.addEventListener("change", () => {
  syncColorControl(formFields.metalKt, formFields.color);
});

todayDateButton.addEventListener("click", () => {
  setDateToToday(formFields.date);
});

copyLastVendorButton.addEventListener("click", () => {
  copyLastColumnValue("vendorCustomerName", formFields.vendorCustomerName, "vendor/customer name");
});

copyLastInvoiceButton.addEventListener("click", () => {
  copyLastColumnValue("waxInvoiceNo", formFields.waxInvoiceNo, "wax invoice number");
});

Object.values(filterFields).forEach((field) => {
  field.addEventListener("input", () => {
    render();
  });
});

clearFiltersButton.addEventListener("click", () => {
  Object.values(filterFields).forEach((field) => {
    field.value = "";
  });
  render();
  saveStatus.textContent = "Filters cleared";
});

if (roleManagementRoot) {
  roleManagementRoot.addEventListener("click", (event) => {
    const selectedRoleButton = event.target.closest("[data-select-role]");
    if (selectedRoleButton) {
      selectedRoleId = selectedRoleButton.dataset.selectRole;
      renderRoleManagement();
      return;
    }

    if (event.target.closest("[data-new-role]")) {
      selectedRoleId = null;
      renderRoleManagement();
      setRoleStatus("Creating a new role.");
      return;
    }

    if (event.target.closest("[data-delete-role]")) {
      deleteSelectedRole();
    }
  });

  roleManagementRoot.addEventListener("submit", (event) => {
    if (!event.target.matches("[data-role-form]")) return;

    event.preventDefault();
    saveRoleFromForm();
  });
}

if (metalReceivingRoot) {
  metalReceivingRoot.addEventListener("submit", (event) => {
    if (!event.target.matches("[data-metal-receiving-form]")) return;

    event.preventDefault();
    submitMetalReceivingForm(event.target);
  });

  metalReceivingRoot.addEventListener("change", (event) => {
    if (!event.target.matches('[data-receiving-field="metalType"], [data-receiving-field="purity"]')) return;

    const form = event.target.closest("[data-metal-receiving-form]");
    const metalTypeInput = form?.querySelector('[data-receiving-field="metalType"]');
    const purityInput = form?.querySelector('[data-receiving-field="purity"]');

    if (event.target.matches('[data-receiving-field="metalType"]') && purityInput) {
      purityInput.value = getReceivingDefaultPurity(metalTypeInput?.value);
    }

    syncReceivingPurityOptions(form);
    refreshReceivingColorField(form);
  });

  metalReceivingRoot.addEventListener("input", (event) => {
    if (!event.target.matches('[data-receiving-field="purity"]')) return;

    refreshReceivingColorField(event.target.closest("[data-metal-receiving-form]"));
  });
}

if (inventoryRoot) {
  inventoryRoot.addEventListener("change", (event) => {
    if (!event.target.matches("[data-inventory-filter]")) return;

    inventoryFilters = {
      ...inventoryFilters,
      [event.target.dataset.inventoryFilter]: event.target.value
    };
    renderInventory();
  });

  inventoryRoot.addEventListener("click", (event) => {
    if (event.target.closest("[data-clear-inventory-filters]")) {
      inventoryFilters = {
        barcodeValue: "",
        dateFrom: "",
        dateTo: "",
        internalTreeNumber: "",
        metalKtColor: "",
        metalType: "",
        transactionType: ""
      };
      renderInventory();
      return;
    }

    if (event.target.closest("[data-export-inventory-ledger]")) {
      exportInventoryLedgerCsv();
    }
  });
}

if (userManagementRoot) {
  userManagementRoot.addEventListener("click", (event) => {
    const selectedUserButton = event.target.closest("[data-select-user]");
    if (selectedUserButton) {
      selectedUserId = selectedUserButton.dataset.selectUser;
      renderUserManagement();
      return;
    }

    if (event.target.closest("[data-new-user]")) {
      selectedUserId = null;
      renderUserManagement();
      setUserStatus("Creating a new user.");
      return;
    }

    if (event.target.closest("[data-toggle-password]")) {
      togglePasswordVisibility(event.target.closest("[data-toggle-password]"));
      return;
    }

    if (event.target.closest("[data-reset-password]")) {
      resetSelectedUserPassword();
      return;
    }

    if (event.target.closest("[data-deactivate-user]")) {
      deactivateSelectedUser().catch((error) => {
        setUserStatus(error.message || "User could not be deactivated.");
      });
      return;
    }

    if (event.target.closest("[data-delete-user]")) {
      deleteSelectedUser().catch((error) => {
        setUserStatus(error.message || "User could not be deleted.");
      });
    }
  });

  userManagementRoot.addEventListener("submit", (event) => {
    if (!event.target.matches("[data-user-form]")) return;

    event.preventDefault();
    saveUserFromForm();
  });
}

if (auditLogsRoot) {
  auditLogsRoot.addEventListener("change", (event) => {
    if (!event.target.matches("[data-audit-filter]")) return;

    auditFilters = {
      ...auditFilters,
      [event.target.dataset.auditFilter]: event.target.value
    };
    renderAuditLogs();
  });

  auditLogsRoot.addEventListener("click", (event) => {
    if (event.target.closest("[data-clear-audit-filters]")) {
      auditFilters = {
        action: "",
        barcodeValue: "",
        dateFrom: "",
        dateTo: "",
        internalTreeNumber: "",
        module: "",
        stage: "",
        user: ""
      };
      renderAuditLogs();
      return;
    }

    if (event.target.closest("[data-export-audit-logs]")) {
      exportAuditLogsCsv();
      return;
    }

    if (event.target.closest("[data-download-kt-formula-table]")) {
      downloadKtFormulaTableCsv();
    }
  });
}

if (loginRoot) {
  loginRoot.addEventListener("submit", (event) => {
    if (!event.target.matches("[data-login-form]")) return;
    handleLoginSubmit(event);
  });

  loginRoot.addEventListener("click", (event) => {
    if (event.target.closest("[data-toggle-password]")) {
      togglePasswordVisibility(event.target.closest("[data-toggle-password]"));
    }
  });
}

if (logoutButton) {
  logoutButton.addEventListener("click", () => {
    if (RBAC?.logout) {
      RBAC.logout();
    }
    renderAuthState();
  });
}

moduleTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    switchModule(tab.dataset.moduleTarget);
  });
});

submitEntryButton.addEventListener("click", submitEntry);
exportCsvButton.addEventListener("click", exportCsv);

window.addEventListener("afterprint", () => {
  printArea.setAttribute("aria-hidden", "true");
  saveStatus.textContent = "Saved";
});

window.addEventListener("beforeunload", stopLiveSync);

if (RBAC) {
  window.addEventListener(RBAC.rolesChangedEvent, () => {
    render();
  });
  if (RBAC.usersChangedEvent) {
    window.addEventListener(RBAC.usersChangedEvent, () => {
      render();
    });
  }
  if (RBAC.authChangedEvent) {
    window.addEventListener(RBAC.authChangedEvent, () => {
      renderAuthState();
    });
  }
  window.addEventListener(RBAC.auditChangedEvent, () => {
    renderAuditLogs();
  });
}

if (Inventory) {
  window.addEventListener(Inventory.receivingChangedEvent, () => {
    renderMetalReceiving();
    renderInventory();
  });
  window.addEventListener(Inventory.ledgerChangedEvent, () => {
    renderInventory();
  });
}

window.addEventListener(kanbanWorkflowChangedEvent, () => {
  renderRows();
});

window.addEventListener("storage", (event) => {
  if (event.key === kanbanStorageKey) {
    renderRows();
  }
});

window.ProductionAuthComponents = {
  AuthProvider,
  LoginPage,
  ProtectedRoute,
  RoleAssignment,
  UserForm,
  UserManagement,
  auditLogger,
  permissionUtils,
  useAuth
};

window.ProductionBarcode = {
  getBarcodeValue,
  normalizeBarcodeSearch,
  normalizeBarcodeValue,
  renderCode128Svg
};

populateDropdowns();
AuthProvider();
if (!RBAC || RBAC.isAuthenticated()) {
  scheduleSave();
}
