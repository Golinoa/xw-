-- 运营合同域：五张表 + 五个形状函数 + 引用计数 + 十四个 RPC（契约 §3.3、§5.4）。
--
-- 设计要点：
--
-- 1. 写路径只有 SECURITY DEFINER RPC。五张表对 authenticated 连 SELECT 都不授予：
--    读也走 RPC。理由与 `20261030000007` / `20261030000009` 一致——合同详情要带
--    `items[]`、`receivables[]`、`attachments[]` 这些聚合数组，列级 grant 表达不了；
--    给了一半权限的表会出现两种形状，「字段缺失」比「没有权限」更难排查。
--
-- 2. 业务失败用 `{status:...}` 信封，不 RAISE。理由同上：PostgREST 把任何非 2xx
--    压成状态码，返回值才是可分辨的分支。只有权限不足仍走 `ops.require_permission`
--    抛 42501——那不是业务分支。
--
-- 3. `contract_no` 由 sequence 生成，格式 `HT-` + 6 位零填充，与客户域 `CUS-`
--    同机制。序列允许空洞，并发下不会重号；唯一约束只作为兜底，冲突时返回
--    `contract_no_conflict` 而不是 500。
--
-- 4. **`current_version_no` 默认 0，不是契约原文的 1**。`draft` 阶段还没有任何
--    `contract_versions` 行，默认 1 会让「有 1 个版本」与「没有版本」无法区分；
--    本轮定 0，`activate` 时写第 1 版。联调时需与运营端确认这条（规格 §1 已标）。
--
-- 5. 金额一律由 SQL 重算：`amount = quantity * unit_price`、`total_amount =
--    sum(amount)`，入站 `items[]` 里的 `amount` 即使传了也被忽略。两个 CHECK 约束
--    是真约束（不是注释）：它们是「服务端重算」的最后一道闸，写坏了会当场 23514。
--
-- 6. `ops.contract_versions` 只 INSERT：没有 UPDATE/DELETE 的 RPC，表级写权限
--    一并撤掉。版本快照是「当时签了什么」的证据链，能改就能让历史对不上；变更
--    只能追加一条（activate 与变更单 applied 各写一条）。
--
-- 7. 应收/订阅/租户命令三张表属 T-07/T-09/T-10，本轮不存在。
--    `ops.contract_reference_counts()` 用 `to_regclass` 守卫 + 动态 SQL：直接引用
--    会让函数在创建时就失败，而 `terminate` 的引用守卫必须现在接上。T-07 落地后
--    这里自动生效，不需要改本域代码。
--
-- 8. 状态机严格照契约 §3.3 的七条边（submit / withdraw / sign / activate /
--    terminate / expire，其中 expire 有两条来源）。不合法的边返回
--    `invalid_transition`，不 RAISE；`expired` / `terminated` 是终态。
--
-- 9. 附件不做真实 Storage 校验（U-13，本地没有 Storage）：`complete` 只校验
--    `status = 'pending'` 与 `checksum_sha256` 的 64 位十六进制格式，**不**去
--    Storage 查对象是否存在。生产上线时要在这里补一次 HEAD，这条写进未验证项。
CREATE SEQUENCE ops.contract_no_seq AS bigint start
WITH
  1 increment by 1;


CREATE TABLE ops.contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 默认值就是生成规则：调用方不传编号，序列保证并发不重号。
  contract_no text NOT NULL DEFAULT (
    'HT-' || lpad(nextval('ops.contract_no_seq')::text, 6, '0')
  ),
  customer_id uuid NOT NULL REFERENCES ops.customers (id) ON DELETE RESTRICT,
  sales_owner_operator_id uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  sales_mode text NOT NULL CHECK (sales_mode IN ('saas', 'private')),
  currency char(3) NOT NULL DEFAULT 'CNY',
  total_amount numeric(14, 2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  payment_terms text,
  tax_note text,
  business_note text,
  status text NOT NULL CHECK (
    status IN (
      'draft',
      'reviewing',
      'signed',
      'active',
      'expired',
      'terminated'
    )
  ),
  signed_on date,
  effective_on date,
  expires_on date,
  -- 续约建新合同并指回原合同；原合同不动（规格 §4）。
  renewed_from_contract_id uuid REFERENCES ops.contracts (id) ON DELETE SET NULL,
  status_reason text,
  -- 见文件头第 4 条：默认 0 而不是契约原文的 1。
  current_version_no integer NOT NULL DEFAULT 0 CHECK (current_version_no >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  updated_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  CONSTRAINT contracts_contract_no_key UNIQUE (contract_no),
  CONSTRAINT contracts_dates_check CHECK (
    expires_on IS NULL
    OR effective_on IS NULL
    OR expires_on >= effective_on
  )
);


ALTER SEQUENCE ops.contract_no_seq owned by ops.contracts.contract_no;


CREATE INDEX contracts_customer_status_idx ON ops.contracts (customer_id, status);


CREATE INDEX contracts_status_expires_idx ON ops.contracts (status, expires_on);


CREATE INDEX contracts_sales_owner_idx ON ops.contracts (sales_owner_operator_id);


CREATE TABLE ops.contract_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES ops.contracts (id) ON DELETE CASCADE,
  product_id uuid REFERENCES ops.products (id) ON DELETE RESTRICT,
  package_id uuid REFERENCES ops.packages (id) ON DELETE RESTRICT,
  package_price_version_id uuid REFERENCES ops.package_price_versions (id) ON DELETE RESTRICT,
  sales_mode text NOT NULL CHECK (sales_mode IN ('saas', 'private')),
  billing_type text NOT NULL CHECK (
    billing_type IN ('periodic', 'fixed_term', 'one_time')
  ),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price numeric(14, 2) NOT NULL CHECK (unit_price >= 0),
  amount numeric(14, 2) NOT NULL CHECK (amount >= 0),
  term_months integer,
  -- 软引用：`ops.entitlement_snapshots` 属 T-09，本轮不存在。加 FK 会把 T-09 的
  -- 迁移顺序绑死在本域上，而那是一条没有收益的耦合。
  entitlement_snapshot_id uuid,
  item_name_snapshot text NOT NULL CHECK (length(btrim(item_name_snapshot)) > 0),
  line_no integer NOT NULL CHECK (line_no > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  updated_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  -- 「服务端重算」的最后一道闸：绕过 RPC 直接写也过不了这一关。
  CONSTRAINT contract_items_amount_recalc_check CHECK (amount = quantity * unit_price),
  CONSTRAINT contract_items_contract_line_key UNIQUE (contract_id, line_no)
);


CREATE INDEX contract_items_contract_idx ON ops.contract_items (contract_id);


CREATE INDEX contract_items_package_idx ON ops.contract_items (package_id);


CREATE TABLE ops.contract_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES ops.contracts (id) ON DELETE CASCADE,
  version_no integer NOT NULL CHECK (version_no > 0),
  snapshot jsonb NOT NULL,
  created_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  change_reason text NOT NULL CHECK (length(btrim(change_reason)) > 0),
  CONSTRAINT contract_versions_contract_version_key UNIQUE (contract_id, version_no)
);


CREATE TABLE ops.contract_amendments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES ops.contracts (id) ON DELETE CASCADE,
  amendment_no integer NOT NULL CHECK (amendment_no > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  before_summary jsonb NOT NULL,
  after_summary jsonb NOT NULL,
  status text NOT NULL CHECK (
    status IN (
      'draft',
      'pending_approval',
      'approved',
      'rejected',
      'applied'
    )
  ),
  requested_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  approved_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  approved_at timestamptz,
  applied_version_no integer,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  updated_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  CONSTRAINT contract_amendments_contract_no_key UNIQUE (contract_id, amendment_no),
  -- 职责分离：批准人不能是申请人。NULL 通过（尚未批准）。
  CONSTRAINT contract_amendments_segregation_check CHECK (
    approved_by IS NULL
    OR approved_by <> requested_by
  )
);


CREATE INDEX contract_amendments_contract_idx ON ops.contract_amendments (contract_id, status);


CREATE TABLE ops.contract_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES ops.contracts (id) ON DELETE CASCADE,
  file_name text NOT NULL CHECK (length(btrim(file_name)) > 0),
  content_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (
    byte_size > 0
    AND byte_size <= 26214400
  ),
  -- `contracts/{contractId}/{attachmentId}/{fileName}`，由 RPC 拼好写入。
  storage_path text NOT NULL,
  checksum_sha256 text,
  -- 契约 §3.3 没有这一列（规格 §1 标推断）：`POST attachments` 返回 pending、
  -- `complete` 返回 stored，没有状态列就无法表达这两步。
  status text NOT NULL CHECK (status IN ('pending', 'stored')),
  uploaded_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  access_scope text NOT NULL DEFAULT 'contract.read',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT contract_attachments_storage_path_key UNIQUE (storage_path)
);


CREATE INDEX contract_attachments_contract_idx ON ops.contract_attachments (contract_id);


