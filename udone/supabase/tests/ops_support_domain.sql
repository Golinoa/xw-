BEGIN;


SELECT
  plan (77);


-- ── 夹具 ────────────────────────────────────────────────────────────────────
-- 三个运营身份：售后（ticket.read/create/assign/update/close 全有）、只读
-- （只有 ticket.read）、无角色（连 read 都没有）。再补一个停用成员，用来证明
-- 「把工单分给一个不会看到它的人」是被挡住的。
INSERT INTO
  auth.users (id, aud, role, email)
VALUES
  (
    '00000000-0000-4000-8000-0000000007b1',
    'authenticated',
    'authenticated',
    'support-agent@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000007b2',
    'authenticated',
    'authenticated',
    'support-viewer@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000007b3',
    'authenticated',
    'authenticated',
    'support-norole@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000007b4',
    'authenticated',
    'authenticated',
    'support-disabled@example.test'
  );


INSERT INTO
  ops.operators (id, user_id, email, display_name, status)
VALUES
  (
    '00000000-0000-4000-8000-0000000007a1',
    '00000000-0000-4000-8000-0000000007b1',
    'support-agent@example.test',
    'support 售后',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000007a2',
    '00000000-0000-4000-8000-0000000007b2',
    'support-viewer@example.test',
    'support 只读',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000007a3',
    '00000000-0000-4000-8000-0000000007b3',
    'support-norole@example.test',
    'support 无角色',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000007a4',
    '00000000-0000-4000-8000-0000000007b4',
    'support-disabled@example.test',
    'support 已停用',
    'disabled'
  );


INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
SELECT
  '00000000-0000-4000-8000-0000000007a1',
  role.id,
  '00000000-0000-4000-8000-0000000007a1'
FROM
  ops.roles AS role
WHERE
  role.code = 'support_agent';


INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
SELECT
  '00000000-0000-4000-8000-0000000007a2',
  role.id,
  '00000000-0000-4000-8000-0000000007a1'
FROM
  ops.roles AS role
WHERE
  role.code = 'ops_viewer';


INSERT INTO
  ops.customers (id, name, status)
VALUES
  (
    '00000000-0000-4000-8000-0000000007c1',
    'support 测试客户',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000007c2',
    'support 别家客户',
    'active'
  );


INSERT INTO
  ops.contracts (
    id,
    customer_id,
    sales_mode,
    status,
    total_amount,
    currency
  )
VALUES
  (
    '00000000-0000-4000-8000-0000000007d1',
    '00000000-0000-4000-8000-0000000007c1',
    'saas',
    'active',
    12000.00,
    'CNY'
  ),
  (
    '00000000-0000-4000-8000-0000000007d2',
    '00000000-0000-4000-8000-0000000007c2',
    'saas',
    'active',
    6000.00,
    'CNY'
  );


INSERT INTO
  ops.products (id, code, name, lifecycle_status)
VALUES
  (
    '00000000-0000-4000-8000-0000000007e1',
    'SUP-TEST',
    'support 测试产品',
    'active'
  );


-- 三张直插的工单，各钉住一种读侧状态：
--   t_closed  —— 已关闭（分派/加说明必须被拒，且 closed_at 必须非空）
--   t_overdue —— 进行中且已过截止（`overdueOnly` 唯一命中者）
--   t_waiting —— 等待中且过去截止（证明 waiting 也算逾期，只有 resolved/closed 不算）
INSERT INTO
  ops.tickets (
    id,
    customer_id,
    subject,
    description,
    issue_type,
    priority,
    status,
    assignee_operator_id,
    due_at,
    closed_at,
    waiting_on
  )
