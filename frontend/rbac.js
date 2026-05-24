(function () {
  "use strict";

  const roleStorageKey = "production-management-rbac-v2";
  const legacyRoleStorageKey = "production-management-rbac-v1";
  const auditStorageKey = "production-management-audit-v1";
  const rolesChangedEvent = "productionRbacRolesChanged";
  const auditChangedEvent = "productionAuditLogsChanged";
  const backendFoundationAuditActions = new Set([
    "failed login attempt",
    "awaiting metal submitted",
    "casting completed submitted",
    "damaged marked",
    "damaged tree moved to damaged list",
    "attempted duplicate inventory posting",
    "final inventory posted",
    "inventory ledger transaction created",
    "metal received",
    "order completed",
    "order locked after inventory posting",
    "order moved between stages",
    "password reset",
    "quality check and control submitted",
    "ready for casting submitted",
    "received order weight submitted",
    "returned to awaiting metal",
    "role created",
    "role deleted",
    "role edited",
    "roles assigned or removed",
    "rush marked",
    "rush removed",
    "user created",
    "user deactivated",
    "user deleted",
    "user edited",
    "wax entry created",
    "wax entry deleted",
    "wax entry edited",
    "user logged in",
    "user logged out",
    "user session expired"
  ]);

  let backendRoles = [];
  let backendAuditLogs = [];
  let backendSyncStarted = false;

  const resources = {
    modules: [
      { id: "waxEntries", label: "Wax Entries" },
      { id: "castingProcess", label: "Casting Process" },
      { id: "metalReceiving", label: "Metal Receiving" },
      { id: "inventory", label: "Inventory" },
      { id: "invoicing", label: "Invoicing" }
    ],
    moduleActions: [
      { id: "view", label: "View" },
      { id: "create", label: "Create" },
      { id: "edit", label: "Edit" },
      { id: "delete", label: "Delete" },
      { id: "export", label: "Export CSV" },
      { id: "print", label: "Print" }
    ],
    stages: [
      { id: "awaitingMetal", label: "Awaiting Metal", stageKey: "Awaiting Metal" },
      { id: "readyForCasting", label: "Ready for Casting", stageKey: "Ready for Casting" },
      { id: "castingCompleted", label: "Casting Completed", stageKey: "Casting Completed" },
      { id: "qualityCheck", label: "Quality Check and Control", stageKey: "QC Completed" },
      { id: "orderCompleted", label: "Order Completed", stageKey: "Received at Store" }
    ],
    stageActions: [
      { id: "view", label: "View stage" },
      { id: "open", label: "Open focused order" },
      { id: "edit", label: "Edit focused form" },
      { id: "submit", label: "Submit stage" },
      { id: "print", label: "Print" },
      { id: "markDamaged", label: "Mark damaged" },
      { id: "viewDamagedTrees", label: "View damaged trees" }
    ],
    specialPermissions: [
      { id: "roles.manage", label: "Manage Roles" },
      { id: "users.manage", label: "Manage Users" },
      { id: "roles.assign", label: "Assign Roles" },
      { id: "rush.mark", label: "Mark Rush" },
      { id: "auditLogs.view", label: "View Audit Logs" },
      { id: "auditLogs.export", label: "Export Audit Logs" },
      { id: "inventoryLedger.view", label: "View Inventory Ledger" },
      { id: "inventoryLedger.export", label: "Export Inventory Ledger" },
      { id: "inventory.postFinal", label: "Post Final Inventory" },
      { id: "inventory.adjustment.future", label: "Manual Adjustment (Future)" }
    ]
  };

  const permissionTokens = {
    module: (moduleId, action = "view") => `${moduleId}.${normalizeModuleAction(action)}`,
    stage: (stageId, action = "view") => `casting.${normalizeStageId(stageId)}.${normalizeStageAction(action)}`,
    special: (permissionId) => normalizeSpecialPermission(permissionId),
    system: (resourceId, action) => normalizeSystemPermission(resourceId, action),
    action: (action) => normalizeSpecialPermission(action)
  };

  const currentUser = {
    id: "anonymous",
    name: "Unauthenticated",
    username: "anonymous",
    email: "",
    assignedRoleIds: [],
    roleIds: [],
    isActive: false
  };

  function normalizeModuleAction(action) {
    const normalized = normalizeKey(action);
    const aliases = {
      exportcsv: "export",
      markrush: "markRush",
      printlabel: "print"
    };
    return aliases[normalized] || normalized || "view";
  }

  function normalizeStageAction(action) {
    const normalized = normalizeKey(action);
    const aliases = {
      openfocusedorder: "open",
      editfocusedform: "edit",
      submitstage: "submit",
      viewstage: "view",
      markdamaged: "markDamaged",
      viewdamagedtrees: "viewDamagedTrees"
    };
    return aliases[normalized] || normalized || "view";
  }

  function normalizeSpecialPermission(permissionId) {
    const normalized = normalizeKey(permissionId);
    const aliases = {
      assignroles: "roles.assign",
      auditlogsexport: "auditLogs.export",
      auditlogsview: "auditLogs.view",
      exportauditlogs: "auditLogs.export",
      exportinventoryledger: "inventoryLedger.export",
      inventoryadjustmentfuture: "inventory.adjustment.future",
      inventoryledgerexport: "inventoryLedger.export",
      inventoryledgerview: "inventoryLedger.view",
      inventorypostfinal: "inventory.postFinal",
      manageroles: "roles.manage",
      manageusers: "users.manage",
      markrush: "rush.mark",
      postfinalinventory: "inventory.postFinal",
      rolesassign: "roles.assign",
      rolesmanage: "roles.manage",
      rushmark: "rush.mark",
      usersmanage: "users.manage",
      viewauditlogs: "auditLogs.view",
      viewinventoryledger: "inventoryLedger.view"
    };

    if (String(permissionId || "").includes(".")) {
      return String(permissionId).trim();
    }

    return aliases[normalized] || normalized;
  }

  function normalizeSystemPermission(resourceId, action) {
    const resource = normalizeKey(resourceId);
    const normalizedAction = normalizeKey(action);

    if (resource === "roles" && normalizedAction === "manage") return "roles.manage";
    if (resource === "users" && normalizedAction === "manage") return "users.manage";
    if (resource === "roles" && normalizedAction === "assign") return "roles.assign";
    if (resource === "auditlogs" && normalizedAction === "view") return "auditLogs.view";
    if (resource === "auditlogs" && normalizedAction === "export") return "auditLogs.export";
    if (resource === "inventoryledger" && normalizedAction === "view") return "inventoryLedger.view";
    if (resource === "inventoryledger" && normalizedAction === "export") return "inventoryLedger.export";
    if (resource === "inventory" && normalizedAction === "postfinal") return "inventory.postFinal";
    if (resource === "inventory" && normalizedAction === "adjustmentfuture") return "inventory.adjustment.future";

    return `${resourceId}.${normalizedAction}`;
  }

  function normalizeStageId(stageId) {
    const rawValue = String(stageId || "").trim();
    const normalized = normalizeKey(rawValue);
    const matchedStage = resources.stages.find(
      (stage) =>
        normalizeKey(stage.id) === normalized ||
        normalizeKey(stage.stageKey) === normalized ||
        normalizeKey(stage.label) === normalized
    );

    return matchedStage ? matchedStage.id : rawValue;
  }

  function normalizeKey(value) {
    return String(value || "")
      .trim()
      .replace(/[_\-\s]+/g, "")
      .toLowerCase();
  }

  function createDefaultRoles() {
    const allPermissions = [
      ...resources.modules.flatMap((module) =>
        resources.moduleActions.map((action) => permissionTokens.module(module.id, action.id))
      ),
      ...resources.stages.flatMap((stage) =>
        resources.stageActions.map((action) => permissionTokens.stage(stage.id, action.id))
      ),
      ...resources.specialPermissions.map((permission) => permission.id)
    ];

    return [
      {
        id: "role_admin",
        name: "Admin",
        description: "Full system access.",
        isActive: true,
        permissions: allPermissions,
        system: true
      },
      {
        id: "role_wax_entry",
        name: "Wax Entry",
        description: "Can manage Wax Entries, labels, exports, and rush priority.",
        isActive: true,
        permissions: [
          "waxEntries.view",
          "waxEntries.create",
          "waxEntries.edit",
          "waxEntries.delete",
          "waxEntries.export",
          "waxEntries.print",
          "rush.mark"
        ]
      },
      {
        id: "role_casting",
        name: "Casting",
        description: "Can process casting stages from metal issue through casting completion.",
        isActive: true,
        permissions: [
          "castingProcess.view",
          "casting.awaitingMetal.view",
          "casting.awaitingMetal.open",
          "casting.awaitingMetal.edit",
          "casting.awaitingMetal.submit",
          "casting.readyForCasting.view",
          "casting.readyForCasting.open",
          "casting.readyForCasting.edit",
          "casting.readyForCasting.submit",
          "casting.readyForCasting.markDamaged",
          "casting.readyForCasting.viewDamagedTrees",
          "casting.castingCompleted.view",
          "casting.castingCompleted.open",
          "casting.castingCompleted.edit",
          "casting.castingCompleted.submit",
          "casting.castingCompleted.viewDamagedTrees"
        ]
      },
      {
        id: "role_qc",
        name: "QC",
        description: "Can complete Quality Check and Control.",
        isActive: true,
        permissions: [
          "castingProcess.view",
          "casting.qualityCheck.view",
          "casting.qualityCheck.open",
          "casting.qualityCheck.edit",
          "casting.qualityCheck.submit"
        ]
      },
      {
        id: "role_store",
        name: "Store",
        description: "Can review completed orders and post final inventory.",
        isActive: true,
        permissions: [
          "castingProcess.view",
          "casting.orderCompleted.view",
          "casting.orderCompleted.open",
          "casting.orderCompleted.edit",
          "casting.orderCompleted.submit",
          "inventory.view",
          "inventoryLedger.view",
          "inventory.postFinal"
        ]
      },
      {
        id: "role_inventory",
        name: "Inventory",
        description: "Can receive metal, view stock balances, and export inventory ledger.",
        isActive: true,
        permissions: [
          "metalReceiving.view",
          "metalReceiving.create",
          "inventory.view",
          "inventory.export",
          "inventoryLedger.view",
          "inventoryLedger.export"
        ]
      },
      {
        id: "role_invoicing",
        name: "Invoicing",
        description: "Can manage invoice companies, orders, line items, and generated invoice records.",
        isActive: true,
        permissions: ["invoicing.view", "invoicing.create", "invoicing.edit", "invoicing.delete", "invoicing.export", "invoicing.print"]
      }
    ];
  }

  function normalizeRole(role) {
    return {
      id: String(role.id || createId("role")).trim(),
      name: String(role.name || "Untitled Role").trim(),
      description: String(role.description || "").trim(),
      isActive: role.isActive !== false,
      permissions: uniqueArray(expandLegacyPermissions(Array.isArray(role.permissions) ? role.permissions : [])),
      system: Boolean(role.system)
    };
  }

  function expandLegacyPermissions(rawPermissions) {
    const permissions = rawPermissions.map(String).filter(Boolean);
    const nextPermissions = [];
    const legacyModules = [];
    const legacyStages = [];
    const legacyActions = [];

    permissions.forEach((permission) => {
      if (permission.startsWith("module:")) {
        legacyModules.push(permission.split(":")[1]);
        return;
      }

      if (permission.startsWith("stage:")) {
        legacyStages.push(normalizeStageId(permission.split(":")[1]));
        return;
      }

      if (permission.startsWith("action:")) {
        legacyActions.push(permission.split(":")[1]);
        return;
      }

      if (permission.startsWith("system:")) {
        const [, resourceId, action] = permission.split(":");
        nextPermissions.push(permissionTokens.system(resourceId, action));
        return;
      }

      nextPermissions.push(permission);
    });

    legacyModules.forEach((moduleId) => {
      nextPermissions.push(permissionTokens.module(moduleId, "view"));
      legacyActions.forEach((action) => {
        const moduleAction = normalizeModuleAction(action);
        if (resources.moduleActions.some((item) => item.id === moduleAction)) {
          nextPermissions.push(permissionTokens.module(moduleId, moduleAction));
        }
      });
    });

    legacyStages.forEach((stageId) => {
      nextPermissions.push(permissionTokens.stage(stageId, "view"));
      legacyActions.forEach((action) => {
        const stageAction = normalizeStageAction(action);
        if (resources.stageActions.some((item) => item.id === stageAction)) {
          nextPermissions.push(permissionTokens.stage(stageId, stageAction));
        }
      });
    });

    legacyActions.forEach((action) => {
      const specialPermission = normalizeSpecialPermission(action);
      if (resources.specialPermissions.some((item) => item.id === specialPermission)) {
        nextPermissions.push(specialPermission);
      }
    });

    return uniqueArray(nextPermissions);
  }

  function readState() {
    const storedState = readJson(roleStorageKey) || readJson(legacyRoleStorageKey);
    if (storedState && Array.isArray(storedState.roles)) {
      const roles = storedState.roles.map(normalizeRole).filter((role) => role.id && role.name);
      if (roles.length) {
        return ensureAdminRole({ roles });
      }
    }

    return { roles: createDefaultRoles().map(normalizeRole) };
  }

  function ensureAdminRole(state) {
    const defaultAdminRole = normalizeRole(createDefaultRoles()[0]);
    const hasAdmin = state.roles.some((role) => role.id === "role_admin" || role.id === "admin");

    if (!hasAdmin) {
      return { roles: [defaultAdminRole, ...state.roles] };
    }

    return {
      roles: state.roles.map((role) =>
        role.id === "role_admin" || role.id === "admin"
          ? {
              ...defaultAdminRole,
              id: "role_admin",
              name: role.name || defaultAdminRole.name,
              description: role.description || defaultAdminRole.description
            }
          : role
      )
    };
  }

  function writeState(state) {
    window.dispatchEvent(new CustomEvent(rolesChangedEvent, { detail: { roles: state.roles } }));
  }

  function getRoles() {
    return backendRoles.length ? backendRoles : readState().roles;
  }

  function getRole(roleId) {
    return getRoles().find((role) => role.id === roleId) || null;
  }

  function saveRole(role) {
    let normalizedRole = normalizeRole(role);

    if (normalizedRole.id === "admin") {
      normalizedRole.id = "role_admin";
    }

    if (normalizedRole.id === "role_admin") {
      const defaultAdminRole = normalizeRole(createDefaultRoles()[0]);
      normalizedRole = {
        ...normalizedRole,
        isActive: true,
        permissions: defaultAdminRole.permissions,
        system: true
      };
    }

    const state = readState();
    const existingIndex = state.roles.findIndex((item) => item.id === normalizedRole.id);

    if (existingIndex === -1) {
      state.roles.push(normalizedRole);
    } else {
      state.roles[existingIndex] = {
        ...state.roles[existingIndex],
        ...normalizedRole,
        system: state.roles[existingIndex].system || normalizedRole.system
      };
    }

    writeState(state);
    updateBackendRoleCache(normalizedRole);
    persistRoleToBackend(normalizedRole);
    return normalizedRole;
  }

  function deleteRole(roleId) {
    if (roleId === "role_admin" || roleId === "admin") {
      return false;
    }

    const state = readState();
    const nextRoles = state.roles.filter((role) => role.id !== roleId);
    if (nextRoles.length === state.roles.length) {
      return false;
    }

    writeState({ roles: nextRoles });
    backendRoles = backendRoles.filter((role) => role.id !== roleId);
    deleteRoleFromBackend(roleId);
    return true;
  }

  function getAssignedRoleIds(user) {
    return uniqueArray([...(user?.assignedRoleIds || []), ...(user?.roleIds || [])]).map((roleId) =>
      roleId === "admin" ? "role_admin" : roleId
    );
  }

  function getEffectivePermissions(user) {
    if (user && user.isActive === false) {
      return [];
    }

    const roleIds = getAssignedRoleIds(user);
    const roles = getRoles().filter((role) => role.isActive && roleIds.includes(role.id));
    return uniqueArray(roles.flatMap((role) => role.permissions));
  }

  function can(user, action, resource = {}) {
    const resourceType = resource.type || resource.resourceType || "";
    const resourceId = resource.id || resource.resourceId || "";

    if (resourceType === "module") {
      return hasModulePermission(user, resourceId, action);
    }

    if (resourceType === "stage") {
      return hasStagePermission(user, resourceId, action);
    }

    if (resourceType === "special") {
      return hasPermission(user, normalizeSpecialPermission(resourceId || action));
    }

    if (resourceType === "system") {
      const token = permissionTokens.system(resourceId, action);
      return hasPermission(user, token);
    }

    const specialPermission = normalizeSpecialPermission(action);
    return hasPermission(user, specialPermission);
  }

  function hasModulePermission(user, moduleId, action = "view") {
    const moduleAction = normalizeModuleAction(action);

    if (moduleAction === "markRush") {
      return hasPermission(user, "rush.mark");
    }

    return hasPermission(user, permissionTokens.module(moduleId, moduleAction));
  }

  function hasStagePermission(user, stageId, action = "view") {
    const normalizedStageId = normalizeStageId(stageId);
    const stageAction = normalizeStageAction(action);

    if (!hasPermission(user, "castingProcess.view")) {
      return false;
    }

    return hasPermission(user, permissionTokens.stage(normalizedStageId, stageAction));
  }

  function hasPermission(user, permission) {
    return getEffectivePermissions(user).includes(permission);
  }

  function getStageIdByKey(stageKey) {
    return normalizeStageId(stageKey);
  }

  function recordAuditLog(entry = {}) {
    const user = entry.user || currentUser;
    const logs = getLocalAuditLogs();
    const logEntry = {
      id: createId("audit"),
      userId: user.id || "unknown",
      username: user.username || user.name || "Unknown User",
      action: String(entry.action || "").trim() || "Action",
      barcodeValue: String(entry.barcodeValue || getAuditObjectBarcodeValue(entry.newValue) || getAuditObjectBarcodeValue(entry.oldValue) || "").trim(),
      isInHouseProduction: getAuditInHouseProductionValue(entry),
      module: String(entry.module || "").trim(),
      stage: String(entry.stage || "").trim(),
      internalTreeNumber: String(entry.internalTreeNumber || "").trim(),
      oldValue: formatAuditValue(entry.oldValue),
      newValue: formatAuditValue(entry.newValue),
      notes: String(entry.notes || "").trim(),
      device: String(entry.device || getDeviceInfo()).trim(),
      createdAt: entry.createdAt || new Date().toISOString()
    };

    const nextLogs = [logEntry, ...logs].slice(0, 1000);
    window.dispatchEvent(new CustomEvent(auditChangedEvent, { detail: { log: logEntry, logs: nextLogs } }));
    persistAuditLogToBackend(logEntry);
    return logEntry;
  }

  function getAuditLogs() {
    if (backendAuditLogs.length) {
      return backendAuditLogs;
    }

    return getLocalAuditLogs();
  }

  function getLocalAuditLogs() {
    const storedState = readJson(auditStorageKey);
    if (!storedState || !Array.isArray(storedState.logs)) {
      return [];
    }

    return storedState.logs
      .map((log) => ({
        id: String(log.id || createId("audit")),
        userId: String(log.userId || ""),
        username: String(log.username || ""),
        action: String(log.action || ""),
        barcodeValue: String(log.barcodeValue || getAuditObjectBarcodeValue(log.newValue) || getAuditObjectBarcodeValue(log.oldValue) || ""),
        isInHouseProduction: String(log.isInHouseProduction || ""),
        module: String(log.module || ""),
        stage: String(log.stage || ""),
        internalTreeNumber: String(log.internalTreeNumber || ""),
        oldValue: String(log.oldValue || ""),
        newValue: String(log.newValue || ""),
        notes: String(log.notes || ""),
        device: String(log.device || ""),
        createdAt: String(log.createdAt || "")
      }))
      .sort((first, second) => (new Date(second.createdAt).getTime() || 0) - (new Date(first.createdAt).getTime() || 0));
  }

  function getAuditObjectBarcodeValue(value) {
    if (!value || typeof value !== "object") {
      return "";
    }

    return String(value.barcodeValue || value.relatedBarcodeValue || "").trim();
  }

  function getAuditInHouseProductionValue(entry = {}) {
    const value = getFirstBooleanValue(
      entry.isInHouseProduction,
      getAuditObjectInHouseProduction(entry.newValue),
      getAuditObjectInHouseProduction(entry.oldValue)
    );

    if (typeof value !== "boolean") {
      return "";
    }

    return value ? "Yes" : "No";
  }

  function getAuditObjectInHouseProduction(value) {
    if (!value || typeof value !== "object") {
      return null;
    }

    return typeof value.isInHouseProduction === "boolean" ? value.isInHouseProduction : null;
  }

  function getFirstBooleanValue() {
    return Array.from(arguments).find((value) => typeof value === "boolean");
  }

  function formatAuditValue(value) {
    if (value === null || value === undefined || value === "") {
      return "";
    }

    if (typeof value === "object") {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }

    return String(value);
  }

  async function refreshBackendState() {
    const bridge = getBackendBridge();
    if (!bridge?.isConfigured?.()) return false;

    try {
      const [roles, auditLogs] = await Promise.all([
        bridge.fetchRoles(),
        bridge.fetchAuditLogs().catch((error) => {
          console.warn("Backend audit log refresh failed.", error);
          return [];
        })
      ]);

      if (roles.length) {
        backendRoles = roles.map(normalizeRole);
        window.dispatchEvent(new CustomEvent(rolesChangedEvent, { detail: { roles: backendRoles } }));
      }

      backendAuditLogs = auditLogs;
      window.dispatchEvent(new CustomEvent(auditChangedEvent, { detail: { logs: backendAuditLogs } }));

      return true;
    } catch (error) {
      console.warn("Backend RBAC refresh failed.", error);
      return false;
    }
  }

  function startBackendSync() {
    if (backendSyncStarted) return;
    backendSyncStarted = true;
    refreshBackendState();
  }

  function updateBackendRoleCache(role) {
    if (!backendRoles.length) return;

    const nextRole = normalizeRole(role);
    const existingIndex = backendRoles.findIndex((item) => item.id === nextRole.id);

    if (existingIndex === -1) {
      backendRoles = [...backendRoles, nextRole];
    } else {
      backendRoles = backendRoles.map((item, index) => (index === existingIndex ? nextRole : item));
    }
  }

  function persistRoleToBackend(role) {
    const bridge = getBackendBridge();
    if (!bridge?.isConfigured?.()) return;

    bridge
      .saveRole(role)
      .then(() => refreshBackendState())
      .catch((error) => {
        console.warn("Backend role save failed.", error);
      });
  }

  function deleteRoleFromBackend(roleId) {
    const bridge = getBackendBridge();
    if (!bridge?.isConfigured?.()) return;

    bridge
      .deleteRole(roleId)
      .then(() => refreshBackendState())
      .catch((error) => {
        console.warn("Backend role delete failed. Local RBAC cache is still updated.", error);
      });
  }

  function persistAuditLogToBackend(logEntry) {
    const bridge = getBackendBridge();
    if (!bridge?.isConfigured?.()) {
      return;
    }
    if (!shouldWriteAuditLogToBackend(logEntry)) {
      return;
    }

    bridge
      .insertAuditLog(logEntry)
      .then(() => refreshBackendAuditLogs())
      .catch((error) => {
        console.warn("Backend audit log insert failed.", error);
      });
  }

  function shouldWriteAuditLogToBackend(logEntry = {}) {
    return backendFoundationAuditActions.has(String(logEntry.action || "").trim().toLowerCase());
  }

  function getBackendBridge() {
    return window.CastingAPI;
  }

  async function refreshBackendAuditLogs() {
    const bridge = getBackendBridge();
    if (!bridge?.isConfigured?.()) return;

    try {
      const auditLogs = await bridge.fetchAuditLogs();
      backendAuditLogs = auditLogs;
      window.dispatchEvent(new CustomEvent(auditChangedEvent, { detail: { logs: backendAuditLogs } }));
    } catch (error) {
      console.warn("Backend audit log refresh failed.", error);
    }
  }

  function readJson(key) {
    return null;
  }

  function createId(prefix) {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return `${prefix}_${window.crypto.randomUUID()}`;
    }

    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function uniqueArray(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function getDeviceInfo() {
    return typeof navigator === "undefined" ? "" : navigator.userAgent || "";
  }

  window.ProductionRBAC = {
    auditChangedEvent,
    can,
    currentUser,
    deleteRole,
    getAuditLogs,
    getEffectivePermissions,
    getRole,
    getRoles,
    getStageIdByKey,
    hasModulePermission,
    hasPermission,
    hasStagePermission,
    permissionTokens,
    recordAuditLog,
    refreshBackendAuditLogs,
    refreshBackendState,
    resources,
    rolesChangedEvent,
    saveRole,
    startBackendSync
  };

})();
