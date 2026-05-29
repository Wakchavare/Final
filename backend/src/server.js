require("./env").loadEnv();

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const bcrypt = require("bcryptjs");
const cors = require("cors");
const express = require("express");
const helmet = require("helmet");
const jwt = require("jsonwebtoken");
const morgan = require("morgan");
const { migrate } = require("./migrate");
const { seed } = require("./seed");
const { pool, query, transaction } = require("./db");
const { generateInvoiceWorkbook, generateOrderCopyWorkbook, generateShippingWorkbook, workbookFileName } = require("./excel-generator");
const { parseInvoiceOrderWorkbook } = require("./order-parser");

const app = express();
const port = Number(process.env.PORT || 3000);
const jwtSecret = process.env.JWT_SECRET || "development-secret-change-me";
const jwtExpiresIn = process.env.JWT_EXPIRES_IN || "8h";
const publicRoot = process.env.PUBLIC_ROOT || path.resolve(__dirname, "..", "public");
const invoiceFileRoot = process.env.INVOICE_FILE_ROOT || path.resolve(__dirname, "..", "generated", "invoicing");

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: getCorsOrigin(), credentials: true }));
app.use(express.json({ limit: "25mb" }));
app.use(morgan(process.env.NODE_ENV === "test" ? "tiny" : "dev"));