VALUES
  (
    '00000000-0000-4000-8000-0000000007f1',
    '00000000-0000-4000-8000-0000000007c1',
    '已关闭的工单',
    '用于验证关闭后的写入拒绝',
    'bug',
    'normal',
    'closed',
    '00000000-0000-4000-8000-0000000007a1',
    now() + interval '1 day',
    now(),
    NULL
  ),
  (
    '00000000-0000-4000-8000-0000000007f2',
    '00000000-0000-4000-8000-0000000007c1',
    '已逾期的工单',
    '用于验证 overdueOnly',
    'incident',
    'urgent',
    'in_progress',
    '00000000-0000-4000-8000-0000000007a1',
    now() - interval '2 hours',
    NULL,
    NULL
  ),
  (
    '00000000-0000-4000-8000-0000000007f3',
    '00000000-0000-4000-8000-0000000007c1',
    '等待客户回复的逾期工单',
    '用于验证 waiting 也算逾期',
    'question',
    'low',
    'waiting',
    '00000000-0000-4000-8000-0000000007a2',
    now() - interval '3 days',
    NULL,
    '客户提供日志'
  );


-- ── I：状态机是数据，不是三份副本 ───────────────────────────────────────────
SELECT
  IS (
    ops.allowed_ticket_actions ('new'),
    ARRAY['assign']::TEXT[],
    'I1 new only allows assign'
  );


SELECT
  IS (
    ops.allowed_ticket_actions ('assigned'),
    ARRAY['start']::TEXT[],
    'I2 assigned only allows start'
  );


SELECT
  IS (
    ops.allowed_ticket_actions ('in_progress'),
    ARRAY['wait', 'resolve']::TEXT[],
    'I3 in_progress allows wait and resolve'
  );


SELECT
  IS (
    ops.allowed_ticket_actions ('waiting'),
    ARRAY['resume', 'resolve']::TEXT[],
    'I4 waiting allows resume and resolve'
  );


SELECT
  IS (
    ops.allowed_ticket_actions ('resolved'),
    ARRAY['close', 'reopen']::TEXT[],
    'I5 resolved allows close and reopen'
  );


SELECT
  IS (
    ops.allowed_ticket_actions ('closed'),
    ARRAY['reopen']::TEXT[],
    'I6 closed only allows reopen'
  );


SELECT
  IS (
    ops.allowed_ticket_actions ('bogus'),
    ARRAY[]::TEXT[],
    'I7 an unknown status allows nothing instead of raising'
  );


-- ── D：时限与业务时区 ───────────────────────────────────────────────────────
SELECT
  IS (
    ops.ticket_due_at ('2026-03-01 00:00:00+00'::timestamptz),
    '2026-03-03 00:00:00+00'::timestamptz,
    'D1 due_at is created_at plus settings.ticket.dueHours (default 48)'
  );


SELECT
  IS (
    ops.business_day_start (DATE '2026-03-01'),
    '2026-02-28 16:00:00+00'::timestamptz,
    'D2 a business day starts at 00:00 Asia/Shanghai, not 00:00 UTC'
  );


SELECT
  IS (
    ops.ticket_is_overdue (
      'new',
      '2026-03-01 12:00:00+00'::timestamptz,
      '2026-03-01 12:00:00+00'::timestamptz
    ),
    FALSE,
    'D3 due_at equal to now is not overdue (strict less-than)'
  );


-- ── O：逾期矩阵 ─────────────────────────────────────────────────────────────
SELECT
  IS (
    ops.ticket_is_overdue ('in_progress', now() - interval '1 minute', now()),
    TRUE,
    'O1 an open ticket past its due_at is overdue'
  );


SELECT
  IS (
    ops.ticket_is_overdue ('waiting', now() - interval '1 minute', now()),
    TRUE,
    'O2 waiting does not exempt a ticket from being overdue'
  );


SELECT
  IS (
    ops.ticket_is_overdue ('resolved', now() - interval '1 minute', now()),
    FALSE,
    'O3 resolved is not overdue even past its due_at'
  );


SELECT
  IS (
    ops.ticket_is_overdue ('closed', now() - interval '1 minute', now()),
    FALSE,
    'O4 closed is never overdue'
  );


