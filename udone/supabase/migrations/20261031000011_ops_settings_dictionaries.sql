-- 设置页：三个参数项的读写（契约 §5.9 的 `GET/PATCH /settings`）+ 字典配置
-- （`GET /dictionaries`、`POST /dictionaries/{code}/items`、
-- `PATCH /dictionary-items/{itemId}`）。
--
-- 这两组东西放在一个迁移里，不是因为它们相似，而是因为它们**共用同一个权限**
-- （`settings.manage`）：设置页一次加载就同时要这两块，分成两个迁移会出现
-- 「参数能读、字典 500」的中间态，而那个中间态正好是设置页打不开的样子。
--
-- 四件必须写下来的判断：
--
-- 1. **参数表是「三行」而不是「一行三列」。** `ops.settings` 在 o-t07 就落地了
--    （key 白名单 + 值域 CHECK），端点这一轮才补。为什么不是一行三列：加第四个
--    参数时，三列的表要改表结构，三行的表只要插一行。这是**为了扩展而选的形状**，
--    代价是「读三个值」要么三次查询、要么一次聚合成对象——这里选后者，聚合成
--    对象的地方只有一处（`ops.ops_settings_json`），读与写都从它取。
--
-- 2. **`updatedBy` / `updatedAt` 取「最近一次改动」，不是「三个值各自的时间」。**
--    契约给的是单数（§5.9 与 U-20），而库里有三行。三行各有时间戳的话，前端
--    要么显示三个「谁改的」，要么自己挑一个——两种都会让人问「为什么这里是这个
--    人」。取 max(updated_at) 那一行，语义是「这张设置页最后一次被谁动过」。
--
-- 3. **越界回 400 而不是被表约束打成 422/500。** 表上的 CHECK 是最后一道闸，
--    但它报出来的是 `settings_value_check` 这种名字，前端没法定位到具体字段。
--    函数里先按字段判一次范围，返回 `{status:'out_of_range',field,min,max}`，
--    路由翻成 400 + `details.field`。**表约束仍然保留**：将来有迁移直接写这张表
--    时，它是唯一管得住的地方。
--
-- 4. **字典的条目值不带 CHECK 白名单，与「字典是可配置的」是同一件事。** 如果
--    把 `payment_methods` 的取值写进 CHECK，那它就不是字典、而是枚举——运营
--    改一个字要发版。字典的权威在表里，前端下拉从 `GET /dictionaries` 取。
--    代价是 `ops.tickets.issue_type` 这类消费方**不会**被库层拦住（它只要求
--    非空字符串）：字典给的是可选值来源，不是唯一真相。收严会连带影响已有
--    工单的下拉回显，属于跨域改动，不在本域的单子里。
-- ── 1. 参数项：读与写共用一个组装器 ─────────────────────────────────────────
-- 不做权限判定：调用方（两个 RPC）都已判过。放在这里是为了让「参数对象长什么样」
-- 只有一处定义——读与写各拼一次的话，`PATCH` 的响应迟早会少一个键，而前端正好
-- 拿它回填表单。
CREATE OR REPLACE FUNCTION ops.ops_settings_json () returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  latest_key text;
  latest_updated_at timestamptz;
  latest_updated_by uuid;
begin
  -- 缺行回落到契约给的默认值。种子行被谁删掉时，设置页应当显示 30/48/90，
  -- 而不是整页报错——「读不到配置」和「配置是默认值」对使用者是同一件事。
  select setting.key, setting.updated_at, setting.updated_by
  into latest_key, latest_updated_at, latest_updated_by
  from ops.settings as setting
  order by setting.updated_at desc, setting.key
  limit 1;

  return jsonb_build_object(
    'settings', jsonb_build_object(
      'overview_expiry_window_days', ops.setting_int('overview.expiryWindowDays', 30),
      'ticket_due_hours', ops.setting_int('ticket.dueHours', 48),
      'export_retention_days', ops.setting_int('retention.exportDays', 90)
    ),
    'updated_by', ops.operator_ref(latest_updated_by),
    -- 一行都没有时（种子被清空）这里是 null：前端显示「从未修改」比显示
    -- 一个假的当前时间诚实。
    'updated_at', latest_updated_at
  );
end;
$$;


CREATE OR REPLACE FUNCTION ops.get_ops_settings () returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
begin
  perform ops.require_permission('settings.manage');

  return jsonb_build_object('status', 'ok') || ops.ops_settings_json();
end;
$$;


