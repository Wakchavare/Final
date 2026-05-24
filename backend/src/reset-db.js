require("dotenv").config();
const { query } = require("./db");
const { migrate } = require("./migrate");
const { seed } = require("./seed");

async function resetDb() {
  await query(`
    drop table if exists
      generated_invoices,
      invoice_order_rows,
      invoice_orders,
      invoice_companies,
      inventory_balances,
      inventory_postings,
      inventory_ledger,
      metal_receiving_entries,
      order_stage_history,
      casting_orders,
      wax_entries,
      internal_tree_counters,
      audit_logs,
      user_roles,
      users,
      permissions,
      roles
    cascade
  `);
  await query("drop sequence if exists invoice_order_number_seq cascade");
  await migrate();
  await seed();
  console.log("Database reset complete.");
}

if (require.main === module) {
  resetDb().then(() => process.exit(0)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { resetDb };