-- ── 引用计数（前向兼容） ────────────────────────────────────────────────────
-- 三张域表本轮都不存在。`to_regclass` 是**运行期**判定，配合动态 SQL 才能让
-- 「表还不存在」变成返回 0 而不是创建函数时失败。
--
-- 落地时怎么补：把 `if to_regclass(...) is not null then` 分支里的表名换成真实
-- 表名即可，语义不变。列名按 `contract_id` 约定取数——T-07/T-09/T-10 建表时
-- 必须有这一列，否则本函数会在这里报错（那正是该报的位置）。
--
-- 键名固定为 `receivables` / `entitlements` / `tenant_commands`（snake_case，
-- 与其它形状函数同口径；出站由 protocol.ts 转 camelCase）：前者是应收，
-- 中间是订阅权益，后者是租户命令。`terminate` 只要任一 > 0 就拒绝。
CREATE OR REPLACE FUNCTION ops.contract_reference_counts (p_contract_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  receivable_count integer := 0;
  entitlement_count integer := 0;
  tenant_command_count integer := 0;
begin
  if p_contract_id is null then
    return jsonb_build_object(
      'receivables', 0,
      'entitlements', 0,
      'tenant_commands', 0
    );
  end if;

  if to_regclass('ops.receivables') is not null then
    execute 'select count(*) from ops.receivables where contract_id = $1'
      into receivable_count
      using p_contract_id;
  end if;

  if to_regclass('ops.subscriptions') is not null then
    execute 'select count(*) from ops.subscriptions where contract_id = $1'
      into entitlement_count
      using p_contract_id;
  end if;

  if to_regclass('ops.tenant_commands') is not null then
    execute 'select count(*) from ops.tenant_commands where contract_id = $1'
      into tenant_command_count
      using p_contract_id;
  end if;

  return jsonb_build_object(
    'receivables', receivable_count,
    'entitlements', entitlement_count,
    'tenant_commands', tenant_command_count
  );
end;
$$;


-- ── 形状函数 ────────────────────────────────────────────────────────────────
-- 与 `ops.customer_json` / `ops.package_json` 同一口径：返回数据库列名
-- （snake_case），出站映射负责拒绝字段漂移。这五个函数**没有**权限判定，必须对
-- 所有非属主角色关闭执行权，否则任意登录用户都能按 id 读到合同、附件路径与价格。
--
-- 金额保持 JSON number（`numeric(14,2)` 直接进 `jsonb_build_object`），出站由
-- API 层用 `z.number()` 接；不要转成字符串，否则同一个字段在客户域与合同域会有
-- 两种类型。
CREATE OR REPLACE FUNCTION ops.contract_json (p_contract_id uuid) returns jsonb language sql stable security definer
SET
  search_path = '' AS $$
  select jsonb_build_object(
    'id', contract.id,
    'contract_no', contract.contract_no,
    'customer_id', contract.customer_id,
    'customer', jsonb_build_object(
      'id', customer.id,
      'customer_no', customer.customer_no,
      'name', customer.name,
      'status', customer.status
    ),
    'sales_owner_operator_id', contract.sales_owner_operator_id,
    'sales_owner', case
      when owner.id is null then null
      else jsonb_build_object(
        'id', owner.id,
        'display_name', owner.display_name,
        'email', owner.email
      )
    end,
    'sales_mode', contract.sales_mode,
    'currency', contract.currency,
    'total_amount', contract.total_amount,
    'payment_terms', contract.payment_terms,
    'tax_note', contract.tax_note,
    'business_note', contract.business_note,
    'status', contract.status,
    'signed_on', contract.signed_on,
    'effective_on', contract.effective_on,
    'expires_on', contract.expires_on,
    'renewed_from_contract_id', contract.renewed_from_contract_id,
    'status_reason', contract.status_reason,
    'current_version_no', contract.current_version_no,
    'version', contract.version,
    'created_at', contract.created_at,
    'updated_at', contract.updated_at
  )
  from ops.contracts as contract
  join ops.customers as customer on customer.id = contract.customer_id
  left join ops.operators as owner on owner.id = contract.sales_owner_operator_id
  where contract.id = p_contract_id;
$$;


CREATE OR REPLACE FUNCTION ops.contract_item_json (p_item_id uuid) returns jsonb language sql stable security definer
SET
  search_path = '' AS $$
  select jsonb_build_object(
    'id', item.id,
    'contract_id', item.contract_id,
    'product_id', item.product_id,
    'package_id', item.package_id,
    'package_price_version_id', item.package_price_version_id,
    'sales_mode', item.sales_mode,
    'billing_type', item.billing_type,
    'quantity', item.quantity,
    'unit_price', item.unit_price,
    'amount', item.amount,
    'term_months', item.term_months,
    'entitlement_snapshot_id', item.entitlement_snapshot_id,
    'item_name_snapshot', item.item_name_snapshot,
    'line_no', item.line_no,
    'version', item.version
  )
  from ops.contract_items as item
  where item.id = p_item_id;
$$;


CREATE OR REPLACE FUNCTION ops.contract_version_json (p_version_id uuid) returns jsonb language sql stable security definer
SET
  search_path = '' AS $$
  select jsonb_build_object(
    'id', version.id,
    'contract_id', version.contract_id,
    'version_no', version.version_no,
    'snapshot', version.snapshot,
    'created_by', version.created_by,
    'created_at', version.created_at,
    'change_reason', version.change_reason
  )
  from ops.contract_versions as version
  where version.id = p_version_id;
$$;


CREATE OR REPLACE FUNCTION ops.amendment_json (p_amendment_id uuid) returns jsonb language sql stable security definer
SET
  search_path = '' AS $$
  select jsonb_build_object(
    'id', amendment.id,
    'contract_id', amendment.contract_id,
    'amendment_no', amendment.amendment_no,
    'reason', amendment.reason,
    'before_summary', amendment.before_summary,
    'after_summary', amendment.after_summary,
    'status', amendment.status,
    'requested_by', amendment.requested_by,
    'approved_by', amendment.approved_by,
    'approved_at', amendment.approved_at,
    'applied_version_no', amendment.applied_version_no,
    'version', amendment.version,
    'created_at', amendment.created_at,
    'updated_at', amendment.updated_at
  )
  from ops.contract_amendments as amendment
  where amendment.id = p_amendment_id;
$$;


CREATE OR REPLACE FUNCTION ops.attachment_json (p_attachment_id uuid) returns jsonb language sql stable security definer
SET
  search_path = '' AS $$
  select jsonb_build_object(
    'id', attachment.id,
    'contract_id', attachment.contract_id,
    'file_name', attachment.file_name,
    'content_type', attachment.content_type,
    'byte_size', attachment.byte_size,
    'storage_path', attachment.storage_path,
    'checksum_sha256', attachment.checksum_sha256,
    'status', attachment.status,
    'uploaded_by', attachment.uploaded_by,
    'uploaded_at', attachment.uploaded_at,
    'access_scope', attachment.access_scope,
    'version', attachment.version
  )
  from ops.contract_attachments as attachment
  where attachment.id = p_attachment_id;
$$;


-- ── 条目：归一化与落库 ──────────────────────────────────────────────────────
-- 分两步是刻意的：先把整批条目**校验并归一化**成纯数据，再统一落库。一步写一边
-- 校验的写法在「第 3 条价格不匹配」时会留下一个已插入合同、只有 2 条条目的半成品
-- ——函数 return 不会回滚事务。
--
-- 归一化的产物是列名 key 的 jsonb，`ops.contract_items_store` 只负责插入与汇总，
-- 不再做任何判定。create / update / renew 三条路径共用这一对，金额口径只有一处。
CREATE OR REPLACE FUNCTION ops.contract_items_normalize (p_sales_mode text, p_items jsonb) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  items jsonb := coalesce(p_items, '[]'::jsonb);
  normalized jsonb := '[]'::jsonb;
  element jsonb;
  normalized_item jsonb;
  line_no integer := 0;
  total numeric(14, 2) := 0;
  quantity integer;
  requested_price numeric(14, 2);
  effective_price numeric(14, 2);
  version_price numeric(14, 2);
  version_id uuid;
  product_id uuid;
  package_id uuid;
  product_row ops.products;
  package_row ops.packages;
  item_name text;
  billing_type text;
begin
  if jsonb_typeof(items) <> 'array' then
    return jsonb_build_object('status', 'items_required', 'field', 'items');
  end if;

  for element in
    select value
    from jsonb_array_elements(items)
  loop
    if jsonb_typeof(element) <> 'object' then
      return jsonb_build_object('status', 'items_required', 'field', 'items');
    end if;

    quantity := coalesce((element ->> 'quantity')::integer, 1);
    if quantity <= 0 then
      return jsonb_build_object('status', 'items_required', 'field', 'items');
    end if;

    product_id := nullif(btrim(coalesce(element ->> 'productId', '')), '')::uuid;
    package_id := nullif(btrim(coalesce(element ->> 'packageId', '')), '')::uuid;
    version_id := nullif(btrim(coalesce(element ->> 'priceVersionId', '')), '')::uuid;
    requested_price := nullif(btrim(coalesce(element ->> 'unitPrice', '')), '')::numeric;

    -- 价格版本优先：两者都给且不一致是调用方的错，不是「以服务端为准」。
    effective_price := requested_price;

    if version_id is not null then
      select version.price
      into version_price
      from ops.package_price_versions as version
      where version.id = version_id;

      if not found then
        return jsonb_build_object('status', 'price_mismatch', 'field', 'priceVersionId');
      end if;

      if requested_price is not null and requested_price <> version_price then
        return jsonb_build_object('status', 'price_mismatch', 'field', 'unitPrice');
      end if;

      effective_price := coalesce(requested_price, version_price);
    end if;

    effective_price := coalesce(effective_price, 0);

    if effective_price < 0 then
      return jsonb_build_object('status', 'price_mismatch', 'field', 'unitPrice');
    end if;

    item_name := null;
    billing_type := nullif(btrim(coalesce(element ->> 'billingType', '')), '');

    if package_id is not null then
      select *
      into package_row
      from ops.packages as package
      where package.id = package_id;

      if not found then
        return jsonb_build_object(
          'status', 'items_required',
          'field', 'items',
          'reason', 'PACKAGE_NOT_FOUND'
        );
      end if;

      -- 建行时定格：套餐之后改名不影响已签合同（规格 §4）。
      item_name := coalesce(
        nullif(btrim(coalesce(package_row.customer_name, '')), ''),
        nullif(btrim(coalesce(package_row.internal_name, '')), '')
      );
      billing_type := coalesce(billing_type, package_row.billing_type);

      if package_row.product_id is not null then
        select *
        into product_row
        from ops.products as product
        where product.id = package_row.product_id;

        item_name := coalesce(item_name, product_row.name);
      end if;
    elsif product_id is not null then
      select *
      into product_row
      from ops.products as product
      where product.id = product_id;

      if not found then
        return jsonb_build_object(
          'status', 'items_required',
          'field', 'items',
          'reason', 'PRODUCT_NOT_FOUND'
        );
      end if;

      item_name := product_row.name;
    end if;

    line_no := line_no + 1;
    total := total + quantity * effective_price;

    normalized_item := jsonb_build_object(
      'product_id', product_id,
      'package_id', package_id,
      'package_price_version_id', version_id,
      'sales_mode', p_sales_mode,
      'billing_type', coalesce(billing_type, 'periodic'),
      'quantity', quantity,
      'unit_price', effective_price,
      'amount', quantity * effective_price,
      'term_months', nullif(btrim(coalesce(element ->> 'termMonths', '')), '')::integer,
      'item_name_snapshot', coalesce(item_name, '未命名条目'),
      'line_no', line_no
    );

    normalized := normalized || jsonb_build_array(normalized_item);
  end loop;

  return jsonb_build_object('status', 'ok', 'items', normalized, 'total', total);
end;
$$;


-- 整体替换条目：先删后插，金额在 SQL 里乘出来，不信归一化时算的 amount。
-- 返回新的 total_amount；调用方负责把它写回 `ops.contracts`。
CREATE OR REPLACE FUNCTION ops.contract_items_store (p_contract_id uuid, p_normalized jsonb) returns numeric language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  new_total numeric(14, 2);
begin
  delete from ops.contract_items as item where item.contract_id = p_contract_id;

  insert into ops.contract_items (
    contract_id, product_id, package_id, package_price_version_id, sales_mode,
    billing_type, quantity, unit_price, amount, term_months, item_name_snapshot,
    line_no, created_by, updated_by
  )
  select
    p_contract_id,
    (entry ->> 'product_id')::uuid,
    (entry ->> 'package_id')::uuid,
    (entry ->> 'package_price_version_id')::uuid,
    entry ->> 'sales_mode',
    entry ->> 'billing_type',
    (entry ->> 'quantity')::integer,
    (entry ->> 'unit_price')::numeric,
    (entry ->> 'quantity')::integer * (entry ->> 'unit_price')::numeric,
    (entry ->> 'term_months')::integer,
    entry ->> 'item_name_snapshot',
    (entry ->> 'line_no')::integer,
    actor_id,
    actor_id
  from jsonb_array_elements(coalesce(p_normalized, '[]'::jsonb)) as entry (entry);

  select coalesce(sum(item.amount), 0)
  into new_total
  from ops.contract_items as item
  where item.contract_id = p_contract_id;

  return new_total;
end;
$$;


-- 快照的唯一口径：activate 与变更单 applied 都写这一形状（规格 §4）。
-- `entitlementLines` 在 `ops.entitlement_snapshots` 不存在时是**空数组**而不是
-- null——null 与「没有权益」不可区分，空数组才是「此刻没有」。
CREATE OR REPLACE FUNCTION ops.contract_snapshot_json (p_contract_id uuid) returns jsonb language sql stable security definer
SET
  search_path = '' AS $$
  select jsonb_build_object(
    'contract', ops.contract_json(p_contract_id),
    'items', coalesce(
      (
        select jsonb_agg(
          ops.contract_item_json(item.id)
          order by item.line_no
        )
        from ops.contract_items as item
        where item.contract_id = p_contract_id
      ),
      '[]'::jsonb
    ),
    'entitlementLines', '[]'::jsonb
  );
$$;


-- ── GET /contracts ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.list_contracts (
  p_keyword text DEFAULT NULL,
  p_customer_id uuid DEFAULT NULL,
  p_statuses TEXT[] DEFAULT NULL,
  p_owner uuid DEFAULT NULL,
  p_expires_from date DEFAULT NULL,
  p_expires_to date DEFAULT NULL,
  p_sales_mode text DEFAULT NULL,
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 20
) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  page_size integer := least(greatest(coalesce(p_page_size, 20), 1), 100);
  page_offset integer := (greatest(coalesce(p_page, 1), 1) - 1) * page_size;
begin
  perform ops.require_permission('contract.read');

  return (
    with filtered as (
      select contract.*
      from ops.contracts as contract
      join ops.customers as customer on customer.id = contract.customer_id
      where (p_customer_id is null or contract.customer_id = p_customer_id)
        and (p_statuses is null or contract.status = any (p_statuses))
        and (p_owner is null or contract.sales_owner_operator_id = p_owner)
        and (p_sales_mode is null or contract.sales_mode = p_sales_mode)
        and (p_expires_from is null or contract.expires_on >= p_expires_from)
        and (p_expires_to is null or contract.expires_on <= p_expires_to)
        and (
          p_keyword is null
          or btrim(p_keyword) = ''
          or contract.contract_no ilike '%' || btrim(p_keyword) || '%'
          or customer.name ilike '%' || btrim(p_keyword) || '%'
        )
    ), ordered as (
      select
        filtered.id,
        -- 兜底必须唯一，否则翻页会漏行或重行。
        row_number() over (
          order by filtered.created_at desc, filtered.id
        ) as position
      from filtered
    ), page as (
      select ordered.id, ordered.position
      from ordered
      order by ordered.position
      limit page_size
      offset page_offset
      )
    select jsonb_build_object(
      'status', 'ok',
      'items', coalesce(
        (
          select jsonb_agg(ops.contract_json(page.id) order by page.position)
          from page
        ),
        '[]'::jsonb
      ),
      'total', (select count(*) from filtered)
    )
  );
end;
$$;


-- ── POST /contracts ─────────────────────────────────────────────────────────
-- 入站不收 amount：`items[]` 只收 productId/packageId/priceVersionId/quantity/
-- unitPrice/termMonths，金额由 `ops.contract_items_store` 重算（规格 §4）。
CREATE OR REPLACE FUNCTION ops.create_contract (
  p_customer_id uuid,
  p_sales_mode text,
  p_currency text DEFAULT 'CNY',
  p_payment_terms text DEFAULT NULL,
  p_tax_note text DEFAULT NULL,
  p_business_note text DEFAULT NULL,
  p_items jsonb DEFAULT '[]'::jsonb
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  normalized jsonb;
  new_id uuid;
  new_no text;
  new_total numeric(14, 2);
begin
  perform ops.require_permission('contract.write');

  -- 枚举外的值落到 CHECK 会变成 500。这里归到 `sales_mode_disabled`：HTTP 上仍是
  -- 400，且 details 带 salesMode，与「这个销售方式当前不可售」同一条读法。
  if p_sales_mode is null or p_sales_mode not in ('saas', 'private') then
    return jsonb_build_object(
      'status', 'sales_mode_disabled',
      'sales_mode', p_sales_mode
    );
  end if;

  if not exists (
    select 1 from ops.customers as customer where customer.id = p_customer_id
  ) then
    return jsonb_build_object('status', 'customer_not_found');
  end if;

  -- 先校验后写入：不匹配的条目不能留下一个已建好的空合同。
  normalized := ops.contract_items_normalize(p_sales_mode, p_items);

  if (normalized ->> 'status') <> 'ok' then
    return normalized;
  end if;

  -- 契约 §5.4 的 400「销售方式未开放」：建单时就要判，不能等到 `sign`。
  -- 等到签署才拒，等于让人先建好一张卖不出去的草稿——PATCH 又改不了 `sales_mode`
  -- （换销售方式等于换一份合同），这张草稿只能被 `terminate` 掉，留下一条无意义的
  -- 合同记录与审计。空条目在这里放行：`items_required` 是 `submit` 的守卫，
  -- 允许先建一张空草稿再补条目。
  -- 判据与 `sign` 一致（「至少一个被引用的产品为该销售方式开了 is_enabled」）：
  -- 条目可能只写 `packageId`，此时产品要从套餐反查，否则漏判。
  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) > 0
    and not exists (
      select 1
      from jsonb_array_elements(p_items) as entry
      cross join lateral (
        select nullif(btrim(coalesce(entry ->> 'productId', '')), '')::uuid as product_id
        union all
        select package.product_id
        from ops.packages as package
        where package.id = nullif(btrim(coalesce(entry ->> 'packageId', '')), '')::uuid
      ) as referenced
      where referenced.product_id is not null
        and exists (
          select 1
          from ops.product_sales_modes as mode
          where mode.product_id = referenced.product_id
            and mode.sales_mode = p_sales_mode
            and mode.is_enabled
        )
    )
  then
    return jsonb_build_object(
      'status', 'sales_mode_disabled',
      'sales_mode', p_sales_mode
    );
  end if;

  begin
    insert into ops.contracts (
      customer_id, sales_mode, currency, payment_terms, tax_note, business_note,
      status, current_version_no, created_by, updated_by
    )
    values (
      p_customer_id,
      p_sales_mode,
      upper(coalesce(nullif(btrim(coalesce(p_currency, '')), ''), 'CNY')),
      nullif(btrim(coalesce(p_payment_terms, '')), ''),
      nullif(btrim(coalesce(p_tax_note, '')), ''),
      nullif(btrim(coalesce(p_business_note, '')), ''),
      'draft',
      0,
      actor_id,
      actor_id
    )
    returning id, contract_no into new_id, new_no;
  exception
    when unique_violation then
      -- 序列生成不可能重号，能走到这里说明有人手工插了编号或序列被重置过。
      return jsonb_build_object('status', 'contract_no_conflict');
  end;

  new_total := ops.contract_items_store(new_id, normalized -> 'items');

  update ops.contracts as contract
  set total_amount = new_total
  where contract.id = new_id;

  perform ops.write_audit(
    'contract.created',
    'contract',
    new_id,
    null,
    null,
    jsonb_build_object(
      'contractNo', new_no,
      'customerId', p_customer_id,
      'salesMode', p_sales_mode,
      'totalAmount', new_total,
      'itemCount', jsonb_array_length(normalized -> 'items')
    ),
    null
  );

  return jsonb_build_object(
    'status', 'ok',
    'contract', ops.contract_json(new_id),
    'items', coalesce(
      (
        select jsonb_agg(ops.contract_item_json(item.id) order by item.line_no)
        from ops.contract_items as item
        where item.contract_id = new_id
      ),
      '[]'::jsonb
    )
  );
end;
$$;


-- ── GET /contracts/{contractId} ─────────────────────────────────────────────
-- `receivables[]` / `subscriptions[]` / `licenses[]` 指向未落地的表：表不存在时
-- 返回**空数组**而不是 null（前端按 `.length` 渲染，缺键在运行期抛 TypeError）。
-- 表落地后这里靠 `to_regclass` 自动开始返回原始行，不需要改本域代码。
CREATE OR REPLACE FUNCTION ops.get_contract (p_contract_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  items jsonb;
  attachments jsonb;
  receivables jsonb := '[]'::jsonb;
  subscriptions jsonb := '[]'::jsonb;
  licenses jsonb := '[]'::jsonb;
begin
  perform ops.require_permission('contract.read');

  if not exists (
    select 1 from ops.contracts as contract where contract.id = p_contract_id
  ) then
    return jsonb_build_object('status', 'contract_not_found');
  end if;

  select coalesce(
    jsonb_agg(ops.contract_item_json(item.id) order by item.line_no),
    '[]'::jsonb
  )
  into items
  from ops.contract_items as item
  where item.contract_id = p_contract_id;

  select coalesce(
    jsonb_agg(
      ops.attachment_json(attachment.id)
      order by attachment.uploaded_at, attachment.id
    ),
    '[]'::jsonb
  )
  into attachments
  from ops.contract_attachments as attachment
  where attachment.contract_id = p_contract_id;

  if to_regclass('ops.receivables') is not null then
    execute $sql$
      select coalesce(jsonb_agg(to_jsonb(entry)), '[]'::jsonb)
      from ops.receivables as entry
      where entry.contract_id = $1
    $sql$ into receivables using p_contract_id;
  end if;

  if to_regclass('ops.subscriptions') is not null then
    execute $sql$
      select coalesce(jsonb_agg(to_jsonb(entry)), '[]'::jsonb)
      from ops.subscriptions as entry
      where entry.contract_id = $1
    $sql$ into subscriptions using p_contract_id;
  end if;

  if to_regclass('ops.licenses') is not null then
    execute $sql$
      select coalesce(jsonb_agg(to_jsonb(entry)), '[]'::jsonb)
      from ops.licenses as entry
      where entry.contract_id = $1
    $sql$ into licenses using p_contract_id;
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'contract', ops.contract_json(p_contract_id),
    'items', items,
    'receivables', receivables,
    'subscriptions', subscriptions,
    'licenses', licenses,
    'attachments', attachments
  );
end;
$$;


-- ── PATCH /contracts/{contractId} ───────────────────────────────────────────
-- 只允许 `draft` / `reviewing`：已签署的合同内容冻结，改动只能走变更单。
-- `status` 不在参数表里——状态只能经 `ops.transition_contract`，PATCH 能改状态
-- 等于给状态机开后门。
--
-- 规格 §2/§7 写的信封是 `{status:'contract_immutable', status:<当前>}`，但同一个
-- JSON 对象里 `status` 只能有一个值。这里拆成 `current_status`，理由写进报告，
-- 口径没有改：仍是 409 + details.reason = CONTRACT_IMMUTABLE。
CREATE OR REPLACE FUNCTION ops.update_contract (
  p_contract_id uuid,
  p_expected_version integer,
  p_payment_terms text DEFAULT NULL,
  p_tax_note text DEFAULT NULL,
  p_business_note text DEFAULT NULL,
  p_expires_on date DEFAULT NULL,
  p_items jsonb DEFAULT NULL,
  p_items_provided boolean DEFAULT FALSE
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  target ops.contracts;
  normalized jsonb;
  new_total numeric(14, 2);
  effective_payment_terms text;
  effective_tax_note text;
  effective_business_note text;
  effective_expires_on date;
  changes jsonb := '{}'::jsonb;
  before_summary jsonb := '{}'::jsonb;
begin
  perform ops.require_permission('contract.write');

  -- FOR UPDATE：版本比较必须在锁内做，否则两个并发 PATCH 都读到 version=3。
  select * into target
  from ops.contracts as contract
  where contract.id = p_contract_id
  for update;

  if not found then
    return jsonb_build_object('status', 'contract_not_found');
  end if;

  if p_expected_version is null or target.version <> p_expected_version then
    return jsonb_build_object(
      'status', 'version_mismatch',
      'current_version', target.version
    );
  end if;

  if target.status not in ('draft', 'reviewing') then
    return jsonb_build_object(
      'status', 'contract_immutable',
      'current_status', target.status
    );
  end if;

  effective_payment_terms := case
    when p_payment_terms is null then target.payment_terms
    else nullif(btrim(p_payment_terms), '')
  end;

  effective_tax_note := case
    when p_tax_note is null then target.tax_note
    else nullif(btrim(p_tax_note), '')
  end;

  effective_business_note := case
    when p_business_note is null then target.business_note
    else nullif(btrim(p_business_note), '')
  end;

  effective_expires_on := coalesce(p_expires_on, target.expires_on);

  if p_items_provided then
    normalized := ops.contract_items_normalize(target.sales_mode, p_items);

    if (normalized ->> 'status') <> 'ok' then
      return normalized;
    end if;

    select coalesce(sum((entry ->> 'amount')::numeric), 0)
    into new_total
    from jsonb_array_elements(normalized -> 'items') as entry (entry);
  end if;

  if effective_payment_terms is distinct from target.payment_terms then
    changes := changes || jsonb_build_object('payment_terms', effective_payment_terms);
    before_summary := before_summary
      || jsonb_build_object('payment_terms', target.payment_terms);
  end if;

  if effective_tax_note is distinct from target.tax_note then
    changes := changes || jsonb_build_object('tax_note', effective_tax_note);
    before_summary := before_summary || jsonb_build_object('tax_note', target.tax_note);
  end if;

  if effective_business_note is distinct from target.business_note then
    changes := changes || jsonb_build_object('business_note', effective_business_note);
    before_summary := before_summary
      || jsonb_build_object('business_note', target.business_note);
  end if;

  if effective_expires_on is distinct from target.expires_on then
    changes := changes || jsonb_build_object('expires_on', effective_expires_on);
    before_summary := before_summary || jsonb_build_object('expires_on', target.expires_on);
  end if;

  -- `itemsProvided=true` 是「整体替换」的声明：即使内容与现状相同也算一次变更，
  -- 因为调用方断言了这一批条目就是全部。`false` 表示不碰条目。
  if p_items_provided then
    changes := changes || jsonb_build_object('items', normalized -> 'items');
    before_summary := before_summary || jsonb_build_object(
      'items',
      coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'product_id', item.product_id,
              'package_id', item.package_id,
              'package_price_version_id', item.package_price_version_id,
              'quantity', item.quantity,
              'unit_price', item.unit_price,
              'term_months', item.term_months,
              'item_name_snapshot', item.item_name_snapshot,
              'line_no', item.line_no
            )
            order by item.line_no
          )
          from ops.contract_items as item
          where item.contract_id = p_contract_id
        ),
        '[]'::jsonb
      )
    );
  end if;

  -- 没有字段变化就不写：空更新会把 version 推高，让调用方的乐观锁白失败一次。
  if changes = '{}'::jsonb then
    return jsonb_build_object(
      'status', 'ok',
      'contract', ops.contract_json(p_contract_id),
      'items', coalesce(
        (
          select jsonb_agg(ops.contract_item_json(item.id) order by item.line_no)
          from ops.contract_items as item
          where item.contract_id = p_contract_id
        ),
        '[]'::jsonb
      )
    );
  end if;

  update ops.contracts as contract
  set
    payment_terms = effective_payment_terms,
    tax_note = effective_tax_note,
    business_note = effective_business_note,
    expires_on = effective_expires_on,
    total_amount = case when p_items_provided then new_total else contract.total_amount end,
    version = contract.version + 1,
    updated_at = now(),
    updated_by = actor_id
  where contract.id = p_contract_id;

  if p_items_provided then
    perform ops.contract_items_store(p_contract_id, normalized -> 'items');
  end if;

  perform ops.write_audit(
    'contract.updated',
    'contract',
    p_contract_id,
    null,
    before_summary,
    changes,
    null
  );

  return jsonb_build_object(
    'status', 'ok',
    'contract', ops.contract_json(p_contract_id),
    'items', coalesce(
      (
        select jsonb_agg(ops.contract_item_json(item.id) order by item.line_no)
        from ops.contract_items as item
        where item.contract_id = p_contract_id
      ),
      '[]'::jsonb
    )
  );