/*
 * `p_patch` 的键是 **camelCase**（与请求体同名），不是列名：这一层是「把请求
 * 原样带下去」，翻译成列名是函数内部的事。键在不在 patch 里决定「改不改」，
 * 而不是值是不是 null——三个参数项都是非空整数，null 只能是错的输入。
 */
CREATE OR REPLACE FUNCTION ops.update_ops_settings (p_patch jsonb, p_request_id text DEFAULT NULL) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  operator_id uuid := ops.current_operator_id();
  before_json jsonb;
  after_json jsonb;
  expected_before jsonb := '{}'::jsonb;
  expected_after jsonb := '{}'::jsonb;
  setting_key text;
  new_value integer;
  upper_bound integer;
begin
  perform ops.require_permission('settings.manage');

  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    -- 空补丁不写、不审计。`PATCH {}` 是一次「什么都没说」的请求，把它记成一次
    -- 修改会让审计里出现一堆没有 before/after 差异的事件。
    return jsonb_build_object('status', 'empty_patch');
  end if;

  before_json := ops.ops_settings_json() #> '{settings}';

  -- 有不认识的键就整体拒绝，不做「认识的改、不认识的忽略」：设置页传错字段名时
  -- 静默成功，运营会以为改过了。
  if exists (
    select 1
    from jsonb_object_keys(p_patch) as entry (key)
    where entry.key not in (
      'overviewExpiryWindowDays', 'ticketDueHours', 'exportRetentionDays'
    )
  ) then
    return jsonb_build_object(
      'status', 'unknown_key',
      'key', (
        select entry.key
        from jsonb_object_keys(p_patch) as entry (key)
        where entry.key not in (
          'overviewExpiryWindowDays', 'ticketDueHours', 'exportRetentionDays'
        )
        limit 1
      )
    );
  end if;

  for setting_key in
    select entry.key from jsonb_object_keys(p_patch) as entry (key)
  loop
    -- 类型先判：非 number 时直接转发成整数会抛错（500），而这是用户输入。
    -- `'30.5'` 也算非法：`::integer` 会把它四舍五入成 31，半天的导出保留期
    -- 没有意义，静默取整是最坏的一种「成功」。
    if jsonb_typeof(p_patch -> setting_key) <> 'number'
      or (p_patch ->> setting_key) !~ '^[0-9]+$' then
      return jsonb_build_object(
        'status', 'invalid_value',
        'field', setting_key,
        'value', p_patch -> setting_key
      );
    end if;

    upper_bound := case setting_key when 'ticketDueHours' then 720 else 365 end;
    new_value := (p_patch ->> setting_key)::integer;

    if new_value < 1 or new_value > upper_bound then
      return jsonb_build_object(
        'status', 'out_of_range',
        'field', setting_key,
        'value', new_value,
        'min', 1,
        'max', upper_bound
      );
    end if;

    expected_before := expected_before || jsonb_build_object(
      setting_key,
      (before_json ->> case setting_key
        when 'overviewExpiryWindowDays' then 'overview_expiry_window_days'
        when 'ticketDueHours' then 'ticket_due_hours'
        else 'export_retention_days'
      end)::integer
    );

    update ops.settings
    set
      value = to_jsonb(new_value),
      updated_by = operator_id,
      updated_at = now()
    where key = case setting_key
      when 'overviewExpiryWindowDays' then 'overview.expiryWindowDays'
      when 'ticketDueHours' then 'ticket.dueHours'
      else 'retention.exportDays'
    end;

    expected_after := expected_after || jsonb_build_object(setting_key, new_value);
  end loop;

  perform ops.write_audit(
    'settings.updated',
    'settings',
    NULL,
    NULL,
    expected_before,
    expected_after,
    p_request_id
  );

  return jsonb_build_object('status', 'ok') || ops.ops_settings_json();
end;
$$;


-- ── 2. 字典：两张表 ────────────────────────────────────────────────────────
-- `code` 限成小写下划线：字典码会出现在 URL 路径里（`/dictionaries/{code}/items`），
-- 带大写或空格时前端要做转义，而转义做错的表现是 404——排查成本远高于限制成本。
CREATE TABLE ops.dictionaries (
  code text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  description text,
  -- 系统内置：种子行。当前没有删除字典的端点，这一列是给「将来能删」留的判据，
  -- 也是给前端决定「这一组能不能整体改」用的。默认 false 是安全侧：新加的字典
  -- 一定是运营自己建的。
  is_system boolean NOT NULL DEFAULT FALSE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);


