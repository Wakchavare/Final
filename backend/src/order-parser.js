const path = require("node:path");
const ExcelJS = require("exceljs");

const COLUMN_KEYWORDS = {
  srNo: ["sr no", "sr."],
  waxShipmentInvNo: ["wax shipment", "wax inv"],
  treeNo: ["tree no", "tree no."],
  vpoPoNo: ["vpo", "po no"],
  productCategory: ["product cat", "category"],
  sku: ["sku"],
  customerSku: ["customer sku", "cust sku"],
  waxQty: ["wax qty"],
  orderQty: ["order qty"],
  kt: ["kt"],
  color: ["color", "colour"],
  netWtPc: ["net wt", "net wt/pc"],
  grossWtPc: ["gross wt"],
  totalWt: ["total wt"],
  requiredMetalPg: ["required metal", "metal pg"],
  totalValue: ["total value"],
  waxWeight: ["wax weight", "wax wt"],
  castingQty: ["casting qty"],
  castingWeight: ["casting weight", "casting wt"],
  laborCharge: ["labor", "labour"],
  settingCharge: ["setting"],
  stoneCharge: ["stone"],
  extraCharge: ["extra charge", "extra"]
};

async function parseInvoiceOrderWorkbook(buffer, fileName = "invoice-order.xlsx") {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw Object.assign(new Error("Uploaded workbook is empty."), { status: 400 });
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch (error) {
    throw Object.assign(new Error(`Could not parse uploaded .xlsx workbook: ${error.message}`), { status: 400 });
  }
  const worksheet = workbook.worksheets.find((sheet) => isOrderSheet(sheet));
  if (!worksheet) {
    throw Object.assign(
      new Error(`No valid order sheet found. Expected "Customer Name:" and "Sr No." headers in the first 20 rows.`),
      { status: 400 }
    );
  }

  const customerNameCell = findCellContaining(worksheet, "customer name:", 20);
  if (!customerNameCell) {
    throw Object.assign(new Error('Could not find "Customer Name:" in the uploaded workbook.'), { status: 400 });
  }

  const metaRow = customerNameCell.row;
  const companyName = extractCompanyName(worksheet, customerNameCell);
  if (!companyName) {
    throw Object.assign(new Error("Could not extract customer/company name from the uploaded workbook."), { status: 400 });
  }

  const getMetaValue = (row) => {
    const canonical = getCellVal(worksheet, 12, row);
    if (hasValue(canonical)) return canonical;
    for (let col = 8; col <= 14; col += 1) {
      const value = getCellVal(worksheet, col, row);
      if (hasValue(value) && !looksLikeLabel(value)) return value;
    }
    return null;
  };

  const srNoCell = findCellContaining(worksheet, "sr no", 30);
  if (!srNoCell) {
    throw Object.assign(new Error('Could not find the "Sr No." header row.'), { status: 400 });
  }

  const headerRow = srNoCell.row;
  const colMap = buildColMap(worksheet, headerRow);
  if (colMap.srNo === null) {
    throw Object.assign(new Error('Could not locate the "Sr No." column.'), { status: 400 });
  }

  const rows = [];
  for (let rowIndex = headerRow + 1; rowIndex <= worksheet.rowCount; rowIndex += 1) {
    const srNoRaw = getCellVal(worksheet, colMap.srNo, rowIndex);
    if (hasValue(srNoRaw) && normStr(srNoRaw) === "total") break;
    if (!hasValue(srNoRaw)) continue;

    const getField = (field) => {
      const col = colMap[field];
      return col === null ? null : getCellVal(worksheet, col, rowIndex);
    };

    rows.push({
      srNo: Number.parseInt(srNoRaw, 10) || rows.length + 1,
      waxShipmentInvNo: cleanText(getField("waxShipmentInvNo")),
      treeNo: cleanText(getField("treeNo")),
      vpoPoNo: cleanText(getField("vpoPoNo")),
      productCategory: cleanText(getField("productCategory")),
      sku: cleanText(getField("sku")),
      customerSku: cleanText(getField("customerSku")),
      waxQty: numOrNull(getField("waxQty")),
      orderQty: numOrNull(getField("orderQty")),
      kt: cleanText(getField("kt")),
      color: cleanText(getField("color")),
      netWtPc: numOrNull(getField("netWtPc")),
      grossWtPc: numOrNull(getField("grossWtPc")),
      totalWt: numOrNull(getField("totalWt")),
      requiredMetalPg: numOrNull(getField("requiredMetalPg")),
      totalValue: numOrNull(getField("totalValue")),
      waxWeight: numOrNull(getField("waxWeight")),
      castingQty: numOrNull(getField("castingQty")),
      castingWeight: numOrNull(getField("castingWeight")),
      laborCharge: numOrNull(getField("laborCharge")),
      settingCharge: numOrNull(getField("settingCharge")),
      stoneCharge: numOrNull(getField("stoneCharge")),
      extraCharge: numOrNull(getField("extraCharge"))
    });
  }

  if (!rows.length) {
    throw Object.assign(new Error("No line items found in the uploaded workbook."), { status: 400 });
  }

  const firstWaxShipmentInvNo = rows.find((row) => row.waxShipmentInvNo)?.waxShipmentInvNo || "";
  const firstVpoNo = rows.find((row) => row.vpoPoNo)?.vpoPoNo || "";
  const fallbackOrderNo = firstVpoNo ? `VPO-${firstVpoNo}` : fallbackNoFromFileName(fileName);
  const waxShipmentInvNo = firstWaxShipmentInvNo || fallbackOrderNo;
  rows.forEach((row) => {
    if (!row.waxShipmentInvNo) row.waxShipmentInvNo = waxShipmentInvNo;
  });
  const invoiceNo = findValueNearLabel(worksheet, ["invoice no", "invoice number"], 30) || waxShipmentInvNo;
  const metalType = findValueNearLabel(worksheet, ["metal type", "metal kt"], 30) || firstValue(rows, "kt");

  return {
    companyName,
    waxShipmentInvNo,
    invoiceNo,
    dateOfOrder: normalizeDate(getMetaValue(metaRow)) || new Date().toISOString().slice(0, 10),
    soNo: cleanText(getMetaValue(metaRow + 1)) || fallbackOrderNo,
    metalType,
    waxWeight: sumNumeric(rows, "waxWeight") || sumNumeric(rows, "totalWt"),
    castingWeight: sumNumeric(rows, "castingWeight"),
    laborCharge: sumNumeric(rows, "laborCharge"),
    settingCharge: sumNumeric(rows, "settingCharge"),
    stoneCharge: sumNumeric(rows, "stoneCharge"),
    extraCharge: sumNumeric(rows, "extraCharge"),
    goldValue: numOrNull(getMetaValue(metaRow + 2)),
    silverValue: numOrNull(getMetaValue(metaRow + 3)),
    platinumValue: numOrNull(getMetaValue(metaRow + 4)),
    rows,
    source: {
      fileName: path.basename(fileName || "invoice-order.xlsx"),
      sheetName: worksheet.name,
      rowCount: rows.length,
      fallbackWaxShipmentInvNo: !firstWaxShipmentInvNo
    }
  };
}

