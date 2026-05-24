require("./env").loadEnv();
const bcrypt = require("bcryptjs");
const { allPermissions, defaultRoles } = require("./permissions");
const { query, transaction } = require("./db");

const waxSeedRows = [
  ["UD-CUST-001", "2026-05-01", "WAX-1001", "TREE-A1", "14KT", "Yellow", "12.50", "A-1", "260501-A-1", false, false],
  ["UD-CUST-002", "2026-05-02", "WAX-1002", "TREE-A2", "18KT", "White", "8.75", "A-2", "260502-A-2", true, false],
  ["UD-CUST-003", "2026-05-03", "WAX-1003", "TREE-A3", "10KT", "Pink", "15.20", "A-3", "260503-A-3", false, true],
  ["UD-CUST-004", "2026-05-04", "WAX-1004", "TREE-A4", "22KT", "Yellow", "6.40", "A-4", "260504-A-4", false, false],
  ["UD-CUST-005", "2026-05-05", "WAX-1005", "TREE-A5", "14KT", "White", "9.85", "A-5", "260505-A-5", true, true],
  ["UD-CUST-006", "2026-05-06", "WAX-1006", "TREE-A6", "18KT", "Yellow", "11.10", "A-6", "260506-A-6", false, false],
  ["UD-CUST-007", "2026-05-07", "WAX-1007", "TREE-A7", "Platinum", "White", "7.35", "A-7", "260507-A-7", false, true],
  ["UD-CUST-008", "2026-05-08", "WAX-1008", "TREE-A8", "Silver", "White", "18.60", "A-8", "260508-A-8", true, false],
  ["UD-CUST-009", "2026-05-09", "WAX-1009", "TREE-A9", "9KT", "Rose", "10.45", "A-9", "260509-A-9", false, false],
  ["UD-CUST-010", "2026-05-10", "WAX-1010", "TREE-A10", "14KT", "Yellow", "13.95", "A-10", "260510-A-10", true, true]
];

async function seed() {
  const passwordHash = await bcrypt.hash("Admin@123", 12);
  await transaction(async (client) => {
    for (const permission of allPermissions()) {
      await client.query(
        `insert into permissions (permission_key, label, category)
         values ($1, $2, $3)
         on conflict (permission_key) do update set label = excluded.label, category = excluded.category`,
        [permission, labelFor(permission), categoryFor(permission)]
      );
    }

    for (const role of defaultRoles()) {
      await client.query(
        `insert into roles (id, name, description, is_active, is_system, permissions)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (id) do update set
          name = excluded.name,
          description = excluded.description,
          is_active = excluded.is_active,
          is_system = excluded.is_system,
          permissions = excluded.permissions,
          updated_at = now()`,
        [role.id, role.name, role.description, role.isActive, role.system, JSON.stringify(role.permissions)]
      );
    }

    const adminResult = await client.query(
      `insert into users (email, username, full_name, password_hash, is_active)
       values ('admin@example.com', 'admin@example.com', 'System Admin', $1, true)
       on conflict (email) do update set
        username = excluded.username,
        full_name = excluded.full_name,
        password_hash = excluded.password_hash,
        is_active = true,
        updated_at = now()
       returning id`,
      [passwordHash]
    );
    const adminId = adminResult.rows[0].id;
    await client.query(
      `insert into user_roles (user_id, role_id) values ($1, 'role_admin')
       on conflict (user_id, role_id) do nothing`,
      [adminId]
    );

    for (const row of waxSeedRows) {
      const result = await client.query(
        `insert into wax_entries (
          vendor_customer_name, entry_date, wax_invoice_no, customer_vendor_tree_no,
          metal_kt, color, wax_weight, internal_tree_number, barcode_value,
          is_rush, is_in_house_production, created_by
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        on conflict (barcode_value) do update set
          vendor_customer_name = excluded.vendor_customer_name,
          entry_date = excluded.entry_date,
          wax_invoice_no = excluded.wax_invoice_no,
          customer_vendor_tree_no = excluded.customer_vendor_tree_no,
          metal_kt = excluded.metal_kt,
          color = excluded.color,
          wax_weight = excluded.wax_weight,
          internal_tree_number = excluded.internal_tree_number,
          is_rush = excluded.is_rush,
          is_in_house_production = excluded.is_in_house_production,
          updated_at = now()
        returning id, internal_tree_number, barcode_value`,
        [...row, adminId]
      );
      const entry = result.rows[0];
      await client.query(
        `insert into casting_orders (wax_entry_id, current_stage, barcode_value, internal_tree_number, workflow_data, created_by)
         values ($1, 'Awaiting Metal', $2, $3, $4, $5)
         on conflict (wax_entry_id) do nothing`,
        [entry.id, entry.barcode_value, entry.internal_tree_number, JSON.stringify({ stage: "Awaiting Metal" }), adminId]
      );
    }

    await client.query(
      `insert into internal_tree_counters (prefix, last_sequence)
       values ('A', 10)
       on conflict (prefix) do update set last_sequence = greatest(internal_tree_counters.last_sequence, excluded.last_sequence), updated_at = now()`
    );

    await client.query(
      `insert into audit_logs (actor_user_id, actor_email, action, module, new_value, notes)
       values ($1, 'admin@example.com', 'Seed data loaded', 'System', $2, 'Default admin, roles, permissions, and 10 wax entries seeded.')`,
      [adminId, JSON.stringify({ waxEntryCount: waxSeedRows.length })]
    );

    const companyResult = await client.query(
      `insert into invoice_companies (name, address, gold_labor_price, silver_labor_price, platinum_labor_price)
       values ('Unique Designs Wholesale', '48 W 48th St, New York, NY', 18.50, 4.25, 32.00)
       on conflict (name) do update set
        address = excluded.address,
        gold_labor_price = excluded.gold_labor_price,
        silver_labor_price = excluded.silver_labor_price,
        platinum_labor_price = excluded.platinum_labor_price,
        updated_at = now()
       returning id`
    );
    const invoiceCompanyId = companyResult.rows[0].id;
    const orderResult = await client.query(
      `insert into invoice_orders (company_id, wax_shipment_inv_no, date_of_order, so_no, gold_value, silver_value, platinum_value, status, created_by)
       values ($1, 'SHIP-1001', '2026-05-12', 'SO-5001', 1250.00, 0, 0, 'Draft', $2)
       on conflict (wax_shipment_inv_no) do update set updated_at = now()
       returning id`,
      [invoiceCompanyId, adminId]
    );
    await client.query(
      `insert into invoice_order_rows (order_id, sr_no, wax_shipment_inv_no, tree_no, vpo_po_no, product_category, sku, customer_sku, wax_qty, order_qty, kt, color, net_wt_pc, gross_wt_pc, total_wt, required_metal_pg, total_value, notes)
       select $1, 1, 'SHIP-1001', 'A-1', 'PO-9001', 'Ring', 'UD-RING-14Y', 'CUST-R-001', 1, 1, '14KT', 'Yellow', 2.1, 2.4, 2.4, 1.4, 44.40, 'Seed invoice line'
       where not exists (select 1 from invoice_order_rows where order_id = $1 and sr_no = 1)`,
      [orderResult.rows[0].id]
    );
  });
  console.log("Database seed complete.");
}

function labelFor(permission) {
  return permission.replace(/\./g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function categoryFor(permission) {
  if (permission.startsWith("casting.")) return "stage";
  if (permission.includes(".")) return "system";
  return "module";
}

if (require.main === module) {
  seed().then(() => process.exit(0)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { seed, waxSeedRows };