SELECT
  IS (
    ops.ticket_is_overdue ('new', NULL, now()),
    FALSE,
    'O5 a ticket without due_at is not overdue'
  );


-- ── K：表约束（绕过 RPC 也拦得住） ──────────────────────────────────────────
SELECT
  throws_ok (
    $$insert into ops.tickets (customer_id, subject, description, issue_type, priority, status) values ('00000000-0000-4000-8000-0000000007c1', 's', 'd', 'bug', 'normal', 'waiting')$$,
    '23514',
    NULL,
    'K1 status waiting without waiting_on violates the check constraint'
  );


SELECT
  throws_ok (
    $$insert into ops.tickets (customer_id, subject, description, issue_type, priority, status) values ('00000000-0000-4000-8000-0000000007c1', 's', 'd', 'bug', 'critical', 'new')$$,
    '23514',
    NULL,
    'K2 an unknown priority is rejected by the table, not only by the RPC'
  );


SELECT
  throws_ok (
    $$insert into ops.tickets (customer_id, subject, description, issue_type, priority, status) values ('00000000-0000-4000-8000-0000000007c1', 's', 'd', 'bug', 'normal', 'closed')$$,
    '23514',
    NULL,
    'K3 closed without closed_at is impossible'
  );


-- ── 切到售后身份，走写入路径 ────────────────────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000007b1","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


-- 主用单：后续分派与状态机测试都在这张单上推进。整个返回体存进会话变量，
-- 后续断言只读它——**不能直接读 `ops.tickets`**：测试跑在 `authenticated` 身份上，
-- 而三张表现在对它是零权限（这正是 §7.2 的设计）。读侧只能走 RPC，与端点同一条路。
-- 每次变更后把最新信封存进 `support.env`，版本号从信封里取，不硬编码。
SELECT
  set_config(
    'support.created',
    ops.create_ticket (
      '00000000-0000-4000-8000-0000000007c1',
      '登录失败',
      '客户反馈 SSO 登录返回 500',
      'bug',
      'high',
      '00000000-0000-4000-8000-0000000007e1',
      '00000000-0000-4000-8000-0000000007d1'
    )::text,
    TRUE
  );


SELECT
  IS (
    current_setting('support.created')::jsonb #>> '{ticket,status}',
    'new',
    'C1 a new ticket starts in status new'
  );


SELECT
  ok (
    current_setting('support.created')::jsonb #>> '{ticket,ticket_no}' ~ '^TK-[0-9]{6}$',
    'C2 ticket_no follows the TK- plus six digits convention'
  );


SELECT
  IS (
    (
      SELECT
        count(*)
      FROM
        jsonb_array_elements(
          ops.list_ticket_timeline (
            (
              current_setting('support.created')::jsonb #>> '{ticket,id}'
            )::uuid,
            100,
            0
          ) -> 'items'
        ) AS event
      WHERE
        event ->> 'event_type' = 'created'
    ),
    1::bigint,
    'C3 creation appends exactly one created event'
  );


SELECT
  IS (
    (
      current_setting('support.created')::jsonb #>> '{ticket,due_at}'
    )::timestamptz BETWEEN now() + interval '47 hours' AND now() + interval '49 hours',
    TRUE,
    'C4 due_at is a snapshot of created_at plus the configured hours'
  );


SELECT
  IS (
    ops.create_ticket (
      '00000000-0000-4000-8000-0000000007c1',
      '错配引用',
      '合同属于另一个客户',
      'bug',
      'normal',
      NULL,
      '00000000-0000-4000-8000-0000000007d2'
    ) ->> 'status',
    'reference_customer_mismatch',
    'C5 a contract of another customer is refused'
  );


