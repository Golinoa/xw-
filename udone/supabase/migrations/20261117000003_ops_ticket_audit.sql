-- 工单审计：此前 `ops.tickets` 全表零审计写入
--
-- 后果不只是「查不到」：审计相关的用例（「审计失败会怎样」）连对象都没有，
-- 所以那一批测试一直没写。补上之后，工单的每一次创建与状态变化都有据可查。
--
-- 为什么用触发器而不是在每个 RPC 里加一行：写工单的入口有 create_ticket /
-- update_ticket / assign_ticket 三个，将来还会有流转、关闭；表级 AFTER 触发器
-- 一次覆盖全部入口，也不会因为新增一个 RPC 忘了写审计而漏记。
--
-- 「before = after」直接跳过：`update_operator` 那类「先删后插」的写法会产生
-- 值完全相同的 UPDATE，逐条记账只会把审计表灌成一堆噪声（写进去的每一条
-- 都该是「发生了一件事」，而不是「跑了一次 SQL」）。

CREATE OR REPLACE FUNCTION ops.ticket_audit_summary (p_ticket ops.tickets) returns jsonb language sql immutable
SET
  search_path = '' AS $$
  select jsonb_build_object(
    'status', p_ticket.status,
    'priority', p_ticket.priority,
    'assigneeOperatorId', p_ticket.assignee_operator_id,
    'waitingOn', p_ticket.waiting_on,
    'resolutionSummary', p_ticket.resolution_summary
  );
$$;


CREATE OR REPLACE FUNCTION ops.audit_ticket_change () returns trigger language plpgsql security definer
SET
  search_path = '' AS $$
begin
  if tg_op = 'UPDATE' and to_jsonb(old) = to_jsonb(new) then
    return null;
  end if;

  perform ops.write_audit(
    case tg_op
      when 'INSERT' then 'ticket.created'
      else 'ticket.updated'
    end,
    'ticket',
    new.id,
    null,
    case tg_op
      when 'INSERT' then null
      else ops.ticket_audit_summary(old)
    end,
    ops.ticket_audit_summary(new),
    null
  );

  return null;
end;
$$;


DROP TRIGGER IF EXISTS tickets_audit_change ON ops.tickets;

CREATE TRIGGER tickets_audit_change
AFTER INSERT OR UPDATE ON ops.tickets FOR EACH ROW
EXECUTE FUNCTION ops.audit_ticket_change ();


-- 新建函数默认对 PUBLIC 有 EXECUTE；仓库有断言专门查这件事（A2）。
REVOKE ALL ON function ops.ticket_audit_summary (ops.tickets) FROM public, anon, authenticated;

REVOKE ALL ON function ops.audit_ticket_change () FROM public, anon, authenticated;
