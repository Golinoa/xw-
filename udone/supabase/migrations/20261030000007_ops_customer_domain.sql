-- 运营客户域：两张表 + 掩码函数 + 引用计数 + 十一个 RPC（契约 §3.1、§5.2）。
--
-- 设计要点：
--
-- 1. 写路径只有 SECURITY DEFINER RPC。`ops.customers` 与 `ops.customer_contacts`
--    在本轮连 SELECT 都不授予 authenticated：读也走 RPC。契约 §7.3 把这两张表归在
--    A1（可直写）类，但同一份契约的 §5.2 又要求联系人原值键由
--    `customer.sensitive.read` 决定**是否出现**——列级 grant 表达不了「有键/没键」，
--    只有 RPC 组装 jsonb 才能。给了一半权限的表比一张都不给更难解释：直读的人会
--    拿到没有原值键的行，看起来像「数据没录」。
--
-- 2. 业务失败用 `{status:...}` 信封，不 RAISE。理由与 `20261030000005` 一致：
--    PostgREST 把任何非 2xx 压成状态码，返回值才是可分辨的分支。只有权限不足
--    仍走 `ops.require_permission` 抛 42501——那不是业务分支。
--
-- 3. `customer_no` 由 sequence 生成，格式 `CUS-` + 6 位零填充。序列允许空洞，
--    并发下不会重号；`customers_customer_no_key` 只作为兜底存在，唯一冲突时返回
--    `customer_no_conflict` 而不是 500。
--
-- 4. 掩码函数是 P6 的落点：掩码值始终可读，原值只在调用方具备
--    `customer.sensitive.read` 时才被 RPC 拼进 jsonb。`customer_contact_json()`
--    把「有没有原值键」做成参数而不是再判一次权限——判定只能在 RPC 里发生一次，
--    两个地方各判一次，迟早会出现「掩码值有了、原值键也在」的第三种形态。
--
-- 5. 合同/授权/工单/部署四张表本轮还不存在。`ops.customer_reference_counts()`
--    因此用 `to_regclass` 守卫 + 动态 SQL：引用不存在的表会连函数都建不出来，
--    而本轮必须先把 `terminate` 的引用守卫接上，否则后续四张表落地时要改的是
--    状态机本身，不是加一个计数分支。哪张表落地就把对应分支补进来。
--
-- 6. 客户状态机严格照契约 §3.1 的五条边。`terminated` 是终态；`status` 与
--    `owner_operator_id` 不在 `update_customer` 的白名单里——PATCH 能改状态等于给
--    状态机守卫开后门（契约 §7.4 P13）。
CREATE SEQUENCE ops.customer_no_seq AS bigint START
WITH
  1 INCREMENT BY 1;


CREATE TABLE ops.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 默认值就是生成规则：调用方不传编号，序列保证并发不重号。
  customer_no text NOT NULL DEFAULT (
    'CUS-' || lpad(nextval('ops.customer_no_seq')::text, 6, '0')
  ),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  -- 名称与信用代码**不做**唯一约束：重复只提示（duplicate_hints），不阻断。
  unified_social_credit_code text,
  region_code text,
  status text NOT NULL CHECK (
    status IN (
      'signed',
      'onboarding',
      'active',
      'suspended',
      'terminated'
    )
  ),
  owner_operator_id uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  source_note text,
  internal_note text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  updated_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  -- 软删除三列本轮没有写入路径：契约 §5.2 没有归档端点，状态机终态即归档位。
  -- 列先留着是因为「不物理删除历史」是表级约定，等归档端点落地时不该再改一次表。
  archived_at timestamptz,
  archived_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  archived_reason text,
  CONSTRAINT customers_customer_no_key UNIQUE (customer_no)
);


ALTER SEQUENCE ops.customer_no_seq OWNED BY ops.customers.customer_no;


CREATE INDEX customers_status_created_idx ON ops.customers (status, created_at DESC);


CREATE INDEX customers_owner_idx ON ops.customers (owner_operator_id);


CREATE INDEX customers_name_idx ON ops.customers (name);


CREATE TABLE ops.customer_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT：客户还在时不能物理删，联系人属于客户但不随客户级联消失。
  customer_id uuid NOT NULL REFERENCES ops.customers (id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  job_title text,
  phone text,
  email text,
  usage_scene text,
  is_primary boolean NOT NULL DEFAULT FALSE,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  updated_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL
);


-- 每客户至多一个主要联系人。部分唯一索引是唯一能在库层表达这件事的形式，
-- 但 RPC 仍要在插入前降级旧主要——靠索引报错只会得到一个 500。
CREATE UNIQUE INDEX customer_contacts_primary_idx ON ops.customer_contacts (customer_id)
WHERE
  is_primary;


CREATE INDEX customer_contacts_customer_idx ON ops.customer_contacts (customer_id);


-- ── 掩码 ────────────────────────────────────────────────────────────────────
-- 掩码是「没有敏感权限时唯一可读的联系方式」。NULL 进 NULL 出：把 NULL 变成
-- 一串星号会让「没留电话」与「留了但被掩码」看起来一样，而这两种情况的后续
-- 动作不同（该补录 vs 该申请权限）。
--
-- 长度不足 7 时整串按原长度打码，不保留首尾：`1388888` 这种短号保留前 3 后 4
-- 就等于原样输出，而「掩码函数把短号原样返回」是最容易被忽略的泄漏。
CREATE OR REPLACE FUNCTION ops.mask_phone (p_phone text) returns text language sql stable security definer
SET
  search_path = '' AS $$
  select case
    when p_phone is null then null
    when length(p_phone) < 7 then repeat('*', length(p_phone))
    else left(p_phone, 3) || '****' || right(p_phone, 4)
  end;