CREATE TABLE ops.dictionary_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 级联用 RESTRICT 而不是 CASCADE：删字典连带删条目，会让「这个值以前是什么
  -- 意思」永久丢失——而工单、收款里存的是 `value` 字符串，历史行还指着它。
  dictionary_code text NOT NULL REFERENCES ops.dictionaries (code) ON DELETE RESTRICT,
  -- `value` 落库、`label` 给人看。二者分开的意义就是运营可以改文案而不动数据：
  -- 把 `wechat_pay` 改成「微信支付」不该让历史收款变成另一笔。
  value text NOT NULL CHECK (length(btrim(value)) > 0),
  label text NOT NULL CHECK (length(btrim(label)) > 0),
  sort_order integer NOT NULL DEFAULT 0,
  -- 停用而不是删除：删掉之后历史行回显成裸 value，停用还能查到 label。
  is_active boolean NOT NULL DEFAULT TRUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dictionary_items_code_value_key UNIQUE (dictionary_code, value)
);


CREATE INDEX dictionary_items_dictionary_idx ON ops.dictionary_items (dictionary_code, sort_order, value);


-- 两组系统字典。**码值是实现选的，契约只给了表结构没给码表**，所以这里同时
-- 说明理由并上协作项：`payment_methods` 对应 PRD §6.5「内部配置的收款方式」，
-- `ticket_issue_types` 对应 §6.9「问题类型配置可扩展」。种子里的 `value` 用
-- 英文小写下划线（与 `code` 同风格），`label` 给中文——运营改文案时改 label，
-- 已落库的 value 不动。
INSERT INTO
  ops.dictionaries (code, name, description, is_system)
VALUES
  (
    'payment_methods',
    '收款方式',
    '收款登记时的方式选项（PRD §6.5）',
    TRUE
  ),
  (
    'ticket_issue_types',
    '问题类型',
    '工单的问题类型选项（PRD §6.9）',
    TRUE
  );


INSERT INTO
  ops.dictionary_items (dictionary_code, value, label, sort_order)
VALUES
  ('payment_methods', 'bank_transfer', '银行转账', 10),
  ('payment_methods', 'alipay', '支付宝', 20),
  ('payment_methods', 'wechat_pay', '微信支付', 30),
  ('payment_methods', 'cheque', '支票', 40),
  ('payment_methods', 'other', '其他', 90),
  ('ticket_issue_types', 'usage', '使用问题', 10),
  ('ticket_issue_types', 'defect', '功能缺陷', 20),
  ('ticket_issue_types', 'billing', '账单问题', 30),
  ('ticket_issue_types', 'sync', '同步异常', 40),
  ('ticket_issue_types', 'other', '其他', 90);


-- ── 3. 字典的读与写 ────────────────────────────────────────────────────────
-- 条目按 `sort_order, label` 排：运营调顺序的方式就是改 sort_order，同序时按
-- 文案排——比按 uuid 排好，因为「同序」在刚建的两条上很常见。
CREATE OR REPLACE FUNCTION ops.dictionary_item_json (p_item ops.dictionary_items) returns jsonb language sql immutable
SET
  search_path = '' AS $$
  select jsonb_build_object(
    'id', p_item.id,
    'value', p_item.value,
    'label', p_item.label,
    'sort_order', p_item.sort_order,
    'is_active', p_item.is_active
  );
$$;


/*
 * `p_code` 为空时返回全部字典。
 *
 * 这里刻意**不**按权限分档：契约 §5.9 写的是「任意已认证运营成员」，因为
 * 字典是纯选项文案，客户名、金额都不在里面。让创建工单的人先有 `settings.manage`
 * 才能取到问题类型，等于把这个页面锁给了管理员。
 */
CREATE OR REPLACE FUNCTION ops.list_dictionaries (p_code text DEFAULT NULL) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  filter_code text := nullif(btrim(coalesce(p_code, '')), '');
  items_json jsonb;
begin
  if ops.current_operator_id() is null then
    -- 不是运营成员：契约给的是 401/403，这里回 403 的语义（调用方路由翻成 401
    -- 与 403 的分界由中间件判定，函数只保证「没身份读不到」）。
    return jsonb_build_object('status', 'forbidden');
  end if;

  -- 字典本身的 `is_active` 不存在：整组字典没有启停的概念，启停落在条目上。
  -- 少了这一层，「这组还要不要」就只能靠删表，而删表会带走历史回显。
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'code', dictionary.code,
        'name', dictionary.name,
        'items', coalesce(
          (
            select jsonb_agg(
              ops.dictionary_item_json(item)
              order by item.sort_order, item.label, item.value
            )
            from ops.dictionary_items as item
            where item.dictionary_code = dictionary.code
          ),
          '[]'::jsonb
        )
      )
      order by dictionary.name, dictionary.code
    ),
    '[]'::jsonb
  )
  into items_json
  from ops.dictionaries as dictionary
  where filter_code is null or dictionary.code = filter_code;

  return jsonb_build_object('status', 'ok', 'items', items_json);
