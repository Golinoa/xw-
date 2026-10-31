-- 附件「上传完成」的两处修正。
--
-- 原来的 `ops.complete_contract_attachment` 里有一段：
--
--   if target.status <> 'pending' then
--     return jsonb_build_object('status', 'attachment_not_uploaded');
--   end if;
--
-- 它同时错了两件事：
--
-- 1. **语义错**：`attachment_not_uploaded` 说的是「文件还没传上来」，而这个
--    分支在「已经 stored」时触发。也就是说**重复调用会收到「文件还没上传」**
--    —— 一个已经存在、还能下载的附件，被告知从未上传过。
-- 2. **该检查的没检查**：真正的「没上传」是「存储里没有这个对象」，而这段
--    代码只看数据库那一行的状态。那一行在 `create` 时就写了，于是
--    `complete` 一个从未上传过的附件**永远成功**，状态变 stored，下载 404。
--
-- 第 2 条的根因是「数据库不知道 Storage」。o-t13 之前本地没有 `/storage/v1`，
-- 这个理由成立；现在本地有替身、线上有 Supabase，它不成立了。所以补一个
-- 只读函数给 API：先拿路径、HEAD 对象、再决定是否推进状态。
--
-- 为什么是「新增只读函数」而不是给 complete 加一个 `p_object_exists` 参数：
-- 后者要求调用方先知道路径，而路径本身要通过一次查询拿到——参数化只是把
-- 两次往返藏进一个签名里，顺序反而更难读。
-- ── 附件的存储位置（API 用来做存在性校验） ─────────────────────────────────
-- 权限与 `complete` 一致（`contract.write`），不借 `contract.read`：能确认
-- 上传的人不一定能读合同正文，反过来也一样。
CREATE OR REPLACE FUNCTION ops.contract_attachment_location (p_attachment_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  target ops.contract_attachments;
begin
  perform ops.require_permission('contract.write');

  select * into target
  from ops.contract_attachments as attachment
  where attachment.id = p_attachment_id;

  if not found then
    return jsonb_build_object('status', 'attachment_not_found');
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'storage_path', target.storage_path,
    'file_name', target.file_name,
    'byte_size', target.byte_size,
    -- 让调用方一次拿到「行当前状态」，避免它为了判断幂等再查一遍。
    'attachment_status', target.status
  );
end;
$$;


COMMENT ON FUNCTION ops.contract_attachment_location (uuid) IS '附件的存储路径与当前状态；供 API 在 complete 前做对象存在性校验（数据库不知道 Storage）。';


-- ── 重写 complete：已 stored 走幂等，不再冒充「未上传」 ─────────────────────
CREATE OR REPLACE FUNCTION ops.complete_contract_attachment (
  p_attachment_id uuid,
  p_checksum_sha256 text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
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

  -- 已经是 stored：这是一次重试，不是一次错误。
  --
  -- 不重写 `uploaded_at` 与 `version`：重试没有产生新的上传，把它记成一次
  -- 新动作会让「这个附件何时被上传」这个问题的答案随请求次数漂移。审计也
  -- 不写第二行——`contract.attachment_added` 描述的是「它变成了 stored」，
  -- 那件事只发生过一次。
  --
  -- 返回 ok 而不是 409：当请求本身完全正确、结果与期望一致时，回错误会让
  -- 客户端把「已经成功」当成「需要人工处理」。真正的 409 留给对象缺失。
  if target.status = 'stored' then
    return jsonb_build_object(
      'status', 'ok',
      'attachment', ops.attachment_json(p_attachment_id)
    );
  end if;

  if checksum is not null and checksum !~ '^[0-9a-fA-F]{64}$' then
    return jsonb_build_object(
      'status', 'invalid_checksum',
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


COMMENT ON FUNCTION ops.complete_contract_attachment (uuid, text) IS '附件完成：pending→stored；已 stored 幂等返回 ok（重复调用不是错误）。对象是否真的在存储里由 API 用 contract_attachment_location + HEAD 校验——数据库不知道 Storage。';


-- ── 授权 ────────────────────────────────────────────────────────────────────
REVOKE ALL ON function ops.contract_attachment_location (uuid)
FROM
  public,
  anon,
  authenticated;


GRANT
EXECUTE ON function ops.contract_attachment_location (uuid) TO authenticated,
service_role;