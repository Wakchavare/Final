require("dotenv").config();

const fs = require("fs");
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

const app = express();
const port = Number(process.env.PORT || 3000);
const jwtSecret = process.env.JWT_SECRET || "development-secret-change-me";
const jwtExpiresIn = process.env.JWT_EXPIRES_IN || "8h";
const publicRoot = process.env.PUBLIC_ROOT || path.resolve(__dirname, "..", "public");

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: getCorsOrigin(), credentials: true }));
app.use(express.json({ limit: "2mb" }));
app.use(morgan(process.env.NODE_ENV === "test" ? "tiny" : "dev"));

app.get("/api/health", async (_req, res) => {
  try {
    await query("select 1");
    res.json({ ok: true, database: "connected", timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({ ok: false, database: "disconnected", error: error.message });
  }
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

app.get("/api/invoicing/orders/:id", authRequired, async (req, res, next) => {
  try {
    const order = await fetchInvoiceOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "Invoice order not found." });
    res.json(order);
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
    const invoice = await generateInvoice(req.params.id, req.body, req.user);
    await insertAudit(req.user, "Invoice generated", { module: "Invoicing", newValue: invoice });
    res.status(201).json(invoice);
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
    dateOfOrder: row.date_of_order ? new Date(row.date_of_order).toISOString().slice(0, 10) : "",
    soNo: row.so_no || "",
    goldValue: number(row.gold_value),
    silverValue: number(row.silver_value),
    platinumValue: number(row.platinum_value),
    status: row.status || "Draft",
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
    castingQty: number(row.casting_qty),
    castingWeight: number(row.casting_weight),
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
    generatedAt: row.generated_at || "",
    createdBy: row.created_by || ""
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
      String(input.dateOfOrder || "").trim() || null,
      String(input.soNo || "").trim(),
      nullableNumber(input.goldValue),
      nullableNumber(input.silverValue),
      nullableNumber(input.platinumValue),
      String(input.status || "Draft").trim() || "Draft",
      user.id
    ];
    const orderResult = await client.query(
      input.id
        ? `update invoice_orders set company_id=$1, wax_shipment_inv_no=$2, date_of_order=$3, so_no=$4, gold_value=$5,
           silver_value=$6, platinum_value=$7, status=$8, created_by=$9, updated_at=now()
           where id=$10 returning *`
        : `insert into invoice_orders (company_id, wax_shipment_inv_no, date_of_order, so_no, gold_value, silver_value, platinum_value, status, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
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
          total_value, casting_qty, casting_weight, notes, image_url
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
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
          nullableNumber(row.castingQty),
          nullableNumber(row.castingWeight),
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
