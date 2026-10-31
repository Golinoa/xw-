-- 跨域拒绝对照表：契约 §7.4 的 P1–P13，一行一节。
--
-- 为什么要有这么一个文件，而不是把 13 条摊在各域自己的测试里：
-- 各域的 `ops_*_domain.sql` 里也有 P1–P4 编号，但那是**域内**的编号（本域没权限
-- 能不能读本域数据），逐域改名或增删都不影响别处。§7.4 这张表不一样——它是
-- **跨域**的：P9 讲的是运营身份读不到租户业务表、P10 讲的是不借用租户上下文、
-- P7/P8 讲的是审计与核销两张表不可改删。这些问题没有哪个域愿意认领，因为它们
-- 测的不是「这个域对不对」而是「两套身份体系有没有串线」。没有专人认领的断言，
-- 迟早会在某次重构里被顺手删掉，而且删掉之后没有任何一个测试会红。
--
-- 所以这里按契约表格逐行建节，节号就是行号。**读这张表的人和读契约的人看到的是
-- 同一个顺序**，改一处就能对上另一处。域内测试可以被重写，这个文件不行。
--
-- ## 与契约表格的偏差：三处括注写的机制在本实现里不存在
--
-- §7.4 的「期望」列写的是结果，括注写的是机制。结果全部成立，但三条括注
-- 描述的是另一套设计（列级授权 + `WITH CHECK` + UPDATE 列白名单）：
--
--   P3  「有列级 INSERT 授权但 WITH CHECK 为 false」
--   P5  「无 receivable.read → select ops.receipts 0 行」
--   P13 「status 不在 UPDATE 列白名单」
--
-- 本实现全域没有一条列级授权（`grep 'GRANT .*UPDATE ('` 零命中）。ops 业务表
-- 对 authenticated 是**表级零授权**：读也走 `SECURITY DEFINER` RPC。所以默认
-- 状态下这三条的实际形状是 42501，而不是 0 行或策略违例。
--
-- 两种形状都记在下面：先用一条断言钉住默认态（42501），再**临时补授**一次
-- 相应权限去证明第二层（RLS 开着、零策略 = 默认拒绝）真的在挡。临时授权只活
-- 在本事务里，跑完即回滚。这么写不是为了迁就契约，而是因为「零授权」和
-- 「有授权但策略拒绝」是两道独立的门，只测第一道的话，第二道哪天被人删了
-- （比如有人为了排查问题 `ALTER TABLE ... DISABLE ROW LEVEL SECURITY`）
-- 也不会有任何断言变红。
--
-- P6 / P11 / P12 是 API 层的，写在这里会被 RLS 测成假绿（DROP 到 SQL 层就
-- 看不到 DTO 与中间件）。它们的断言在 `tests/integration/ops-denials.test.ts`。
BEGIN;


SELECT
  plan (33);


-- ── 夹具 ────────────────────────────────────────────────────────────────────
-- 六个 auth 用户：五个运营账号（active ×3 / invited ×1 / disabled ×1），
-- 第六个只有租户身份。角色分配是刻意的——
--   admin    → platform_admin（39 个动作码，全绿的那一侧，用来当对照）
--   support  → support_agent（**没有** receivable.read，P5 要的人）
--   viewer   → ops_viewer（有 audit.read，用来证明 P4 的 0 行不是「他本来就没权限」）
--   invited / disabled → 用来证明「账号状态」与「权限码」是两个独立维度
INSERT INTO
  auth.users (id, aud, role, email)
VALUES
  (
    '00000000-0000-4000-8000-000000000c01',
    'authenticated',
    'authenticated',
    'denial-admin@example.test'
  ),
  (
    '00000000-0000-4000-8000-000000000c02',
    'authenticated',
    'authenticated',
    'denial-support@example.test'
  ),
  (
    '00000000-0000-4000-8000-000000000c03',
    'authenticated',
    'authenticated',
    'denial-viewer@example.test'
  ),
  (
    '00000000-0000-4000-8000-000000000c04',
    'authenticated',
    'authenticated',
    'denial-invited@example.test'
  ),
  (
    '00000000-0000-4000-8000-000000000c05',
    'authenticated',
    'authenticated',
    'denial-disabled@example.test'
  ),
  (
    '00000000-0000-4000-8000-000000000c06',
    'authenticated',
    'authenticated',
    'denial-tenant@example.test'
  );


