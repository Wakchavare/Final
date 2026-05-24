const resources = {
  modules: ["waxEntries", "castingProcess", "metalReceiving", "inventory", "invoicing"],
  moduleActions: ["view", "create", "edit", "delete", "export", "print"],
  stages: ["awaitingMetal", "readyForCasting", "castingCompleted", "qualityCheck", "orderCompleted"],
  stageActions: ["view", "open", "edit", "submit", "print", "markDamaged", "viewDamagedTrees"],
  special: [
    "roles.manage",
    "users.manage",
    "roles.assign",
    "rush.mark",
    "auditLogs.view",
    "auditLogs.export",
    "inventoryLedger.view",
    "inventoryLedger.export",
    "inventory.postFinal",
    "inventory.adjustment.future"
  ]
};

function allPermissions() {
  return [
    ...resources.modules.flatMap((module) => resources.moduleActions.map((action) => `${module}.${action}`)),
    ...resources.stages.flatMap((stage) => resources.stageActions.map((action) => `casting.${stage}.${action}`)),
    ...resources.special
  ];
}

function defaultRoles() {
  const all = allPermissions();
  return [
    {
      id: "role_admin",
      name: "Admin",
      description: "Full system access.",
      isActive: true,
      system: true,
      permissions: all
    },
    {
      id: "role_wax_entry",
      name: "Wax Entry",
      description: "Can manage Wax Entries, labels, exports, and rush priority.",
      isActive: true,
      system: false,
      permissions: ["waxEntries.view", "waxEntries.create", "waxEntries.edit", "waxEntries.delete", "waxEntries.export", "waxEntries.print", "rush.mark"]
    },
    {
      id: "role_casting",
      name: "Casting",
      description: "Can process casting stages from metal issue through casting completion.",
      isActive: true,
      system: false,
      permissions: [
        "castingProcess.view",
        "casting.awaitingMetal.view",
        "casting.awaitingMetal.open",
        "casting.awaitingMetal.edit",
        "casting.awaitingMetal.submit",
        "casting.readyForCasting.view",
        "casting.readyForCasting.open",
        "casting.readyForCasting.edit",
        "casting.readyForCasting.submit",
        "casting.readyForCasting.markDamaged",
        "casting.readyForCasting.viewDamagedTrees",
        "casting.castingCompleted.view",
        "casting.castingCompleted.open",
        "casting.castingCompleted.edit",
        "casting.castingCompleted.submit",
        "casting.castingCompleted.viewDamagedTrees"
      ]
    },
    {
      id: "role_qc",
      name: "QC",
      description: "Can complete Quality Check and Control.",
      isActive: true,
      system: false,
      permissions: ["castingProcess.view", "casting.qualityCheck.view", "casting.qualityCheck.open", "casting.qualityCheck.edit", "casting.qualityCheck.submit"]
    },
    {
      id: "role_store",
      name: "Store",
      description: "Can review completed orders and post final inventory.",
      isActive: true,
      system: false,
      permissions: ["castingProcess.view", "casting.orderCompleted.view", "casting.orderCompleted.open", "casting.orderCompleted.edit", "casting.orderCompleted.submit", "inventory.view", "inventoryLedger.view", "inventory.postFinal"]
    },
    {
      id: "role_inventory",
      name: "Inventory",
      description: "Can receive metal, view stock balances, and export inventory ledger.",
      isActive: true,
      system: false,
      permissions: ["metalReceiving.view", "metalReceiving.create", "inventory.view", "inventory.export", "inventoryLedger.view", "inventoryLedger.export"]
    },
    {
      id: "role_invoicing",
      name: "Invoicing",
      description: "Can manage invoice companies, orders, line items, and generated invoice records.",
      isActive: true,
      system: false,
      permissions: ["invoicing.view", "invoicing.create", "invoicing.edit", "invoicing.delete", "invoicing.export", "invoicing.print"]
    }
  ];
}

module.exports = { allPermissions, defaultRoles };
