-- Teleemon ledger schema, version 3 (ADR-005, docs/adr/005-ledger.md).
--
-- A double-entry ledger in its own PostgreSQL database, owned by the ledger service (Phase 8).
-- The database, not application code, enforces the invariants:
--   1. Every journal balances to the cent: its entries sum to zero (debits positive, credits negative).
--   2. Every journal has at least two entries, none of them zero.
--   3. Nothing is ever updated or deleted. Mistakes are corrected by a reversal journal, which must
--      exactly mirror the journal it reverses, and each journal can be reversed only once.
--   4. Each posting is idempotent: a source event (an ERA line, a Stripe charge, a ChargeItem) maps
--      to one idempotency key, so a retried import cannot post twice.
-- Money is integer cents (bigint). FHIR resources are referenced by "Type/id" strings only; no
-- names, diagnoses or note content are stored here.
--
-- Apply with `npm run ledger:schema -- --apply` (idempotent). `npm run ledger:schema` alone proves
-- the invariants in a throwaway database and drops it.

create schema if not exists ledger;

create table if not exists ledger.schema_version (
  version integer primary key,
  applied_at timestamptz not null default now()
);

create table if not exists ledger.account (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in (
    'patient_receivable',      -- what a patient owes (debit-normal)
    'insurance_receivable',    -- what a payer owes (debit-normal)
    'patient_credit',          -- patient overpayments held for refund or later charges (credit-normal)
    'cash',                    -- settled bank deposits
    'card_clearing',           -- card payments captured, not yet paid out by the processor
    'revenue',                 -- gross charges (credit-normal)
    'contractual_adjustment',  -- payer allowance reductions
    'write_off',               -- bad debt and courtesy adjustments
    'refund_payable'           -- refunds approved, not yet paid
  )),
  patient_ref text check (patient_ref ~ '^Patient/[A-Za-z0-9.-]{1,64}$'),
  payer_ref text check (payer_ref ~ '^(Organization/[A-Za-z0-9.-]{1,64}|payer:[A-Za-z0-9._-]{1,64})$'),
  name text not null check (length(name) between 1 and 120),
  created_at timestamptz not null default now(),
  constraint account_owner check (
    case kind
      when 'patient_receivable' then patient_ref is not null and payer_ref is null
      when 'patient_credit' then patient_ref is not null and payer_ref is null
      when 'insurance_receivable' then payer_ref is not null
      else patient_ref is null
    end
  ),
  constraint account_unique unique nulls not distinct (kind, patient_ref, payer_ref)
);

create table if not exists ledger.journal (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('charge', 'payment', 'adjustment', 'refund', 'transfer', 'reversal')),
  occurred_at timestamptz not null,
  posted_at timestamptz not null default now(),
  idempotency_key text not null unique check (length(idempotency_key) between 3 and 200),
  source text not null check (length(source) between 3 and 200),
  memo text check (length(memo) <= 500),
  reverses uuid unique references ledger.journal (id),
  posted_by text not null check (length(posted_by) between 3 and 120),
  constraint reversal_names_original check ((kind = 'reversal') = (reverses is not null)),
  constraint no_self_reversal check (reverses is null or reverses <> id)
);

create table if not exists ledger.entry (
  id bigint generated always as identity primary key,
  journal_id uuid not null references ledger.journal (id),
  account_id uuid not null references ledger.account (id),
  amount_cents bigint not null check (amount_cents <> 0),
  encounter_ref text check (encounter_ref ~ '^Encounter/[A-Za-z0-9.-]{1,64}$'),
  claim_ref text check (claim_ref ~ '^Claim/[A-Za-z0-9.-]{1,64}$'),
  charge_item_ref text check (charge_item_ref ~ '^ChargeItem/[A-Za-z0-9.-]{1,64}$')
);

create index if not exists entry_account on ledger.entry (account_id);
create index if not exists entry_journal on ledger.entry (journal_id);
create index if not exists entry_encounter on ledger.entry (encounter_ref) where encounter_ref is not null;
create index if not exists account_patient on ledger.account (patient_ref) where patient_ref is not null;

-- Invariants 1–3, checked when the transaction commits (deferred), so a journal and its entries
-- are written together and the whole posting is refused if it does not balance.
create or replace function ledger.check_journal() returns trigger language plpgsql as $$
declare
  j ledger.journal%rowtype;
  n integer;
  total bigint;
  mismatched integer;
begin
  -- Fired from both tables: an entry names its journal; a journal is itself.
  select * into j from ledger.journal
  where id = (to_jsonb(new) ->> case when tg_table_name = 'entry' then 'journal_id' else 'id' end)::uuid;
  select count(*), coalesce(sum(amount_cents), 0) into n, total from ledger.entry where journal_id = j.id;
  if n < 2 then
    raise exception 'ledger: journal % (%) needs at least two entries', j.id, j.idempotency_key using errcode = 'check_violation';
  end if;
  if total <> 0 then
    raise exception 'ledger: journal % (%) does not balance: entries sum to % cents', j.id, j.idempotency_key, total using errcode = 'check_violation';
  end if;
  if j.reverses is not null then
    select count(*) into mismatched from (
      select account_id from ledger.entry where journal_id in (j.id, j.reverses)
      group by account_id having sum(amount_cents) <> 0
    ) d;
    if mismatched > 0 then
      raise exception 'ledger: reversal % does not exactly mirror journal %', j.id, j.reverses using errcode = 'check_violation';
    end if;
  end if;
  return null;