$$;


-- 保留首字符与域名：`a***@example.com`。没有 `@` 的值（录错或用别的形态）按
-- 手机号的短串规则处理，不让「没有域名」变成原样输出。
CREATE OR REPLACE FUNCTION ops.mask_email (p_email text) returns text language sql stable security definer
SET
  search_path = '' AS $$
  select case
    when p_email is null then null
    when strpos(p_email, '@') = 0 then left(p_email, 1) || '***'
    else left(p_email, 1) || '***' || substring(p_email from strpos(p_email, '@'))
  end;
$$;


-- ── 引用计数（前向兼容） ────────────────────────────────────────────────────
-- 四张域表本轮都不存在。`to_regclass` 在**运行期**判定，配合动态 SQL：直接写
-- `select count(*) from ops.contracts` 会让函数在创建时就因为「表不存在」失败，
-- 于是整条 terminate 守卫连编译都过不去。
--
-- 落地时怎么补：把对应 `if to_regclass(...) is not null then` 分支里的表名换成
-- 真实表名，并在该表的迁移里保证它有 `customer_id` 列（这里按列名约定取数）。
-- `active_contract_count`（列表项）走同一个口径 —— `->> 'contracts'`，
-- 生效中的筛选条件等 contract 域给出后由该分支自己收紧，不要在调用方再写一份。
CREATE OR REPLACE FUNCTION ops.customer_reference_counts (p_customer_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  contract_count integer := 0;
  entitlement_count integer := 0;
  ticket_count integer := 0;
  deployment_count integer := 0;
begin
  if to_regclass('ops.contracts') is not null then
    execute 'select count(*) from ops.contracts where customer_id = $1'
      into contract_count
      using p_customer_id;
  end if;

  if to_regclass('ops.subscriptions') is not null then
    execute 'select count(*) from ops.subscriptions where customer_id = $1'
      into entitlement_count
      using p_customer_id;
  end if;

  if to_regclass('ops.tickets') is not null then
    execute 'select count(*) from ops.tickets where customer_id = $1'
      into ticket_count
      using p_customer_id;
  end if;

  if to_regclass('ops.deployment_instances') is not null then
    execute 'select count(*) from ops.deployment_instances where customer_id = $1'
      into deployment_count
      using p_customer_id;
  end if;

  return jsonb_build_object(
    'contracts', contract_count,
    'entitlements', entitlement_count,
    'tickets', ticket_count,
    'deployments', deployment_count
  );
end;
$$;


-- ── 形状函数 ────────────────────────────────────────────────────────────────
-- 与 `ops.operator_json` 同一口径：返回数据库列名（snake_case），出站校验负责
-- 拒绝字段漂移。这三个函数**没有**权限判定，必须对所有非属主角色关闭执行权，
-- 否则任意登录用户都能按 id 读客户与联系人原值。
CREATE OR REPLACE FUNCTION ops.customer_json (p_customer_id uuid) returns jsonb language sql stable security definer
SET
  search_path = '' AS $$
  select jsonb_build_object(
    'id', customer.id,
    'customer_no', customer.customer_no,
    'name', customer.name,
    'unified_social_credit_code', customer.unified_social_credit_code,
    'region_code', customer.region_code,
    'status', customer.status,
    'owner', case
      when owner.id is null then null
      else jsonb_build_object(
        'id', owner.id,
        'display_name', owner.display_name,
        'email', owner.email
      )
    end,
    'source_note', customer.source_note,
    'internal_note', customer.internal_note,
    'version', customer.version,
    'created_at', customer.created_at,
    'updated_at', customer.updated_at
  )
  from ops.customers as customer
  left join ops.operators as owner on owner.id = customer.owner_operator_id
  where customer.id = p_customer_id;
$$;


-- `p_include_sensitive` 由调用方（RPC）算好传进来。参数化的理由：把权限判定
-- 放在这里会让「谁在调用」变成隐式上下文，而 SECURITY DEFINER 函数里
-- `auth.uid()` 仍然是调用者的 —— 两种写法都能跑，但只有显式参数能让测试直接
-- 断言两种形态，不必伪造权限。
CREATE OR REPLACE FUNCTION ops.customer_contact_json (p_contact_id uuid, p_include_sensitive boolean) returns jsonb language sql stable security definer
SET
  search_path = '' AS $$
  select jsonb_build_object(
    'id', contact.id,
    'name', contact.name,
    'job_title', contact.job_title,
    'phone_masked', ops.mask_phone(contact.phone),
    'email_masked', ops.mask_email(contact.email),
    'is_primary', contact.is_primary,
    'usage_scene', contact.usage_scene,
    'version', contact.version,
    'created_at', contact.created_at,
    'updated_at', contact.updated_at
  ) || case
    when p_include_sensitive then jsonb_build_object('phone', contact.phone, 'email', contact.email)
    else '{}'::jsonb
  end
  from ops.customer_contacts as contact
  where contact.id = p_contact_id;
$$;


CREATE OR REPLACE FUNCTION ops.customer_list_json (p_customer_id uuid) returns jsonb language sql stable security definer
SET
  search_path = '' AS $$
  select ops.customer_json(customer.id) || jsonb_build_object(
    'primary_contact', case
      when contact.id is null then null
      else jsonb_build_object(
        'masked_phone', ops.mask_phone(contact.phone),
        'masked_email', ops.mask_email(contact.email)
      )
    end,
    'active_contract_count', coalesce(
      (ops.customer_reference_counts(customer.id) ->> 'contracts')::integer,
      0
    )
  )
  from ops.customers as customer
  left join ops.customer_contacts as contact
    on contact.customer_id = customer.id
    and contact.is_primary
  where customer.id = p_customer_id
  -- 部分唯一索引保证至多一条主要联系人；`limit 1` 是给「索引被绕过（例如有人
  -- 临时删过索引）」的情况留一条确定的返回，而不是让列表整页报错。
  limit 1;
$$;


-- 查重的唯一真源：`create_customer` 的提示与 `check_customer_duplicates` 的
-- 回包必须是同一批行、同一个判定。写两遍的代价不是重复，而是某天只给其中一处
-- 加了「忽略大小写」——建客户时提示 0 条、查重端点提示 1 条，用户会以为后者是 bug。
CREATE OR REPLACE FUNCTION ops.customer_duplicate_matches (p_name text, p_unified_social_credit_code text) returns TABLE (
  customer_id uuid,
  customer_no text,
  customer_name text,
  match_reason text
) language sql stable security definer
SET
  search_path = '' AS $$
  with candidate as (
    select
      customer.id,
      customer.customer_no,
      customer.name,
      lower(btrim(customer.name)) = lower(btrim(coalesce(p_name, ''))) as name_match,
      coalesce(btrim(p_unified_social_credit_code), '') <> ''
        and lower(btrim(coalesce(customer.unified_social_credit_code, '')))
          = lower(btrim(p_unified_social_credit_code)) as uscc_match
    from ops.customers as customer
  )
  select
    candidate.id,
    candidate.customer_no,
    candidate.name,
    case
      when candidate.name_match and candidate.uscc_match then 'NAME_AND_USCC_MATCH'
      when candidate.name_match then 'NAME_MATCH'
      else 'USCC_MATCH'
    end
  from candidate
  where candidate.name_match or candidate.uscc_match
  order by candidate.customer_no;
$$;


-- ── GET /customers ──────────────────────────────────────────────────────────
-- `p_contract_status` 与 `p_entitlement_expiring_in_days` 本轮**接受但不生效**：
-- 合同与授权表还不存在，筛一个不存在的集合只能靠猜。留着参数是为了让 Worker 的
-- 入站形状不必等到 T-06 再改一次；落地时把过滤条件补进 `filtered` 即可。
CREATE OR REPLACE FUNCTION ops.list_customers (
  p_keyword text DEFAULT NULL,
  p_statuses TEXT[] DEFAULT NULL,
  p_owner_operator_id uuid DEFAULT NULL,
  p_contract_status text DEFAULT NULL,
  p_entitlement_expiring_in_days integer DEFAULT NULL,
  p_sort text DEFAULT 'created_at',
  p_order text DEFAULT 'desc',
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 20
) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  page_size integer := least(greatest(coalesce(p_page_size, 20), 1), 100);
  page_offset integer := (greatest(coalesce(p_page, 1), 1) - 1) * page_size;
  direction text := case when lower(coalesce(p_order, 'desc')) = 'asc' then 'asc' else 'desc' end;
  -- 白名单：非法值落 created_at，而不是报错。排序是展示细节，不该让一个拼错的
  -- `sort` 变成 400——列表仍然可用，只是顺序回到默认。
  sort_key text := case
    when p_sort in ('created_at', 'updated_at', 'name') then p_sort
    else 'created_at'
  end;
begin
  perform ops.require_permission('customer.read');

  return (
    with filtered as (
      select customer.*
      from ops.customers as customer
      where (p_statuses is null or customer.status = any (p_statuses))
        and (p_owner_operator_id is null or customer.owner_operator_id = p_owner_operator_id)
        and (
          p_keyword is null
          or btrim(p_keyword) = ''
          or customer.name ilike '%' || btrim(p_keyword) || '%'
          or customer.customer_no ilike '%' || btrim(p_keyword) || '%'
        )
    ), ordered as (
      select
        filtered.id,
        row_number() over (
          order by
            -- 排序键走 CASE 阶梯而不是拼字符串：列名不能绑定，拼进去就是注入。
            -- `name` 用 lower() 排序，否则「Apple」与「apple」会被大写字母分开。
            case when sort_key = 'created_at' and direction = 'asc' then filtered.created_at end asc nulls last,
            case when sort_key = 'created_at' and direction = 'desc' then filtered.created_at end desc nulls last,
            case when sort_key = 'updated_at' and direction = 'asc' then filtered.updated_at end asc nulls last,
            case when sort_key = 'updated_at' and direction = 'desc' then filtered.updated_at end desc nulls last,
            case when sort_key = 'name' and direction = 'asc' then lower(filtered.name) end asc nulls last,
            case when sort_key = 'name' and direction = 'desc' then lower(filtered.name) end desc nulls last,
            -- 兜底必须唯一，否则翻页会漏行或重行。
            filtered.created_at desc,
            filtered.id asc
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
      'items', coalesce(
        (
          select jsonb_agg(ops.customer_list_json(page.id) order by page.position)
          from page
        ),
        '[]'::jsonb
      ),
      'total', (select count(*) from filtered)
    )
  );
end;
$$;


-- ── POST /customers ─────────────────────────────────────────────────────────
-- 客户与联系人同一事务写入：只写了一半的客户（有客户行、没有内嵌联系人）会让
-- `start_onboarding` 永远返回 `contacts_required`，而用户明明在创建时填了人。
CREATE OR REPLACE FUNCTION ops.create_customer (
  p_name text,
  p_unified_social_credit_code text DEFAULT NULL,
  p_region_code text DEFAULT NULL,
  p_source_note text DEFAULT NULL,
  p_internal_note text DEFAULT NULL,
  p_owner_operator_id uuid DEFAULT NULL,
  p_contacts jsonb DEFAULT '[]'::jsonb,
  p_reason text DEFAULT NULL,
  p_request_id text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  new_id uuid;
  new_no text;
  contact jsonb;
  contact_count integer := 0;
  normalized_name text := btrim(coalesce(p_name, ''));
  normalized_uscc text := nullif(btrim(coalesce(p_unified_social_credit_code, '')), '');
  hints jsonb;
begin
  perform ops.require_permission('customer.write');

  -- 责任人必须是有效运营账号。这里只判「行存在」不判 `status = 'active'`：
  -- 已停用账号仍然是被追溯的历史责任人，把它当“不存在”会让 PATCH 之外的
  -- 场景无法引用旧账号。
  if p_owner_operator_id is not null and not exists (
    select 1 from ops.operators as operator where operator.id = p_owner_operator_id
  ) then
    return jsonb_build_object('status', 'unknown_owner', 'owner_operator_id', p_owner_operator_id);
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', match.customer_id,
        'customer_no', match.customer_no,
        'name', match.customer_name,
        'reason', match.match_reason
      )
      order by match.customer_no
    ),
    '[]'::jsonb
  )
  into hints
  from (
    select *
    from ops.customer_duplicate_matches(normalized_name, normalized_uscc)
    limit 5
  ) as match;

  begin
    insert into ops.customers (
      name, unified_social_credit_code, region_code, status, owner_operator_id,
      source_note, internal_note, created_by, updated_by
    )
    values (
      normalized_name,
      normalized_uscc,
      nullif(btrim(coalesce(p_region_code, '')), ''),
      'signed',
      p_owner_operator_id,
      nullif(btrim(coalesce(p_source_note, '')), ''),
      nullif(btrim(coalesce(p_internal_note, '')), ''),
      actor_id,
      actor_id
    )
    returning id, customer_no into new_id, new_no;
  exception
    when unique_violation then
      -- 序列生成不可能重号，能走到这里说明有人手工插了编号或序列被重置过。
      -- 它是兜底，不是「你填重了」——前端看到 409 时该提示的是「系统侧冲突」。
      return jsonb_build_object('status', 'customer_no_conflict');
  end;

  for contact in
    select value from jsonb_array_elements(coalesce(p_contacts, '[]'::jsonb))
  loop
    -- 同一批里出现两个 `is_primary` 时，后一个把前一个降级。部分唯一索引会
    -- 直接报 500，而降级是契约 §5.2 对「主要联系人冲突」的既定处理。
    if coalesce((contact ->> 'is_primary')::boolean, false) then
      update ops.customer_contacts
      set
        is_primary = false,
        version = version + 1,
        updated_at = now(),
        updated_by = actor_id
      where customer_id = new_id
        and is_primary;
    end if;

    insert into ops.customer_contacts (
      customer_id, name, job_title, phone, email, is_primary, usage_scene,
      created_by, updated_by
    )
    values (
      new_id,
      btrim(coalesce(contact ->> 'name', '')),
      nullif(btrim(coalesce(contact ->> 'job_title', '')), ''),
      nullif(btrim(coalesce(contact ->> 'phone', '')), ''),
      nullif(btrim(coalesce(contact ->> 'email', '')), ''),
      coalesce((contact ->> 'is_primary')::boolean, false),
      nullif(btrim(coalesce(contact ->> 'usage_scene', '')), ''),
      actor_id,
      actor_id
    );

    contact_count := contact_count + 1;
  end loop;

  perform ops.write_audit(
    'customer.created',
    'customer',
    new_id,
    p_reason,
    null,
    jsonb_build_object(
      'customerNo', new_no,
      'name', normalized_name,
      'status', 'signed',
      'contactCount', contact_count
    ),
    p_request_id
  );

  return jsonb_build_object(
    'status', 'ok',
    'customer', ops.customer_json(new_id),
    'duplicate_hints', hints
  );
