BEGIN;


SELECT
  plan (5);


-- ── 夹具 ────────────────────────────────────────────────────────────────────
-- 直接写表（无会话）代表迁移/种子路径；触发器同样要记账，只是 actor 为空。
INSERT INTO
  ops.customers (id, name, status)
VALUES
  (
    '00000000-0000-4000-8000-000000000a11',
    '审计测试客户',
    'active'
  );

INSERT INTO
  ops.tickets (id, customer_id, subject, description, issue_type, priority, status)
VALUES
  (
    '00000000-0000-4000-8000-000000000b11',
    '00000000-0000-4000-8000-000000000a11',
    '审计测试工单',
    '验证工单创建会被记账',
    'incident',
    'high',
    'new'
  );


SELECT
  is(
    (
      SELECT
        count(*)::integer
      FROM
        ops.audit_events
      WHERE
        entity_type = 'ticket'
        and entity_id = '00000000-0000-4000-8000-000000000b11'
        and action = 'ticket.created'
    ),
    1,
    '建单写一条 ticket.created'
  );


-- 状态流转：审计要同时留下前后两态，否则「从什么状态变成什么状态」查不出来。
UPDATE ops.tickets
SET
  status = 'assigned'
WHERE
  id = '00000000-0000-4000-8000-000000000b11';


SELECT
  is(
    (
      SELECT
        count(*)::integer
      FROM
        ops.audit_events
      WHERE
        entity_type = 'ticket'
        and entity_id = '00000000-0000-4000-8000-000000000b11'
    ),
    2,
    '改状态再写一条 ticket.updated'
  );


SELECT
  is(
    (
      SELECT
        before_summary ->> 'status'
      FROM
        ops.audit_events
      WHERE
        entity_type = 'ticket'
        and entity_id = '00000000-0000-4000-8000-000000000b11'
        and action = 'ticket.updated'
    ),
    'new',
    '审计里留住了变更前的状态'
  );


SELECT
  is(
    (
      SELECT
        after_summary ->> 'status'
      FROM
        ops.audit_events
      WHERE
        entity_type = 'ticket'
        and entity_id = '00000000-0000-4000-8000-000000000b11'
        and action = 'ticket.updated'
    ),
    'assigned',
    '审计里留住了变更后的状态'
  );


-- 值没变的 UPDATE 不该记账：审计表里每一条都应是「发生了一件事」。
UPDATE ops.tickets
SET
  status = 'assigned'
WHERE
  id = '00000000-0000-4000-8000-000000000b11';


SELECT
  is(
    (
      SELECT
        count(*)::integer
      FROM
        ops.audit_events
      WHERE
        entity_type = 'ticket'
        and entity_id = '00000000-0000-4000-8000-000000000b11'
    ),
    2,
    '空更新不产生审计噪声'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;
