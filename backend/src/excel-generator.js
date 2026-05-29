const fs = require("fs/promises");
const path = require("path");
const ExcelJS = require("exceljs");
const JSZip = require("jszip");

const KT_TO_METAL_TYPE = {
  SILV: "SILVER - 925",
  SILVER: "SILVER - 925",
  PLAT: "PLATINUM"
};

const METAL_PARAMS = {
  "9KT": { purity: 0.375, pgDiv: 0.995, metal: "GOLD", spot: "gold" },
  "10KT": { purity: 0.4166, pgDiv: 0.995, metal: "GOLD", spot: "gold" },
  "14KT": { purity: 0.5833, pgDiv: 0.995, metal: "GOLD", spot: "gold" },
  "18KT": { purity: 0.75, pgDiv: 0.995, metal: "GOLD", spot: "gold" },
  "22KT": { purity: 0.9166, pgDiv: 0.995, metal: "GOLD", spot: "gold" },
  "24KT": { purity: 1, pgDiv: 0.995, metal: "GOLD", spot: "gold" },
  PLATINUM: { purity: 0.95, pgDiv: 1, metal: "PLATINUM", spot: "plat" },
  "SILVER - 925": { purity: 0.925, pgDiv: 1, metal: "SILVER", spot: "silv" }
};

const METAL_ROWS = [
  { kt: "14KT", row: 14 },
  { kt: "18KT", row: 15 },
  { kt: "10KT", row: 16 },
  { kt: "SILVER - 925", row: 17 },
  { kt: "PLATINUM", row: 18 }
];

function normalizeMetalType(kt) {
  if (!kt) return "";
  const upper = String(kt).trim().toUpperCase();
  return KT_TO_METAL_TYPE[upper] || upper;
}

function getRowMetalGroup(kt) {
  const normalized = normalizeMetalType(kt);
  return METAL_PARAMS[normalized]?.metal || "UNKNOWN";
}

function getMetalParams(metalType) {
  return METAL_PARAMS[String(metalType || "").toUpperCase()] || { purity: 1, pgDiv: 1, metal: "GOLD", spot: "gold" };
}

function metalRatePerGram(metalType, goldSpot, platSpot, silvSpot) {
  const p = getMetalParams(metalType);
  const spot = p.metal === "PLATINUM" ? platSpot : p.metal === "SILVER" ? silvSpot : goldSpot;
  return (spot / 31.1035) * p.purity;
}

function getDescription(metalType) {
  const p = getMetalParams(metalType);
  if (p.metal === "PLATINUM") return "950 PLATINUM CASTING";
  if (p.metal === "SILVER") return "STERLING SILVER CASTING";
  return `${String(metalType || "").toUpperCase()} GOLD CASTING`;
}

function escXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cellRe(addr) {
  return new RegExp(`<c r="${escRe(addr)}"([^>]*?)(?:/>|>[\\s\\S]*?</c>)`);
}