function isOrderSheet(worksheet) {
  return Boolean(worksheet && findCellContaining(worksheet, "customer name:", 20) && findCellContaining(worksheet, "sr no", 20));
}

function findCellContaining(worksheet, keyword, maxRow = 30) {
  const needle = keyword.toLowerCase();
  for (let row = 0; row <= Math.min(worksheet.rowCount - 1, maxRow); row += 1) {
    for (let col = 0; col <= Math.min(worksheet.columnCount - 1, 24); col += 1) {
      const value = getCellVal(worksheet, col, row);
      if (hasValue(value) && normStr(value).includes(needle)) return { row, col };
    }
  }
  return null;
}

function findValueNearLabel(worksheet, labels, maxRow = 30) {
  for (const label of labels) {
    const found = findCellContaining(worksheet, label, maxRow);
    if (!found) continue;
    const current = cleanText(getCellVal(worksheet, found.col, found.row));
    const sameCellValue = current.replace(new RegExp(`^${escapeRegExp(label)}\\s*:?\\s*`, "i"), "").trim();
    if (sameCellValue && !looksLikeLabel(sameCellValue)) return sameCellValue;
    for (let offset = 1; offset <= 3; offset += 1) {
      const adjacent = cleanText(getCellVal(worksheet, found.col + offset, found.row));
      if (adjacent && !looksLikeLabel(adjacent)) return adjacent;
    }
  }
  return "";
}