end;
$$;


-- ── POST /customers/duplicate-check ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.check_customer_duplicates (
  p_name text,
  p_unified_social_credit_code text DEFAULT NULL
) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  items jsonb;
begin
  perform ops.require_permission('customer.read');

  -- 上限 50：这是输入框失焦就会触发的读，返回全量同名客户没有意义，
  -- 而它会在「客户名叫 XX 旅行社」这类数据上变成一次全表扫描的响应。
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', match.customer_id,
        'customer_no', match.customer_no,
        'name', match.customer_name,
        'match_reason', match.match_reason
      )
      order by match.customer_no
    ),
    '[]'::jsonb
  )
  into items
  from (
    select *
    from ops.customer_duplicate_matches(p_name, p_unified_social_credit_code)
    limit 50
  ) as match;

  return jsonb_build_object('items', items);
end;
$$;


-- ── GET /customers/{customerId} ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.get_customer (p_customer_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  sensitive boolean := coalesce((select ops.has_permission('customer.sensitive.read')), false);
  reference_counts jsonb;
  contacts jsonb;
begin
  perform ops.require_permission('customer.read');

  if not exists (select 1 from ops.customers as customer where customer.id = p_customer_id) then
    return jsonb_build_object('status', 'not_found');
  end if;

  select coalesce(
    jsonb_agg(
      ops.customer_contact_json(contact.id, sensitive)
      order by contact.is_primary desc, contact.created_at, contact.id
    ),
    '[]'::jsonb
  )
  into contacts
  from ops.customer_contacts as contact
  where contact.customer_id = p_customer_id;

  reference_counts := ops.customer_reference_counts(p_customer_id);

  -- 六个计数里只有四个有域表可数，`receivables` / `subscriptions` / `licenses`
  -- 本轮恒为 0。**键必须都在**：少一个键会让 `customerCountsRowSchema` 整条
  -- 失败，前端连客户详情都渲染不出来。
  return jsonb_build_object(
    'status', 'ok',
    'customer', ops.customer_json(p_customer_id),
    'contacts', contacts,
    'counts', jsonb_build_object(
      'contracts', (reference_counts ->> 'contracts')::integer,
      'receivables', 0,
      'subscriptions', 0,
      'licenses', 0,
      'deployments', (reference_counts ->> 'deployments')::integer,
      'tickets', (reference_counts ->> 'tickets')::integer
    )
  );
end;
$$;


-- ── PATCH /customers/{customerId} ───────────────────────────────────────────
-- `status` 与 `owner_operator_id` 刻意不在参数表里：状态只能经 transition RPC，
-- 责任人创建后不可换（契约 §5.2 没有这条写入口）。让这两件事「在接口形状上
-- 不存在」，比在函数体里判一次更难被后来的改动绕过。
CREATE OR REPLACE FUNCTION ops.update_customer (
  p_customer_id uuid,
  p_expected_version integer,
  p_name text DEFAULT NULL,
  p_unified_social_credit_code text DEFAULT NULL,
  p_region_code text DEFAULT NULL,
  p_source_note text DEFAULT NULL,
  p_internal_note text DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_request_id text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  target ops.customers;
  effective_name text;
begin
  perform ops.require_permission('customer.write');

  -- FOR UPDATE：版本比较必须在锁内做，否则两个并发 PATCH 都读到 version=3，
  -- 都写成功，版本停在 4。
  select * into target
  from ops.customers as customer
  where customer.id = p_customer_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if p_expected_version is null or target.version <> p_expected_version then
    return jsonb_build_object('status', 'version_mismatch', 'current_version', target.version);
  end if;

  effective_name := case when p_name is null then target.name else btrim(p_name) end;

  update ops.customers as customer
  set
    name = effective_name,
    unified_social_credit_code = case
      when p_unified_social_credit_code is null then customer.unified_social_credit_code
      else nullif(btrim(p_unified_social_credit_code), '')
    end,
    region_code = case
      when p_region_code is null then customer.region_code
      else nullif(btrim(p_region_code), '')
    end,
    source_note = case
      when p_source_note is null then customer.source_note
      else nullif(btrim(p_source_note), '')
    end,
    internal_note = case
      when p_internal_note is null then customer.internal_note
      else nullif(btrim(p_internal_note), '')
    end,
    version = customer.version + 1,
    updated_at = now(),
    updated_by = ops.current_operator_id()
  where customer.id = p_customer_id;

  perform ops.write_audit(
    'customer.updated',
    'customer',
    p_customer_id,
    p_reason,
    jsonb_build_object(
      'name', target.name,
      'unifiedSocialCreditCode', target.unified_social_credit_code,
      'regionCode', target.region_code,
      'status', target.status,
      'ownerOperatorId', target.owner_operator_id
    ),
    jsonb_build_object(
      'name', effective_name,
      'unifiedSocialCreditCode', case
        when p_unified_social_credit_code is null then target.unified_social_credit_code
        else nullif(btrim(p_unified_social_credit_code), '')
      end,
      'regionCode', case
        when p_region_code is null then target.region_code
        else nullif(btrim(p_region_code), '')
      end,
      'status', target.status,
      'ownerOperatorId', target.owner_operator_id
    ),
    p_request_id
  );

  return jsonb_build_object('status', 'ok', 'customer', ops.customer_json(p_customer_id));
end;
$$;


-- ── POST /customers/{customerId}/transition ─────────────────────────────────
-- 五条边逐条判定，不用「先算目标状态再校验」的写法：`contacts_required` 与
-- `referenced` 是两条**只有某一条边**才会触发的守卫，混在通用分支里会让
-- `activate` 也开始检查联系人（契约没这条）。
CREATE OR REPLACE FUNCTION ops.transition_customer (
  p_customer_id uuid,
  p_action text,
  p_reason text DEFAULT NULL,
  p_expected_version integer DEFAULT NULL,
  p_request_id text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  target ops.customers;
  from_status text;
  to_status text;
  contact_count integer;
  impact jsonb;
begin
  perform ops.require_permission('customer.write');

  select * into target
  from ops.customers as customer
  where customer.id = p_customer_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if p_expected_version is null or target.version <> p_expected_version then
    return jsonb_build_object('status', 'version_mismatch', 'current_version', target.version);
  end if;

  from_status := target.status;

  to_status := case
    when p_action = 'start_onboarding' and from_status = 'signed' then 'onboarding'
    when p_action = 'activate' and from_status = 'onboarding' then 'active'
    when p_action = 'suspend' and from_status = 'active' then 'suspended'
    when p_action = 'resume' and from_status = 'suspended' then 'active'
    when p_action = 'terminate'
      and from_status in ('signed', 'onboarding', 'active', 'suspended') then 'terminated'
  end;

  -- `terminated` 是终态：任何动作都落在这里，包括再次 `terminate`。
  if to_status is null then
    return jsonb_build_object('status', 'invalid_transition');
  end if;

  if p_action = 'start_onboarding' then
    select count(*) into contact_count
    from ops.customer_contacts as contact
    where contact.customer_id = p_customer_id;

    if contact_count = 0 then
      return jsonb_build_object('status', 'contacts_required');
    end if;
  end if;

  impact := ops.customer_reference_counts(p_customer_id);

  if p_action = 'terminate' and (
    (impact ->> 'contracts')::integer > 0
    or (impact ->> 'entitlements')::integer > 0
    or (impact ->> 'tickets')::integer > 0
    or (impact ->> 'deployments')::integer > 0
  ) then
    return jsonb_build_object('status', 'referenced', 'impact', impact);
  end if;

  update ops.customers as customer
  set
    status = to_status,
    version = customer.version + 1,
    updated_at = now(),
    updated_by = ops.current_operator_id()
  where customer.id = p_customer_id;

  perform ops.write_audit(
    'customer.transitioned',
    'customer',
    p_customer_id,
    p_reason,
    jsonb_build_object('status', from_status, 'action', p_action),
    jsonb_build_object('status', to_status, 'action', p_action, 'impact', impact),
    p_request_id
  );

  return jsonb_build_object(
    'status', 'ok',
    'customer', jsonb_build_object('status', to_status, 'version', target.version + 1),
    'impact', impact
  );
end;
$$;


-- ── GET /customers/{customerId}/overview ────────────────────────────────────
-- 七个数组本轮全空。**返回空数组而不是省略键**：前端按 `data.contracts.length`
-- 渲染，缺键会在运行时抛 TypeError，而那时看起来像「总览接口坏了」。
CREATE OR REPLACE FUNCTION ops.customer_overview (p_customer_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
begin
  perform ops.require_permission('customer.read');

  if not exists (select 1 from ops.customers as customer where customer.id = p_customer_id) then
    return jsonb_build_object('status', 'not_found');
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'contracts', '[]'::jsonb,
    'receivables', '[]'::jsonb,
    'subscriptions', '[]'::jsonb,
    'licenses', '[]'::jsonb,
    'tenant_mappings', '[]'::jsonb,
    'deployments', '[]'::jsonb,
    'tickets', '[]'::jsonb
  );
end;
$$;


-- ── GET /customers/{customerId}/contacts ────────────────────────────────────
-- 原值键的出现与否完全由 `customer.sensitive.read` 决定：没有权限时**键不存在**，
-- 而不是值为 null。`jsonb_build_object` 无法删键，所以这里靠
-- `customer_contact_json(..., false)` 的分支产出。
CREATE OR REPLACE FUNCTION ops.list_customer_contacts (p_customer_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  sensitive boolean := coalesce((select ops.has_permission('customer.sensitive.read')), false);
  items jsonb;
begin
  perform ops.require_permission('customer.read');

  if not exists (select 1 from ops.customers as customer where customer.id = p_customer_id) then
    return jsonb_build_object('status', 'not_found');
  end if;

  select coalesce(
    jsonb_agg(
      ops.customer_contact_json(contact.id, sensitive)
      order by contact.is_primary desc, contact.created_at, contact.id
    ),
    '[]'::jsonb
  )
  into items
  from ops.customer_contacts as contact
  where contact.customer_id = p_customer_id;

  return jsonb_build_object('status', 'ok', 'items', items);
end;
$$;


-- ── POST /customers/{customerId}/contacts ───────────────────────────────────
CREATE OR REPLACE FUNCTION ops.create_customer_contact (
  p_customer_id uuid,
  p_name text,
  p_job_title text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_email text DEFAULT NULL,
  p_is_primary boolean DEFAULT NULL,
  p_usage_scene text DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_request_id text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  new_id uuid;
  make_primary boolean := coalesce(p_is_primary, false);
  sensitive boolean := coalesce((select ops.has_permission('customer.sensitive.read')), false);
  contact_total integer;
begin
  perform ops.require_permission('customer.write');

  if not exists (select 1 from ops.customers as customer where customer.id = p_customer_id) then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- 先降级再插入，**不能**靠部分唯一索引报错：那会变成 500，而契约要求这里
  -- 是「自动降级旧主要」。
  if make_primary then
    update ops.customer_contacts as contact
    set
      is_primary = false,
      version = contact.version + 1,
      updated_at = now(),
      updated_by = actor_id
    where contact.customer_id = p_customer_id
      and contact.is_primary;
  end if;

  insert into ops.customer_contacts (
    customer_id, name, job_title, phone, email, is_primary, usage_scene,
    created_by, updated_by
  )
  values (
    p_customer_id,
    btrim(p_name),
    nullif(btrim(coalesce(p_job_title, '')), ''),
    nullif(btrim(coalesce(p_phone, '')), ''),
    nullif(btrim(coalesce(p_email, '')), ''),
    make_primary,
    nullif(btrim(coalesce(p_usage_scene, '')), ''),
    actor_id,
    actor_id
  )
  returning id into new_id;

  select count(*) into contact_total
  from ops.customer_contacts as contact
  where contact.customer_id = p_customer_id;

  -- 审计摘要不含电话/邮箱原值：审计页对所有 `audit.read` 开放，把原值写进
  -- 摘要等于给掩码开了一个后门。
  perform ops.write_audit(
    'customer.contact_changed',
    'customer_contact',
    new_id,
    p_reason,
    null,
    jsonb_build_object(
      'customerId', p_customer_id,
      'name', btrim(p_name),
      'isPrimary', make_primary,
      'contactCount', contact_total
    ),
    p_request_id
  );

  return jsonb_build_object(
    'status', 'ok',
    'contact', ops.customer_contact_json(new_id, sensitive)
  );
end;
$$;


-- ── PATCH /customers/{customerId}/contacts/{contactId} ──────────────────────
CREATE OR REPLACE FUNCTION ops.update_customer_contact (
  p_customer_id uuid,
  p_contact_id uuid,
  p_expected_version integer,
  p_name text DEFAULT NULL,
  p_job_title text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_email text DEFAULT NULL,
  p_is_primary boolean DEFAULT NULL,
  p_usage_scene text DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_request_id text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  target ops.customer_contacts;
  make_primary boolean;
  sensitive boolean := coalesce((select ops.has_permission('customer.sensitive.read')), false);
begin
  perform ops.require_permission('customer.write');

  select * into target
  from ops.customer_contacts as contact
  where contact.id = p_contact_id
    and contact.customer_id = p_customer_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if p_expected_version is null or target.version <> p_expected_version then
    return jsonb_build_object('status', 'version_mismatch', 'current_version', target.version);
  end if;

  make_primary := coalesce(p_is_primary, target.is_primary);

  -- 只在「变成主要」时降级旧主要。把 true→false 也走这条会顺手把别的行改掉，
  -- 而那次修改不属于本次请求。false→false 更不能碰。
  if make_primary and not target.is_primary then
    update ops.customer_contacts as contact
    set
      is_primary = false,
      version = contact.version + 1,
      updated_at = now(),
      updated_by = actor_id
    where contact.customer_id = p_customer_id
      and contact.is_primary
      and contact.id <> p_contact_id;
  end if;

  update ops.customer_contacts as contact
  set
    name = case when p_name is null then contact.name else btrim(p_name) end,
    job_title = case
      when p_job_title is null then contact.job_title
      else nullif(btrim(p_job_title), '')
    end,
    phone = case when p_phone is null then contact.phone else nullif(btrim(p_phone), '') end,
    email = case when p_email is null then contact.email else nullif(btrim(p_email), '') end,
    is_primary = make_primary,
    usage_scene = case
      when p_usage_scene is null then contact.usage_scene
      else nullif(btrim(p_usage_scene), '')
    end,
    version = contact.version + 1,
    updated_at = now(),
    updated_by = actor_id
  where contact.id = p_contact_id
    and contact.customer_id = p_customer_id;

  perform ops.write_audit(
    'customer.contact_changed',
    'customer_contact',
    p_contact_id,
    p_reason,
    jsonb_build_object(
      'customerId', p_customer_id,
      'name', target.name,
      'isPrimary', target.is_primary
    ),
    jsonb_build_object(
      'customerId', p_customer_id,
      'name', case when p_name is null then target.name else btrim(p_name) end,
      'isPrimary', make_primary
    ),
    p_request_id
  );

  return jsonb_build_object(
    'status', 'ok',
    'contact', ops.customer_contact_json(p_contact_id, sensitive)
  );
end;
$$;


-- ── DELETE /customers/{customerId}/contacts/{contactId} ─────────────────────
-- `p_reason` 可以为 NULL：当前 HTTP 端点没有理由入口（契约 §5.2 的 DELETE 行
-- 没有请求字段）。把它设成必填会让每次删除都 500，而那不是安全问题，是形状不符。
CREATE OR REPLACE FUNCTION ops.delete_customer_contact (
  p_customer_id uuid,
  p_contact_id uuid,
  p_reason text DEFAULT NULL,
  p_request_id text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  target ops.customers;
  target_contact ops.customer_contacts;
  contact_total integer;
  remaining integer;
begin
  perform ops.require_permission('customer.write');

  select * into target
  from ops.customers as customer
  where customer.id = p_customer_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select * into target_contact
  from ops.customer_contacts as contact
  where contact.id = p_contact_id
    and contact.customer_id = p_customer_id;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select count(*) into contact_total
  from ops.customer_contacts as contact
  where contact.customer_id = p_customer_id;

  -- 「最后一条联系人」对非终态客户是拒绝：客户会失去唯一联系方式。
  -- `terminated` 不再需要联系方式，所以终态下允许删到 0。
  if contact_total <= 1 and target.status <> 'terminated' then
    return jsonb_build_object('status', 'last_primary');
  end if;

  delete from ops.customer_contacts as contact
  where contact.id = p_contact_id
    and contact.customer_id = p_customer_id;

  get diagnostics remaining = row_count;

  perform ops.write_audit(
    'customer.contact_changed',
    'customer_contact',
    p_contact_id,
    p_reason,
    jsonb_build_object(
      'customerId', p_customer_id,
      'name', target_contact.name,
      'isPrimary', target_contact.is_primary,
      'contactCount', contact_total
    ),
    jsonb_build_object(
      'customerId', p_customer_id,
      'deleted', remaining > 0,
      'contactCount', contact_total - remaining
    ),
    p_request_id
  );

  return jsonb_build_object('status', 'ok', 'deleted_contact_id', p_contact_id);
end;
$$;


-- ── 授权 ────────────────────────────────────────────────────────────────────
-- 两张表对 authenticated 连 SELECT 都没有：读也走 RPC（见文件头第 1 条）。
-- anon 本来就没有 schema USAGE，这里再撤一次表级权限是防「以后有人补授 USAGE」。
REVOKE ALL ON TABLE ops.customers,
ops.customer_contacts
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON SEQUENCE ops.customer_no_seq
FROM
  public,
  anon,
  authenticated;


ALTER TABLE ops.customers enable ROW level security;


ALTER TABLE ops.customer_contacts enable ROW level security;


-- 形状函数与计数函数没有权限判定，必须对所有非属主角色关闭：
-- 漏关一个，任何登录用户都能 `rpc/customer_contact_json` 拿到联系人原值。
REVOKE ALL ON function ops.customer_json (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.customer_contact_json (uuid, boolean)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.customer_list_json (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.customer_duplicate_matches (text, text)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.customer_reference_counts (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.mask_phone (text)
FROM
  public,
  anon;


REVOKE ALL ON function ops.mask_email (text)
FROM
  public,
  anon;


REVOKE ALL ON function ops.list_customers (
  text,
  TEXT[],
  uuid,
  text,
  integer,
  text,
  text,
  integer,
  integer
)
FROM
  public,
  anon;


REVOKE ALL ON function ops.create_customer (
  text,
  text,
  text,
  text,
  text,
  uuid,
  jsonb,
  text,
  text
)
FROM
  public,
  anon;


REVOKE ALL ON function ops.check_customer_duplicates (text, text)
FROM
  public,
  anon;


REVOKE ALL ON function ops.get_customer (uuid)
FROM
  public,
  anon;


REVOKE ALL ON function ops.update_customer (
  uuid,
  integer,
  text,
  text,
  text,
  text,
  text,
  text,
  text
)
FROM
  public,
  anon;


REVOKE ALL ON function ops.transition_customer (uuid, text, text, integer, text)
FROM
  public,
  anon;


REVOKE ALL ON function ops.customer_overview (uuid)
FROM
  public,
  anon;


REVOKE ALL ON function ops.list_customer_contacts (uuid)
FROM
  public,
  anon;


REVOKE ALL ON function ops.create_customer_contact (
  uuid,
  text,
  text,
  text,
  text,
  boolean,
  text,
  text,
  text
)
FROM
  public,
  anon;


REVOKE ALL ON function ops.update_customer_contact (
  uuid,
  uuid,
  integer,
  text,
  text,
  text,
  text,
  boolean,
  text,
  text,
  text
)
FROM
  public,
  anon;


REVOKE ALL ON function ops.delete_customer_contact (uuid, uuid, text, text)
FROM
  public,
  anon;


GRANT
EXECUTE ON function ops.mask_phone (text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.mask_email (text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.list_customers (
  text,
  TEXT[],
  uuid,
  text,
  integer,
  text,
  text,
  integer,
  integer
) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.create_customer (
  text,
  text,
  text,
  text,
  text,
  uuid,
  jsonb,
  text,
  text
) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.check_customer_duplicates (text, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.get_customer (uuid) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.update_customer (
  uuid,
  integer,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.transition_customer (uuid, text, text, integer, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.customer_overview (uuid) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.list_customer_contacts (uuid) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.create_customer_contact (
  uuid,
  text,
  text,
  text,
  text,
  boolean,
  text,
  text,
  text
) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.update_customer_contact (
  uuid,
  uuid,
  integer,
  text,
  text,
  text,
  text,
  boolean,
  text,
  text,
  text
) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.delete_customer_contact (uuid, uuid, text, text) TO authenticated,
service_role;


COMMENT ON TABLE ops.customers IS '运营客户（签约旅行社）。编号唯一、名称/信用代码只用于重复提示；状态只能经 ops.transition_customer 迁移（契约 §3.1）。archived_* 三列本轮无写入路径，等归档端点落地。';


COMMENT ON TABLE ops.customer_contacts IS '客户联系人。每客户至多一个 is_primary（部分唯一索引）；电话/邮箱原值只在调用方具备 customer.sensitive.read 时出现在 RPC 回包里。';


COMMENT ON SEQUENCE ops.customer_no_seq IS '客户编号序列，格式 CUS- + 6 位零填充。允许空洞；唯一约束只作兜底。';


COMMENT ON FUNCTION ops.mask_phone (text) IS '电话掩码：保留前 3 后 4，长度 < 7 整串按原长度打码。NULL 进 NULL 出。';


COMMENT ON FUNCTION ops.mask_email (text) IS '邮箱掩码：保留首字符与域名（a***@example.com）。NULL 进 NULL 出。';


COMMENT ON FUNCTION ops.customer_reference_counts (uuid) IS '客户引用计数（合同/授权/工单/部署）。四张域表未落地时用 to_regclass 跳过并返回 0；表落地后把分支换成真实表名。active_contract_count 同口径。';


COMMENT ON FUNCTION ops.transition_customer (uuid, text, text, integer, text) IS '客户状态机（契约 §3.1）。五条边；start_onboarding 需至少一条联系人，terminate 在引用计数 > 0 时返回 referenced。业务失败走信封，不 RAISE。';