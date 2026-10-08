-- =============================================================================
-- Ledger Finance: database schema
--
-- The complete schema in one file: tables, views, functions, triggers, row-level
-- security policies and permissions. Run it once on a new Supabase project
-- (SQL Editor, or `supabase db push`). Requires the extensions below, which
-- Supabase provides in the `extensions` schema.
--
-- Access model, in short:
--   * Every finance row belongs to a workspace; members see it through RLS
--     (owner / editor can write, viewer can read).
--   * The client picks a workspace with the `x-workspace-id` request header.
--   * Bank connections (Plaid, Coinbase) belong to the user who made them.
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


--
-- Name: accept_workspace_invite(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.accept_workspace_invite(p_token text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_inv public.workspace_invites;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  select * into v_inv from public.workspace_invites where token = p_token for update;
  if not found or v_inv.accepted_at is not null or v_inv.expires_at <= now() then
    raise exception 'This invite is no longer valid' using errcode = 'P0002';
  end if;
  if lower(v_inv.email) is distinct from lower(auth.jwt() ->> 'email') then
    raise exception 'This invite was sent to a different email address' using errcode = '42501';
  end if;
  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_inv.workspace_id, auth.uid(), v_inv.role)
  on conflict (workspace_id, user_id) do nothing;
  update public.workspace_invites set accepted_at = now(), accepted_by = auth.uid() where id = v_inv.id;
  return v_inv.workspace_id;
end;
$$;


--
-- Name: apply_categorization_rules(uuid[], uuid, boolean, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_categorization_rules(p_transaction_ids uuid[] DEFAULT NULL::uuid[], p_rule_id uuid DEFAULT NULL::uuid, p_only_unreviewed boolean DEFAULT true, p_import_only boolean DEFAULT false) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  r       record;
  v_n     integer;
  v_total integer := 0;
  v_ws    uuid[] := public.editable_workspace_ids();
begin
  for r in
    select * from public.categorization_rules
    where workspace_id = any (v_ws)
      and active
      and (p_rule_id is null or id = p_rule_id)
      and (not p_import_only or apply_on_import)
    order by priority desc, created_at desc
  loop
    with upd as (
      update public.transactions t set
        category_id       = coalesce(nullif(r.actions ->> 'category_id', '')::uuid, t.category_id),
        transaction_type  = coalesce(nullif(r.actions ->> 'transaction_type', ''), t.transaction_type),
        merchant_name     = coalesce(nullif(btrim(r.actions ->> 'merchant_name'), ''), t.merchant_name),
        recurring_item_id = coalesce(nullif(r.actions ->> 'recurring_item_id', '')::uuid, t.recurring_item_id)
      where t.workspace_id = r.workspace_id
        and (p_transaction_ids is null or t.id = any (p_transaction_ids))
        and (not p_only_unreviewed or t.review_status = 'unreviewed')
        and public.rule_matches(t, r.conditions)
      returning t.id
    ), tagged as (
      insert into public.transaction_tags (workspace_id, transaction_id, tag_id)
      select r.workspace_id, upd.id, (r.actions ->> 'tag_id')::uuid
      from upd
      where nullif(r.actions ->> 'tag_id', '') is not null
      on conflict do nothing
    )
    select count(*) into v_n from upd;

    if v_n > 0 then
      update public.categorization_rules set times_applied = times_applied + v_n where id = r.id;
      v_total := v_total + v_n;
    end if;
  end loop;
  return v_total;
end;
$$;


--
-- Name: apply_categorization_rules_as(uuid, uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_categorization_rules_as(p_user_id uuid, p_transaction_ids uuid[]) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform set_config('request.headers', json_build_object('x-workspace-id', 'all')::text, true);
  return public.apply_categorization_rules(p_transaction_ids, null, true, true);
end;
$$;


--
-- Name: auto_link_recurring(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auto_link_recurring(p_transaction_ids uuid[]) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  v_count integer;
  v_ws    uuid[] := public.editable_workspace_ids();
begin
  update public.transactions t
     set recurring_item_id = m.item_id
    from (
      select distinct on (tx.id) tx.id as transaction_id, r.id as item_id
        from public.transactions tx
        join public.recurring_items r
          on r.workspace_id = tx.workspace_id
         and r.active
         and (r.account_id is null or r.account_id = tx.account_id)
       where tx.workspace_id = any (v_ws)
         and tx.id = any (p_transaction_ids)
         and tx.recurring_item_id is null
         and public.recurring_text_matches(public.recurring_patterns(r), r.match_mode, tx.merchant_name, tx.original_description)
       order by tx.id,
                (r.account_id is not null) desc,
                (select coalesce(sum(char_length(x)), 0) from unnest(public.recurring_patterns(r)) as x) desc,
                r.created_at
    ) m
   where t.id = m.transaction_id
     and t.workspace_id = any (v_ws);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;


--
-- Name: auto_link_recurring_as(uuid, uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auto_link_recurring_as(p_user_id uuid, p_transaction_ids uuid[]) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform set_config('request.headers', json_build_object('x-workspace-id', 'all')::text, true);
  return public.auto_link_recurring(p_transaction_ids);
end;
$$;


--
-- Name: bulk_add_tag(uuid[], uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bulk_add_tag(p_ids uuid[], p_tag_id uuid) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  v_count integer;
begin
  insert into public.transaction_tags (workspace_id, transaction_id, tag_id)
  select t.workspace_id, t.id, p_tag_id
  from public.transactions t
  where t.id = any (p_ids) and t.workspace_id = any (public.editable_workspace_ids())
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;


--
-- Name: bulk_delete_transactions(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bulk_delete_transactions(p_ids uuid[]) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  v_count integer;
begin
  delete from public.transactions t where t.id = any (p_ids) and t.workspace_id = any (public.editable_workspace_ids());
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;


--
-- Name: bulk_update_transactions(uuid[], jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bulk_update_transactions(p_ids uuid[], p_patch jsonb) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  v_count integer;
begin
  if jsonb_typeof(p_patch) is distinct from 'object' then
    raise exception 'Patch must be an object' using errcode = '22023';
  end if;
  if coalesce(array_length(p_ids, 1), 0) > 5000 then
    raise exception 'Too many transactions in one bulk action' using errcode = '22023';
  end if;

  update public.transactions t set
    review_status     = case when p_patch ? 'review_status'     then p_patch ->> 'review_status'           else t.review_status end,
    category_id       = case when p_patch ? 'category_id'       then (p_patch ->> 'category_id')::uuid     else t.category_id end,
    transaction_type  = case when p_patch ? 'transaction_type'  then p_patch ->> 'transaction_type'        else t.transaction_type end,
    excluded          = case when p_patch ? 'excluded'          then (p_patch ->> 'excluded')::boolean     else t.excluded end,
    status            = case when p_patch ? 'status'            then p_patch ->> 'status'                  else t.status end,
    account_id        = case when p_patch ? 'account_id'        then (p_patch ->> 'account_id')::uuid      else t.account_id end,
    recurring_item_id = case when p_patch ? 'recurring_item_id' then (p_patch ->> 'recurring_item_id')::uuid else t.recurring_item_id end
  where t.id = any (p_ids) and t.workspace_id = any (public.editable_workspace_ids());
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;


--
-- Name: business_summary(date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.business_summary(p_start date, p_end date) RETURNS TABLE(revenue numeric, cost_of_goods numeric, operating_expenses numeric, owner_contributions numeric, owner_draws numeric, transaction_count bigint)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select
    coalesce(sum(e.amount) filter (where e.pnl_class = 'income'), 0)::numeric(14,2),
    coalesce(-sum(e.amount) filter (where e.pnl_class = 'cost_of_goods'), 0)::numeric(14,2),
    coalesce(-sum(e.amount) filter (where e.pnl_class = 'expense'), 0)::numeric(14,2),
    coalesce(sum(e.amount) filter (where e.pnl_class = 'equity' and e.amount > 0), 0)::numeric(14,2),
    coalesce(-sum(e.amount) filter (where e.pnl_class = 'equity' and e.amount < 0), 0)::numeric(14,2),
    count(distinct e.transaction_id) filter (where e.pnl_class is not null)
  from public.pnl_entries e
  where e.workspace_id = any ((select public.visible_workspace_ids())::uuid[])
    and e.transaction_date between p_start and p_end;
$$;


--
-- Name: cashflow_summary(date, date, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cashflow_summary(p_start date, p_end date, p_account_id uuid DEFAULT NULL::uuid) RETURNS TABLE(spending numeric, income numeric, transaction_count bigint)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select
    coalesce(-sum(e.amount) filter (where e.transaction_type in ('expense','refund')), 0)::numeric(14,2),
    coalesce(sum(e.amount) filter (where e.transaction_type = 'income'), 0)::numeric(14,2),
    count(distinct e.transaction_id)
  from public.countable_entries e
  where e.workspace_id = any ((select public.visible_workspace_ids())::uuid[])
    and e.transaction_date between p_start and p_end
    and (p_account_id is null or e.account_id = p_account_id);
$$;


--
-- Name: clear_plaid_account_link(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.clear_plaid_account_link() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.plaid_item_id is null and old.plaid_item_id is not null then
    new.plaid_account_id = null;
  end if;
  return new;
end;
$$;


--
-- Name: copy_account_to_workspace(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.copy_account_to_workspace(p_account_id uuid, p_target_ws uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_src  public.accounts;
  v_new  uuid := gen_random_uuid();
  v_name text;
begin
  select * into v_src from public.accounts where id = p_account_id;
  if not found or coalesce(public.workspace_role(v_src.workspace_id), '') not in ('owner', 'editor') then
    raise exception 'Account not found' using errcode = 'P0002';
  end if;
  if coalesce(public.workspace_role(p_target_ws), '') not in ('owner', 'editor') then
    raise exception 'You can''t add accounts to that workspace' using errcode = '42501';
  end if;
  if p_target_ws = v_src.workspace_id then
    raise exception 'The account is already in that workspace' using errcode = '22023';
  end if;
  if v_src.plaid_account_id is not null
     and exists (select 1 from public.accounts where workspace_id = p_target_ws and plaid_account_id = v_src.plaid_account_id) then
    raise exception 'That bank account is already in that workspace' using errcode = '22023';
  end if;

  -- Keep the name unless the target already has an account by that name.
  v_name := v_src.name;
  if exists (select 1 from public.accounts where workspace_id = p_target_ws and lower(name) = lower(v_name) and coalesce(last_four, '') = coalesce(v_src.last_four, '')) then
    v_name := left(v_src.name || ' (' || (select name from public.workspaces where id = v_src.workspace_id) || ')', 120);
  end if;

  insert into public.accounts (
    id, workspace_id, name, institution, account_type, last_four, currency, current_balance, available_balance,
    balance_as_of, credit_limit, statement_balance, minimum_payment, statement_close_day, payment_due_day, autopay_enabled,
    notes, sort_order, active, plaid_item_id, plaid_account_id, sync_from, next_payment_due_date, last_statement_date,
    last_payment_amount, last_payment_date, is_overdue, track_transactions
  )
  select v_new, p_target_ws, v_name, institution, account_type, last_four, currency, current_balance, available_balance,
    balance_as_of, credit_limit, statement_balance, minimum_payment, statement_close_day, payment_due_day, autopay_enabled,
    notes, sort_order, active, plaid_item_id, plaid_account_id, sync_from, next_payment_due_date, last_statement_date,
    last_payment_amount, last_payment_date, is_overdue, track_transactions
  from public.accounts where id = p_account_id;

  if to_regclass('pg_temp._copy_txn_map') is null then
    create temporary table _copy_txn_map (old_id uuid primary key, new_id uuid not null, category_id uuid) on commit drop;
  else
    truncate _copy_txn_map;
  end if;
  insert into _copy_txn_map (old_id, new_id, category_id)
  select t.id, gen_random_uuid(), public.match_category_in_workspace(t.category_id, p_target_ws)
  from public.transactions t where t.account_id = p_account_id;

  insert into public.transactions (
    id, workspace_id, account_id, transaction_date, posted_date, merchant_name, original_description, amount, currency,
    transaction_type, category_id, status, review_status, excluded, notes, external_transaction_id, import_hash,
    plaid_transaction_id, coinbase_transaction_id
  )
  select m.new_id, p_target_ws, v_new, t.transaction_date, t.posted_date, t.merchant_name, t.original_description, t.amount, t.currency,
    t.transaction_type, m.category_id, t.status,
    case when t.category_id is not null and m.category_id is null then 'unreviewed' else t.review_status end,
    t.excluded, t.notes, t.external_transaction_id, t.import_hash, t.plaid_transaction_id, t.coinbase_transaction_id
  from public.transactions t join _copy_txn_map m on m.old_id = t.id;

  insert into public.transaction_splits (workspace_id, transaction_id, category_id, amount, notes, sort_order)
  select p_target_ws, m.new_id, public.match_category_in_workspace(s.category_id, p_target_ws), s.amount, s.notes, s.sort_order
  from public.transaction_splits s join _copy_txn_map m on m.old_id = s.transaction_id;

  return v_new;
end;
$$;


--
-- Name: create_workspace(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_workspace(p_name text, p_kind text DEFAULT 'personal'::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_uid uuid := auth.uid();
  v_ws  uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_kind not in ('personal','business') then
    raise exception 'Workspace type must be personal or business' using errcode = '22023';
  end if;
  if (select count(*) from public.workspaces where created_by = v_uid) >= 20 then
    raise exception 'You already have the maximum number of workspaces' using errcode = '22023';
  end if;
  insert into public.workspaces (name, kind, created_by) values (btrim(p_name), p_kind, v_uid) returning id into v_ws;
  insert into public.workspace_members (workspace_id, user_id, role) values (v_ws, v_uid, 'owner');
  perform public.seed_workspace_categories(v_ws);
  return v_ws;
end;
$$;


--
-- Name: current_workspace_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_workspace_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select m.workspace_id from public.workspace_members m
  where m.user_id = auth.uid() and m.workspace_id::text = public.request_workspace();
$$;


--
-- Name: delete_all_my_data(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_all_my_data(p_confirm text) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  v_ws uuid := public.request_or_personal_workspace();
begin
  if p_confirm is distinct from 'DELETE' then
    raise exception 'Confirmation text did not match' using errcode = '22023';
  end if;
  if v_ws is null or public.workspace_role(v_ws) <> 'owner' then
    raise exception 'Only the workspace owner can delete its data' using errcode = '42501';
  end if;
  delete from public.import_rows           where workspace_id = v_ws;
  delete from public.transaction_tags      where workspace_id = v_ws;
  delete from public.transaction_splits    where workspace_id = v_ws;
  delete from public.recurring_occurrences where workspace_id = v_ws;
  delete from public.transactions          where workspace_id = v_ws;
  delete from public.transfer_groups       where workspace_id = v_ws;
  delete from public.calendar_reminders    where workspace_id = v_ws;
  delete from public.categorization_rules  where workspace_id = v_ws;
  delete from public.recurring_items       where workspace_id = v_ws;
  delete from public.imports               where workspace_id = v_ws;
  delete from public.tags                  where workspace_id = v_ws;
  delete from public.categories            where workspace_id = v_ws;
  delete from public.accounts              where workspace_id = v_ws;
end;
$$;


--
-- Name: delete_workspace(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_workspace(p_workspace_id uuid, p_confirm_name text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_name text;
begin
  if public.workspace_role(p_workspace_id) is distinct from 'owner' then
    raise exception 'Only an owner can delete this workspace' using errcode = '42501';
  end if;
  select name into v_name from public.workspaces where id = p_workspace_id;
  if p_confirm_name is distinct from v_name then
    raise exception 'Confirmation text did not match' using errcode = '22023';
  end if;
  if (select count(*) from public.workspace_members where user_id = auth.uid()) <= 1 then
    raise exception 'You can''t delete your only workspace' using errcode = '22023';
  end if;
  delete from public.workspaces where id = p_workspace_id;
end;
$$;


--
-- Name: editable_workspace_ids(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.editable_workspace_ids() RETURNS uuid[]
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select coalesce(array_agg(m.workspace_id), '{}')
  from public.workspace_members m, (select public.request_workspace() as h) r
  where m.user_id = auth.uid()
    and m.role in ('owner','editor')
    and (r.h = 'all' or m.workspace_id::text = r.h or (r.h is null and m.workspace_id = public.personal_workspace_of(auth.uid())));
$$;


--
-- Name: enforce_category_depth(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_category_depth() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.parent_category_id is not null then
    if exists (select 1 from public.categories p where p.id = new.parent_category_id and p.parent_category_id is not null) then
      raise exception 'Subcategories cannot have their own subcategories' using errcode = '23514';
    end if;
    if exists (select 1 from public.categories c where c.parent_category_id = new.id) then
      raise exception 'A category with subcategories cannot become a subcategory' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;


--
-- Name: ensure_personal_workspace(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ensure_personal_workspace(p_name text DEFAULT 'Personal Workspace'::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_ws uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  select m.workspace_id into v_ws from public.workspace_members m where m.user_id = auth.uid() order by m.created_at limit 1;
  if v_ws is null then
    v_ws := public.create_workspace(coalesce(nullif(btrim(p_name), ''), 'Personal Workspace'), 'personal');
  end if;
  return v_ws;
end;
$$;


--
-- Name: guard_account_plaid_item(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_account_plaid_item() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if new.plaid_item_id is not null and (tg_op = 'INSERT' or new.plaid_item_id is distinct from old.plaid_item_id or new.workspace_id is distinct from old.workspace_id) then
    if not exists (
      select 1 from public.plaid_items p
      join public.workspace_members m on m.user_id = p.user_id and m.workspace_id = new.workspace_id and m.role in ('owner','editor')
      where p.id = new.plaid_item_id
    ) then
      raise exception 'That bank connection can''t feed this workspace' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;


--
-- Name: guard_coinbase_account(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_coinbase_account() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if new.account_id is not null and (tg_op = 'INSERT' or new.account_id is distinct from old.account_id) then
    if not exists (
      select 1 from public.accounts a
      join public.workspace_members m on m.workspace_id = a.workspace_id and m.user_id = new.user_id and m.role in ('owner','editor')
      where a.id = new.account_id
    ) then
      raise exception 'That account isn''t in a workspace you can edit' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;


--
-- Name: guard_split_amount(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_split_amount() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  v_sum numeric(14,2);
begin
  if new.amount is distinct from old.amount then
    select sum(amount) into v_sum from public.transaction_splits where transaction_id = new.id;
    if v_sum is not null and v_sum <> new.amount then
      raise exception 'This transaction is split. Remove or edit the split before changing its amount.' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;


--
-- Name: invite_to_workspace(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.invite_to_workspace(p_workspace_id uuid, p_email text, p_role text DEFAULT 'editor'::text) RETURNS TABLE(id uuid, token text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  v_email text := lower(btrim(p_email));
begin
  if public.workspace_role(p_workspace_id) is distinct from 'owner' then
    raise exception 'Only an owner can invite people' using errcode = '42501';
  end if;
  if p_role not in ('owner','editor','viewer') then
    raise exception 'Invalid role' using errcode = '22023';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter a valid email address' using errcode = '22023';
  end if;
  if exists (select 1 from public.workspace_members m join auth.users u on u.id = m.user_id
             where m.workspace_id = p_workspace_id and lower(u.email) = v_email) then
    raise exception 'That person is already a member' using errcode = '23505';
  end if;
  return query
  insert into public.workspace_invites as i (workspace_id, email, role, invited_by)
  values (p_workspace_id, v_email, p_role, auth.uid())
  on conflict (workspace_id, lower(email)) where accepted_at is null
  do update set role = excluded.role, invited_by = excluded.invited_by, expires_at = now() + interval '14 days'
  returning i.id, i.token;
end;
$_$;


--
-- Name: link_recurring_transactions(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.link_recurring_transactions(p_recurring_item_id uuid) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  v_item     public.recurring_items;
  v_patterns text[];
  v_count    integer;
begin
  select * into v_item from public.recurring_items
  where id = p_recurring_item_id and workspace_id = any (public.editable_workspace_ids());
  if not found then
    raise exception 'Recurring item not found' using errcode = 'P0002';
  end if;
  v_patterns := public.recurring_patterns(v_item);
  if cardinality(v_patterns) = 0 then
    return 0;
  end if;

  update public.transactions t
     set recurring_item_id = v_item.id
   where t.workspace_id = v_item.workspace_id
     and t.recurring_item_id is null
     and (v_item.account_id is null or t.account_id = v_item.account_id)
     and public.recurring_text_matches(v_patterns, v_item.match_mode, t.merchant_name, t.original_description);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;


--
-- Name: link_transfer(uuid[], text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.link_transfer(p_ids uuid[], p_type text DEFAULT 'transfer'::text) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  v_group uuid;
  v_found integer;
  v_ws    uuid[];
begin
  if p_type not in ('transfer', 'credit_card_payment') then
    raise exception 'Invalid transfer type' using errcode = '22023';
  end if;
  select count(*), array_agg(distinct workspace_id) into v_found, v_ws
  from public.transactions where id = any (p_ids) and workspace_id = any (public.editable_workspace_ids());
  if v_found = 0 or v_found <> coalesce(array_length(p_ids, 1), 0) then
    raise exception 'Transaction not found' using errcode = 'P0002';
  end if;
  if array_length(v_ws, 1) <> 1 then
    raise exception 'Transfers can only link transactions in the same workspace' using errcode = '22023';
  end if;

  -- Re-linking replaces any previous group the legs belonged to.
  delete from public.transfer_groups g
  where g.workspace_id = v_ws[1]
    and g.id in (select transfer_group_id from public.transactions where id = any (p_ids) and transfer_group_id is not null);

  insert into public.transfer_groups (workspace_id) values (v_ws[1]) returning id into v_group;
  update public.transactions
     set transfer_group_id = v_group, transaction_type = p_type
   where id = any (p_ids) and workspace_id = v_ws[1];
  return v_group;
end;
$$;


--
-- Name: list_workspace_members(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_workspace_members(p_workspace_id uuid) RETURNS TABLE(user_id uuid, email text, role text, joined_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select m.user_id, u.email::text, m.role, m.created_at
  from public.workspace_members m
  join auth.users u on u.id = m.user_id
  where m.workspace_id = p_workspace_id
    and public.workspace_role(p_workspace_id) is not null
  order by case m.role when 'owner' then 0 when 'editor' then 1 else 2 end, m.created_at;
$$;


--
-- Name: match_category_in_workspace(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_category_in_workspace(p_category_id uuid, p_target_ws uuid) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select t.id
  from public.categories c
  left join public.categories cp on cp.id = c.parent_category_id
  join public.categories t on t.workspace_id = p_target_ws and lower(t.name) = lower(c.name)
  left join public.categories tp on tp.id = t.parent_category_id
  where c.id = p_category_id
  order by (coalesce(lower(tp.name), '') = coalesce(lower(cp.name), '')) desc,
           (t.parent_category_id is not null) = (c.parent_category_id is not null) desc,
           t.active desc,
           t.sort_order
  limit 1;
$$;


--
-- Name: member_workspace_ids(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.member_workspace_ids() RETURNS uuid[]
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select coalesce(array_agg(m.workspace_id), '{}') from public.workspace_members m where m.user_id = auth.uid();
$$;


--
-- Name: monthly_cashflow(date, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.monthly_cashflow(p_end date, p_months integer DEFAULT 12) RETURNS TABLE(month date, spending numeric, income numeric)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  with months as (
    select generate_series(
      date_trunc('month', p_end)::date - make_interval(months => greatest(least(p_months, 60), 1) - 1),
      date_trunc('month', p_end)::date,
      interval '1 month'
    )::date as month
  )
  select
    m.month,
    coalesce(-sum(e.amount) filter (where e.transaction_type in ('expense','refund')), 0)::numeric(14,2),
    coalesce(sum(e.amount) filter (where e.transaction_type = 'income'), 0)::numeric(14,2)
  from months m
  left join public.countable_entries e
    on e.workspace_id = any ((select public.visible_workspace_ids())::uuid[])
   and e.transaction_date >= m.month
   and e.transaction_date < (m.month + interval '1 month')::date
  group by m.month
  order by m.month;
$$;


--
-- Name: monthly_pnl(date, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.monthly_pnl(p_end date, p_months integer DEFAULT 12) RETURNS TABLE(month date, revenue numeric, cost_of_goods numeric, operating_expenses numeric)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  with months as (
    select generate_series(
      date_trunc('month', p_end)::date - make_interval(months => greatest(least(p_months, 60), 1) - 1),
      date_trunc('month', p_end)::date,
      interval '1 month'
    )::date as month
  )
  select
    m.month,
    coalesce(sum(e.amount) filter (where e.pnl_class = 'income'), 0)::numeric(14,2),
    coalesce(-sum(e.amount) filter (where e.pnl_class = 'cost_of_goods'), 0)::numeric(14,2),
    coalesce(-sum(e.amount) filter (where e.pnl_class = 'expense'), 0)::numeric(14,2)
  from months m
  left join public.pnl_entries e
    on e.workspace_id = any ((select public.visible_workspace_ids())::uuid[])
   and e.transaction_date >= m.month
   and e.transaction_date < (m.month + interval '1 month')::date
  group by m.month
  order by m.month;
$$;


--
-- Name: move_account_to_workspace(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.move_account_to_workspace(p_account_id uuid, p_target_ws uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_new uuid;
begin
  v_new := public.copy_account_to_workspace(p_account_id, p_target_ws);
  -- A Coinbase key follows its account.
  update public.coinbase_connections set account_id = v_new where account_id = p_account_id;
  delete from public.accounts where id = p_account_id;
  return v_new;
end;
$$;


--
-- Name: my_workspace_invites(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.my_workspace_invites() RETURNS TABLE(id uuid, token text, workspace_id uuid, workspace_name text, workspace_kind text, role text, invited_by_email text, expires_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select i.id, i.token, w.id, w.name, w.kind, i.role, u.email::text, i.expires_at
  from public.workspace_invites i
  join public.workspaces w on w.id = i.workspace_id
  left join auth.users u on u.id = i.invited_by
  where i.accepted_at is null
    and i.expires_at > now()
    and lower(i.email) = lower(auth.jwt() ->> 'email')
    and not exists (select 1 from public.workspace_members m where m.workspace_id = i.workspace_id and m.user_id = auth.uid())
  order by i.created_at;
$$;


--
-- Name: my_workspaces(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.my_workspaces() RETURNS TABLE(id uuid, name text, kind text, role text, created_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select w.id, w.name, w.kind, m.role, w.created_at
  from public.workspace_members m
  join public.workspaces w on w.id = m.workspace_id
  where m.user_id = auth.uid()
  order by m.created_at, w.created_at;
$$;


--
-- Name: personal_workspace_of(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.personal_workspace_of(p_user_id uuid) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select m.workspace_id from public.workspace_members m join public.workspaces w on w.id = m.workspace_id
  where m.user_id = p_user_id and m.role = 'owner' and w.kind = 'personal'
  order by m.created_at, w.created_at limit 1;
$$;


--
-- Name: pnl_by_category(date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pnl_by_category(p_start date, p_end date) RETURNS TABLE(category_id uuid, pnl_class text, amount numeric, transaction_count bigint)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select e.category_id,
         e.pnl_class,
         (case when e.pnl_class in ('income', 'equity') then sum(e.amount) else -sum(e.amount) end)::numeric(14,2),
         count(distinct e.transaction_id)
  from public.pnl_entries e
  where e.workspace_id = any ((select public.visible_workspace_ids())::uuid[])
    and e.pnl_class is not null
    and e.transaction_date between p_start and p_end
  group by e.category_id, e.pnl_class
  order by 2, 3 desc;
$$;


--
-- Name: preview_recurring_matches(text[], text, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.preview_recurring_matches(p_patterns text[], p_mode text DEFAULT 'any'::text, p_account_id uuid DEFAULT NULL::uuid, p_recurring_item_id uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  with pats as (
    select coalesce(array(select lower(btrim(x)) from unnest(p_patterns) as x where btrim(x) <> ''), '{}') as p
  ),
  m as (
    select t.id, t.transaction_date, t.merchant_name, t.amount, t.recurring_item_id
    from public.transactions t, pats
    where t.workspace_id = any ((select public.visible_workspace_ids())::uuid[])
      and (p_account_id is null or t.account_id = p_account_id)
      and public.recurring_text_matches(pats.p, coalesce(p_mode, 'any'), t.merchant_name, t.original_description)
  )
  select jsonb_build_object(
    'total', (select count(*) from m),
    'unlinked', (select count(*) from m where recurring_item_id is null),
    'linked_elsewhere', (select count(*) from m where recurring_item_id is not null and recurring_item_id is distinct from p_recurring_item_id),
    'sample', coalesce((
      select jsonb_agg(jsonb_build_object('date', s.transaction_date, 'merchant', s.merchant_name, 'amount', s.amount))
      from (select * from m order by transaction_date desc limit 5) s), '[]'::jsonb)
  );
$$;


--
-- Name: preview_rule_matches(jsonb, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.preview_rule_matches(p_conditions jsonb, p_only_unreviewed boolean DEFAULT false) RETURNS bigint
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select count(*)
  from public.transactions t
  where t.workspace_id = any ((select public.visible_workspace_ids())::uuid[])
    and (not p_only_unreviewed or t.review_status = 'unreviewed')
    and public.rule_matches(t, p_conditions);
$$;


--
-- Name: text_array_max_length(text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.text_array_max_length(p text[]) RETURNS integer
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select coalesce(max(char_length(x)), 0) from unnest(p) as x;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: recurring_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recurring_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    merchant_pattern text,
    account_id uuid,
    category_id uuid,
    recurring_type text DEFAULT 'subscription'::text NOT NULL,
    expected_amount numeric(14,2) DEFAULT 0 NOT NULL,
    amount_type text DEFAULT 'fixed'::text NOT NULL,
    frequency text DEFAULT 'monthly'::text NOT NULL,
    interval_value integer DEFAULT 1 NOT NULL,
    next_expected_date date NOT NULL,
    end_date date,
    notes text,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    match_patterns text[] DEFAULT '{}'::text[] NOT NULL,
    match_mode text DEFAULT 'any'::text NOT NULL,
    workspace_id uuid DEFAULT public.current_workspace_id() NOT NULL,
    CONSTRAINT recurring_items_amount_type_check CHECK ((amount_type = ANY (ARRAY['fixed'::text, 'estimated'::text, 'variable'::text]))),
    CONSTRAINT recurring_items_expected_amount_check CHECK ((expected_amount >= (0)::numeric)),
    CONSTRAINT recurring_items_frequency_check CHECK ((frequency = ANY (ARRAY['weekly'::text, 'biweekly'::text, 'monthly'::text, 'quarterly'::text, 'semiannual'::text, 'annual'::text, 'custom'::text]))),
    CONSTRAINT recurring_items_interval_value_check CHECK (((interval_value >= 1) AND (interval_value <= 3650))),
    CONSTRAINT recurring_items_match_mode_check CHECK ((match_mode = ANY (ARRAY['any'::text, 'all'::text]))),
    CONSTRAINT recurring_items_match_patterns_check CHECK (((cardinality(match_patterns) <= 10) AND (public.text_array_max_length(match_patterns) <= 200))),
    CONSTRAINT recurring_items_merchant_pattern_check CHECK ((char_length(merchant_pattern) <= 200)),
    CONSTRAINT recurring_items_name_check CHECK (((char_length(btrim(name)) >= 1) AND (char_length(btrim(name)) <= 120))),
    CONSTRAINT recurring_items_notes_check CHECK ((char_length(notes) <= 2000)),
    CONSTRAINT recurring_items_recurring_type_check CHECK ((recurring_type = ANY (ARRAY['subscription'::text, 'bill'::text, 'credit_card_payment'::text, 'transfer'::text, 'income'::text, 'loan'::text, 'other'::text])))
);

ALTER TABLE ONLY public.recurring_items FORCE ROW LEVEL SECURITY;


--
-- Name: recurring_patterns(public.recurring_items); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.recurring_patterns(p_item public.recurring_items) RETURNS text[]
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select coalesce(
    nullif(array(select lower(btrim(x)) from unnest(p_item.match_patterns) as x where btrim(x) <> ''), '{}'),
    case when coalesce(btrim(p_item.merchant_pattern), '') <> '' then array[lower(btrim(p_item.merchant_pattern))] else '{}'::text[] end
  );
$$;


--
-- Name: recurring_text_matches(text[], text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.recurring_text_matches(p_patterns text[], p_mode text, p_merchant text, p_description text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select case
    when cardinality(p_patterns) = 0 then false
    when p_mode = 'all' then not exists (
      select 1 from unnest(p_patterns) as x
      where position(x in lower(coalesce(p_merchant, ''))) = 0
        and position(x in lower(coalesce(p_description, ''))) = 0)
    else exists (
      select 1 from unnest(p_patterns) as x
      where position(x in lower(coalesce(p_merchant, ''))) > 0
         or position(x in lower(coalesce(p_description, ''))) > 0)
  end;
$$;


--
-- Name: remove_account_copy(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.remove_account_copy(p_account_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_acct public.accounts;
begin
  select * into v_acct from public.accounts where id = p_account_id;
  if not found or coalesce(public.workspace_role(v_acct.workspace_id), '') not in ('owner', 'editor') then
    raise exception 'Account not found' using errcode = 'P0002';
  end if;
  if v_acct.plaid_account_id is null
     or not exists (select 1 from public.accounts where plaid_account_id = v_acct.plaid_account_id and id <> v_acct.id) then
    raise exception 'This is the only copy of the account. Move it or disconnect it instead.' using errcode = '22023';
  end if;
  delete from public.accounts where id = p_account_id;
end;
$$;


--
-- Name: remove_workspace_member(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.remove_workspace_member(p_workspace_id uuid, p_user_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if p_user_id <> auth.uid() and public.workspace_role(p_workspace_id) is distinct from 'owner' then
    raise exception 'Only an owner can remove members' using errcode = '42501';
  end if;
  if (select count(*) from public.workspace_members where workspace_id = p_workspace_id and role = 'owner' and user_id <> p_user_id) = 0 then
    raise exception 'A workspace needs at least one owner' using errcode = '22023';
  end if;
  perform public.unlink_member_connections(p_workspace_id, p_user_id);
  delete from public.workspace_members where workspace_id = p_workspace_id and user_id = p_user_id;
  if not found then
    raise exception 'Member not found' using errcode = 'P0002';
  end if;
end;
$$;


--
-- Name: request_or_personal_workspace(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.request_or_personal_workspace() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select coalesce(public.current_workspace_id(), case when public.request_workspace() is null then public.personal_workspace_of(auth.uid()) end);
$$;


--
-- Name: request_workspace(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.request_workspace() RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select nullif(btrim(coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json ->> 'x-workspace-id'), '');
$$;


--
-- Name: revoke_workspace_invite(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.revoke_workspace_invite(p_invite_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_ws uuid;
begin
  select workspace_id into v_ws from public.workspace_invites where id = p_invite_id and accepted_at is null;
  if v_ws is null or public.workspace_role(v_ws) is distinct from 'owner' then
    raise exception 'Invite not found' using errcode = 'P0002';
  end if;
  delete from public.workspace_invites where id = p_invite_id;
end;
$$;


--
-- Name: transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    transaction_date date NOT NULL,
    posted_date date,
    merchant_name text NOT NULL,
    original_description text,
    amount numeric(14,2) NOT NULL,
    currency character(3) DEFAULT 'USD'::bpchar NOT NULL,
    transaction_type text DEFAULT 'expense'::text NOT NULL,
    category_id uuid,
    status text DEFAULT 'posted'::text NOT NULL,
    review_status text DEFAULT 'unreviewed'::text NOT NULL,
    reviewed_at timestamp with time zone,
    excluded boolean DEFAULT false NOT NULL,
    recurring_item_id uuid,
    is_recurring boolean GENERATED ALWAYS AS ((recurring_item_id IS NOT NULL)) STORED,
    transfer_group_id uuid,
    notes text,
    external_transaction_id text,
    import_id uuid,
    import_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    amount_abs numeric(14,2) GENERATED ALWAYS AS (abs(amount)) STORED,
    plaid_transaction_id text,
    coinbase_transaction_id text,
    workspace_id uuid DEFAULT public.current_workspace_id() NOT NULL,
    CONSTRAINT transactions_coinbase_transaction_id_check CHECK ((char_length(coinbase_transaction_id) <= 200)),
    CONSTRAINT transactions_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT transactions_external_transaction_id_check CHECK ((char_length(external_transaction_id) <= 200)),
    CONSTRAINT transactions_import_hash_check CHECK ((char_length(import_hash) <= 128)),
    CONSTRAINT transactions_merchant_name_check CHECK (((char_length(btrim(merchant_name)) >= 1) AND (char_length(btrim(merchant_name)) <= 200))),
    CONSTRAINT transactions_notes_check CHECK ((char_length(notes) <= 5000)),
    CONSTRAINT transactions_original_description_check CHECK ((char_length(original_description) <= 500)),
    CONSTRAINT transactions_plaid_transaction_id_check CHECK ((char_length(plaid_transaction_id) <= 200)),
    CONSTRAINT transactions_review_status_check CHECK ((review_status = ANY (ARRAY['reviewed'::text, 'unreviewed'::text]))),
    CONSTRAINT transactions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'posted'::text]))),
    CONSTRAINT transactions_transaction_type_check CHECK ((transaction_type = ANY (ARRAY['expense'::text, 'income'::text, 'transfer'::text, 'credit_card_payment'::text, 'refund'::text, 'adjustment'::text])))
);

ALTER TABLE ONLY public.transactions FORCE ROW LEVEL SECURITY;


--
-- Name: rule_matches(public.transactions, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rule_matches(t public.transactions, p_conditions jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $_$
  select coalesce(bool_and(
    case c ->> 'field'
      when 'merchant' then
        case c ->> 'op'
          when 'contains'    then position(lower(c ->> 'value') in lower(t.merchant_name)) > 0
          when 'equals'      then lower(t.merchant_name) = lower(c ->> 'value')
          when 'starts_with' then left(lower(t.merchant_name), char_length(c ->> 'value')) = lower(c ->> 'value')
          else false end
      when 'description' then
        case c ->> 'op'
          when 'contains'    then position(lower(c ->> 'value') in lower(coalesce(t.original_description, t.merchant_name))) > 0
          when 'equals'      then lower(coalesce(t.original_description, t.merchant_name)) = lower(c ->> 'value')
          when 'starts_with' then left(lower(coalesce(t.original_description, t.merchant_name)), char_length(c ->> 'value')) = lower(c ->> 'value')
          else false end
      when 'account' then t.account_id::text = c ->> 'value'
      when 'amount' then
        case when (c ->> 'value') ~ '^[0-9]+(\.[0-9]{1,2})?$' then
          case c ->> 'op'
            when 'equals' then abs(t.amount) = (c ->> 'value')::numeric
            when 'gt'     then abs(t.amount) > (c ->> 'value')::numeric
            when 'lt'     then abs(t.amount) < (c ->> 'value')::numeric
            else false end
        else false end
      else false
    end), false)
  from jsonb_array_elements(p_conditions) c;
$_$;


--
-- Name: search_transactions(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.search_transactions(q text DEFAULT NULL::text) RETURNS SETOF public.transactions
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $_$
declare
  v_q   text := btrim(coalesce(q, ''));
  v_ws  uuid[] := public.visible_workspace_ids();
  v_pat text;
  v_num numeric;
begin
  if v_q = '' then
    return query select t.* from public.transactions t where t.workspace_id = any (v_ws);
    return;
  end if;

  v_pat := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  if v_q ~ '^[+-]?\$?[0-9][0-9,]*(\.[0-9]{1,2})?$' then
    v_num := abs(replace(replace(replace(v_q, '$', ''), ',', ''), '+', '')::numeric);
  end if;

  return query
  select t.*
  from public.transactions t
  where t.workspace_id = any (v_ws)
    and (
      t.merchant_name ilike v_pat
      or t.original_description ilike v_pat
      or t.notes ilike v_pat
      or (v_num is not null and abs(t.amount) = v_num)
      or exists (select 1 from public.accounts a where a.id = t.account_id and (a.name ilike v_pat or a.institution ilike v_pat))
      or exists (select 1 from public.categories c where c.id = t.category_id and c.name ilike v_pat)
      or exists (
        select 1 from public.transaction_tags tt join public.tags g on g.id = tt.tag_id
        where tt.transaction_id = t.id and g.name ilike v_pat
      )
    );
end;
$_$;


--
-- Name: seed_default_categories(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.seed_default_categories() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_ws uuid := public.request_or_personal_workspace();
begin
  if v_ws is null or public.workspace_role(v_ws) not in ('owner','editor') then
    raise exception 'Open a workspace you can edit first' using errcode = '42501';
  end if;
  return public.seed_workspace_categories(v_ws);
end;
$$;


--
-- Name: seed_workspace_categories(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.seed_workspace_categories(p_workspace_id uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_kind   text;
  v_parent uuid;
  v_count  integer := 0;
  v_rec    record;
  v_child  jsonb;
  v_i      integer := 0;
begin
  select kind into v_kind from public.workspaces where id = p_workspace_id;
  if v_kind is null then
    raise exception 'Workspace not found' using errcode = 'P0002';
  end if;

  for v_rec in
    select * from (
      -- Personal: spending categories.
      select 'personal' as kind, x.* from (values
        ('Housing',        null::text, '#A65A4E', 'home',             'expense',  '[{"n":"Mortgage"},{"n":"Rent"},{"n":"Utilities"},{"n":"Home Improvement"},{"n":"Property Maintenance"}]'::jsonb),
        ('Food',           null, '#C96442', 'utensils',         'expense',  '[{"n":"Restaurants"},{"n":"Groceries"},{"n":"Quick Eats"},{"n":"Coffee"}]'),
        ('Transportation', null, '#6B7F99', 'car',              'expense',  '[{"n":"Rideshare"},{"n":"Gas"},{"n":"Parking"},{"n":"Car Maintenance"},{"n":"Car Insurance"}]'),
        ('Travel',         null, '#5E8C87', 'plane',            'expense',  '[{"n":"Flights"},{"n":"Lodging"},{"n":"Vacation"}]'),
        ('Entertainment',  null, '#8C6A8F', 'ticket',           'expense',  '[{"n":"Streaming"},{"n":"Bars & Nightlife"},{"n":"Events"}]'),
        ('Shopping',       null, '#C49A45', 'shopping-bag',     'expense',  '[{"n":"Subscriptions"},{"n":"Clothing"},{"n":"Household"},{"n":"Misc"}]'),
        ('Health',         null, '#7D9A78', 'heart-pulse',      'expense',  '[{"n":"Healthcare"},{"n":"Gym"},{"n":"Personal Care"}]'),
        ('Financial',      null, '#8A847C', 'landmark',         'expense',  '[{"n":"Taxes"},{"n":"Fees"},{"n":"Interest"},{"n":"Loans"},{"n":"Insurance"}]'),
        ('Income',         null, '#7D9A78', 'wallet',           'income',   '[{"n":"Paycheck"},{"n":"Interest Income"},{"n":"Other Income"}]'),
        ('Transfers',      null, '#8A847C', 'arrow-left-right', 'transfer', '[{"n":"Credit Card Payment"},{"n":"Transfer"},{"n":"Investment Transfer"}]'),
        ('Other',          null, '#8A847C', 'circle-dashed',    'expense',  '[{"n":"Miscellaneous"}]')
      ) as x (name, code, color, icon, ctype, children)
      union all
      -- Business: chart of accounts, numbered, with Schedule C lines.
      select 'business', x.* from (values
        ('Revenue',               '4000', '#7D9A78', 'wallet', 'income',
          '[{"n":"Sales & Services","c":"4010","t":"Sch. C line 1"},{"n":"Returns & Allowances","c":"4050","t":"Sch. C line 2"},{"n":"Other Income","c":"4900","t":"Sch. C line 6"}]'::jsonb),
        ('Cost of Goods Sold',    '5000', '#C49A45', 'package', 'cost_of_goods',
          '[{"n":"Materials & Supplies","c":"5010","t":"Sch. C line 38"},{"n":"Subcontractors","c":"5020","t":"Sch. C line 37"},{"n":"Shipping & Fulfillment","c":"5030","t":"Sch. C line 39"}]'),
        ('Marketing',             '6100', '#C96442', 'trending-up', 'expense',
          '[{"n":"Advertising","c":"6110","t":"Sch. C line 8"},{"n":"Promotion & Sponsorships","c":"6120","t":"Sch. C line 8"}]'),
        ('Software & Office',     '6200', '#6B7F99', 'laptop', 'expense',
          '[{"n":"Software & Subscriptions","c":"6210","t":"Sch. C line 27a"},{"n":"Office Supplies","c":"6220","t":"Sch. C line 18"},{"n":"Equipment (expensed)","c":"6230","t":"Sch. C line 22"}]'),
        ('Professional Services', '6300', '#7A7296', 'briefcase', 'expense',
          '[{"n":"Legal & Accounting","c":"6310","t":"Sch. C line 17"},{"n":"Contract Labor","c":"6320","t":"Sch. C line 11"},{"n":"Commissions & Fees","c":"6330","t":"Sch. C line 10"}]'),
        ('Payroll',               '6400', '#5E8C87', 'banknote', 'expense',
          '[{"n":"Wages","c":"6410","t":"Sch. C line 26"},{"n":"Payroll Taxes","c":"6420","t":"Sch. C line 23"},{"n":"Employee Benefits","c":"6430","t":"Sch. C line 14"},{"n":"Retirement Plans","c":"6440","t":"Sch. C line 19"}]'),
        ('Travel & Meals',        '6500', '#8C6A8F', 'plane', 'expense',
          '[{"n":"Travel","c":"6510","t":"Sch. C line 24a"},{"n":"Business Meals","c":"6520","t":"Sch. C line 24b"}]'),
        ('Vehicle',               '6600', '#8A8D5A', 'car', 'expense',
          '[{"n":"Car & Truck Expenses","c":"6610","t":"Sch. C line 9"}]'),
        ('Facilities',            '6700', '#A65A4E', 'building', 'expense',
          '[{"n":"Rent & Lease","c":"6710","t":"Sch. C line 20b"},{"n":"Utilities","c":"6720","t":"Sch. C line 25"},{"n":"Phone & Internet","c":"6730","t":"Sch. C line 25"},{"n":"Repairs & Maintenance","c":"6740","t":"Sch. C line 21"}]'),
        ('Financial',             '6800', '#8A847C', 'landmark', 'expense',
          '[{"n":"Bank & Merchant Fees","c":"6810","t":"Sch. C line 27a"},{"n":"Interest Expense","c":"6820","t":"Sch. C line 16b"},{"n":"Insurance","c":"6830","t":"Sch. C line 15"},{"n":"Taxes & Licenses","c":"6840","t":"Sch. C line 23"}]'),
        ('Other Expenses',        '6900', '#A89060', 'circle-dashed', 'expense',
          '[{"n":"Education & Training","c":"6910","t":"Sch. C line 27a"},{"n":"Dues & Memberships","c":"6920","t":"Sch. C line 27a"},{"n":"Depreciation","c":"6930","t":"Sch. C line 13"},{"n":"Miscellaneous","c":"6990","t":"Sch. C line 27a"}]'),
        ('Owner''s Equity',       '3000', '#7A7296', 'piggy-bank', 'equity',
          '[{"n":"Owner Contributions","c":"3010"},{"n":"Owner Draws","c":"3020"}]'),
        ('Transfers',             '1000', '#8A847C', 'arrow-left-right', 'transfer',
          '[{"n":"Transfer Between Accounts","c":"1010"},{"n":"Credit Card Payment","c":"2010"},{"n":"Loan Principal","c":"2020"}]')
      ) as x (name, code, color, icon, ctype, children)
    ) all_rows
    where all_rows.kind = v_kind
  loop
    v_i := v_i + 1;
    select id into v_parent from public.categories
     where workspace_id = p_workspace_id and parent_category_id is null and lower(name) = lower(v_rec.name);
    if v_parent is null then
      insert into public.categories (workspace_id, name, code, color, icon, category_type, sort_order)
      values (p_workspace_id, v_rec.name, v_rec.code, v_rec.color, v_rec.icon, v_rec.ctype, v_i * 10)
      returning id into v_parent;
      v_count := v_count + 1;
    end if;

    for v_child in select * from jsonb_array_elements(v_rec.children) loop
      if not exists (select 1 from public.categories where workspace_id = p_workspace_id and parent_category_id = v_parent and lower(name) = lower(v_child ->> 'n')) then
        insert into public.categories (workspace_id, name, parent_category_id, code, tax_line, color, icon, category_type, sort_order)
        values (p_workspace_id, v_child ->> 'n', v_parent, v_child ->> 'c', v_child ->> 't', v_rec.color, null, v_rec.ctype, v_count);
        v_count := v_count + 1;
      end if;
    end loop;
  end loop;
  return v_count;
end;
$$;


--
-- Name: set_transaction_splits(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_transaction_splits(p_transaction_id uuid, p_splits jsonb) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  v_amount numeric(14,2);
  v_ws     uuid;
  v_sum    numeric(14,2);
begin
  if jsonb_typeof(p_splits) is distinct from 'array' then
    raise exception 'Splits must be a list' using errcode = '22023';
  end if;

  select t.amount, t.workspace_id into v_amount, v_ws
  from public.transactions t
  where t.id = p_transaction_id and t.workspace_id = any (public.editable_workspace_ids())
  for update;
  if not found then
    raise exception 'Transaction not found' using errcode = 'P0002';
  end if;

  delete from public.transaction_splits where transaction_id = p_transaction_id and workspace_id = v_ws;

  if jsonb_array_length(p_splits) = 0 then
    return;
  end if;
  if jsonb_array_length(p_splits) < 2 or jsonb_array_length(p_splits) > 20 then
    raise exception 'A split needs between 2 and 20 parts' using errcode = '22023';
  end if;

  select sum((s ->> 'amount')::numeric(14,2)) into v_sum from jsonb_array_elements(p_splits) s;
  if v_sum is distinct from v_amount then
    raise exception 'Split parts add up to %, but the transaction is %', v_sum, v_amount using errcode = '22023';
  end if;

  insert into public.transaction_splits (workspace_id, transaction_id, category_id, amount, notes, sort_order)
  select v_ws, p_transaction_id, nullif(x.s ->> 'category_id', '')::uuid, (x.s ->> 'amount')::numeric(14,2),
         nullif(btrim(x.s ->> 'notes'), ''), (x.ord - 1)::integer
  from jsonb_array_elements(p_splits) with ordinality as x (s, ord);
end;
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


--
-- Name: set_workspace_member_role(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_workspace_member_role(p_workspace_id uuid, p_user_id uuid, p_role text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if public.workspace_role(p_workspace_id) is distinct from 'owner' then
    raise exception 'Only an owner can change roles' using errcode = '42501';
  end if;
  if p_role not in ('owner','editor','viewer') then
    raise exception 'Invalid role' using errcode = '22023';
  end if;
  if p_role <> 'owner' and (select count(*) from public.workspace_members where workspace_id = p_workspace_id and role = 'owner' and user_id <> p_user_id) = 0 then
    raise exception 'A workspace needs at least one owner' using errcode = '22023';
  end if;
  update public.workspace_members set role = p_role where workspace_id = p_workspace_id and user_id = p_user_id;
  if not found then
    raise exception 'Member not found' using errcode = 'P0002';
  end if;
  -- Someone who can no longer edit can't keep feeding the workspace from their bank connections.
  if p_role = 'viewer' then
    perform public.unlink_member_connections(p_workspace_id, p_user_id);
  end if;
end;
$$;


--
-- Name: spending_by_category(date, date, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.spending_by_category(p_start date, p_end date, p_account_id uuid DEFAULT NULL::uuid) RETURNS TABLE(category_id uuid, amount numeric, transaction_count bigint)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select
    e.category_id,
    (-sum(e.amount))::numeric(14,2),
    count(distinct e.transaction_id)
  from public.countable_entries e
  where e.workspace_id = any ((select public.visible_workspace_ids())::uuid[])
    and e.transaction_type in ('expense','refund')
    and e.transaction_date between p_start and p_end
    and (p_account_id is null or e.account_id = p_account_id)
  group by e.category_id
  order by 2 desc;
$$;


--
-- Name: stamp_reviewed_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.stamp_reviewed_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'INSERT' or new.review_status is distinct from old.review_status then
    new.reviewed_at = case when new.review_status = 'reviewed' then now() else null end;
  end if;
  return new;
end;
$$;


--
-- Name: unlink_member_connections(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.unlink_member_connections(p_workspace_id uuid, p_user_id uuid) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  update public.accounts a set plaid_item_id = null
   where a.workspace_id = p_workspace_id
     and a.plaid_item_id in (select p.id from public.plaid_items p where p.user_id = p_user_id);
  update public.coinbase_connections c set account_id = null
   where c.user_id = p_user_id
     and c.account_id in (select a.id from public.accounts a where a.workspace_id = p_workspace_id);
$$;


--
-- Name: unlink_transfer(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.unlink_transfer(p_group_id uuid) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  delete from public.transfer_groups where id = p_group_id and workspace_id = any (public.editable_workspace_ids());
end;
$$;


--
-- Name: visible_workspace_ids(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.visible_workspace_ids() RETURNS uuid[]
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select coalesce(array_agg(m.workspace_id), '{}')
  from public.workspace_members m, (select public.request_workspace() as h) r
  where m.user_id = auth.uid()
    and (r.h = 'all' or m.workspace_id::text = r.h or (r.h is null and m.workspace_id = public.personal_workspace_of(auth.uid())));
$$;


--
-- Name: workspace_role(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.workspace_role(p_workspace_id uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select m.role from public.workspace_members m where m.workspace_id = p_workspace_id and m.user_id = auth.uid();
$$;


--
-- Name: accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    institution text,
    account_type text DEFAULT 'checking'::text NOT NULL,
    last_four text,
    currency character(3) DEFAULT 'USD'::bpchar NOT NULL,
    current_balance numeric(14,2) DEFAULT 0 NOT NULL,
    available_balance numeric(14,2),
    balance_as_of date,
    credit_limit numeric(14,2),
    statement_balance numeric(14,2),
    minimum_payment numeric(14,2),
    statement_close_day smallint,
    payment_due_day smallint,
    autopay_enabled boolean DEFAULT false NOT NULL,
    autopay_account_id uuid,
    notes text,
    sort_order integer DEFAULT 0 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    plaid_item_id uuid,
    plaid_account_id text,
    sync_from date,
    next_payment_due_date date,
    last_statement_date date,
    last_payment_amount numeric(14,2),
    last_payment_date date,
    is_overdue boolean,
    workspace_id uuid DEFAULT public.current_workspace_id() NOT NULL,
    track_transactions boolean DEFAULT true NOT NULL,
    CONSTRAINT accounts_account_type_check CHECK ((account_type = ANY (ARRAY['checking'::text, 'savings'::text, 'credit_card'::text, 'brokerage'::text, 'retirement'::text, 'loan'::text, 'mortgage'::text, 'cash'::text, 'other'::text]))),
    CONSTRAINT accounts_check CHECK (((autopay_account_id IS NULL) OR (autopay_account_id <> id))),
    CONSTRAINT accounts_credit_limit_check CHECK ((credit_limit >= (0)::numeric)),
    CONSTRAINT accounts_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT accounts_institution_check CHECK ((char_length(institution) <= 120)),
    CONSTRAINT accounts_last_four_check CHECK ((last_four ~ '^[0-9A-Za-z]{1,8}$'::text)),
    CONSTRAINT accounts_minimum_payment_check CHECK ((minimum_payment >= (0)::numeric)),
    CONSTRAINT accounts_name_check CHECK (((char_length(btrim(name)) >= 1) AND (char_length(btrim(name)) <= 120))),
    CONSTRAINT accounts_notes_check CHECK ((char_length(notes) <= 2000)),
    CONSTRAINT accounts_payment_due_day_check CHECK (((payment_due_day >= 1) AND (payment_due_day <= 31))),
    CONSTRAINT accounts_plaid_account_id_check CHECK ((char_length(plaid_account_id) <= 200)),
    CONSTRAINT accounts_statement_close_day_check CHECK (((statement_close_day >= 1) AND (statement_close_day <= 31)))
);

ALTER TABLE ONLY public.accounts FORCE ROW LEVEL SECURITY;


--
-- Name: calendar_reminders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calendar_reminders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    reminder_date date NOT NULL,
    amount numeric(14,2),
    event_type text DEFAULT 'other'::text NOT NULL,
    account_id uuid,
    notes text,
    completed boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    workspace_id uuid DEFAULT public.current_workspace_id() NOT NULL,
    CONSTRAINT calendar_reminders_amount_check CHECK ((amount >= (0)::numeric)),
    CONSTRAINT calendar_reminders_event_type_check CHECK ((event_type = ANY (ARRAY['subscription'::text, 'credit_card_payment'::text, 'bill'::text, 'transfer'::text, 'income'::text, 'other'::text]))),
    CONSTRAINT calendar_reminders_notes_check CHECK ((char_length(notes) <= 2000)),
    CONSTRAINT calendar_reminders_title_check CHECK (((char_length(btrim(title)) >= 1) AND (char_length(btrim(title)) <= 120)))
);

ALTER TABLE ONLY public.calendar_reminders FORCE ROW LEVEL SECURITY;


--
-- Name: categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    parent_category_id uuid,
    icon text,
    color text DEFAULT '#8A847C'::text NOT NULL,
    category_type text DEFAULT 'expense'::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    workspace_id uuid DEFAULT public.current_workspace_id() NOT NULL,
    code text,
    tax_line text,
    CONSTRAINT categories_category_type_check CHECK ((category_type = ANY (ARRAY['expense'::text, 'income'::text, 'transfer'::text, 'cost_of_goods'::text, 'equity'::text]))),
    CONSTRAINT categories_check CHECK (((parent_category_id IS NULL) OR (parent_category_id <> id))),
    CONSTRAINT categories_code_check CHECK ((code ~ '^[0-9A-Za-z.-]{1,12}$'::text)),
    CONSTRAINT categories_color_check CHECK ((color ~ '^#[0-9A-Fa-f]{6}$'::text)),
    CONSTRAINT categories_icon_check CHECK ((char_length(icon) <= 40)),
    CONSTRAINT categories_name_check CHECK (((char_length(btrim(name)) >= 1) AND (char_length(btrim(name)) <= 80))),
    CONSTRAINT categories_tax_line_check CHECK ((char_length(tax_line) <= 80))
);

ALTER TABLE ONLY public.categories FORCE ROW LEVEL SECURITY;


--
-- Name: categorization_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.categorization_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    conditions jsonb NOT NULL,
    actions jsonb NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    apply_on_import boolean DEFAULT true NOT NULL,
    active boolean DEFAULT true NOT NULL,
    times_applied integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    workspace_id uuid DEFAULT public.current_workspace_id() NOT NULL,
    CONSTRAINT categorization_rules_actions_check CHECK (((jsonb_typeof(actions) = 'object'::text) AND (actions <> '{}'::jsonb))),
    CONSTRAINT categorization_rules_conditions_check CHECK (((jsonb_typeof(conditions) = 'array'::text) AND ((jsonb_array_length(conditions) >= 1) AND (jsonb_array_length(conditions) <= 10)))),
    CONSTRAINT categorization_rules_name_check CHECK (((char_length(btrim(name)) >= 1) AND (char_length(btrim(name)) <= 120)))
);

ALTER TABLE ONLY public.categorization_rules FORCE ROW LEVEL SECURITY;


--
-- Name: coinbase_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coinbase_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid DEFAULT auth.uid() NOT NULL,
    key_name text NOT NULL,
    private_key_enc text NOT NULL,
    account_id uuid,
    wallets jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    last_synced_at timestamp with time zone,
    last_sync_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT coinbase_connections_key_name_check CHECK (((char_length(key_name) >= 1) AND (char_length(key_name) <= 300))),
    CONSTRAINT coinbase_connections_last_sync_error_check CHECK ((char_length(last_sync_error) <= 1000)),
    CONSTRAINT coinbase_connections_private_key_enc_check CHECK ((char_length(private_key_enc) <= 4000)),
    CONSTRAINT coinbase_connections_status_check CHECK ((status = ANY (ARRAY['active'::text, 'auth_failed'::text, 'error'::text]))),
    CONSTRAINT coinbase_connections_wallets_check CHECK ((jsonb_typeof(wallets) = 'array'::text))
);

ALTER TABLE ONLY public.coinbase_connections FORCE ROW LEVEL SECURITY;


--
-- Name: transaction_splits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transaction_splits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    transaction_id uuid NOT NULL,
    category_id uuid,
    amount numeric(14,2) NOT NULL,
    notes text,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    workspace_id uuid DEFAULT public.current_workspace_id() NOT NULL,
    CONSTRAINT transaction_splits_notes_check CHECK ((char_length(notes) <= 500))
);

ALTER TABLE ONLY public.transaction_splits FORCE ROW LEVEL SECURITY;


--
-- Name: ledger_entries; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.ledger_entries WITH (security_invoker='true') AS
 SELECT t.id AS transaction_id,
    NULL::uuid AS split_id,
    t.workspace_id,
    t.account_id,
    t.transaction_date,
    t.merchant_name,
    t.amount,
    t.category_id,
    t.transaction_type,
    t.excluded,
    t.recurring_item_id
   FROM public.transactions t
  WHERE (NOT (EXISTS ( SELECT 1
           FROM public.transaction_splits s
          WHERE (s.transaction_id = t.id))))
UNION ALL
 SELECT t.id AS transaction_id,
    s.id AS split_id,
    t.workspace_id,
    t.account_id,
    t.transaction_date,
    t.merchant_name,
    s.amount,
    s.category_id,
    t.transaction_type,
    t.excluded,
    t.recurring_item_id
   FROM (public.transactions t
     JOIN public.transaction_splits s ON ((s.transaction_id = t.id)));


--
-- Name: countable_entries; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.countable_entries WITH (security_invoker='true') AS
 SELECT e.transaction_id,
    e.split_id,
    e.workspace_id,
    e.account_id,
    e.transaction_date,
    e.merchant_name,
    e.amount,
    e.category_id,
    e.transaction_type,
    e.excluded,
    e.recurring_item_id
   FROM (public.ledger_entries e
     LEFT JOIN public.categories c ON ((c.id = e.category_id)))
  WHERE ((NOT e.excluded) AND (e.transaction_type = ANY (ARRAY['expense'::text, 'refund'::text, 'income'::text])) AND (COALESCE(c.category_type, 'expense'::text) <> ALL (ARRAY['transfer'::text, 'equity'::text])));


--
-- Name: import_rows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_rows (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    import_id uuid NOT NULL,
    row_number integer NOT NULL,
    raw jsonb NOT NULL,
    status text NOT NULL,
    transaction_id uuid,
    message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    workspace_id uuid DEFAULT public.current_workspace_id() NOT NULL,
    CONSTRAINT import_rows_message_check CHECK ((char_length(message) <= 500)),
    CONSTRAINT import_rows_raw_check CHECK ((jsonb_typeof(raw) = 'object'::text)),
    CONSTRAINT import_rows_row_number_check CHECK ((row_number >= 0)),
    CONSTRAINT import_rows_status_check CHECK ((status = ANY (ARRAY['imported'::text, 'duplicate'::text, 'skipped'::text, 'error'::text])))
);

ALTER TABLE ONLY public.import_rows FORCE ROW LEVEL SECURITY;


--
-- Name: imports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.imports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    filename text NOT NULL,
    file_size integer,
    row_count integer DEFAULT 0 NOT NULL,
    imported_count integer DEFAULT 0 NOT NULL,
    duplicate_count integer DEFAULT 0 NOT NULL,
    skipped_count integer DEFAULT 0 NOT NULL,
    error_count integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'in_progress'::text NOT NULL,
    column_mapping jsonb DEFAULT '{}'::jsonb NOT NULL,
    options jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    workspace_id uuid DEFAULT public.current_workspace_id() NOT NULL,
    CONSTRAINT imports_column_mapping_check CHECK ((jsonb_typeof(column_mapping) = 'object'::text)),
    CONSTRAINT imports_duplicate_count_check CHECK ((duplicate_count >= 0)),
    CONSTRAINT imports_error_count_check CHECK ((error_count >= 0)),
    CONSTRAINT imports_file_size_check CHECK ((file_size >= 0)),
    CONSTRAINT imports_filename_check CHECK ((char_length(filename) <= 255)),
    CONSTRAINT imports_imported_count_check CHECK ((imported_count >= 0)),
    CONSTRAINT imports_options_check CHECK ((jsonb_typeof(options) = 'object'::text)),
    CONSTRAINT imports_row_count_check CHECK ((row_count >= 0)),
    CONSTRAINT imports_skipped_count_check CHECK ((skipped_count >= 0)),
    CONSTRAINT imports_status_check CHECK ((status = ANY (ARRAY['in_progress'::text, 'completed'::text, 'failed'::text])))
);

ALTER TABLE ONLY public.imports FORCE ROW LEVEL SECURITY;


--
-- Name: plaid_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plaid_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid DEFAULT auth.uid() NOT NULL,
    item_id text NOT NULL,
    access_token_enc text NOT NULL,
    institution_id text,
    institution_name text,
    plaid_accounts jsonb DEFAULT '[]'::jsonb NOT NULL,
    cursor text,
    status text DEFAULT 'active'::text NOT NULL,
    error_code text,
    last_synced_at timestamp with time zone,
    last_sync_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    liabilities_status text,
    CONSTRAINT plaid_items_access_token_enc_check CHECK ((char_length(access_token_enc) <= 2000)),
    CONSTRAINT plaid_items_error_code_check CHECK ((char_length(error_code) <= 200)),
    CONSTRAINT plaid_items_institution_id_check CHECK ((char_length(institution_id) <= 100)),
    CONSTRAINT plaid_items_institution_name_check CHECK ((char_length(institution_name) <= 200)),
    CONSTRAINT plaid_items_item_id_check CHECK ((char_length(item_id) <= 200)),
    CONSTRAINT plaid_items_last_sync_error_check CHECK ((char_length(last_sync_error) <= 1000)),
    CONSTRAINT plaid_items_liabilities_status_check CHECK ((liabilities_status = ANY (ARRAY['ok'::text, 'pending'::text, 'consent_required'::text, 'unsupported'::text, 'not_enabled'::text, 'error'::text]))),
    CONSTRAINT plaid_items_plaid_accounts_check CHECK ((jsonb_typeof(plaid_accounts) = 'array'::text)),
    CONSTRAINT plaid_items_status_check CHECK ((status = ANY (ARRAY['active'::text, 'login_required'::text, 'error'::text])))
);

ALTER TABLE ONLY public.plaid_items FORCE ROW LEVEL SECURITY;


--
-- Name: pnl_entries; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.pnl_entries WITH (security_invoker='true') AS
 SELECT e.transaction_id,
    e.split_id,
    e.workspace_id,
    e.account_id,
    e.transaction_date,
    e.merchant_name,
    e.amount,
    e.category_id,
    e.transaction_type,
    e.excluded,
    e.recurring_item_id,
        CASE
            WHEN (c.category_type = 'equity'::text) THEN 'equity'::text
            WHEN (e.transaction_type <> ALL (ARRAY['expense'::text, 'refund'::text, 'income'::text])) THEN NULL::text
            WHEN (c.category_type = ANY (ARRAY['income'::text, 'cost_of_goods'::text, 'expense'::text])) THEN c.category_type
            WHEN (c.category_type = 'transfer'::text) THEN NULL::text
            WHEN (e.transaction_type = 'income'::text) THEN 'income'::text
            ELSE 'expense'::text
        END AS pnl_class
   FROM (public.ledger_entries e
     LEFT JOIN public.categories c ON ((c.id = e.category_id)))
  WHERE (NOT e.excluded);


--
-- Name: recurring_occurrences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recurring_occurrences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    recurring_item_id uuid NOT NULL,
    expected_date date NOT NULL,
    expected_amount numeric(14,2),
    status text DEFAULT 'projected'::text NOT NULL,
    transaction_id uuid,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    workspace_id uuid DEFAULT public.current_workspace_id() NOT NULL,
    CONSTRAINT recurring_occurrences_notes_check CHECK ((char_length(notes) <= 500)),
    CONSTRAINT recurring_occurrences_status_check CHECK ((status = ANY (ARRAY['projected'::text, 'matched'::text, 'paid'::text, 'skipped'::text, 'overdue'::text])))
);

ALTER TABLE ONLY public.recurring_occurrences FORCE ROW LEVEL SECURITY;


--
-- Name: tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    color text DEFAULT '#8A847C'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    workspace_id uuid DEFAULT public.current_workspace_id() NOT NULL,
    CONSTRAINT tags_color_check CHECK ((color ~ '^#[0-9A-Fa-f]{6}$'::text)),
    CONSTRAINT tags_name_check CHECK (((char_length(btrim(name)) >= 1) AND (char_length(btrim(name)) <= 50)))
);

ALTER TABLE ONLY public.tags FORCE ROW LEVEL SECURITY;


--
-- Name: transaction_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transaction_tags (
    transaction_id uuid NOT NULL,
    tag_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    workspace_id uuid DEFAULT public.current_workspace_id() NOT NULL
);

ALTER TABLE ONLY public.transaction_tags FORCE ROW LEVEL SECURITY;


--
-- Name: transfer_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transfer_groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    workspace_id uuid DEFAULT public.current_workspace_id() NOT NULL,
    CONSTRAINT transfer_groups_note_check CHECK ((char_length(note) <= 500))
);

ALTER TABLE ONLY public.transfer_groups FORCE ROW LEVEL SECURITY;


--
-- Name: workspace_invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    email text NOT NULL,
    role text DEFAULT 'editor'::text NOT NULL,
    token text DEFAULT (replace((gen_random_uuid())::text, '-'::text, ''::text) || replace((gen_random_uuid())::text, '-'::text, ''::text)) NOT NULL,
    invited_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '14 days'::interval) NOT NULL,
    accepted_at timestamp with time zone,
    accepted_by uuid,
    CONSTRAINT workspace_invites_email_check CHECK ((((char_length(email) >= 3) AND (char_length(email) <= 320)) AND (POSITION(('@'::text) IN (email)) > 1))),
    CONSTRAINT workspace_invites_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'editor'::text, 'viewer'::text])))
);


--
-- Name: workspace_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_members (
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'editor'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'editor'::text, 'viewer'::text])))
);


--
-- Name: workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspaces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    kind text DEFAULT 'personal'::text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspaces_kind_check CHECK ((kind = ANY (ARRAY['personal'::text, 'business'::text]))),
    CONSTRAINT workspaces_name_check CHECK (((char_length(btrim(name)) >= 1) AND (char_length(btrim(name)) <= 80)))
);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


--
-- Name: accounts accounts_workspace_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_workspace_id_id_key UNIQUE (workspace_id, id);


--
-- Name: calendar_reminders calendar_reminders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_reminders
    ADD CONSTRAINT calendar_reminders_pkey PRIMARY KEY (id);


--
-- Name: categories categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);


--
-- Name: categories categories_workspace_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_workspace_id_id_key UNIQUE (workspace_id, id);


--
-- Name: categorization_rules categorization_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categorization_rules
    ADD CONSTRAINT categorization_rules_pkey PRIMARY KEY (id);


--
-- Name: coinbase_connections coinbase_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coinbase_connections
    ADD CONSTRAINT coinbase_connections_pkey PRIMARY KEY (id);


--
-- Name: coinbase_connections coinbase_connections_user_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coinbase_connections
    ADD CONSTRAINT coinbase_connections_user_id_id_key UNIQUE (user_id, id);


--
-- Name: coinbase_connections coinbase_connections_user_id_key_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coinbase_connections
    ADD CONSTRAINT coinbase_connections_user_id_key_name_key UNIQUE (user_id, key_name);


--
-- Name: import_rows import_rows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_rows
    ADD CONSTRAINT import_rows_pkey PRIMARY KEY (id);


--
-- Name: imports imports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imports
    ADD CONSTRAINT imports_pkey PRIMARY KEY (id);


--
-- Name: imports imports_workspace_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imports
    ADD CONSTRAINT imports_workspace_id_id_key UNIQUE (workspace_id, id);


--
-- Name: plaid_items plaid_items_item_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plaid_items
    ADD CONSTRAINT plaid_items_item_id_key UNIQUE (item_id);


--
-- Name: plaid_items plaid_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plaid_items
    ADD CONSTRAINT plaid_items_pkey PRIMARY KEY (id);


--
-- Name: plaid_items plaid_items_user_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plaid_items
    ADD CONSTRAINT plaid_items_user_id_id_key UNIQUE (user_id, id);


--
-- Name: recurring_items recurring_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_items
    ADD CONSTRAINT recurring_items_pkey PRIMARY KEY (id);


--
-- Name: recurring_items recurring_items_workspace_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_items
    ADD CONSTRAINT recurring_items_workspace_id_id_key UNIQUE (workspace_id, id);


--
-- Name: recurring_occurrences recurring_occurrences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_occurrences
    ADD CONSTRAINT recurring_occurrences_pkey PRIMARY KEY (id);


--
-- Name: recurring_occurrences recurring_occurrences_recurring_item_id_expected_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_occurrences
    ADD CONSTRAINT recurring_occurrences_recurring_item_id_expected_date_key UNIQUE (recurring_item_id, expected_date);


--
-- Name: tags tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);


--
-- Name: tags tags_workspace_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_workspace_id_id_key UNIQUE (workspace_id, id);


--
-- Name: transaction_splits transaction_splits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_splits
    ADD CONSTRAINT transaction_splits_pkey PRIMARY KEY (id);


--
-- Name: transaction_tags transaction_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_tags
    ADD CONSTRAINT transaction_tags_pkey PRIMARY KEY (transaction_id, tag_id);


--
-- Name: transactions transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_pkey PRIMARY KEY (id);


--
-- Name: transactions transactions_workspace_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_workspace_id_id_key UNIQUE (workspace_id, id);


--
-- Name: transfer_groups transfer_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transfer_groups
    ADD CONSTRAINT transfer_groups_pkey PRIMARY KEY (id);


--
-- Name: transfer_groups transfer_groups_workspace_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transfer_groups
    ADD CONSTRAINT transfer_groups_workspace_id_id_key UNIQUE (workspace_id, id);


--
-- Name: workspace_invites workspace_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invites
    ADD CONSTRAINT workspace_invites_pkey PRIMARY KEY (id);


--
-- Name: workspace_invites workspace_invites_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invites
    ADD CONSTRAINT workspace_invites_token_key UNIQUE (token);


--
-- Name: workspace_members workspace_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_pkey PRIMARY KEY (workspace_id, user_id);


--
-- Name: workspaces workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);


--
-- Name: accounts_plaid_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX accounts_plaid_item_idx ON public.accounts USING btree (plaid_item_id) WHERE (plaid_item_id IS NOT NULL);


--
-- Name: accounts_ws_autopay_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX accounts_ws_autopay_idx ON public.accounts USING btree (workspace_id, autopay_account_id) WHERE (autopay_account_id IS NOT NULL);


--
-- Name: accounts_ws_name_mask_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX accounts_ws_name_mask_key ON public.accounts USING btree (workspace_id, lower(name), COALESCE(last_four, ''::text));


--
-- Name: accounts_ws_plaid_account_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX accounts_ws_plaid_account_key ON public.accounts USING btree (workspace_id, plaid_account_id) WHERE (plaid_account_id IS NOT NULL);


--
-- Name: accounts_ws_plaid_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX accounts_ws_plaid_item_idx ON public.accounts USING btree (workspace_id, plaid_item_id) WHERE (plaid_item_id IS NOT NULL);


--
-- Name: calendar_reminders_ws_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX calendar_reminders_ws_account_idx ON public.calendar_reminders USING btree (workspace_id, account_id);


--
-- Name: calendar_reminders_ws_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX calendar_reminders_ws_idx ON public.calendar_reminders USING btree (workspace_id, reminder_date);


--
-- Name: categories_ws_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX categories_ws_parent_idx ON public.categories USING btree (workspace_id, parent_category_id);


--
-- Name: categories_ws_parent_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX categories_ws_parent_name_key ON public.categories USING btree (workspace_id, COALESCE(parent_category_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));


--
-- Name: categorization_rules_ws_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX categorization_rules_ws_idx ON public.categorization_rules USING btree (workspace_id, priority);


--
-- Name: coinbase_connections_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX coinbase_connections_account_idx ON public.coinbase_connections USING btree (account_id);


--
-- Name: import_rows_ws_import_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX import_rows_ws_import_idx ON public.import_rows USING btree (workspace_id, import_id, row_number);


--
-- Name: import_rows_ws_txn_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX import_rows_ws_txn_idx ON public.import_rows USING btree (workspace_id, transaction_id);


--
-- Name: imports_ws_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX imports_ws_idx ON public.imports USING btree (workspace_id, created_at DESC);


--
-- Name: plaid_items_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX plaid_items_user_idx ON public.plaid_items USING btree (user_id);


--
-- Name: recurring_items_ws_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recurring_items_ws_account_idx ON public.recurring_items USING btree (workspace_id, account_id);


--
-- Name: recurring_items_ws_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recurring_items_ws_category_idx ON public.recurring_items USING btree (workspace_id, category_id);


--
-- Name: recurring_items_ws_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recurring_items_ws_idx ON public.recurring_items USING btree (workspace_id, active, next_expected_date);


--
-- Name: recurring_occurrences_ws_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recurring_occurrences_ws_idx ON public.recurring_occurrences USING btree (workspace_id, expected_date);


--
-- Name: recurring_occurrences_ws_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recurring_occurrences_ws_item_idx ON public.recurring_occurrences USING btree (workspace_id, recurring_item_id, expected_date);


--
-- Name: recurring_occurrences_ws_txn_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recurring_occurrences_ws_txn_idx ON public.recurring_occurrences USING btree (workspace_id, transaction_id);


--
-- Name: tags_ws_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX tags_ws_name_key ON public.tags USING btree (workspace_id, lower(name));


--
-- Name: transaction_splits_category_idx_ws; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transaction_splits_category_idx_ws ON public.transaction_splits USING btree (workspace_id, category_id);


--
-- Name: transaction_splits_txn_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transaction_splits_txn_idx ON public.transaction_splits USING btree (transaction_id);


--
-- Name: transaction_splits_ws_txn_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transaction_splits_ws_txn_idx ON public.transaction_splits USING btree (workspace_id, transaction_id);


--
-- Name: transaction_tags_ws_tag_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transaction_tags_ws_tag_idx ON public.transaction_tags USING btree (workspace_id, tag_id);


--
-- Name: transaction_tags_ws_txn_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transaction_tags_ws_txn_idx ON public.transaction_tags USING btree (workspace_id, transaction_id);


--
-- Name: transactions_desc_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_desc_trgm_idx ON public.transactions USING gin (original_description extensions.gin_trgm_ops);


--
-- Name: transactions_import_hash_idx_ws; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_import_hash_idx_ws ON public.transactions USING btree (workspace_id, import_hash);


--
-- Name: transactions_merchant_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_merchant_trgm_idx ON public.transactions USING gin (merchant_name extensions.gin_trgm_ops);


--
-- Name: transactions_ws_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_ws_account_idx ON public.transactions USING btree (workspace_id, account_id, transaction_date DESC);


--
-- Name: transactions_ws_amount_abs_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_ws_amount_abs_idx ON public.transactions USING btree (workspace_id, amount_abs DESC);


--
-- Name: transactions_ws_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_ws_category_idx ON public.transactions USING btree (workspace_id, category_id, transaction_date DESC);


--
-- Name: transactions_ws_coinbase_txn_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX transactions_ws_coinbase_txn_key ON public.transactions USING btree (workspace_id, coinbase_transaction_id) WHERE (coinbase_transaction_id IS NOT NULL);


--
-- Name: transactions_ws_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_ws_date_idx ON public.transactions USING btree (workspace_id, transaction_date DESC, id DESC);


--
-- Name: transactions_ws_import_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_ws_import_idx ON public.transactions USING btree (workspace_id, import_id);


--
-- Name: transactions_ws_plaid_txn_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX transactions_ws_plaid_txn_key ON public.transactions USING btree (workspace_id, plaid_transaction_id) WHERE (plaid_transaction_id IS NOT NULL);


--
-- Name: transactions_ws_recurring_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_ws_recurring_idx ON public.transactions USING btree (workspace_id, recurring_item_id, transaction_date DESC);


--
-- Name: transactions_ws_review_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_ws_review_idx ON public.transactions USING btree (workspace_id, review_status, transaction_date DESC);


--
-- Name: transactions_ws_transfer_group_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_ws_transfer_group_idx ON public.transactions USING btree (workspace_id, transfer_group_id);


--
-- Name: transactions_ws_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_ws_type_idx ON public.transactions USING btree (workspace_id, transaction_type, transaction_date DESC);


--
-- Name: workspace_invites_accepted_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_invites_accepted_by_idx ON public.workspace_invites USING btree (accepted_by);


--
-- Name: workspace_invites_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_invites_email_idx ON public.workspace_invites USING btree (lower(email)) WHERE (accepted_at IS NULL);


--
-- Name: workspace_invites_invited_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_invites_invited_by_idx ON public.workspace_invites USING btree (invited_by);


--
-- Name: workspace_invites_pending_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspace_invites_pending_key ON public.workspace_invites USING btree (workspace_id, lower(email)) WHERE (accepted_at IS NULL);


--
-- Name: workspace_members_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_members_user_idx ON public.workspace_members USING btree (user_id);


--
-- Name: workspaces_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspaces_created_by_idx ON public.workspaces USING btree (created_by);


--
-- Name: accounts accounts_clear_plaid_link; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER accounts_clear_plaid_link BEFORE UPDATE OF plaid_item_id ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.clear_plaid_account_link();


--
-- Name: accounts accounts_guard_plaid_item; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER accounts_guard_plaid_item BEFORE INSERT OR UPDATE OF plaid_item_id, workspace_id ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.guard_account_plaid_item();


--
-- Name: accounts accounts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER accounts_updated_at BEFORE UPDATE ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: calendar_reminders calendar_reminders_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER calendar_reminders_updated_at BEFORE UPDATE ON public.calendar_reminders FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: categories categories_depth; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER categories_depth BEFORE INSERT OR UPDATE OF parent_category_id ON public.categories FOR EACH ROW EXECUTE FUNCTION public.enforce_category_depth();


--
-- Name: categories categories_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER categories_updated_at BEFORE UPDATE ON public.categories FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: categorization_rules categorization_rules_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER categorization_rules_updated_at BEFORE UPDATE ON public.categorization_rules FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: coinbase_connections coinbase_connections_guard_account; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER coinbase_connections_guard_account BEFORE INSERT OR UPDATE OF account_id ON public.coinbase_connections FOR EACH ROW EXECUTE FUNCTION public.guard_coinbase_account();


--
-- Name: coinbase_connections coinbase_connections_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER coinbase_connections_updated_at BEFORE UPDATE ON public.coinbase_connections FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: plaid_items plaid_items_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER plaid_items_updated_at BEFORE UPDATE ON public.plaid_items FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: recurring_items recurring_items_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER recurring_items_updated_at BEFORE UPDATE ON public.recurring_items FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: recurring_occurrences recurring_occurrences_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER recurring_occurrences_updated_at BEFORE UPDATE ON public.recurring_occurrences FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: transactions transactions_reviewed_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER transactions_reviewed_at BEFORE INSERT OR UPDATE OF review_status ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.stamp_reviewed_at();


--
-- Name: transactions transactions_split_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER transactions_split_guard BEFORE UPDATE OF amount ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.guard_split_amount();


--
-- Name: transactions transactions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER transactions_updated_at BEFORE UPDATE ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: workspaces workspaces_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER workspaces_updated_at BEFORE UPDATE ON public.workspaces FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: accounts accounts_plaid_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_plaid_item_id_fkey FOREIGN KEY (plaid_item_id) REFERENCES public.plaid_items(id) ON DELETE SET NULL;


--
-- Name: accounts accounts_workspace_id_autopay_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_workspace_id_autopay_account_id_fkey FOREIGN KEY (workspace_id, autopay_account_id) REFERENCES public.accounts(workspace_id, id) ON DELETE SET NULL (autopay_account_id);


--
-- Name: accounts accounts_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: calendar_reminders calendar_reminders_workspace_id_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_reminders
    ADD CONSTRAINT calendar_reminders_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES public.accounts(workspace_id, id) ON DELETE SET NULL (account_id);


--
-- Name: calendar_reminders calendar_reminders_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_reminders
    ADD CONSTRAINT calendar_reminders_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: categories categories_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: categories categories_workspace_id_parent_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_workspace_id_parent_category_id_fkey FOREIGN KEY (workspace_id, parent_category_id) REFERENCES public.categories(workspace_id, id) ON DELETE SET NULL (parent_category_id);


--
-- Name: categorization_rules categorization_rules_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categorization_rules
    ADD CONSTRAINT categorization_rules_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: coinbase_connections coinbase_connections_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coinbase_connections
    ADD CONSTRAINT coinbase_connections_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: coinbase_connections coinbase_connections_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coinbase_connections
    ADD CONSTRAINT coinbase_connections_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: import_rows import_rows_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_rows
    ADD CONSTRAINT import_rows_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: import_rows import_rows_workspace_id_import_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_rows
    ADD CONSTRAINT import_rows_workspace_id_import_id_fkey FOREIGN KEY (workspace_id, import_id) REFERENCES public.imports(workspace_id, id) ON DELETE CASCADE;


--
-- Name: import_rows import_rows_workspace_id_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_rows
    ADD CONSTRAINT import_rows_workspace_id_transaction_id_fkey FOREIGN KEY (workspace_id, transaction_id) REFERENCES public.transactions(workspace_id, id) ON DELETE SET NULL (transaction_id);


--
-- Name: imports imports_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imports
    ADD CONSTRAINT imports_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: plaid_items plaid_items_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plaid_items
    ADD CONSTRAINT plaid_items_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: recurring_items recurring_items_workspace_id_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_items
    ADD CONSTRAINT recurring_items_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES public.accounts(workspace_id, id) ON DELETE SET NULL (account_id);


--
-- Name: recurring_items recurring_items_workspace_id_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_items
    ADD CONSTRAINT recurring_items_workspace_id_category_id_fkey FOREIGN KEY (workspace_id, category_id) REFERENCES public.categories(workspace_id, id) ON DELETE SET NULL (category_id);


--
-- Name: recurring_items recurring_items_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_items
    ADD CONSTRAINT recurring_items_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: recurring_occurrences recurring_occurrences_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_occurrences
    ADD CONSTRAINT recurring_occurrences_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: recurring_occurrences recurring_occurrences_workspace_id_recurring_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_occurrences
    ADD CONSTRAINT recurring_occurrences_workspace_id_recurring_item_id_fkey FOREIGN KEY (workspace_id, recurring_item_id) REFERENCES public.recurring_items(workspace_id, id) ON DELETE CASCADE;


--
-- Name: recurring_occurrences recurring_occurrences_workspace_id_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_occurrences
    ADD CONSTRAINT recurring_occurrences_workspace_id_transaction_id_fkey FOREIGN KEY (workspace_id, transaction_id) REFERENCES public.transactions(workspace_id, id) ON DELETE SET NULL (transaction_id);


--
-- Name: tags tags_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: transaction_splits transaction_splits_workspace_id_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_splits
    ADD CONSTRAINT transaction_splits_workspace_id_category_id_fkey FOREIGN KEY (workspace_id, category_id) REFERENCES public.categories(workspace_id, id) ON DELETE SET NULL (category_id);


--
-- Name: transaction_splits transaction_splits_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_splits
    ADD CONSTRAINT transaction_splits_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: transaction_splits transaction_splits_workspace_id_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_splits
    ADD CONSTRAINT transaction_splits_workspace_id_transaction_id_fkey FOREIGN KEY (workspace_id, transaction_id) REFERENCES public.transactions(workspace_id, id) ON DELETE CASCADE;


--
-- Name: transaction_tags transaction_tags_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_tags
    ADD CONSTRAINT transaction_tags_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: transaction_tags transaction_tags_workspace_id_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_tags
    ADD CONSTRAINT transaction_tags_workspace_id_tag_id_fkey FOREIGN KEY (workspace_id, tag_id) REFERENCES public.tags(workspace_id, id) ON DELETE CASCADE;


--
-- Name: transaction_tags transaction_tags_workspace_id_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transaction_tags
    ADD CONSTRAINT transaction_tags_workspace_id_transaction_id_fkey FOREIGN KEY (workspace_id, transaction_id) REFERENCES public.transactions(workspace_id, id) ON DELETE CASCADE;


--
-- Name: transactions transactions_workspace_id_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES public.accounts(workspace_id, id) ON DELETE CASCADE;


--
-- Name: transactions transactions_workspace_id_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_workspace_id_category_id_fkey FOREIGN KEY (workspace_id, category_id) REFERENCES public.categories(workspace_id, id) ON DELETE SET NULL (category_id);


--
-- Name: transactions transactions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: transactions transactions_workspace_id_import_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_workspace_id_import_id_fkey FOREIGN KEY (workspace_id, import_id) REFERENCES public.imports(workspace_id, id) ON DELETE SET NULL (import_id);


--
-- Name: transactions transactions_workspace_id_recurring_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_workspace_id_recurring_item_id_fkey FOREIGN KEY (workspace_id, recurring_item_id) REFERENCES public.recurring_items(workspace_id, id) ON DELETE SET NULL (recurring_item_id);


--
-- Name: transactions transactions_workspace_id_transfer_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_workspace_id_transfer_group_id_fkey FOREIGN KEY (workspace_id, transfer_group_id) REFERENCES public.transfer_groups(workspace_id, id) ON DELETE SET NULL (transfer_group_id);


--
-- Name: transfer_groups transfer_groups_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transfer_groups
    ADD CONSTRAINT transfer_groups_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_invites workspace_invites_accepted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invites
    ADD CONSTRAINT workspace_invites_accepted_by_fkey FOREIGN KEY (accepted_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: workspace_invites workspace_invites_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invites
    ADD CONSTRAINT workspace_invites_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: workspace_invites workspace_invites_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invites
    ADD CONSTRAINT workspace_invites_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_members workspace_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: workspace_members workspace_members_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspaces workspaces_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: accounts accounts_delete_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY accounts_delete_editor ON public.accounts FOR DELETE TO authenticated USING ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: accounts accounts_insert_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY accounts_insert_editor ON public.accounts FOR INSERT TO authenticated WITH CHECK ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: accounts accounts_select_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY accounts_select_member ON public.accounts FOR SELECT TO authenticated USING ((workspace_id = ANY (( SELECT public.visible_workspace_ids() AS visible_workspace_ids)::uuid[])));


--
-- Name: accounts accounts_update_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY accounts_update_editor ON public.accounts FOR UPDATE TO authenticated USING ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[]))) WITH CHECK ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: calendar_reminders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.calendar_reminders ENABLE ROW LEVEL SECURITY;

--
-- Name: calendar_reminders calendar_reminders_delete_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY calendar_reminders_delete_editor ON public.calendar_reminders FOR DELETE TO authenticated USING ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: calendar_reminders calendar_reminders_insert_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY calendar_reminders_insert_editor ON public.calendar_reminders FOR INSERT TO authenticated WITH CHECK ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: calendar_reminders calendar_reminders_select_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY calendar_reminders_select_member ON public.calendar_reminders FOR SELECT TO authenticated USING ((workspace_id = ANY (( SELECT public.visible_workspace_ids() AS visible_workspace_ids)::uuid[])));


--
-- Name: calendar_reminders calendar_reminders_update_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY calendar_reminders_update_editor ON public.calendar_reminders FOR UPDATE TO authenticated USING ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[]))) WITH CHECK ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: categories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;

--
-- Name: categories categories_delete_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY categories_delete_editor ON public.categories FOR DELETE TO authenticated USING ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: categories categories_insert_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY categories_insert_editor ON public.categories FOR INSERT TO authenticated WITH CHECK ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: categories categories_select_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY categories_select_member ON public.categories FOR SELECT TO authenticated USING ((workspace_id = ANY (( SELECT public.visible_workspace_ids() AS visible_workspace_ids)::uuid[])));


--
-- Name: categories categories_update_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY categories_update_editor ON public.categories FOR UPDATE TO authenticated USING ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[]))) WITH CHECK ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: categorization_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.categorization_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: categorization_rules categorization_rules_delete_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY categorization_rules_delete_editor ON public.categorization_rules FOR DELETE TO authenticated USING ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: categorization_rules categorization_rules_insert_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY categorization_rules_insert_editor ON public.categorization_rules FOR INSERT TO authenticated WITH CHECK ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: categorization_rules categorization_rules_select_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY categorization_rules_select_member ON public.categorization_rules FOR SELECT TO authenticated USING ((workspace_id = ANY (( SELECT public.visible_workspace_ids() AS visible_workspace_ids)::uuid[])));


--
-- Name: categorization_rules categorization_rules_update_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY categorization_rules_update_editor ON public.categorization_rules FOR UPDATE TO authenticated USING ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[]))) WITH CHECK ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: coinbase_connections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.coinbase_connections ENABLE ROW LEVEL SECURITY;

--
-- Name: coinbase_connections coinbase_connections_delete_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY coinbase_connections_delete_own ON public.coinbase_connections FOR DELETE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: coinbase_connections coinbase_connections_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY coinbase_connections_insert_own ON public.coinbase_connections FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: coinbase_connections coinbase_connections_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY coinbase_connections_select_own ON public.coinbase_connections FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: coinbase_connections coinbase_connections_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY coinbase_connections_update_own ON public.coinbase_connections FOR UPDATE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: import_rows; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.import_rows ENABLE ROW LEVEL SECURITY;

--
-- Name: import_rows import_rows_delete_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY import_rows_delete_editor ON public.import_rows FOR DELETE TO authenticated USING ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: import_rows import_rows_insert_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY import_rows_insert_editor ON public.import_rows FOR INSERT TO authenticated WITH CHECK ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: import_rows import_rows_select_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY import_rows_select_member ON public.import_rows FOR SELECT TO authenticated USING ((workspace_id = ANY (( SELECT public.visible_workspace_ids() AS visible_workspace_ids)::uuid[])));


--
-- Name: import_rows import_rows_update_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY import_rows_update_editor ON public.import_rows FOR UPDATE TO authenticated USING ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[]))) WITH CHECK ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: imports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.imports ENABLE ROW LEVEL SECURITY;

--
-- Name: imports imports_delete_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY imports_delete_editor ON public.imports FOR DELETE TO authenticated USING ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: imports imports_insert_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY imports_insert_editor ON public.imports FOR INSERT TO authenticated WITH CHECK ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: imports imports_select_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY imports_select_member ON public.imports FOR SELECT TO authenticated USING ((workspace_id = ANY (( SELECT public.visible_workspace_ids() AS visible_workspace_ids)::uuid[])));


--
-- Name: imports imports_update_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY imports_update_editor ON public.imports FOR UPDATE TO authenticated USING ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[]))) WITH CHECK ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: plaid_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.plaid_items ENABLE ROW LEVEL SECURITY;

--
-- Name: plaid_items plaid_items_delete_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY plaid_items_delete_own ON public.plaid_items FOR DELETE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: plaid_items plaid_items_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY plaid_items_insert_own ON public.plaid_items FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: plaid_items plaid_items_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY plaid_items_select_own ON public.plaid_items FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: plaid_items plaid_items_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY plaid_items_update_own ON public.plaid_items FOR UPDATE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: recurring_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.recurring_items ENABLE ROW LEVEL SECURITY;

--
-- Name: recurring_items recurring_items_delete_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY recurring_items_delete_editor ON public.recurring_items FOR DELETE TO authenticated USING ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: recurring_items recurring_items_insert_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY recurring_items_insert_editor ON public.recurring_items FOR INSERT TO authenticated WITH CHECK ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: recurring_items recurring_items_select_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY recurring_items_select_member ON public.recurring_items FOR SELECT TO authenticated USING ((workspace_id = ANY (( SELECT public.visible_workspace_ids() AS visible_workspace_ids)::uuid[])));


--
-- Name: recurring_items recurring_items_update_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY recurring_items_update_editor ON public.recurring_items FOR UPDATE TO authenticated USING ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[]))) WITH CHECK ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: recurring_occurrences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.recurring_occurrences ENABLE ROW LEVEL SECURITY;

--
-- Name: recurring_occurrences recurring_occurrences_delete_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY recurring_occurrences_delete_editor ON public.recurring_occurrences FOR DELETE TO authenticated USING ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: recurring_occurrences recurring_occurrences_insert_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY recurring_occurrences_insert_editor ON public.recurring_occurrences FOR INSERT TO authenticated WITH CHECK ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: recurring_occurrences recurring_occurrences_select_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY recurring_occurrences_select_member ON public.recurring_occurrences FOR SELECT TO authenticated USING ((workspace_id = ANY (( SELECT public.visible_workspace_ids() AS visible_workspace_ids)::uuid[])));


--
-- Name: recurring_occurrences recurring_occurrences_update_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY recurring_occurrences_update_editor ON public.recurring_occurrences FOR UPDATE TO authenticated USING ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[]))) WITH CHECK ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: tags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tags ENABLE ROW LEVEL SECURITY;

--
-- Name: tags tags_delete_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tags_delete_editor ON public.tags FOR DELETE TO authenticated USING ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: tags tags_insert_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tags_insert_editor ON public.tags FOR INSERT TO authenticated WITH CHECK ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: tags tags_select_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tags_select_member ON public.tags FOR SELECT TO authenticated USING ((workspace_id = ANY (( SELECT public.visible_workspace_ids() AS visible_workspace_ids)::uuid[])));


--
-- Name: tags tags_update_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tags_update_editor ON public.tags FOR UPDATE TO authenticated USING ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[]))) WITH CHECK ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: transaction_splits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.transaction_splits ENABLE ROW LEVEL SECURITY;

--
-- Name: transaction_splits transaction_splits_delete_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transaction_splits_delete_editor ON public.transaction_splits FOR DELETE TO authenticated USING ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: transaction_splits transaction_splits_insert_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transaction_splits_insert_editor ON public.transaction_splits FOR INSERT TO authenticated WITH CHECK ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: transaction_splits transaction_splits_select_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transaction_splits_select_member ON public.transaction_splits FOR SELECT TO authenticated USING ((workspace_id = ANY (( SELECT public.visible_workspace_ids() AS visible_workspace_ids)::uuid[])));


--
-- Name: transaction_splits transaction_splits_update_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transaction_splits_update_editor ON public.transaction_splits FOR UPDATE TO authenticated USING ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[]))) WITH CHECK ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: transaction_tags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.transaction_tags ENABLE ROW LEVEL SECURITY;

--
-- Name: transaction_tags transaction_tags_delete_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transaction_tags_delete_editor ON public.transaction_tags FOR DELETE TO authenticated USING ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: transaction_tags transaction_tags_insert_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transaction_tags_insert_editor ON public.transaction_tags FOR INSERT TO authenticated WITH CHECK ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: transaction_tags transaction_tags_select_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transaction_tags_select_member ON public.transaction_tags FOR SELECT TO authenticated USING ((workspace_id = ANY (( SELECT public.visible_workspace_ids() AS visible_workspace_ids)::uuid[])));


--
-- Name: transaction_tags transaction_tags_update_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transaction_tags_update_editor ON public.transaction_tags FOR UPDATE TO authenticated USING ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[]))) WITH CHECK ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

--
-- Name: transactions transactions_delete_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transactions_delete_editor ON public.transactions FOR DELETE TO authenticated USING ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: transactions transactions_insert_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transactions_insert_editor ON public.transactions FOR INSERT TO authenticated WITH CHECK ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: transactions transactions_select_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transactions_select_member ON public.transactions FOR SELECT TO authenticated USING ((workspace_id = ANY (( SELECT public.visible_workspace_ids() AS visible_workspace_ids)::uuid[])));


--
-- Name: transactions transactions_update_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transactions_update_editor ON public.transactions FOR UPDATE TO authenticated USING ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[]))) WITH CHECK ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: transfer_groups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.transfer_groups ENABLE ROW LEVEL SECURITY;

--
-- Name: transfer_groups transfer_groups_delete_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transfer_groups_delete_editor ON public.transfer_groups FOR DELETE TO authenticated USING ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: transfer_groups transfer_groups_insert_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transfer_groups_insert_editor ON public.transfer_groups FOR INSERT TO authenticated WITH CHECK ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: transfer_groups transfer_groups_select_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transfer_groups_select_member ON public.transfer_groups FOR SELECT TO authenticated USING ((workspace_id = ANY (( SELECT public.visible_workspace_ids() AS visible_workspace_ids)::uuid[])));


--
-- Name: transfer_groups transfer_groups_update_editor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transfer_groups_update_editor ON public.transfer_groups FOR UPDATE TO authenticated USING ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[]))) WITH CHECK ((workspace_id = ANY (( SELECT public.editable_workspace_ids() AS editable_workspace_ids)::uuid[])));


--
-- Name: workspace_invites; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workspace_invites ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_invites workspace_invites_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY workspace_invites_select ON public.workspace_invites FOR SELECT TO authenticated USING (((( SELECT public.workspace_role(workspace_invites.workspace_id) AS workspace_role) = 'owner'::text) OR (lower(email) = lower(( SELECT (auth.jwt() ->> 'email'::text))))));


--
-- Name: workspace_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_members workspace_members_select_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY workspace_members_select_member ON public.workspace_members FOR SELECT TO authenticated USING ((workspace_id = ANY (( SELECT public.member_workspace_ids() AS member_workspace_ids)::uuid[])));


--
-- Name: workspaces; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;

--
-- Name: workspaces workspaces_select_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY workspaces_select_member ON public.workspaces FOR SELECT TO authenticated USING ((id = ANY (( SELECT public.member_workspace_ids() AS member_workspace_ids)::uuid[])));


--
-- Name: workspaces workspaces_update_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY workspaces_update_owner ON public.workspaces FOR UPDATE TO authenticated USING ((( SELECT public.workspace_role(workspaces.id) AS workspace_role) = 'owner'::text)) WITH CHECK ((( SELECT public.workspace_role(workspaces.id) AS workspace_role) = 'owner'::text));

-- =============================================================================
-- Permissions
--
-- Explicit grants for every table, view and function, so the result is the same
-- whatever default privileges the project has. Row-level security decides which
-- rows a signed-in user can see; `anon` gets no table access at all.
-- =============================================================================

revoke all on function public.accept_workspace_invite(text) from public, anon, authenticated, service_role;
grant execute on function public.accept_workspace_invite(text) to authenticated, service_role;
revoke all on function public.apply_categorization_rules(uuid[],uuid,boolean,boolean) from public, anon, authenticated, service_role;
grant execute on function public.apply_categorization_rules(uuid[],uuid,boolean,boolean) to authenticated, service_role;
revoke all on function public.apply_categorization_rules_as(uuid,uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.apply_categorization_rules_as(uuid,uuid[]) to service_role;
revoke all on function public.auto_link_recurring(uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.auto_link_recurring(uuid[]) to authenticated, service_role;
revoke all on function public.auto_link_recurring_as(uuid,uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.auto_link_recurring_as(uuid,uuid[]) to service_role;
revoke all on function public.bulk_add_tag(uuid[],uuid) from public, anon, authenticated, service_role;
grant execute on function public.bulk_add_tag(uuid[],uuid) to authenticated, service_role;
revoke all on function public.bulk_delete_transactions(uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.bulk_delete_transactions(uuid[]) to authenticated, service_role;
revoke all on function public.bulk_update_transactions(uuid[],jsonb) from public, anon, authenticated, service_role;
grant execute on function public.bulk_update_transactions(uuid[],jsonb) to authenticated, service_role;
revoke all on function public.business_summary(date,date) from public, anon, authenticated, service_role;
grant execute on function public.business_summary(date,date) to authenticated, service_role;
revoke all on function public.cashflow_summary(date,date,uuid) from public, anon, authenticated, service_role;
grant execute on function public.cashflow_summary(date,date,uuid) to authenticated, service_role;
revoke all on function public.clear_plaid_account_link() from public, anon, authenticated, service_role;
grant execute on function public.clear_plaid_account_link() to anon, authenticated, public, service_role;
revoke all on function public.copy_account_to_workspace(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.copy_account_to_workspace(uuid,uuid) to authenticated, service_role;
revoke all on function public.create_workspace(text,text) from public, anon, authenticated, service_role;
grant execute on function public.create_workspace(text,text) to authenticated, service_role;
revoke all on function public.current_workspace_id() from public, anon, authenticated, service_role;
grant execute on function public.current_workspace_id() to authenticated, service_role;
revoke all on function public.delete_all_my_data(text) from public, anon, authenticated, service_role;
grant execute on function public.delete_all_my_data(text) to authenticated, service_role;
revoke all on function public.delete_workspace(uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.delete_workspace(uuid,text) to authenticated, service_role;
revoke all on function public.editable_workspace_ids() from public, anon, authenticated, service_role;
grant execute on function public.editable_workspace_ids() to authenticated, service_role;
revoke all on function public.enforce_category_depth() from public, anon, authenticated, service_role;
grant execute on function public.enforce_category_depth() to anon, authenticated, public, service_role;
revoke all on function public.ensure_personal_workspace(text) from public, anon, authenticated, service_role;
grant execute on function public.ensure_personal_workspace(text) to authenticated, service_role;
revoke all on function public.guard_account_plaid_item() from public, anon, authenticated, service_role;
grant execute on function public.guard_account_plaid_item() to service_role;
revoke all on function public.guard_coinbase_account() from public, anon, authenticated, service_role;
grant execute on function public.guard_coinbase_account() to service_role;
revoke all on function public.guard_split_amount() from public, anon, authenticated, service_role;
grant execute on function public.guard_split_amount() to anon, authenticated, public, service_role;
revoke all on function public.invite_to_workspace(uuid,text,text) from public, anon, authenticated, service_role;
grant execute on function public.invite_to_workspace(uuid,text,text) to authenticated, service_role;
revoke all on function public.link_recurring_transactions(uuid) from public, anon, authenticated, service_role;
grant execute on function public.link_recurring_transactions(uuid) to authenticated, service_role;
revoke all on function public.link_transfer(uuid[],text) from public, anon, authenticated, service_role;
grant execute on function public.link_transfer(uuid[],text) to authenticated, service_role;
revoke all on function public.list_workspace_members(uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_workspace_members(uuid) to authenticated, service_role;
revoke all on function public.match_category_in_workspace(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.match_category_in_workspace(uuid,uuid) to service_role;
revoke all on function public.member_workspace_ids() from public, anon, authenticated, service_role;
grant execute on function public.member_workspace_ids() to authenticated, service_role;
revoke all on function public.monthly_cashflow(date,integer) from public, anon, authenticated, service_role;
grant execute on function public.monthly_cashflow(date,integer) to authenticated, service_role;
revoke all on function public.monthly_pnl(date,integer) from public, anon, authenticated, service_role;
grant execute on function public.monthly_pnl(date,integer) to authenticated, service_role;
revoke all on function public.move_account_to_workspace(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.move_account_to_workspace(uuid,uuid) to authenticated, service_role;
revoke all on function public.my_workspace_invites() from public, anon, authenticated, service_role;
grant execute on function public.my_workspace_invites() to authenticated, service_role;
revoke all on function public.my_workspaces() from public, anon, authenticated, service_role;
grant execute on function public.my_workspaces() to authenticated, service_role;
revoke all on function public.personal_workspace_of(uuid) from public, anon, authenticated, service_role;
grant execute on function public.personal_workspace_of(uuid) to service_role;
revoke all on function public.pnl_by_category(date,date) from public, anon, authenticated, service_role;
grant execute on function public.pnl_by_category(date,date) to authenticated, service_role;
revoke all on function public.preview_recurring_matches(text[],text,uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.preview_recurring_matches(text[],text,uuid,uuid) to authenticated, service_role;
revoke all on function public.preview_rule_matches(jsonb,boolean) from public, anon, authenticated, service_role;
grant execute on function public.preview_rule_matches(jsonb,boolean) to authenticated, service_role;
revoke all on function public.recurring_patterns(public.recurring_items) from public, anon, authenticated, service_role;
grant execute on function public.recurring_patterns(public.recurring_items) to anon, authenticated, public, service_role;
revoke all on function public.recurring_text_matches(text[],text,text,text) from public, anon, authenticated, service_role;
grant execute on function public.recurring_text_matches(text[],text,text,text) to anon, authenticated, public, service_role;
revoke all on function public.remove_account_copy(uuid) from public, anon, authenticated, service_role;
grant execute on function public.remove_account_copy(uuid) to authenticated, service_role;
revoke all on function public.remove_workspace_member(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.remove_workspace_member(uuid,uuid) to authenticated, service_role;
revoke all on function public.request_or_personal_workspace() from public, anon, authenticated, service_role;
grant execute on function public.request_or_personal_workspace() to authenticated, service_role;
revoke all on function public.request_workspace() from public, anon, authenticated, service_role;
grant execute on function public.request_workspace() to authenticated, service_role;
revoke all on function public.revoke_workspace_invite(uuid) from public, anon, authenticated, service_role;
grant execute on function public.revoke_workspace_invite(uuid) to authenticated, service_role;
revoke all on function public.rule_matches(public.transactions,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.rule_matches(public.transactions,jsonb) to anon, authenticated, public, service_role;
revoke all on function public.search_transactions(text) from public, anon, authenticated, service_role;
grant execute on function public.search_transactions(text) to authenticated, service_role;
revoke all on function public.seed_default_categories() from public, anon, authenticated, service_role;
grant execute on function public.seed_default_categories() to authenticated, service_role;
revoke all on function public.seed_workspace_categories(uuid) from public, anon, authenticated, service_role;
grant execute on function public.seed_workspace_categories(uuid) to service_role;
revoke all on function public.set_transaction_splits(uuid,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.set_transaction_splits(uuid,jsonb) to authenticated, service_role;
revoke all on function public.set_updated_at() from public, anon, authenticated, service_role;
grant execute on function public.set_updated_at() to anon, authenticated, public, service_role;
revoke all on function public.set_workspace_member_role(uuid,uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.set_workspace_member_role(uuid,uuid,text) to authenticated, service_role;
revoke all on function public.spending_by_category(date,date,uuid) from public, anon, authenticated, service_role;
grant execute on function public.spending_by_category(date,date,uuid) to authenticated, service_role;
revoke all on function public.stamp_reviewed_at() from public, anon, authenticated, service_role;
grant execute on function public.stamp_reviewed_at() to anon, authenticated, public, service_role;
revoke all on function public.text_array_max_length(text[]) from public, anon, authenticated, service_role;
grant execute on function public.text_array_max_length(text[]) to anon, authenticated, public, service_role;
revoke all on function public.unlink_member_connections(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.unlink_member_connections(uuid,uuid) to service_role;
revoke all on function public.unlink_transfer(uuid) from public, anon, authenticated, service_role;
grant execute on function public.unlink_transfer(uuid) to authenticated, service_role;
revoke all on function public.visible_workspace_ids() from public, anon, authenticated, service_role;
grant execute on function public.visible_workspace_ids() to authenticated, service_role;
revoke all on function public.workspace_role(uuid) from public, anon, authenticated, service_role;
grant execute on function public.workspace_role(uuid) to authenticated, service_role;
revoke all on table public.accounts from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public.accounts to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public.accounts to service_role;
revoke all on table public.calendar_reminders from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public.calendar_reminders to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public.calendar_reminders to service_role;
revoke all on table public.categories from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public.categories to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public.categories to service_role;
revoke all on table public.categorization_rules from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public.categorization_rules to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public.categorization_rules to service_role;
revoke all on table public.coinbase_connections from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public.coinbase_connections to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public.coinbase_connections to service_role;
revoke all on table public.countable_entries from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public.countable_entries to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public.countable_entries to service_role;
revoke all on table public.import_rows from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public.import_rows to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public.import_rows to service_role;
revoke all on table public.imports from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public.imports to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public.imports to service_role;
revoke all on table public.ledger_entries from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public.ledger_entries to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public.ledger_entries to service_role;
revoke all on table public.plaid_items from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public.plaid_items to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public.plaid_items to service_role;
revoke all on table public.pnl_entries from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public.pnl_entries to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public.pnl_entries to service_role;
revoke all on table public.recurring_items from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public.recurring_items to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public.recurring_items to service_role;
revoke all on table public.recurring_occurrences from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public.recurring_occurrences to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public.recurring_occurrences to service_role;
revoke all on table public.tags from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public.tags to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public.tags to service_role;
revoke all on table public.transaction_splits from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public.transaction_splits to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public.transaction_splits to service_role;
revoke all on table public.transaction_tags from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public.transaction_tags to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public.transaction_tags to service_role;
revoke all on table public.transactions from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public.transactions to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public.transactions to service_role;
revoke all on table public.transfer_groups from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public.transfer_groups to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public.transfer_groups to service_role;
revoke all on table public.workspace_invites from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public.workspace_invites to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public.workspace_invites to service_role;
revoke all on table public.workspace_members from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public.workspace_members to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public.workspace_members to service_role;
revoke all on table public.workspaces from anon, authenticated, service_role;
grant delete, insert, references, select, trigger, truncate, update on table public.workspaces to authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public.workspaces to service_role;