SELECT
  IS (
    ops.create_ticket (
      '00000000-0000-4000-8000-0000000007c1',
      '不存在的合同',
      '合同 id 不存在',
      'bug',
      'normal',
      NULL,
      '00000000-0000-4000-8000-0000000007ff'
    ) ->> 'field',
    'contractId',
    'C6 a missing contract reports which field was wrong'
  );


SELECT
  IS (
    ops.create_ticket (
      '00000000-0000-4000-8000-0000000007c1',
      '优先级非法',
      '描述',
      'bug',
      'critical',
      NULL,
      NULL
    ) ->> 'status',
    'priority_invalid',
    'C7 an unknown priority comes back as an envelope, not a 500'
  );


SELECT
  IS (
    ops.create_ticket (
      '00000000-0000-4000-8000-0000000007c1',
      '   ',
      '描述',
      'bug',
      'normal',
      NULL,
      NULL
    ) ->> 'status',
    'subject_required',
    'C8 a blank subject is not a subject'
  );


SELECT
  IS (
    ops.create_ticket (
      '00000000-0000-4000-8000-0000000007ff',
      '客户不存在',
      '描述',
      'bug',
      'normal',
      NULL,
      NULL
    ) ->> 'status',
    'customer_not_found',
    'C9 a ticket without an existing customer cannot exist'
  );


-- 第二张单子只用来证明「从 new 直接 start」是非法迁移。
SELECT
  set_config(
    'support.other',
    ops.create_ticket (
      '00000000-0000-4000-8000-0000000007c1',
      '另一张新单',
      '用于非法迁移断言',
      'question',
      'low'
    )::text,
    TRUE
  );


SELECT
  IS (
    ops.transition_ticket (
      (
        current_setting('support.other')::jsonb #>> '{ticket,id}'
      )::uuid,
      'start',
      (
        current_setting('support.other')::jsonb #>> '{ticket,version}'
      )::integer
    ) ->> 'status',
    'invalid_transition',
    'T1 start is not reachable from new'
  );


SELECT
  IS (
    ops.transition_ticket (
      (
        current_setting('support.other')::jsonb #>> '{ticket,id}'
      )::uuid,
      'start',
      (
        current_setting('support.other')::jsonb #>> '{ticket,version}'
      )::integer
    ) -> 'allowed_actions',
    '["assign"]'::jsonb,
    'T2 an invalid transition still tells the client what is allowed'
  );


-- A1 起每一次变更都把信封写进 support.env，版本号从上一个信封里取。
SELECT
  set_config(
    'support.env',
    ops.assign_ticket (
      (
        current_setting('support.created')::jsonb #>> '{ticket,id}'
      )::uuid,
      '00000000-0000-4000-8000-0000000007a1',
      (
        current_setting('support.created')::jsonb #>> '{ticket,version}'
      )::integer
    )::text,
    TRUE
  );


SELECT
  IS (
    current_setting('support.env')::jsonb #>> '{ticket,status}',
    'assigned',
    'A1 assigning a new ticket moves it to assigned'
  );


SELECT
  IS (
    (
      SELECT
        event -> 'metadata'
      FROM
        jsonb_array_elements(
          ops.list_ticket_timeline (
            (
              current_setting('support.created')::jsonb #>> '{ticket,id}'
            )::uuid,
            100,
            0
          ) -> 'items'
        ) AS event
      WHERE
        event ->> 'event_type' = 'assigned'
    ) ? 'previousAssigneeId',
    FALSE,
    'A2 a first assignment does not carry a previous assignee key'
  );


SELECT
  IS (
    ops.assign_ticket (
      (
        current_setting('support.created')::jsonb #>> '{ticket,id}'
      )::uuid,
      '00000000-0000-4000-8000-0000000007a4',
      (
        current_setting('support.env')::jsonb #>> '{ticket,version}'
      )::integer
    ) ->> 'status',
    'assignee_inactive',
    'A3 a disabled operator cannot be assigned'
  );