end $$;

drop trigger if exists journal_balanced on ledger.entry;
create constraint trigger journal_balanced after insert on ledger.entry
  deferrable initially deferred for each row execute function ledger.check_journal();

drop trigger if exists journal_has_entries on ledger.journal;
create constraint trigger journal_has_entries after insert on ledger.journal
  deferrable initially deferred for each row execute function ledger.check_journal();

create or replace function ledger.append_only() returns trigger language plpgsql as $$
begin
  raise exception 'ledger: % is append-only; post a reversal instead of %', tg_table_name, lower(tg_op) using errcode = 'insufficient_privilege';
end $$;

drop trigger if exists journal_append_only on ledger.journal;
create trigger journal_append_only before update or delete on ledger.journal for each row execute function ledger.append_only();
drop trigger if exists journal_no_truncate on ledger.journal;
create trigger journal_no_truncate before truncate on ledger.journal for each statement execute function ledger.append_only();
drop trigger if exists entry_append_only on ledger.entry;
create trigger entry_append_only before update or delete on ledger.entry for each row execute function ledger.append_only();
drop trigger if exists entry_no_truncate on ledger.entry;
create trigger entry_no_truncate before truncate on ledger.entry for each statement execute function ledger.append_only();

-- Balances. Debit-normal accounts (receivables, cash) read positive when owed or held.
create or replace view ledger.account_balance as
  select a.id as account_id, a.kind, a.patient_ref, a.payer_ref, a.name, coalesce(sum(e.amount_cents), 0)::bigint as balance_cents
  from ledger.account a left join ledger.entry e on e.account_id = a.id
  group by a.id;

-- What each patient owes (positive) or is owed (negative): receivable plus credit.
create or replace view ledger.patient_balance as
  select patient_ref, sum(balance_cents)::bigint as balance_cents
  from ledger.account_balance
  where kind in ('patient_receivable', 'patient_credit')
  group by patient_ref;

-- Version 2 (Phase 8): the payer's stated total for each 835, so reconciliation can prove that the
-- cash posted under a trace number equals what the payer says it paid. Append-only, like journals.
create table if not exists ledger.remittance (
  trace_number text primary key check (length(trace_number) between 1 and 80),
  payer_ref text not null check (payer_ref ~ '^(Organization/[A-Za-z0-9.-]{1,64}|payer:[A-Za-z0-9._-]{1,64})$'),
  paid_cents bigint not null,
  payment_date date not null,
  claim_count integer not null check (claim_count >= 0),
  recorded_at timestamptz not null default now(),
  recorded_by text not null check (length(recorded_by) between 3 and 120)
);
drop trigger if exists remittance_append_only on ledger.remittance;
create trigger remittance_append_only before update or delete on ledger.remittance for each row execute function ledger.append_only();
drop trigger if exists remittance_no_truncate on ledger.remittance;
create trigger remittance_no_truncate before truncate on ledger.remittance for each statement execute function ledger.append_only();

-- Version 3 (Phase 8): durable hand-posted ERA status projection. The ledger transaction creates
-- the job with its journal; the worker applies the FHIR Claim status under its own outcome policy
-- and acknowledges only after that update succeeds. This operational outbox is separate from the
-- append-only money history, and only its completion timestamp can be changed by ledger_service.
create table if not exists ledger.claim_projection (
  id uuid primary key default gen_random_uuid(),
  source_key text not null unique references ledger.journal (idempotency_key),
  journal_id uuid not null references ledger.journal (id),
  claim_ref text not null check (claim_ref ~ '^Claim/[A-Za-z0-9.-]{1,64}$'),
  target_status text not null check (target_status in ('paid', 'partially-paid')),
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists claim_projection_pending on ledger.claim_projection (created_at, id) where completed_at is null;

-- Least privilege: the ledger service may insert and read; reporting may only read. Neither can
-- update, delete or truncate (and the triggers refuse it even for an owner).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ledger_service') then create role ledger_service nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'ledger_reader') then create role ledger_reader nologin; end if;
end $$;
revoke all on all tables in schema ledger from public, ledger_service, ledger_reader;
grant usage on schema ledger to ledger_service, ledger_reader;
grant select, insert on ledger.account, ledger.journal, ledger.entry, ledger.remittance to ledger_service;
grant select, insert on ledger.claim_projection to ledger_service;
grant update (completed_at) on ledger.claim_projection to ledger_service;
grant select on all tables in schema ledger to ledger_service, ledger_reader;

insert into ledger.schema_version (version) values (1), (2), (3) on conflict do nothing;
