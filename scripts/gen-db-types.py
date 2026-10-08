#!/usr/bin/env python3
"""
Generate src/lib/database.types.ts from a Postgres database that has the migrations applied,
in the same shape `supabase gen types typescript` produces (Tables, Views, Functions).

Usage: DATABASE_URL=postgres://... python3 scripts/gen-db-types.py > src/lib/database.types.ts
   or: PSQL="psql -h /tmp -p 54322 -d ledger" python3 scripts/gen-db-types.py > ...
"""
import json
import os
import shlex
import subprocess

PSQL = shlex.split(os.environ.get("PSQL") or f"psql {os.environ.get('DATABASE_URL', '')}")


def q(sql: str):
    out = subprocess.run(PSQL + ["-At", "-c", f"select coalesce(json_agg(x), '[]') from ({sql}) x"], capture_output=True, text=True, check=True).stdout
    return json.loads(out.strip() or "[]")


SCALAR = {
    "uuid": "string", "text": "string", "character": "string", "character varying": "string", "date": "string",
    "timestamp with time zone": "string", "timestamp without time zone": "string", "time without time zone": "string",
    "numeric": "number", "integer": "number", "bigint": "number", "smallint": "number", "double precision": "number", "real": "number",
    "boolean": "boolean", "jsonb": "Json", "json": "Json", "void": "undefined",
}


def ts(pg: str) -> str:
    if pg.endswith("[]"):
        return f"{ts(pg[:-2])}[]"
    if pg.startswith("_"):
        return f"{ts(pg[1:])}[]"
    pg = {"bpchar": "character", "int4": "integer", "int8": "bigint", "int2": "smallint", "bool": "boolean", "timestamptz": "timestamp with time zone", "varchar": "character varying"}.get(pg, pg)
    return SCALAR.get(pg, "unknown")


columns = q("""
  select c.relname as rel, c.relkind as kind, a.attname as col, format_type(a.atttypid, null) as type,
         not a.attnotnull as nullable, (a.atthasdef or a.attidentity <> '') as has_default, a.attgenerated <> '' as generated
  from pg_attribute a join pg_class c on c.oid = a.attrelid
  where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','v') and a.attnum > 0 and not a.attisdropped
  order by c.relname, a.attname
""")
fks = q("""
  select c.conname as name, c.conrelid::regclass::text as rel, c.confrelid::regclass::text as ref,
         (select array_agg(a.attname order by k.ord) from unnest(c.conkey) with ordinality k(n, ord) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n) as cols,
         (select array_agg(a.attname order by k.ord) from unnest(c.confkey) with ordinality k(n, ord) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.n) as refcols,
         exists (select 1 from pg_constraint u where u.conrelid = c.conrelid and u.contype in ('u','p') and u.conkey::int[] @> c.conkey::int[] and u.conkey::int[] <@ c.conkey::int[]) as one_to_one
  from pg_constraint c
  where c.contype = 'f' and c.connamespace = 'public'::regnamespace and c.confrelid::regclass::text not like 'auth.%'
  order by c.conname
""")
funcs = q("""
  select p.proname as name, p.proretset as setof, format_type(p.prorettype, null) as ret, p.prokind,
         coalesce(p.proargnames, '{}') as argnames, coalesce(p.proallargtypes::regtype[]::text[], p.proargtypes::regtype[]::text[]) as argtypes,
         coalesce(p.proargmodes::text[], '{}') as argmodes, p.pronargs as nargs, p.pronargdefaults as ndefaults,
         (select c.relname from pg_class c where c.reltype = p.prorettype and c.relnamespace = 'public'::regnamespace) as ret_rel
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
    and format_type(p.prorettype, null) <> 'trigger'
    and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute'))
    and p.proname not in ('request_workspace','member_workspace_ids','visible_workspace_ids','editable_workspace_ids','current_workspace_id','workspace_role','rule_matches','recurring_patterns','text_array_max_length')
  order by p.proname
""")

rels: dict[str, dict] = {}
for c in columns:
    rels.setdefault(c["rel"], {"kind": c["kind"], "cols": []})["cols"].append(c)

I = "  "


def row(cols, mode):
    lines = []
    for c in cols:
        t = ts(c["type"])
        if mode == "Row":
            null = c["nullable"] or c["generated"] or rels_kind == "v"
            lines.append(f"{c['col']}: {t}{' | null' if null else ''};")
        else:
            optional = mode == "Update" or c["nullable"] or c["has_default"] or c["generated"]
            null = c["nullable"] or c["generated"]
            lines.append(f"{c['col']}{'?' if optional else ''}: {t}{' | null' if null else ''};")
    return lines


out = [
    "// Generated from the database schema by scripts/gen-db-types.py (same shape as `supabase gen types typescript`).",
    "// Regenerate after changing migrations:",
    '//   PSQL="psql <connection>" python3 scripts/gen-db-types.py > src/lib/database.types.ts',
    "",
    "export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];",
    "",
    "export type Database = {",
    "  // Allows to automatically instantiate createClient with right options",
    "  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)",
    "  __InternalSupabase: {",
    '    PostgrestVersion: "14.5";',
    "  };",
    "  public: {",
]
for section, kind in (("Tables", "r"), ("Views", "v")):
    out.append(f"    {section}: {{")
    for name, rel in sorted(rels.items()):
        if rel["kind"] != kind:
            continue
        rels_kind = kind
        out.append(f"      {name}: {{")
        for mode in (("Row", "Insert", "Update") if kind == "r" else ("Row",)):
            out.append(f"        {mode}: {{")
            out += [f"          {l}" for l in row(rel["cols"], mode)]
            out.append("        };")
        rel_fks = [f for f in fks if f["rel"] == name]
        if rel_fks:
            out.append("        Relationships: [")
            for f in rel_fks:
                out += [
                    "          {",
                    f'            foreignKeyName: "{f["name"]}";',
                    f"            columns: [{', '.join(json.dumps(x) for x in f['cols'])}];",
                    f"            isOneToOne: {'true' if f['one_to_one'] else 'false'};",
                    f'            referencedRelation: "{f["ref"]}";',
                    f"            referencedColumns: [{', '.join(json.dumps(x) for x in f['refcols'])}];",
                    "          },",
                ]
            out.append("        ];")
        else:
            out.append("        Relationships: [];")
        out.append("      };")
    out.append("    };")

out.append("    Functions: {")
for f in funcs:
    names, types, modes = f["argnames"], f["argtypes"], f["argmodes"]
    ins, outs = [], []
    for i, t in enumerate(types):
        m = modes[i] if modes else "i"
        n = names[i] if i < len(names) else f"arg{i}"
        (outs if m in ("o", "t") else ins).append((n, t))
    first_default = len(ins) - f["ndefaults"]
    args = "never" if not ins else "{ " + "; ".join(f"{n}{'?' if i >= first_default else ''}: {ts(t)}" for i, (n, t) in enumerate(ins)) + " }"
    if outs:
        ret = "{ " + "; ".join(f"{n}: {ts(t)}" for n, t in outs) + " }[]"
    elif f["ret_rel"]:
        ret = f'Database["public"]["Tables"]["{f["ret_rel"]}"]["Row"]' + ("[]" if f["setof"] else "")
    else:
        ret = ts(f["ret"]) + ("[]" if f["setof"] else "")
    out.append(f"      {f['name']}: {{ Args: {args}; Returns: {ret} }};")
out += [
    "    };",
    "    Enums: {",
    "      [_ in never]: never;",
    "    };",
    "    CompositeTypes: {",
    "      [_ in never]: never;",
    "    };",
    "  };",
    "};",
    "",
]
print("\n".join(out))
