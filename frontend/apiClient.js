(function () {
  "use strict";

  const tokenKey = "casting-production-auth-token";
  const baseUrl = window.CASTING_API_BASE_URL || "";
  let authToken = getHashToken() || sessionStorage.getItem(tokenKey) || localStorage.getItem(tokenKey) || "";
  if (authToken) sessionStorage.setItem(tokenKey, authToken);
  if (getHashToken()) history.replaceState(null, "", window.location.pathname + window.location.search);

  async function request(path, options = {}) {
    const headers = {
      "Content-Type": "application/json",
      ...(options.headers || {})
    };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;

    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers,
      body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
    });

    if (response.status === 204) return null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) {
        setToken("");
      }
      const error = new Error(data.error || data.message || `Request failed: ${response.status}`);
      error.status = response.status;
      error.code = data.code;
      throw error;
    }
    return data;
  }

  function setToken(token) {
    authToken = token || "";
    if (authToken) {
      sessionStorage.setItem(tokenKey, authToken);
    } else {
      sessionStorage.removeItem(tokenKey);
      localStorage.removeItem(tokenKey);
    }
  }

  function getHashToken() {
    const params = new URLSearchParams(String(window.location.hash || "").replace(/^#/, ""));
    return params.get("token") || "";
  }

  async function login(email, password) {
    const result = await request("/api/auth/login", { method: "POST", body: { email, username: email, password } });
    setToken(result.token);
    return result;
  }

  async function logout() {
    try {
      await request("/api/auth/logout", { method: "POST", body: {} });
    } finally {
      setToken("");
    }
  }

  async function me() {
    return request("/api/auth/me");
  }

  async function fetchUsers() {
    return request("/api/users");
  }

  async function saveUser(user) {
    const isExisting = user.id && !String(user.id).startsWith("user_");
    return request(isExisting ? `/api/users/${encodeURIComponent(user.id)}` : "/api/users", {
      method: isExisting ? "PUT" : "POST",
      body: user
    });
  }

  async function fetchRoles() {
    return request("/api/roles");
  }

  async function saveRole(role) {
    const isExisting = role.id && !String(role.id).startsWith("role_");
    return request(isExisting ? `/api/roles/${encodeURIComponent(role.id)}` : "/api/roles", {
      method: isExisting ? "PUT" : "POST",
      body: role
    });
  }

  async function deleteRole() {
    throw new Error("Role deletion is not enabled in the backend API yet.");
  }

  async function fetchWaxEntries() {
    return request("/api/wax-entries");
  }

  async function createWaxEntryWithNumber(entry) {
    return request("/api/wax-entries", { method: "POST", body: entry });
  }

  async function saveWaxEntry(entry) {
    if (!entry.id) return createWaxEntryWithNumber(entry);
    return request(`/api/wax-entries/${encodeURIComponent(entry.id)}`, { method: "PUT", body: entry });
  }

  async function deleteWaxEntry(entry) {
    return request(`/api/wax-entries/${encodeURIComponent(entry.id)}`, { method: "DELETE" });
  }

  async function ensureCastingOrderForWaxEntry(entry) {
    return { waxEntryId: entry.id, workflow: { stage: "Awaiting Metal" } };
  }

  async function fetchCastingWorkflows() {
    const orders = await request("/api/casting-orders");
    return (orders || []).reduce((map, order) => {
      if (order.waxEntryId) map[order.waxEntryId] = order.workflow || { stage: "Awaiting Metal" };
      return map;
    }, {});
  }

  async function saveCastingWorkflow(order, workflow, event = {}) {
    return request(`/api/casting-orders/${encodeURIComponent(order.id)}/workflow`, {
      method: "PUT",
      body: { workflow, event }
    });
  }

  async function fetchInventorySnapshot() {
    return request("/api/inventory/snapshot");
  }

  async function fetchInventoryPostingByOrderId(orderId) {
    const snapshot = await fetchInventorySnapshot();
    return (snapshot.postings || []).find((posting) => posting.orderId === orderId) || null;
  }

  async function saveMetalReceiving(receivingEntry, ledgerEntry, options = {}) {
    return request("/api/metal-receiving", {
      method: "POST",
      body: { receivingEntry, ledgerEntry, options }
    });
  }

  async function saveInventoryPosting(posting, ledgerEntries, options = {}) {
    return request("/api/inventory-postings", {
      method: "POST",
      body: { posting, ledgerEntries, options }
    });
  }

  async function fetchAuditLogs() {
    return request("/api/audit-logs");
  }

  async function insertAuditLog(logEntry) {
    return request("/api/audit-logs", { method: "POST", body: logEntry });
  }

  async function fetchInvoicingSummary() {
    return request("/api/invoicing/summary");
  }

  async function fetchInvoiceCompanies() {
    return request("/api/invoicing/companies");
  }

  async function saveInvoiceCompany(company) {
    const isExisting = Boolean(company.id);
    return request(isExisting ? `/api/invoicing/companies/${encodeURIComponent(company.id)}` : "/api/invoicing/companies", {
      method: isExisting ? "PUT" : "POST",
      body: company
    });
  }

  async function fetchInvoiceOrders() {
    return request("/api/invoicing/orders");
  }

  async function fetchInvoiceOrder(orderId) {
    return request(`/api/invoicing/orders/${encodeURIComponent(orderId)}`);
  }

  async function saveInvoiceOrder(order) {
    const isExisting = Boolean(order.id);
    return request(isExisting ? `/api/invoicing/orders/${encodeURIComponent(order.id)}` : "/api/invoicing/orders", {
      method: isExisting ? "PUT" : "POST",
      body: order
    });
  }

  async function generateInvoice(orderId, invoice) {
    return request(`/api/invoicing/orders/${encodeURIComponent(orderId)}/generate`, { method: "POST", body: invoice });
  }

  function isConfigured() {
    return true;
  }

  function subscribeToRealtimeChanges(_tables, _onPayload, onStatus) {
    if (typeof onStatus === "function") {
      window.setTimeout(() => onStatus("SUBSCRIBED"), 0);
    }
    return function unsubscribe() {};
  }

  const api = {
    createWaxEntryWithNumber,
    deleteRole,
    deleteWaxEntry,
    ensureCastingOrderForWaxEntry,
    fetchAuditLogs,
    fetchCastingWorkflows,
    fetchInventoryPostingByOrderId,
    fetchInventorySnapshot,
    fetchInvoiceCompanies,
    fetchInvoiceOrder,
    fetchInvoiceOrders,
    fetchInvoicingSummary,
    fetchRoles,
    fetchUsers,
    fetchWaxEntries,
    insertAuditLog,
    isConfigured,
    login,
    logout,
    me,
    resetUserPassword: async (userId, password) => saveUser({ id: userId, password, confirmPassword: password }),
    saveCastingWorkflow,
    saveInventoryPosting,
    saveInvoiceCompany,
    saveInvoiceOrder,
    saveMetalReceiving,
    saveRole,
    saveUser,
    saveWaxEntry,
    subscribeToRealtimeChanges,
    generateInvoice,
    touchLastLogin: async () => null,
    unsubscribeFromRealtimeChanges: () => {}
  };

  window.CastingAPI = api;
})();