INSERT INTO
  ops.operators (id, user_id, email, display_name, status)
VALUES
  (
    '00000000-0000-4000-8000-000000000d01',
    '00000000-0000-4000-8000-000000000c01',
    'denial-admin@example.test',
    '对照管理员',
    'active'
  ),
  (
    '00000000-0000-4000-8000-000000000d02',
    '00000000-0000-4000-8000-000000000c02',
    'denial-support@example.test',
    '售后（无账款读权限）',
    'active'
  ),
  (
    '00000000-0000-4000-8000-000000000d03',
    '00000000-0000-4000-8000-000000000c03',
    'denial-viewer@example.test',
    '只读审计',
    'active'
  ),
  (
    '00000000-0000-4000-8000-000000000d04',
    '00000000-0000-4000-8000-000000000c04',
    'denial-invited@example.test',
    '待激活',
    'invited'
  ),
  (
    '00000000-0000-4000-8000-000000000d05',
    '00000000-0000-4000-8000-000000000c05',
    'denial-disabled@example.test',
    '已停用',
    'disabled'
  );


INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
SELECT
  seed.operator_id,
  role.id,
  '00000000-0000-4000-8000-000000000d01'
FROM
  (
    VALUES
      (
        '00000000-0000-4000-8000-000000000d01'::uuid,
        'platform_admin'
      ),
      (
        '00000000-0000-4000-8000-000000000d02'::uuid,
        'support_agent'
      ),
      (
        '00000000-0000-4000-8000-000000000d03'::uuid,
        'ops_viewer'
      ),
      (
        '00000000-0000-4000-8000-000000000d04'::uuid,
        'sales_ops'
      ),
      (
        '00000000-0000-4000-8000-000000000d05'::uuid,
        'finance_ops'
      )
  ) AS seed (operator_id, role_code)
  JOIN ops.roles AS role ON role.code = seed.role_code;


-- 审计行：没有它，P4 的「0 行」在空表上恒真，而恒真的绿是最贵的那种假证据。
-- 注意这条是**以属主身份**插的，与「谁能读到它」是两件事。
INSERT INTO
  ops.audit_events (
    id,
    actor_operator_id,
    actor_user_id,
    action,
    entity_type,
    reason
  )
VALUES
  (
    '00000000-0000-4000-8000-000000000e01',
    '00000000-0000-4000-8000-000000000d01',
    '00000000-0000-4000-8000-000000000c01',
    'fixture.seed',
    'operator',
    '夹具'
  );


-- 租户侧的完整一套：一个组织、一个成员、一个客户、一张订单、一条订单应收。
-- P9 的断言是「运营身份读 public 表 0 行」——**如果这五张表是空的，0 行就与
-- 权限无关**，任何实现都会绿。所以必须先有行，再证明只有租户成员看得见。
INSERT INTO
  public.organizations (id, name, created_by)
VALUES
  (
    '00000000-0000-4000-8000-000000000f01',
    '跨域拒绝对照组织',
    '00000000-0000-4000-8000-000000000c06'
  );


INSERT INTO
  public.organization_members (organization_id, user_id, role)
VALUES
  (
    '00000000-0000-4000-8000-000000000f01',
    '00000000-0000-4000-8000-000000000c06',
    'admin'
  );


INSERT INTO
  public.customers (id, organization_id, name, phone, created_by)
VALUES
  (
    '00000000-0000-4000-8000-000000000f02',
    '00000000-0000-4000-8000-000000000f01',
    '租户侧客户',
    '13900000009',
    '00000000-0000-4000-8000-000000000c06'
  );


INSERT INTO
  public.orders (
    id,
    organization_id,
    order_number,
    order_type,
    status,
    customer_id,
    created_by
  )
VALUES
  (
    '00000000-0000-4000-8000-000000000f03',
    '00000000-0000-4000-8000-000000000f01',
    'SO-20261031-000001',
    'active',
    'active',
    '00000000-0000-4000-8000-000000000f02',
    '00000000-0000-4000-8000-000000000c06'
  );


