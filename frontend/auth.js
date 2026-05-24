(function () {
  "use strict";

  const RBAC = window.ProductionRBAC;
  const API = window.CastingAPI;
  if (!RBAC || !API) return;

  const usersChangedEvent = "productionAuthUsersChanged";
  const authChangedEvent = "productionAuthSessionChanged";
  const sessionDurationMs = 8 * 60 * 60 * 1000;
  let backendUsers = [];
  let session = null;
  let hydrateStarted = false;

  const anonymousUser = {
    id: "anonymous",
    name: "Unauthenticated",
    username: "anonymous",
    email: "",
    assignedRoleIds: [],
    roleIds: [],
    isActive: false
  };

  function normalizeEmail(value) {
    return String(value || "").trim().toLowerCase();
  }

  function sanitizeUser(user) {
    if (!user) return null;
    const assignedRoleIds = uniqueArray([...(user.assignedRoleIds || []), ...(user.roleIds || [])]);
    return {
      id: String(user.id || ""),
      name: String(user.name || user.fullName || user.full_name || user.email || "").trim(),
      email: normalizeEmail(user.email || user.username),
      username: normalizeEmail(user.username || user.email),
      assignedRoleIds,
      roleIds: assignedRoleIds,
      isActive: user.isActive !== false,
      createdAt: user.createdAt || user.created_at || "",
      updatedAt: user.updatedAt || user.updated_at || "",
      lastLoginAt: user.lastLoginAt || user.last_login_at || ""
    };
  }

  function sanitizeUserForAudit(user) {
    return sanitizeUser(user) || "";
  }

  function setCurrentUser(user) {
    Object.keys(RBAC.currentUser).forEach((key) => delete RBAC.currentUser[key]);
    Object.assign(RBAC.currentUser, sanitizeUser(user) || anonymousUser);
  }

  function dispatchAuthChanged() {
    window.dispatchEvent(new CustomEvent(authChangedEvent, { detail: { user: getCurrentUser(), session } }));
  }

  function dispatchUsersChanged() {
    window.dispatchEvent(new CustomEvent(usersChangedEvent, { detail: { users: getUsers() } }));
  }

  async function login(username, password) {
    try {
      const result = await API.login(normalizeEmail(username), password);
      session = {
        token: result.token,
        userId: result.user?.id || "",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + sessionDurationMs).toISOString()
      };
      setCurrentUser(result.user);
      await refreshBackendUsers();
      await RBAC.refreshBackendState?.();
      dispatchAuthChanged();
      return { ok: true, user: sanitizeUser(result.user), session };
    } catch (error) {
      return { ok: false, error: error.message || "Invalid username or password" };
    }
  }

  function logout(options = {}) {
    const user = getCurrentUser();
    if (isAuthenticated()) {
      RBAC.recordAuditLog?.({
        action: options.reason === "Session expired" ? "User session expired" : "User logged out",
        user,
        module: "Auth",
        oldValue: { userId: user.id },
        notes: options.reason || ""
      });
    }
    API.logout().catch(() => {});
    session = null;
    backendUsers = [];
    setCurrentUser(null);
    dispatchAuthChanged();
  }

  function getSession() {
    return session;
  }

  function getCurrentUser() {
    return sanitizeUser(RBAC.currentUser);
  }

  function isAuthenticated() {
    const user = getCurrentUser();
    return Boolean(user && user.id && user.id !== "anonymous" && user.isActive);
  }

  async function hydrateSession() {
    if (hydrateStarted) return getCurrentUser();
    hydrateStarted = true;
    try {
      const result = await API.me();
      session = session || {
        token: "api-session",
        userId: result.user?.id || "",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + sessionDurationMs).toISOString()
      };
      setCurrentUser(result.user);
      await refreshBackendUsers();
      await RBAC.refreshBackendState?.();
      dispatchAuthChanged();
      return getCurrentUser();
    } catch {
      session = null;
      setCurrentUser(null);
      return null;
    }
  }

  function getUsers() {
    return backendUsers.map(sanitizeUser);
  }

  function getUser(userId) {
    return getUsers().find((user) => user.id === userId) || null;
  }

  async function refreshBackendUsers() {
    if (!isAuthenticated()) return [];
    backendUsers = (await API.fetchUsers()).map(sanitizeUser);
    dispatchUsersChanged();
    return backendUsers;
  }

  async function saveUser(userInput = {}) {
    const result = await API.saveUser(userInput);
    await refreshBackendUsers();
    return {
      created: Boolean(result.created),
      passwordChanged: Boolean(result.passwordChanged),
      previousUser: sanitizeUser(result.previousUser),
      user: sanitizeUser(result.user)
    };
  }

  async function deactivateUser(userId) {
    const user = getUser(userId);
    if (!user) return null;
    return saveUser({ ...user, isActive: false });
  }

  async function deleteUser() {
    throw new Error("User deletion is not enabled in the backend API.");
  }

  async function resetPassword(userId, password, confirmPassword) {
    const errors = validatePassword(password, confirmPassword, true);
    if (errors.length) throw new Error(errors[0]);
    const result = await API.resetUserPassword(userId, password);
    await refreshBackendUsers();
    return {
      previousUser: sanitizeUser(result.previousUser),
      user: sanitizeUser(result.user)
    };
  }

  function validatePassword(password, confirmPassword, required = true) {
    const value = String(password || "");
    const confirmation = String(confirmPassword || "");
    const messages = [];
    if (!value && !confirmation && !required) return messages;
    if (!value) messages.push("Password is required.");
    if (value.length < 8) messages.push("Password must be at least 8 characters.");
    if (!/[A-Z]/.test(value)) messages.push("Password must include at least 1 uppercase letter.");
    if (!/[a-z]/.test(value)) messages.push("Password must include at least 1 lowercase letter.");
    if (!/[0-9]/.test(value)) messages.push("Password must include at least 1 number.");
    if (!/[^A-Za-z0-9]/.test(value)) messages.push("Password must include at least 1 special character.");
    if (value !== confirmation) messages.push("Confirm password must match.");
    return messages;
  }

  function uniqueArray(values) {
    return [...new Set((values || []).filter(Boolean))];
  }

  hydrateSession();

  Object.assign(RBAC, {
    authChangedEvent,
    deactivateUser,
    deleteUser,
    getCurrentUser,
    getSession,
    getUser,
    getUsers,
    hydrateSession,
    isAuthenticated,
    login,
    logout,
    refreshBackendUsers,
    resetPassword,
    sanitizeUserForAudit,
    saveUser,
    sessionDurationMs,
    usersChangedEvent,
    validatePassword
  });
})();