SELECT
  IS (
    ops.assign_ticket (
      (
        current_setting('support.created')::jsonb #>> '{ticket,id}'
      )::uuid,
      '00000000-0000-4000-8000-0000000007fe',
      (
        current_setting('support.env')::jsonb #>> '{ticket,version}'
      )::integer
    ) ->> 'status',
    'assignee_not_found',
    'A4 an unknown assignee is not found, not silently accepted'
  );


SELECT
  set_config(
    'support.env',
    ops.transition_ticket (
      (
        current_setting('support.created')::jsonb #>> '{ticket,id}'
      )::uuid,
      'start',
      (
        current_setting('support.env')::jsonb #>> '{ticket,version}'
      )::integer
    )::text,
    TRUE
  );


SELECT
  IS (
    current_setting('support.env')::jsonb #>> '{ticket,status}',
    'in_progress',
    'T3 start moves an assigned ticket to in_progress'
  );


SELECT
  set_config(
    'support.env',
    ops.assign_ticket (
      (
        current_setting('support.created')::jsonb #>> '{ticket,id}'
      )::uuid,
      '00000000-0000-4000-8000-0000000007a2',
      (
        current_setting('support.env')::jsonb #>> '{ticket,version}'
      )::integer
    )::text,
    TRUE
  );


SELECT
  IS (
    current_setting('support.env')::jsonb #>> '{ticket,status}',
    'in_progress',
    'A5 reassigning an in-progress ticket does not change its status'
  );


SELECT
  IS (
    ops.transition_ticket (
      (
        current_setting('support.created')::jsonb #>> '{ticket,id}'
      )::uuid,
      'wait',
      (
        current_setting('support.env')::jsonb #>> '{ticket,version}'
      )::integer
    ) ->> 'status',
    'waiting_on_required',
    'T4 wait without waitingOn is refused'
  );


SELECT
  set_config(
    'support.env',
    ops.transition_ticket (
      (
        current_setting('support.created')::jsonb #>> '{ticket,id}'
      )::uuid,
      'wait',
      (
        current_setting('support.env')::jsonb #>> '{ticket,version}'
      )::integer,
      '等待客户回传日志'
    )::text,
    TRUE
  );


SELECT
  IS (
    current_setting('support.env')::jsonb #>> '{ticket,status}',
    'waiting',
    'T5 wait with waitingOn moves the ticket to waiting'
  );


SELECT
  IS (
    current_setting('support.env')::jsonb #>> '{ticket,waiting_on}',
    '等待客户回传日志',
    'T6 waiting_on is stored on the ticket, not only in the event'
  );


SELECT
  set_config(
    'support.env',
    ops.transition_ticket (
      (
        current_setting('support.created')::jsonb #>> '{ticket,id}'
      )::uuid,
      'resume',
      (
        current_setting('support.env')::jsonb #>> '{ticket,version}'
      )::integer
    )::text,
    TRUE
  );


SELECT
  IS (
    current_setting('support.env')::jsonb #>> '{ticket,status}',
    'in_progress',
    'T7 resume returns the ticket to in_progress'
  );


SELECT
  IS (
    current_setting('support.env')::jsonb #>> '{ticket,waiting_on}',
    NULL,
    'T8 leaving waiting clears waiting_on instead of leaving a stale value'
  );


SELECT
  IS (
    ops.transition_ticket (
      (
        current_setting('support.created')::jsonb #>> '{ticket,id}'
      )::uuid,
      'resolve',
      (
        current_setting('support.env')::jsonb #>> '{ticket,version}'
      )::integer
    ) ->> 'status',
    'resolution_summary_required',
    'T9 resolve without a summary is refused'
  );


SELECT
  set_config(
    'support.env',
    ops.transition_ticket (
      (
        current_setting('support.created')::jsonb #>> '{ticket,id}'
      )::uuid,
      'resolve',
      (
        current_setting('support.env')::jsonb #>> '{ticket,version}'
      )::integer,
      NULL,
      '重置了 SSO 回调地址'
    )::text,
    TRUE
  );