INSERT INTO
  public.order_receivables (id, organization_id, order_id, name, amount)
VALUES
  (
    '00000000-0000-4000-8000-000000000f04',
    '00000000-0000-4000-8000-000000000f01',
    '00000000-0000-4000-8000-000000000f03',
    '定金',
    1000
  );


-- ══ §0 A2 形态：表级授权面 ══════════════════════════════════════════════════
-- 两条断言扫全集而不是点名。点名的话，下一个域新增的表默认就是「没人检查」，
-- 而漏检的表恰好是最可能带着授权进门的那个。
SELECT
  ok (
    NOT EXISTS (
      SELECT
        1
      FROM
        pg_class AS c
        JOIN pg_namespace AS n ON n.oid = c.relnamespace
      WHERE
        n.nspname = 'ops'
        AND c.relkind = 'r'
        AND c.relname NOT IN (
          'operators',
          'roles',
          'permissions',
          'role_permissions',
          'operator_roles',
          'audit_events'
        )
        AND (
          has_table_privilege('authenticated', c.oid, 'SELECT')
          OR has_table_privilege('authenticated', c.oid, 'INSERT')
          OR has_table_privilege('authenticated', c.oid, 'UPDATE')
          OR has_table_privilege('authenticated', c.oid, 'DELETE')
        )
    ),
    'A2: no ops business table grants any table privilege to authenticated'
  );


-- 白名单本身也要钉住：上面那条只证明「除六张之外都没有」，不证明「这六张确实有」。
-- 少了这条，把六张身份表的 SELECT 一起撤掉也能让上面变绿——而那样审计页与
-- 账号页会整体 500，属于「测试全绿、页面全崩」的经典形态。
SELECT
  IS (
    (
      SELECT
        array_agg(
          c.relname::text
          ORDER BY
            c.relname
        )
      FROM
        pg_class AS c
        JOIN pg_namespace AS n ON n.oid = c.relnamespace
      WHERE
        n.nspname = 'ops'
        AND c.relkind = 'r'
        AND has_table_privilege('authenticated', c.oid, 'SELECT')
    ),
    ARRAY[
      'audit_events',
      'operator_roles',
      'operators',
      'permissions',
      'role_permissions',
      'roles'
    ],
    'A2: exactly six ops tables are readable by authenticated, and none of them is a business table'
  );


-- 函数的 EXECUTE 面：同样扫全集。这一条写出来的时候是红的——`ops` 下有一个
-- 触发器函数保留了函数默认 ACL（PUBLIC 可执行），已由
-- `20261031000014_ops_trigger_function_revoke.sql` 补掉。
--
-- 它今天不可利用（触发器函数不能直接调用，anon 也没有 schema USAGE），但仍然要
-- 断言「零个」：文档里承诺的不变量是「所有函数都不给 public/anon」，而一个例外
-- 会让下一个人抄一份漏过的 REVOKE 清单。
SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        pg_proc AS p
        JOIN pg_namespace AS n ON n.oid = p.pronamespace
      WHERE
        n.nspname = 'ops'
        AND (
          has_function_privilege('anon', p.oid, 'EXECUTE')
          -- `public` 是伪角色，不能直接喂给 has_function_privilege；展开 ACL 看
          -- grantee = 0（PUBLIC 在 aclitem 里的编号）才是准确的判据。
          OR p.proacl IS NULL
          OR EXISTS (
            SELECT
              1
            FROM
              aclexplode(p.proacl) AS a
            WHERE
              a.grantee = 0
              AND a.privilege_type = 'EXECUTE'
          )
        )
    ),
    0,
    'A2: no ops function is executable by anon or by PUBLIC'
  );


-- ══ P1 anon 无 schema USAGE ══════════════════════════════════════════════════
SELECT
  IS (
    has_schema_privilege('anon', 'ops', 'USAGE'),
    FALSE,
    'P1: anon has no USAGE on the ops schema'
  );


SELECT
  IS (
    has_table_privilege('anon', 'ops.customers', 'SELECT'),
    FALSE,
    'P1: anon holds no SELECT on ops.customers even if USAGE were granted later'
  );


SET
  local role anon;