app.get("/api/health", async (_req, res) => {
  try {
    await query("select 1");
    res.json({ ok: true, database: "connected", timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({ ok: false, database: "disconnected", error: error.message });
  }
});

app.get("/api/auth/login", (_req, res) => {
  res.status(405).json({
    error: "Login API requires POST.",
    method: "POST",
    path: "/api/auth/login",
    loginPage: "/"
  });
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email || req.body.username);
    const password = String(req.body.password || "");
    const result = await query(
      `select u.*, coalesce(json_agg(ur.role_id) filter (where ur.role_id is not null), '[]') as role_ids
       from users u
       left join user_roles ur on ur.user_id = u.id
       where u.email = $1 or u.username = $1
       group by u.id`,
      [email]
    );
    const user = result.rows[0];
    if (!user || !user.is_active || !(await bcrypt.compare(password, user.password_hash))) {
      await insertAudit(null, "Failed login attempt", { actorEmail: email, newValue: "Invalid username or password" });
      return res.status(401).json({ error: "Invalid username or password" });
    }

    await query("update users set last_login_at = now(), updated_at = now() where id = $1", [user.id]);
    const safeUser = mapUserRow({ ...user, last_login_at: new Date().toISOString() });
    const token = jwt.sign({ sub: user.id, email: user.email }, jwtSecret, { expiresIn: jwtExpiresIn });
    await insertAudit(user, "User logged in", { module: "Auth" });
    res.json({ token, user: safeUser, session: { token, userId: user.id, createdAt: new Date().toISOString() } });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/logout", authRequired, async (req, res, next) => {
  try {
    await insertAudit(req.user, "User logged out", { module: "Auth" });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/auth/me", authRequired, async (req, res) => {
  res.json({ user: req.user });
});

app.get("/api/users", authRequired, async (_req, res, next) => {
  try {
    res.json(await fetchUsers());
  } catch (error) {
    next(error);
  }
});

app.post("/api/users", authRequired, async (req, res, next) => {
  try {
    const result = await saveUser(req.body);
    await insertAudit(req.user, result.created ? "User created" : "User edited", { module: "User Management", newValue: result.user, oldValue: result.previousUser });
    res.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    next(error);
  }
});

app.put("/api/users/:id", authRequired, async (req, res, next) => {
  try {
    const result = await saveUser({ ...req.body, id: req.params.id });
    await insertAudit(req.user, "User edited", { module: "User Management", newValue: result.user, oldValue: result.previousUser });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/roles", authRequired, async (_req, res, next) => {
  try {
    const result = await query("select * from roles order by name");
    res.json(result.rows.map(mapRoleRow));
  } catch (error) {
    next(error);
  }
});

app.post("/api/roles", authRequired, async (req, res, next) => {
  try {
    const role = await saveRole(req.body);
    await insertAudit(req.user, "Role created", { module: "Role Management", newValue: role });
    res.status(201).json(role);
  } catch (error) {
    next(error);
  }
});

app.put("/api/roles/:id", authRequired, async (req, res, next) => {
  try {
    const role = await saveRole({ ...req.body, id: req.params.id });
    await insertAudit(req.user, "Role edited", { module: "Role Management", newValue: role });
    res.json(role);
  } catch (error) {
    next(error);
  }
});

app.get("/api/wax-entries", authRequired, async (_req, res, next) => {
  try {
    const result = await query("select * from wax_entries order by created_at desc");
    res.json(result.rows.map(mapWaxEntryRow));
  } catch (error) {
    next(error);
  }
});

app.post("/api/wax-entries", authRequired, async (req, res, next) => {
  try {
    const entry = await createWaxEntry(req.body, req.user);
    await ensureCastingOrder(entry, req.user);
    await insertAudit(req.user, "Wax Entry created", { module: "Wax Entries", barcodeValue: entry.barcodeValue, internalTreeNumber: entry.internalTreeNumber, newValue: entry });
    res.status(201).json(entry);
  } catch (error) {
    next(error);
  }
});

app.put("/api/wax-entries/:id", authRequired, async (req, res, next) => {
  try {
    const entry = await updateWaxEntry(req.params.id, req.body);
    await insertAudit(req.user, "Wax Entry edited", { module: "Wax Entries", barcodeValue: entry.barcodeValue, internalTreeNumber: entry.internalTreeNumber, newValue: entry });
    res.json(entry);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/wax-entries/:id", authRequired, async (req, res, next) => {
  try {
    const existing = await query("select * from wax_entries where id = $1", [req.params.id]);
    await query("delete from wax_entries where id = $1", [req.params.id]);
    if (existing.rows[0]) await insertAudit(req.user, "Wax Entry deleted", { module: "Wax Entries", oldValue: mapWaxEntryRow(existing.rows[0]) });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/casting-orders", authRequired, async (_req, res, next) => {
  try {
    const result = await query("select * from casting_orders order by updated_at desc");
    res.json(result.rows.map(mapCastingOrderRow));
  } catch (error) {
    next(error);
  }
});

app.put("/api/casting-orders/:id/workflow", authRequired, async (req, res, next) => {
  try {
    const order = await saveCastingWorkflow(req.params.id, req.body.workflow || req.body, req.body.event || {}, req.user);
    res.json(order);
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/snapshot", authRequired, async (_req, res, next) => {
  try {
    const [receiving, ledger, balances, postings] = await Promise.all([
      query("select * from metal_receiving_entries order by submitted_at desc"),
      query("select * from inventory_ledger order by created_at desc"),
      query("select * from inventory_balances order by balance_label"),
      query("select * from inventory_postings order by posted_at desc")
    ]);
    res.json({
      receivingEntries: receiving.rows.map(mapMetalReceivingRow),
      ledgerEntries: ledger.rows.map(mapInventoryLedgerRow),
      balances: balances.rows.map(mapInventoryBalanceRow),
      postings: postings.rows.map(mapInventoryPostingRow)
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/metal-receiving", authRequired, async (req, res, next) => {
  try {
    const result = await saveMetalReceiving(req.body.receivingEntry || req.body, req.body.ledgerEntry || null, req.user);
    await insertAudit(req.user, "Metal received", { module: "Metal Receiving", newValue: result.receivingEntry });
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/inventory-postings", authRequired, async (req, res, next) => {
  try {
    const result = await saveInventoryPosting(req.body.posting || req.body, req.body.ledgerEntries || [], req.user);
    await insertAudit(req.user, "Final inventory posted", { module: "Inventory", newValue: result.posting });
    res.status(201).json(result);
  } catch (error) {
    if (error.code === "23505") error.status = 409;
    next(error);
  }
});

app.get("/api/audit-logs", authRequired, async (_req, res, next) => {
  try {
    const result = await query("select * from audit_logs order by created_at desc limit 1000");
    res.json(result.rows.map(mapAuditLogRow));
  } catch (error) {
    next(error);
  }
});

app.post("/api/audit-logs", authRequired, async (req, res, next) => {
  try {
    const log = await insertAudit(req.user, req.body.action || "Action", req.body);
    res.status(201).json(log);
  } catch (error) {
    next(error);
  }
});

app.get("/api/invoicing/summary", authRequired, async (_req, res, next) => {
  try {
    const [companyCount, orderCount, rowCount, companies, orders] = await Promise.all([
      query("select count(*)::int as count from invoice_companies"),
      query("select count(*)::int as count from invoice_orders"),
      query("select count(*)::int as count from invoice_order_rows"),
      query("select * from invoice_companies order by name"),
      query(`select o.*, c.name as company_name
             from invoice_orders o
             join invoice_companies c on c.id = o.company_id
             order by o.uploaded_at desc
             limit 25`)
    ]);
    res.json({
      stats: {
        companies: companyCount.rows[0].count,
        orders: orderCount.rows[0].count,
        rows: rowCount.rows[0].count
      },
      companies: companies.rows.map(mapInvoiceCompanyRow),
      orders: orders.rows.map(mapInvoiceOrderRow)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/invoicing/companies", authRequired, async (_req, res, next) => {
  try {
    const result = await query("select * from invoice_companies order by name");
    res.json(result.rows.map(mapInvoiceCompanyRow));
  } catch (error) {
    next(error);
  }
});

app.post("/api/invoicing/companies", authRequired, async (req, res, next) => {
  try {
    const company = await saveInvoiceCompany(req.body);
    await insertAudit(req.user, "Invoice company saved", { module: "Invoicing", newValue: company });
    res.status(201).json(company);
  } catch (error) {
    next(error);
  }
});

app.put("/api/invoicing/companies/:id", authRequired, async (req, res, next) => {
  try {
    const company = await saveInvoiceCompany({ ...req.body, id: req.params.id });
    await insertAudit(req.user, "Invoice company saved", { module: "Invoicing", newValue: company });
    res.json(company);
  } catch (error) {
    next(error);
  }
});

app.get("/api/invoicing/search", authRequired, async (req, res, next) => {
  try {
    res.json(await searchInvoicing(req.query.q));
  } catch (error) {
    next(error);
  }
});

app.get("/api/invoicing/orders", authRequired, async (_req, res, next) => {
  try {
    const result = await query(`select o.*, c.name as company_name
                                from invoice_orders o
                                join invoice_companies c on c.id = o.company_id
                                order by o.uploaded_at desc`);
    res.json(result.rows.map(mapInvoiceOrderRow));
  } catch (error) {
    next(error);
  }
});

app.post("/api/invoicing/orders", authRequired, async (req, res, next) => {
  try {
    const order = await saveInvoiceOrder(req.body, req.user);
    await insertAudit(req.user, "Invoice order created", { module: "Invoicing", newValue: order });
    res.status(201).json(order);
  } catch (error) {
    next(error);
  }
});

app.post("/api/invoicing/orders/upload", authRequired, async (req, res, next) => {
  try {
    const fileName = String(req.body.fileName || "invoice-order.xlsx").trim();
    if (path.extname(fileName).toLowerCase() !== ".xlsx") {
      return res.status(400).json({ error: "Only .xlsx Excel files are supported for invoice uploads." });
    }
    const fileBase64 = String(req.body.fileBase64 || "").replace(/^data:.*?;base64,/i, "");
    if (!fileBase64) {
      return res.status(400).json({ error: "fileBase64 is required." });
    }

    const workbook = Buffer.from(fileBase64, "base64");
    const parsed = await parseInvoiceOrderWorkbook(workbook, fileName);
    const company = await saveInvoiceCompany({ name: parsed.companyName });
    const duplicate = await query(
      "select id, company_id, upload_version from invoice_orders where wax_shipment_inv_no=$1 order by upload_version desc limit 1",
      [parsed.waxShipmentInvNo]
    );
    const existing = duplicate.rows[0];
    if (existing && !req.body.overwrite && !req.body.newVersion) {
      return res.status(409).json({
        error: "An invoice order with this company and order number already exists. Confirm overwrite or create a new version.",
        code: "DUPLICATE_ORDER",
        orderId: String(existing.id)
      });
    }
    const versionInfo = existing && req.body.newVersion
      ? await nextVersionedInvoiceOrderNumber(parsed.waxShipmentInvNo)
      : { waxShipmentInvNo: parsed.waxShipmentInvNo, version: Number(existing?.upload_version || 1) };
    const { waxShipmentInvNo, version } = versionInfo;
    const rows = parsed.rows.map((row) => ({
      ...row,
      waxShipmentInvNo: row.waxShipmentInvNo === parsed.waxShipmentInvNo ? waxShipmentInvNo : row.waxShipmentInvNo
    }));
    const order = await saveInvoiceOrder(
      {
        id: existing && req.body.overwrite ? existing.id : undefined,
        companyId: company.id,
        waxShipmentInvNo,
        originalOrderNumber: parsed.waxShipmentInvNo,
        uploadVersion: version,
        invoiceNo: parsed.invoiceNo,
        dateOfOrder: parsed.dateOfOrder,
        soNo: parsed.soNo,
        metalType: parsed.metalType,
        waxWeight: parsed.waxWeight,
        castingWeight: parsed.castingWeight,
        laborCharge: parsed.laborCharge,
        settingCharge: parsed.settingCharge,
        stoneCharge: parsed.stoneCharge,
        extraCharge: parsed.extraCharge,
        goldValue: parsed.goldValue,
        silverValue: parsed.silverValue,
        platinumValue: parsed.platinumValue,
        status: existing && req.body.overwrite ? "Ready" : "Draft",
        sourceFileName: path.basename(fileName),
        rows
      },
      req.user
    );
    const sourceFilePath = await saveUploadedInvoiceWorkbook(order.id, fileName, workbook);
    const savedOrder = await setInvoiceOrderSourceFile(order.id, path.basename(fileName), sourceFilePath);

    await insertAudit(req.user, "Invoice order uploaded", {
      module: "Invoicing",
      newValue: { orderId: savedOrder.id, fileName, source: parsed.source, overwritten: Boolean(existing && req.body.overwrite), version }
    });
    res.status(existing && req.body.overwrite ? 200 : 201).json({ ...savedOrder, upload: parsed.source });
  } catch (error) {
    next(error);
  }
});

app.get("/api/invoicing/orders/:id", authRequired, async (req, res, next) => {
  try {
    const order = await fetchInvoiceOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "Invoice order not found." });
    res.json(order);
  } catch (error) {
    next(error);
  }
});

app.get("/api/invoicing/orders/:id/rows", authRequired, async (req, res, next) => {
  try {
    const result = await query("select * from invoice_order_rows where order_id=$1 order by sr_no, created_at", [req.params.id]);
    res.json(result.rows.map(mapInvoiceLineRow));
  } catch (error) {
    next(error);
  }
});

app.put("/api/invoicing/orders/:id", authRequired, async (req, res, next) => {
  try {
    const order = await saveInvoiceOrder({ ...req.body, id: req.params.id }, req.user);
    await insertAudit(req.user, "Invoice order edited", { module: "Invoicing", newValue: order });
    res.json(order);
  } catch (error) {
    next(error);
  }
});

app.post("/api/invoicing/orders/:id/generate", authRequired, async (req, res, next) => {
  try {
    const invoice = await generateInvoiceFile(req.params.id, req.body, req.user);
    await insertAudit(req.user, "Invoice generated", { module: "Invoicing", newValue: invoice });
    res.status(201).json(invoice);
  } catch (error) {
    next(error);
  }
});

app.post("/api/invoicing/orders/:id/generate-invoice", authRequired, async (req, res, next) => {
  try {
    const invoice = await generateInvoiceFile(req.params.id, req.body, req.user);
    await insertAudit(req.user, "Invoice Excel generated", { module: "Invoicing", newValue: invoice });
    res.status(201).json(invoice);
  } catch (error) {
    next(error);
  }
});

app.post("/api/invoicing/orders/:id/generate-shipping", authRequired, async (req, res, next) => {
  try {
    const shipping = await generateShippingFile(req.params.id, req.body, req.user);
    await insertAudit(req.user, "Shipping Excel generated", { module: "Invoicing", newValue: shipping });
    res.status(201).json(shipping);
  } catch (error) {
    next(error);
  }
});

app.post("/api/invoicing/orders/:id/generate-order-copy", authRequired, async (req, res, next) => {
  try {
    const orderCopy = await generateOrderCopyFile(req.params.id, req.body, req.user);
    await insertAudit(req.user, "Order copy Excel generated", { module: "Invoicing", newValue: orderCopy });
    res.status(201).json(orderCopy);
  } catch (error) {
    next(error);
  }
});

app.get("/api/invoicing/orders/:id/download-invoice", authRequired, async (req, res, next) => {
  try {
    await sendGeneratedInvoiceFile(req.params.id, "invoice", res);
  } catch (error) {
    next(error);
  }
});

app.get("/api/invoicing/orders/:id/download-shipping", authRequired, async (req, res, next) => {
  try {
    await sendGeneratedInvoiceFile(req.params.id, "shipping", res);
  } catch (error) {
    next(error);
  }
});

app.get("/api/invoicing/orders/:id/download-order-copy", authRequired, async (req, res, next) => {
  try {
    await sendGeneratedInvoiceFile(req.params.id, "order_copy", res);
  } catch (error) {
    next(error);
  }
});

app.post("/api/invoicing/orders/:id/download-invoice", authRequired, async (req, res, next) => {
  try {
    const invoice = await generateInvoiceFile(req.params.id, req.body, req.user);
    await sendGeneratedInvoiceFile(req.params.id, "invoice", res, invoice.id);
  } catch (error) {
    next(error);
  }
});

app.post("/api/invoicing/orders/:id/download-shipping", authRequired, async (req, res, next) => {
  try {
    const shipping = await generateShippingFile(req.params.id, req.body, req.user);
    await sendGeneratedInvoiceFile(req.params.id, "shipping", res, shipping.id);
  } catch (error) {
    next(error);
  }
});

app.post("/api/invoicing/orders/:id/download-order-copy", authRequired, async (req, res, next) => {
  try {
    const orderCopy = await generateOrderCopyFile(req.params.id, req.body, req.user);
    await sendGeneratedInvoiceFile(req.params.id, "order_copy", res, orderCopy.id);
  } catch (error) {
    next(error);
  }
});

const frontendIndex = path.join(publicRoot, "index.html");
if (fs.existsSync(frontendIndex)) {
  app.use(express.static(publicRoot));
  app.get("*", (_req, res) => res.sendFile(frontendIndex));
}

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  res.status(status).json({ error: status === 500 ? "Server error" : error.message, detail: process.env.NODE_ENV === "development" ? error.stack : undefined });
});

async function authRequired(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return res.status(401).json({ error: "Authentication required" });
    const payload = jwt.verify(token, jwtSecret);
    const result = await query(
      `select u.*, coalesce(json_agg(ur.role_id) filter (where ur.role_id is not null), '[]') as role_ids
       from users u left join user_roles ur on ur.user_id = u.id
       where u.id = $1 group by u.id`,
      [payload.sub]
    );
    if (!result.rows[0] || !result.rows[0].is_active) return res.status(401).json({ error: "Authentication required" });
    req.user = mapUserRow(result.rows[0]);
    next();
  } catch (_error) {
    res.status(401).json({ error: "Authentication required" });
  }
}

function getCorsOrigin() {
  const values = String(process.env.CORS_ORIGIN || "").split(",").map((value) => value.trim()).filter(Boolean);
  return values.length ? values : true;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function mapRoleRow(row) {
  return { id: row.id, name: row.name, description: row.description || "", isActive: row.is_active !== false, permissions: Array.isArray(row.permissions) ? row.permissions : [], system: Boolean(row.is_system) };
}

function mapUserRow(row) {
  const roleIds = Array.isArray(row.role_ids) ? row.role_ids : [];
  return {
    id: String(row.id),
    name: row.full_name,
    email: row.email,
    username: row.username || row.email,
    assignedRoleIds: roleIds,
    roleIds,
    isActive: row.is_active !== false,
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || "",
    lastLoginAt: row.last_login_at || ""
  };
}

function mapWaxEntryRow(row) {
  return {
    id: String(row.id),
    internalTreeNumber: row.internal_tree_number || "",
    barcodeValue: row.barcode_value || "",
    vendorCustomerName: row.vendor_customer_name || "",
    date: row.entry_date ? new Date(row.entry_date).toISOString().slice(0, 10) : "",
    waxInvoiceNo: row.wax_invoice_no || "",
    customerVendorTreeNo: row.customer_vendor_tree_no || "",
    metalKt: row.metal_kt || "",
    color: row.color || "",
    waxWeight: String(row.wax_weight || ""),
    isRush: Boolean(row.is_rush),
    isInHouseProduction: Boolean(row.is_in_house_production),
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || "",
    createdBy: row.created_by || ""
  };
}

function mapCastingOrderRow(row) {
  const workflow = row.workflow_data && typeof row.workflow_data === "object" ? row.workflow_data : {};
  return {
    id: String(row.id),
    waxEntryId: String(row.wax_entry_id),
    workflow: {
      ...workflow,
      stage: workflow.stage || row.current_stage || "Awaiting Metal",
      finalStatus: workflow.finalStatus || row.final_status || "",
      isDamaged: Boolean(workflow.isDamaged || row.is_damaged),
      removedFromBoard: Boolean(workflow.removedFromBoard || row.removed_from_board),
      updatedAt: workflow.updatedAt || row.updated_at || ""
    }
  };
}

function mapMetalReceivingRow(row) {
  const payload = row.payload || {};
  return {
    id: row.local_id || String(row.id),
    color: row.color || "",
    createdByUserId: row.created_by || "",
    createdByUsername: payload.createdByUsername || "",
    locked: row.locked !== false,
    metalKtColor: row.metal_kt_color || "",
    metalType: row.metal_type || "",
    notes: row.notes || "",
    purity: row.purity || "",
    referenceNumber: row.reference_number || "",
    submittedAt: row.submitted_at || row.created_at || "",
    supplier: row.supplier || "",
    weightReceived: number(row.weight_received)
  };
}

function mapInventoryLedgerRow(row) {
  const payload = row.payload || {};
  return {
    id: row.local_id || String(row.id),
    balanceAfterTransaction: number(row.balance_after_transaction),
    bucketKey: row.bucket_key || "",
    category: row.category || "",
    color: row.color || "",
    createdAt: row.created_at || "",
    createdByUserId: row.created_by || "",
    createdByUsername: payload.createdByUsername || "",
    inWeight: number(row.in_weight),
    metalKtColor: row.metal_kt_color || "",
    metalType: row.metal_type || "",
    notes: row.notes || "",
    outWeight: number(row.out_weight),
    purity: row.purity || "",
    relatedBarcodeValue: row.related_barcode_value || "",
    relatedInternalTreeNumber: row.related_internal_tree_number || "",
    relatedOrderId: row.related_order_id || "",
    sourceId: row.source_id || "",
    sourceModule: row.source_module || "",
    transactionType: row.transaction_type || ""
  };
}

function mapInventoryPostingRow(row) {
  const payload = row.payload || {};
  return {
    id: row.local_id || String(row.id),
    barcodeValue: row.barcode_value || "",
    finishedProductWeight: number(row.finished_product_weight),
    internalTreeNumber: row.internal_tree_number || "",
    ledgerEntryIds: Array.isArray(row.ledger_entry_ids) ? row.ledger_entry_ids.map(String) : [],
    notes: row.notes || "",
    orderId: row.order_id || "",
    postedAt: row.posted_at || row.created_at || "",
    postedByUserId: row.posted_by || "",
    postedByUsername: payload.postedByUsername || "",
    pureConsumedWeight: number(row.pure_consumed_weight),
    reusableBalanceWeight: number(row.reusable_balance_weight),
    scrapLossWeight: number(row.scrap_loss_weight)
  };
}

function mapInventoryBalanceRow(row) {
  return { bucketKey: row.bucket_key || "", category: row.category || "", color: row.color || "", label: row.balance_label || "", metalKtColor: row.metal_kt_color || "", metalType: row.metal_type || "", purity: row.purity || "", balance: number(row.balance), updatedAt: row.updated_at || "" };
}

function mapAuditLogRow(row) {
  return {
    id: String(row.id),
    userId: row.actor_user_id || "",
    username: row.actor_email || "Unknown User",
    action: row.action || "",
    barcodeValue: row.barcode_value || "",
    isInHouseProduction: typeof row.is_in_house_production === "boolean" ? (row.is_in_house_production ? "Yes" : "No") : "",
    module: row.module || "",
    stage: row.stage || "",
    internalTreeNumber: row.internal_tree_number || "",
    oldValue: formatValue(row.old_value),
    newValue: formatValue(row.new_value),
    notes: row.notes || "",
    device: row.device || "",
    createdAt: row.created_at || ""
  };
}

function mapInvoiceCompanyRow(row) {
  return {
    id: String(row.id),
    name: row.name || "",
    address: row.address || "",
    goldLaborPrice: number(row.gold_labor_price),
    silverLaborPrice: number(row.silver_labor_price),
    platinumLaborPrice: number(row.platinum_labor_price),
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || ""
  };
}

function mapInvoiceOrderRow(row) {
  return {
    id: String(row.id),
    orderNumber: row.order_number,
    companyId: String(row.company_id || ""),
    companyName: row.company_name || "",
    waxShipmentInvNo: row.wax_shipment_inv_no || "",
    originalOrderNumber: row.original_order_number || "",
    uploadVersion: row.upload_version || 1,
    invoiceNo: row.invoice_no || "",
    dateOfOrder: row.date_of_order ? new Date(row.date_of_order).toISOString().slice(0, 10) : "",
    soNo: row.so_no || "",
    metalType: row.metal_type || "",
    waxWeight: number(row.wax_weight),
    castingWeight: number(row.casting_weight),
    laborCharge: number(row.labor_charge),
    settingCharge: number(row.setting_charge),
    stoneCharge: number(row.stone_charge),
    extraCharge: number(row.extra_charge),
    goldValue: number(row.gold_value),
    silverValue: number(row.silver_value),
    platinumValue: number(row.platinum_value),
    status: row.status || "Draft",
    sourceFileName: row.source_file_name || "",
    sourceFilePath: row.source_file_path || "",
    uploadedAt: row.uploaded_at || "",
    updatedAt: row.updated_at || "",
    createdBy: row.created_by || ""
  };
}

function mapInvoiceOrderDetail(orderRow, lineRows = [], invoiceRows = []) {
  return {
    ...mapInvoiceOrderRow(orderRow),
    rows: lineRows.map(mapInvoiceLineRow),
    generatedInvoices: invoiceRows.map(mapGeneratedInvoiceRow)
  };
}

function mapInvoiceLineRow(row) {
  return {
    id: String(row.id || ""),
    srNo: row.sr_no || 0,
    waxShipmentInvNo: row.wax_shipment_inv_no || "",
    treeNo: row.tree_no || "",
    vpoPoNo: row.vpo_po_no || "",
    productCategory: row.product_category || "",
    sku: row.sku || "",
    customerSku: row.customer_sku || "",
    waxQty: number(row.wax_qty),
    orderQty: number(row.order_qty),
    kt: row.kt || "",
    color: row.color || "",
    netWtPc: number(row.net_wt_pc),
    grossWtPc: number(row.gross_wt_pc),
    totalWt: number(row.total_wt),
    requiredMetalPg: number(row.required_metal_pg),
    totalValue: number(row.total_value),
    waxWeight: number(row.wax_weight),
    castingQty: number(row.casting_qty),
    castingWeight: number(row.casting_weight),
    laborCharge: number(row.labor_charge),
    settingCharge: number(row.setting_charge),
    stoneCharge: number(row.stone_charge),
    extraCharge: number(row.extra_charge),
    notes: row.notes || "",
    imageUrl: row.image_url || ""
  };
}

function mapGeneratedInvoiceRow(row) {
  return {
    id: String(row.id || ""),
    orderId: String(row.order_id || ""),
    invoiceNo: row.invoice_no || "",
    invoiceDate: row.invoice_date ? new Date(row.invoice_date).toISOString().slice(0, 10) : "",
    metalType: row.metal_type || "",
    laborRate: number(row.labor_rate),
    goldSpot: number(row.gold_spot),
    platinumSpot: number(row.platinum_spot),
    silverSpot: number(row.silver_spot),
    fileType: row.file_type || "invoice",
    filePath: row.file_path || "",
    generatedAt: row.generated_at || row.created_at || "",
    createdAt: row.created_at || row.generated_at || "",
    generatedBy: row.generated_by || row.created_by || "",
    createdBy: row.created_by || row.generated_by || ""
  };
}

async function fetchUsers() {
  const result = await query(
    `select u.*, coalesce(json_agg(ur.role_id) filter (where ur.role_id is not null), '[]') as role_ids
     from users u left join user_roles ur on ur.user_id = u.id
     group by u.id order by u.full_name`
  );
  return result.rows.map(mapUserRow);
}

async function saveUser(input) {
  const email = normalizeEmail(input.email || input.username);
  const name = String(input.name || input.fullName || "").trim();
  if (!email || !name) throw Object.assign(new Error("Full name and email are required."), { status: 400 });
  const roles = unique(input.assignedRoleIds || input.roleIds || []);
  const existing = input.id ? (await query("select * from users where id = $1", [input.id])).rows[0] : null;
  const password = String(input.password || "");
  const hash = password ? await bcrypt.hash(password, 12) : existing?.password_hash || await bcrypt.hash("Temp@12345", 12);

  return transaction(async (client) => {
    const result = await client.query(
      existing
        ? `update users set email=$1, username=$1, full_name=$2, password_hash=$3, is_active=$4, updated_at=now() where id=$5 returning *`
        : `insert into users (email, username, full_name, password_hash, is_active) values ($1,$1,$2,$3,$4) returning *`,
      existing ? [email, name, hash, input.isActive !== false, existing.id] : [email, name, hash, input.isActive !== false]
    );
    const user = result.rows[0];
    await client.query("delete from user_roles where user_id = $1", [user.id]);
    for (const roleId of roles.length ? roles : ["role_wax_entry"]) {
      await client.query("insert into user_roles (user_id, role_id) values ($1, $2) on conflict do nothing", [user.id, roleId]);
    }
    const users = await client.query(
      `select u.*, coalesce(json_agg(ur.role_id) filter (where ur.role_id is not null), '[]') as role_ids
       from users u left join user_roles ur on ur.user_id = u.id where u.id = $1 group by u.id`,
      [user.id]
    );
    return { created: !existing, passwordChanged: Boolean(password), previousUser: existing ? mapUserRow({ ...existing, role_ids: [] }) : null, user: mapUserRow(users.rows[0]) };
  });
}

async function saveRole(input) {
  const id = String(input.id || `role_${Date.now()}`).trim();
  const role = {
    id,
    name: String(input.name || "Untitled Role").trim(),
    description: String(input.description || "").trim(),
    isActive: input.isActive !== false,
    system: id === "role_admin" || Boolean(input.system),
    permissions: id === "role_admin" ? require("./permissions").allPermissions() : unique(input.permissions || [])
  };
  const result = await query(
    `insert into roles (id, name, description, is_active, is_system, permissions)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (id) do update set name=$2, description=$3, is_active=$4, is_system=$5, permissions=$6, updated_at=now()
     returning *`,
    [role.id, role.name, role.description, role.isActive, role.system, JSON.stringify(role.permissions)]
  );
  return mapRoleRow(result.rows[0]);
}

async function saveInvoiceCompany(input) {
  const name = String(input.name || "").trim();
  if (!name) throw Object.assign(new Error("Company name is required."), { status: 400 });
  const values = [
    name,
    String(input.address || "").trim(),
    nullableNumber(input.goldLaborPrice),
    nullableNumber(input.silverLaborPrice),
    nullableNumber(input.platinumLaborPrice)
  ];
  const result = await query(
    input.id
      ? `update invoice_companies set name=$1, address=$2, gold_labor_price=$3, silver_labor_price=$4, platinum_labor_price=$5, updated_at=now()
         where id=$6 returning *`
      : `insert into invoice_companies (name, address, gold_labor_price, silver_labor_price, platinum_labor_price)
         values ($1,$2,$3,$4,$5)
         on conflict (name) do update set address=excluded.address, gold_labor_price=excluded.gold_labor_price,
          silver_labor_price=excluded.silver_labor_price, platinum_labor_price=excluded.platinum_labor_price, updated_at=now()
         returning *`,
    input.id ? [...values, input.id] : values
  );
  if (!result.rows[0]) throw Object.assign(new Error("Invoice company not found."), { status: 404 });
  return mapInvoiceCompanyRow(result.rows[0]);
}

async function saveInvoiceOrder(input, user) {
  const companyId = String(input.companyId || "").trim();
  const waxShipmentInvNo = String(input.waxShipmentInvNo || "").trim();
  if (!companyId || !waxShipmentInvNo) {
    throw Object.assign(new Error("Company and Wax Shipment Invoice Number are required."), { status: 400 });
  }
  const rows = Array.isArray(input.rows) ? input.rows : [];
  return transaction(async (client) => {
    const values = [
      companyId,
      waxShipmentInvNo,
      String(input.originalOrderNumber || waxShipmentInvNo).trim(),
      Number.parseInt(input.uploadVersion || 1, 10) || 1,
      String(input.invoiceNo || "").trim(),
      String(input.dateOfOrder || "").trim() || null,
      String(input.soNo || "").trim(),
      String(input.metalType || "").trim(),
      nullableNumber(input.waxWeight),
      nullableNumber(input.castingWeight),
      nullableNumber(input.laborCharge),
      nullableNumber(input.settingCharge),
      nullableNumber(input.stoneCharge),
      nullableNumber(input.extraCharge),
      nullableNumber(input.goldValue),
      nullableNumber(input.silverValue),
      nullableNumber(input.platinumValue),
      String(input.status || "Draft").trim() || "Draft",
      String(input.sourceFileName || "").trim(),
      String(input.sourceFilePath || "").trim(),
      user.id
    ];
    const orderResult = await client.query(
      input.id
        ? `update invoice_orders set company_id=$1, wax_shipment_inv_no=$2, original_order_number=$3, upload_version=$4,
           invoice_no=$5, date_of_order=$6, so_no=$7, metal_type=$8, wax_weight=$9, casting_weight=$10,
           labor_charge=$11, setting_charge=$12, stone_charge=$13, extra_charge=$14, gold_value=$15,
           silver_value=$16, platinum_value=$17, status=$18, source_file_name=coalesce(nullif($19, ''), source_file_name),
           source_file_path=coalesce(nullif($20, ''), source_file_path),
           created_by=$21, updated_at=now()
           where id=$22 returning *`
        : `insert into invoice_orders (
           company_id, wax_shipment_inv_no, original_order_number, upload_version, invoice_no, date_of_order, so_no,
           metal_type, wax_weight, casting_weight, labor_charge, setting_charge, stone_charge, extra_charge,
           gold_value, silver_value, platinum_value, status, source_file_name, source_file_path, created_by
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) returning *`,
      input.id ? [...values, input.id] : values
    );
    const order = orderResult.rows[0];
    if (!order) throw Object.assign(new Error("Invoice order not found."), { status: 404 });
    if (input.id) {
      await client.query("delete from invoice_order_rows where order_id=$1", [order.id]);
    }
    for (const [index, row] of rows.entries()) {
      await client.query(
        `insert into invoice_order_rows (
          order_id, sr_no, wax_shipment_inv_no, tree_no, vpo_po_no, product_category, sku, customer_sku,
          wax_qty, order_qty, kt, color, net_wt_pc, gross_wt_pc, total_wt, required_metal_pg,
          total_value, wax_weight, casting_qty, casting_weight, labor_charge, setting_charge, stone_charge,
          extra_charge, notes, image_url
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
        [
          order.id,
          Number.parseInt(row.srNo || index + 1, 10) || index + 1,
          row.waxShipmentInvNo || waxShipmentInvNo,
          row.treeNo || "",
          row.vpoPoNo || "",
          row.productCategory || "",
          row.sku || "",
          row.customerSku || "",
          nullableNumber(row.waxQty),
          nullableNumber(row.orderQty),
          row.kt || "",
          row.color || "",
          nullableNumber(row.netWtPc),
          nullableNumber(row.grossWtPc),
          nullableNumber(row.totalWt),
          nullableNumber(row.requiredMetalPg),
          nullableNumber(row.totalValue),
          nullableNumber(row.waxWeight),
          nullableNumber(row.castingQty),
          nullableNumber(row.castingWeight),
          nullableNumber(row.laborCharge),
          nullableNumber(row.settingCharge),
          nullableNumber(row.stoneCharge),
          nullableNumber(row.extraCharge),
          row.notes || "",
          row.imageUrl || ""
        ]
      );
    }
    return fetchInvoiceOrder(order.id, client);
  });
}

async function fetchInvoiceOrder(orderId, client = { query }) {
  const orderResult = await client.query(
    `select o.*, c.name as company_name
     from invoice_orders o
     join invoice_companies c on c.id = o.company_id
     where o.id=$1`,
    [orderId]
  );
  if (!orderResult.rows[0]) return null;
  const [lineResult, invoiceResult] = await Promise.all([
    client.query("select * from invoice_order_rows where order_id=$1 order by sr_no, created_at", [orderId]),
    client.query("select * from generated_invoices where order_id=$1 order by generated_at desc", [orderId])
  ]);
  return mapInvoiceOrderDetail(orderResult.rows[0], lineResult.rows, invoiceResult.rows);
}

async function searchInvoicing(rawQuery) {
  const term = String(rawQuery || "").trim();
  if (!term) return { companies: [], orders: [], rows: [] };
  const like = `%${term}%`;
  const [companies, orders, rows] = await Promise.all([
    query("select * from invoice_companies where name ilike $1 or coalesce(address, '') ilike $1 order by name limit 25", [like]),
    query(
      `select o.*, c.name as company_name
       from invoice_orders o
       join invoice_companies c on c.id=o.company_id
       where c.name ilike $1
          or o.wax_shipment_inv_no ilike $1
          or coalesce(o.original_order_number, '') ilike $1
          or coalesce(o.invoice_no, '') ilike $1
          or coalesce(o.so_no, '') ilike $1
          or o.order_number::text ilike $1
       order by o.uploaded_at desc
       limit 25`,
      [like]
    ),
    query(
      `select r.*, o.order_number, o.wax_shipment_inv_no as order_wax_shipment_inv_no, c.name as company_name
       from invoice_order_rows r
       join invoice_orders o on o.id=r.order_id
       join invoice_companies c on c.id=o.company_id
       where coalesce(r.tree_no, '') ilike $1
          or coalesce(r.vpo_po_no, '') ilike $1
          or coalesce(r.sku, '') ilike $1
          or coalesce(r.customer_sku, '') ilike $1
          or coalesce(r.notes, '') ilike $1
       order by r.created_at desc
       limit 50`,
      [like]
    )
  ]);
  return {
    companies: companies.rows.map(mapInvoiceCompanyRow),
    orders: orders.rows.map(mapInvoiceOrderRow),
    rows: rows.rows.map((row) => ({
      ...mapInvoiceLineRow(row),
      orderNumber: row.order_number,
      orderWaxShipmentInvNo: row.order_wax_shipment_inv_no || "",
      companyName: row.company_name || ""
    }))
  };
}

async function nextVersionedInvoiceOrderNumber(baseOrderNumber) {
  const existing = await query(
    "select coalesce(max(upload_version), 1)::int as version from invoice_orders where original_order_number=$1 or wax_shipment_inv_no=$1",
    [baseOrderNumber]
  );
  let suffix = Number(existing.rows[0]?.version || 1) + 1;
  let candidate = `${baseOrderNumber}-v${suffix}`;
  while ((await query("select 1 from invoice_orders where wax_shipment_inv_no=$1 limit 1", [candidate])).rows[0]) {
    suffix += 1;
    candidate = `${baseOrderNumber}-v${suffix}`;
  }
  return { waxShipmentInvNo: candidate, version: suffix };
}

async function saveUploadedInvoiceWorkbook(orderId, fileName, buffer) {
  const uploadDir = path.join(invoiceFileRoot, "uploads");
  await fsp.mkdir(uploadDir, { recursive: true });
  const safeName = safeWorkbookFileName(path.basename(fileName || "invoice-order.xlsx"));
  const filePath = path.join(uploadDir, `${orderId}-${Date.now()}-${safeName}`);
  await fsp.writeFile(filePath, buffer);
  return filePath;
}

async function setInvoiceOrderSourceFile(orderId, fileName, filePath) {
  await query("update invoice_orders set source_file_name=$1, source_file_path=$2, updated_at=now() where id=$3", [fileName, filePath, orderId]);
  return fetchInvoiceOrder(orderId);
}

async function generateInvoiceFile(orderId, input, user) {
  return generateWorkbookFile(orderId, input, user, "invoice");
}

async function generateShippingFile(orderId, input, user) {
  return generateWorkbookFile(orderId, input, user, "shipping");
}

async function generateWorkbookFile(orderId, input, user, fileType) {
  const order = await fetchInvoiceOrder(orderId);
  if (!order) throw Object.assign(new Error("Invoice order not found."), { status: 404 });
  const payload = normalizeInvoiceDownloadPayload(input, order, fileType === "shipping" ? "Shipping" : "Invoice");
  const company = invoiceCompanyFromOrder(order);
  const rows = order.rows || [];
  const buffer =
    fileType === "shipping"
      ? await generateShippingWorkbook({ ...payload, order, company, rows })
      : await generateInvoiceWorkbook({ ...payload, order, company, rows });
  const fileName = workbookFileName(fileType === "shipping" ? "Shipping" : "Invoice", payload.invoiceNo, order.companyName);
  const filePath = await saveGeneratedWorkbookFile(order.id, fileName, buffer);
  const generated = await insertGeneratedInvoiceRecord(order.id, { ...payload, fileType, filePath, metalType: input.metalType }, user);
  if (fileType === "invoice") await query("update invoice_orders set status='Invoiced', updated_at=now() where id=$1", [order.id]);
  return generated;
}

async function generateOrderCopyFile(orderId, input, user) {
  const order = await fetchInvoiceOrder(orderId);
  if (!order) throw Object.assign(new Error("Invoice order not found."), { status: 404 });
  const invoiceNo = String(input.invoiceNo || `ORDER-COPY-${order.orderNumber || Date.now()}`).trim();
  const invoiceDate = String(input.invoiceDate || order.dateOfOrder || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const company = invoiceCompanyFromOrder(order);
  const buffer = await generateOrderCopyWorkbook({ order, company, rows: order.rows || [], sourceFilePath: order.sourceFilePath });
  const fileName = workbookFileName("Order_Copy", invoiceNo, order.companyName);
  const filePath = await saveGeneratedWorkbookFile(order.id, fileName, buffer);
  return insertGeneratedInvoiceRecord(order.id, { invoiceNo, invoiceDate, fileType: "order_copy", filePath, metalType: input.metalType || order.metalType }, user);
}

async function saveGeneratedWorkbookFile(orderId, fileName, buffer) {
  const generatedDir = path.join(invoiceFileRoot, "generated");
  await fsp.mkdir(generatedDir, { recursive: true });
  const filePath = path.join(generatedDir, `${orderId}-${Date.now()}-${safeWorkbookFileName(fileName)}`);
  await fsp.writeFile(filePath, buffer);
  return filePath;
}

async function insertGeneratedInvoiceRecord(orderId, payload, user) {
  const result = await query(
    `insert into generated_invoices (
      order_id, invoice_no, invoice_date, metal_type, labor_rate, gold_spot, platinum_spot, silver_spot,
      file_type, file_path, generated_by, created_by
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) returning *`,
    [
      orderId,
      payload.invoiceNo,
      payload.invoiceDate || new Date().toISOString().slice(0, 10),
      String(payload.metalType || "").trim(),
      nullableNumber(payload.laborRate),
      nullableNumber(payload.goldSpot),
      nullableNumber(payload.platinumSpot),
      nullableNumber(payload.silverSpot),
      payload.fileType || "invoice",
      payload.filePath || "",
      user.id
    ]
  );
  return mapGeneratedInvoiceRow(result.rows[0]);
}

async function sendGeneratedInvoiceFile(orderId, fileType, res, generatedId = null) {
  const generated = await fetchGeneratedInvoiceFile(orderId, fileType, generatedId);
  if (!generated) throw Object.assign(new Error(`No generated ${fileType.replace("_", " ")} file found. Generate it first.`), { status: 404 });
  if (!generated.file_path || !isPathInside(invoiceFileRoot, generated.file_path) || !fs.existsSync(generated.file_path)) {
    throw Object.assign(new Error(`Generated ${fileType.replace("_", " ")} file is missing on the server. Generate it again.`), { status: 404 });
  }
  const buffer = await fsp.readFile(generated.file_path);
  const storedName = path.basename(generated.file_path);
  const downloadName = storedName.replace(new RegExp(`^${escapeRegex(String(orderId))}-\\d+-`), "");
  sendWorkbook(res, buffer, downloadName || storedName);
}

async function fetchGeneratedInvoiceFile(orderId, fileType, generatedId = null) {
  const result = await query(
    generatedId
      ? "select * from generated_invoices where id=$1 and order_id=$2 and file_type=$3"
      : "select * from generated_invoices where order_id=$1 and file_type=$2 order by created_at desc, generated_at desc limit 1",
    generatedId ? [generatedId, orderId, fileType] : [orderId, fileType]
  );
  return result.rows[0] || null;
}

function safeWorkbookFileName(fileName) {
  const ext = path.extname(fileName || ".xlsx") || ".xlsx";
  const base = path.basename(fileName || "workbook", ext).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "workbook";
  return `${base}${ext.toLowerCase() === ".xlsx" ? ".xlsx" : ext}`;
}

function isPathInside(rootPath, filePath) {
  const relative = path.relative(rootPath, filePath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function generateInvoice(orderId, input, user) {
  const invoiceNo = String(input.invoiceNo || `INV-${Date.now()}`).trim();
  const result = await query(
    `insert into generated_invoices (order_id, invoice_no, invoice_date, metal_type, labor_rate, gold_spot, platinum_spot, silver_spot, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [
      orderId,
      invoiceNo,
      String(input.invoiceDate || "").trim() || new Date().toISOString().slice(0, 10),
      String(input.metalType || "").trim(),
      nullableNumber(input.laborRate),
      nullableNumber(input.goldSpot),
      nullableNumber(input.platinumSpot),
      nullableNumber(input.silverSpot),
      user.id
    ]
  );
  await query("update invoice_orders set status='Invoiced', updated_at=now() where id=$1", [orderId]);
  return mapGeneratedInvoiceRow(result.rows[0]);
}

function normalizeInvoiceDownloadPayload(input = {}, order, fallbackPrefix) {
  const invoiceNo = String(input.invoiceNo || `${fallbackPrefix}-${order.orderNumber || Date.now()}`).trim();
  const invoiceDate = String(input.invoiceDate || order.dateOfOrder || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const laborRate = nullableNumber(input.laborRate);
  const goldSpot = nullableNumber(input.goldSpot ?? order.goldValue);
  const platinumSpot = nullableNumber(input.platinumSpot ?? order.platinumValue);
  const silverSpot = nullableNumber(input.silverSpot ?? order.silverValue);
  if (!invoiceNo) throw Object.assign(new Error("Invoice number is required."), { status: 400 });
  if (!laborRate || !goldSpot || !platinumSpot || !silverSpot) {
    throw Object.assign(new Error("Labor rate, gold spot, platinum spot, and silver spot are required."), { status: 400 });
  }
  return { invoiceNo, invoiceDate, laborRate, goldSpot, platinumSpot, silverSpot };
}

function invoiceCompanyFromOrder(order) {
  return {
    id: order.companyId,
    name: order.companyName || "Company"
  };
}

function sendWorkbook(res, buffer, fileName) {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.setHeader("Content-Length", buffer.length);
  res.send(buffer);
}

async function createWaxEntry(input, user) {
  return transaction(async (client) => {
    const generated = await nextTreeNumber(client);
    const date = String(input.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
    const barcode = `${date.slice(2, 4)}${date.slice(5, 7)}${date.slice(8, 10)}-${generated}`;
    const result = await client.query(
      `insert into wax_entries (internal_tree_number, barcode_value, vendor_customer_name, entry_date, wax_invoice_no, customer_vendor_tree_no, metal_kt, color, wax_weight, is_rush, is_in_house_production, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
      [generated, barcode, input.vendorCustomerName || "", date, input.waxInvoiceNo || "", input.customerVendorTreeNo || "", input.metalKt || "", input.color || "", number(input.waxWeight), Boolean(input.isRush), Boolean(input.isInHouseProduction), user.id]
    );
    return mapWaxEntryRow(result.rows[0]);
  });
}

async function updateWaxEntry(id, input) {
  const result = await query(
    `update wax_entries set vendor_customer_name=$1, entry_date=$2, wax_invoice_no=$3, customer_vendor_tree_no=$4, metal_kt=$5, color=$6, wax_weight=$7, is_rush=$8, is_in_house_production=$9, updated_at=now()
     where id=$10 returning *`,
    [input.vendorCustomerName || "", input.date || null, input.waxInvoiceNo || "", input.customerVendorTreeNo || "", input.metalKt || "", input.color || "", number(input.waxWeight), Boolean(input.isRush), Boolean(input.isInHouseProduction), id]
  );
  if (!result.rows[0]) throw Object.assign(new Error("Wax entry not found."), { status: 404 });
  return mapWaxEntryRow(result.rows[0]);
}

async function nextTreeNumber(client) {
  const result = await client.query(
    `insert into internal_tree_counters (prefix, last_sequence) values ('A', 1)
     on conflict (prefix) do update set last_sequence = internal_tree_counters.last_sequence + 1, updated_at = now()
     returning prefix, last_sequence`
  );
  return `${result.rows[0].prefix}-${result.rows[0].last_sequence}`;
}

async function ensureCastingOrder(entry, user) {
  const result = await query(
    `insert into casting_orders (wax_entry_id, current_stage, barcode_value, internal_tree_number, workflow_data, created_by)
     values ($1, 'Awaiting Metal', $2, $3, $4, $5)
     on conflict (wax_entry_id) do update set barcode_value=$2, internal_tree_number=$3, updated_at=now()
     returning *`,
    [entry.id, entry.barcodeValue, entry.internalTreeNumber, JSON.stringify({ stage: "Awaiting Metal" }), user.id]
  );
  return mapCastingOrderRow(result.rows[0]);
}

async function saveCastingWorkflow(waxEntryId, workflow, event, user) {
  const existing = await query("select * from casting_orders where wax_entry_id = $1 or id = $1", [waxEntryId]);
  if (!existing.rows[0]) throw Object.assign(new Error("Casting order not found."), { status: 404 });
  const result = await query(
    `update casting_orders set current_stage=$1, workflow_data=$2, is_damaged=$3, removed_from_board=$4, final_status=$5, updated_at=now()
     where id=$6 returning *`,
    [workflow.stage || event.toStage || "Awaiting Metal", JSON.stringify(workflow), Boolean(workflow.isDamaged || workflow.castingIssue?.damaged || workflow.damagedTree), Boolean(workflow.removedFromBoard), workflow.finalStatus || null, existing.rows[0].id]
  );
  await query(
    `insert into order_stage_history (casting_order_id, from_stage, to_stage, action, notes, payload, created_by)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [existing.rows[0].id, event.fromStage || null, event.toStage || workflow.stage || null, event.action || "Stage submitted", event.notes || null, JSON.stringify(event.payload || event.details || {}), user.id]
  );
  await insertAudit(user, event.action || "Order moved between stages", { module: "Casting Process", stage: workflow.stage, newValue: workflow });
  return mapCastingOrderRow(result.rows[0]);
}

async function saveMetalReceiving(entry, ledgerEntry, user) {
  const saved = await query(
    `insert into metal_receiving_entries (local_id, metal_type, purity, metal_kt_color, color, weight_received, supplier, reference_number, notes, submitted_at, locked, created_by, payload)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict (local_id) do update set weight_received=excluded.weight_received, notes=excluded.notes
     returning *`,
    [entry.id || null, entry.metalType || "", entry.purity || "", entry.metalKtColor || "", entry.color || "", number(entry.weightReceived), entry.supplier || "", entry.referenceNumber || "", entry.notes || "", entry.submittedAt || new Date().toISOString(), entry.locked !== false, user.id, JSON.stringify({ createdByUsername: user.username })]
  );
  const ledger = ledgerEntry ? (await upsertLedgerEntries([ledgerEntry], user))[0] : null;
  return { receivingEntry: mapMetalReceivingRow(saved.rows[0]), ledgerEntry: ledger };
}

async function saveInventoryPosting(posting, ledgerEntries, user) {
  const savedLedger = await upsertLedgerEntries(ledgerEntries, user);
  const result = await query(
    `insert into inventory_postings (local_id, order_id, barcode_value, internal_tree_number, finished_product_weight, reusable_balance_weight, scrap_loss_weight, pure_consumed_weight, ledger_entry_ids, posted_at, posted_by, notes, payload)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
    [posting.id || null, posting.orderId || "", posting.barcodeValue || "", posting.internalTreeNumber || "", number(posting.finishedProductWeight), number(posting.reusableBalanceWeight), number(posting.scrapLossWeight), number(posting.pureConsumedWeight), JSON.stringify(savedLedger.map((row) => row.id)), posting.postedAt || new Date().toISOString(), user.id, posting.notes || "", JSON.stringify({ postedByUsername: user.username })]
  );
  return { posting: mapInventoryPostingRow(result.rows[0]), ledgerEntries: savedLedger };
}

async function upsertLedgerEntries(entries, user) {
  const saved = [];
  for (const entry of entries) {
    const result = await query(
      `insert into inventory_ledger (local_id, bucket_key, category, transaction_type, metal_type, purity, metal_kt_color, color, in_weight, out_weight, balance_after_transaction, related_internal_tree_number, related_barcode_value, related_order_id, source_module, source_id, notes, created_by, created_at, payload)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       on conflict (local_id) do update set in_weight=excluded.in_weight, out_weight=excluded.out_weight, balance_after_transaction=excluded.balance_after_transaction
       returning *`,
      [entry.id || null, entry.bucketKey || "", entry.category || "", entry.transactionType || "", entry.metalType || "", entry.purity || "", entry.metalKtColor || "", entry.color || "", number(entry.inWeight), number(entry.outWeight), number(entry.balanceAfterTransaction), entry.relatedInternalTreeNumber || "", entry.relatedBarcodeValue || "", entry.relatedOrderId || "", entry.sourceModule || "", entry.sourceId || "", entry.notes || "", user.id, entry.createdAt || new Date().toISOString(), JSON.stringify({ createdByUsername: user.username })]
    );
    const mapped = mapInventoryLedgerRow(result.rows[0]);
    saved.push(mapped);
    await query(
      `insert into inventory_balances (bucket_key, category, metal_type, purity, metal_kt_color, color, balance, balance_label, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,now())
       on conflict (bucket_key) do update set category=$2, metal_type=$3, purity=$4, metal_kt_color=$5, color=$6, balance=$7, balance_label=$8, updated_at=now()`,
      [mapped.bucketKey, mapped.category, mapped.metalType, mapped.purity, mapped.metalKtColor, mapped.color, mapped.balanceAfterTransaction, balanceLabel(mapped)]
    );
  }
  return saved;
}

async function insertAudit(user, action, entry = {}) {
  const result = await query(
    `insert into audit_logs (actor_user_id, actor_email, action, barcode_value, is_in_house_production, module, stage, internal_tree_number, old_value, new_value, notes, device)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
    [user?.id || null, entry.actorEmail || user?.email || "", action, entry.barcodeValue || "", typeof entry.isInHouseProduction === "boolean" ? entry.isInHouseProduction : null, entry.module || "", entry.stage || "", entry.internalTreeNumber || "", jsonOrNull(entry.oldValue), jsonOrNull(entry.newValue), entry.notes || "", entry.device || ""]
  );
  return mapAuditLogRow(result.rows[0]);
}

function jsonOrNull(value) {
  if (value === undefined || value === "") return null;
  return JSON.stringify(value);
}

function formatValue(value) {
  if (value === null || value === undefined || value === "") return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function number(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) / 1000 : 0;
}

function nullableNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) / 1000 : null;
}

function unique(values) {
  return [...new Set((values || []).map(String).filter(Boolean))];
}

function balanceLabel(entry) {
  if (entry.category === "pureGold") return "Pure Gold / 24KT Gold";
  if (entry.category === "purePlatinum") return "Platinum";
  if (entry.category === "pureSilver") return "Fine Silver";
  return entry.metalKtColor || entry.purity || entry.metalType || "Inventory";
}

async function start() {
  if (process.env.SKIP_AUTO_MIGRATE !== "true") {
    await migrate();
    await seed();
  }
  app.listen(port, () => console.log(`Casting Production Management listening on http://localhost:${port}`));
}

if (require.main === module) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { app, pool };