function styleOf(attrs) {
  return (attrs.match(/ s="[^"]*"/) || [""])[0];
}

function replaceCell(xml, addr, newInnerXml, typeAttr) {
  return xml.replace(cellRe(addr), (_, attrs) => {
    const style = styleOf(attrs);
    const tPart = typeAttr ? ` t="${typeAttr}"` : "";
    return `<c r="${addr}"${style}${tPart}>${newInnerXml}</c>`;
  });
}

function setNum(xml, addr, value) {
  const safeValue = Number.isFinite(Number(value)) ? Number(value) : 0;
  return xml.replace(cellRe(addr), (match, attrs) => {
    const style = styleOf(attrs);
    const fMatch = match.match(/<f>[\s\S]*?<\/f>/);
    const fPart = fMatch ? fMatch[0] : "";
    return `<c r="${addr}"${style}>${fPart}<v>${safeValue}</v></c>`;
  });
}

function setStr(xml, addr, value) {
  if (value === null || value === undefined || value === "") return xml;
  return replaceCell(xml, addr, `<is><t>${escXml(value)}</t></is>`, "inlineStr");
}

function clearCell(xml, addr) {
  return xml.replace(cellRe(addr), (_, attrs) => `<c r="${addr}"${styleOf(attrs)}/>`);
}

function hideRow(xml, rowNum) {
  return xml.replace(new RegExp(`<row r="${rowNum}"([^>]*?)>`), (_, attrs) => `<row r="${rowNum}"${attrs} hidden="1">`);
}

function setCached(xml, addr, value) {
  const ae = escRe(addr);
  const isNum = typeof value === "number";
  const fPat = `(?:<f(?![^>]*\\/>)[^>]*>[\\s\\S]*?</f>|<f[^>]*\\/>)`;
  return xml.replace(new RegExp(`<c r="${ae}"([^>]*?)>(${fPat})<v[^>]*/?>(?:[^<]*</v>)?`), (_, attrs, formulaPart) => {
    if (isNum) {
      const cleanAttrs = attrs.replace(/ t="[^"]*"/, "");
      return `<c r="${addr}"${cleanAttrs}>${formulaPart}<v>${value}</v>`;
    }
    return `<c r="${addr}"${attrs}>${formulaPart}<v>${escXml(String(value))}</v>`;
  });
}

function extractRowXml(sheetXml, rowNum) {
  const match = sheetXml.match(new RegExp(`<row r="${rowNum}"[^>]*>[\\s\\S]*?<\\/row>`));
  return match ? match[0] : null;
}

function extractSharedFormulas(sheetXml) {
  const map = {};
  const re = /<f\b([^>]*?)>([\s\S]*?)<\/f>/g;
  let match;
  while ((match = re.exec(sheetXml)) !== null) {
    const attrs = match[1];
    const formula = match[2];
    const siMatch = attrs.match(/\bsi="(\d+)"/);
    const refMatch = attrs.match(/\bref="([^"]+)"/);
    if (siMatch && refMatch) {
      const masterRow = Number.parseInt(refMatch[1].match(/\d+/)[0], 10);
      map[siMatch[1]] = { formula, masterRow };
    }
  }
  return map;
}

function adjustFormulaRefs(formula, offset) {
  return String(formula).replace(/(\$?[A-Z]+)(\$?)(\d+)/g, (match, col, dollar, num) => {
    if (dollar === "$") return match;
    return `${col}${Number.parseInt(num, 10) + offset}`;
  });
}

function cloneDataRow(rowXml, fromRow, toRow, sharedFormulas = {}) {
  if (!rowXml) return "";
  let xml = rowXml.replace(`r="${fromRow}"`, `r="${toRow}"`);
  xml = xml.replace(new RegExp(`(<c r="[A-Z]+)${fromRow}(")`, "g"), `$1${toRow}$2`);
  xml = xml.replace(/(<f(?![^>]*\/>)[^>]*>)([\s\S]*?)(<\/f>)/g, (match, open, formula, close) => {
    return `${open}${adjustFormulaRefs(formula, toRow - fromRow)}${close}`;
  });
  xml = xml.replace(/<f\b([^>]*?)\/>/g, (match, attrs) => {
    const siMatch = attrs.match(/\bsi="(\d+)"/);
    if (!siMatch || !/\bt="shared"/.test(attrs)) return match;
    const sf = sharedFormulas[siMatch[1]];
    return sf ? `<f>${adjustFormulaRefs(sf.formula, toRow - sf.masterRow)}</f>` : "<f></f>";
  });
  return xml;
}

