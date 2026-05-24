(function () {
  "use strict";

  const rootElement = document.querySelector("#kanbanRoot");

  if (!rootElement) {
    return;
  }

  if (!window.React || !window.ReactDOM) {
    rootElement.innerHTML =
      '<section class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-700">Casting Process needs React to load.</section>';
    return;
  }

  const h = window.React.createElement;
  const { useEffect, useMemo, useState } = window.React;

  const waxStorageKey = "production-management-state-v1";
  const kanbanStorageKey = "production-management-kanban-v1";
  const rushFilterSessionKey = "production-management-kanban-rush-only-v1";
  const kanbanWorkflowChangedEvent = "productionKanbanWorkflowChanged";
  const castingRealtimeRefreshEvent = "productionCastingRealtimeRefresh";
  const waxEntriesChangedEvent = "waxEntriesChanged";
  const RBAC = window.ProductionRBAC;
  const Inventory = window.ProductionInventory;
  const Backend = window.CastingAPI;
  const currentUser = RBAC
    ? RBAC.currentUser
    : {
        id: "anonymous",
        assignedRoleIds: [],
        roleIds: [],
        isActive: false
      };
  const permissionDeniedMessage = "You do not have permission to perform this action.";

  const stages = [
    "Awaiting Metal",
    "Ready for Casting",
    "Casting Completed",
    "QC Completed",
    "Received at Store"
  ];

  const stageDisplayNames = {
    "QC Completed": "Quality Check and Control",
    "Received at Store": "Order Completed"
  };

  const metalSourceOptions = [
    {
      label: "Fine Gold + Alloy",
      value: "fineGoldAlloy"
    },
    {
      label: "Recycled",
      value: "recycled"
    },
    {
      label: "Mixed / Both",
      value: "mixed"
    }
  ];

  const colorOptions = ["", "White", "Yellow", "Pink"];
  const recycledMetalKtOptions = ["", "24KT", "22KT", "18KT", "14KT", "10KT", "Platinum", "Silver"];
  const silver925PurityFraction = 925 / 1000;

  const requiredActualWeightsBySource = {
    fineGoldAlloy: ["fineGoldWeight", "alloyWeight"],
    recycled: ["recycledWeight"],
    mixed: ["fineGoldWeight", "alloyWeight", "recycledWeight"]
  };

  const actualWeightLabels = {
    recycledWeight: "Actual Recycled Weight"
  };

  const metalWeightMultipliers = {
    "9KT": 11,
    "10KT": 11.5,
    "14KT": 13,
    "18KT": 15.5,
    "22KT": 17.8,
    Silver: 10.5,
    Plat: 21.4
  };

  const castingChecklistItems = [
    {
      field: "weightChecked",
      label: "Weight checked"
    },
    {
      field: "flaskTemperatureChecked",
      label: "Accurate temperature of flask"
    },
    {
      field: "metalChecked",
      label: "Metal checked"
    }
  ];

  function cx() {
    return Array.from(arguments).filter(Boolean).join(" ");
  }

  function readEntryFeed() {
    return normalizeEntryFeed([]);
  }

  function normalizeEntryFeed(entries) {
    const normalizedEntries = entries.map(normalizeWaxEntry).filter(hasOrderData);

    return {
      entries: normalizedEntries
    };
  }

  function normalizeWaxEntry(entry) {
    const internalTreeNumber = getInternalTreeNumber(entry);
    const barcodeValue = getBarcodeValue({ ...entry, internalTreeNumber });
    const treeParts = parseInternalTreeNumber(internalTreeNumber);

    return {
      id: entry.id || createId(),
      internalTreeNumber,
      barcodeValue,
      vendorCustomerName: entry.vendorCustomerName || "",
      date: entry.date || "",
      waxInvoiceNo: entry.waxInvoiceNo || "",
      customerVendorTreeNo: entry.customerVendorTreeNo || "",
      metalKt: entry.metalKt || "",
      color: entry.color || "",
      waxWeight: entry.waxWeight || "",
      alphabet: treeParts.prefix,
      number: treeParts.sequence,
      isInHouseProduction: Boolean(entry.isInHouseProduction),
      isRush: Boolean(entry.isRush)
    };
  }

  function hasOrderData(entry) {
    return Object.entries(entry).some(
      ([key, value]) => !["id", "isRush", "isInHouseProduction"].includes(key) && String(value || "").trim()
    );
  }

  function createId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }

    return `kanban-order-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function readWorkflowState() {
    return {};
  }

  function readRushOnlyFilter() {
    try {
      return sessionStorage.getItem(rushFilterSessionKey) === "true";
    } catch {
      return false;
    }
  }

  function writeRushOnlyFilter(isRushOnly) {
    try {
      sessionStorage.setItem(rushFilterSessionKey, String(Boolean(isRushOnly)));
    } catch {
      // Session persistence is optional; filtering still works without storage access.
    }
  }

  function persistWorkflowState(workflowById) {
    window.dispatchEvent(new CustomEvent(kanbanWorkflowChangedEvent, { detail: { orders: workflowById } }));
  }

  function canUseBackendCasting() {
    return Boolean(Backend?.isConfigured?.() && RBAC?.isAuthenticated?.());
  }

  async function loadCastingWorkflowsFromBackend() {
    if (!canUseBackendCasting() || !Backend?.fetchCastingWorkflows) {
      return null;
    }

    return Backend.fetchCastingWorkflows();
  }

  function persistCastingWorkflowToBackend(order, workflow, event = {}) {
    if (!canUseBackendCasting() || !Backend?.saveCastingWorkflow) return;

    Backend.saveCastingWorkflow(order, workflow, {
      ...event,
      user: currentUser
    }).catch((error) => {
      console.warn("Backend Casting Process save failed. Local workflow fallback remains updated.", error);
    });
  }

  function getValidStage(stage) {
    return stages.includes(stage) ? stage : stages[0];
  }

  function getNextStage(stage) {
    const currentIndex = stages.indexOf(stage);
    if (currentIndex === -1 || currentIndex === stages.length - 1) {
      return stage;
    }

    return stages[currentIndex + 1];
  }

  function getStageDisplayName(stage) {
    return stageDisplayNames[stage] || stage;
  }

  function canPerform(action, resource) {
    return RBAC ? RBAC.can(currentUser, action, resource) : true;
  }

  function getRbacStageId(stage) {
    return RBAC ? RBAC.getStageIdByKey(stage) || stage : stage;
  }

  function canUseCastingProcess(action = "view") {
    return RBAC ? RBAC.hasModulePermission(currentUser, "castingProcess", action) : true;
  }

  function canUseStage(stage, action = "view") {
    return RBAC ? RBAC.hasStagePermission(currentUser, getRbacStageId(stage), action) : true;
  }

  function canPostFinalInventory() {
    return RBAC ? RBAC.hasPermission(currentUser, "inventory.postFinal") : true;
  }

  function recordAudit(action, details = {}) {
    if (!RBAC) return;

    RBAC.recordAuditLog({
      action,
      user: currentUser,
      ...details
    });
  }

  function buildOrder(entry, workflowById) {
    const workflow = workflowById[entry.id] || {};
    const stage = getValidStage(workflow.stage);
    const isDamaged = Boolean(workflow.isDamaged || workflow.castingIssue?.damaged || workflow.damagedTree);
    const removedFromBoard = Boolean(
      workflow.removedFromBoard || workflow.finalStatus === "Damaged" || workflow.damagedTree
    );
    const metalIssue = workflow.metalIssue || null;
    const totalIssuedWeight = getOrderTotalIssuedWeight(workflow);
    const castingVerification = workflow.castingVerification || null;
    const qcVerification = workflow.qcVerification || null;
    const currentColor = workflow.castingColor || castingVerification?.castingColor || entry.color || "";

    return {
      ...entry,
      color: currentColor,
      stage,
      notes: workflow.notes || "",
      metalIssue,
      castingIssue: workflow.castingIssue || null,
      castingVerification,
      qcVerification,
      castingColor: currentColor,
      castingColorConfirmed: Boolean(workflow.castingColorConfirmed || castingVerification?.colorConfirmed),
      castingWeight: hasSubmittedWeightValue(workflow.castingWeight)
        ? workflow.castingWeight
        : castingVerification?.castingWeight || "",
      weightDifference: hasSubmittedWeightValue(workflow.weightDifference)
        ? workflow.weightDifference
        : (castingVerification?.weightDifference ?? null),
      weightAfterCutting: hasSubmittedWeightValue(workflow.weightAfterCutting)
        ? workflow.weightAfterCutting
        : qcVerification?.weightAfterCutting || "",
      assayKt: workflow.assayKt || qcVerification?.assayKt || "",
      assayResultReferenceNumber:
        workflow.assayResultReferenceNumber || qcVerification?.assayResultReferenceNumber || "",
      receivedOrderWeight: hasSubmittedWeightValue(workflow.receivedOrderWeight)
        ? workflow.receivedOrderWeight
        : workflow.receivedOrder?.weight || "",
      receivedOrderSubmittedAt: workflow.receivedOrderSubmittedAt || workflow.receivedOrder?.submittedAt || "",
      finishedProductWeight: hasSubmittedWeightValue(workflow.finishedProductWeight)
        ? workflow.finishedProductWeight
        : workflow.receivedOrderWeight || workflow.receivedOrder?.weight || "",
      inventoryLedgerIds: Array.isArray(workflow.inventoryLedgerIds) ? workflow.inventoryLedgerIds : [],
      inventoryPosted: Boolean(workflow.inventoryPosted),
      inventoryPostedAt: workflow.inventoryPostedAt || "",
      reusableBalanceWeight: hasSubmittedWeightValue(workflow.reusableBalanceWeight)
        ? workflow.reusableBalanceWeight
        : "",
      scrapLossWeight: hasSubmittedWeightValue(workflow.scrapLossWeight) ? workflow.scrapLossWeight : "",
      damagedTree: workflow.damagedTree || null,
      finalStatus: workflow.finalStatus || "",
      returnHistory: Array.isArray(workflow.returnHistory) ? workflow.returnHistory : [],
      isInHouseProduction: Boolean(entry.isInHouseProduction),
      isRush: Boolean(entry.isRush),
      isDamaged,
      removedFromBoard,
      actualFineGoldWeight: hasSubmittedWeightValue(workflow.actualFineGoldWeight)
        ? workflow.actualFineGoldWeight
        : metalIssue?.fineGoldWeight || "",
      actualAlloyWeight: hasSubmittedWeightValue(workflow.actualAlloyWeight)
        ? workflow.actualAlloyWeight
        : metalIssue?.alloyWeight || "",
      actualRecycledWeight: hasSubmittedWeightValue(workflow.actualRecycledWeight)
        ? workflow.actualRecycledWeight
        : metalIssue?.recycledWeight || "",
      excessRecycledWeight: hasSubmittedWeightValue(workflow.excessRecycledWeight)
        ? workflow.excessRecycledWeight
        : metalIssue?.excessRecycledWeight || "",
      recycledMetalColor: workflow.recycledMetalColor || metalIssue?.recycledMetalColor || "",
      recycledMetalKt: workflow.recycledMetalKt || metalIssue?.recycledMetalKt || "",
      suggestedAlloyRequired: workflow.suggestedAlloyRequired || metalIssue?.suggestedAlloyRequired || "",
      suggestedFineGoldRequired: workflow.suggestedFineGoldRequired || metalIssue?.suggestedFineGoldRequired || "",
      totalIssuedWeight,
      updatedAt: workflow.updatedAt || "",
      orderCode: formatOrderCode(entry),
      barcodeValue: getBarcodeValue(entry),
      barcodeDisplay: buildBarcodeDisplay(entry),
      barcodeSearchKey: buildBarcodeSearchKey(entry),
      metalDisplay: formatMetal({ ...entry, color: currentColor }),
      weightDisplay: formatWeight(entry.waxWeight),
      reference: formatReference(entry),
      isComplete: stage === stages[stages.length - 1]
    };
  }

  function formatOrderCode(order) {
    return getInternalTreeNumber(order) || "Unassigned";
  }

  function buildBarcodeDisplay(order) {
    return getBarcodeValue(order);
  }

  function getInternalTreeNumber(entry = {}) {
    const existingValue = String(entry.internalTreeNumber || "").trim().toUpperCase();
    if (existingValue) return existingValue;

    const prefix = String(entry.alphabet || "").trim().toUpperCase();
    const sequence = String(entry.number || "").trim();
    return prefix && sequence ? `${prefix}-${sequence}` : "";
  }

  function parseInternalTreeNumber(value) {
    const [prefix, sequence] = String(value || "")
      .trim()
      .toUpperCase()
      .split("-");

    return {
      prefix: prefix || "",
      sequence: sequence || ""
    };
  }

  function buildBarcodeSearchKey(order) {
    return normalizeBarcodeSearch(getBarcodeValue(order));
  }

  function getBarcodeDate(date) {
    const [year, month, day] = String(date || "").split("-");
    if (!year || !month || !day) return "";
    return `${year}${month}${day}`;
  }

  function buildBarcodeValue(date, internalTreeNumber) {
    const dateCode = getBarcodeDate(date);
    const treeNumber = String(internalTreeNumber || "").trim().toUpperCase();
    return dateCode && treeNumber ? normalizeBarcodeValue(`${dateCode}-${treeNumber}`) : "";
  }

  function getBarcodeValue(entry = {}) {
    const existingValue = normalizeBarcodeValue(entry.barcodeValue);
    if (existingValue) return existingValue;

    return buildBarcodeValue(entry.date, getInternalTreeNumber(entry));
  }

  function normalizeBarcodeValue(value) {
    return String(value || "")
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "")
      .replace(/[^A-Z0-9-]/g, "");
  }

  function normalizeBarcodeSearch(value) {
    return normalizeBarcodeValue(value).replace(/[^A-Z0-9]/g, "");
  }

  function formatMetal(order) {
    const metal = String(order.metalKt || "").trim();
    const color = String(order.color || "").trim();

    if (metal && color) {
      return `${metal} ${color}`;
    }

    return metal || color || "Metal pending";
  }

  function formatWeight(weight) {
    const value = String(weight || "").trim();
    return value ? `${value} g` : "Weight pending";
  }

  function parseWeight(value) {
    const parsedValue = Number.parseFloat(String(value || "").trim());
    return Number.isFinite(parsedValue) ? parsedValue : null;
  }

  function parseActualWeight(value) {
    const parsedValue = Number.parseFloat(String(value || "").trim());
    return Number.isFinite(parsedValue) ? parsedValue : 0;
  }

  function calculateActualTotalWeight(actualWeights, visibleFields) {
    return visibleFields.reduce((totalWeight, field) => totalWeight + parseActualWeight(actualWeights[field]), 0);
  }

  function formatActualTotalWeight(value) {
    const roundedValue = Math.round((Number.isFinite(value) ? value : 0) * 1000) / 1000;
    const formattedValue = roundedValue.toFixed(3).replace(/\.?0+$/, "");

    return `${formattedValue || "0"} g`;
  }

  function hasSubmittedWeightValue(value) {
    return value !== null && value !== undefined && String(value).trim() !== "";
  }

  function parseSubmittedWeight(value) {
    if (!hasSubmittedWeightValue(value)) {
      return null;
    }

    const parsedValue = Number.parseFloat(String(value).trim());
    return Number.isFinite(parsedValue) ? parsedValue : null;
  }

  function getSubmittedActualWeight(metalIssue, field) {
    const submittedValue = parseSubmittedWeight(metalIssue?.[field]);
    return submittedValue === null ? 0 : submittedValue;
  }

  function calculateSubmittedTotalIssuedWeight(metalIssue) {
    if (!metalIssue || !metalIssue.submittedAt) {
      return null;
    }

    const savedTotal = parseSubmittedWeight(metalIssue.totalIssuedWeight);

    if (savedTotal !== null) {
      return savedTotal;
    }

    const submittedFields = requiredActualWeightsBySource[metalIssue.source] || [
      "fineGoldWeight",
      "alloyWeight",
      "recycledWeight"
    ];
    const hasAnySubmittedWeight = submittedFields.some((field) => hasSubmittedWeightValue(metalIssue[field]));

    if (!hasAnySubmittedWeight) {
      return null;
    }

    return submittedFields.reduce(
      (totalWeight, field) => totalWeight + getSubmittedActualWeight(metalIssue, field),
      0
    );
  }

  function getOrderTotalIssuedWeight(workflow) {
    const savedTotal = parseSubmittedWeight(workflow.totalIssuedWeight);

    if (savedTotal !== null) {
      return savedTotal;
    }

    return calculateSubmittedTotalIssuedWeight(workflow.metalIssue);
  }

  function formatSavedTotalIssuedWeight(value) {
    const parsedValue = parseSubmittedWeight(value);

    if (parsedValue === null) {
      return "Not available";
    }

    return formatActualTotalWeight(parsedValue);
  }

  function calculateWeightDifference(totalIssuedWeight, castingWeight) {
    const issuedWeight = parseSubmittedWeight(totalIssuedWeight);
    const castWeight = parseSubmittedWeight(castingWeight);

    if (issuedWeight === null || castWeight === null) {
      return null;
    }

    return Math.round((issuedWeight - castWeight) * 1000) / 1000;
  }

  function formatWeightDifference(value) {
    if (value === null) {
      return "Cannot calculate difference";
    }

    return formatActualTotalWeight(value);
  }

  function formatReferenceWeight(value) {
    if (!Number.isFinite(value)) {
      return "Not available";
    }

    return `${value.toFixed(3)} g`;
  }

  function roundWeightValue(value) {
    return Math.round((Number.isFinite(value) ? value : 0) * 1000) / 1000;
  }

  function isSilver925Metal(metalKt) {
    const normalizedMetal = String(metalKt || "")
      .trim()
      .toUpperCase()
      .replace(/[\s_-]+/g, " ");

    return ["SILVER", "SILVER 925", "SILVER925", "925 SILVER", "925SILVER"].includes(normalizedMetal);
  }

  function getMetalIssueLabels(metalKt) {
    const isSilver = isSilver925Metal(metalKt);
    const fineMetalName = isSilver ? "Fine Silver" : "Fine Gold";
    const alloyName = isSilver ? "Silver Alloy" : "Alloy";

    return {
      alloyName,
      alloyRequiredLabel: "Alloy Required",
      actualAlloyWeightLabel: "Actual Alloy Weight",
      actualAlloyTopUpWeightLabel: "Actual Alloy Weight (Top-up)",
      actualFineMetalWeightLabel: `Actual ${fineMetalName} Weight`,
      actualFineMetalTopUpWeightLabel: `Actual ${fineMetalName} Weight (Top-up)`,
      fineMetalAlreadyPresentLabel: `${fineMetalName} In Recycled`,
      fineMetalLabel: fineMetalName,
      fineMetalRequiredLabel: `${fineMetalName} Required`,
      metalType: isSilver ? "Silver" : "Gold",
      sourceOptionLabel: `${fineMetalName} + Alloy`,
      suggestedFineMetalRequiredLabel: `Suggested ${fineMetalName} Required`,
      targetFineMetalRequiredLabel: `Target ${fineMetalName} Required`
    };
  }

  function getActualWeightLabel(field, labels) {
    if (field === "fineGoldWeight") return labels.actualFineMetalWeightLabel;
    if (field === "alloyWeight") return labels.actualAlloyWeightLabel;

    return actualWeightLabels[field] || field;
  }

  function getMetalPurityFraction(metalKt) {
    if (isSilver925Metal(metalKt)) {
      return silver925PurityFraction;
    }

    const match = String(metalKt || "")
      .trim()
      .toUpperCase()
      .match(/^(\d+(?:\.\d+)?)KT$/);

    if (!match) {
      return null;
    }

    return Number(match[1]) / 24;
  }

  function getMetalWeightMultiplier(metalKt) {
    const normalizedMetal = String(metalKt || "").trim();
    if (isSilver925Metal(normalizedMetal)) return metalWeightMultipliers.Silver;

    return metalWeightMultipliers[normalizedMetal] || null;
  }

  function calculateMetalWeightRequired(order) {
    const waxWeight = parseWeight(order.waxWeight);
    const multiplier = getMetalWeightMultiplier(order.metalKt);

    if (waxWeight === null || multiplier === null) {
      return null;
    }

    return waxWeight * multiplier;
  }

  function calculateMetalReference(order) {
    const waxWeight = parseWeight(order.waxWeight);
    const metalWeightRequired = calculateMetalWeightRequired(order);
    const purityFraction = getMetalPurityFraction(order.metalKt);

    if (metalWeightRequired === null || purityFraction === null) {
      return {
        metalWeightRequired,
        requiredAlloy: null,
        requiredFineMetal: null,
        requiredFineGold: null,
        purityFraction,
        waxWeight
      };
    }

    const requiredFineMetal = metalWeightRequired * purityFraction;

    return {
      metalWeightRequired,
      purityFraction,
      requiredAlloy: Math.max(metalWeightRequired - requiredFineMetal, 0),
      requiredFineGold: requiredFineMetal,
      requiredFineMetal,
      waxWeight
    };
  }

  function calculateExcessRecycledWeight(recycledWeight, requiredMetalWeight) {
    const recycled = parseSubmittedWeight(recycledWeight);

    if (recycled === null || !Number.isFinite(requiredMetalWeight)) {
      return 0;
    }

    return roundWeightValue(Math.max(recycled - requiredMetalWeight, 0));
  }

  function calculateMixedMetalReference({ order, recycledKt, recycledWeight, reference }) {
    const requiredMetalWeight = reference.metalWeightRequired;
    const recycled = parseSubmittedWeight(recycledWeight);
    const targetPurity = getMetalPurityFraction(order.metalKt);
    const recycledPurity = getMetalPurityFraction(recycledKt) || 0;

    if (!Number.isFinite(requiredMetalWeight) || recycled === null || targetPurity === null) {
      return {
        additionalAlloyRequired: null,
        additionalFineGoldRequired: null,
        additionalFineMetalRequired: null,
        fineMetalAlreadyPresent: null,
        pureGoldAlreadyPresent: null,
        targetFineMetalRequired: Number.isFinite(requiredMetalWeight) && targetPurity !== null
          ? roundWeightValue(requiredMetalWeight * targetPurity)
          : null,
        remainingMetalToPrepare: null,
        targetPureGoldRequired: Number.isFinite(requiredMetalWeight) && targetPurity !== null
          ? roundWeightValue(requiredMetalWeight * targetPurity)
          : null
      };
    }

    const targetFineMetalRequired = requiredMetalWeight * targetPurity;
    const fineMetalAlreadyPresent = recycled * recycledPurity;
    const additionalFineMetalRequired = Math.max(targetFineMetalRequired - fineMetalAlreadyPresent, 0);
    const remainingMetalToPrepare = requiredMetalWeight - recycled;
    const additionalAlloyRequired = Math.max(remainingMetalToPrepare - additionalFineMetalRequired, 0);

    return {
      additionalAlloyRequired: roundWeightValue(additionalAlloyRequired),
      additionalFineGoldRequired: roundWeightValue(additionalFineMetalRequired),
      additionalFineMetalRequired: roundWeightValue(additionalFineMetalRequired),
      fineMetalAlreadyPresent: roundWeightValue(fineMetalAlreadyPresent),
      pureGoldAlreadyPresent: roundWeightValue(fineMetalAlreadyPresent),
      remainingMetalToPrepare: roundWeightValue(remainingMetalToPrepare),
      targetFineMetalRequired: roundWeightValue(targetFineMetalRequired),
      targetPureGoldRequired: roundWeightValue(targetFineMetalRequired)
    };
  }

  function getMetalSourceLabel(value, labels = getMetalIssueLabels()) {
    if (value === "fineGoldAlloy") {
      return labels.sourceOptionLabel;
    }

    const option = metalSourceOptions.find((item) => item.value === value);
    return option ? option.label : metalSourceOptions[0].label;
  }

  function formatReference(order) {
    const parts = [
      order.vendorCustomerName,
      order.waxInvoiceNo ? `Invoice ${order.waxInvoiceNo}` : "",
      order.customerVendorTreeNo ? `Tree ${order.customerVendorTreeNo}` : ""
    ]
      .map((part) => String(part || "").trim())
      .filter(Boolean);

    return parts.join(" / ") || "Reference pending";
  }

  function groupOrdersByStage(orders) {
    return stages.reduce((groupedOrders, stage) => {
      groupedOrders[stage] = orders.filter((order) => order.stage === stage);
      return groupedOrders;
    }, {});
  }

  function buildDamagedTrees(orders) {
    return orders
      .filter((order) => order.damagedTree || (order.removedFromBoard && order.finalStatus === "Damaged"))
      .map((order) => {
        const damagedTree = order.damagedTree || {};

        return {
          barcodeValue: order.barcodeValue,
          id: order.id,
          currentStage: order.finalStatus || order.stage,
          damageReason: damagedTree.damageReason || order.castingIssue?.damageReason || "",
          isInHouseProduction: Boolean(order.isInHouseProduction),
          markedAt: damagedTree.markedAt || order.castingIssue?.submittedAt || "",
          metalDisplay: order.metalDisplay,
          notes: order.notes || "",
          orderCode: order.orderCode,
          reference: order.reference,
          reportedStage: damagedTree.reportedStage || stages[1],
          weightDisplay: order.weightDisplay
        };
      })
      .sort((first, second) => {
        const firstTime = new Date(first.markedAt).getTime() || 0;
        const secondTime = new Date(second.markedAt).getTime() || 0;
        return secondTime - firstTime;
      });
  }

  function formatDateTime(value) {
    if (!value) {
      return "Not available";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }

    return date.toLocaleString();
  }

  function formatSummaryDateTime(value) {
    if (!value) {
      return "Not available";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "Not available";
    }

    return date
      .toLocaleString("en-GB", {
        day: "2-digit",
        hour: "numeric",
        hour12: true,
        minute: "2-digit",
        month: "short",
        year: "numeric"
      })
      .replace(" am", " AM")
      .replace(" pm", " PM");
  }

  function formatSummaryValue(value) {
    const textValue = String(value ?? "").trim();
    return textValue || "Not available";
  }

  function formatReviewInfoValue(value) {
    const textValue = String(value ?? "").trim();
    const pendingValues = ["Metal pending", "Reference pending", "Unassigned", "Weight pending"];

    if (!textValue || pendingValues.includes(textValue)) {
      return "Not available";
    }

    return textValue;
  }

  function formatSummaryWeight(value) {
    return formatSavedTotalIssuedWeight(value);
  }

  function formatSummaryBoolean(value, trueLabel = "Yes", falseLabel = "No") {
    if (typeof value !== "boolean") {
      return "Not available";
    }

    return value ? trueLabel : falseLabel;
  }

  function formatChecklistStatus(checklist, field) {
    if (!checklist || typeof checklist[field] !== "boolean") {
      return "Not available";
    }

    return checklist[field] ? "Checked" : "Not checked";
  }

  function getTotalTreeWeightValue(order) {
    return hasSubmittedWeightValue(order.castingWeight) ? order.castingWeight : order.totalIssuedWeight;
  }

  function formatChangedCastingColor(castingVerification) {
    if (!castingVerification || typeof castingVerification.colorChanged !== "boolean") {
      return "Not available";
    }

    if (!castingVerification.colorChanged) {
      return "No color change";
    }

    return formatSummaryValue(castingVerification.castingColor);
  }

  function formatDamagedStatus(castingIssue) {
    if (!castingIssue || typeof castingIssue.damaged !== "boolean") {
      return "Not available";
    }

    return formatSummaryBoolean(castingIssue.damaged, "Damaged", "Not damaged");
  }

  function matchesDamagedTreeSearch(item, query) {
    if (!query) return true;

    const haystack = [
      item.damageReason,
      item.markedAt,
      item.metalDisplay,
      item.notes,
      item.orderCode,
      item.barcodeValue,
      item.isInHouseProduction ? "in-house prod" : "",
      item.reference,
      item.reportedStage,
      getStageDisplayName(item.reportedStage),
      item.weightDisplay,
      item.currentStage,
      getStageDisplayName(item.currentStage)
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(query);
  }

  function matchesInternalTreeNumberSearch(order, query) {
    const searchValue = String(query || "").trim().toLowerCase();
    if (!searchValue) return true;

    return String(order.internalTreeNumber || "").trim().toLowerCase().includes(searchValue);
  }

  function matchesRushFilter(order, rushOnly) {
    return !rushOnly || Boolean(order.isRush);
  }

  function KanbanBoard() {
    const [entryFeed, setEntryFeed] = useState(readEntryFeed);
    const [workflowById, setWorkflowById] = useState(readWorkflowState);
    const [selectedOrderId, setSelectedOrderId] = useState(null);
    const [draftNotes, setDraftNotes] = useState("");
    const [error, setError] = useState("");
    const [showDamagedTrees, setShowDamagedTrees] = useState(false);
    const [damagedTreeSearch, setDamagedTreeSearch] = useState("");
    const [internalTreeSearch, setInternalTreeSearch] = useState("");
    const [rushOnly, setRushOnly] = useState(readRushOnlyFilter);
    const [rbacVersion, setRbacVersion] = useState(0);
    const [remoteWorkflowLoadStarted, setRemoteWorkflowLoadStarted] = useState(false);
    const [scanValues, setScanValues] = useState(() => Object.fromEntries(stages.map((stage) => [stage, ""])));
    const [scanMessages, setScanMessages] = useState({});

    const orders = useMemo(
      () => entryFeed.entries.map((entry) => buildOrder(entry, workflowById)),
      [entryFeed.entries, workflowById]
    );

    const boardOrders = useMemo(
      () =>
        orders.filter(
          (order) =>
            !order.removedFromBoard &&
            matchesInternalTreeNumberSearch(order, internalTreeSearch) &&
            matchesRushFilter(order, rushOnly)
        ),
      [orders, internalTreeSearch, rushOnly]
    );
    const ordersByStage = useMemo(() => groupOrdersByStage(boardOrders), [boardOrders]);
    const accessibleStages = useMemo(() => stages.filter((stage) => canUseStage(stage)), [rbacVersion]);
    const damagedTrees = useMemo(
      () => buildDamagedTrees(orders).filter((item) => canUseStage(item.reportedStage) || canUseStage(item.currentStage)),
      [orders, rbacVersion]
    );
    const filteredDamagedTrees = useMemo(
      () => damagedTrees.filter((item) => matchesDamagedTreeSearch(item, damagedTreeSearch.trim().toLowerCase())),
      [damagedTrees, damagedTreeSearch]
    );
    const selectedBoardOrder = boardOrders.find((order) => order.id === selectedOrderId) || null;
    const selectedOrder =
      selectedBoardOrder && canUseStage(selectedBoardOrder.stage) ? selectedBoardOrder : null;
    const isFocusedView = Boolean(selectedOrder);
    const activeStage = selectedOrder ? selectedOrder.stage : "";
    const visibleStages = isFocusedView ? [selectedOrder.stage] : accessibleStages;
    const canViewCastingProcess = canUseCastingProcess();
    const canViewDamagedTrees = stages.some((stage) => canUseStage(stage, "viewDamagedTrees"));

    useEffect(() => {
      let deferredRefreshTimer = 0;
      let pendingRemoteRefresh = false;
      let isRefreshing = false;

      function syncFromStorage() {
        setEntryFeed(readEntryFeed());
      }

      function handleWaxEntriesChanged(event) {
        const entries =
          event.detail && Array.isArray(event.detail.entries) ? event.detail.entries : readEntryFeed().entries;
        setEntryFeed(normalizeEntryFeed(entries));
      }

      function handleStorage(event) {
        if (event.key === waxStorageKey) {
          syncFromStorage();
        }

        if (event.key === kanbanStorageKey) {
          setWorkflowById(readWorkflowState());
        }
      }

      function isUserEditingKanban() {
        const activeElement = document.activeElement;
        return Boolean(
          activeElement &&
            rootElement.contains(activeElement) &&
            activeElement.matches("input, textarea, select, [contenteditable='true']")
        );
      }

      function scheduleDeferredRemoteRefresh() {
        window.clearTimeout(deferredRefreshTimer);
        deferredRefreshTimer = window.setTimeout(refreshRemoteWorkflows, 1500);
      }

      function refreshRemoteWorkflows() {
        if (!canUseBackendCasting() || isRefreshing) return;

        if (isUserEditingKanban()) {
          pendingRemoteRefresh = true;
          scheduleDeferredRemoteRefresh();
          return;
        }

        pendingRemoteRefresh = false;
        isRefreshing = true;
        loadCastingWorkflowsFromBackend()
          .then((remoteWorkflows) => {
            if (!remoteWorkflows) return;
            setWorkflowById(remoteWorkflows);
          })
          .catch((error) => {
            console.warn("Backend Casting Process live refresh failed.", error);
          })
          .finally(() => {
            isRefreshing = false;
          });
      }

      function handleFocusOut() {
        if (pendingRemoteRefresh) {
          scheduleDeferredRemoteRefresh();
        }
      }

      window.addEventListener(waxEntriesChangedEvent, handleWaxEntriesChanged);
      window.addEventListener(castingRealtimeRefreshEvent, refreshRemoteWorkflows);
      window.addEventListener("storage", handleStorage);
      window.addEventListener("focus", syncFromStorage);
      rootElement.addEventListener("focusout", handleFocusOut, true);

      return () => {
        window.clearTimeout(deferredRefreshTimer);
        window.removeEventListener(waxEntriesChangedEvent, handleWaxEntriesChanged);
        window.removeEventListener(castingRealtimeRefreshEvent, refreshRemoteWorkflows);
        window.removeEventListener("storage", handleStorage);
        window.removeEventListener("focus", syncFromStorage);
        rootElement.removeEventListener("focusout", handleFocusOut, true);
      };
    }, []);

    useEffect(() => {
      if (!RBAC) return undefined;

      function refreshRbac() {
        setRbacVersion((version) => version + 1);
      }

      window.addEventListener(RBAC.rolesChangedEvent, refreshRbac);
      if (RBAC.usersChangedEvent) {
        window.addEventListener(RBAC.usersChangedEvent, refreshRbac);
      }
      if (RBAC.authChangedEvent) {
        window.addEventListener(RBAC.authChangedEvent, refreshRbac);
      }
      window.addEventListener("storage", refreshRbac);

      return () => {
        window.removeEventListener(RBAC.rolesChangedEvent, refreshRbac);
        if (RBAC.usersChangedEvent) {
          window.removeEventListener(RBAC.usersChangedEvent, refreshRbac);
        }
        if (RBAC.authChangedEvent) {
          window.removeEventListener(RBAC.authChangedEvent, refreshRbac);
        }
        window.removeEventListener("storage", refreshRbac);
      };
    }, []);

    useEffect(() => {
      persistWorkflowState(workflowById);
    }, [workflowById]);

    useEffect(() => {
      writeRushOnlyFilter(rushOnly);
    }, [rushOnly]);

    useEffect(() => {
      let isCancelled = false;

      if (!canUseBackendCasting()) {
        setRemoteWorkflowLoadStarted(false);
        return undefined;
      }

      if (remoteWorkflowLoadStarted) {
        return undefined;
      }

      setRemoteWorkflowLoadStarted(true);
      loadCastingWorkflowsFromBackend()
        .then((remoteWorkflows) => {
          if (isCancelled || !remoteWorkflows) return;
          setWorkflowById((currentState) => ({
            ...currentState,
            ...remoteWorkflows
          }));
        })
        .catch((error) => {
          console.warn("Backend Casting Process load failed.", error);
        });

      return () => {
        isCancelled = true;
      };
    }, [rbacVersion, remoteWorkflowLoadStarted]);

    useEffect(() => {
      if (
        selectedOrderId &&
        !boardOrders.some((order) => order.id === selectedOrderId && canUseStage(order.stage))
      ) {
        setSelectedOrderId(null);
        setDraftNotes("");
        setError("");
      }
    }, [boardOrders, rbacVersion, selectedOrderId]);

    function openOrder(order) {
      if (!canUseStage(order.stage, "open")) {
        recordAudit("Unauthorized access attempt", {
          barcodeValue: order.barcodeValue,
          isInHouseProduction: order.isInHouseProduction,
          module: "Casting Process",
          stage: getStageDisplayName(order.stage),
          internalTreeNumber: order.orderCode,
          notes: "Open focused order"
        });
        setError(permissionDeniedMessage);
        return;
      }

      setSelectedOrderId(order.id);
      setDraftNotes(order.notes || "");
      setError("");
    }

    function cancelOrder() {
      setSelectedOrderId(null);
      setDraftNotes("");
      setError("");
    }

    function openDamagedTrees() {
      if (!canViewDamagedTrees) {
        recordAudit("Unauthorized access attempt", {
          module: "Casting Process",
          notes: "View damaged trees"
        });
        setError(permissionDeniedMessage);
        return;
      }

      cancelOrder();
      setShowDamagedTrees(true);
    }

    function closeDamagedTrees() {
      setShowDamagedTrees(false);
      setDamagedTreeSearch("");
    }

    function updateScanValue(stage, value) {
      setScanValues((currentValues) => ({
        ...currentValues,
        [stage]: value
      }));
      setScanMessages((currentMessages) => ({
        ...currentMessages,
        [stage]: null
      }));
    }

    function setScanMessage(stage, type, message) {
      setScanMessages((currentMessages) => ({
        ...currentMessages,
        [stage]: {
          message,
          type
        }
      }));
    }

    function scanBarcode(stage) {
      const scanValue = String(scanValues[stage] || "").trim();
      const barcodeSearchKey = normalizeBarcodeSearch(scanValue);

      if (!barcodeSearchKey) {
        setScanMessage(stage, "info", "Scan or type a barcode first.");
        return;
      }

      const matchedOrder = orders.find((order) => order.barcodeSearchKey === barcodeSearchKey);

      if (!matchedOrder) {
        setScanMessage(stage, "error", "No matching order found");
        return;
      }

      if (matchedOrder.removedFromBoard) {
        setScanValues((currentValues) => ({
          ...currentValues,
          [stage]: ""
        }));
        setScanMessage(stage, "warning", "Order is in Damaged Trees.");
        return;
      }

      if (!canUseStage(matchedOrder.stage)) {
        setScanValues((currentValues) => ({
          ...currentValues,
          [stage]: ""
        }));
        recordAudit("Unauthorized access attempt", {
          barcodeValue: matchedOrder.barcodeValue,
          isInHouseProduction: matchedOrder.isInHouseProduction,
          module: "Casting Process",
          stage: getStageDisplayName(matchedOrder.stage),
          internalTreeNumber: matchedOrder.orderCode,
          notes: "Barcode scan"
        });
        setScanMessage(stage, "warning", permissionDeniedMessage);
        return;
      }

      openOrder(matchedOrder);
      setScanValues((currentValues) => ({
        ...currentValues,
        [stage]: ""
      }));
      setScanMessage(
        matchedOrder.stage,
        matchedOrder.stage === stage ? "success" : "warning",
        matchedOrder.stage === stage
          ? `Order opened in ${getStageDisplayName(stage)}`
          : `Order found in ${getStageDisplayName(matchedOrder.stage)}`
      );
    }

    async function submitOrder(details = {}) {
      if (!selectedOrder) {
        setError("Order is no longer available.");
        return;
      }

      const notesValue = typeof details.notes === "string" ? details.notes : draftNotes;

      if (notesValue.trim().length > 500) {
        setError("Remarks must be 500 characters or less.");
        return;
      }

      const submittedReceivedOrder = details.receivedOrder || null;
      const submittedInventoryPosting = details.inventoryPosting || null;
      if (selectedOrder.isComplete && !submittedReceivedOrder && !submittedInventoryPosting) {
        return;
      }

      if (submittedReceivedOrder && hasSubmittedWeightValue(selectedOrder.receivedOrderWeight)) {
        setError("Received order weight has already been submitted.");
        return;
      }

      if (selectedOrder.inventoryPosted && submittedReceivedOrder) {
        setError("Inventory has already been posted for this order.");
        return;
      }

      if (submittedInventoryPosting && selectedOrder.inventoryPosted) {
        recordAudit("Attempted duplicate inventory posting", {
          barcodeValue: selectedOrder.barcodeValue,
          isInHouseProduction: selectedOrder.isInHouseProduction,
          module: "Inventory",
          stage: getStageDisplayName(selectedOrder.stage),
          internalTreeNumber: selectedOrder.orderCode,
          newValue: { orderId: selectedOrder.id }
        });
        setError("Inventory has already been posted for this order.");
        return;
      }

      if (submittedInventoryPosting && !canPostFinalInventory()) {
        recordAudit("Unauthorized access attempt", {
          barcodeValue: selectedOrder.barcodeValue,
          isInHouseProduction: selectedOrder.isInHouseProduction,
          module: "Inventory",
          stage: getStageDisplayName(selectedOrder.stage),
          internalTreeNumber: selectedOrder.orderCode,
          notes: "Post final inventory"
        });
        setError(permissionDeniedMessage);
        return;
      }

      if (!canUseStage(selectedOrder.stage, "submitStage")) {
        recordAudit("Unauthorized access attempt", {
          barcodeValue: selectedOrder.barcodeValue,
          isInHouseProduction: selectedOrder.isInHouseProduction,
          module: "Casting Process",
          stage: getStageDisplayName(selectedOrder.stage),
          internalTreeNumber: selectedOrder.orderCode,
          notes: "Submit stage"
        });
        setError(permissionDeniedMessage);
        return;
      }

      const nextStage = getNextStage(selectedOrder.stage);
      const submittedCastingIssue = details.castingIssue || selectedOrder.castingIssue || {};
      if (details.castingIssue?.damaged && !canUseStage(selectedOrder.stage, "markDamaged")) {
        recordAudit("Unauthorized access attempt", {
          barcodeValue: selectedOrder.barcodeValue,
          isInHouseProduction: selectedOrder.isInHouseProduction,
          module: "Casting Process",
          stage: getStageDisplayName(selectedOrder.stage),
          internalTreeNumber: selectedOrder.orderCode,
          notes: "Mark damaged"
        });
        setError(permissionDeniedMessage);
        return;
      }

      const shouldFinalizeDamagedTree =
        selectedOrder.stage === stages[2] && Boolean(submittedCastingIssue.damaged || selectedOrder.isDamaged);
      const submittedAt = new Date().toISOString();
      const submittedMetalIssue = details.metalIssue || null;
      const submittedTotalIssuedWeight = submittedMetalIssue
        ? calculateSubmittedTotalIssuedWeight(submittedMetalIssue)
        : null;
      const submittedCastingVerification = details.castingVerification || null;
      const submittedCastingColor = submittedCastingVerification?.castingColor || "";
      const submittedQcVerification = details.qcVerification || null;
      const inventoryPostedAt = submittedInventoryPosting?.postedAt || new Date().toISOString();
      let inventoryPostingResult = null;

      if (submittedInventoryPosting) {
        if (!Inventory?.postOrderToInventory) {
          setError("Inventory posting is not available.");
          return;
        }

        try {
          inventoryPostingResult = await Inventory.postOrderToInventory(
            {
              ...selectedOrder,
              finishedProductWeight: submittedInventoryPosting.finishedProductWeight,
              receivedOrderWeight: submittedInventoryPosting.finishedProductWeight
            },
            {
              notes: submittedInventoryPosting.notes || notesValue.trim(),
              postedAt: inventoryPostedAt,
              user: currentUser
            }
          );
        } catch (error) {
          setError(error.message || "Inventory could not be posted.");
          return;
        }
      }

      const existingWorkflow = workflowById[selectedOrder.id] || {};
      const nextWorkflow = {
        ...existingWorkflow,
        stage: shouldFinalizeDamagedTree ? selectedOrder.stage : nextStage,
        notes: notesValue.trim(),
        ...(submittedMetalIssue
          ? {
              actualAlloyWeight: getSubmittedActualWeight(submittedMetalIssue, "alloyWeight"),
              actualFineGoldWeight: getSubmittedActualWeight(submittedMetalIssue, "fineGoldWeight"),
              actualRecycledWeight: getSubmittedActualWeight(submittedMetalIssue, "recycledWeight"),
              excessRecycledWeight: submittedMetalIssue.excessRecycledWeight || "",
              metalIssue: submittedMetalIssue,
              recycledMetalColor: submittedMetalIssue.recycledMetalColor || "",
              recycledMetalKt: submittedMetalIssue.recycledMetalKt || "",
              suggestedAlloyRequired: submittedMetalIssue.suggestedAlloyRequired || "",
              suggestedFineMetalRequired: submittedMetalIssue.suggestedFineMetalRequired || "",
              suggestedFineGoldRequired: submittedMetalIssue.suggestedFineGoldRequired || "",
              totalIssuedWeight: submittedTotalIssuedWeight
            }
          : {}),
        ...(submittedCastingVerification
          ? {
              castingColor: submittedCastingColor || selectedOrder.color || "",
              castingColorConfirmed: Boolean(submittedCastingVerification.colorConfirmed),
              castingVerification: submittedCastingVerification,
              castingWeight: submittedCastingVerification.castingWeight,
              weightDifference: submittedCastingVerification.weightDifference
            }
          : {}),
        ...(submittedQcVerification
          ? {
              assayKt: submittedQcVerification.assayKt,
              assayResultReferenceNumber: submittedQcVerification.assayResultReferenceNumber,
              qcVerification: submittedQcVerification,
              weightAfterCutting: submittedQcVerification.weightAfterCutting
            }
          : {}),
        ...(submittedReceivedOrder
          ? {
              receivedOrder: submittedReceivedOrder,
              receivedOrderStatus: "Received weight submitted",
              receivedOrderSubmittedAt: submittedReceivedOrder.submittedAt,
              receivedOrderWeight: submittedReceivedOrder.weight
            }
          : {}),
        ...(submittedInventoryPosting && inventoryPostingResult
          ? {
              finishedProductWeight: inventoryPostingResult.finishedProductWeight,
              inventoryLedgerIds: inventoryPostingResult.ledgerEntries.map((entry) => entry.id),
              inventoryPosted: true,
              inventoryPostedAt,
              receivedOrder: {
                status: "Received weight submitted",
                submittedAt: inventoryPostedAt,
                weight: inventoryPostingResult.finishedProductWeight
              },
              receivedOrderStatus: "Received weight submitted",
              receivedOrderSubmittedAt: inventoryPostedAt,
              receivedOrderWeight: inventoryPostingResult.finishedProductWeight,
              reusableBalanceWeight: inventoryPostingResult.reusableBalanceWeight,
              scrapLossWeight: inventoryPostingResult.scrapLossWeight
            }
          : {}),
        ...(details.castingIssue
          ? {
              castingIssue: details.castingIssue,
              finalStatus: "",
              isDamaged: Boolean(details.castingIssue.damaged),
              removedFromBoard: false
            }
          : {}),
        ...(shouldFinalizeDamagedTree
          ? {
              damagedTree: {
                ...(existingWorkflow.damagedTree || {}),
                addedAt: existingWorkflow.damagedTree?.addedAt || submittedAt,
                damageReason: submittedCastingIssue.damageReason || "",
                markedAt: submittedCastingIssue.submittedAt || "",
                reportedStage: stages[1]
              },
              finalStatus: "Damaged",
              isDamaged: true,
              removedFromBoard: true
            }
          : {}),
        updatedAt: submittedAt
      };

      setWorkflowById((currentState) => ({
        ...currentState,
        [selectedOrder.id]: nextWorkflow
      }));
      persistCastingWorkflowToBackend(selectedOrder, nextWorkflow, {
        action: shouldFinalizeDamagedTree ? "Damaged tree moved to damaged list" : "Stage submitted",
        details,
        fromStage: selectedOrder.stage,
        notes: notesValue.trim(),
        payload: {
          barcodeValue: selectedOrder.barcodeValue,
          internalTreeNumber: selectedOrder.orderCode,
          workflow: nextWorkflow
        },
        shouldFinalizeDamagedTree,
        submittedAt,
        submittedCastingIssue,
        toStage: shouldFinalizeDamagedTree ? "Damaged Trees" : nextStage
      });

      recordOrderAuditEvents({
        details,
        nextStage,
        notesValue,
        selectedOrder,
        shouldFinalizeDamagedTree,
        submittedCastingIssue
      });

      if (submittedReceivedOrder) {
        setError("");
        return;
      }

      if (submittedInventoryPosting) {
        setError("");
        return;
      }

      cancelOrder();
    }

    function returnSelectedOrderToAwaitingMetal(reason) {
      if (!selectedOrder) {
        setError("Order is no longer available.");
        return;
      }

      if (selectedOrder.stage !== stages[1]) {
        setError("Only Ready for Casting orders can be returned to Awaiting Metal.");
        return;
      }

      if (!canUseStage(selectedOrder.stage, "submitStage")) {
        recordAudit("Unauthorized access attempt", {
          barcodeValue: selectedOrder.barcodeValue,
          isInHouseProduction: selectedOrder.isInHouseProduction,
          module: "Casting Process",
          stage: getStageDisplayName(selectedOrder.stage),
          internalTreeNumber: selectedOrder.orderCode,
          notes: "Return to Awaiting Metal"
        });
        setError(permissionDeniedMessage);
        return;
      }

      const returnReason = String(reason || "").trim();
      if (!returnReason) {
        setError("Reason for return is required.");
        return;
      }

      const previousStage = stages[1];
      const newStage = stages[0];
      const returnedAt = new Date().toISOString();
      const returnEntry = {
        id: createId(),
        newStage,
        previousStage,
        reason: returnReason,
        returnedAt,
        userId: currentUser.id || "unknown",
        username: currentUser.username || currentUser.name || "Unknown User"
      };

      const existingWorkflow = workflowById[selectedOrder.id] || {};
      const nextWorkflow = {
        ...existingWorkflow,
        castingIssue: null,
        damagedTree: null,
        finalStatus: "",
        isDamaged: false,
        notes: "",
        removedFromBoard: false,
        returnHistory: [...(Array.isArray(existingWorkflow.returnHistory) ? existingWorkflow.returnHistory : []), returnEntry],
        stage: newStage,
        updatedAt: returnedAt
      };

      setWorkflowById((currentState) => ({
        ...currentState,
        [selectedOrder.id]: nextWorkflow
      }));
      persistCastingWorkflowToBackend(selectedOrder, nextWorkflow, {
        action: "Returned to Awaiting Metal",
        details: {},
        fromStage: previousStage,
        notes: returnReason,
        payload: returnEntry,
        submittedAt: returnedAt,
        toStage: newStage
      });

      recordAudit("Returned to Awaiting Metal", {
        barcodeValue: selectedOrder.barcodeValue,
        isInHouseProduction: selectedOrder.isInHouseProduction,
        internalTreeNumber: selectedOrder.orderCode,
        module: "Casting Process",
        notes: returnReason,
        oldValue: {
          stage: getStageDisplayName(previousStage)
        },
        newValue: {
          newStage: getStageDisplayName(newStage),
          previousStage: getStageDisplayName(previousStage),
          reason: returnReason,
          returnedAt
        },
        stage: getStageDisplayName(previousStage)
      });

      setDraftNotes("");
      setError("");
    }

    function recordOrderAuditEvents({
      details,
      nextStage,
      notesValue,
      selectedOrder,
      shouldFinalizeDamagedTree,
      submittedCastingIssue
    }) {
      const stageLabel = getStageDisplayName(selectedOrder.stage);
      const nextStageLabel = getStageDisplayName(nextStage);
      const baseDetails = {
        barcodeValue: selectedOrder.barcodeValue,
        isInHouseProduction: selectedOrder.isInHouseProduction,
        internalTreeNumber: selectedOrder.orderCode,
        module: "Casting Process",
        notes: notesValue,
        stage: stageLabel
      };

      if (details.metalIssue) {
        recordAudit("Awaiting Metal submitted", {
          ...baseDetails,
          newValue: details.metalIssue
        });
      }

      if (details.castingIssue) {
        recordAudit("Ready for Casting submitted", {
          ...baseDetails,
          newValue: details.castingIssue
        });

        if (details.castingIssue.damaged) {
          recordAudit("Damaged marked", {
            ...baseDetails,
            oldValue: Boolean(selectedOrder.castingIssue?.damaged),
            newValue: true
          });
        }
      }

      if (details.castingVerification) {
        recordAudit("Casting Completed submitted", {
          ...baseDetails,
          newValue: details.castingVerification
        });
      }

      if (details.qcVerification) {
        recordAudit("Quality Check and Control submitted", {
          ...baseDetails,
          newValue: details.qcVerification
        });
      }

      if (details.receivedOrder) {
        recordAudit("Received order weight submitted", {
          ...baseDetails,
          newValue: details.receivedOrder
        });
        return;
      }

      if (shouldFinalizeDamagedTree) {
        recordAudit("Damaged tree moved to damaged list", {
          ...baseDetails,
          newValue: submittedCastingIssue
        });
        return;
      }

      if (selectedOrder.stage !== nextStage) {
        recordAudit("Order moved between stages", {
          ...baseDetails,
          oldValue: stageLabel,
          newValue: nextStageLabel
        });
      }

      if (nextStage === stages[stages.length - 1]) {
        recordAudit("Order completed", {
          ...baseDetails,
          newValue: nextStageLabel,
          stage: nextStageLabel
        });
      }
    }

    if (!canViewCastingProcess) {
      return h(
        "section",
        {
          className:
            "kanban-shell min-h-[70vh] rounded-lg border border-production-line bg-white p-8 text-center text-sm font-bold text-production-muted shadow-[0_18px_45px_rgba(31,42,42,0.08)]"
        },
        permissionDeniedMessage
      );
    }

    return h(
      "section",
      {
        className:
          "kanban-shell flex min-h-[70vh] flex-col overflow-hidden rounded-lg border border-production-line bg-white shadow-[0_18px_45px_rgba(31,42,42,0.08)]"
      },
      h(
        "div",
        {
          className:
            "flex flex-col gap-3 border-b border-production-line px-5 py-4 lg:flex-row lg:items-center lg:justify-between"
        },
        h(
          "div",
          null,
          h("p", { className: "text-xs font-bold uppercase text-production-teal" }, "Order Processing")
        ),
        h(
          "div",
          { className: "flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end" },
          h("input", {
            className:
              "min-h-9 rounded-md border border-production-line bg-white px-3 text-xs font-bold text-production-ink outline-none focus:border-production-teal focus:ring-4 focus:ring-teal-100",
            onChange: (event) => setInternalTreeSearch(event.target.value),
            placeholder: "Search internal tree",
            type: "search",
            value: internalTreeSearch,
            "aria-label": "Search internal tree number"
          }),
          h(
            "label",
            {
              className: cx(
                "inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-xs font-bold",
                rushOnly
                  ? "border-amber-500 bg-amber-100 text-amber-800"
                  : "border-production-line bg-white text-production-ink hover:border-production-teal hover:text-production-teal"
              )
            },
            h("input", {
              checked: rushOnly,
              className: "h-4 w-4 accent-amber-500",
              onChange: (event) => setRushOnly(event.target.checked),
              type: "checkbox"
            }),
            "Rush Only"
          ),
          h(
            "span",
            {
              className:
                "rounded-full bg-production-soft px-3 py-2 text-xs font-bold text-production-teal"
            },
            `${boardOrders.length} ${boardOrders.length === 1 ? "order" : "orders"}`
          ),
          h(
            "button",
            {
              className:
                "min-h-9 rounded-md border border-production-line bg-white px-3 text-xs font-bold text-production-ink hover:border-production-teal hover:text-production-teal",
              onClick: openDamagedTrees,
              title: "Open damaged trees",
              type: "button"
            },
            "Damaged Trees"
          )
        )
      ),
      showDamagedTrees
        ? h(DamagedTreesView, {
            damagedTreeSearch,
            damagedTrees,
            filteredDamagedTrees,
            onClose: closeDamagedTrees,
            onSearchChange: setDamagedTreeSearch
          })
        : h(
            "div",
            { className: cx("kanban-board-scroll flex-1 bg-slate-100/70 p-4", isFocusedView && "is-focused") },
            h(
              "div",
              { className: cx("kanban-board-track", isFocusedView && "is-focused") },
              visibleStages.map((stage) =>
                h(
                  window.React.Fragment,
                  { key: stage },
                  h(StageColumn, {
                    activeOrderId: selectedOrderId,
                    activeStage,
                    hasSelection: isFocusedView,
                    onScanChange: updateScanValue,
                    onScanSubmit: scanBarcode,
                    onCloseOrder: cancelOrder,
                    orders: ordersByStage[stage],
                    onOpenOrder: openOrder,
                    scanStatus: scanMessages[stage],
                    scanValue: scanValues[stage] || "",
                    stage
                  }),
                  isFocusedView && selectedOrder.stage === stage
                    ? h(OrderDetailPanel, {
                        key: `${selectedOrder.id}-detail`,
                        draftNotes,
                        error,
                        onCancel: cancelOrder,
                        onDraftNotesChange: setDraftNotes,
                        onReturnToAwaitingMetal: returnSelectedOrderToAwaitingMetal,
                        onSubmit: submitOrder,
                        order: selectedOrder,
                        canEditStage: canUseStage(selectedOrder.stage, "edit"),
                        canMarkDamaged: canUseStage(selectedOrder.stage, "markDamaged"),
                        canPostFinalInventory: canPostFinalInventory(),
                        canSubmitStage: canUseStage(selectedOrder.stage, "submitStage")
                      })
                    : null
                )
              )
            )
          )
    );
  }

  function StageColumn({
    activeOrderId,
    activeStage,
    hasSelection,
    onOpenOrder,
    onCloseOrder,
    onScanChange,
    onScanSubmit,
    orders,
    scanStatus,
    scanValue,
    stage
  }) {
    const isActiveStage = activeStage === stage;
    const isCompressed = hasSelection && !isActiveStage;
    const activeOrder = activeOrderId ? orders.find((order) => order.id === activeOrderId) : null;
    const displayOrders = activeOrder ? [activeOrder, ...orders.filter((order) => order.id !== activeOrderId)] : orders;

    return h(
      "section",
      {
        className: cx(
          "kanban-column rounded-lg border border-slate-300 bg-white p-3 shadow-[0_10px_24px_rgba(31,42,42,0.08)]",
          isActiveStage && "is-active-stage border-production-teal bg-teal-50/70 shadow-[0_14px_32px_rgba(18,117,111,0.14)]",
          isCompressed && "is-compressed"
        )
      },
      h(
        "header",
        { className: "mb-3 flex items-start justify-between gap-3" },
        h(
          "div",
          null,
          h("h3", { className: "text-sm font-bold text-production-ink" }, getStageDisplayName(stage)),
          h("p", { className: "mt-1 text-xs font-bold text-production-muted" }, `${orders.length} orders`)
        ),
        h(
          "span",
          {
            className:
              "rounded-full border border-production-line bg-white px-2 py-1 text-xs font-bold text-production-muted"
          },
          String(stages.indexOf(stage) + 1).padStart(2, "0")
        )
      ),
      h(StageScanField, {
        onScanChange,
        onScanSubmit,
        scanStatus,
        scanValue,
        stage
      }),
      h(
        "div",
        { className: "kanban-card-list space-y-3" },
        displayOrders.length
          ? displayOrders.map((order) =>
              h(OrderCard, {
                isActive: activeOrderId === order.id,
                key: order.id,
                onClose: onCloseOrder,
                onOpen: onOpenOrder,
                order
              })
            )
          : h(
              "div",
              {
                className:
                  "rounded-lg border border-dashed border-slate-300 bg-white/70 p-4 text-center text-xs font-bold text-slate-400"
              },
              "No orders"
            )
      )
    );
  }

  function StageScanField({ onScanChange, onScanSubmit, scanStatus, scanValue, stage }) {
    const stageLabel = getStageDisplayName(stage);

    return h(
      "div",
      { className: "mb-3" },
      h(
        "div",
        {
          className:
            "flex min-h-10 items-center rounded-lg border border-production-line bg-white shadow-sm focus-within:border-production-teal focus-within:ring-4 focus-within:ring-teal-100"
        },
        h("input", {
          className:
            "min-w-0 flex-1 rounded-l-lg border-0 bg-transparent px-3 py-2 text-sm font-bold text-production-ink outline-none placeholder:text-slate-400",
          onChange: (event) => onScanChange(stage, event.target.value),
          onKeyDown: (event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onScanSubmit(stage);
            }
          },
          placeholder: "Scan barcode",
          type: "search",
          value: scanValue,
          "aria-label": `Scan barcode for ${stageLabel}`
        }),
        h(
          "button",
          {
            className:
              "kanban-scan-button flex h-10 w-10 shrink-0 items-center justify-center rounded-r-lg border-l border-production-line bg-production-soft text-production-teal hover:bg-white",
            onClick: () => onScanSubmit(stage),
            title: "Search barcode",
            type: "button",
            "aria-label": `Search barcode in ${stageLabel}`
          },
          h("span", { className: "kanban-search-icon", "aria-hidden": "true" })
        )
      ),
      scanStatus
        ? h(
            "p",
            { className: cx("kanban-scan-message mt-2 rounded-md px-2 py-1 text-xs font-bold", getScanMessageClass(scanStatus.type)) },
            scanStatus.message
          )
        : null
    );
  }

  function getScanMessageClass(type) {
    if (type === "success") {
      return "border border-emerald-200 bg-emerald-50 text-emerald-700";
    }

    if (type === "warning") {
      return "border border-amber-200 bg-amber-50 text-amber-700";
    }

    if (type === "error") {
      return "border border-red-200 bg-red-50 text-red-700";
    }

    return "border border-slate-200 bg-white text-production-muted";
  }

  function InHouseProductionBadge({ isVisible }) {
    return isVisible ? h("span", { className: "in-house-badge" }, "In-House Prod") : null;
  }

  function OrderCodeWithBadges({ className = "", orderCode, showInHouse }) {
    return h(
      "span",
      { className: cx("inline-flex min-w-0 flex-wrap items-center gap-2", className) },
      h("span", { className: "truncate" }, orderCode),
      h(InHouseProductionBadge, { isVisible: showInHouse })
    );
  }

  function DamagedTreesView({ damagedTreeSearch, damagedTrees, filteredDamagedTrees, onClose, onSearchChange }) {
    const [expandedTreeId, setExpandedTreeId] = useState(null);

    function toggleExpandedTree(itemId) {
      setExpandedTreeId((currentId) => (currentId === itemId ? null : itemId));
    }

    return h(
      "section",
      { className: "p-4" },
      h(
        "div",
        { className: "rounded-lg border border-production-line bg-white p-5" },
        h(
          "div",
          { className: "flex flex-col gap-4 border-b border-production-line pb-4 lg:flex-row lg:items-center lg:justify-between" },
          h(
            "div",
            null,
            h("p", { className: "text-xs font-bold uppercase text-production-teal" }, "Damaged Trees"),
            h(
              "p",
              { className: "mt-1 text-sm font-bold text-production-muted" },
              `${damagedTrees.length} ${damagedTrees.length === 1 ? "tree" : "trees"} recorded`
            )
          ),
          h(
            "div",
            { className: "flex flex-col gap-3 sm:flex-row sm:items-center" },
            h("input", {
              className:
                "min-h-10 rounded-md border border-production-line bg-white px-3 text-sm font-bold text-production-ink outline-none focus:border-production-teal focus:ring-4 focus:ring-teal-100",
              onChange: (event) => onSearchChange(event.target.value),
              placeholder: "Search damaged trees",
              type: "search",
              value: damagedTreeSearch
            }),
            h(
              "button",
              {
                className:
                  "min-h-10 rounded-md border border-production-line bg-white px-4 font-bold text-production-muted hover:bg-slate-50",
                onClick: onClose,
                type: "button"
              },
              "Back to Board"
            )
          )
        ),
        filteredDamagedTrees.length
          ? h(
              "div",
              { className: "mt-5 overflow-x-auto" },
              h(
                "div",
                { className: "damaged-tree-list overflow-hidden rounded-lg border border-production-line" },
                h(
                  "div",
                  {
                    className:
                      "grid grid-cols-[40px_1fr_1fr_2fr_1.2fr] gap-3 border-b border-production-line bg-slate-50 px-4 py-3 text-xs font-bold uppercase text-production-muted"
                  },
                  h("span", null, ""),
                  h("span", null, "Internal Tree Number"),
                  h("span", null, "Metal KT and Color"),
                  h("span", null, "Damage Reason"),
                  h("span", null, "Date and Time")
                ),
                h(
                  "div",
                  { className: "divide-y divide-production-line" },
                  filteredDamagedTrees.map((item) =>
                    h(DamagedTreeRow, {
                      isExpanded: expandedTreeId === item.id,
                      item,
                      key: item.id,
                      onToggle: () => toggleExpandedTree(item.id)
                    })
                  )
                )
              )
            )
          : h(
              "div",
              {
                className:
                  "mt-5 rounded-lg border border-dashed border-production-line bg-slate-50 p-8 text-center text-sm font-bold text-production-muted"
              },
              "No damaged trees found."
            )
      )
    );
  }

  function DamagedTreeRow({ isExpanded, item, onToggle }) {
    return h(
      "div",
      null,
      h(
        "div",
        {
          className:
            "grid grid-cols-[40px_1fr_1fr_2fr_1.2fr] gap-3 bg-white px-4 py-3 text-sm font-bold text-production-ink hover:bg-slate-50"
        },
        h(
          "button",
          {
            className:
              "h-7 w-7 rounded-md border border-production-line bg-production-soft text-base font-bold leading-none text-production-teal hover:border-production-teal hover:bg-white",
            onClick: onToggle,
            title: isExpanded ? "Collapse damaged tree details" : "Expand damaged tree details",
            type: "button",
            "aria-expanded": String(isExpanded)
          },
          isExpanded ? "-" : "+"
        ),
        h(OrderCodeWithBadges, {
          className: "min-w-0",
          orderCode: item.orderCode,
          showInHouse: item.isInHouseProduction
        }),
        h("span", { className: "truncate" }, item.metalDisplay),
        h("span", { className: "truncate", title: item.damageReason || "No reason entered" }, item.damageReason || "No reason entered"),
        h("span", { className: "truncate text-production-muted" }, formatDateTime(item.markedAt))
      ),
      h(
        "div",
        {
          className: cx(
            "damaged-tree-expanded overflow-hidden bg-slate-50 transition-all duration-200 ease-out",
            isExpanded ? "max-h-[420px] border-t border-production-line opacity-100" : "max-h-0 opacity-0"
          )
        },
        isExpanded
          ? h(
              "div",
              { className: "grid gap-3 p-4 text-sm md:grid-cols-2 xl:grid-cols-3" },
              h(DetailFact, {
                label: "Internal Tree Number",
                value: h(OrderCodeWithBadges, {
                  orderCode: item.orderCode,
                  showInHouse: item.isInHouseProduction
                })
              }),
              h(DetailFact, { label: "Barcode Value", value: item.barcodeValue || "Not available" }),
              h(DetailFact, { label: "Customer / Order Reference", value: item.reference }),
              h(DetailFact, { label: "Metal KT and Color", value: item.metalDisplay }),
              h(DetailFact, { label: "Wax Weight", value: item.weightDisplay }),
              h(DetailFact, { label: "Damage Reason", value: item.damageReason || "No reason entered" }),
              h(DetailFact, { label: "Stage Where Damaged Was Reported", value: getStageDisplayName(item.reportedStage) }),
              h(DetailFact, { label: "Current Order Stage", value: getStageDisplayName(item.currentStage) }),
              h(DetailFact, { label: "Date and Time Marked Damaged", value: formatDateTime(item.markedAt) }),
              h(DetailFact, { label: "Notes / Remarks", value: item.notes || "No additional details" })
            )
          : null
      )
    );
  }

  function OrderCard({ isActive, onClose, onOpen, order }) {
    const buttonLabel = isActive ? "-" : "+";

    return h(
      "article",
      {
        className: cx(
          "kanban-card rounded-lg border bg-white p-3 shadow-sm",
          isActive ? "is-active border-production-teal" : "border-slate-200 hover:border-production-teal"
        )
      },
      h(
        "div",
        { className: "mb-3 flex items-start justify-between gap-3" },
        h(
          "div",
          { className: "min-w-0" },
          h("p", { className: "text-[10px] font-bold uppercase text-production-muted" }, "Internal Tree Number"),
          h(
            "div",
            { className: "mt-1 flex min-w-0 flex-wrap items-center gap-2" },
            h("p", { className: "truncate text-lg font-bold text-production-ink" }, order.orderCode),
            order.isRush ? h("span", { className: "kanban-rush-badge" }, "Rush") : null
          ),
          h("p", { className: "kanban-card-secondary mt-1 text-xs font-bold text-production-muted" }, order.reference)
        ),
        h(
          "button",
          {
            className:
              "h-8 w-8 shrink-0 rounded-md border border-production-line bg-production-soft text-base font-bold text-production-teal hover:border-production-teal hover:bg-white",
            onClick: () => {
              if (isActive) {
                onClose();
                return;
              }

              onOpen(order);
            },
            title: isActive ? "Close order" : "Open order",
            type: "button",
            "aria-label": `${isActive ? "Close" : "Open"} order ${order.orderCode}`
          },
          buttonLabel
        )
      ),
      h(
        "dl",
        { className: "space-y-2 text-xs" },
        h(CardFact, { label: "Metal", value: order.metalDisplay }),
        h(CardFact, { label: "Wax Weight", value: order.weightDisplay })
      )
    );
  }

  function CardFact({ label, value }) {
    return h(
      "div",
      { className: "flex items-center justify-between gap-3" },
      h("dt", { className: "font-bold text-production-muted" }, label),
      h("dd", { className: "text-right font-bold text-production-ink" }, value)
    );
  }

  function OrderDetailPanel(props) {
    if (props.order.stage === stages[0]) {
      return h(AwaitingMetalPanel, props);
    }

    if (props.order.stage === stages[1]) {
      return h(ReadyForCastingPanel, props);
    }

    if (props.order.stage === stages[2]) {
      return h(CastingCompletedPanel, props);
    }

    if (props.order.stage === stages[3]) {
      return h(QCCompletedPanel, props);
    }

    if (props.order.stage === stages[4]) {
      return h(OrderCompletedPanel, props);
    }

    return h(GenericStagePanel, props);
  }

  function AwaitingMetalPanel({ canEditStage = true, canSubmitStage = true, onCancel, onSubmit, order }) {
    const reference = calculateMetalReference(order);
    const metalIssueLabels = getMetalIssueLabels(order.metalKt);
    const savedMetalIssue = order.metalIssue || {};
    const [metalSource, setMetalSource] = useState(savedMetalIssue.source || metalSourceOptions[0].value);
    const [actualWeights, setActualWeights] = useState({
      alloyWeight: savedMetalIssue.alloyWeight || "",
      fineGoldWeight: savedMetalIssue.fineGoldWeight || "",
      recycledWeight: savedMetalIssue.recycledWeight || ""
    });
    const [recycledMetalKt, setRecycledMetalKt] = useState(savedMetalIssue.recycledMetalKt || order.recycledMetalKt || "");
    const [validationMessages, setValidationMessages] = useState([]);

    useEffect(() => {
      const currentMetalIssue = order.metalIssue || {};
      setMetalSource(currentMetalIssue.source || metalSourceOptions[0].value);
      setActualWeights({
        alloyWeight: currentMetalIssue.alloyWeight || "",
        fineGoldWeight: currentMetalIssue.fineGoldWeight || "",
        recycledWeight: currentMetalIssue.recycledWeight || ""
      });
      setRecycledMetalKt(currentMetalIssue.recycledMetalKt || order.recycledMetalKt || "");
      setValidationMessages([]);
    }, [order.id, order.metalIssue, order.recycledMetalKt]);

    const requiredFields = requiredActualWeightsBySource[metalSource] || requiredActualWeightsBySource.fineGoldAlloy;
    const isFineGoldAlloySource = metalSource === "fineGoldAlloy";
    const isRecycledOnlySource = metalSource === "recycled";
    const isMixedSource = metalSource === "mixed";
    const showFineGold = requiredFields.includes("fineGoldWeight");
    const showAlloy = requiredFields.includes("alloyWeight");
    const showRecycled = requiredFields.includes("recycledWeight");
    const effectiveRecycledMetalKt = isRecycledOnlySource ? order.metalKt || "" : recycledMetalKt;
    const recycledMetalColor = showRecycled ? order.color || "" : "";
    const mixedReference = isMixedSource
      ? calculateMixedMetalReference({
          order,
          recycledKt: recycledMetalKt,
          recycledWeight: actualWeights.recycledWeight,
          reference
        })
      : null;
    const suggestedFineGoldRequired = isMixedSource
      ? mixedReference?.additionalFineGoldRequired
      : isFineGoldAlloySource
        ? reference.requiredFineGold
        : null;
    const suggestedAlloyRequired = isMixedSource
      ? mixedReference?.additionalAlloyRequired
      : isFineGoldAlloySource
        ? reference.requiredAlloy
        : null;
    const actualTotalWeight = calculateActualTotalWeight(actualWeights, requiredFields);
    const submittedTotalIssuedWeight = roundWeightValue(actualTotalWeight);
    const excessRecycledWeight = showRecycled
      ? calculateExcessRecycledWeight(actualWeights.recycledWeight, reference.metalWeightRequired)
      : 0;
    const totalWeightDifference = Number.isFinite(reference.metalWeightRequired)
      ? roundWeightValue(actualTotalWeight - reference.metalWeightRequired)
      : null;
    const warningMessages = [];
    const formulaText =
      isSilver925Metal(order.metalKt) && isFineGoldAlloySource
        ? "Fine Silver Required = Total Metal Required x 0.925; Alloy Required = Total Metal Required x 0.075."
        : "";
    if (isRecycledOnlySource && excessRecycledWeight > 0) {
      warningMessages.push("Recycled weight is higher than required metal weight.");
      warningMessages.push(`Excess Recycled Weight: ${formatReferenceWeight(excessRecycledWeight)}`);
    }
    if (totalWeightDifference !== null && actualTotalWeight > 0 && Math.abs(totalWeightDifference) > 0.01) {
      warningMessages.push(
        `Total weight differs from required metal weight by ${formatReferenceWeight(Math.abs(totalWeightDifference))}.`
      );
    }
    const isSubmitDisabled = actualTotalWeight <= 0 || !canEditStage || !canSubmitStage;

    function updateActualWeight(field, value) {
      if (!canEditStage) return;

      setActualWeights((currentWeights) => ({
        ...currentWeights,
        [field]: value
      }));
      setValidationMessages([]);
    }

    function updateRecycledMetalKt(value) {
      if (!canEditStage) return;

      setRecycledMetalKt(value);
      setValidationMessages([]);
    }

    function validateMetalIssue() {
      const messages = [];
      const recycledWeight = parseSubmittedWeight(actualWeights.recycledWeight);
      const mixedRecycledReady =
        !isMixedSource || (recycledWeight !== null && recycledWeight > 0 && String(effectiveRecycledMetalKt || "").trim());

      requiredFields.forEach((field) => {
        const rawValue = String(actualWeights[field] || "").trim();
        const parsedValue = Number.parseFloat(rawValue);
        if (isMixedSource && (field === "fineGoldWeight" || field === "alloyWeight") && !mixedRecycledReady) {
          return;
        }
        const isOptionalZeroTopUp =
          isMixedSource &&
          (field === "fineGoldWeight" || field === "alloyWeight") &&
          Number.isFinite(field === "fineGoldWeight" ? suggestedFineGoldRequired : suggestedAlloyRequired) &&
          (field === "fineGoldWeight" ? suggestedFineGoldRequired : suggestedAlloyRequired) <= 0;

        if (!rawValue) {
          if (isOptionalZeroTopUp) {
            return;
          }
          messages.push(`Enter ${getActualWeightLabel(field, metalIssueLabels)}.`);
          return;
        }

        if (!Number.isFinite(parsedValue) || parsedValue < 0) {
          messages.push(`${getActualWeightLabel(field, metalIssueLabels)} must be zero or greater.`);
          return;
        }

        if (!isOptionalZeroTopUp && parsedValue <= 0) {
          messages.push(`${getActualWeightLabel(field, metalIssueLabels)} must be greater than 0.`);
        }
      });

      if (showRecycled && recycledWeight !== null && recycledWeight > 0 && !String(effectiveRecycledMetalKt || "").trim()) {
        messages.push(isRecycledOnlySource ? "Order Metal KT is required for recycled metal." : "Select Recycled Metal KT.");
      }

      return messages;
    }

    function submitMetalIssue() {
      if (!canSubmitStage) {
        setValidationMessages([permissionDeniedMessage]);
        return;
      }

      const messages = validateMetalIssue();

      if (messages.length) {
        setValidationMessages(messages);
        return;
      }

      onSubmit({
        metalIssue: {
          alloyWeight: showAlloy ? String(actualWeights.alloyWeight).trim() : "",
          excessRecycledWeight: showRecycled ? excessRecycledWeight : "",
          color: order.color || "",
          actualFineMetalWeight: showFineGold ? String(actualWeights.fineGoldWeight).trim() : "",
          alloyLabel: metalIssueLabels.alloyName,
          fineGoldWeight: showFineGold ? String(actualWeights.fineGoldWeight).trim() : "",
          fineMetalLabel: metalIssueLabels.fineMetalLabel,
          fineMetalPurityFraction: Number.isFinite(reference.purityFraction) ? reference.purityFraction : "",
          metalKt: order.metalKt || "",
          metalType: metalIssueLabels.metalType,
          purity: isSilver925Metal(order.metalKt) ? "925 Silver" : order.metalKt || "",
          recycledMetalColor: recycledMetalColor,
          recycledMetalKt: showRecycled ? String(effectiveRecycledMetalKt).trim() : "",
          recycledWeight: showRecycled ? String(actualWeights.recycledWeight).trim() : "",
          referenceAlloy: Number.isFinite(suggestedAlloyRequired) ? suggestedAlloyRequired.toFixed(3) : "",
          referenceFineMetal: Number.isFinite(suggestedFineGoldRequired) ? suggestedFineGoldRequired.toFixed(3) : "",
          referenceFineGold: Number.isFinite(suggestedFineGoldRequired) ? suggestedFineGoldRequired.toFixed(3) : "",
          suggestedAlloyRequired: Number.isFinite(suggestedAlloyRequired) ? suggestedAlloyRequired.toFixed(3) : "",
          suggestedFineMetalRequired: Number.isFinite(suggestedFineGoldRequired) ? suggestedFineGoldRequired.toFixed(3) : "",
          suggestedFineGoldRequired: Number.isFinite(suggestedFineGoldRequired) ? suggestedFineGoldRequired.toFixed(3) : "",
          targetAlloyRequired: Number.isFinite(reference.requiredAlloy) ? reference.requiredAlloy.toFixed(3) : "",
          targetFineMetalRequired: Number.isFinite(reference.requiredFineMetal) ? reference.requiredFineMetal.toFixed(3) : "",
          targetFineGoldRequired: Number.isFinite(reference.requiredFineGold) ? reference.requiredFineGold.toFixed(3) : "",
          targetPureMetalRequired: Number.isFinite(mixedReference?.targetFineMetalRequired)
            ? mixedReference.targetFineMetalRequired.toFixed(3)
            : "",
          targetPureGoldRequired: Number.isFinite(mixedReference?.targetPureGoldRequired)
            ? mixedReference.targetPureGoldRequired.toFixed(3)
            : "",
          metalWeightRequired: Number.isFinite(reference.metalWeightRequired) ? reference.metalWeightRequired.toFixed(3) : "",
          source: metalSource,
          sourceLabel: getMetalSourceLabel(metalSource, metalIssueLabels),
          metalSourceType: metalSource,
          submittedAt: new Date().toISOString(),
          totalIssuedWeight: submittedTotalIssuedWeight,
          waxWeight: order.waxWeight || ""
        }
      });
    }

    return h(
      "aside",
      {
        className:
          "kanban-detail-panel flex min-h-[62vh] flex-col rounded-lg border border-production-teal bg-white p-6 shadow-[0_18px_45px_rgba(18,117,111,0.18)] lg:p-8"
      },
      h(
        "div",
        { className: "mb-6 border-b border-production-line pb-5" },
        h(
          "div",
          { className: "flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between" },
          h(
            "div",
            { className: "min-w-0" },
            h("p", { className: "text-xs font-bold uppercase text-production-teal" }, "Focused Order"),
            h("h3", { className: "mt-2 text-3xl font-bold text-production-ink" }, h(OrderCodeWithBadges, {
              orderCode: order.orderCode,
              showInHouse: order.isInHouseProduction
            }))
          ),
          h(
            "button",
            {
              className:
                "min-h-10 rounded-md border border-production-line bg-white px-4 font-bold text-production-muted hover:bg-slate-50",
              onClick: onCancel,
              type: "button"
            },
            "Back to Board"
          )
        ),
        h(
          "div",
          { className: "mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3" },
          h(SummaryPill, { label: "Wax Weight", value: order.weightDisplay }),
          h(SummaryPill, { label: "Metal KT and Color", value: order.metalDisplay }),
          h(SummaryPill, {
            label: "Metal Weight Required",
            value: formatReferenceWeight(reference.metalWeightRequired)
          })
        )
      ),
      h(
        "section",
        { className: "rounded-xl border border-production-line bg-slate-50 p-4 lg:p-5" },
        h("h4", { className: "text-sm font-bold uppercase text-production-muted" }, "Metal Source"),
        h(
          "div",
          { className: "mt-3 grid gap-2 lg:grid-cols-3", role: "radiogroup", "aria-label": "Metal source selection" },
          metalSourceOptions.map((option) =>
            h(
              "button",
              {
                "aria-checked": metalSource === option.value,
                className: cx(
                  "min-h-12 rounded-lg border px-4 text-sm font-bold transition",
                  metalSource === option.value
                    ? "border-production-teal bg-production-teal text-white shadow-sm"
                    : "border-production-line bg-white text-production-ink hover:border-production-teal"
                ),
                key: option.value,
                onClick: () => {
                  if (!canEditStage) return;

                  setMetalSource(option.value);
                  if (option.value === "recycled") {
                    setRecycledMetalKt(order.metalKt || "");
                  }
                  setValidationMessages([]);
                },
                role: "radio",
                disabled: !canEditStage,
                type: "button"
              },
              option.value === "fineGoldAlloy" ? metalIssueLabels.sourceOptionLabel : option.label
            )
          )
        )
      ),
      h(
        "section",
        { className: "mt-5 rounded-xl border border-production-line bg-white p-4 lg:p-5" },
        h("h4", { className: "text-sm font-bold uppercase text-production-muted" }, "Required / Reference"),
        h(
          "div",
          { className: "mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-3" },
          h(ReferenceValue, {
            label: "Required Metal Weight",
            value: formatReferenceWeight(reference.metalWeightRequired)
          }),
          isFineGoldAlloySource
            ? h(ReferenceValue, {
                label: metalIssueLabels.fineMetalRequiredLabel,
                value: formatReferenceWeight(reference.requiredFineGold)
              })
            : null,
          isFineGoldAlloySource
            ? h(ReferenceValue, {
                label: metalIssueLabels.alloyRequiredLabel,
                value: formatReferenceWeight(reference.requiredAlloy)
              })
            : null
        ),
        h(
          "p",
          { className: "mt-3 text-xs font-bold text-production-muted" },
          `Based on ${order.weightDisplay}, ${order.metalDisplay}.`
        ),
        formulaText
          ? h("p", { className: "mt-2 text-xs font-bold text-production-teal" }, formulaText)
          : null
      ),
      h(
        "section",
        { className: "mt-5 rounded-xl border border-production-line bg-white p-4 lg:p-5" },
        h("h4", { className: "text-sm font-bold uppercase text-production-muted" }, "Actual Issued"),
        h(
          "div",
          { className: "mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-3" },
          showRecycled
            ? h(RecycledMetalInput, {
                disabled: !canEditStage,
                isKtLocked: isRecycledOnlySource,
                ktOptions: recycledMetalKtOptions,
                onKtChange: updateRecycledMetalKt,
                onWeightChange: (value) => updateActualWeight("recycledWeight", value),
                recycledColor: recycledMetalColor,
                recycledKt: effectiveRecycledMetalKt,
                title: isMixedSource ? "Step 1: Recycled Metal" : "Recycled Metal",
                weight: actualWeights.recycledWeight
              })
            : null,
          isMixedSource
            ? h(MixedMetalReferencePanel, {
                labels: metalIssueLabels,
                mixedReference,
                suggestedAlloyRequired,
                suggestedFineGoldRequired
              })
            : null,
          showFineGold
            ? h(ActualWeightInput, {
                label: isMixedSource
                  ? metalIssueLabels.actualFineMetalTopUpWeightLabel
                  : metalIssueLabels.actualFineMetalWeightLabel,
                disabled: !canEditStage,
                onChange: (value) => updateActualWeight("fineGoldWeight", value),
                value: actualWeights.fineGoldWeight
              })
            : null,
          showAlloy
            ? h(ActualWeightInput, {
                label: isMixedSource
                  ? metalIssueLabels.actualAlloyTopUpWeightLabel
                  : metalIssueLabels.actualAlloyWeightLabel,
                disabled: !canEditStage,
                onChange: (value) => updateActualWeight("alloyWeight", value),
                value: actualWeights.alloyWeight
              })
            : null
        ),
        h(
          "div",
          { className: "mt-4 rounded-lg border border-production-teal bg-production-soft px-4 py-3" },
          h(
            "div",
            { className: "flex items-center justify-between gap-4" },
            h("span", { className: "text-sm font-bold uppercase text-production-teal" }, "Total Weight"),
            h("span", { className: "text-xl font-bold text-production-ink" }, formatActualTotalWeight(actualTotalWeight))
          )
        )
      ),
      warningMessages.length
        ? h(
            "div",
            { className: "mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800" },
            warningMessages.map((message) => h("p", { key: message }, message))
          )
        : null,
      validationMessages.length
        ? h(
            "div",
            { className: "mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700" },
            validationMessages.map((message) => h("p", { key: message }, message))
          )
        : null,
      h(
        "div",
        { className: "mt-auto flex flex-col-reverse gap-3 border-t border-production-line pt-6 sm:flex-row sm:justify-end" },
        h(
          "button",
          {
            className:
              "min-h-12 rounded-md border border-production-line bg-white px-6 font-bold text-production-muted hover:bg-slate-50",
            onClick: onCancel,
            type: "button"
          },
          "Cancel"
        ),
        h(
          "button",
          {
            "aria-disabled": String(isSubmitDisabled),
            className: cx(
              "min-h-12 rounded-md px-8 font-bold text-white",
              isSubmitDisabled
                ? "cursor-not-allowed bg-slate-300 hover:bg-slate-300"
                : "bg-production-teal hover:bg-[#0c5853]"
            ),
            disabled: isSubmitDisabled,
            onClick: submitMetalIssue,
            title: !canSubmitStage
              ? "Submit stage permission required"
              : isSubmitDisabled
                ? "Enter actual issued weight before submitting"
                : "Submit metal issue",
            type: "button"
          },
          "Submit"
        )
      )
    );
  }

  function ReadyForCastingPanel({
    canEditStage = true,
    canMarkDamaged = true,
    canSubmitStage = true,
    draftNotes,
    onCancel,
    onDraftNotesChange,
    onReturnToAwaitingMetal,
    onSubmit,
    order
  }) {
    const savedCastingIssue = order.castingIssue || {};
    const savedChecklist = savedCastingIssue.checklist || {};
    const [checklist, setChecklist] = useState({
      flaskTemperatureChecked: Boolean(savedChecklist.flaskTemperatureChecked),
      metalChecked: Boolean(savedChecklist.metalChecked),
      weightChecked: Boolean(savedChecklist.weightChecked)
    });
    const [damaged, setDamaged] = useState(Boolean(savedCastingIssue.damaged));
    const [damageReason, setDamageReason] = useState(savedCastingIssue.damageReason || "");
    const [showReturnModal, setShowReturnModal] = useState(false);
    const [returnReason, setReturnReason] = useState("");
    const [returnValidationMessage, setReturnValidationMessage] = useState("");
    const [validationMessage, setValidationMessage] = useState("");

    useEffect(() => {
      const currentCastingIssue = order.castingIssue || {};
      const currentChecklist = currentCastingIssue.checklist || {};

      setChecklist({
        flaskTemperatureChecked: Boolean(currentChecklist.flaskTemperatureChecked),
        metalChecked: Boolean(currentChecklist.metalChecked),
        weightChecked: Boolean(currentChecklist.weightChecked)
      });
      setDamaged(Boolean(currentCastingIssue.damaged));
      setDamageReason(currentCastingIssue.damageReason || "");
      setShowReturnModal(false);
      setReturnReason("");
      setReturnValidationMessage("");
      setValidationMessage("");
    }, [order.id, order.castingIssue]);

    const allChecklistComplete = castingChecklistItems.every((item) => checklist[item.field]);
    const checklistValidationMessage =
      validationMessage || (!allChecklistComplete ? "Please complete all required casting checklist items." : "");
    const totalIssuedWeightDisplay = formatSavedTotalIssuedWeight(order.totalIssuedWeight);

    function updateChecklist(field, checked) {
      if (!canEditStage) return;

      setChecklist((currentChecklist) => ({
        ...currentChecklist,
        [field]: checked
      }));
      setValidationMessage("");
    }

    function toggleDamaged() {
      if (!canMarkDamaged) {
        setValidationMessage(permissionDeniedMessage);
        return;
      }
      if (!canEditStage) return;

      setDamaged((currentValue) => !currentValue);
      setValidationMessage("");
    }

    function submitCasting() {
      if (!canEditStage || !canSubmitStage) {
        setValidationMessage(permissionDeniedMessage);
        return;
      }

      if (!allChecklistComplete) {
        setValidationMessage("Please complete all required casting checklist items.");
        return;
      }

      onSubmit({
        castingIssue: {
          checklist: {
            flaskTemperatureChecked: Boolean(checklist.flaskTemperatureChecked),
            metalChecked: Boolean(checklist.metalChecked),
            weightChecked: Boolean(checklist.weightChecked)
          },
          damaged,
          damageReason: damaged ? damageReason.trim() : "",
          submittedAt: new Date().toISOString()
        },
        notes: draftNotes
      });
    }

    function openReturnModal() {
      if (!canEditStage || !canSubmitStage) {
        setValidationMessage(permissionDeniedMessage);
        return;
      }

      setReturnReason("");
      setReturnValidationMessage("");
      setShowReturnModal(true);
    }

    function closeReturnModal() {
      setShowReturnModal(false);
      setReturnReason("");
      setReturnValidationMessage("");
    }

    function confirmReturn() {
      const trimmedReason = returnReason.trim();
      if (!trimmedReason) {
        setReturnValidationMessage("Reason for Return is required.");
        return;
      }

      if (typeof onReturnToAwaitingMetal === "function") {
        onReturnToAwaitingMetal(trimmedReason);
      }
    }

    return h(
      "aside",
      {
        className:
          "kanban-detail-panel flex min-h-[62vh] flex-col rounded-lg border border-production-teal bg-white p-6 shadow-[0_18px_45px_rgba(18,117,111,0.18)] lg:p-8"
      },
      h(
        "div",
        { className: "mb-6 flex flex-col gap-4 border-b border-production-line pb-5 lg:flex-row lg:items-start lg:justify-between" },
        h(
          "div",
          { className: "min-w-0" },
          h("p", { className: "text-xs font-bold uppercase text-production-teal" }, "Focused Order"),
          h("h3", { className: "mt-2 text-3xl font-bold text-production-ink" }, h(OrderCodeWithBadges, {
            orderCode: order.orderCode,
            showInHouse: order.isInHouseProduction
          }))
        ),
        h(
          "button",
          {
            className:
              "min-h-10 rounded-md border border-production-line bg-white px-4 font-bold text-production-muted hover:bg-slate-50",
            onClick: onCancel,
            type: "button"
          },
          "Back to Board"
        )
      ),
      h(
        "dl",
        { className: "grid gap-4 text-sm md:grid-cols-2 xl:grid-cols-6" },
        h(DetailFact, {
          label: "Internal Tree Number",
          value: h(OrderCodeWithBadges, {
            orderCode: order.orderCode,
            showInHouse: order.isInHouseProduction
          })
        }),
        h(DetailFact, { label: "Barcode Value", value: order.barcodeValue || "Not available" }),
        h(DetailFact, { label: "Metal KT and Color", value: order.metalDisplay }),
        h(DetailFact, { label: "Wax Weight", value: order.weightDisplay }),
        h(DetailFact, { label: "Customer / Order Reference", value: order.reference }),
        h(DetailFact, { label: "Current Stage", value: getStageDisplayName(order.stage) })
      ),
      h(
        "section",
        { className: "mt-6 rounded-xl border border-production-line bg-slate-50 p-4 lg:p-5" },
        h(
          "div",
          { className: "flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between" },
          h("h4", { className: "text-sm font-bold uppercase text-production-muted" }, "Casting Checklist"),
          h(
            "span",
            { className: "rounded-full border border-production-line bg-white px-3 py-1 text-xs font-bold text-production-muted" },
            "All items required"
          )
        ),
        h(
          "div",
          {
            className:
              "mt-4 flex flex-col gap-1 rounded-lg border border-production-teal bg-production-soft px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
          },
          h("span", { className: "text-xs font-bold uppercase text-production-teal" }, "Total Issued Weight"),
          h("span", { className: "text-lg font-bold text-production-ink" }, totalIssuedWeightDisplay)
        ),
        h(
          "div",
          { className: "mt-3 grid gap-3 lg:grid-cols-3" },
          castingChecklistItems.map((item) =>
            h(CastingChecklistItem, {
              checked: Boolean(checklist[item.field]),
              disabled: !canEditStage,
              key: item.field,
              label: item.label,
              onChange: (checked) => updateChecklist(item.field, checked)
            })
          )
        )
      ),
      h(
        "section",
        {
          className: cx(
            "mt-5 rounded-xl border p-4 lg:p-5",
            damaged ? "border-amber-300 bg-amber-50" : "border-production-line bg-white"
          )
        },
        h(
          "div",
          { className: "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between" },
          h(
            "div",
            null,
            h("h4", { className: "text-sm font-bold uppercase text-production-muted" }, "Casting Status"),
            damaged
              ? h("p", { className: "mt-1 text-sm font-bold text-amber-700" }, "Marked damaged during casting")
              : h("p", { className: "mt-1 text-sm font-bold text-production-muted" }, "Use only if the tree was damaged")
          ),
          h(
            "button",
            {
              className: cx(
                "min-h-11 rounded-md border px-5 font-bold",
                damaged
                  ? "border-amber-500 bg-amber-500 text-white hover:bg-amber-600"
                  : "border-amber-300 bg-white text-amber-700 hover:bg-amber-50"
              ),
              disabled: !canEditStage || !canMarkDamaged,
              onClick: toggleDamaged,
              title: canMarkDamaged ? "Mark this tree as damaged" : "Mark damaged permission required",
              type: "button"
            },
            "Damaged"
          )
        ),
        damaged
          ? h(
              "label",
              { className: "mt-4 block text-sm font-bold text-production-ink" },
              "Damage Reason",
              h("textarea", {
                className:
                  "mt-2 min-h-24 w-full resize-y rounded-lg border border-amber-200 bg-white p-4 text-sm font-normal text-production-ink outline-none focus:border-amber-500 focus:ring-4 focus:ring-amber-100",
                onChange: (event) => setDamageReason(event.target.value),
                disabled: !canEditStage,
                placeholder: "Enter reason if the tree was damaged during casting",
                value: damageReason
              })
            )
          : null
      ),
      h(
        "label",
        { className: "mt-5 block text-sm font-bold text-production-ink" },
        "Notes / Remarks",
        h("textarea", {
          className:
            "mt-2 min-h-32 w-full resize-y rounded-lg border border-production-line bg-white p-4 text-base font-normal text-production-ink outline-none focus:border-production-teal focus:ring-4 focus:ring-teal-100",
          maxLength: 500,
          onChange: (event) => onDraftNotesChange(event.target.value),
          placeholder: "Add optional casting remarks",
          value: draftNotes
        })
      ),
      h(
        "div",
        { className: "mt-3 flex justify-between text-xs font-bold text-production-muted" },
        h(
          "span",
          null,
          allChecklistComplete
            ? canSubmitStage
              ? `Next: ${getStageDisplayName(getNextStage(order.stage))}`
              : "Submit stage permission required"
            : "Checklist required before submit"
        ),
        h("span", null, `${draftNotes.length}/500`)
      ),
      checklistValidationMessage
        ? h(
            "p",
            { className: "mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-bold text-red-700" },
            checklistValidationMessage
          )
        : null,
      showReturnModal
        ? h(ReturnToAwaitingMetalModal, {
            onCancel: closeReturnModal,
            onConfirm: confirmReturn,
            onReasonChange: (value) => {
              setReturnReason(value);
              setReturnValidationMessage("");
            },
            reason: returnReason,
            validationMessage: returnValidationMessage
          })
        : null,
      h(
        "div",
        {
          className:
            "mt-auto flex flex-col gap-3 border-t border-production-line pt-6 lg:flex-row lg:items-center lg:justify-between"
        },
        h(
          "div",
          { className: "flex" },
          h(
            "button",
            {
              className: cx(
                "min-h-12 rounded-md border px-5 font-bold",
                canEditStage && canSubmitStage
                  ? "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
                  : "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"
              ),
              disabled: !canEditStage || !canSubmitStage,
              onClick: openReturnModal,
              title:
                canEditStage && canSubmitStage
                  ? "Return order to Awaiting Metal"
                  : "Submit stage permission required",
              type: "button"
            },
            "Return to Awaiting Metal"
          )
        ),
        h(
          "div",
          { className: "flex flex-col-reverse gap-3 sm:flex-row sm:justify-end" },
          h(
            "button",
            {
              className:
                "min-h-12 rounded-md border border-production-line bg-white px-6 font-bold text-production-muted hover:bg-slate-50",
              onClick: onCancel,
              type: "button"
            },
            "Cancel"
          ),
          h(
            "button",
            {
              "aria-disabled": String(!allChecklistComplete || !canSubmitStage),
              className: cx(
                "min-h-12 rounded-md px-8 font-bold text-white",
                allChecklistComplete && canEditStage && canSubmitStage
                  ? "bg-production-teal hover:bg-[#0c5853]"
                  : "cursor-not-allowed bg-slate-300 hover:bg-slate-300"
              ),
              disabled: !allChecklistComplete || !canEditStage || !canSubmitStage,
              onClick: submitCasting,
              title: canSubmitStage ? "Submit casting checklist" : "Submit stage permission required",
              type: "button"
            },
            "Submit"
          )
        )
      )
    );
  }

  function ReturnToAwaitingMetalModal({ onCancel, onConfirm, onReasonChange, reason, validationMessage }) {
    const reasonValue = String(reason || "");
    const isConfirmDisabled = !reasonValue.trim();

    return h(
      "div",
      {
        className: "fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4",
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": "returnToAwaitingMetalTitle"
      },
      h(
        "div",
        { className: "w-full max-w-lg rounded-lg border border-amber-200 bg-white p-5 shadow-xl" },
        h("h4", { className: "text-lg font-bold text-production-ink", id: "returnToAwaitingMetalTitle" }, "Return to Awaiting Metal"),
        h(
          "p",
          { className: "mt-3 text-sm font-bold leading-6 text-production-muted" },
          "This will move the order back to Awaiting Metal. Metal issue data will be preserved. Ready for Casting checklist data will be reset. Please provide a reason for return."
        ),
        h(
          "label",
          { className: "mt-4 block text-sm font-bold text-production-ink" },
          "Reason for Return",
          h("textarea", {
            "aria-required": "true",
            className:
              "mt-2 min-h-28 w-full resize-y rounded-lg border border-amber-200 bg-white p-4 text-sm font-normal text-production-ink outline-none focus:border-amber-500 focus:ring-4 focus:ring-amber-100",
            onChange: (event) => onReasonChange(event.target.value),
            placeholder: "Enter why this order is returning to Awaiting Metal",
            required: true,
            value: reasonValue
          })
        ),
        validationMessage
          ? h(
              "p",
              { className: "mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-bold text-red-700" },
              validationMessage
            )
          : null,
        h(
          "div",
          { className: "mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end" },
          h(
            "button",
            {
              className:
                "min-h-11 rounded-md border border-production-line bg-white px-5 font-bold text-production-muted hover:bg-slate-50",
              onClick: onCancel,
              type: "button"
            },
            "Cancel"
          ),
          h(
            "button",
            {
              "aria-disabled": String(isConfirmDisabled),
              className: cx(
                "min-h-11 rounded-md px-5 font-bold text-white",
                isConfirmDisabled
                  ? "cursor-not-allowed bg-slate-300 hover:bg-slate-300"
                  : "bg-amber-600 hover:bg-amber-700"
              ),
              disabled: isConfirmDisabled,
              onClick: onConfirm,
              type: "button"
            },
            "Confirm Return"
          )
        )
      )
    );
  }

  function CastingCompletedPanel({
    canEditStage = true,
    canSubmitStage = true,
    draftNotes,
    error,
    onCancel,
    onDraftNotesChange,
    onSubmit,
    order
  }) {
    const savedVerification = order.castingVerification || {};
    const [castingWeight, setCastingWeight] = useState(
      hasSubmittedWeightValue(savedVerification.castingWeight) ? String(savedVerification.castingWeight) : ""
    );
    const [colorConfirmed, setColorConfirmed] = useState(Boolean(savedVerification.colorConfirmed));
    const [isChangingColor, setIsChangingColor] = useState(Boolean(savedVerification.colorChanged));
    const [castingColor, setCastingColor] = useState(savedVerification.castingColor || order.color || "");

    useEffect(() => {
      const currentVerification = order.castingVerification || {};
      setCastingWeight(
        hasSubmittedWeightValue(currentVerification.castingWeight) ? String(currentVerification.castingWeight) : ""
      );
      setColorConfirmed(Boolean(currentVerification.colorConfirmed));
      setIsChangingColor(Boolean(currentVerification.colorChanged));
      setCastingColor(currentVerification.castingColor || order.color || "");
    }, [order.id, order.castingVerification, order.color]);

    const parsedCastingWeight = parseSubmittedWeight(castingWeight);
    const hasValidCastingWeight = parsedCastingWeight !== null && parsedCastingWeight > 0;
    const weightDifference = hasValidCastingWeight ? calculateWeightDifference(order.totalIssuedWeight, castingWeight) : null;
    const canSubmitCasting = hasValidCastingWeight && colorConfirmed && canEditStage && canSubmitStage;
    const nextStepLabel =
      order.isDamaged ? "Next: Damaged Trees" : `Next: ${getStageDisplayName(getNextStage(order.stage))}`;
    const submittedCastingColor = isChangingColor && castingColor ? castingColor : order.color || "";

    function submitCastingCompleted() {
      if (!canEditStage || !canSubmitStage) {
        return;
      }

      if (!canSubmitCasting) {
        return;
      }

      const normalizedCastingWeight = Math.round(parsedCastingWeight * 1000) / 1000;

      onSubmit({
        castingVerification: {
          castingColor: submittedCastingColor,
          castingWeight: normalizedCastingWeight,
          colorChanged: isChangingColor && submittedCastingColor !== (order.color || ""),
          colorConfirmed,
          originalColor: order.color || "",
          submittedAt: new Date().toISOString(),
          totalIssuedWeight: order.totalIssuedWeight,
          weightDifference
        },
        notes: draftNotes
      });
    }

    return h(
      "aside",
      {
        className:
          "kanban-detail-panel flex min-h-[62vh] flex-col rounded-lg border border-production-teal bg-white p-6 shadow-[0_18px_45px_rgba(18,117,111,0.18)] lg:p-8"
      },
      h(
        "div",
        { className: "mb-6 flex flex-col gap-4 border-b border-production-line pb-5 lg:flex-row lg:items-start lg:justify-between" },
        h(
          "div",
          { className: "min-w-0" },
          h("p", { className: "text-xs font-bold uppercase text-production-teal" }, "Focused Order"),
          h("h3", { className: "mt-2 text-3xl font-bold text-production-ink" }, h(OrderCodeWithBadges, {
            orderCode: order.orderCode,
            showInHouse: order.isInHouseProduction
          }))
        ),
        h(
          "div",
          { className: "flex flex-wrap items-center gap-3" },
          h(
            "span",
            {
              className: order.isDamaged
                ? "rounded-full bg-amber-100 px-4 py-2 text-xs font-bold text-amber-700"
                : "rounded-full bg-production-soft px-4 py-2 text-xs font-bold text-production-teal"
            },
            order.isDamaged ? "Damaged" : "Active"
          ),
          h(
            "button",
            {
              className:
                "min-h-10 rounded-md border border-production-line bg-white px-4 font-bold text-production-muted hover:bg-slate-50",
              onClick: onCancel,
              type: "button"
            },
            "Back to Board"
          )
        )
      ),
      h(
        "dl",
        { className: "grid gap-4 text-sm md:grid-cols-2 xl:grid-cols-6" },
        h(DetailFact, {
          label: "Internal Tree Number",
          value: h(OrderCodeWithBadges, {
            orderCode: order.orderCode,
            showInHouse: order.isInHouseProduction
          })
        }),
        h(DetailFact, { label: "Barcode Value", value: order.barcodeValue || "Not available" }),
        h(DetailFact, { label: "Metal KT and Color", value: order.metalDisplay }),
        h(DetailFact, { label: "Wax Weight", value: order.weightDisplay }),
        h(DetailFact, { label: "Customer / Order Reference", value: order.reference }),
        h(DetailFact, { label: "Current Stage", value: getStageDisplayName(order.stage) })
      ),
      h(
        "section",
        { className: "mt-6 rounded-xl border border-production-line bg-white p-4 lg:p-5" },
        h("h4", { className: "text-sm font-bold uppercase text-production-muted" }, "Casting Verification"),
        h(
          "div",
          { className: "mt-4 grid gap-4 md:grid-cols-3" },
          h(
            "div",
            { className: "rounded-lg border border-production-line bg-slate-50 p-4" },
            h("p", { className: "text-xs font-bold uppercase text-production-muted" }, "Total Issued Weight"),
            h("p", { className: "mt-2 text-2xl font-bold text-production-ink" }, formatSavedTotalIssuedWeight(order.totalIssuedWeight))
          ),
          h(
            "label",
            { className: "block rounded-lg border border-production-line bg-white p-4 text-sm font-bold text-production-ink" },
            "Casting Weight",
            h("input", {
              className:
                "mt-2 h-12 w-full rounded-lg border border-production-line bg-white px-4 text-base font-bold text-production-ink outline-none focus:border-production-teal focus:ring-4 focus:ring-teal-100",
              min: "0",
              onChange: (event) => setCastingWeight(event.target.value),
              disabled: !canEditStage,
              placeholder: "Enter casting wt.",
              step: "0.001",
              type: "number",
              value: castingWeight
            })
          ),
          h(
            "div",
            { className: "rounded-lg border border-production-teal bg-production-soft p-4" },
            h("p", { className: "text-xs font-bold uppercase text-production-teal" }, "Difference"),
            h(
              "p",
              {
                className: cx(
                  "mt-2 font-bold text-production-ink",
                  weightDifference === null ? "text-base" : "text-2xl"
                )
              },
              formatWeightDifference(weightDifference)
            )
          )
        ),
        h(
          "div",
          { className: "mt-4 rounded-lg border border-production-line bg-slate-50 p-4" },
          h(
            "div",
            { className: "flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between" },
            h(
              "div",
              null,
              h("p", { className: "text-xs font-bold uppercase text-production-muted" }, "Metal KT and Color"),
              h("p", { className: "mt-1 text-lg font-bold text-production-ink" }, order.metalDisplay)
            ),
            h(
              "div",
              { className: "flex flex-col gap-3 sm:flex-row sm:items-center" },
              h(
                "label",
                { className: "flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-production-line bg-white px-4 text-sm font-bold text-production-ink" },
                h("input", {
                  checked: colorConfirmed,
                  className: "h-5 w-5 accent-[#12756f]",
                  disabled: !canEditStage,
                  onChange: (event) => setColorConfirmed(event.target.checked),
                  type: "checkbox"
                }),
                "Casting color confirmed"
              ),
              h(
                "button",
                {
                  className:
                    "min-h-11 rounded-md border border-production-line bg-white px-4 text-sm font-bold text-production-muted hover:border-production-teal hover:text-production-teal",
                  disabled: !canEditStage,
                  onClick: () => setIsChangingColor((currentValue) => !currentValue),
                  type: "button"
                },
                isChangingColor ? "Keep Color" : "Change Color"
              )
            )
          ),
          isChangingColor
            ? h(
                "label",
                { className: "mt-4 block max-w-xs text-sm font-bold text-production-ink" },
                "Updated Casting Color",
                h(
                  "select",
                  {
                    className:
                      "mt-2 h-12 w-full rounded-lg border border-production-line bg-white px-3 text-base font-bold text-production-ink outline-none focus:border-production-teal focus:ring-4 focus:ring-teal-100",
                    onChange: (event) => setCastingColor(event.target.value),
                    disabled: !canEditStage,
                    value: castingColor
                  },
                  colorOptions.map((color) =>
                    h("option", { key: color || "blank", value: color }, color || "Select color")
                  )
                )
              )
            : null
        )
      ),
      order.isDamaged
        ? h(
            "div",
            { className: "mt-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800" },
            "This tree was marked damaged during Ready for Casting. Submitting Casting Completed will move it to Damaged Trees and remove it from the Kanban board."
          )
        : null,
      h(
        "label",
        { className: "mt-5 block text-sm font-bold text-production-ink" },
        "Notes / Remarks",
        h("textarea", {
          className:
            "mt-2 min-h-32 w-full resize-y rounded-lg border border-production-line bg-white p-4 text-base font-normal text-production-ink outline-none focus:border-production-teal focus:ring-4 focus:ring-teal-100",
          maxLength: 500,
          onChange: (event) => onDraftNotesChange(event.target.value),
          placeholder: "Add casting completed remarks",
          value: draftNotes
        })
      ),
      h(
        "div",
        { className: "mt-3 flex justify-between text-xs font-bold text-production-muted" },
        h(
          "span",
          null,
          canSubmitCasting
            ? nextStepLabel
            : canSubmitStage
              ? "Casting weight and color confirmation required before submit"
              : "Submit stage permission required"
        ),
        h("span", null, `${draftNotes.length}/500`)
      ),
      error
        ? h(
            "p",
            { className: "mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-bold text-red-700" },
            error
          )
        : null,
      h(
        "div",
        { className: "mt-auto flex flex-col-reverse gap-3 border-t border-production-line pt-6 sm:flex-row sm:justify-end" },
        h(
          "button",
          {
            className:
              "min-h-12 rounded-md border border-production-line bg-white px-6 font-bold text-production-muted hover:bg-slate-50",
            onClick: onCancel,
            type: "button"
          },
          "Cancel"
        ),
        h(
          "button",
          {
            "aria-disabled": String(!canSubmitCasting),
            className: cx(
              "min-h-12 rounded-md px-8 font-bold text-white",
              canSubmitCasting
                ? "bg-production-teal hover:bg-[#0c5853]"
                : "cursor-not-allowed bg-slate-300 hover:bg-slate-300"
            ),
            disabled: !canSubmitCasting,
            onClick: submitCastingCompleted,
            title: canSubmitStage ? "Submit casting verification" : "Submit stage permission required",
            type: "button"
          },
          "Submit"
        )
      )
    );
  }

  function QCCompletedPanel({ canEditStage = true, canSubmitStage = true, draftNotes, error, onCancel, onDraftNotesChange, onSubmit, order }) {
    const savedQcVerification = order.qcVerification || {};
    const [weightAfterCutting, setWeightAfterCutting] = useState(
      hasSubmittedWeightValue(savedQcVerification.weightAfterCutting)
        ? String(savedQcVerification.weightAfterCutting)
        : ""
    );
    const [assayKt, setAssayKt] = useState(savedQcVerification.assayKt || "");
    const [assayResultReferenceNumber, setAssayResultReferenceNumber] = useState(
      savedQcVerification.assayResultReferenceNumber || ""
    );
    const [showValidationMessages, setShowValidationMessages] = useState(false);

    useEffect(() => {
      const currentQcVerification = order.qcVerification || {};
      setWeightAfterCutting(
        hasSubmittedWeightValue(currentQcVerification.weightAfterCutting)
          ? String(currentQcVerification.weightAfterCutting)
          : ""
      );
      setAssayKt(currentQcVerification.assayKt || "");
      setAssayResultReferenceNumber(currentQcVerification.assayResultReferenceNumber || "");
      setShowValidationMessages(false);
    }, [order.id, order.qcVerification]);

    function getQcValidationMessages() {
      const messages = [];
      const parsedWeightAfterCutting = parseSubmittedWeight(weightAfterCutting);

      if (!String(weightAfterCutting || "").trim()) {
        messages.push("Enter Weight After Cutting.");
      } else if (parsedWeightAfterCutting === null || parsedWeightAfterCutting <= 0) {
        messages.push("Weight After Cutting must be greater than 0.");
      }

      if (!String(assayKt || "").trim()) {
        messages.push("Enter Assay KT.");
      }

      if (!String(assayResultReferenceNumber || "").trim()) {
        messages.push("Enter Assay Result Reference Number.");
      }

      return messages;
    }

    const qcValidationMessages = getQcValidationMessages();
    const canSubmitQc = qcValidationMessages.length === 0 && canEditStage && canSubmitStage;
    const qcSubmitMessages = canEditStage && canSubmitStage ? qcValidationMessages : [permissionDeniedMessage];
    const totalTreeWeightValue = hasSubmittedWeightValue(order.castingWeight) ? order.castingWeight : order.totalIssuedWeight;
    const totalTreeWeightDisplay = formatSavedTotalIssuedWeight(totalTreeWeightValue);

    function updateQcField(setter, value) {
      if (!canEditStage) return;

      setter(value);
      setShowValidationMessages(false);
    }

    function submitQcCompleted() {
      if (!canEditStage || !canSubmitStage) {
        setShowValidationMessages(true);
        return;
      }

      const messages = getQcValidationMessages();

      if (messages.length) {
        setShowValidationMessages(true);
        return;
      }

      onSubmit({
        notes: draftNotes,
        qcVerification: {
          assayKt: assayKt.trim(),
          assayResultReferenceNumber: assayResultReferenceNumber.trim(),
          submittedAt: new Date().toISOString(),
          weightAfterCutting: Math.round(parseSubmittedWeight(weightAfterCutting) * 1000) / 1000
        }
      });
    }

    return h(
      "aside",
      {
        className:
          "kanban-detail-panel flex min-h-[62vh] flex-col rounded-lg border border-production-teal bg-white p-6 shadow-[0_18px_45px_rgba(18,117,111,0.18)] lg:p-8"
      },
      h(
        "div",
        { className: "mb-6 flex flex-col gap-4 border-b border-production-line pb-5 lg:flex-row lg:items-start lg:justify-between" },
        h(
          "div",
          { className: "min-w-0" },
          h("p", { className: "text-xs font-bold uppercase text-production-teal" }, "Focused Order"),
          h("h3", { className: "mt-2 text-3xl font-bold text-production-ink" }, h(OrderCodeWithBadges, {
            orderCode: order.orderCode,
            showInHouse: order.isInHouseProduction
          }))
        ),
        h(
          "button",
          {
            className:
              "min-h-10 rounded-md border border-production-line bg-white px-4 font-bold text-production-muted hover:bg-slate-50",
            onClick: onCancel,
            type: "button"
          },
          "Back to Board"
        )
      ),
      h(
        "dl",
        { className: "grid gap-4 text-sm md:grid-cols-2 xl:grid-cols-6" },
        h(DetailFact, {
          label: "Internal Tree Number",
          value: h(OrderCodeWithBadges, {
            orderCode: order.orderCode,
            showInHouse: order.isInHouseProduction
          })
        }),
        h(DetailFact, { label: "Barcode Value", value: order.barcodeValue || "Not available" }),
        h(DetailFact, { label: "Metal KT and Color", value: order.metalDisplay }),
        h(DetailFact, { label: "Wax Weight", value: order.weightDisplay }),
        h(DetailFact, { label: "Customer / Order Reference", value: order.reference }),
        h(DetailFact, { label: "Current Stage", value: getStageDisplayName(order.stage) })
      ),
      h(
        "section",
        { className: "mt-6 rounded-xl border border-production-line bg-white p-4 lg:p-5" },
        h(
          "div",
          { className: "flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between" },
          h("h4", { className: "text-sm font-bold uppercase text-production-muted" }, "QC Verification"),
          h(
            "span",
            { className: "rounded-full border border-production-line bg-slate-50 px-3 py-1 text-xs font-bold text-production-muted" },
            "All steps required"
          )
        ),
        h(
          "div",
          { className: "mt-4 grid gap-4 xl:grid-cols-2" },
          h(
            "div",
            { className: "block rounded-lg border border-production-line bg-slate-50 p-4 text-sm font-bold text-production-ink" },
            h(
              "span",
              { className: "mb-3 flex items-center gap-3" },
              h(
                "span",
                { className: "flex h-7 w-7 items-center justify-center rounded-full bg-production-teal text-xs font-bold text-white" },
                "1"
              ),
              h("span", null, "Check Weight")
            ),
            h(
              "div",
              { className: "mb-3 rounded-lg border border-production-line bg-white px-3 py-2" },
              h("p", { className: "text-xs font-bold uppercase text-production-muted" }, "Total Tree Weight"),
              h("p", { className: "mt-1 text-base font-bold text-production-ink" }, totalTreeWeightDisplay)
            ),
            h(
              "label",
              { className: "block" },
              h("span", { className: "text-xs font-bold uppercase text-production-muted" }, "Weight After Cutting"),
              h(
                "div",
                { className: "mt-2 flex items-center gap-2" },
                h("input", {
                  className:
                    "h-12 min-w-0 flex-1 rounded-lg border border-production-line bg-white px-4 text-base font-bold text-production-ink outline-none focus:border-production-teal focus:ring-4 focus:ring-teal-100",
                  min: "0",
                  onChange: (event) => updateQcField(setWeightAfterCutting, event.target.value),
                  disabled: !canEditStage,
                  placeholder: "Enter weight",
                  step: "0.001",
                  type: "number",
                  value: weightAfterCutting
                }),
                h("span", { className: "font-bold text-production-muted" }, "g")
              )
            )
          ),
          h(
            "div",
            { className: "rounded-lg border border-production-line bg-slate-50 p-4 text-sm font-bold text-production-ink" },
            h(
              "span",
              { className: "mb-3 flex items-center gap-3" },
              h(
                "span",
                { className: "flex h-7 w-7 items-center justify-center rounded-full bg-production-teal text-xs font-bold text-white" },
                "2"
              ),
              h("span", null, "Assay Details")
            ),
            h(
              "div",
              { className: "grid gap-4 md:grid-cols-2" },
              h(
                "label",
                { className: "block text-sm font-bold text-production-ink" },
                "Assay KT",
                h("input", {
                  className:
                    "mt-2 h-12 w-full rounded-lg border border-production-line bg-white px-4 text-base font-bold text-production-ink outline-none focus:border-production-teal focus:ring-4 focus:ring-teal-100",
                  onChange: (event) => updateQcField(setAssayKt, event.target.value),
                  disabled: !canEditStage,
                  placeholder: "14KT",
                  type: "text",
                  value: assayKt
                })
              ),
              h(
                "label",
                { className: "block text-sm font-bold text-production-ink" },
                "Assay Result Reference Number",
                h("input", {
                  className:
                    "mt-2 h-12 w-full rounded-lg border border-production-line bg-white px-4 text-base font-bold text-production-ink outline-none focus:border-production-teal focus:ring-4 focus:ring-teal-100",
                  onChange: (event) => updateQcField(setAssayResultReferenceNumber, event.target.value),
                  disabled: !canEditStage,
                  placeholder: "Enter reference number",
                  type: "text",
                  value: assayResultReferenceNumber
                })
              )
            )
          )
        )
      ),
      h(
        "label",
        { className: "mt-5 block text-sm font-bold text-production-ink" },
        "Notes / Remarks",
        h("textarea", {
          className:
            "mt-2 min-h-32 w-full resize-y rounded-lg border border-production-line bg-white p-4 text-base font-normal text-production-ink outline-none focus:border-production-teal focus:ring-4 focus:ring-teal-100",
          maxLength: 500,
          onChange: (event) => onDraftNotesChange(event.target.value),
          placeholder: "Add QC remarks",
          value: draftNotes
        })
      ),
      h(
        "div",
        { className: "mt-3 flex justify-between text-xs font-bold text-production-muted" },
        h(
          "span",
          null,
          canSubmitQc
            ? `Next: ${getStageDisplayName(getNextStage(order.stage))}`
            : canSubmitStage
              ? "Complete all QC verification steps before submit"
              : "Submit stage permission required"
        ),
        h("span", null, `${draftNotes.length}/500`)
      ),
      showValidationMessages || !canSubmitQc
        ? h(
            "div",
            {
              className: cx(
                "mt-3 rounded-md px-3 py-2 text-sm font-bold",
                showValidationMessages ? "border border-red-200 bg-red-50 text-red-700" : "border border-production-line bg-slate-50 text-production-muted"
              )
            },
            qcSubmitMessages.map((message) => h("p", { key: message }, message))
          )
        : null,
      error
        ? h(
            "p",
            { className: "mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-bold text-red-700" },
            error
          )
        : null,
      h(
        "div",
        { className: "mt-auto flex flex-col-reverse gap-3 border-t border-production-line pt-6 sm:flex-row sm:justify-end" },
        h(
          "button",
          {
            className:
              "min-h-12 rounded-md border border-production-line bg-white px-6 font-bold text-production-muted hover:bg-slate-50",
            onClick: onCancel,
            type: "button"
          },
          "Cancel"
        ),
        h(
          "button",
          {
            "aria-disabled": String(!canSubmitQc),
            className: cx(
              "min-h-12 rounded-md px-8 font-bold text-white",
              canSubmitQc ? "bg-production-teal hover:bg-[#0c5853]" : "cursor-not-allowed bg-slate-300 hover:bg-slate-300"
            ),
            disabled: !canSubmitQc,
            onClick: submitQcCompleted,
            title: canSubmitStage
              ? canSubmitQc
                ? "Submit QC verification"
                : "Complete QC verification before submitting"
              : "Submit stage permission required",
            type: "button"
          },
          "Submit"
        )
      )
    );
  }

  function OrderCompletedPanel({
    canEditStage = true,
    canPostFinalInventory = true,
    canSubmitStage = true,
    error,
    onCancel,
    onSubmit,
    order
  }) {
    const metalIssue = order.metalIssue || {};
    const metalIssueLabels = getMetalIssueLabels(order.metalKt || metalIssue.metalKt);
    const castingIssue = order.castingIssue || {};
    const castingChecklist = castingIssue.checklist || {};
    const castingVerification = order.castingVerification || {};
    const qcVerification = order.qcVerification || {};
    const totalTreeWeightValue = getTotalTreeWeightValue(order);
    const finalCastingColor = formatChangedCastingColor(castingVerification);
    const orderTitle = formatReviewInfoValue(order.orderCode);
    const savedFinishedProductWeight = hasSubmittedWeightValue(order.finishedProductWeight)
      ? String(order.finishedProductWeight)
      : hasSubmittedWeightValue(order.receivedOrderWeight)
        ? String(order.receivedOrderWeight)
      : "";
    const isInventoryPosted = Boolean(order.inventoryPosted);
    const recycledMetalKtValue = order.recycledMetalKt || metalIssue.recycledMetalKt;
    const recycledMetalColorValue = order.recycledMetalColor || metalIssue.recycledMetalColor;
    const excessRecycledWeightValue = hasSubmittedWeightValue(order.excessRecycledWeight)
      ? order.excessRecycledWeight
      : metalIssue.excessRecycledWeight;
    const suggestedFineGoldValue = hasSubmittedWeightValue(order.suggestedFineGoldRequired)
      ? order.suggestedFineGoldRequired
      : metalIssue.suggestedFineMetalRequired || metalIssue.suggestedFineGoldRequired;
    const suggestedAlloyValue = hasSubmittedWeightValue(order.suggestedAlloyRequired)
      ? order.suggestedAlloyRequired
      : metalIssue.suggestedAlloyRequired;
    const referenceFineMetalValue = metalIssue.referenceFineMetal || metalIssue.referenceFineGold;
    const actualFineMetalWeightValue = metalIssue.actualFineMetalWeight || order.actualFineGoldWeight;
    const [finishedProductWeight, setFinishedProductWeight] = useState(savedFinishedProductWeight);
    const [validationMessage, setValidationMessage] = useState("");
    const [showConfirmPost, setShowConfirmPost] = useState(false);
    const topFacts = [
      {
        label: "Internal Tree Number",
        value: h(OrderCodeWithBadges, {
          orderCode: orderTitle,
          showInHouse: order.isInHouseProduction
        })
      },
      { label: "Barcode Value", value: formatReviewInfoValue(order.barcodeValue) },
      { label: "Customer / Order Reference", value: formatReviewInfoValue(order.reference) },
      { label: "Wax Weight", value: formatReviewInfoValue(order.weightDisplay) },
      { label: "Metal KT and Color", value: formatReviewInfoValue(order.metalDisplay) },
      { label: "Current Stage", value: getStageDisplayName(order.stage) }
    ];

    useEffect(() => {
      setFinishedProductWeight(savedFinishedProductWeight);
      setValidationMessage("");
      setShowConfirmPost(false);
    }, [order.id, savedFinishedProductWeight, order.inventoryPostedAt]);

    const summarySections = [
      {
        title: "Metal Issue Summary",
        items: [
          { label: "Metal Weight Required", value: formatSummaryWeight(metalIssue.metalWeightRequired) },
          { label: metalIssueLabels.fineMetalRequiredLabel, value: formatSummaryWeight(referenceFineMetalValue) },
          { label: metalIssueLabels.alloyRequiredLabel, value: formatSummaryWeight(metalIssue.referenceAlloy) },
          { label: metalIssueLabels.actualFineMetalWeightLabel, value: formatSummaryWeight(actualFineMetalWeightValue) },
          { label: metalIssueLabels.actualAlloyWeightLabel, value: formatSummaryWeight(order.actualAlloyWeight) },
          { label: "Actual Recycled Weight", value: formatSummaryWeight(order.actualRecycledWeight) },
          { label: "Recycled Metal KT", value: formatSummaryValue(recycledMetalKtValue) },
          { label: "Recycled Metal Color", value: formatSummaryValue(recycledMetalColorValue) },
          { label: "Excess Recycled Weight", value: formatSummaryWeight(excessRecycledWeightValue) },
          { label: metalIssueLabels.suggestedFineMetalRequiredLabel, value: formatSummaryWeight(suggestedFineGoldValue) },
          { label: "Suggested Alloy Required", value: formatSummaryWeight(suggestedAlloyValue) },
          { label: "Total Issued Weight", value: formatSummaryWeight(order.totalIssuedWeight) },
          {
            label: "Metal Source selected",
            value: metalIssue.sourceLabel || (metalIssue.source ? getMetalSourceLabel(metalIssue.source, metalIssueLabels) : "Not available")
          },
          { label: "Awaiting Metal submitted date and time", value: formatSummaryDateTime(metalIssue.submittedAt) }
        ]
      },
      {
        title: "Casting Preparation Summary",
        items: [
          { label: "Total Issued Weight reference", value: formatSummaryWeight(order.totalIssuedWeight) },
          { label: "Weight checked", value: formatChecklistStatus(castingChecklist, "weightChecked") },
          {
            label: "Accurate temperature of flask checked",
            value: formatChecklistStatus(castingChecklist, "flaskTemperatureChecked")
          },
          { label: "Metal checked", value: formatChecklistStatus(castingChecklist, "metalChecked") },
          { label: "Damaged status", value: formatDamagedStatus(castingIssue) },
          { label: "Damage reason", value: castingIssue.damaged ? formatSummaryValue(castingIssue.damageReason) : "Not available" },
          { label: "Ready for Casting submitted date and time", value: formatSummaryDateTime(castingIssue.submittedAt) }
        ]
      },
      {
        title: "Casting Result Summary",
        items: [
          { label: "Total Issued Weight", value: formatSummaryWeight(order.totalIssuedWeight) },
          { label: "Casting Weight", value: formatSummaryWeight(order.castingWeight) },
          { label: "Weight Difference", value: formatSummaryWeight(order.weightDifference) },
          { label: "Casting color confirmed", value: formatSummaryBoolean(castingVerification.colorConfirmed) },
          { label: "Final casting color if changed", value: finalCastingColor },
          { label: "Casting Completed submitted date and time", value: formatSummaryDateTime(castingVerification.submittedAt) }
        ]
      },
      {
        title: "Quality Check Summary",
        items: [
          { label: "Weight After Cutting", value: formatSummaryWeight(order.weightAfterCutting) },
          { label: "Total Tree Weight reference", value: formatSummaryWeight(totalTreeWeightValue) },
          { label: "Assay KT", value: formatSummaryValue(order.assayKt) },
          { label: "Assay Result Reference Number", value: formatSummaryValue(order.assayResultReferenceNumber) },
          { label: "Quality Check submitted date and time", value: formatSummaryDateTime(qcVerification.submittedAt) },
          { label: "Finished Product Weight", value: formatSummaryWeight(order.finishedProductWeight) },
          { label: "Reusable Balance Weight", value: formatSummaryWeight(order.reusableBalanceWeight) },
          { label: "Scrap / Loss Weight", value: formatSummaryWeight(order.scrapLossWeight) },
          { label: "Final posted date and time", value: formatSummaryDateTime(order.inventoryPostedAt) },
          { label: "Inventory posted status", value: isInventoryPosted ? "Inventory Posted" : "Not posted" }
        ]
      }
    ];

    const parsedFinishedProductWeight = parseSubmittedWeight(finishedProductWeight);
    const calculatedReusableBalance = Inventory?.calculateReusableBalance
      ? Inventory.calculateReusableBalance(order.castingWeight, finishedProductWeight)
      : calculateWeightDifference(order.castingWeight, finishedProductWeight);
    const calculatedScrapLoss = Inventory?.calculateScrapLoss
      ? Inventory.calculateScrapLoss(order.totalIssuedWeight, order.castingWeight)
      : calculateWeightDifference(order.totalIssuedWeight, order.castingWeight);
    const hasRequiredPostingValues =
      parsedFinishedProductWeight !== null &&
      parsedFinishedProductWeight > 0 &&
      parseSubmittedWeight(order.castingWeight) !== null &&
      parseSubmittedWeight(order.totalIssuedWeight) !== null &&
      calculatedReusableBalance !== null &&
      calculatedReusableBalance >= 0 &&
      calculatedScrapLoss !== null &&
      calculatedScrapLoss >= 0;
    const canSubmitInventoryPosting =
      !isInventoryPosted &&
      canEditStage &&
      canSubmitStage &&
      canPostFinalInventory &&
      hasRequiredPostingValues;
    const canAttemptInventoryPosting = !isInventoryPosted && canEditStage && canSubmitStage && canPostFinalInventory;

    function updateFinishedProductWeight(value) {
      if (isInventoryPosted) return;

      setFinishedProductWeight(value);
      setValidationMessage("");
    }

    function getInventoryPostingValidationMessage() {
      if (isInventoryPosted) return "Inventory has already been posted for this order.";
      if (!canEditStage || !canSubmitStage) return permissionDeniedMessage;
      if (!canPostFinalInventory) return permissionDeniedMessage;
      if (parsedFinishedProductWeight === null || parsedFinishedProductWeight <= 0) {
        return "Finished Product Weight is required and must be greater than 0 g.";
      }
      if (parseSubmittedWeight(order.castingWeight) === null) return "Casting Weight must exist before final posting.";
      if (parseSubmittedWeight(order.totalIssuedWeight) === null) {
        return "Total Issued Weight must exist before final posting.";
      }
      if (calculatedReusableBalance === null || calculatedReusableBalance < 0) {
        return "Reusable Balance Weight cannot be negative.";
      }
      if (calculatedScrapLoss === null || calculatedScrapLoss < 0) {
        return "Scrap / Loss Weight cannot be negative.";
      }
      return "";
    }

    function requestInventoryPosting() {
      const postingValidationMessage = getInventoryPostingValidationMessage();
      if (postingValidationMessage) {
        if (postingValidationMessage === permissionDeniedMessage) {
          recordAudit("Inventory-related permission denial", {
            module: "Inventory",
            stage: getStageDisplayName(order.stage),
            internalTreeNumber: order.orderCode,
            notes: "Post final inventory"
          });
        }
        setValidationMessage(postingValidationMessage);
        return;
      }

      setValidationMessage("");
      setShowConfirmPost(true);
    }

    function confirmInventoryPosting() {
      if (!canSubmitInventoryPosting) {
        setShowConfirmPost(false);
        requestInventoryPosting();
        return;
      }

      onSubmit({
        inventoryPosting: {
          finishedProductWeight: parsedFinishedProductWeight,
          postedAt: new Date().toISOString(),
          reusableBalanceWeight: calculatedReusableBalance,
          scrapLossWeight: calculatedScrapLoss,
          status: "Inventory Posted"
        }
      });
      setShowConfirmPost(false);
    }

    return h(
      "aside",
      {
        className:
          "kanban-detail-panel flex min-h-[62vh] flex-col rounded-lg border border-production-teal bg-white p-6 shadow-[0_18px_45px_rgba(18,117,111,0.18)] lg:p-8"
      },
      h(
        "div",
        { className: "mb-6 flex flex-col gap-4 border-b border-production-line pb-5 lg:flex-row lg:items-start lg:justify-between" },
        h(
          "div",
          { className: "min-w-0" },
          h("p", { className: "text-xs font-bold uppercase text-production-teal" }, "Focused Order"),
          h("h3", { className: "mt-2 text-3xl font-bold text-production-ink" }, h(OrderCodeWithBadges, {
            orderCode: orderTitle,
            showInHouse: order.isInHouseProduction
          }))
        ),
        h(
          "div",
          { className: "flex flex-wrap items-center gap-3" },
          h(
            "span",
            { className: "rounded-full bg-production-soft px-4 py-2 text-xs font-bold text-production-teal" },
            "Completed"
          ),
          h(
            "button",
            {
              className:
                "min-h-10 rounded-md border border-production-line bg-white px-4 font-bold text-production-muted hover:bg-slate-50",
              onClick: onCancel,
              type: "button"
            },
            "Back to Board"
          )
        )
      ),
      h(
        "dl",
        { className: "grid gap-4 text-sm md:grid-cols-2 xl:grid-cols-5" },
        topFacts.map((fact) => h(DetailFact, { key: fact.label, label: fact.label, value: fact.value }))
      ),
      h(
        "section",
        { className: "mt-6 rounded-xl border-2 border-production-teal bg-production-soft p-4 lg:p-5" },
        h(
          "div",
          { className: "flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between" },
          h(
            "div",
            null,
            h("h4", { className: "text-sm font-bold uppercase text-production-teal" }, "Final Inventory Posting"),
            h(
              "p",
              { className: "mt-1 text-sm font-bold text-production-muted" },
              isInventoryPosted
                ? "Inventory posted and order locked."
                : "Review final weights and post this completed order to inventory."
            )
          ),
          h(
            "span",
            {
              className: cx(
                "rounded-full px-3 py-1 text-xs font-bold",
                isInventoryPosted
                  ? "bg-white text-production-teal"
                  : "bg-amber-100 text-amber-700"
              )
            },
            isInventoryPosted ? "Inventory Posted" : "Required"
          )
        ),
        h(
          "div",
          { className: "mt-4 grid gap-4 lg:grid-cols-3" },
          h(
            "label",
            { className: "block text-sm font-bold text-production-ink" },
            "Finished Product Weight",
            h(
              "div",
              { className: "mt-2 flex min-w-0 items-center rounded-lg border border-production-line bg-white focus-within:border-production-teal focus-within:ring-4 focus-within:ring-teal-100" },
              h("input", {
                className:
                  "h-12 min-w-0 flex-1 rounded-lg border-0 bg-transparent px-4 text-base font-bold text-production-ink outline-none",
                disabled: isInventoryPosted || !canEditStage,
                min: "0",
                onChange: (event) => updateFinishedProductWeight(event.target.value),
                placeholder: "Enter finished wt.",
                readOnly: isInventoryPosted,
                step: "0.001",
                type: "number",
                value: finishedProductWeight
              }),
              h("span", { className: "px-4 text-sm font-bold text-production-muted" }, "g")
            )
          ),
          h(ReferenceValue, {
            label: "Reusable Balance Weight",
            value: calculatedReusableBalance === null ? "Not available" : formatSummaryWeight(calculatedReusableBalance)
          }),
          h(ReferenceValue, {
            label: "Scrap / Loss Weight",
            value: calculatedScrapLoss === null ? "Not available" : formatSummaryWeight(calculatedScrapLoss)
          })
        ),
        h(
          "div",
          { className: "mt-4 grid gap-3 md:grid-cols-3" },
          h(DetailFact, { label: "Casting Weight", value: formatSummaryWeight(order.castingWeight) }),
          h(DetailFact, { label: "Total Issued Weight", value: formatSummaryWeight(order.totalIssuedWeight) }),
          h(DetailFact, { label: "Recycled Metal KT", value: formatSummaryValue(recycledMetalKtValue) }),
          h(DetailFact, { label: "Recycled Metal Color", value: formatSummaryValue(recycledMetalColorValue) }),
          h(DetailFact, { label: "Excess Recycled Weight", value: formatSummaryWeight(excessRecycledWeightValue) }),
          h(DetailFact, { label: "Metal KT and Color", value: formatReviewInfoValue(order.metalDisplay) })
        ),
        h(
          "div",
          { className: "mt-4 flex justify-end" },
          h(
            "button",
            {
              className: cx(
                "min-h-12 self-end rounded-md px-6 font-bold text-white",
                canAttemptInventoryPosting
                  ? "bg-production-teal hover:bg-[#0c5853]"
                  : "cursor-not-allowed bg-slate-300 hover:bg-slate-300"
              ),
              disabled: !canAttemptInventoryPosting,
              onClick: requestInventoryPosting,
              title: isInventoryPosted ? "Inventory already posted" : "Post final inventory",
              type: "button"
            },
            "Post to Inventory"
          )
        ),
        isInventoryPosted
          ? h(
              "div",
              { className: "mt-4 rounded-lg border border-production-teal bg-white px-4 py-3 text-sm font-bold text-production-ink" },
              h("p", null, "Status: Inventory Posted."),
              h("p", { className: "mt-1 text-production-muted" }, `Posted: ${formatSummaryDateTime(order.inventoryPostedAt)}`)
            )
          : null,
        validationMessage || error
          ? h(
              "p",
              { className: "mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-bold text-red-700" },
              validationMessage || error
            )
          : null
      ),
      h(
        "section",
        { className: "mt-6 rounded-xl border border-production-line bg-white p-4 lg:p-5" },
        h("h4", { className: "text-sm font-bold uppercase text-production-muted" }, "Order Processing Summary"),
        h(
          "div",
          { className: "mt-4 grid gap-4 xl:grid-cols-2" },
          summarySections.map((section) =>
            h(OrderSummarySection, {
              key: section.title,
              items: section.items,
              title: section.title
            })
          )
        )
      ),
      showConfirmPost
        ? h(
            "div",
            {
              className:
                "fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4",
              role: "dialog",
              "aria-modal": "true"
            },
            h(
              "div",
              { className: "w-full max-w-md rounded-lg border border-production-line bg-white p-5 shadow-xl" },
              h("h4", { className: "text-lg font-bold text-production-ink" }, "Confirm Inventory Posting"),
              h(
                "p",
                { className: "mt-3 text-sm font-bold text-production-muted" },
                "Once posted to inventory, this order cannot be edited and inventory transactions cannot be changed directly. Do you want to continue?"
              ),
              h(
                "div",
                { className: "mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end" },
                h(
                  "button",
                  {
                    className:
                      "min-h-11 rounded-md border border-production-line bg-white px-5 font-bold text-production-muted hover:bg-slate-50",
                    onClick: () => setShowConfirmPost(false),
                    type: "button"
                  },
                  "Cancel"
                ),
                h(
                  "button",
                  {
                    className: "min-h-11 rounded-md bg-production-teal px-5 font-bold text-white hover:bg-[#0c5853]",
                    onClick: confirmInventoryPosting,
                    type: "button"
                  },
                  "Confirm Submit"
                )
              )
            )
          )
        : null,
      h(
        "div",
        { className: "mt-auto flex flex-col-reverse gap-3 border-t border-production-line pt-6 sm:flex-row sm:justify-end" },
        h(
          "button",
          {
            className:
              "min-h-12 rounded-md border border-production-line bg-white px-6 font-bold text-production-muted hover:bg-slate-50",
            onClick: onCancel,
            type: "button"
          },
          "Back to Board"
        ),
        h(
          "button",
          {
            "aria-disabled": "true",
            className: "min-h-12 cursor-not-allowed rounded-md bg-slate-300 px-8 font-bold text-white",
            disabled: true,
            type: "button"
          },
          "Completed"
        )
      )
    );
  }

  function GenericStagePanel({ canSubmitStage = true, draftNotes, error, onCancel, onDraftNotesChange, onSubmit, order }) {
    const nextStage = getNextStage(order.stage);
    const willExitAsDamaged = order.stage === stages[2] && order.isDamaged;

    return h(
      "aside",
      {
        className:
          "kanban-detail-panel flex min-h-[62vh] flex-col rounded-lg border border-production-teal bg-white p-6 shadow-[0_18px_45px_rgba(18,117,111,0.18)] lg:p-8"
      },
      h(
        "div",
        { className: "mb-6 flex flex-col gap-4 border-b border-production-line pb-5 lg:flex-row lg:items-start lg:justify-between" },
        h(
          "div",
          { className: "min-w-0" },
          h("p", { className: "text-xs font-bold uppercase text-production-teal" }, "Focused Order"),
          h("h3", { className: "mt-2 text-3xl font-bold text-production-ink" }, h(OrderCodeWithBadges, {
            orderCode: order.orderCode,
            showInHouse: order.isInHouseProduction
          }))
        ),
        h(
          "div",
          { className: "flex flex-wrap items-center gap-3" },
          h(
            "span",
            {
              className:
                willExitAsDamaged
                  ? "rounded-full bg-amber-100 px-4 py-2 text-xs font-bold text-amber-700"
                  : "rounded-full bg-production-soft px-4 py-2 text-xs font-bold text-production-teal"
            },
            order.isComplete ? "Completed" : willExitAsDamaged ? "Damaged" : "Active"
          ),
          h(
            "button",
            {
              className:
                "min-h-10 rounded-md border border-production-line bg-white px-4 font-bold text-production-muted hover:bg-slate-50",
              onClick: onCancel,
              type: "button"
            },
            "Back to Board"
          )
        )
      ),
      h(
        "dl",
        { className: "grid gap-4 text-sm md:grid-cols-2" },
        h(DetailFact, {
          label: "Internal Tree Number",
          value: h(OrderCodeWithBadges, {
            orderCode: order.orderCode,
            showInHouse: order.isInHouseProduction
          })
        }),
        h(DetailFact, { label: "Barcode Value", value: order.barcodeValue || "Not available" }),
        h(DetailFact, { label: "Metal KT and Color", value: order.metalDisplay }),
        h(DetailFact, { label: "Wax Weight", value: order.weightDisplay }),
        h(DetailFact, { label: "Customer / Order Reference", value: order.reference }),
        h(DetailFact, { label: "Current Stage", value: getStageDisplayName(order.stage) })
      ),
      willExitAsDamaged
        ? h(
            "div",
            { className: "mt-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800" },
            "This tree was marked damaged during Ready for Casting. Submitting Casting Completed will move it to Damaged Trees and remove it from the Kanban board."
          )
        : null,
      h(
        "label",
        { className: "mt-6 block text-sm font-bold text-production-ink" },
        "Notes / Remarks",
        h("textarea", {
          className:
            "mt-2 min-h-44 w-full resize-y rounded-lg border border-production-line bg-white p-4 text-base font-normal text-production-ink outline-none focus:border-production-teal focus:ring-4 focus:ring-teal-100",
          maxLength: 500,
          onChange: (event) => onDraftNotesChange(event.target.value),
          placeholder: "Add remarks for this production step",
          value: draftNotes
        })
      ),
      h(
        "div",
        { className: "mt-3 flex justify-between text-xs font-bold text-production-muted" },
        h(
          "span",
          null,
          order.isComplete
            ? "Final stage reached"
            : willExitAsDamaged
              ? "Next: Damaged Trees"
              : canSubmitStage
                ? `Next: ${getStageDisplayName(nextStage)}`
                : "Submit stage permission required"
        ),
        h("span", null, `${draftNotes.length}/500`)
      ),
      error
        ? h(
            "p",
            { className: "mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-bold text-red-700" },
            error
          )
        : null,
      h(
        "div",
        { className: "mt-auto flex flex-col-reverse gap-3 border-t border-production-line pt-6 sm:flex-row sm:justify-end" },
        h(
          "button",
          {
            className:
              "min-h-12 rounded-md border border-production-line bg-white px-6 font-bold text-production-muted hover:bg-slate-50",
            onClick: onCancel,
            type: "button"
          },
          "Cancel"
        ),
        h(
          "button",
          {
            className: cx(
              "min-h-12 rounded-md px-8 font-bold text-white",
              order.isComplete
                ? "cursor-not-allowed bg-slate-300"
                : !canSubmitStage
                  ? "cursor-not-allowed bg-slate-300"
                : "bg-production-teal hover:bg-[#0c5853]"
            ),
            disabled: order.isComplete || !canSubmitStage,
            onClick: () => onSubmit({ notes: draftNotes }),
            title: canSubmitStage ? "Submit production step" : "Submit stage permission required",
            type: "button"
          },
          order.isComplete ? "Completed" : "Submit"
        )
      )
    );
  }

  function CastingChecklistItem({ checked, disabled = false, label, onChange }) {
    return h(
      "label",
      {
        className: cx(
          "flex min-h-16 cursor-pointer items-center gap-3 rounded-lg border bg-white p-4 text-sm font-bold",
          checked ? "border-production-teal shadow-sm" : "border-production-line"
        )
      },
      h("input", {
          checked,
          className: "h-5 w-5 accent-[#12756f]",
          disabled,
          onChange: (event) => onChange(event.target.checked),
        type: "checkbox"
      }),
      h(
        "span",
        { className: "flex-1 text-production-ink" },
        label,
        h("span", { className: "ml-1 text-red-600" }, "*")
      ),
      h(
        "span",
        { className: "rounded-full bg-production-soft px-2 py-1 text-xs font-bold text-production-teal" },
        "Required"
      )
    );
  }

  function SummaryPill({ label, value }) {
    return h(
      "div",
      { className: "rounded-lg border border-production-line bg-production-soft px-4 py-3" },
      h("p", { className: "text-xs font-bold uppercase text-production-muted" }, label),
      h("p", { className: "mt-1 text-lg font-bold text-production-ink" }, value)
    );
  }

  function ReferenceValue({ label, value }) {
    return h(
      "div",
      { className: "rounded-lg border border-slate-200 bg-slate-50 p-4" },
      h("p", { className: "text-xs font-bold uppercase text-production-muted" }, label),
      h("p", { className: "mt-2 text-2xl font-bold text-production-ink" }, value)
    );
  }

  function ActualWeightInput({ disabled = false, label, onChange, value }) {
    return h(
      "label",
      { className: "block text-sm font-bold text-production-ink" },
      label,
      h("input", {
        className:
          "mt-2 h-12 w-full rounded-lg border border-production-line bg-white px-4 text-base font-bold text-production-ink outline-none focus:border-production-teal focus:ring-4 focus:ring-teal-100",
        min: "0",
        disabled,
        onChange: (event) => onChange(event.target.value),
        placeholder: "Enter wt.",
        step: "0.001",
        type: "number",
        value
      })
    );
  }

  function RecycledMetalInput({
    disabled = false,
    isKtLocked = false,
    ktOptions = [],
    onKtChange,
    onWeightChange,
    recycledColor,
    recycledKt,
    title = "Recycled Metal",
    weight
  }) {
    return h(
      "div",
      {
        className:
          "rounded-lg border border-production-line bg-slate-50 p-3 text-sm font-bold text-production-ink md:col-span-2 xl:col-span-3"
      },
      h("p", { className: "text-xs font-bold uppercase text-production-muted" }, title),
      h(
        "div",
        { className: "mt-2 grid gap-3 lg:grid-cols-[minmax(0,1fr)_180px_180px]" },
        h(
          "label",
          { className: "block" },
          "Actual Recycled Weight",
          h("input", {
            className:
              "mt-2 h-12 w-full rounded-lg border border-production-line bg-white px-4 text-base font-bold text-production-ink outline-none focus:border-production-teal focus:ring-4 focus:ring-teal-100",
            disabled,
            min: "0",
            onChange: (event) => onWeightChange(event.target.value),
            placeholder: "Enter wt.",
            step: "0.001",
            type: "number",
            value: weight
          })
        ),
        h(
          "label",
          { className: "block" },
          "Recycled Metal KT",
          isKtLocked
            ? h("input", {
                className:
                  "mt-2 h-12 w-full rounded-lg border border-production-line bg-slate-100 px-3 text-base font-bold text-production-ink",
                readOnly: true,
                value: recycledKt || "Not available"
              })
            : h(
                "select",
                {
                  className:
                    "mt-2 h-12 w-full rounded-lg border border-production-line bg-white px-3 text-base font-bold text-production-ink outline-none focus:border-production-teal focus:ring-4 focus:ring-teal-100",
                  disabled,
                  onChange: (event) => onKtChange(event.target.value),
                  value: recycledKt
                },
                ktOptions.map((option) =>
                  h("option", { key: option || "blank", value: option }, option || "Select KT")
                )
              )
        ),
        h(
          "label",
          { className: "block" },
          "Recycled Color",
          h("input", {
            className:
              "mt-2 h-12 w-full rounded-lg border border-production-line bg-slate-100 px-3 text-base font-bold text-production-ink",
            readOnly: true,
            value: recycledColor || "Not available"
          })
        )
      ),
      isKtLocked
        ? h(
            "p",
            { className: "mt-3 text-xs font-bold text-production-muted" },
            "KT and color follow the tree/order and are locked for recycled-only metal."
          )
        : h(
            "p",
            { className: "mt-3 text-xs font-bold text-production-muted" },
            "Color follows the tree/order. Select recycled KT before using suggested fine gold and alloy values."
          )
    );
  }

  function MixedMetalReferencePanel({ labels = getMetalIssueLabels(), mixedReference, suggestedAlloyRequired, suggestedFineGoldRequired }) {
    return h(
      "div",
      {
        className:
          "rounded-lg border border-production-teal bg-production-soft p-3 text-sm font-bold text-production-ink md:col-span-2 xl:col-span-3"
      },
      h("p", { className: "text-xs font-bold uppercase text-production-teal" }, "Step 2: Additional Metal Required"),
      h(
        "div",
        { className: "mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4" },
        h(ReferenceValue, {
          label: labels.targetFineMetalRequiredLabel,
          value: formatReferenceWeight(mixedReference?.targetFineMetalRequired ?? mixedReference?.targetPureGoldRequired)
        }),
        h(ReferenceValue, {
          label: labels.fineMetalAlreadyPresentLabel,
          value: formatReferenceWeight(mixedReference?.fineMetalAlreadyPresent ?? mixedReference?.pureGoldAlreadyPresent)
        }),
        h(ReferenceValue, {
          label: labels.suggestedFineMetalRequiredLabel,
          value: formatReferenceWeight(suggestedFineGoldRequired)
        }),
        h(ReferenceValue, {
          label: "Suggested Alloy Required",
          value: formatReferenceWeight(suggestedAlloyRequired)
        })
      )
    );
  }

  function DetailFact({ label, value }) {
    return h(
      "div",
      { className: "rounded-lg border border-slate-200 bg-slate-50 p-3" },
      h("dt", { className: "text-xs font-bold uppercase text-production-muted" }, label),
      h("dd", { className: "mt-1 break-words font-bold text-production-ink" }, value)
    );
  }

  function OrderSummarySection({ items, title }) {
    return h(
      "section",
      { className: "rounded-lg border border-production-line bg-slate-50 p-4" },
      h("h5", { className: "text-sm font-bold uppercase text-production-teal" }, title),
      h(
        "dl",
        { className: "mt-3 divide-y divide-production-line rounded-lg border border-production-line bg-white" },
        items.map((item) =>
          h(
            "div",
            { className: "grid gap-1 px-3 py-2 text-sm sm:grid-cols-[1.1fr_1fr]", key: item.label },
            h("dt", { className: "font-bold text-production-muted" }, item.label),
            h("dd", { className: "break-words font-bold text-production-ink sm:text-right" }, item.value)
          )
        )
      )
    );
  }

  window.ReactDOM.createRoot(rootElement).render(h(KanbanBoard));
})();