end;
$$;


-- ── POST /contracts/{contractId}/transition ─────────────────────────────────
-- 七条边逐条判定，不用「先算目标状态再统一校验」：`submit` 的三条守卫、
-- `sign` 的销售方式查表、`activate` 的写版本、`terminate` 的引用守卫都只属于
-- 某一条边，混在通用分支里会让不相干的动作也开始检查它们。
--
-- 权限码按动作分两类：submit / withdraw 是 `contract.write`，其余四个是
-- `contract.approve`。未知动作落到 approve（最严的那一档），先过权限再返回
-- `invalid_transition`——不拿「动作名对不对」换取存在性探测。
CREATE OR REPLACE FUNCTION ops.transition_contract (
  p_contract_id uuid,
  p_action text,
  p_reason text DEFAULT NULL,
  p_signed_on date DEFAULT NULL,
  p_effective_on date DEFAULT NULL,
  p_confirm_impact boolean DEFAULT FALSE,
  p_expected_version integer DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  target ops.contracts;
  required_permission text;
  from_status text;
  to_status text;
  item_count integer;
  item_total numeric(14, 2);
  customer_status text;
  impact jsonb;
  effective_signed_on date;
  effective_effective_on date;
  effective_reason text;
  next_version_no integer;
  snapshot jsonb;
  new_version_id uuid;
begin
  required_permission := case
    when p_action in ('submit', 'withdraw') then 'contract.write'
    else 'contract.approve'
  end;

  perform ops.require_permission(required_permission);

  select * into target
  from ops.contracts as contract
  where contract.id = p_contract_id
  for update;

  if not found then
    return jsonb_build_object('status', 'contract_not_found');
  end if;

  if p_expected_version is null or target.version <> p_expected_version then
    return jsonb_build_object(
      'status', 'version_mismatch',
      'current_version', target.version
    );
  end if;

  from_status := target.status;
  effective_reason := nullif(btrim(coalesce(p_reason, '')), '');
  effective_signed_on := target.signed_on;
  effective_effective_on := target.effective_on;
  next_version_no := target.current_version_no;

  to_status := case
    when p_action = 'submit' and from_status = 'draft' then 'reviewing'
    when p_action = 'withdraw' and from_status = 'reviewing' then 'draft'
    when p_action = 'sign' and from_status = 'reviewing' then 'signed'
    when p_action = 'activate' and from_status = 'signed' then 'active'
    when p_action = 'terminate' and from_status = 'active' then 'terminated'
    when p_action = 'expire' and from_status in ('signed', 'active') then 'expired'
  end;

  -- 终态（expired / terminated）与所有不存在的边都落在这里，不 RAISE。
  if to_status is null then
    return jsonb_build_object(
      'status', 'invalid_transition',
      'current', from_status,
      'action', p_action
    );
  end if;

  -- submit：至少一条条目、合计一致、客户状态可签约。
  if p_action = 'submit' then
    select count(*), coalesce(sum(item.amount), 0)
    into item_count, item_total
    from ops.contract_items as item
    where item.contract_id = p_contract_id;

    if item_count = 0 then
      return jsonb_build_object('status', 'items_required', 'field', 'items');
    end if;

    if target.total_amount <> item_total then
      return jsonb_build_object(
        'status', 'total_mismatch',
        'total_amount', target.total_amount,
        'items_total', item_total
      );
    end if;

    select customer.status
    into customer_status
    from ops.customers as customer
    where customer.id = target.customer_id;

    if customer_status is null then
      return jsonb_build_object('status', 'customer_not_found');
    end if;

    if customer_status not in ('signed', 'onboarding', 'active') then
      return jsonb_build_object(
        'status', 'customer_not_eligible',
        'customer_status', customer_status
      );
    end if;
  end if;

  -- sign：销售方式必须在 `product_sales_modes.is_enabled` 里（真查表，不跳过）。
  -- 判定口径是「合同引用到的产品里，至少有一个为该销售方式开了口」：合同条目
  -- 可能只写了套餐（`package_id`），产品要从套餐反查。
  if p_action = 'sign' then
    -- 规格 §2 要求「需 signed_on」。API 层 zod 已先拦一次；这里 NULL 视为
    -- 「签署即当下」，不让一个词表外的 status 出现在回包里。
    effective_signed_on := coalesce(p_signed_on, target.signed_on, current_date);

    if not exists (
      select 1
      from (
        select item.product_id
        from ops.contract_items as item
        where item.contract_id = p_contract_id
          and item.product_id is not null
        union
        select package.product_id
        from ops.contract_items as item
        join ops.packages as package on package.id = item.package_id
        where item.contract_id = p_contract_id
      ) as referenced
      where exists (
        select 1
        from ops.product_sales_modes as mode
        where mode.product_id = referenced.product_id
          and mode.sales_mode = target.sales_mode
          and mode.is_enabled
      )
    ) then
      return jsonb_build_object(
        'status', 'sales_mode_disabled',
        'sales_mode', target.sales_mode
      );
    end if;
  end if;

  -- activate：写第 1 版快照，并把 current_version_no 从 0 提到 1。
  if p_action = 'activate' then
    effective_effective_on := coalesce(p_effective_on, target.effective_on, current_date);

    select coalesce(max(version.version_no), 0) + 1
    into next_version_no
    from ops.contract_versions as version
    where version.contract_id = p_contract_id;

    if next_version_no <= target.current_version_no then
      next_version_no := target.current_version_no + 1;
    end if;
  end if;

  -- terminate：reason 与 confirmImpact 都是入站必填（API 层已校验），缺了归到
  -- `invalid_transition` 并带上 `missing`，不发明词表外的 status。
  if p_action = 'terminate' then
    if effective_reason is null then
      return jsonb_build_object(
        'status', 'invalid_transition',
        'current', from_status,
        'action', p_action,
        'missing', 'reason'
      );
    end if;

    if p_confirm_impact is not true then
      return jsonb_build_object(
        'status', 'invalid_transition',
        'current', from_status,
        'action', p_action,
        'missing', 'confirmImpact'
      );
    end if;
  end if;

  -- 引用守卫：三个计数全为 0 才放行。计数口径在 `contract_reference_counts`，
  -- 未落地的三张表由 to_regclass 跳过；表落地后这里自动生效。
  impact := ops.contract_reference_counts(p_contract_id);

  if p_action = 'terminate' and (
    (impact ->> 'receivables')::integer > 0
    or (impact ->> 'entitlements')::integer > 0
    or (impact ->> 'tenant_commands')::integer > 0
  ) then
    return jsonb_build_object('status', 'referenced', 'impact', impact);
  end if;

  update ops.contracts as contract
  set
    status = to_status,
    signed_on = effective_signed_on,
    effective_on = effective_effective_on,
    status_reason = coalesce(effective_reason, contract.status_reason),
    current_version_no = next_version_no,
    version = contract.version + 1,
    updated_at = now(),
    updated_by = ops.current_operator_id()
  where contract.id = p_contract_id;

  if p_action = 'activate' then
    -- 快照写在状态更新之后：版本 1 记录的是「生效这一刻」的合同，不是签署前那行。
    snapshot := ops.contract_snapshot_json(p_contract_id);

    insert into ops.contract_versions (
      contract_id, version_no, snapshot, created_by, change_reason
    )
    values (
      p_contract_id, next_version_no, snapshot, ops.current_operator_id(), 'activate'
    )
    returning id into new_version_id;

    perform ops.write_audit(
      'contract.version_created',
      'contract',
      p_contract_id,
      effective_reason,
      null,
      jsonb_build_object(
        'versionNo', next_version_no,
        'reason', 'activate',
        'itemCount', jsonb_array_length(snapshot -> 'items')
      ),
      null
    );
  end if;

  perform ops.write_audit(
    'contract.transitioned',
    'contract',
    p_contract_id,
    effective_reason,
    jsonb_build_object('status', from_status, 'action', p_action),
    jsonb_build_object(
      'from', from_status,
      'to', to_status,
      'reason', effective_reason,
      'impact', impact
    ),
    null
  );

  return jsonb_build_object(
    'status', 'ok',
    'contract', jsonb_build_object(
      'status', to_status,
      'version', target.version + 1,
      'current_version_no', next_version_no,
      'signed_on', effective_signed_on,
      'effective_on', effective_effective_on,
      'status_reason', coalesce(effective_reason, target.status_reason)
    ),
    'impact', impact,
    'version', case
      when new_version_id is null then null
      else ops.contract_version_json(new_version_id)
    end,
    -- 契约 §5.4 的响应列 `createdVersionNo?`：把新快照号单独给出，前端不必从
    -- 完整的 version 对象里挖。非 activate 时没有新快照，返回 null 而不是 0
    -- （0 会被读成「第 0 版」）。
    'created_version_no', case
      when new_version_id is null then null
      else (ops.contract_version_json(new_version_id) ->> 'version_no')::integer
    end
  );
end;
$$;


-- ── GET /contracts/{contractId}/versions ────────────────────────────────────
-- 最新版本在前：版本列表的读法是「最近改了什么」，倒序才是它的默认排序。
CREATE OR REPLACE FUNCTION ops.list_contract_versions (p_contract_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
begin
  perform ops.require_permission('contract.read');

  if not exists (
    select 1 from ops.contracts as contract where contract.id = p_contract_id
  ) then
    return jsonb_build_object('status', 'contract_not_found');
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'items', coalesce(
      (
        select jsonb_agg(
          ops.contract_version_json(version.id)
          order by version.version_no desc
        )
        from ops.contract_versions as version
        where version.contract_id = p_contract_id
      ),
      '[]'::jsonb
    )
  );
end;
$$;


-- ── POST /contracts/{contractId}/amendments ─────────────────────────────────
-- 同一合同同时只允许一张未结变更单（draft / pending_approval）：两张并行变更单
-- 各自基于同一份 before_summary，谁先 applied 谁就把另一张的前提废掉。
--
-- `before_summary` / `after_summary` 的形状固定为 `{header:{...},items:[...]}`：
-- header 只放可改的四列（付款条件/税务说明/商务备注/到期日），items 与
-- `contract_item_json` 同形，`apply` 时可以直接照着重放。
CREATE OR REPLACE FUNCTION ops.create_contract_amendment (
  p_contract_id uuid,
  p_reason text,
  p_header jsonb DEFAULT NULL,
  p_items jsonb DEFAULT NULL,
  p_header_provided boolean DEFAULT FALSE,
  p_items_provided boolean DEFAULT FALSE
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  target ops.contracts;
  normalized jsonb;
  current_header jsonb;
  requested_header jsonb;
  current_items jsonb;
  requested_items jsonb;
  new_id uuid;
  next_amendment_no integer;
begin
  perform ops.require_permission('contract.write');

  -- 理由必填（表上是 NOT NULL）。词表里没有 reason_required，归到通用 400 上，
  -- details.field 说明缺的是哪个字段——与附件文件名的处理同一口径。
  IF NULLIF(btrim(coalesce(p_reason, '')), '') IS NULL THEN
    RETURN jsonb_build_object('status', 'items_required', 'field', 'reason');
  END IF;

  select * into target
  from ops.contracts as contract
  where contract.id = p_contract_id
  for update;

  if not found then
    return jsonb_build_object('status', 'contract_not_found');
  end if;

  -- 变更单的有意义区间是「已签」之后：草稿改内容走 PATCH，不需要变更单。
  if target.status not in ('signed', 'active') then
    return jsonb_build_object(
      'status', 'contract_immutable',
      'current_status', target.status
    );
  end if;

  if exists (
    select 1
    from ops.contract_amendments as amendment
    where amendment.contract_id = p_contract_id
      and amendment.status in ('draft', 'pending_approval')
  ) then
    return jsonb_build_object('status', 'amendment_conflict', 'field', 'amendment');
  end if;

  current_header := jsonb_build_object(
    'paymentTerms', target.payment_terms,
    'taxNote', target.tax_note,
    'businessNote', target.business_note,
    'expiresOn', target.expires_on
  );

  select coalesce(
    jsonb_agg(ops.contract_item_json(item.id) order by item.line_no),
    '[]'::jsonb
  )
  into current_items
  from ops.contract_items as item
  where item.contract_id = p_contract_id;

  if p_items_provided then
    normalized := ops.contract_items_normalize(target.sales_mode, p_items);

    if (normalized ->> 'status') <> 'ok' then
      return normalized;
    end if;

    requested_items := normalized -> 'items';
  else
    requested_items := current_items;
  end if;

  if p_header_provided and p_header is not null then
    requested_header := jsonb_build_object(
      'paymentTerms', coalesce(
        nullif(btrim(coalesce(p_header ->> 'paymentTerms', '')), ''),
        target.payment_terms
      ),
      'taxNote', coalesce(
        nullif(btrim(coalesce(p_header ->> 'taxNote', '')), ''),
        target.tax_note
      ),
      'businessNote', coalesce(
        nullif(btrim(coalesce(p_header ->> 'businessNote', '')), ''),
        target.business_note
      ),
      'expiresOn', coalesce(
        nullif(btrim(coalesce(p_header ->> 'expiresOn', '')), ''),
        target.expires_on::text
      )
    );
  else
    requested_header := current_header;
  end if;

  select coalesce(max(amendment.amendment_no), 0) + 1
  into next_amendment_no
  from ops.contract_amendments as amendment
  where amendment.contract_id = p_contract_id;

  begin
    insert into ops.contract_amendments (
      contract_id, amendment_no, reason, before_summary, after_summary, status,
      requested_by, version, created_by, updated_by
    )
    values (
      p_contract_id,
      next_amendment_no,
      btrim(p_reason),
      jsonb_build_object('header', current_header, 'items', current_items),
      jsonb_build_object('header', requested_header, 'items', requested_items),
      'draft',
      actor_id,
      1,
      actor_id,
      actor_id
    )
    returning id into new_id;
  exception
    when unique_violation then
      return jsonb_build_object('status', 'amendment_conflict', 'field', 'amendment');
  end;

  perform ops.write_audit(
    'contract.amendment_created',
    'contract_amendment',
    new_id,
    p_reason,
    jsonb_build_object('header', current_header),
    jsonb_build_object(
      'amendmentNo', next_amendment_no,
      'status', 'draft',
      'header', requested_header,
      'itemCount', jsonb_array_length(requested_items)
    ),
    null
  );

  return jsonb_build_object('status', 'ok', 'amendment', ops.amendment_json(new_id));
end;
$$;


-- ── POST /contracts/{id}/amendments/{aid}/transition ────────────────────────
-- 四条边：draft→pending_approval（submit，write）、pending_approval→approved
-- （approve，approve）、pending_approval→rejected（reject，approve）、
-- approved→applied（apply，approve）。
--
-- 职责分离在 RPC 里先判一次：表上的 CHECK 会拦住 approved_by = requested_by，
-- 但如果只靠 CHECK，自批会变成 23514 / 500 而不是可读的 409。`apply` 还要写
-- 版本快照，所以它归 approve——能改活合同内容的人必须是能签合同的人。
CREATE OR REPLACE FUNCTION ops.transition_contract_amendment (
  p_contract_id uuid,
  p_amendment_id uuid,
  p_action text,
  p_reason text DEFAULT NULL,
  p_expected_version integer DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  target ops.contract_amendments;
  contract_row ops.contracts;
  required_permission text;
  new_status text;
  decided_by uuid;
  decided_at timestamptz;
  header jsonb;
  items jsonb;
  effective_payment_terms text;
  effective_tax_note text;
  effective_business_note text;
  effective_expires_on date;
  new_total numeric(14, 2);
  next_version_no integer;
  snapshot jsonb;
  new_version_id uuid;
begin
  required_permission := case
    when p_action in ('approve', 'reject', 'apply') then 'contract.approve'
    else 'contract.write'
  end;

  perform ops.require_permission(required_permission);

  select * into target
  from ops.contract_amendments as amendment
  where amendment.id = p_amendment_id
  for update;

  if not found then
    return jsonb_build_object('status', 'amendment_not_found');
  end if;

  -- 路径上的合同段必须与变更单的真实归属一致。不校验的话
  -- `/contracts/{别的合同}/amendments/{本变更单}/transition` 会成功：
  -- 权限码虽然一样（都是 `contract.approve`），但审计里的 contract_id 会记成
  -- 路径上的那张合同，事后追「谁改了哪份合同」就是错的。归属不符按「不存在」处理，
  -- 不区分「变更单不存在」与「不属于这份合同」——区分等于允许探测别人的变更单 id。
  if target.contract_id <> p_contract_id then
    return jsonb_build_object('status', 'amendment_not_found');
  end if;

  if p_expected_version is null or target.version <> p_expected_version then
    return jsonb_build_object(
      'status', 'version_mismatch',
      'current_version', target.version
    );
  end if;

  if p_action = 'submit' and target.status = 'draft' then
    new_status := 'pending_approval';
  elsif p_action = 'approve' and target.status = 'pending_approval' then
    if target.requested_by is not null and target.requested_by = actor_id then
      return jsonb_build_object(
        'status', 'amendment_conflict',
        'field', 'amendment',
        'reason', 'SELF_APPROVAL'
      );
    end if;

    new_status := 'approved';
    decided_by := actor_id;
    decided_at := now();
  elsif p_action = 'reject' and target.status = 'pending_approval' then
    new_status := 'rejected';
    decided_at := now();
  elsif p_action = 'apply' and target.status = 'approved' then
    new_status := 'applied';
  else
    return jsonb_build_object(
      'status', 'invalid_transition',
      'current', target.status,
      'action', p_action
    );
  end if;

  if p_action = 'apply' then
    select * into contract_row
    from ops.contracts as contract
    where contract.id = target.contract_id
    for update;

    if not found then
      return jsonb_build_object('status', 'contract_not_found');
    end if;

    header := coalesce(target.after_summary -> 'header', '{}'::jsonb);
    items := coalesce(target.after_summary -> 'items', '[]'::jsonb);

    effective_payment_terms := case
      when header ? 'paymentTerms' then nullif(btrim(coalesce(header ->> 'paymentTerms', '')), '')
      else contract_row.payment_terms
    end;

    effective_tax_note := case
      when header ? 'taxNote' then nullif(btrim(coalesce(header ->> 'taxNote', '')), '')
      else contract_row.tax_note
    end;

    effective_business_note := case
      when header ? 'businessNote' then nullif(btrim(coalesce(header ->> 'businessNote', '')), '')
      else contract_row.business_note
    end;

    effective_expires_on := case
      when header ? 'expiresOn' then nullif(btrim(coalesce(header ->> 'expiresOn', '')), '')::date
      else contract_row.expires_on
    end;

    select coalesce(max(version.version_no), 0) + 1
    into next_version_no
    from ops.contract_versions as version
    where version.contract_id = contract_row.id;

    if next_version_no <= contract_row.current_version_no then
      next_version_no := contract_row.current_version_no + 1;
    end if;

    delete from ops.contract_items as item where item.contract_id = contract_row.id;

    insert into ops.contract_items (
      contract_id, product_id, package_id, package_price_version_id, sales_mode,
      billing_type, quantity, unit_price, amount, term_months,
      entitlement_snapshot_id, item_name_snapshot, line_no, created_by, updated_by
    )
    select
      contract_row.id,
      (entry ->> 'product_id')::uuid,
      (entry ->> 'package_id')::uuid,
      (entry ->> 'package_price_version_id')::uuid,
      coalesce(nullif(entry ->> 'sales_mode', ''), contract_row.sales_mode),
      coalesce(nullif(entry ->> 'billing_type', ''), 'periodic'),
      greatest(coalesce((entry ->> 'quantity')::integer, 1), 1),
      coalesce((entry ->> 'unit_price')::numeric, 0),
      greatest(coalesce((entry ->> 'quantity')::integer, 1), 1)
        * coalesce((entry ->> 'unit_price')::numeric, 0),
      (entry ->> 'term_months')::integer,
      (entry ->> 'entitlement_snapshot_id')::uuid,
      coalesce(
        nullif(btrim(coalesce(entry ->> 'item_name_snapshot', '')), ''),
        '未命名条目'
      ),
      row_number() over (
        order by coalesce((entry ->> 'line_no')::integer, 0), ord
      ),
      actor_id,
      actor_id
    from jsonb_array_elements(items) with ordinality as source (entry, ord);

    select coalesce(sum(item.amount), 0)
    into new_total
    from ops.contract_items as item
    where item.contract_id = contract_row.id;

    update ops.contracts as contract
    set
      payment_terms = effective_payment_terms,
      tax_note = effective_tax_note,
      business_note = effective_business_note,
      expires_on = effective_expires_on,
      total_amount = new_total,
      current_version_no = next_version_no,
      version = contract.version + 1,
      updated_at = now(),
      updated_by = actor_id
    where contract.id = contract_row.id;

    snapshot := ops.contract_snapshot_json(contract_row.id);

    insert into ops.contract_versions (
      contract_id, version_no, snapshot, created_by, change_reason
    )
    values (
      contract_row.id,
      next_version_no,
      snapshot,
      actor_id,
      'amendment_applied'
    )
    returning id into new_version_id;

    perform ops.write_audit(
      'contract.version_created',
      'contract',
      contract_row.id,
      p_reason,
      null,
      jsonb_build_object(
        'versionNo', next_version_no,
        'reason', 'amendment_applied',
        'amendmentNo', target.amendment_no
      ),
      null
    );
  end if;

  update ops.contract_amendments as amendment
  set
    status = new_status,
    approved_by = coalesce(decided_by, amendment.approved_by),
    approved_at = coalesce(decided_at, amendment.approved_at),    applied_version_no = case
      when new_status = 'applied' then next_version_no
      else amendment.applied_version_no
    end,
    version = amendment.version + 1,
    updated_at = now(),
    updated_by = actor_id
  where amendment.id = p_amendment_id;

  perform ops.write_audit(
    'contract.amendment_decided',
    'contract_amendment',
    p_amendment_id,
    p_reason,
    jsonb_build_object('status', target.status, 'action', p_action),
    jsonb_build_object(
      'amendmentNo', target.amendment_no,
      'from', target.status,
      'to', new_status,
      'appliedVersionNo', case when new_status = 'applied' then next_version_no else null end
    ),
    null
  );

  return jsonb_build_object(
    'status', 'ok',
    'amendment', ops.amendment_json(p_amendment_id),
    'contract', case
      when p_action = 'apply' then ops.contract_json(target.contract_id)
      else null
    end,
    'version', case
      when new_version_id is null then null
      else ops.contract_version_json(new_version_id)
    end,
    'created_version_no', case
      when new_version_id is null then null
      else (ops.contract_version_json(new_version_id) ->> 'version_no')::integer
    end
  );
end;
$$;


-- ── POST /contracts/{contractId}/renewals ───────────────────────────────────
-- 续约建**新**合同（draft），不复用原合同行；原合同一行都不动（规格 §4）。
-- 新合同用 `renewed_from_contract_id` 指回原合同，续约链因此可以直接回溯。
--
-- `renewal_not_due` 的判定窗口契约没写死（规格标推断）：原合同到期日在 90 天
-- 之外视为「还不到续约时点」，`force=true` 可越过。原合同没有到期日时不拦——
-- 无固定期限合同的续约节奏本来就由商务自己定。
CREATE OR REPLACE FUNCTION ops.renew_contract (
  p_contract_id uuid,
  p_effective_on date DEFAULT NULL,
  p_expires_on date DEFAULT NULL,
  p_items jsonb DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_force boolean DEFAULT FALSE
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  source ops.contracts;
  normalized jsonb;
  normalized_items jsonb;
  new_id uuid;
  new_no text;
  new_total numeric(14, 2);
begin
  perform ops.require_permission('contract.write');

  select * into source
  from ops.contracts as contract
  where contract.id = p_contract_id
  for update;

  if not found then
    return jsonb_build_object('status', 'contract_not_found');
  end if;

  -- 草稿/评审中的合同续约没有意义：它们还没有生效过。
  if source.status not in ('signed', 'active', 'expired', 'terminated') then
    return jsonb_build_object(
      'status', 'invalid_transition',
      'current', source.status,
      'action', 'renew'
    );
  end if;

  if not coalesce(p_force, false)
    and source.expires_on is not null
    and source.expires_on > current_date + 90 then
    return jsonb_build_object(
      'status', 'renewal_not_due',
      'expires_on', source.expires_on
    );
  end if;

  if p_items is not null and jsonb_array_length(coalesce(p_items, '[]'::jsonb)) > 0 then
    normalized := ops.contract_items_normalize(source.sales_mode, p_items);

    if (normalized ->> 'status') <> 'ok' then
      return normalized;
    end if;

    normalized_items := normalized -> 'items';
  else
    -- 不传条目就整批复制：续约最常见的动作是「条款照旧，只换起止日」。
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'product_id', item.product_id,
          'package_id', item.package_id,
          'package_price_version_id', item.package_price_version_id,
          'sales_mode', source.sales_mode,
          'billing_type', item.billing_type,
          'quantity', item.quantity,
          'unit_price', item.unit_price,
          'amount', item.quantity * item.unit_price,
          'term_months', item.term_months,
          'item_name_snapshot', item.item_name_snapshot,
          'line_no', item.line_no
        )
        order by item.line_no
      ),
      '[]'::jsonb
    )
    into normalized_items
    from ops.contract_items as item
    where item.contract_id = p_contract_id;
  end if;

  begin
    insert into ops.contracts (
      customer_id, sales_owner_operator_id, sales_mode, currency, payment_terms,
      tax_note, business_note, status, effective_on, expires_on,
      renewed_from_contract_id, current_version_no, created_by, updated_by
    )
    values (
      source.customer_id,
      source.sales_owner_operator_id,
      source.sales_mode,
      source.currency,
      source.payment_terms,
      source.tax_note,
      source.business_note,
      'draft',
      coalesce(p_effective_on, current_date),
      p_expires_on,
      p_contract_id,
      0,
      actor_id,
      actor_id
    )
    returning id, contract_no into new_id, new_no;
  exception
    when unique_violation then
      return jsonb_build_object('status', 'contract_no_conflict');
  end;

  new_total := ops.contract_items_store(new_id, normalized_items);

  update ops.contracts as contract
  set total_amount = new_total
  where contract.id = new_id;

  perform ops.write_audit(
    'contract.renewed',
    'contract',
    new_id,
    p_reason,
    jsonb_build_object('contractNo', source.contract_no, 'expiresOn', source.expires_on),
    jsonb_build_object(
      'contractNo', new_no,
      'renewedFromContractId', p_contract_id,
      'effectiveOn', coalesce(p_effective_on, current_date),
      'expiresOn', p_expires_on,
      'totalAmount', new_total
    ),
    null
  );

  return jsonb_build_object(
    'status', 'ok',
    'contract', ops.contract_json(new_id),
    'items', coalesce(
      (
        select jsonb_agg(ops.contract_item_json(item.id) order by item.line_no)
        from ops.contract_items as item
        where item.contract_id = new_id
      ),
      '[]'::jsonb
    ),
    'renewed_from_contract_id', p_contract_id
  );
end;
$$;


-- ── GET /contracts/{contractId}/entitlement-preview ─────────────────────────
-- 本域与 catalog 的唯一耦合点：条目 → 套餐 → 权益 → 按 feature_key 合并。
-- 合并规则（规格 §6）：同键多条时 `quota` 取最大、`enabled` 取 AND、
-- `termMonths` 取最大；`appliesTo` 一致时取该值，不一致取 'both'。
--
-- 没有 `package_id` 的条目（只写了产品）不产出行，也不报错——契约没规定，
-- 静默跳过并写进未验证项。`warnings[]` 本轮只出 PACKAGE_NOT_ACTIVE 一种。
CREATE OR REPLACE FUNCTION ops.contract_entitlement_preview (p_contract_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
begin
  perform ops.require_permission('contract.read');

  if not exists (
    select 1 from ops.contracts as contract where contract.id = p_contract_id
  ) then
    return jsonb_build_object('status', 'contract_not_found');
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'features', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'featureKey', merged.feature_key,
            'displayName', merged.display_name,
            'enabled', merged.enabled,
            'quota', merged.quota,
            'termMonths', merged.term_months,
            'appliesTo', merged.applies_to
          )
          order by merged.feature_key
        )
        from (
          select
            package_feature.feature_key,
            min(feature.display_name) as display_name,
            bool_and(package_feature.enabled) as enabled,
            max(package_feature.quota_value) as quota,
            max(package_feature.term_months) as term_months,
            case
              when count(distinct package_feature.applies_to) = 1
                then min(package_feature.applies_to)
              else 'both'
            end as applies_to
          from ops.contract_items as item
          join ops.package_features as package_feature
            on package_feature.package_id = item.package_id
          join ops.feature_definitions as feature
            on feature.feature_key = package_feature.feature_key
          where item.contract_id = p_contract_id
          group by package_feature.feature_key
        ) as merged
      ),
      '[]'::jsonb
    ),
    'warnings', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object('code', 'PACKAGE_NOT_ACTIVE', 'packageId', inactive.id)
          order by inactive.id
        )
        from (
          select distinct package.id
          from ops.contract_items as item
          join ops.packages as package on package.id = item.package_id
          where item.contract_id = p_contract_id
            and package.status <> 'active'
        ) as inactive
      ),
      '[]'::jsonb
    )
  );