function shiftRowsDown(sheetXml, startRow, shiftBy) {
  if (shiftBy <= 0) return sheetXml;
  let result = sheetXml;
  result = result.replace(/<row r="(\d+)"/g, (match, num) => {
    const n = Number.parseInt(num, 10);
    return n >= startRow ? `<row r="${n + shiftBy}"` : match;
  });
  result = result.replace(/(<c r="[A-Z]+)(\d+)(")/g, (match, pre, num, post) => {
    const n = Number.parseInt(num, 10);
    return n >= startRow ? `${pre}${n + shiftBy}${post}` : match;
  });
  result = result.replace(/(<f(?![^>]*\/>)[^>]*>)([\s\S]*?)(<\/f>)/g, (match, open, formula, close) => {
    const shiftRef = (text) =>
      text.replace(/([A-Z]+)(\d+)/g, (ref, col, num) => {
        const n = Number.parseInt(num, 10);
        return n >= startRow ? `${col}${n + shiftBy}` : ref;
      });
    return `${shiftRef(open)}${shiftRef(formula)}${close}`;
  });
  result = result.replace(/(<mergeCell ref="[A-Z]+)(\d+)(:[A-Z]+)(\d+)(")/g, (match, pre, r1, mid, r2, post) => {
    const n1 = Number.parseInt(r1, 10);
    const n2 = Number.parseInt(r2, 10);
    return `${pre}${n1 >= startRow ? n1 + shiftBy : n1}${mid}${n2 >= startRow ? n2 + shiftBy : n2}${post}`;
  });
  return result;
}

function fmtDateMDY(isoDate) {
  const [y, m, d] = String(isoDate || new Date().toISOString().slice(0, 10)).split("-");
  return `${m}-${d}-${y}`;
}

