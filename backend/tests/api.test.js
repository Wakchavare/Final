process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { app, pool } = require("../src/server");
const { resetDb } = require("../src/reset-db");

test("API supports the production workflow", async () => {
  await resetDb();

  const health = await request(app).get("/api/health").expect(200);
  assert.equal(health.body.database, "connected");

  const login = await request(app)
    .post("/api/auth/login")
    .send({ email: "admin@example.com", password: "Admin@123" })
    .expect(200);
  assert.ok(login.body.token);
  assert.equal(login.body.user.email, "admin@example.com");
  const token = login.body.token;

  const waxEntries = await request(app).get("/api/wax-entries").set("Authorization", `Bearer ${token}`).expect(200);
  assert.equal(waxEntries.body.length, 10);
  assert.equal(waxEntries.body.some((entry) => entry.waxInvoiceNo === "WAX-1001"), true);
  const seededWaxEntryId = waxEntries.body[0].id;

  const created = await request(app)
    .post("/api/wax-entries")
    .set("Authorization", `Bearer ${token}`)
    .send({
      vendorCustomerName: "UD-CUST-011",
      date: "2026-05-11",
      waxInvoiceNo: "WAX-1011",
      customerVendorTreeNo: "TREE-A11",
      metalKt: "18KT",
      color: "Yellow",
      waxWeight: "9.25",
      isRush: false,
      isInHouseProduction: true
    })
    .expect(201);
  assert.ok(created.body.internalTreeNumber);
  assert.ok(created.body.barcodeValue);

  const edited = await request(app)
    .put(`/api/wax-entries/${created.body.id}`)
    .set("Authorization", `Bearer ${token}`)
    .send({ ...created.body, waxWeight: "9.75", isRush: true })
    .expect(200);
  assert.equal(edited.body.waxWeight, "9.750");
  assert.equal(edited.body.isRush, true);

  await request(app).delete(`/api/wax-entries/${created.body.id}`).set("Authorization", `Bearer ${token}`).expect(204);

  const workflow = await request(app)
    .put(`/api/casting-orders/${seededWaxEntryId}/workflow`)
    .set("Authorization", `Bearer ${token}`)
    .send({
      workflow: { stage: "Ready for Casting", totalIssuedWeight: "20.5" },
      event: { fromStage: "Awaiting Metal", toStage: "Ready for Casting", action: "Awaiting Metal submitted" }
    })
    .expect(200);
  assert.equal(workflow.body.workflow.stage, "Ready for Casting");

  await request(app).get("/api/roles").set("Authorization", `Bearer ${token}`).expect(200);
  await request(app).get("/api/users").set("Authorization", `Bearer ${token}`).expect(200);
  await request(app).get("/api/inventory/snapshot").set("Authorization", `Bearer ${token}`).expect(200);

  const invoiceSummary = await request(app).get("/api/invoicing/summary").set("Authorization", `Bearer ${token}`).expect(200);
  assert.equal(invoiceSummary.body.stats.companies >= 1, true);
  assert.equal(invoiceSummary.body.stats.orders >= 1, true);

  const fixturePath = path.join(__dirname, "fixtures", "batch-15-vpo-988-10k.xlsx");
  const uploadedOrder = await request(app)
    .post("/api/invoicing/orders/upload")
    .set("Authorization", `Bearer ${token}`)
    .send({
      fileName: "Batch 15 Purchase Order VPO 988 - 10K .xlsx",
      fileBase64: fs.readFileSync(fixturePath).toString("base64")
    })
    .expect(201);
  assert.equal(uploadedOrder.body.companyName, "ShineBright USA, INC.");
  assert.equal(uploadedOrder.body.waxShipmentInvNo, "VPO-988");
  assert.equal(uploadedOrder.body.dateOfOrder, "2026-05-15");
  assert.equal(uploadedOrder.body.rows.length, 4);
  assert.equal(uploadedOrder.body.rows[0].customerSku, "WAXSBPR100Y10");
  assert.equal(uploadedOrder.body.rows[0].kt, "10KT");
  assert.equal(uploadedOrder.body.upload.fallbackWaxShipmentInvNo, true);

  await request(app)
    .post("/api/invoicing/orders/upload")
    .set("Authorization", `Bearer ${token}`)
    .send({
      fileName: "Batch 15 Purchase Order VPO 988 - 10K .xlsx",
      fileBase64: fs.readFileSync(fixturePath).toString("base64")
    })
    .expect(409);

  const invoiceCompany = await request(app)
    .post("/api/invoicing/companies")
    .set("Authorization", `Bearer ${token}`)
    .send({
      name: "Unique Designs Test Billing",
      address: "48 W 48th St, New York, NY",
      goldLaborPrice: "18.50",
      silverLaborPrice: "5.25",
      platinumLaborPrice: "24.00"
    })
    .expect(201);
  assert.equal(invoiceCompany.body.name, "Unique Designs Test Billing");

  const invoiceOrder = await request(app)
    .post("/api/invoicing/orders")
    .set("Authorization", `Bearer ${token}`)
    .send({
      companyId: invoiceCompany.body.id,
      waxShipmentInvNo: "SHIP-TEST-001",
      dateOfOrder: "2026-05-12",
      soNo: "SO-TEST-001",
      goldValue: "1250.00",
      status: "Draft",
      rows: [
        {
          treeNo: "A-TEST",
          vpoPoNo: "VPO-TEST",
          productCategory: "Ring",
          sku: "UD-TEST-14Y",
          customerSku: "CUST-TEST-14Y",
          waxQty: "3",
          orderQty: "3",
          kt: "14KT",
          color: "Yellow",
          netWtPc: "2.15",
          grossWtPc: "2.45",
          totalWt: "7.35",
          requiredMetalPg: "8.20",
          totalValue: "375.00",
          castingQty: "3",
          castingWeight: "7.10",
          notes: "API test invoice row"
        }
      ]
    })
    .expect(201);
  assert.equal(invoiceOrder.body.rows.length, 1);

  const invoiceOrderDetail = await request(app)
    .get(`/api/invoicing/orders/${invoiceOrder.body.id}`)
    .set("Authorization", `Bearer ${token}`)
    .expect(200);
  assert.equal(invoiceOrderDetail.body.rows[0].sku, "UD-TEST-14Y");

  const invoiceOrderRows = await request(app)
    .get(`/api/invoicing/orders/${invoiceOrder.body.id}/rows`)
    .set("Authorization", `Bearer ${token}`)
    .expect(200);
  assert.equal(invoiceOrderRows.body.length, 1);

  const generatedInvoice = await request(app)
    .post(`/api/invoicing/orders/${invoiceOrder.body.id}/generate-invoice`)
    .set("Authorization", `Bearer ${token}`)
    .send({
      invoiceNo: "INV-TEST-001",
      invoiceDate: "2026-05-13",
      metalType: "Gold",
      laborRate: "18.50",
      goldSpot: "2340.00",
      platinumSpot: "980.00",
      silverSpot: "30.00"
    })
    .expect(201);
  assert.equal(generatedInvoice.body.invoiceNo, "INV-TEST-001");
  assert.equal(generatedInvoice.body.fileType, "invoice");

  const downloadPayload = {
    invoiceNo: "INV-TEST-001",
    invoiceDate: "2026-05-13",
    laborRate: "18.50",
    goldSpot: "2340.00",
    platinumSpot: "980.00",
    silverSpot: "30.00"
  };
  const generatedShipping = await request(app)
    .post(`/api/invoicing/orders/${invoiceOrder.body.id}/generate-shipping`)
    .set("Authorization", `Bearer ${token}`)
    .send(downloadPayload)
    .expect(201);
  assert.equal(generatedShipping.body.fileType, "shipping");

  const generatedOrderCopy = await request(app)
    .post(`/api/invoicing/orders/${invoiceOrder.body.id}/generate-order-copy`)
    .set("Authorization", `Bearer ${token}`)
    .send({ invoiceNo: "COPY-TEST-001", invoiceDate: "2026-05-13" })
    .expect(201);
  assert.equal(generatedOrderCopy.body.fileType, "order_copy");

  const invoiceWorkbook = await request(app)
    .get(`/api/invoicing/orders/${invoiceOrder.body.id}/download-invoice`)
    .set("Authorization", `Bearer ${token}`)
    .buffer(true)
    .parse(binaryParser)
    .expect(200);
  assert.match(invoiceWorkbook.headers["content-type"], /spreadsheetml\.sheet/);
  assert.equal(invoiceWorkbook.body.slice(0, 2).toString(), "PK");

  const shippingWorkbook = await request(app)
    .get(`/api/invoicing/orders/${invoiceOrder.body.id}/download-shipping`)
    .set("Authorization", `Bearer ${token}`)
    .buffer(true)
    .parse(binaryParser)
    .expect(200);
  assert.match(shippingWorkbook.headers["content-type"], /spreadsheetml\.sheet/);
  assert.equal(shippingWorkbook.body.slice(0, 2).toString(), "PK");

  const orderCopyWorkbook = await request(app)
    .get(`/api/invoicing/orders/${invoiceOrder.body.id}/download-order-copy`)
    .set("Authorization", `Bearer ${token}`)
    .buffer(true)
    .parse(binaryParser)
    .expect(200);
  assert.match(orderCopyWorkbook.headers["content-type"], /spreadsheetml\.sheet/);
  assert.equal(orderCopyWorkbook.body.slice(0, 2).toString(), "PK");

  const search = await request(app).get("/api/invoicing/search?q=UD-TEST").set("Authorization", `Bearer ${token}`).expect(200);
  assert.equal(search.body.rows.length >= 1, true);

  await request(app).get("/api/audit-logs").set("Authorization", `Bearer ${token}`).expect(200);
});

test.after(async () => {
  await pool.end();
});

function binaryParser(res, callback) {
  const chunks = [];
  res.on("data", (chunk) => chunks.push(chunk));
  res.on("end", () => callback(null, Buffer.concat(chunks)));
}