end;
$$;


-- ── GET /contracts/{contractId}/attachments ─────────────────────────────────
CREATE OR REPLACE FUNCTION ops.list_contract_attachments (p_contract_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
begin
  perform ops.require_permission('contract.read');

  if not exists (
    select 1 from ops.contracts as contract where contract.id = p_contract_id
  ) then
    return jsonb_build_object('status', 'contract_not_found');
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'items', coalesce(
      (
        select jsonb_agg(
          ops.attachment_json(attachment.id)
          order by attachment.uploaded_at desc, attachment.id
        )
        from ops.contract_attachments as attachment
        where attachment.contract_id = p_contract_id
      ),
      '[]'::jsonb
    )
  );
end;
$$;


-- ── POST /contracts/{contractId}/attachments ────────────────────────────────
-- 只登记元数据并返回 `status='pending'`，真正的字节流由客户端直传对象存储
-- （本地没有 Storage，U-13）。`storage_path` 在这里就定下来：
-- `contracts/{contractId}/{attachmentId}/{fileName}`——先有 id 再拼路径，
-- 所以 id 由 RPC 生成，不用序列/默认值。
CREATE OR REPLACE FUNCTION ops.create_contract_attachment (
  p_contract_id uuid,
  p_file_name text,
  p_content_type text,
  p_byte_size bigint
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  new_id uuid := gen_random_uuid();
  normalized_name text := btrim(coalesce(p_file_name, ''));
  normalized_type text := btrim(coalesce(p_content_type, ''));
  storage text;
  allowed_types text[] := array[
    'application/pdf',
    'image/png',
    'image/jpeg',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ];
begin
  perform ops.require_permission('contract.write');

  if not exists (
    select 1 from ops.contracts as contract where contract.id = p_contract_id
  ) then
    return jsonb_build_object('status', 'contract_not_found');
  end if;

  -- 文件名缺失没有专属词（词表里没有 attachment_name_required），归到
  -- `items_required` 这个通用 400 上，details.field 说明是哪个字段。
  if normalized_name = '' then
    return jsonb_build_object('status', 'items_required', 'field', 'fileName');
  end if;

  if p_byte_size is null or p_byte_size <= 0 or p_byte_size > 26214400 then
    return jsonb_build_object(
      'status', 'attachment_too_large',
      'max_bytes', 26214400
    );
  end if;

  if not (normalized_type = any (allowed_types)) then
    return jsonb_build_object(
      'status', 'attachment_type_rejected',
      'content_type', normalized_type
    );
  end if;

  storage := 'contracts/'
    || p_contract_id::text
    || '/'
    || new_id::text
    || '/'
    || normalized_name;

  insert into ops.contract_attachments (
    id, contract_id, file_name, content_type, byte_size, storage_path, status,
    uploaded_by
  )
  values (
    new_id,
    p_contract_id,
    normalized_name,
    normalized_type,
    p_byte_size,
    storage,
    'pending',
    actor_id
  );

  perform ops.write_audit(
    'contract.attachment_added',
    'contract_attachment',
    new_id,
    null,
    null,
    jsonb_build_object(
      'contractId', p_contract_id,
      'fileName', normalized_name,
      'contentType', normalized_type,
      'byteSize', p_byte_size,
      'status', 'pending'
    ),
    null
  );

  return jsonb_build_object('status', 'ok', 'attachment', ops.attachment_json(new_id));
end;
$$;


-- ── POST /contract-attachments/{attachmentId}/complete ──────────────────────
-- 不做真实对象校验（规格 §8 / U-13）：本地没有 Storage，这里只校验
-- `status='pending'` 与 checksum 的 64 位十六进制格式。**生产必须补一次 HEAD**，
-- 否则「登记成功」与「对象真的在」之间没有任何证据。这条写进未验证项。
CREATE OR REPLACE FUNCTION ops.complete_contract_attachment (
  p_attachment_id uuid,
  p_checksum_sha256 text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  target ops.contract_attachments;
  checksum text := nullif(btrim(coalesce(p_checksum_sha256, '')), '');
begin
  perform ops.require_permission('contract.write');

  select * into target
  from ops.contract_attachments as attachment
  where attachment.id = p_attachment_id
  for update;

  if not found then
    return jsonb_build_object('status', 'attachment_not_found');
  end if;

  if target.status <> 'pending' then
    return jsonb_build_object('status', 'attachment_not_uploaded');
  end if;

  if checksum is not null and checksum !~ '^[0-9a-fA-F]{64}$' then
    return jsonb_build_object(
      'status', 'attachment_not_uploaded',
      'field', 'checksumSha256'
    );
  end if;

  update ops.contract_attachments as attachment
  set
    checksum_sha256 = lower(checksum),
    status = 'stored',
    uploaded_at = now(),
    version = attachment.version + 1
  where attachment.id = p_attachment_id;

  perform ops.write_audit(
    'contract.attachment_added',
    'contract_attachment',
    p_attachment_id,
    null,
    jsonb_build_object('status', target.status),
    jsonb_build_object(
      'contractId', target.contract_id,
      'fileName', target.file_name,
      'status', 'stored',
      'checksumSha256', lower(checksum)
    ),
    null
  );

  return jsonb_build_object(
    'status', 'ok',
    'attachment', ops.attachment_json(p_attachment_id)
  );
end;
$$;


-- ── GET /contract-attachments/{attachmentId}/access ─────────────────────────
-- 返回附件元数据（含 `storage_path` 与 `access_scope`）。签名下载 URL 由 API
-- Worker 拼——数据库不知道 `OPS_STORAGE_PUBLIC_URL`，也不该知道。
CREATE OR REPLACE FUNCTION ops.contract_attachment_access (p_attachment_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
begin
  perform ops.require_permission('contract.read');

  if not exists (
    select 1
    from ops.contract_attachments as attachment
    where attachment.id = p_attachment_id
  ) then
    return jsonb_build_object('status', 'attachment_not_found');
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'attachment', ops.attachment_json(p_attachment_id)
  );
end;
$$;


-- ── 授权 ────────────────────────────────────────────────────────────────────
-- 五张表对 authenticated 连 SELECT 都没有：读也走 RPC（见文件头第 1 条）。
-- anon 本来就没有 schema USAGE，这里再撤一次表级权限是防「以后有人补授 USAGE」。
REVOKE ALL ON TABLE ops.contracts,
ops.contract_items,
ops.contract_versions,
ops.contract_amendments,
ops.contract_attachments
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON sequence ops.contract_no_seq
FROM
  public,
  anon,
  authenticated;


ALTER TABLE ops.contracts enable ROW level security;


ALTER TABLE ops.contract_items enable ROW level security;


-- 只 INSERT：没有 UPDATE/DELETE 的 RPC，表级写权限也不授予。
ALTER TABLE ops.contract_versions enable ROW level security;


ALTER TABLE ops.contract_amendments enable ROW level security;


ALTER TABLE ops.contract_attachments enable ROW level security;


-- 形状函数、快照函数、条目归一化/落库函数与计数函数都没有权限判定，必须对所有
-- 非属主角色关闭：漏关一个，任何登录用户都能 `rpc/contract_json` 读到合同与附件路径。
REVOKE ALL ON function ops.contract_json (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.contract_item_json (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.contract_version_json (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.amendment_json (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.attachment_json (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.contract_snapshot_json (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.contract_items_normalize (text, jsonb)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.contract_items_store (uuid, jsonb)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.contract_reference_counts (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.list_contracts (
  text,
  uuid,
  TEXT[],
  uuid,
  date,
  date,
  text,
  integer,
  integer
)
FROM
  public,
  anon;


REVOKE ALL ON function ops.create_contract (uuid, text, text, text, text, text, jsonb)
FROM
  public,
  anon;


REVOKE ALL ON function ops.get_contract (uuid)
FROM
  public,
  anon;


REVOKE ALL ON function ops.update_contract (
  uuid,
  integer,
  text,
  text,
  text,
  date,
  jsonb,
  boolean
)
FROM
  public,
  anon;


REVOKE ALL ON function ops.transition_contract (uuid, text, text, date, date, boolean, integer)
FROM
  public,
  anon;


REVOKE ALL ON function ops.list_contract_versions (uuid)
FROM
  public,
  anon;


REVOKE ALL ON function ops.create_contract_amendment (uuid, text, jsonb, jsonb, boolean, boolean)
FROM
  public,
  anon;


REVOKE ALL ON function ops.transition_contract_amendment (uuid, uuid, text, text, integer)
FROM
  public,
  anon;


REVOKE ALL ON function ops.renew_contract (uuid, date, date, jsonb, text, boolean)
FROM
  public,
  anon;


REVOKE ALL ON function ops.contract_entitlement_preview (uuid)
FROM
  public,
  anon;


REVOKE ALL ON function ops.list_contract_attachments (uuid)
FROM
  public,
  anon;


REVOKE ALL ON function ops.create_contract_attachment (uuid, text, text, bigint)
FROM
  public,
  anon;


REVOKE ALL ON function ops.complete_contract_attachment (uuid, text)
FROM
  public,
  anon;


REVOKE ALL ON function ops.contract_attachment_access (uuid)
FROM
  public,
  anon;


GRANT
EXECUTE ON function ops.list_contracts (
  text,
  uuid,
  TEXT[],
  uuid,
  date,
  date,
  text,
  integer,
  integer
) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.create_contract (uuid, text, text, text, text, text, jsonb) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.get_contract (uuid) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.update_contract (
  uuid,
  integer,
  text,
  text,
  text,
  date,
  jsonb,
  boolean
) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.transition_contract (uuid, text, text, date, date, boolean, integer) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.list_contract_versions (uuid) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.create_contract_amendment (uuid, text, jsonb, jsonb, boolean, boolean) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.transition_contract_amendment (uuid, uuid, text, text, integer) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.renew_contract (uuid, date, date, jsonb, text, boolean) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.contract_entitlement_preview (uuid) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.list_contract_attachments (uuid) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.create_contract_attachment (uuid, text, text, bigint) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.complete_contract_attachment (uuid, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.contract_attachment_access (uuid) TO authenticated,
service_role;


COMMENT ON TABLE ops.contracts IS '运营合同（契约 §3.3）。contract_no 唯一；状态只能经 ops.transition_contract 迁移（7 条边，expired/terminated 终态）；current_version_no 默认 0，activate 时写第 1 版。';


COMMENT ON TABLE ops.contract_items IS '合同条目。amount 由 RPC 按 quantity * unit_price 重算，CHECK 是第二道闸；item_name_snapshot 建行时定格，套餐改名不影响已签合同。';


COMMENT ON TABLE ops.contract_versions IS '合同版本快照，仅 INSERT（无 UPDATE/DELETE RPC，表级写权限不授予）。activate 与变更单 applied 各写一条。';


COMMENT ON TABLE ops.contract_amendments IS '合同变更单。同合同同时只允许一张未结单；approved_by <> requested_by 由 CHECK 与 RPC 双重保证。';


COMMENT ON TABLE ops.contract_attachments IS '合同附件元数据。status pending→stored 由 complete 推进；本轮不校验 Storage 对象是否存在（U-13）。';


COMMENT ON sequence ops.contract_no_seq IS '合同编号序列，格式 HT- + 6 位零填充。允许空洞；唯一约束只作兜底。';


COMMENT ON function ops.contract_reference_counts (uuid) IS '合同引用计数（应收/订阅权益/租户命令）。三张域表未落地时用 to_regclass 跳过并返回 0；表落地后分支自动生效。';


COMMENT ON function ops.transition_contract (uuid, text, text, date, date, boolean, integer) IS '合同状态机（契约 §3.3）：submit/withdraw 需 contract.write，sign/activate/terminate/expire 需 contract.approve；非法边返回 invalid_transition，不 RAISE。';


COMMENT ON function ops.transition_contract_amendment (uuid, uuid, text, text, integer) IS '变更单状态机：submit/approve/reject/apply；自批返回 amendment_conflict，apply 写新合同版本快照。';


COMMENT ON function ops.complete_contract_attachment (uuid, text) IS '附件完成：只校验 pending 与 checksum 的 64 hex 格式，不查 Storage（本地无 Storage，U-13）。';