function toExcelDate(isoDate) {
  const [y, m, d] = String(isoDate || new Date().toISOString().slice(0, 10)).split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const epoch = Date.UTC(1899, 11, 30);
  return Math.round((ms - epoch) / 86400000);
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function templatePath(name) {
  return path.resolve(__dirname, "..", "templates", name);
}

async function finalizeWorkbook(zip) {
  const ctFile = zip.file("[Content_Types].xml");
  if (ctFile) {
    let ct = await ctFile.async("string");
    ct = ct.replace(/<Override PartName="\/xl\/calcChain\.xml"[^>]*\/>/g, "");
    zip.file("[Content_Types].xml", ct);
  }
  const relsFile = zip.file("xl/_rels/workbook.xml.rels");
  if (relsFile) {
    let wbRels = await relsFile.async("string");
    wbRels = wbRels.replace(/<Relationship[^>]*calcChain[^>]*\/>/g, "");
    zip.file("xl/_rels/workbook.xml.rels", wbRels);
  }
  zip.remove("xl/calcChain.xml");
  const wbFile = zip.file("xl/workbook.xml");
  if (wbFile) {
    let wb = await wbFile.async("string");
    wb = wb.replace(/<calcPr\b([^/]*)\/>/, (_, attrs) => `<calcPr${attrs} fullCalcOnLoad="1"/>`);
    zip.file("xl/workbook.xml", wb);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

function rowValue(row, camel, snake, fallback = "") {
  return row[camel] ?? row[snake] ?? fallback;
}

function colToNum(col) {
  return String(col || "").split("").reduce((num, char) => num * 26 + char.charCodeAt(0) - 64, 0);
}

function numToCol(num) {
  let col = "";
  let current = Number(num);
  while (current > 0) {
    col = String.fromCharCode(((current - 1) % 26) + 65) + col;
    current = Math.floor((current - 1) / 26);
  }
  return col;
}

function appendCellsToRow(sheetXml, rowNum, cellsXml) {
  const re = new RegExp(`(<row r="${rowNum}"[^>]*>[\\s\\S]*?)(</row>)`);
  return sheetXml.replace(re, `$1${cellsXml}$2`);
}

function makeStrCell(addr, value) {
  return `<c r="${addr}" t="inlineStr"><is><t>${escXml(value)}</t></is></c>`;
}

function makeNumCell(addr, value) {
  return `<c r="${addr}"><v>${Number(value) || 0}</v></c>`;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (_error) {
    return false;
  }
}

function copyCellVal(worksheet, col, row) {
  const cell = worksheet.getCell(row + 1, col + 1);
  if (!cell) return null;
  const value = cell.value;
  if (value && typeof value === "object") {
    if (value.result !== undefined) return value.result;
    if (value.text !== undefined) return value.text;
    if (value.richText) return value.richText.map((part) => part.text || "").join("");
  }
  return value;
}

function copyNorm(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function findCopyCellContaining(worksheet, keyword, maxRow = 30) {
  const needle = keyword.toLowerCase();
  for (let row = 0; row <= Math.min(worksheet.rowCount - 1, maxRow); row += 1) {
    for (let col = 0; col <= Math.min(worksheet.columnCount - 1, 24); col += 1) {
      const value = copyCellVal(worksheet, col, row);
      if (value !== null && value !== undefined && copyNorm(value).includes(needle)) return { row, col };
    }
  }
  return null;
}

function isCopyOrderSheet(worksheet) {
  return Boolean(worksheet && findCopyCellContaining(worksheet, "customer name:", 20) && findCopyCellContaining(worksheet, "sr no", 20));
}

async function findSheetXmlPath(zip, sheetName) {
  const workbookFile = zip.file("xl/workbook.xml");
  const relsFile = zip.file("xl/_rels/workbook.xml.rels");
  if (!workbookFile || !relsFile) return null;
  const workbookXml = await workbookFile.async("string");
  const sheetTagMatch = workbookXml.match(new RegExp(`<sheet\\b[^>]*name="${escRe(sheetName)}"[^>]*>`));
  if (!sheetTagMatch) return null;
  const rIdMatch = sheetTagMatch[0].match(/\br:id="([^"]+)"/);
  if (!rIdMatch) return null;
  const relsXml = await relsFile.async("string");
  const relMatch = relsXml.match(new RegExp(`<Relationship[^>]*Id="${escRe(rIdMatch[1])}"[^>]*Target="([^"]+)"`));
  return relMatch ? `xl/${relMatch[1]}` : null;
}

async function generateInvoiceWorkbook({ order, company, rows, invoiceNo, invoiceDate, laborRate, goldSpot, platinumSpot, silverSpot }) {
  const zip = await JSZip.loadAsync(await fs.readFile(templatePath("blank_format.xlsx")));
  let sheet = await zip.file("xl/worksheets/sheet2.xml").async("string");

  sheet = setStr(sheet, "G9", invoiceNo);
  sheet = setStr(sheet, "G10", fmtDateMDY(invoiceDate));
  sheet = setNum(sheet, "O11", laborRate);
  sheet = setNum(sheet, "O12", goldSpot);
  sheet = setNum(sheet, "O13", platinumSpot);
  sheet = setNum(sheet, "O14", silverSpot);

  const templateRows = 55;
  const extraRows = Math.max(0, rows.length - templateRows);
  if (extraRows > 0) {
    const sharedFormulas = extractSharedFormulas(sheet);
    const templateRow = extractRowXml(sheet, 72);
    const lastDataRow = 17 + rows.length;
    sheet = shiftRowsDown(sheet, 73, extraRows);
    sheet = sheet.replace(/\bSUM\(([A-Z]+18:[A-Z]+)72\)/g, `SUM($1${lastDataRow})`);
    sheet = sheet.replace(/(<dataValidation[^>]*sqref=")J18:J72(")/g, `$1J18:J${lastDataRow}$2`);
    const totalsRowTag = `<row r="${73 + extraRows}"`;
    let newRowsXml = "";
    for (let extra = 0; extra < extraRows; extra++) {
      newRowsXml += cloneDataRow(templateRow, 72, 73 + extra, sharedFormulas);
    }
    sheet = sheet.replace(totalsRowTag, newRowsXml + totalsRowTag);
    sheet = sheet.replace(/<dimension ref="A1:S\d+"/, `<dimension ref="A1:S${124 + extraRows}"`);
  }

  rows.forEach((row, index) => {
    const r = 18 + index;
    const mt = normalizeMetalType(rowValue(row, "kt", "kt"));
    const wt = Number(rowValue(row, "castingWeight", "casting_weight", rowValue(row, "totalWt", "total_wt", 0))) || 0;
    const qty = Number(rowValue(row, "orderQty", "order_qty", 0)) || 0;
    const rpg = metalRatePerGram(mt, goldSpot, platinumSpot, silverSpot);
    const p = getMetalParams(mt);
    const wtPg = p.pgDiv > 0 ? round2((wt * p.purity) / p.pgDiv) : 0;
    const mval = round2(wt * rpg);
    const lval = round2(wt * laborRate);
    const total = round2(mval + lval);
    const ppg = wt > 0 ? round2(total / wt) : 0;
    const ppu = qty > 0 ? round2(total / qty) : 0;

    sheet = setNum(sheet, `B${r}`, index + 1);
    sheet = setStr(sheet, `D${r}`, rowValue(row, "vpoPoNo", "vpo_po_no"));
    sheet = setStr(sheet, `E${r}`, company.name);
    sheet = setStr(sheet, `F${r}`, rowValue(row, "sku", "sku"));
    sheet = setStr(sheet, `G${r}`, rowValue(row, "customerSku", "customer_sku"));
    sheet = setStr(sheet, `H${r}`, rowValue(row, "productCategory", "product_category"));
    sheet = setStr(sheet, `J${r}`, mt);
    sheet = setNum(sheet, `K${r}`, qty);
    sheet = setNum(sheet, `L${r}`, wt);
    sheet = setStr(sheet, `S${r}`, rowValue(row, "notes", "notes"));
    sheet = setCached(sheet, `I${r}`, getDescription(mt));
    sheet = setCached(sheet, `M${r}`, wtPg);
    sheet = setCached(sheet, `N${r}`, mval);
    sheet = setCached(sheet, `O${r}`, lval);
    sheet = setCached(sheet, `P${r}`, total);
    sheet = setCached(sheet, `Q${r}`, ppg);
    sheet = setCached(sheet, `R${r}`, ppu);
  });

  zip.file("xl/worksheets/sheet2.xml", sheet);
  return finalizeWorkbook(zip);
}

async function generateShippingWorkbook({ order, company, rows, invoiceNo, invoiceDate, laborRate, goldSpot, platinumSpot, silverSpot }) {
  const zip = await JSZip.loadAsync(await fs.readFile(templatePath("shipping_format.xlsx")));
  let sheet = await zip.file("xl/worksheets/sheet1.xml").async("string");

  sheet = setStr(sheet, "H4", company.name);
  sheet = setStr(sheet, "D7", invoiceNo);
  sheet = setNum(sheet, "D8", toExcelDate(invoiceDate));
  sheet = setNum(sheet, "N8", laborRate);
  sheet = setNum(sheet, "Q8", goldSpot);
  sheet = setNum(sheet, "Q9", platinumSpot);
  sheet = setNum(sheet, "Q10", silverSpot);

  const groups = {};
  for (const row of rows) {
    const kt = normalizeMetalType(rowValue(row, "kt", "kt"));
    if (!groups[kt]) groups[kt] = { qty: 0, wt: 0 };
    groups[kt].qty += Number(rowValue(row, "orderQty", "order_qty", 0)) || 0;
    groups[kt].wt += Number(rowValue(row, "castingWeight", "casting_weight", rowValue(row, "totalWt", "total_wt", 0))) || 0;
  }

  let lineNo = 0;
  for (const { kt, row: r } of METAL_ROWS) {
    const group = groups[kt];
    if (!group || group.wt === 0) {
      for (const col of ["E", "J", "K", "L", "M", "N", "O", "P", "Q"]) sheet = clearCell(sheet, `${col}${r}`);
      sheet = hideRow(sheet, r);
      continue;
    }
    lineNo++;
    const p = METAL_PARAMS[kt] || { purity: 1, pgDiv: 1, spot: "gold" };
    const spot = p.spot === "plat" ? platinumSpot : p.spot === "silv" ? silverSpot : goldSpot;
    const rpg = (spot / 31.1035) * p.purity;
    const mval = round2(group.wt * rpg);
    const lval = round2(group.wt * laborRate);
    const total = round2(mval + lval);
    const wtPg = group.wt > 0 ? round2((group.wt * p.purity) / p.pgDiv) : 0;
    const ppg = group.wt > 0 ? round2(total / group.wt) : 0;
    const ppu = group.qty > 0 ? round2(total / group.qty) : 0;

    sheet = setNum(sheet, `A${r}`, lineNo);
    sheet = setStr(sheet, `B${r}`, order.waxShipmentInvNo || order.wax_shipment_inv_no || "");
    sheet = setStr(sheet, `D${r}`, company.name);
    sheet = setNum(sheet, `J${r}`, group.qty);
    sheet = setNum(sheet, `K${r}`, group.wt);
    sheet = setNum(sheet, `L${r}`, wtPg);
    sheet = setNum(sheet, `M${r}`, mval);
    sheet = setNum(sheet, `N${r}`, lval);
    sheet = setNum(sheet, `O${r}`, total);
    sheet = setNum(sheet, `P${r}`, ppg);
    sheet = setNum(sheet, `Q${r}`, ppu);
  }

  zip.file("xl/worksheets/sheet1.xml", sheet);
  return finalizeWorkbook(zip);
}

async function generateOrderCopyWorkbook({ order, company, rows, sourceFilePath }) {
  if (!sourceFilePath || !(await fileExists(sourceFilePath))) {
    return generateOrderCopyFallbackWorkbook({ order, company, rows });
  }

  const originalBuffer = await fs.readFile(sourceFilePath);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(originalBuffer);
  } catch (_error) {
    return generateOrderCopyFallbackWorkbook({ order, company, rows });
  }

  const worksheet = workbook.worksheets.find((sheet) => isCopyOrderSheet(sheet));
  if (!worksheet) return generateOrderCopyFallbackWorkbook({ order, company, rows });

  const srNoCell = findCopyCellContaining(worksheet, "sr no", 30);
  if (!srNoCell) return generateOrderCopyFallbackWorkbook({ order, company, rows });

  const headerExcelRow = srNoCell.row + 1;
  const srNoToExcelRow = {};
  for (let row = srNoCell.row + 1; row <= worksheet.rowCount - 1; row += 1) {
    const value = copyCellVal(worksheet, srNoCell.col, row);
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (!text || text.toLowerCase() === "total") continue;
    const srNo = typeof value === "number" ? value : Number.parseInt(value, 10);
    if (Number.isFinite(srNo)) srNoToExcelRow[srNo] = row + 1;
  }

  const zip = await JSZip.loadAsync(originalBuffer);
  const sheetXmlPath = await findSheetXmlPath(zip, worksheet.name);
  if (!sheetXmlPath || !zip.file(sheetXmlPath)) return generateOrderCopyFallbackWorkbook({ order, company, rows });

  let sheetXml = await zip.file(sheetXmlPath).async("string");
  const dimensionMatch = sheetXml.match(/<dimension ref="[A-Z\d]+:([A-Z]+)\d+"/);
  const lastColNum = dimensionMatch ? colToNum(dimensionMatch[1]) : Math.max(worksheet.columnCount, 1);
  const castingWeightCol = numToCol(lastColNum + 1);
  const castingQtyCol = numToCol(lastColNum + 2);

  sheetXml = appendCellsToRow(
    sheetXml,
    headerExcelRow,
    makeStrCell(`${castingWeightCol}${headerExcelRow}`, "Casting Wt.") +
      makeStrCell(`${castingQtyCol}${headerExcelRow}`, "Casting Qty.")
  );

  const dbRowBySrNo = {};
  for (const row of rows) {
    const srNo = Number(rowValue(row, "srNo", "sr_no"));
    if (Number.isFinite(srNo)) dbRowBySrNo[srNo] = row;
  }

  for (const [srNoString, excelRow] of Object.entries(srNoToExcelRow)) {
    const dbRow = dbRowBySrNo[Number(srNoString)];
    if (!dbRow) continue;
    let cells = "";
    const castingWeight = rowValue(dbRow, "castingWeight", "casting_weight", null);
    const castingQty = rowValue(dbRow, "castingQty", "casting_qty", null);
    if (castingWeight !== null && castingWeight !== undefined && castingWeight !== "") {
      cells += makeNumCell(`${castingWeightCol}${excelRow}`, castingWeight);
    }
    if (castingQty !== null && castingQty !== undefined && castingQty !== "") {
      cells += makeNumCell(`${castingQtyCol}${excelRow}`, castingQty);
    }
    if (cells) sheetXml = appendCellsToRow(sheetXml, excelRow, cells);
  }

  sheetXml = sheetXml.replace(/(<dimension ref="[A-Z\d]+:)[A-Z]+(\d+")/, `$1${castingQtyCol}$2`);
  zip.file(sheetXmlPath, sheetXml);
  return finalizeWorkbook(zip);
}

async function generateOrderCopyFallbackWorkbook({ order, company, rows }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Casting Production Management";
  workbook.created = new Date();
  const worksheet = workbook.addWorksheet("Order Copy");
  worksheet.columns = [
    { header: "Order No", key: "orderNo", width: 18 },
    { header: "Company", key: "company", width: 28 },
    { header: "SO No", key: "soNo", width: 18 },
    { header: "Sr No", key: "srNo", width: 10 },
    { header: "Tree No", key: "treeNo", width: 14 },
    { header: "VPO / PO No", key: "vpoPoNo", width: 18 },
    { header: "SKU", key: "sku", width: 20 },
    { header: "Customer SKU", key: "customerSku", width: 22 },
    { header: "KT", key: "kt", width: 12 },
    { header: "Color", key: "color", width: 14 },
    { header: "Order Qty", key: "orderQty", width: 12 },
    { header: "Wax Weight", key: "waxWeight", width: 14 },
    { header: "Total Wt", key: "totalWt", width: 12 },
    { header: "Casting Wt.", key: "castingWeight", width: 14 },
    { header: "Casting Qty.", key: "castingQty", width: 14 },
    { header: "Labor Charge", key: "laborCharge", width: 14 },
    { header: "Setting Charge", key: "settingCharge", width: 15 },
    { header: "Stone Charge", key: "stoneCharge", width: 14 },
    { header: "Extra Charge", key: "extraCharge", width: 14 },
    { header: "Notes", key: "notes", width: 30 }
  ];
  rows.forEach((row) => {
    worksheet.addRow({
      orderNo: order.waxShipmentInvNo || order.wax_shipment_inv_no || "",
      company: company.name || "",
      soNo: order.soNo || order.so_no || "",
      srNo: rowValue(row, "srNo", "sr_no"),
      treeNo: rowValue(row, "treeNo", "tree_no"),
      vpoPoNo: rowValue(row, "vpoPoNo", "vpo_po_no"),
      sku: rowValue(row, "sku", "sku"),
      customerSku: rowValue(row, "customerSku", "customer_sku"),
      kt: rowValue(row, "kt", "kt"),
      color: rowValue(row, "color", "color"),
      orderQty: rowValue(row, "orderQty", "order_qty"),
      waxWeight: rowValue(row, "waxWeight", "wax_weight"),
      totalWt: rowValue(row, "totalWt", "total_wt"),
      castingWeight: rowValue(row, "castingWeight", "casting_weight"),
      castingQty: rowValue(row, "castingQty", "casting_qty"),
      laborCharge: rowValue(row, "laborCharge", "labor_charge"),
      settingCharge: rowValue(row, "settingCharge", "setting_charge"),
      stoneCharge: rowValue(row, "stoneCharge", "stone_charge"),
      extraCharge: rowValue(row, "extraCharge", "extra_charge"),
      notes: rowValue(row, "notes", "notes")
    });
  });
  worksheet.getRow(1).font = { bold: true };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function workbookFileName(prefix, invoiceNo, companyName) {
  const safeNo = String(invoiceNo || "invoice").replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeCompany = String(companyName || "company").replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${prefix}_${safeNo}_${safeCompany}.xlsx`;
}

module.exports = {
  generateInvoiceWorkbook,
  generateOrderCopyWorkbook,
  generateShippingWorkbook,
  getRowMetalGroup,
  workbookFileName
};