end;
$$;


CREATE OR REPLACE FUNCTION ops.create_dictionary_item (
  p_code text,
  p_value text,
  p_label text,
  p_sort_order integer DEFAULT NULL,
  p_request_id text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  effective_code text := nullif(btrim(coalesce(p_code, '')), '');
  effective_value text := nullif(btrim(coalesce(p_value, '')), '');
  effective_label text := nullif(btrim(coalesce(p_label, '')), '');
  new_item ops.dictionary_items;
  existing_id uuid;
  next_sort integer;
begin
  perform ops.require_permission('settings.manage');

  if effective_code is null or not exists (
    select 1 from ops.dictionaries as dictionary where dictionary.code = effective_code
  ) then
    -- 不认识的字典码回 404 语义而不是建一组新字典：建字典没有端点，所以
    -- 「码不存在」一定是调用方拼错了，不是「还没建」。
    return jsonb_build_object('status', 'dictionary_not_found', 'code', p_code);
  end if;

  if effective_value is null then
    return jsonb_build_object('status', 'value_required');
  end if;

  if effective_label is null then
    return jsonb_build_object('status', 'label_required');
  end if;

  select item.id into existing_id
  from ops.dictionary_items as item
  where item.dictionary_code = effective_code
    and item.value = effective_value;

  if existing_id is not null then
    -- 409：同一组里 `value` 重复不是「再建一条」，是调用方以为它不存在。
    -- 带上已有条目的 id，前端可以直接跳过去编辑。
    return jsonb_build_object(
      'status', 'duplicate_value',
      'value', effective_value,
      'item_id', existing_id
    );
  end if;

  -- `sortOrder` 不传时排到本组末尾（当前最大 + 10），而不是排到最前面：
  -- 新建的往往是补充项，排第一会把运营精心排过的顺序打乱。
  if p_sort_order is null then
    select coalesce(max(item.sort_order), 0) + 10 into next_sort
    from ops.dictionary_items as item
    where item.dictionary_code = effective_code;
  else
    next_sort := p_sort_order;
  end if;

  insert into ops.dictionary_items (dictionary_code, value, label, sort_order)
  values (effective_code, effective_value, effective_label, next_sort)
  returning * into new_item;

  perform ops.write_audit(
    'dictionary.item_created',
    'dictionary_item',
    new_item.id,
    NULL,
    NULL,
    jsonb_build_object(
      'dictionaryCode', new_item.dictionary_code,
      'value', new_item.value,
      'label', new_item.label,
      'sortOrder', new_item.sort_order
    ),
    p_request_id
  );

  return jsonb_build_object('status', 'ok', 'item', ops.dictionary_item_json(new_item));
end;
$$;


/*
 * PATCH 的补丁里只放「真的传了」的键。三个字段都允许改成 null 吗？不允许：
 * `label` 是文案、删不得；`sortOrder` 与 `isActive` 是标量，null 无意义。
 * 所以这里用「键在不在」而不是「值是不是 null」来判，把 `{"label": null}`
 * 当成非法输入（而不是静默忽略）——设置页清空输入框就该被拦住。
 */
CREATE OR REPLACE FUNCTION ops.update_dictionary_item (
  p_item_id uuid,
  p_patch jsonb,
  p_request_id text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  target ops.dictionary_items;
  before_json jsonb;
  after_json jsonb;
  next_label text;
  next_sort integer;
  next_active boolean;
begin
  perform ops.require_permission('settings.manage');

  select * into target from ops.dictionary_items as item where item.id = p_item_id;

  if target.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    return jsonb_build_object('status', 'empty_patch');
  end if;

  if p_patch ? 'label' then
    next_label := nullif(btrim(coalesce(p_patch ->> 'label', '')), '');

    if next_label is null then
      return jsonb_build_object('status', 'label_required');
    end if;
  end if;

  if p_patch ? 'sortOrder' then
    if jsonb_typeof(p_patch -> 'sortOrder') <> 'number'
      or (p_patch ->> 'sortOrder') !~ '^-?[0-9]+$' then
      return jsonb_build_object(
        'status', 'invalid_value',
        'field', 'sortOrder',
        'value', p_patch -> 'sortOrder'
      );
    end if;

    next_sort := (p_patch ->> 'sortOrder')::integer;
  end if;

  if p_patch ? 'isActive' then
    if jsonb_typeof(p_patch -> 'isActive') <> 'boolean' then
      return jsonb_build_object(
        'status', 'invalid_value',
        'field', 'isActive',
        'value', p_patch -> 'isActive'
      );
    end if;

    next_active := (p_patch ->> 'isActive')::boolean;
  end if;

  before_json := ops.dictionary_item_json(target);

  update ops.dictionary_items
  set
    label = coalesce(next_label, label),
    sort_order = coalesce(next_sort, sort_order),
    is_active = coalesce(next_active, is_active),
    updated_at = now()
  where id = p_item_id
  returning * into target;

  after_json := ops.dictionary_item_json(target);

  -- 改文案与改启停记同一个动作码：审计查的是「谁动了这个条目」。把两者拆成
  -- 两个码会让「这个条目被谁改过」需要查两个动作，而那才是这条审计的真实问题。
  perform ops.write_audit(
    'dictionary.item_updated',
    'dictionary_item',
    p_item_id,
    NULL,
    before_json,
    after_json,
    p_request_id
  );

  return jsonb_build_object('status', 'ok', 'item', after_json);
end;
$$;


-- ── 4. 授权 ────────────────────────────────────────────────────────────────
-- 两张表零直写权限：契约 §7.3 把字典归在 A1（直写 + RLS），业务端全线走 RPC
-- （其余 A1 表也一样），这里保持同一种形态——同一个 schema 里两种写路径会让
-- 「谁能写字典」变成要查两处的问题。已上协作项请契约侧确认或修订矩阵。
REVOKE ALL ON TABLE ops.dictionaries
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON TABLE ops.dictionary_items
FROM
  public,
  anon,
  authenticated;


ALTER TABLE ops.dictionaries enable ROW level security;


ALTER TABLE ops.dictionary_items enable ROW level security;


REVOKE ALL ON function ops.ops_settings_json ()
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.dictionary_item_json (ops.dictionary_items)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.get_ops_settings ()
FROM
  public,
  anon;


REVOKE ALL ON function ops.update_ops_settings (jsonb, text)
FROM
  public,
  anon;


REVOKE ALL ON function ops.list_dictionaries (text)
FROM
  public,
  anon;


REVOKE ALL ON function ops.create_dictionary_item (text, text, text, integer, text)
FROM
  public,
  anon;


REVOKE ALL ON function ops.update_dictionary_item (uuid, jsonb, text)
FROM
  public,
  anon;


GRANT
EXECUTE ON function ops.get_ops_settings () TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.update_ops_settings (jsonb, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.list_dictionaries (text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.create_dictionary_item (text, text, text, integer, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.update_dictionary_item (uuid, jsonb, text) TO authenticated,
service_role;


COMMENT ON FUNCTION ops.get_ops_settings () IS '设置页读取（契约 §5.9）。三个参数项聚成一个对象；updatedBy/updatedAt 取最近一次改动，不是三行各自的时间。';


COMMENT ON FUNCTION ops.update_ops_settings (jsonb, text) IS '设置页写入。越界在函数里判并回 {status:out_of_range,field,min,max}，表上的 CHECK 仍保留作为直写迁移的最后一道闸。空补丁不写不审计。';


COMMENT ON FUNCTION ops.list_dictionaries (text) IS '字典列表（契约 §5.9）。任意已认证运营成员可读：字典里只有选项文案。';


COMMENT ON FUNCTION ops.create_dictionary_item (text, text, text, integer, text) IS '新增字典条目。同组 value 重复回 duplicate_value 并带已有条目 id（409）。sortOrder 缺省排到本组末尾。';


COMMENT ON FUNCTION ops.update_dictionary_item (uuid, jsonb, text) IS '改条目文案 / 排序 / 启停。三个字段都不接受 null，清空输入框要被拦住而不是静默忽略。';


COMMENT ON TABLE ops.dictionaries IS '字典分组（契约 §3.9）。码值白名单不在库里，运营改文案只动 label。';


COMMENT ON TABLE ops.dictionary_items IS '字典条目。value 落库、label 给人看；停用而不是删除，否则历史行回显成裸 value。';