function buildColMap(worksheet, headerRow) {
  return Object.fromEntries(Object.entries(COLUMN_KEYWORDS).map(([field, keywords]) => [field, findCol(worksheet, headerRow, keywords)]));
}

function findCol(worksheet, headerRow, keywords) {
  for (let col = 0; col <= worksheet.columnCount - 1; col += 1) {
    const value = normStr(getCellVal(worksheet, col, headerRow));
    if (keywords.some((keyword) => value.includes(keyword))) return col;
  }
  return null;
}

function extractCompanyName(worksheet, customerNameCell) {
  const currentValue = cleanText(getCellVal(worksheet, customerNameCell.col, customerNameCell.row));
  const sameCellName = currentValue.replace(/^customer name:\s*/i, "").trim();
  return sameCellName || cleanText(getCellVal(worksheet, customerNameCell.col + 1, customerNameCell.row));
}

function getCellVal(worksheet, col, row) {
  const cell = worksheet.getCell(row + 1, col + 1);
  if (!cell) return null;
  const value = cell.value;
  if (value && typeof value === "object") {
    if (value.result !== undefined) return value.result;
    if (value.text !== undefined) return value.text;
    if (value.richText) return value.richText.map((part) => part.text || "").join("");
    if (value instanceof Date) return value;
  }
  return value;
}

function normalizeDate(value) {
  if (!hasValue(value)) return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === "number") {
    const date = new Date(Math.round((value - 25569) * 86400 * 1000));
    return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
  }
  const text = cleanText(value);
  const dotted = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (dotted) {
    const month = dotted[1].padStart(2, "0");
    const day = dotted[2].padStart(2, "0");
    const year = dotted[3].length === 2 ? `20${dotted[3]}` : dotted[3];
    return `${year}-${month}-${day}`;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text.slice(0, 10) : parsed.toISOString().slice(0, 10);
}

function fallbackNoFromFileName(fileName) {
  const base = path.basename(fileName || "", path.extname(fileName || ""));
  const vpo = base.match(/\bVPO\s*[-_ ]?\s*(\d+)\b/i);
  if (vpo) return `VPO-${vpo[1]}`;
  return base.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || `UPLOAD-${Date.now()}`;
}

function cleanText(value) {
  return hasValue(value) ? String(value).replace(/\s+/g, " ").trim() : "";
}

function normStr(value) {
  return cleanText(value).toLowerCase();
}

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function looksLikeLabel(value) {
  return /customer name|date of order|so no|invoice no|invoice number|metal type|gold value|silver value|platinum value|labor|labour|setting|stone|extra/i.test(String(value || ""));
}

function numOrNull(value) {
  if (!hasValue(value)) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function sumNumeric(rows, field) {
  const total = rows.reduce((sum, row) => {
    const value = Number(row[field]);
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);
  return total || null;
}

function firstValue(rows, field) {
  const row = rows.find((item) => hasValue(item[field]));
  return row ? cleanText(row[field]) : "";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { parseInvoiceOrderWorkbook };
