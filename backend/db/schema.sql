create extension if not exists pgcrypto;

create table if not exists roles (
  id text primary key,
  name text not null,
  description text not null default '',
  is_active boolean not null default true,
  is_system boolean not null default false,
  permissions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists permissions (
  id uuid primary key default gen_random_uuid(),
  permission_key text unique not null,
  label text not null,
  category text not null default 'module',
  created_at timestamptz not null default now()
);

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  username text unique not null,
  full_name text not null,
  password_hash text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz
);

create table if not exists user_roles (
  user_id uuid not null references users(id) on delete cascade,
  role_id text not null references roles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, role_id)
);

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references users(id) on delete set null,
  actor_email text,
  action text not null,
  barcode_value text,
  is_in_house_production boolean,
  module text,
  stage text,
  internal_tree_number text,
  old_value jsonb,
  new_value jsonb,
  notes text,
  device text,
  created_at timestamptz not null default now()
);

create table if not exists internal_tree_counters (
  prefix text primary key,
  last_sequence integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists wax_entries (
  id uuid primary key default gen_random_uuid(),
  internal_tree_number text unique not null,
  barcode_value text unique not null,
  vendor_customer_name text not null default '',
  entry_date date,
  wax_invoice_no text not null default '',
  customer_vendor_tree_no text not null default '',
  metal_kt text not null default '',
  color text not null default '',
  wax_weight numeric(12,3) not null default 0,
  is_rush boolean not null default false,
  is_in_house_production boolean not null default false,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists casting_orders (
  id uuid primary key default gen_random_uuid(),
  wax_entry_id uuid unique not null references wax_entries(id) on delete cascade,
  current_stage text not null default 'Awaiting Metal',
  barcode_value text,
  internal_tree_number text,
  workflow_data jsonb not null default '{"stage":"Awaiting Metal"}'::jsonb,
  is_damaged boolean not null default false,
  removed_from_board boolean not null default false,
  final_status text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists order_stage_history (
  id uuid primary key default gen_random_uuid(),
  casting_order_id uuid not null references casting_orders(id) on delete cascade,
  from_stage text,
  to_stage text,
  action text not null,
  notes text,
  payload jsonb,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists metal_receiving_entries (
  id uuid primary key default gen_random_uuid(),
  local_id text unique,
  metal_type text not null,
  purity text not null,
  metal_kt_color text,
  color text,
  weight_received numeric(12,3) not null,
  supplier text,
  reference_number text,
  notes text,
  submitted_at timestamptz not null default now(),
  locked boolean not null default true,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb
);

create table if not exists inventory_ledger (
  id uuid primary key default gen_random_uuid(),
  local_id text unique,
  bucket_key text not null,
  category text not null,
  transaction_type text not null,
  metal_type text,
  purity text,
  metal_kt_color text,
  color text,
  in_weight numeric(12,3) not null default 0,
  out_weight numeric(12,3) not null default 0,
  balance_after_transaction numeric(12,3) not null default 0,
  related_internal_tree_number text,
  related_barcode_value text,
  related_order_id text,
  source_module text,
  source_id text,
  notes text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb
);

create table if not exists inventory_postings (
  id uuid primary key default gen_random_uuid(),
  local_id text unique,
  order_id text unique not null,
  barcode_value text,
  internal_tree_number text,
  finished_product_weight numeric(12,3) not null default 0,
  reusable_balance_weight numeric(12,3) not null default 0,
  scrap_loss_weight numeric(12,3) not null default 0,
  pure_consumed_weight numeric(12,3) not null default 0,
  ledger_entry_ids jsonb not null default '[]'::jsonb,
  posted_at timestamptz not null default now(),
  posted_by uuid references users(id) on delete set null,
  notes text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists inventory_balances (
  bucket_key text primary key,
  category text not null,
  metal_type text,
  purity text,
  metal_kt_color text,
  color text,
  balance numeric(12,3) not null default 0,
  balance_label text not null,
  updated_at timestamptz not null default now()
);

create sequence if not exists invoice_order_number_seq start 1001;

create table if not exists invoice_companies (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  address text,
  gold_labor_price numeric(12,2),
  silver_labor_price numeric(12,2),
  platinum_labor_price numeric(12,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists invoice_orders (
  id uuid primary key default gen_random_uuid(),
  order_number integer not null default nextval('invoice_order_number_seq') unique,
  company_id uuid not null references invoice_companies(id) on delete cascade,
  wax_shipment_inv_no text not null unique,
  original_order_number text,
  upload_version integer not null default 1,
  invoice_no text,
  date_of_order date,
  so_no text,
  metal_type text,
  wax_weight numeric(12,3),
  casting_weight numeric(12,3),
  labor_charge numeric(12,2),
  setting_charge numeric(12,2),
  stone_charge numeric(12,2),
  extra_charge numeric(12,2),
  gold_value numeric(12,2),
  silver_value numeric(12,2),
  platinum_value numeric(12,2),
  status text not null default 'Draft',
  source_file_name text,
  source_file_path text,
  uploaded_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references users(id) on delete set null
);

create table if not exists invoice_order_rows (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references invoice_orders(id) on delete cascade,
  sr_no integer,
  wax_shipment_inv_no text,
  tree_no text,
  vpo_po_no text,
  product_category text,
  sku text,
  customer_sku text,
  wax_qty numeric(12,3),
  order_qty numeric(12,3),
  kt text,
  color text,
  net_wt_pc numeric(12,3),
  gross_wt_pc numeric(12,3),
  total_wt numeric(12,3),
  required_metal_pg numeric(12,3),
  total_value numeric(12,2),
  wax_weight numeric(12,3),
  casting_qty numeric(12,3),
  casting_weight numeric(12,3),
  labor_charge numeric(12,2),
  setting_charge numeric(12,2),
  stone_charge numeric(12,2),
  extra_charge numeric(12,2),
  notes text,
  image_url text,
  created_at timestamptz not null default now()
);

create table if not exists generated_invoices (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references invoice_orders(id) on delete cascade,
  invoice_no text not null,
  invoice_date date,
  metal_type text,
  labor_rate numeric(12,2),
  gold_spot numeric(12,2),
  platinum_spot numeric(12,2),
  silver_spot numeric(12,2),
  file_type text not null default 'invoice',
  file_path text,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  generated_by uuid references users(id) on delete set null,
  created_by uuid references users(id) on delete set null
);

alter table invoice_orders add column if not exists original_order_number text;
alter table invoice_orders add column if not exists upload_version integer not null default 1;
alter table invoice_orders add column if not exists invoice_no text;
alter table invoice_orders add column if not exists metal_type text;
alter table invoice_orders add column if not exists wax_weight numeric(12,3);
alter table invoice_orders add column if not exists casting_weight numeric(12,3);
alter table invoice_orders add column if not exists labor_charge numeric(12,2);
alter table invoice_orders add column if not exists setting_charge numeric(12,2);
alter table invoice_orders add column if not exists stone_charge numeric(12,2);
alter table invoice_orders add column if not exists extra_charge numeric(12,2);
alter table invoice_orders add column if not exists source_file_name text;
alter table invoice_orders add column if not exists source_file_path text;

alter table invoice_order_rows add column if not exists wax_weight numeric(12,3);
alter table invoice_order_rows add column if not exists labor_charge numeric(12,2);
alter table invoice_order_rows add column if not exists setting_charge numeric(12,2);
alter table invoice_order_rows add column if not exists stone_charge numeric(12,2);
alter table invoice_order_rows add column if not exists extra_charge numeric(12,2);

alter table generated_invoices add column if not exists file_type text not null default 'invoice';
alter table generated_invoices add column if not exists file_path text;
alter table generated_invoices add column if not exists created_at timestamptz not null default now();
alter table generated_invoices add column if not exists generated_by uuid references users(id) on delete set null;

create index if not exists idx_wax_entries_created_at on wax_entries(created_at desc);
create index if not exists idx_casting_orders_stage on casting_orders(current_stage);
create index if not exists idx_audit_logs_created_at on audit_logs(created_at desc);
create index if not exists idx_invoice_orders_company_id on invoice_orders(company_id);
create index if not exists idx_invoice_orders_uploaded_at on invoice_orders(uploaded_at desc);
create index if not exists idx_invoice_orders_original_order_number on invoice_orders(original_order_number);
create index if not exists idx_invoice_order_rows_order_id on invoice_order_rows(order_id);
create index if not exists idx_invoice_order_rows_tree_no on invoice_order_rows(tree_no);
create index if not exists idx_invoice_order_rows_sku on invoice_order_rows(sku);
create index if not exists idx_generated_invoices_order_id on generated_invoices(order_id);
create index if not exists idx_generated_invoices_file_type on generated_invoices(order_id, file_type, created_at desc);