-- 报错文本必须指向 schema 而不是表：如果哪天有人误授了 USAGE，这条会变成
-- 「对表 ops.customers 的权限被拒绝」，错误码仍是 42501、断言仍会绿——错误的
-- 层仍然报同样的码。所以再断言一次错误文本，让「哪一层在挡」也变成可观测的。
SELECT
  throws_ok (
    $$ select count(*) from ops.customers $$,
    '42501',
    'permission denied for schema ops',
    'P1: anon reading ops.customers is stopped at the schema, not at the table'
  );


RESET ROLE;


-- ══ P2 租户成员（无 ops.operators 行）═══════════════════════════════════════
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000000c06","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    (
      SELECT
        ops.current_operator_id ()
    ),
    NULL,
    'P2: a tenant member resolves to no operator, so every ops policy keyed on it is false'
  );


SELECT
  throws_ok (
    $$ select count(*) from ops.customers $$,
    '42501',
    'permission denied for table customers',
    'P2: a tenant member cannot read ops.customers at all'
  );


RESET ROLE;


-- 补授 SELECT：证明「即使有人把读权限开出去，也没有任何行会漏出来」。
-- 这一步不是为了模拟一个可能发生的误操作，而是因为 RLS 开着、策略为零 ——
-- 第二道门是否真的关着，只有在第一道门被打开时才观测得到。
GRANT
SELECT
  ON ops.customers TO authenticated;


SET
  local role authenticated;


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        ops.customers
    ),
    0,
    'P2: even with SELECT granted, a tenant member reads zero ops.customers rows (RLS is on, policies are absent)'
  );


RESET ROLE;


REVOKE
SELECT
  ON ops.customers
FROM
  authenticated;


-- ══ P3 租户成员不能写 ops.customers ═════════════════════════════════════════
SET
  local role authenticated;


SELECT
  throws_ok (
    $$ insert into ops.customers (name, status) values ('租户伪造', 'signed') $$,
    '42501',
    'permission denied for table customers',
    'P3: a tenant member cannot insert an ops customer'
  );


RESET ROLE;


GRANT INSERT ON ops.customers TO authenticated;


SET
  local role authenticated;


-- 契约括注写的是「列级 INSERT 授权 + WITH CHECK 为 false」。本实现没有列级授权，
-- 但把表级 INSERT 补上之后，零策略的 RLS 会给出同一形状的拒绝：WITH CHECK 无
-- 策略可满足 → 42501。错误文本与「权限不足」不同，这条断言就是为了把两种 42501
-- 区分开——它们的修法完全不同（前者补授权，后者补策略）。
--
-- `customer_no` 显式给值而不是走默认：默认要 `nextval('ops.customer_no_seq')`，
-- 而 authenticated 对序列也是零授权——写死单号是为了让这条断言失败在**策略**上，
-- 而不是失败在「连序列都用不了」上。第一版没写，拿到的正是后者的报错。
SELECT
  throws_ok (
    $$ insert into ops.customers (customer_no, name, status) values ('CUS-900001', '租户伪造', 'signed') $$,
    '42501',
    'new row violates row-level security policy for table "customers"',
    'P3: with INSERT granted, the write is still rejected by the absent WITH CHECK policy'
  );


RESET ROLE;


REVOKE INSERT ON ops.customers
FROM
  authenticated;


-- ══ P4 invited / disabled 成员 ══════════════════════════════════════════════
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000000c04","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        ops.get_current_ops_context ()
    ),
    0,
    'P4: an invited operator resolves to no session context'
  );


-- 这条读的是 ops.contracts —— 默认态下它是 42501（零授权），所以这里换成
-- 有 SELECT 授权且有策略的 ops.audit_events：只有在这种表上，「0 行」才真的
-- 是策略在挡，而不是没权限。契约要求证明的是「停用账号读不到业务数据」，
-- 用审计表证明的是同一件事里唯一可观测的那一面。
SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        ops.audit_events
    ),
    0,
    'P4: an invited operator reads zero audit rows even though the table grants SELECT'
  );


RESET ROLE;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000000c05","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        ops.get_current_ops_context ()
    ),
    0,
    'P4: a disabled operator resolves to no session context either'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        ops.audit_events
    ),
    0,
    'P4: a disabled operator reads zero audit rows'
  );


RESET ROLE;