SELECT
  IS (
    current_setting('support.env')::jsonb #>> '{ticket,status}',
    'resolved',
    'T10 resolve with a summary moves the ticket to resolved'
  );


SELECT
  IS (
    (
      SELECT
        event ->> 'body'
      FROM
        jsonb_array_elements(
          ops.list_ticket_timeline (
            (
              current_setting('support.created')::jsonb #>> '{ticket,id}'
            )::uuid,
            100,
            0
          ) -> 'items'
        ) AS event
      WHERE
        event ->> 'event_type' = 'status_changed'
        AND event ->> 'to_status' = 'resolved'
    ),
    '重置了 SSO 回调地址',
    'T11 the resolution summary is the timeline body of the resolve event'
  );


SELECT
  set_config(
    'support.env',
    ops.transition_ticket (
      (
        current_setting('support.created')::jsonb #>> '{ticket,id}'
      )::uuid,
      'close',
      (
        current_setting('support.env')::jsonb #>> '{ticket,version}'
      )::integer
    )::text,
    TRUE
  );


SELECT
  IS (
    current_setting('support.env')::jsonb #>> '{ticket,status}',
    'closed',
    'T12 close moves a resolved ticket to closed'
  );


SELECT
  ok (
    current_setting('support.env')::jsonb #>> '{ticket,closed_at}' IS NOT NULL,
    'T13 closing stamps closed_at'
  );


SELECT
  IS (
    ops.add_ticket_event (
      (
        current_setting('support.created')::jsonb #>> '{ticket,id}'
      )::uuid,
      '关闭之后再补一句'
    ) ->> 'status',
    'ticket_closed',
    'E1 a closed ticket accepts no further comments'
  );


SELECT
  IS (
    ops.transition_ticket (
      (
        current_setting('support.created')::jsonb #>> '{ticket,id}'
      )::uuid,
      'reopen',
      (
        current_setting('support.env')::jsonb #>> '{ticket,version}'
      )::integer
    ) ->> 'status',
    'reason_required',
    'T14 reopen without a reason is refused'
  );


SELECT
  set_config(
    'support.env',
    ops.transition_ticket (
      (
        current_setting('support.created')::jsonb #>> '{ticket,id}'
      )::uuid,
      'reopen',
      (
        current_setting('support.env')::jsonb #>> '{ticket,version}'
      )::integer,
      NULL,
      NULL,
      '客户说问题复发了'
    )::text,
    TRUE
  );


SELECT
  IS (
    current_setting('support.env')::jsonb #>> '{ticket,status}',
    'in_progress',
    'T15 reopen returns a closed ticket to in_progress'
  );


SELECT
  IS (
    (
      current_setting('support.env')::jsonb #>> '{ticket,reopen_count}'
    )::integer,
    1,
    'T16 reopen increments reopen_count'
  );


SELECT
  IS (
    current_setting('support.env')::jsonb #>> '{ticket,closed_at}',
    NULL,
    'T17 reopen clears closed_at so the row cannot claim to be both open and closed'
  );


SELECT
  IS (
    ops.transition_ticket (
      (
        current_setting('support.created')::jsonb #>> '{ticket,id}'
      )::uuid,
      'reopen',
      (
        current_setting('support.env')::jsonb #>> '{ticket,version}'
      )::integer,
      NULL,
      NULL,
      '再重开一次'
    ) ->> 'status',
    'invalid_transition',
    'T18 reopen is not reachable from in_progress'
  );


SELECT
  IS (
    ops.add_ticket_event (
      (
        current_setting('support.created')::jsonb #>> '{ticket,id}'
      )::uuid,
      '已按客户提供的日志定位'
    ) #>> '{event,event_type}',
    'comment',
    'E2 an internal note is appended as a comment event'
  );


