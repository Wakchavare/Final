(function () {
  "use strict";

  const Backend = window.CastingAPI;
  const RBAC = window.ProductionRBAC;
  const rootSelector = "#invoicingRoot";
  const today = () => new Date().toISOString().slice(0, 10);

  const state = {
    companies: [],
    orders: [],
    selectedOrder: null,
    editingCompany: null,
    editingOrder: null,
    stats: { companies: 0, orders: 0, rows: 0 },
    loading: false,
    loaded: false,
    message: "Ready"
  };

  function root() {
    return document.querySelector(rootSelector);
  }

  function currentUser() {
    return RBAC?.getCurrentUser?.() || RBAC?.currentUser || { isActive: true };
  }

  function can(action) {
    if (!RBAC?.hasModulePermission) return true;
    return RBAC.hasModulePermission(currentUser(), "invoicing", action);
  }

  function setMessage(message) {
    state.message = message || "Ready";
    const target = document.querySelector("[data-invoicing-message]");
    if (target) target.textContent = state.message;
  }

  async function refresh(options = {}) {
    if (!Backend?.fetchInvoicingSummary) {
      state.message = "Invoicing API is not available.";
      render();
      return;
    }

    if (state.loading) return;
    state.loading = true;
    render();

    try {
      const summary = await Backend.fetchInvoicingSummary();
      state.stats = summary.stats || { companies: 0, orders: 0, rows: 0 };
      state.companies = summary.companies || [];
      state.orders = summary.orders || [];
      state.loaded = true;
      if (options.keepSelected && state.selectedOrder?.id) {
        state.selectedOrder = await Backend.fetchInvoiceOrder(state.selectedOrder.id);
      } else if (state.selectedOrder?.id) {
        const stillExists = state.orders.some((order) => order.id === state.selectedOrder.id);
        state.selectedOrder = stillExists ? await Backend.fetchInvoiceOrder(state.selectedOrder.id) : null;
      }
      setMessage("Invoicing data loaded from PostgreSQL.");
    } catch (error) {
      console.warn("Invoicing refresh failed.", error);
      setMessage(error.message || "Invoicing refresh failed.");
    } finally {
      state.loading = false;
      render();
    }
  }

  function render() {
    const container = root();
    if (!container) return;

    if (!can("view")) {
      container.innerHTML = '<section class="inventory-panel"><p class="role-status">You do not have permission to perform this action.</p></section>';
      return;
    }

    if (!state.loaded && !state.loading && Backend?.fetchInvoicingSummary) {
      window.setTimeout(() => refresh(), 0);
    }

    container.innerHTML = `
      <section class="inventory-panel">
        <div class="section-heading">
          <div>
            <h2>Invoicing</h2>
            <p class="role-status" data-invoicing-message>${escapeHtml(state.loading ? "Loading invoicing data..." : state.message)}</p>
          </div>
          <button class="button button-secondary" type="button" data-invoice-refresh ${state.loading ? "disabled" : ""}>Refresh</button>
        </div>

        <div class="inventory-balance-grid">
          ${renderStatCard("Companies", state.stats.companies)}
          ${renderStatCard("Orders", state.stats.orders)}
          ${renderStatCard("Line Items", state.stats.rows)}
        </div>

        ${renderUploadPanel()}

        <div class="invoicing-layout">
          ${renderCompanyPanel()}
          ${renderOrderPanel()}
        </div>

        ${renderOrdersTable()}
        ${renderSelectedOrder()}
      </section>
    `;
  }

  function renderUploadPanel() {
    const disabled = can("create") ? "" : "disabled";
    return `
      <form class="inventory-form invoicing-card" data-invoice-upload-form>
        <div class="section-heading">
          <div>
            <h2>Upload Purchase Order Excel</h2>
            <p class="role-status">Saved as invoice order rows</p>
          </div>
        </div>
        <div class="inventory-form-grid">
          <label class="inventory-form-wide">
            <span>Excel File</span>
            <input type="file" accept=".xlsx" data-invoice-upload-file ${disabled} required>
          </label>
        </div>
        <div class="role-actions">
          <button class="button" type="submit" ${disabled}>Upload Order</button>
        </div>
      </form>
    `;
  }

  function renderStatCard(label, value) {
    return `
      <article class="inventory-balance-card">
        <p>${escapeHtml(label)}</p>
        <h3>Backend</h3>
        <strong>${escapeHtml(String(value || 0))}</strong>
      </article>
    `;
  }

  function renderCompanyPanel() {
    const company = state.editingCompany || {};
    const disabled = can("create") || can("edit") ? "" : "disabled";
    return `
      <form class="inventory-form invoicing-card" data-invoice-company-form>
        <div class="section-heading">
          <div>
            <h2>${company.id ? "Edit Company" : "Company"}</h2>
            <p class="role-status">${state.companies.length} saved</p>
          </div>
          <button class="button button-secondary" type="button" data-new-invoice-company>New</button>
        </div>
        <input type="hidden" data-company-field="id" value="${escapeAttribute(company.id || "")}">
        <div class="inventory-form-grid">
          <label class="inventory-form-wide">
            <span>Name</span>
            <input type="text" data-company-field="name" value="${escapeAttribute(company.name || "")}" placeholder="Company name" ${disabled} required>
          </label>
          <label class="inventory-form-wide">
            <span>Address</span>
            <textarea data-company-field="address" placeholder="Billing address" ${disabled}>${escapeHtml(company.address || "")}</textarea>
          </label>
          <label>
            <span>Gold Labor Price</span>
            <input type="number" min="0" step="0.01" data-company-field="goldLaborPrice" value="${escapeAttribute(company.goldLaborPrice || "")}" ${disabled}>
          </label>
          <label>
            <span>Silver Labor Price</span>
            <input type="number" min="0" step="0.01" data-company-field="silverLaborPrice" value="${escapeAttribute(company.silverLaborPrice || "")}" ${disabled}>
          </label>
          <label>
            <span>Platinum Labor Price</span>
            <input type="number" min="0" step="0.01" data-company-field="platinumLaborPrice" value="${escapeAttribute(company.platinumLaborPrice || "")}" ${disabled}>
          </label>
        </div>
        <div class="role-actions">
          <button class="button" type="submit" ${disabled}>Save Company</button>
        </div>
      </form>
    `;
  }

  function renderOrderPanel() {
    const order = state.editingOrder || {};
    const row = (order.rows && order.rows[0]) || {};
    const companyOptions = state.companies
      .map((company) => `<option value="${escapeAttribute(company.id)}" ${company.id === order.companyId ? "selected" : ""}>${escapeHtml(company.name)}</option>`)
      .join("");
    const disabled = can(order.id ? "edit" : "create") ? "" : "disabled";
    return `
      <form class="inventory-form invoicing-card" data-invoice-order-form>
        <div class="section-heading">
          <div>
            <h2>${order.id ? "Edit Order" : "Order"}</h2>
            <p class="role-status">Create invoice-ready order rows</p>
          </div>
          <button class="button button-secondary" type="button" data-new-invoice-order>New</button>
        </div>
        <input type="hidden" data-order-field="id" value="${escapeAttribute(order.id || "")}">
        <div class="inventory-form-grid">
          <label>
            <span>Company</span>
            <select data-order-field="companyId" ${disabled} required>
              <option value="">Select company</option>
              ${companyOptions}
            </select>
          </label>
          <label>
            <span>Wax Shipment Inv No</span>
            <input type="text" data-order-field="waxShipmentInvNo" value="${escapeAttribute(order.waxShipmentInvNo || row.waxShipmentInvNo || "")}" placeholder="SHIP-1001" ${disabled} required>
          </label>
          <label>
            <span>Date Of Order</span>
            <input type="date" data-order-field="dateOfOrder" value="${escapeAttribute(order.dateOfOrder || today())}" ${disabled}>
          </label>
          <label>
            <span>SO No</span>
            <input type="text" data-order-field="soNo" value="${escapeAttribute(order.soNo || "")}" placeholder="SO-5001" ${disabled}>
          </label>
          <label>
            <span>Status</span>
            <select data-order-field="status" ${disabled}>
              ${["Draft", "Ready", "Invoiced", "Closed"].map((status) => `<option value="${status}" ${status === (order.status || "Draft") ? "selected" : ""}>${status}</option>`).join("")}
            </select>
          </label>
          <label>
            <span>Gold Value</span>
            <input type="number" min="0" step="0.01" data-order-field="goldValue" value="${escapeAttribute(order.goldValue || "")}" ${disabled}>
          </label>
          <label>
            <span>Silver Value</span>
            <input type="number" min="0" step="0.01" data-order-field="silverValue" value="${escapeAttribute(order.silverValue || "")}" ${disabled}>
          </label>
          <label>
            <span>Platinum Value</span>
            <input type="number" min="0" step="0.01" data-order-field="platinumValue" value="${escapeAttribute(order.platinumValue || "")}" ${disabled}>
          </label>
        </div>
        <div class="section-heading inventory-ledger-heading">
          <div>
            <h2>Line Item</h2>
            <p class="role-status">Stored in invoice_order_rows</p>
          </div>
        </div>
        <div class="inventory-form-grid">
          ${renderLineField("treeNo", "Tree No", row.treeNo || "A-1", disabled)}
          ${renderLineField("vpoPoNo", "VPO / PO No", row.vpoPoNo || "", disabled)}
          ${renderLineField("productCategory", "Product Category", row.productCategory || "Ring", disabled)}
          ${renderLineField("sku", "SKU", row.sku || "", disabled)}
          ${renderLineField("customerSku", "Customer SKU", row.customerSku || "", disabled)}
          ${renderLineField("waxQty", "Wax Qty", row.waxQty || "", disabled, "number")}
          ${renderLineField("orderQty", "Order Qty", row.orderQty || "", disabled, "number")}
          ${renderLineField("kt", "KT", row.kt || "14KT", disabled)}
          ${renderLineField("color", "Color", row.color || "Yellow", disabled)}
          ${renderLineField("netWtPc", "Net Wt / Pc", row.netWtPc || "", disabled, "number")}
          ${renderLineField("grossWtPc", "Gross Wt / Pc", row.grossWtPc || "", disabled, "number")}
          ${renderLineField("totalWt", "Total Wt", row.totalWt || "", disabled, "number")}
          ${renderLineField("requiredMetalPg", "Required Metal PG", row.requiredMetalPg || "", disabled, "number")}
          ${renderLineField("totalValue", "Total Value", row.totalValue || "", disabled, "number")}
          ${renderLineField("castingQty", "Casting Qty", row.castingQty || "", disabled, "number")}
          ${renderLineField("castingWeight", "Casting Weight", row.castingWeight || "", disabled, "number")}
          <label class="inventory-form-wide">
            <span>Notes</span>
            <textarea data-line-field="notes" ${disabled}>${escapeHtml(row.notes || "")}</textarea>
          </label>
        </div>
        <div class="role-actions">
          <button class="button" type="submit" ${disabled}>Save Order</button>
        </div>
      </form>
    `;
  }

  function renderLineField(field, label, value, disabled, type = "text") {
    const numeric = type === "number" ? ' min="0" step="0.001"' : "";
    return `
      <label>
        <span>${escapeHtml(label)}</span>
        <input type="${type}"${numeric} data-line-field="${escapeAttribute(field)}" value="${escapeAttribute(value)}" ${disabled}>
      </label>
    `;
  }

  function renderOrdersTable() {
    return `
      <div class="section-heading inventory-ledger-heading">
        <div>
          <h2>Invoice Orders</h2>
          <p class="role-status">${state.orders.length} ${state.orders.length === 1 ? "order" : "orders"}</p>
        </div>
      </div>
      <div class="inventory-table-scroll">
        <table class="audit-table">
          <thead>
            <tr>
              <th>Order No</th>
              <th>Company</th>
              <th>Wax Shipment Inv No</th>
              <th>Date</th>
              <th>SO No</th>
              <th>Status</th>
              <th>Gold Value</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${
              state.orders.length
                ? state.orders
                    .map(
                      (order) => `
                        <tr>
                          <td>${escapeHtml(order.orderNumber)}</td>
                          <td>${escapeHtml(order.companyName)}</td>
                          <td>${escapeHtml(order.waxShipmentInvNo)}</td>
                          <td>${escapeHtml(order.dateOfOrder)}</td>
                          <td>${escapeHtml(order.soNo)}</td>
                          <td>${escapeHtml(order.status)}</td>
                          <td>${escapeHtml(formatMoney(order.goldValue))}</td>
                          <td>
                            <button class="button button-secondary compact-button" type="button" data-view-invoice-order="${escapeAttribute(order.id)}">View</button>
                            <button class="button button-secondary compact-button" type="button" data-edit-invoice-order="${escapeAttribute(order.id)}">Edit</button>
                          </td>
                        </tr>
                      `
                    )
                    .join("")
                : '<tr><td colspan="8" class="audit-empty">No invoice orders yet.</td></tr>'
            }
          </tbody>
        </table>
      </div>
      <div class="inventory-table-scroll">
        <table class="audit-table">
          <thead>
            <tr>
              <th>Company</th>
              <th>Address</th>
              <th>Gold Labor</th>
              <th>Silver Labor</th>
              <th>Platinum Labor</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${
              state.companies.length
                ? state.companies
                    .map(
                      (company) => `
                        <tr>
                          <td>${escapeHtml(company.name)}</td>
                          <td>${escapeHtml(company.address)}</td>
                          <td>${escapeHtml(formatMoney(company.goldLaborPrice))}</td>
                          <td>${escapeHtml(formatMoney(company.silverLaborPrice))}</td>
                          <td>${escapeHtml(formatMoney(company.platinumLaborPrice))}</td>
                          <td><button class="button button-secondary compact-button" type="button" data-edit-invoice-company="${escapeAttribute(company.id)}">Edit</button></td>
                        </tr>
                      `
                    )
                    .join("")
                : '<tr><td colspan="6" class="audit-empty">No invoice companies yet.</td></tr>'
            }
          </tbody>
        </table>
      </div>
    `;
  }

  function renderSelectedOrder() {
    const order = state.selectedOrder;
    if (!order) {
      return '<p class="role-status invoicing-empty-state">Select an invoice order to view line items and generate an invoice.</p>';
    }

    const defaultInvoiceNo = `INV-${String(order.orderNumber || Date.now()).replace(/^ORD-/, "")}`;
    const company = state.companies.find((item) => item.id === order.companyId) || {};
    const metal = String(order.metalType || order.rows?.[0]?.kt || "").toLowerCase();
    const defaultLaborRate = order.laborCharge || (metal.includes("silver") ? company.silverLaborPrice : metal.includes("plat") ? company.platinumLaborPrice : company.goldLaborPrice) || "";
    return `
      <div class="section-heading inventory-ledger-heading">
        <div>
          <h2>${escapeHtml(order.orderNumber)} Details</h2>
          <p class="role-status">${escapeHtml(order.companyName)} · ${escapeHtml(order.status)}</p>
        </div>
      </div>
      <div class="inventory-table-scroll">
        <table class="audit-table">
          <thead>
            <tr>
              <th>Sr No</th>
              <th>Tree No</th>
              <th>SKU</th>
              <th>KT</th>
              <th>Color</th>
              <th>Order Qty</th>
              <th>Total Wt</th>
              <th>Casting Weight</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            ${
              order.rows?.length
                ? order.rows
                    .map(
                      (row) => `
                        <tr>
                          <td>${escapeHtml(row.srNo)}</td>
                          <td>${escapeHtml(row.treeNo)}</td>
                          <td>${escapeHtml(row.sku)}</td>
                          <td>${escapeHtml(row.kt)}</td>
                          <td>${escapeHtml(row.color)}</td>
                          <td>${escapeHtml(formatNumber(row.orderQty))}</td>
                          <td>${escapeHtml(formatNumber(row.totalWt))}</td>
                          <td>${escapeHtml(formatNumber(row.castingWeight))}</td>
                          <td>${escapeHtml(row.notes)}</td>
                        </tr>
                      `
                    )
                    .join("")
                : '<tr><td colspan="9" class="audit-empty">No line items found.</td></tr>'
            }
          </tbody>
        </table>
      </div>

      <form class="inventory-form" data-generate-invoice-form data-order-id="${escapeAttribute(order.id)}">
        <div class="inventory-form-grid">
          <label>
            <span>Invoice No</span>
            <input type="text" data-generate-field="invoiceNo" value="${escapeAttribute(defaultInvoiceNo)}" ${can("create") ? "" : "disabled"}>
          </label>
          <label>
            <span>Invoice Date</span>
            <input type="date" data-generate-field="invoiceDate" value="${today()}" ${can("create") ? "" : "disabled"}>
          </label>
          <label>
            <span>Metal Type</span>
            <select data-generate-field="metalType" ${can("create") ? "" : "disabled"}>
              ${["Gold", "Silver", "Platinum"].map((item) => `<option value="${item}" ${String(order.metalType || "").toLowerCase().includes(item.toLowerCase()) ? "selected" : ""}>${item}</option>`).join("")}
            </select>
          </label>
          ${renderGenerateNumberField("laborRate", "Labor Rate", can("create"), defaultLaborRate)}
          ${renderGenerateNumberField("goldSpot", "Gold Spot", can("create"), order.goldValue || "")}
          ${renderGenerateNumberField("platinumSpot", "Platinum Spot", can("create"), order.platinumValue || "")}
          ${renderGenerateNumberField("silverSpot", "Silver Spot", can("create"), order.silverValue || "")}
        </div>
        <div class="role-actions">
          <button class="button" type="submit" ${can("create") ? "" : "disabled"}>Generate Invoice</button>
          <button class="button button-secondary" type="button" data-generate-shipping-excel="${escapeAttribute(order.id)}" ${can("create") ? "" : "disabled"}>Generate Shipping</button>
          <button class="button button-secondary" type="button" data-generate-order-copy-excel="${escapeAttribute(order.id)}" ${can("create") ? "" : "disabled"}>Generate Order Copy</button>
          <button class="button button-secondary" type="button" data-download-invoice-excel="${escapeAttribute(order.id)}" ${can("export") ? "" : "disabled"}>Download Invoice Excel</button>
          <button class="button button-secondary" type="button" data-download-shipping-excel="${escapeAttribute(order.id)}" ${can("export") ? "" : "disabled"}>Download Shipping Excel</button>
          <button class="button button-secondary" type="button" data-download-order-copy-excel="${escapeAttribute(order.id)}" ${can("export") ? "" : "disabled"}>Download Order Copy</button>
        </div>
      </form>

      <div class="inventory-table-scroll">
        <table class="audit-table">
          <thead>
            <tr>
              <th>Invoice No</th>
              <th>Date</th>
              <th>Metal</th>
              <th>File Type</th>
              <th>Labor Rate</th>
              <th>Generated At</th>
            </tr>
          </thead>
          <tbody>
            ${
              order.generatedInvoices?.length
                ? order.generatedInvoices
                    .map(
                      (invoice) => `
                        <tr>
                          <td>${escapeHtml(invoice.invoiceNo)}</td>
                          <td>${escapeHtml(invoice.invoiceDate)}</td>
                          <td>${escapeHtml(invoice.metalType)}</td>
                          <td>${escapeHtml(invoice.fileType)}</td>
                          <td>${escapeHtml(formatMoney(invoice.laborRate))}</td>
                          <td>${escapeHtml(formatDateTime(invoice.generatedAt))}</td>
                        </tr>
                      `
                    )
                    .join("")
                : '<tr><td colspan="6" class="audit-empty">No generated invoices yet.</td></tr>'
            }
          </tbody>
        </table>
      </div>
    `;
  }

  function renderGenerateNumberField(field, label, enabled, value = "") {
    return `
      <label>
        <span>${escapeHtml(label)}</span>
        <input type="number" min="0" step="0.01" data-generate-field="${escapeAttribute(field)}" value="${escapeAttribute(value)}" ${enabled ? "" : "disabled"}>
      </label>
    `;
  }

  function readFields(form, selector) {
    return Array.from(form.querySelectorAll(selector)).reduce((values, field) => {
      values[field.dataset.companyField || field.dataset.orderField || field.dataset.lineField || field.dataset.generateField] = field.value;
      return values;
    }, {});
  }

  async function handleCompanySubmit(form) {
    const payload = readFields(form, "[data-company-field]");
    await Backend.saveInvoiceCompany(payload);
    state.editingCompany = null;
    setMessage("Company saved to PostgreSQL.");
    await refresh();
  }

  async function handleOrderSubmit(form) {
    const order = readFields(form, "[data-order-field]");
    const line = readFields(form, "[data-line-field]");
    order.rows = [line];
    await Backend.saveInvoiceOrder(order);
    state.editingOrder = null;
    setMessage("Invoice order saved to PostgreSQL.");
    await refresh({ keepSelected: true });
  }

  async function handleUploadSubmit(form) {
    const file = form.querySelector("[data-invoice-upload-file]")?.files?.[0];
    if (!file) {
      setMessage("Select an Excel file to upload.");
      return;
    }
    if (!/\.xlsx$/i.test(file.name)) {
      setMessage("Only .xlsx Excel files can be uploaded.");
      return;
    }
    const fileBase64 = await fileToBase64(file);
    let order;
    try {
      order = await Backend.uploadInvoiceOrderWorkbook({ fileName: file.name, fileBase64 });
    } catch (error) {
      if (error.code !== "DUPLICATE_ORDER") throw error;
      const overwrite = window.confirm("This company and order number already exist. Overwrite the saved order?");
      if (overwrite) {
        order = await Backend.uploadInvoiceOrderWorkbook({ fileName: file.name, fileBase64, overwrite: true });
      } else {
        const newVersion = window.confirm("Create a new version instead?");
        if (!newVersion) throw error;
        order = await Backend.uploadInvoiceOrderWorkbook({ fileName: file.name, fileBase64, newVersion: true });
      }
    }
    state.selectedOrder = order;
    state.editingOrder = null;
    setMessage(`Uploaded ${order.rows?.length || 0} invoice line items from ${file.name}.`);
    form.reset();
    await refresh({ keepSelected: true });
  }

  async function handleGenerateSubmit(form) {
    const orderId = form.dataset.orderId;
    const payload = readFields(form, "[data-generate-field]");
    await Backend.generateInvoice(orderId, payload);
    state.selectedOrder = await Backend.fetchInvoiceOrder(orderId);
    setMessage("Invoice Excel generated from PostgreSQL data.");
    await refresh({ keepSelected: true });
  }

  async function handleGenerateWorkbook(orderId, type) {
    const form = document.querySelector(`[data-generate-invoice-form][data-order-id="${cssEscape(orderId)}"]`);
    const payload = form ? readFields(form, "[data-generate-field]") : {};
    if (type === "shipping") {
      await Backend.generateShipping(orderId, payload);
      setMessage("Shipping Excel generated from PostgreSQL data.");
    } else {
      await Backend.generateOrderCopy(orderId, payload);
      setMessage("Order copy Excel generated from PostgreSQL data.");
    }
    state.selectedOrder = await Backend.fetchInvoiceOrder(orderId);
    await refresh({ keepSelected: true });
  }

  async function handleWorkbookDownload(orderId, type) {
    const result =
      type === "shipping"
        ? await Backend.downloadShippingWorkbook(orderId)
        : type === "orderCopy"
          ? await Backend.downloadOrderCopyWorkbook(orderId)
          : await Backend.downloadInvoiceWorkbook(orderId);
    downloadBlob(result.blob, result.fileName);
    setMessage(`${type === "shipping" ? "Shipping" : type === "orderCopy" ? "Order copy" : "Invoice"} Excel downloaded.`);
  }

  document.addEventListener("submit", (event) => {
    const companyForm = event.target.closest("[data-invoice-company-form]");
    const orderForm = event.target.closest("[data-invoice-order-form]");
    const uploadForm = event.target.closest("[data-invoice-upload-form]");
    const generateForm = event.target.closest("[data-generate-invoice-form]");
    if (!companyForm && !orderForm && !uploadForm && !generateForm) return;

    event.preventDefault();
    const run = companyForm
      ? handleCompanySubmit(companyForm)
      : orderForm
        ? handleOrderSubmit(orderForm)
        : uploadForm
          ? handleUploadSubmit(uploadForm)
          : handleGenerateSubmit(generateForm);
    run.catch((error) => {
      console.warn("Invoicing action failed.", error);
      setMessage(error.message || "Invoicing action failed.");
    });
  });

  document.addEventListener("click", (event) => {
    const refreshButton = event.target.closest("[data-invoice-refresh]");
    const newCompanyButton = event.target.closest("[data-new-invoice-company]");
    const editCompanyButton = event.target.closest("[data-edit-invoice-company]");
    const newOrderButton = event.target.closest("[data-new-invoice-order]");
    const editOrderButton = event.target.closest("[data-edit-invoice-order]");
    const viewOrderButton = event.target.closest("[data-view-invoice-order]");
    const generateShippingButton = event.target.closest("[data-generate-shipping-excel]");
    const generateOrderCopyButton = event.target.closest("[data-generate-order-copy-excel]");
    const downloadInvoiceButton = event.target.closest("[data-download-invoice-excel]");
    const downloadShippingButton = event.target.closest("[data-download-shipping-excel]");
    const downloadOrderCopyButton = event.target.closest("[data-download-order-copy-excel]");

    if (refreshButton) {
      refresh({ keepSelected: true });
      return;
    }

    if (newCompanyButton) {
      state.editingCompany = null;
      render();
      return;
    }

    if (editCompanyButton) {
      state.editingCompany = state.companies.find((company) => company.id === editCompanyButton.dataset.editInvoiceCompany) || null;
      render();
      return;
    }

    if (newOrderButton) {
      state.editingOrder = null;
      render();
      return;
    }

    if (editOrderButton) {
      Backend.fetchInvoiceOrder(editOrderButton.dataset.editInvoiceOrder)
        .then((order) => {
          state.editingOrder = order;
          state.selectedOrder = order;
          render();
        })
        .catch((error) => setMessage(error.message || "Could not load order."));
      return;
    }

    if (viewOrderButton) {
      Backend.fetchInvoiceOrder(viewOrderButton.dataset.viewInvoiceOrder)
        .then((order) => {
          state.selectedOrder = order;
          render();
        })
        .catch((error) => setMessage(error.message || "Could not load order."));
      return;
    }

    if (generateShippingButton) {
      handleGenerateWorkbook(generateShippingButton.dataset.generateShippingExcel, "shipping").catch((error) => {
        console.warn("Shipping Excel generation failed.", error);
        setMessage(error.message || "Shipping Excel generation failed.");
      });
      return;
    }

    if (generateOrderCopyButton) {
      handleGenerateWorkbook(generateOrderCopyButton.dataset.generateOrderCopyExcel, "orderCopy").catch((error) => {
        console.warn("Order copy generation failed.", error);
        setMessage(error.message || "Order copy generation failed.");
      });
      return;
    }

    if (downloadInvoiceButton) {
      handleWorkbookDownload(downloadInvoiceButton.dataset.downloadInvoiceExcel, "invoice").catch((error) => {
        console.warn("Invoice Excel download failed.", error);
        setMessage(error.message || "Invoice Excel download failed.");
      });
      return;
    }

    if (downloadShippingButton) {
      handleWorkbookDownload(downloadShippingButton.dataset.downloadShippingExcel, "shipping").catch((error) => {
        console.warn("Shipping Excel download failed.", error);
        setMessage(error.message || "Shipping Excel download failed.");
      });
      return;
    }

    if (downloadOrderCopyButton) {
      handleWorkbookDownload(downloadOrderCopyButton.dataset.downloadOrderCopyExcel, "orderCopy").catch((error) => {
        console.warn("Order copy download failed.", error);
        setMessage(error.message || "Order copy download failed.");
      });
    }
  });

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || "");
        resolve(result.includes(",") ? result.split(",").pop() : result);
      };
      reader.onerror = () => reject(new Error("Could not read the selected Excel file."));
      reader.readAsDataURL(file);
    });
  }

  function formatMoney(value) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed.toFixed(2) : "0.00";
  }

  function formatNumber(value) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed.toFixed(3) : "";
  }

  function formatDateTime(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
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
    return escapeHtml(value).replace(/`/g, "&#96;");
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return window.CSS.escape(String(value));
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName || "invoice.xlsx";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  window.ProductionInvoicing = {
    refresh,
    render,
    state
  };
})();