-- 对照：同一条策略、同一张表，active + audit.read 的人看得到那一行。
-- 没有这条，上面两条「0 行」可能只是因为策略写错了（比如条件恒假），
-- 而那种错会让所有角色都读不到审计——测试全绿，审计页永远空着。
--
-- 断言按 id 点名而不是 count(*)：本地库里还有集成测试夹具留下的审计行，
-- `count(*) = 1` 会随夹具增减而红，那样这条对照就成了「库有多干净」的测量。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000000c03","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        ops.audit_events
      WHERE
        id = '00000000-0000-4000-8000-000000000e01'
    ),
    1,
    'P4 control: an active operator with audit.read reads the fixture row'
  );


RESET ROLE;


-- ══ P5 无 receivable.read 的 active 成员 ═════════════════════════════════════
-- 两个断言成对：support_agent 没有这个动作码，finance_ops 有。契约写的是
-- 「select ops.receipts 0 行」，本实现是零授权 + RPC 判权限，所以断言落在
-- RPC 上——那是真实的门。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000000c02","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    (
      SELECT
        ops.has_permission ('receivable.read')
    ),
    FALSE,
    'P5: the support role does not hold receivable.read'
  );


SELECT
  throws_ok (
    $$ select * from ops.list_receipts() $$,
    '42501',
    NULL,
    'P5: an operator without receivable.read cannot list receipts'
  );


RESET ROLE;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000000c05","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


-- 停用账号即使**有** receivable.read（finance_ops）也进不来。这一条与 P4 配对，
-- 证明「有权限码」不能替代「账号是 active」：两个条件都查，缺一个就漏一类人。
SELECT
  throws_ok (
    $$ select * from ops.list_receipts() $$,
    '42501',
    NULL,
    'P5: a disabled operator with receivable.read still cannot list receipts'
  );


RESET ROLE;


-- ══ P7 审计表不可改 ══════════════════════════════════════════════════════════
SELECT
  IS (
    has_table_privilege('authenticated', 'ops.audit_events', 'UPDATE'),
    FALSE,
    'P7: authenticated holds no UPDATE on ops.audit_events'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000000c01","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


-- 必须真的以 authenticated 跑：以属主身份跑 UPDATE 会成功，那条绿就成了
-- 「我们能改审计」的假证据。平台管理员也一样被挡——追加表对谁都不开写。
SELECT
  throws_ok (
    $$ update ops.audit_events set action = 'tampered' $$,
    '42501',
    'permission denied for table audit_events',
    'P7: not even the platform admin can rewrite an audit row'
  );


RESET ROLE;


-- ══ P8 核销表不可删 ══════════════════════════════════════════════════════════
SELECT
  IS (
    has_table_privilege(
      'authenticated',
      'ops.receipt_allocations',
      'DELETE'
    ),
    FALSE,
    'P8: authenticated holds no DELETE on ops.receipt_allocations'
  );


SET
  local role authenticated;


SELECT
  throws_ok (
    $$ delete from ops.receipt_allocations $$,
    '42501',
    'permission denied for table receipt_allocations',
    'P8: allocations cannot be deleted; reversal is an appended row, not a removal'
  );


RESET ROLE;


-- ══ P9 运营身份读不到租户业务明细 ═══════════════════════════════════════════
-- 先证明这些表**有行**且租户成员看得见，否则下面的 0 行与权限无关。
--
-- 两种身份都显式带上同一个 `x-organization-id`。这不是为了走通策略，恰恰相反：
-- 运营身份**直接指名道姓要那家租户的数据**仍然拿 0 行，才是这条证明的意思。
-- 不带这个头的话，「0 行」还可以解释为「他没说要哪家」——那是另一件事。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000000c06","role":"authenticated"}',
    TRUE
  );


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"00000000-0000-4000-8000-000000000f01"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.orders
      WHERE
        id = '00000000-0000-4000-8000-000000000f03'
    ),
    1,
    'P9 control: a tenant member does read the order fixture, so the zero below is about identity'
  );


RESET ROLE;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000000c01","role":"authenticated"}',
    TRUE
  );