SELECT
  IS (
    ops.add_ticket_event (
      (
        current_setting('support.created')::jsonb #>> '{ticket,id}'
      )::uuid,
      '   '
    ) ->> 'status',
    'body_required',
    'E3 an empty note is not a note'
  );


SELECT
  IS (
    ops.add_ticket_reference (
      (
        current_setting('support.created')::jsonb #>> '{ticket,id}'
      )::uuid,
      'tenant_command',
      '00000000-0000-4000-8000-0000000007f9'
    ) ->> 'status',
    'ok',
    'R1 a reference to a domain that has not landed yet is accepted'
  );


SELECT
  IS (
    ops.add_ticket_reference (
      (
        current_setting('support.created')::jsonb #>> '{ticket,id}'
      )::uuid,
      'tenant_command',
      '00000000-0000-4000-8000-0000000007f9'
    ) ->> 'status',
    'reference_exists',
    'R2 the same reference cannot be added twice'
  );


SELECT
  IS (
    ops.add_ticket_reference (
      (
        current_setting('support.created')::jsonb #>> '{ticket,id}'
      )::uuid,
      'invoice',
      '00000000-0000-4000-8000-0000000007f9'
    ) ->> 'status',
    'invalid_ref_type',
    'R3 an unknown ref_type is refused with the allowed list'
  );


SELECT
  IS (
    (
      SELECT
        count(*)
      FROM
        jsonb_array_elements(
          ops.list_ticket_timeline (
            (
              current_setting('support.created')::jsonb #>> '{ticket,id}'
            )::uuid,
            100,
            0
          ) -> 'items'
        ) AS event
      WHERE
        event ->> 'event_type' = 'linked'
    ),
    1::bigint,
    'R4 linking writes exactly one linked event, the duplicate wrote none'
  );


SELECT
  set_config(
    'support.env',
    ops.transition_ticket (
      '00000000-0000-4000-8000-0000000007f1',
      'reopen',
      (
        SELECT
          (
            ops.get_ticket ('00000000-0000-4000-8000-0000000007f1') #>> '{ticket,version}'
          )::integer
      ),
      NULL,
      NULL,
      '客户又来了'
    )::text,
    TRUE
  );


SELECT
  IS (
    current_setting('support.env')::jsonb #>> '{ticket,status}',
    'in_progress',
    'T19 reopen also works on a ticket that was closed before this test ran'
  );


SELECT
  IS (
    ops.assign_ticket (
      '00000000-0000-4000-8000-0000000007f1',
      '00000000-0000-4000-8000-0000000007a1',
      (
        current_setting('support.env')::jsonb #>> '{ticket,version}'
      )::integer
    ) ->> 'status',
    'ok',
    'A6 reassigning a reopened ticket keeps the call legal'
  );


-- ── 读侧：列表与详情 ────────────────────────────────────────────────────────
SELECT
  IS (
    ops.list_tickets (
      p_customer_id => '00000000-0000-4000-8000-0000000007c1'
    ) ->> 'total',
    '5',
    'L1 the list counts every ticket of the customer'
  );


SELECT
  IS (
    ops.list_tickets (
      p_customer_id => '00000000-0000-4000-8000-0000000007c1',
      p_statuses => ARRAY['in_progress']::TEXT[]
    ) ->> 'total',
    '3',
    'L2 the status filter is an array, not a single value'
  );


SELECT
  IS (
    ops.list_tickets (
      p_customer_id => '00000000-0000-4000-8000-0000000007c1',
      p_priorities => ARRAY['urgent', 'high']::TEXT[]
    ) ->> 'total',
    '2',
    'L3 the priority filter accepts several values at once'
  );


SELECT
  IS (
    ops.list_tickets (
      p_customer_id => '00000000-0000-4000-8000-0000000007c1',
      p_overdue_only => TRUE
    ) ->> 'total',
    '2',
    'L4 overdueOnly matches both open tickets whose due_at has passed (in_progress and waiting)'
  );


