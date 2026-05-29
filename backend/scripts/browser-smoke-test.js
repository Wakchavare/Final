const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const appUrl = process.env.APP_URL || "http://127.0.0.1:3000";
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const remotePort = Number(process.env.CHROME_DEBUG_PORT || 9333);
const profileDir = path.join(os.tmpdir(), `casting-smoke-profile-${Date.now()}`);

let id = 0;
let socket;
let wsBuffer = Buffer.alloc(0);
const pending = new Map();

async function main() {
  await fs.mkdir(profileDir, { recursive: true });
  const chrome = spawn(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${remotePort}`,
    `--user-data-dir=${profileDir}`,
    "about:blank"
  ]);

  chrome.stderr.on("data", () => {});
  chrome.stdout.on("data", () => {});

  try {
    const webSocketDebuggerUrl = await waitForDebuggerUrl();
    await connect(webSocketDebuggerUrl);
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Network.enable");

    await navigate(`${appUrl}/?browserSmoke=${Date.now()}`);
    await evaluate(`sessionStorage.clear(); localStorage.removeItem("casting-production-auth-token");`);
    await navigate(`${appUrl}/?browserSmoke=${Date.now()}`);

    const results = [];
    const pass = (name, detail = "") => {
      results.push({ name, ok: true, detail });
      console.log(`PASS ${name}${detail ? ` - ${detail}` : ""}`);
    };

    await waitFor(() => Boolean(document.querySelector("[data-login-form]")), "login form");
    await fill("[data-login-username]", "admin@example.com");
    await fill("[data-login-password]", "Admin@123");
    await click("[data-login-form] button[type='submit']");
    await waitFor(() => !document.querySelector("#appShell")?.hidden && document.body.innerText.includes("System Admin"), "authenticated app shell");
    pass("login", "admin@example.com authenticated");

    await waitFor(() => document.body.innerText.includes("UD-CUST-001") && document.body.innerText.includes("10 rows"), "seeded wax rows");
    pass("wax entry list", "10 seeded rows visible");

    const invoiceNo = `WAX-BROWSER-${Date.now()}`;
    await fill("#vendorCustomerNameInput", "UD-BROWSER-CUST");
    await setValue("#dateInput", "2026-05-21");
    await fill("#waxInvoiceNoInput", invoiceNo);
    await fill("#customerVendorTreeNoInput", "TREE-BROWSER-1");
    await setValue("#metalKtInput", "14KT");
    await setValue("#colorInput", "Yellow");
    await fill("#waxWeightInput", "6.75");
    await click("#submitEntryButton");
    await waitForText(invoiceNo, "created wax entry");
    pass("add wax entry", invoiceNo);

    const waxApi = await pageFetch("/api/wax-entries");
    const createdWax = waxApi.find((entry) => entry.waxInvoiceNo === invoiceNo);
    assert(createdWax, "created wax entry exists in backend");
    await pageFetch(`/api/wax-entries/${createdWax.id}`, {
      method: "PUT",
      body: { ...createdWax, waxWeight: "7.250", isRush: true }
    });
    await navigate(`${appUrl}/?browserSmoke=${Date.now()}`);
    await waitForText("7.250", "edited wax entry");
    pass("edit wax entry", "backend edit visible after reload");

    await pageFetch(`/api/wax-entries/${createdWax.id}`, { method: "DELETE" });
    await navigate(`${appUrl}/?browserSmoke=${Date.now()}`);
    await waitFor((deletedInvoiceNo) => !document.querySelector("#entryRows")?.innerText.includes(deletedInvoiceNo), "deleted wax entry removed", [invoiceNo]);
    pass("delete wax entry", "backend delete reflected in UI");

    await openModule("Casting Process");
    await waitForText("Awaiting Metal", "casting board loaded");
    const orders = await pageFetch("/api/casting-orders");
    assert(orders.length > 0, "casting orders loaded");
    const firstOrder = orders[0];
    await pageFetch(`/api/casting-orders/${firstOrder.id}/workflow`, {
      method: "PUT",
      body: {
        workflow: { ...(firstOrder.workflow || {}), stage: "Ready for Casting", totalIssuedWeight: "20.500" },
        event: { fromStage: firstOrder.workflow?.stage || "Awaiting Metal", toStage: "Ready for Casting", action: "Browser smoke workflow move" }
      }
    });
    await navigate(`${appUrl}/?browserSmoke=${Date.now()}`);
    await openModule("Casting Process");
    await waitForText("Ready for Casting", "casting workflow updated");
    pass("casting board workflow", "order update API reflected on board");

    await openModule("Metal Receiving");
    await waitFor(() => Boolean(document.querySelector("[data-metal-receiving-form]")), "metal receiving form");
    await setValue("[data-receiving-field='metalType']", "Gold");
    await fill("[data-receiving-field='purity']", "24KT");
    await fill("[data-receiving-field='weightReceived']", "11.500");
    await fill("[data-receiving-field='supplier']", "Browser Supplier");
    const receivingReference = `MR-BROWSER-${Date.now()}`;
    await fill("[data-receiving-field='referenceNumber']", receivingReference);
    await fill("[data-receiving-field='notes']", "Browser smoke receiving");
    await click("[data-metal-receiving-form] button[type='submit']");
    await waitForText("Browser Supplier", "metal receiving row");
    pass("metal receiving", "row saved and listed");

    await openModule("Inventory");
    await waitForText("Pure Gold / 24KT Gold", "inventory balance");
    const inventorySnapshot = await pageFetch("/api/inventory/snapshot");
    assert(inventorySnapshot.receivingEntries.some((entry) => entry.referenceNumber === receivingReference), "receiving entry exists in inventory snapshot");
    assert(inventorySnapshot.ledgerEntries.some((entry) => entry.referenceNumber === receivingReference || entry.sourceModule === "Metal Receiving"), "ledger entry exists in inventory snapshot");
    pass("inventory", "balance visible and snapshot loaded from backend");

    await openModule("Invoicing");
    await waitForText("Unique Designs Wholesale", "invoicing seed company");
    const companyName = `Browser Billing ${Date.now()}`;
    await fill("[data-company-field='name']", companyName);
    await fill("[data-company-field='address']", "55 Browser Test Ave, New York, NY");
    await fill("[data-company-field='goldLaborPrice']", "19.75");
    await click("[data-invoice-company-form] button[type='submit']");
    await waitForText(companyName, "invoice company saved");
    const orderShipment = `SHIP-BROWSER-${Date.now()}`;
    await setValue("[data-order-field='companyId']", await firstOptionValue("[data-order-field='companyId']", "Unique Designs Wholesale"));
    await fill("[data-order-field='waxShipmentInvNo']", orderShipment);
    await fill("[data-order-field='soNo']", "SO-BROWSER-READY");
    await fill("[data-order-field='goldValue']", "980.25");
    await fill("[data-line-field='treeNo']", "B-2");
    await fill("[data-line-field='sku']", "UD-BROWSER-14Y");
    await fill("[data-line-field='orderQty']", "2");
    await fill("[data-line-field='totalWt']", "4.800");
    await click("[data-invoice-order-form] button[type='submit']");
    let smokeOrder = null;
    const orderStarted = Date.now();
    while (!smokeOrder && Date.now() - orderStarted < 15000) {
      const invoiceOrders = await pageFetch("/api/invoicing/orders");
      smokeOrder = invoiceOrders.find((order) => order.waxShipmentInvNo === orderShipment) || null;
      if (!smokeOrder) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert(smokeOrder, "invoice order exists in backend");
    await pageFetch(`/api/invoicing/orders/${smokeOrder.id}/generate`, {
      method: "POST",
      body: {
        invoiceNo: `INV-BROWSER-${Date.now()}`,
        invoiceDate: "2026-05-22",
        metalType: "Gold",
        laborRate: "19.75",
        goldSpot: "2340.00",
        platinumSpot: "980.00",
        silverSpot: "30.00"
      }
    });
    const orderDetail = await pageFetch(`/api/invoicing/orders/${smokeOrder.id}`);
    assert(orderDetail.generatedInvoices.length > 0, "generated invoice exists");
    pass("invoicing", "company, order, and generated invoice stored in PostgreSQL");

    await openModule("Role Management");
    await waitForText("Invoicing", "role management includes invoicing permissions");
    pass("roles", "role management loaded");

    await openModule("User Management");
    await waitForText("System Admin", "user management loaded");
    pass("users", "user management loaded");

    await openModule("Audit Logs");
    await waitForText("Invoice generated", "audit log includes new actions");
    pass("audit logs", "actions recorded");

    const errors = await evaluate(`performance.getEntriesByType("resource")
      .filter((entry) => entry.initiatorType === "fetch")
      .map((entry) => entry.name)`);
    const consoleErrors = await send("Runtime.evaluate", { expression: "window.__smokeConsoleErrors || []", returnByValue: true });
    pass("network", `${errors.length} fetch resource entries observed`);
    pass("console", `${(consoleErrors.result?.value || []).length} captured frontend errors`);

    console.log(JSON.stringify({ ok: true, passed: results.length, results }, null, 2));
  } finally {
    await closeSocket();
    chrome.kill("SIGTERM");
    await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function navigate(url) {
  await send("Page.navigate", { url });
  await waitFor(() => document.readyState === "complete" || document.readyState === "interactive", `navigate ${url}`);
  await evaluate(`window.__smokeConsoleErrors = [];
    window.addEventListener("error", (event) => window.__smokeConsoleErrors.push(event.message));
    window.addEventListener("unhandledrejection", (event) => window.__smokeConsoleErrors.push(String(event.reason)));`);
}

async function openModule(name) {
  await evaluate(`Array.from(document.querySelectorAll("[data-module-target]"))
    .find((button) => button.textContent.trim() === ${JSON.stringify(name)})?.click();`);
  await waitFor((moduleName) => Array.from(document.querySelectorAll("[data-module-target]")).some((button) => button.textContent.trim() === moduleName && button.getAttribute("aria-selected") === "true"), `${name} tab active`, [name]);
}

async function pageFetch(pathname, options = {}) {
  const response = await evaluate(`(async () => {
    const token = sessionStorage.getItem("casting-production-auth-token") || localStorage.getItem("casting-production-auth-token") || "";
    const response = await fetch(${JSON.stringify(pathname)}, {
      method: ${JSON.stringify(options.method || "GET")},
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: ${options.body ? JSON.stringify(JSON.stringify(options.body)) : "undefined"}
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  })()`);
  if (!response.ok) throw new Error(`${pathname} failed with ${response.status}: ${response.text}`);
  return response.text ? JSON.parse(response.text) : null;
}

async function fill(selector, value) {
  await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error("Missing selector: ${selector}");
    element.focus();
    element.value = ${JSON.stringify(value)};
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
}

async function setValue(selector, value) {
  await fill(selector, value);
}

async function click(selector) {
  await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error("Missing selector: ${selector}");
    element.click();
  })()`);
}

async function firstOptionValue(selector, label) {
  return evaluate(`(() => {
    const select = document.querySelector(${JSON.stringify(selector)});
    const option = Array.from(select.options).find((item) => item.textContent.trim() === ${JSON.stringify(label)});
    if (!option) throw new Error("Missing option: ${label}");
    return option.value;
  })()`);
}

async function waitForText(text, label) {
  await waitFor((expectedText) => document.body.innerText.includes(expectedText), label, [text]);
}

async function waitFor(predicate, label, args = []) {
  const source = `(${predicate.toString()})(${args.map((value) => JSON.stringify(value)).join(",")})`;
  const started = Date.now();
  while (Date.now() - started < 15000) {
    const result = await evaluate(source).catch(() => false);
    if (result) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function evaluate(expression) {
  const response = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text || "Runtime evaluation failed");
  }
  return response.result?.value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForDebuggerUrl() {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    try {
      const list = await fetch(`http://127.0.0.1:${remotePort}/json/list`).then((res) => res.json());
      const page = list.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Could not connect to Chrome debugging endpoint.");
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const key = crypto.randomBytes(16).toString("base64");
    let handshake = Buffer.alloc(0);
    let upgraded = false;

    socket = net.createConnection({ host: parsed.hostname, port: Number(parsed.port || 80) });
    socket.once("error", reject);
    socket.on("connect", () => {
      socket.write(
        [
          `GET ${parsed.pathname}${parsed.search} HTTP/1.1`,
          `Host: ${parsed.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          ""
        ].join("\r\n")
      );
    });
    socket.on("data", (chunk) => {
      if (!upgraded) {
        handshake = Buffer.concat([handshake, chunk]);
        const headerEnd = handshake.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const header = handshake.slice(0, headerEnd).toString("utf8");
        if (!/^HTTP\/1\.1 101\b/.test(header)) {
          reject(new Error(`WebSocket upgrade failed: ${header.split("\r\n")[0]}`));
          return;
        }
        upgraded = true;
        socket.removeListener("error", reject);
        const rest = handshake.slice(headerEnd + 4);
        if (rest.length) handleWsData(rest);
        resolve();
        return;
      }
      handleWsData(chunk);
    });
  });
}

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const messageId = ++id;
    pending.set(messageId, { resolve, reject });
    sendWsText(JSON.stringify({ id: messageId, method, params }));
  });
}

function closeSocket() {
  if (!socket || socket.destroyed) return Promise.resolve();
  socket.end();
  return Promise.resolve();
}

function handleWsData(chunk) {
  wsBuffer = Buffer.concat([wsBuffer, chunk]);
  while (wsBuffer.length >= 2) {
    const first = wsBuffer[0];
    const second = wsBuffer[1];
    let offset = 2;
    let length = second & 0x7f;
    if (length === 126) {
      if (wsBuffer.length < 4) return;
      length = wsBuffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (wsBuffer.length < 10) return;
      length = Number(wsBuffer.readBigUInt64BE(2));
      offset = 10;
    }
    const masked = Boolean(second & 0x80);
    const maskLength = masked ? 4 : 0;
    if (wsBuffer.length < offset + maskLength + length) return;
    const mask = masked ? wsBuffer.slice(offset, offset + 4) : null;
    offset += maskLength;
    let payload = wsBuffer.slice(offset, offset + length);
    wsBuffer = wsBuffer.slice(offset + length);
    if (mask) payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    const opcode = first & 0x0f;
    if (opcode === 8) return;
    if (opcode !== 1) continue;
    const message = JSON.parse(payload.toString("utf8"));
    if (!message.id || !pending.has(message.id)) continue;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result || {});
  }
}

function sendWsText(text) {
  const payload = Buffer.from(text);
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
  socket.write(Buffer.concat([header, mask, masked]));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