-- `request.headers` 保持上一条的值：同一个组织 id，换个人。
SET
  local role authenticated;


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.orders
    ),
    0,
    'P9: an operator reads zero public.orders rows even when naming a real organization'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.customers
    ),
    0,
    'P9: an operator reads zero public.customers rows'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.order_receivables
    ),
    0,
    'P9: an operator reads zero public.order_receivables rows'
  );


-- ══ P10 不借用租户上下文 ═════════════════════════════════════════════════════
-- 这条比 P9 更直接：P9 说的是「读不到行」，P10 说的是「连身份上下文都拿不到」。
-- 函数是 SECURITY DEFINER，绕过 RLS，只按 auth.uid() 查 organization_members——
-- 所以 0 行不是策略挡的，是这个人本来就不在租户成员表里。
SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.get_current_auth_context ()
    ),
    0,
    'P10: an operator gets no tenant auth context, so no tenant claim can be forged through it'
  );


RESET ROLE;


-- 对照：同一个函数对真租户成员返回一行。没有它，「0 行」可能只是函数签名写错了。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000000c06","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.get_current_auth_context ()
    ),
    1,
    'P10 control: the same function returns one row for a real tenant member'
  );


RESET ROLE;


-- ══ P13 status 只能经 transition RPC 改 ══════════════════════════════════════
-- 契约括注写「status 不在 UPDATE 列白名单」，本实现没有列白名单——连表级
-- UPDATE 都没有。两种写法给出的结论一致：直接改 status 这条路不存在。
SELECT
  IS (
    has_table_privilege('authenticated', 'ops.customers', 'UPDATE'),
    FALSE,
    'P13: authenticated holds no UPDATE on ops.customers, so no column whitelist is needed'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000000c01","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  throws_ok (
    $$ update ops.customers set status = 'terminated' $$,
    '42501',
    'permission denied for table customers',
    'P13: even a platform admin cannot set status directly'
  );


RESET ROLE;


-- 补授 UPDATE 后仍改不动：RLS 开着、没有 UPDATE 策略，`UPDATE` 不报错而是
-- **影响 0 行**。这正是「静默不生效」比「报错」更需要断言的地方——报错的路径
-- 用户会看见，静默的路径只有测试能看见。
INSERT INTO
  ops.customers (id, name, status)
VALUES
  (
    '00000000-0000-4000-8000-000000000e02',
    '待转状态的客户',
    'signed'
  );


-- UPDATE 要连 SELECT 一起补：`where id = …` 里的列会被要求 SELECT 权限，
-- 只授 UPDATE 的话报错是「permission denied for table customers」——那是缺
-- SELECT，不是缺 UPDATE，读起来却一模一样。第一版就卡在这里。
GRANT
SELECT
,
UPDATE ON ops.customers TO authenticated;


SET
  local role authenticated;


-- 受影响行数得从 `GET DIAGNOSTICS` 拿：数据修改语句不能塞进子查询（也不许放进
-- 子查询里的 CTE，报错是「must be at the top level」）。所以先用 DO 块把 UPDATE
-- 跑掉、把行数存进事务级 GUC，再用普通的 `is()` 断言——断言仍然是断言，只是
-- 被测语句提前一步执行。
DO $$
DECLARE
  touched integer;
BEGIN
  UPDATE ops.customers
  SET
    status = 'terminated'
  WHERE
    id = '00000000-0000-4000-8000-000000000e02';
  GET DIAGNOSTICS touched = ROW_COUNT;
  PERFORM set_config('test.p13_touched', touched::text, TRUE);
END
$$;


SELECT
  IS (
    current_setting('test.p13_touched')::int,
    0,
    'P13: with UPDATE granted, the statement touches zero rows instead of silently succeeding'
  );


RESET ROLE;


-- 行本身没变。上面那条只证明「UPDATE 影响 0 行」，这条证明「那一行还是原值」——
-- 两者相差一个「有没有别的路径改到它」，而这条路径恰恰是契约要堵的。
SELECT
  IS (
    (
      SELECT
        status
      FROM
        ops.customers
      WHERE
        id = '00000000-0000-4000-8000-000000000e02'
    ),
    'signed',
    'P13: the row still holds its original status'
  );


REVOKE
SELECT
,
UPDATE ON ops.customers
FROM
  authenticated;


SELECT
  *
FROM
  finish ();


ROLLBACK;