SELECT
  IS (
    ops.list_tickets (
      p_customer_id => '00000000-0000-4000-8000-0000000007c1',
      p_created_to => (now() AT TIME ZONE 'Asia/Shanghai')::date - 1
    ) ->> 'total',
    '0',
    'L5 createdTo is inclusive of that business day, so yesterday excludes today'
  );


SELECT
  IS (
    ops.list_tickets (
      p_customer_id => '00000000-0000-4000-8000-0000000007c1',
      p_created_from => (now() AT TIME ZONE 'Asia/Shanghai')::date
    ) ->> 'total',
    '5',
    'L6 createdFrom starts at 00:00 Asia/Shanghai, so today includes everything created now'
  );


SELECT
  IS (
    ops.get_ticket ('00000000-0000-4000-8000-0000000007ff') ->> 'status',
    'ticket_not_found',
    'G1 an unknown ticket id comes back as an envelope'
  );


SELECT
  IS (
    ops.get_ticket ('00000000-0000-4000-8000-0000000007f2') #>> '{ticket,is_overdue}',
    'true',
    'G2 detail carries the server-computed is_overdue'
  );


SELECT
  IS (
    ops.get_ticket ('00000000-0000-4000-8000-0000000007f3') -> 'allowed_actions',
    '["resume","resolve"]'::jsonb,
    'G3 detail lists the actions allowed in the current status'
  );


SELECT
  IS (
    ops.get_ticket ('00000000-0000-4000-8000-0000000007f2') -> 'assignable_operators' -> 0 ->> 'display_name',
    'support 只读',
    'G4 assignable operators are ordered by display name and exclude disabled members'
  );


SELECT
  IS (
    (
      SELECT
        count(*)
      FROM
        jsonb_array_elements(
          ops.get_ticket ('00000000-0000-4000-8000-0000000007f2') -> 'assignable_operators'
        ) AS operator
      WHERE
        operator ->> 'status' <> 'active'
    ),
    0::bigint,
    'G5 a disabled member never appears in the assignable list'
  );


SELECT
  IS (
    ops.list_ticket_timeline ('00000000-0000-4000-8000-0000000007f2', 10, 0) ->> 'total',
    '0',
    'G6 a ticket inserted without events has an empty timeline, not a missing key'
  );


-- ── 权限：只读与无角色 ──────────────────────────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000007b2","role":"authenticated"}',
    TRUE
  );


SELECT
  throws_ok (
    $$select ops.create_ticket ('00000000-0000-4000-8000-0000000007c1', 's', 'd', 'bug', 'normal')$$,
    '42501',
    NULL,
    'P1 ticket.read does not imply ticket.create'
  );


SELECT
  throws_ok (
    $$select ops.transition_ticket ('00000000-0000-4000-8000-0000000007f2', 'resolve', 1, NULL, 'x')$$,
    '42501',
    NULL,
    'P2 ticket.read does not imply ticket.update'
  );


SELECT
  throws_ok (
    $$select ops.add_ticket_event ('00000000-0000-4000-8000-0000000007f2', 'x')$$,
    '42501',
    NULL,
    'P3 adding a note needs ticket.update'
  );


SELECT
  throws_ok (
    $$update ops.ticket_events set body = 'x'$$,
    '42501',
    NULL,
    'P4 the timeline is append-only: authenticated has no update grant'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000007b3","role":"authenticated"}',
    TRUE
  );


SELECT
  throws_ok (
    $$select ops.list_tickets ()$$,
    '42501',
    NULL,
    'P5 an operator without any role cannot read tickets'
  );


SELECT
  throws_ok (
    $$select ops.get_ticket ('00000000-0000-4000-8000-0000000007f2')$$,
    '42501',
    NULL,
    'P6 an operator without any role cannot read a ticket detail'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;