BEGIN;


SELECT
  plan (81);


-- ── 夹具 ────────────────────────────────────────────────────────────────────
-- 四个运营身份。两个财务是刻意的：职责分离要求「登记人 ≠ 审核人」，只造一个
-- 财务账号的话，「自审被挡住」这条既可能是被规则挡住，也可能只是被权限挡住，
-- 两种 403 分不开。
INSERT INTO
  auth.users (id, aud, role, email)
VALUES
  (
    '00000000-0000-4000-8000-0000000007b1',
    'authenticated',
    'authenticated',
    'receipt-finance-a@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000007b2',
    'authenticated',
    'authenticated',
    'receipt-finance-b@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000007b3',
    'authenticated',
    'authenticated',
    'receipt-viewer@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000007b4',
    'authenticated',
    'authenticated',
    'receipt-norole@example.test'
  );


INSERT INTO
  ops.operators (id, user_id, email, display_name, status)
VALUES
  (
    '00000000-0000-4000-8000-0000000007a1',
    '00000000-0000-4000-8000-0000000007b1',
    'receipt-finance-a@example.test',
    '收款财务甲',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000007a2',
    '00000000-0000-4000-8000-0000000007b2',
    'receipt-finance-b@example.test',
    '收款财务乙',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000007a3',
    '00000000-0000-4000-8000-0000000007b3',
    'receipt-viewer@example.test',
    '收款只读',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000007a4',
    '00000000-0000-4000-8000-0000000007b4',
    'receipt-norole@example.test',
    '收款无角色',
    'active'
  );


INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
SELECT
  entry.operator_id,
  role.id,
  '00000000-0000-4000-8000-0000000007a1'
FROM
  (
    VALUES
      ('00000000-0000-4000-8000-0000000007a1'::uuid),
      ('00000000-0000-4000-8000-0000000007a2'::uuid)
  ) AS entry (operator_id)
  JOIN ops.roles AS role ON role.code = 'finance_ops';


INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
SELECT
  '00000000-0000-4000-8000-0000000007a3',
  role.id,
  '00000000-0000-4000-8000-0000000007a1'
FROM
  ops.roles AS role
WHERE
  role.code = 'ops_viewer';


-- 两个客户、三份合同、三期应收，覆盖核销时四种「不该成功」的输入：
--   客户 A + CNY（正常）、客户 B + USD（跨客户）、客户 A + USD（跨币种）、
--   以及客户 A + CNY 的第二期（单期余额不足）。
INSERT INTO
  ops.customers (id, name, status)
VALUES
  (
    '00000000-0000-4000-8000-0000000007c1',
    '收款测试客户甲',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000007c2',
    '收款测试客户乙',
    'active'
  );


INSERT INTO
  ops.contracts (
    id,
    customer_id,
    sales_mode,
    status,
    total_amount,
    currency,
    business_note
  )
VALUES
  (
    '00000000-0000-4000-8000-0000000007d1',
    '00000000-0000-4000-8000-0000000007c1',
    'saas',
    'active',
    12000.00,
    'CNY',
    '收款主合同'
  ),
  (
    '00000000-0000-4000-8000-0000000007d2',
    '00000000-0000-4000-8000-0000000007c2',
    'saas',
    'active',
    5000.00,
    'USD',
    '别家美元合同'
  ),
  (
    '00000000-0000-4000-8000-0000000007d3',
    '00000000-0000-4000-8000-0000000007c1',
    'saas',
    'active',
    1000.00,
    'USD',
    '同客户美元合同'
  );


INSERT INTO
  ops.receivables (
    id,
    contract_id,
    customer_id,
    period_no,
    due_date,
    amount,
    currency
  )
VALUES
  (
    '00000000-0000-4000-8000-0000000007e1',
    '00000000-0000-4000-8000-0000000007d1',
    '00000000-0000-4000-8000-0000000007c1',
    1,
    DATE '2026-01-10',
    8000.00,
    'CNY'
  ),
  (
    '00000000-0000-4000-8000-0000000007e2',
    '00000000-0000-4000-8000-0000000007d1',
    '00000000-0000-4000-8000-0000000007c1',
    2,
    DATE '2026-02-10',
    4000.00,
    'CNY'
  ),
  (
    '00000000-0000-4000-8000-0000000007e3',
    '00000000-0000-4000-8000-0000000007d2',
    '00000000-0000-4000-8000-0000000007c2',
    1,
    DATE '2026-01-15',
    5000.00,
    'USD'
  ),
  (
    '00000000-0000-4000-8000-0000000007e4',
    '00000000-0000-4000-8000-0000000007d3',
    '00000000-0000-4000-8000-0000000007c1',
    1,
    DATE '2026-01-20',
    1000.00,
    'USD'
  );


-- 后续断言统一以财务甲身份执行（财务乙只在「换个人审核」那几条里切过去）。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000007b1","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


-- ── R：登记收款 ──────────────────────────────────────────────────────────────
SELECT
  IS (
    ops.record_receipt (
      p_customer_id => '00000000-0000-4000-8000-0000000007c1',
      p_contract_id => '00000000-0000-4000-8000-0000000007d1',
      p_transaction_date => DATE '2026-01-05',
      p_amount => 8000.00,
      p_currency => 'CNY',
      p_method_code => 'bank_transfer',
      p_reference_no => NULL,
      p_voucher_ref => 'VCH-2026-0001',
      p_reason => '收到首期款'
    ) ->> 'status',
    'ok',
    'R1 finance records a receipt'
  );


SELECT
  IS (
    (
      ops.record_receipt (
        p_customer_id => '00000000-0000-4000-8000-0000000007c1',
        p_contract_id => '00000000-0000-4000-8000-0000000007d1',
        p_transaction_date => DATE '2026-01-06',
        p_amount => 5000.00,
        p_currency => 'CNY',
        p_method_code => 'bank_transfer',
        p_reason => '第二笔待审'
      ) ->> 'receipt'
    )::jsonb ->> 'status',
    'recorded',
    'R2 a fresh receipt lands in recorded'
  );


SELECT
  ok (
    (
      ops.record_receipt (
        p_customer_id => '00000000-0000-4000-8000-0000000007c1',
        p_contract_id => '00000000-0000-4000-8000-0000000007d1',
        p_transaction_date => DATE '2026-01-07',
        p_amount => 1000.00,
        p_currency => 'CNY',
        p_method_code => 'cash',
        p_reason => '现金收款'
      ) ->> 'receipt'
    )::jsonb ->> 'receipt_no' LIKE 'SK-%',
    'R3 the receipt number is minted by the sequence with the SK- prefix'
  );


SELECT
  IS (
    ops.record_receipt (
      p_customer_id => '00000000-0000-4000-8000-0000000007c1',
      p_contract_id => NULL,
      p_transaction_date => DATE '2026-01-08',
      p_amount => 4000.00,
      p_currency => 'CNY',
      p_method_code => 'bank_transfer',
      p_reason => '第四笔待驳'
    ) ->> 'status',
    'ok',
    'R4 a receipt without a contract is legal'
  );


SELECT
  IS (
    ops.record_receipt (
      p_customer_id => '00000000-0000-4000-8000-0000000007c1',
      p_contract_id => NULL,
      p_transaction_date => DATE '2026-01-08',
      p_amount => -1.00,
      p_currency => 'CNY',
      p_method_code => 'cash',
      p_reason => '负数'
    ) ->> 'status',
    'amount_invalid',
    'R5 a negative amount is rejected'
  );


SELECT
  IS (
    ops.record_receipt (
      p_customer_id => '00000000-0000-4000-8000-0000000007c1',
      p_contract_id => NULL,
      p_transaction_date => DATE '2026-01-08',
      p_amount => 100.005,
      p_currency => 'CNY',
      p_method_code => 'cash',
      p_reason => '三位小数'
    ) ->> 'status',
    'amount_scale_invalid',
    'R6 more than two decimals is rejected instead of being rounded away'
  );


SELECT
  IS (
    ops.record_receipt (
      p_customer_id => '00000000-0000-4000-8000-0000000007c1',
      p_contract_id => NULL,
      p_transaction_date => DATE '2026-01-08',
      p_amount => 100.00,
      p_currency => 'CNY',
      p_method_code => 'cash',
      p_reason => '   '
    ) ->> 'status',
    'reason_required',
    'R7 a whitespace-only reason does not count as a reason'
  );


SELECT
  IS (
    ops.record_receipt (
      p_customer_id => '00000000-0000-4000-8000-0000000007ff',
      p_contract_id => NULL,
      p_transaction_date => DATE '2026-01-08',
      p_amount => 100.00,
      p_currency => 'CNY',
      p_method_code => 'cash',
      p_reason => '不存在的客户'
    ) ->> 'status',
    'customer_not_found',
    'R8 an unknown customer is reported by name, not by foreign key error'
  );


SELECT
  IS (
    ops.record_receipt (
      p_customer_id => '00000000-0000-4000-8000-0000000007c2',
      p_contract_id => '00000000-0000-4000-8000-0000000007d1',
      p_transaction_date => DATE '2026-01-08',
      p_amount => 100.00,
      p_currency => 'CNY',
      p_method_code => 'cash',
      p_reason => '合同不是这家客户的'
    ) ->> 'status',
    'customer_mismatch',
    'R9 a contract that belongs to another customer is refused'
  );


SELECT
  IS (
    ops.record_receipt (
      p_customer_id => '00000000-0000-4000-8000-0000000007c1',
      p_contract_id => '00000000-0000-4000-8000-0000000007d1',
      p_transaction_date => DATE '2026-01-08',
      p_amount => 100.00,
      p_currency => 'USD',
      p_method_code => 'cash',
      p_reason => '币种与合同不符'
    ) ->> 'status',
    'currency_mismatch',
    'R10 a currency that disagrees with the contract is refused'
  );


SELECT
  IS (
    ops.record_receipt (
      p_customer_id => '00000000-0000-4000-8000-0000000007c1',
      p_contract_id => '00000000-0000-4000-8000-0000000007d1',
      p_transaction_date => DATE '2026-01-09',
      p_amount => 600.00,
      p_currency => 'CNY',
      p_method_code => 'bank_transfer',
      p_reference_no => 'BK-9001',
      p_reason => '流水号重复测试'
    ) ->> 'status',
    'ok',
    'R11 a first receipt with a bank reference is accepted'
  );


SELECT
  IS (
    ops.record_receipt (
      p_customer_id => '00000000-0000-4000-8000-0000000007c1',
      p_contract_id => '00000000-0000-4000-8000-0000000007d1',
      p_transaction_date => DATE '2026-01-09',
      p_amount => 600.00,
      p_currency => 'CNY',
      p_method_code => 'bank_transfer',
      p_reference_no => 'BK-9001',
      p_reason => '同一笔钱录了第二遍'
    ) ->> 'status',
    'duplicate_reference',
    'R12 the very same receipt recorded twice is refused'
  );


SELECT
  IS (
    jsonb_array_length(
      (
        ops.record_receipt (
          p_customer_id => '00000000-0000-4000-8000-0000000007c1',
          p_contract_id => '00000000-0000-4000-8000-0000000007d1',
          p_transaction_date => DATE '2026-01-10',
          p_amount => 700.00,
          p_currency => 'CNY',
          p_method_code => 'bank_transfer',
          p_reference_no => 'BK-9001',
          p_reason => '同流水号但金额不同'
        ) ->> 'duplicate_warnings'
      )::jsonb
    ),
    1,
    'R13 the same reference with a different amount only produces a warning'
  );


-- ── 夹具 id 存进会话变量 ────────────────────────────────────────────────────
-- 从这里开始不再直读业务表：`authenticated` 对 `ops.receipts` 等表没有 SELECT
-- 权限（REVOKE + RLS 双保险），直读会得到 permission denied 而不是断言失败。
-- 以超级用户读一次把 id 存进会话级 GUC，后面的断言一律 `current_setting(...)::uuid`。
RESET ROLE;


SELECT
  set_config(
    'billing.p1',
    (
      SELECT
        id::text
      FROM
        ops.receipts
      WHERE
        amount = 8000.00
    ),
    FALSE
  ),
  set_config(
    'billing.p2',
    (
      SELECT
        id::text
      FROM
        ops.receipts
      WHERE
        amount = 5000.00
    ),
    FALSE
  ),
  set_config(
    'billing.p3',
    (
      SELECT
        id::text
      FROM
        ops.receipts
      WHERE
        amount = 1000.00
    ),
    FALSE
  ),
  set_config(
    'billing.p4',
    (
      SELECT
        id::text
      FROM
        ops.receipts
      WHERE
        amount = 4000.00
    ),
    FALSE
  ),
  set_config(
    'billing.p5',
    (
      SELECT
        id::text
      FROM
        ops.receipts
      WHERE
        amount = 600.00
    ),
    FALSE
  );


SET
  local role authenticated;


-- ── T：审核与驳回 ────────────────────────────────────────────────────────────
-- 收款甲是登记人，换到收款乙去审核。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000007b2","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    ops.transition_receipt (
      current_setting('billing.p1')::uuid,
      'approve',
      '审核通过',
      1
    ) ->> 'status',
    'ok',
    'T1 a different operator may approve the receipt'
  );


SELECT
  IS (
    (
      ops.get_receipt (current_setting('billing.p1')::uuid) -> 'receipt' ->> 'status'
    ),
    'pending_reconcile',
    'T2 approving moves the receipt to pending_reconcile'
  );


SELECT
  IS (
    ops.transition_receipt (
      current_setting('billing.p1')::uuid,
      'approve',
      '重复审核',
      NULL
    ) ->> 'status',
    'invalid_transition',
    'T3 approving twice is refused'
  );


SELECT
  IS (
    ops.transition_receipt (
      current_setting('billing.p1')::uuid,
      'reject',
      '已通过还想驳回',
      NULL
    ) ->> 'status',
    'invalid_transition',
    'T4 a receipt past recorded cannot be rejected'
  );


-- 换回登记人自己审：这是被职责分离挡住的那一条。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000007b1","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    ops.transition_receipt (
      current_setting('billing.p2')::uuid,
      'approve',
      '自己审自己',
      1
    ) ->> 'status',
    'segregation_of_duty',
    'T5 the recorder cannot approve their own receipt'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000007b2","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    ops.transition_receipt (
      current_setting('billing.p2')::uuid,
      'approve',
      '别人来审',
      99
    ) ->> 'status',
    'version_mismatch',
    'T6 a stale version is refused before any state change'
  );


SELECT
  IS (
    (
      ops.transition_receipt (
        current_setting('billing.p4')::uuid,
        'reject',
        '凭证看不清，退回去重填',
        NULL
      ) ->> 'receipt'
    )::jsonb ->> 'status',
    'recorded',
    'T7 rejecting keeps the receipt in recorded instead of deleting it'
  );


SELECT
  IS (
    (
      SELECT
        count(*)
      FROM
        ops.audit_events
      WHERE
        action = 'receipt.rejected'
    )::int,
    1,
    'T8 the rejection is written to the audit trail with its reason'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000007b1","role":"authenticated"}',
    TRUE
  );


-- ── A：核销的四类拒绝与成功路径 ──────────────────────────────────────────────
SELECT
  IS (
    ops.allocate_receipt (
      current_setting('billing.p2')::uuid,
      jsonb_build_array(
        jsonb_build_object(
          'receivableId',
          '00000000-0000-4000-8000-0000000007e1',
          'amount',
          1000
        )
      ),
      '未审核就核销'
    ) ->> 'status',
    'receipt_not_approved',
    'A1 an unapproved receipt cannot be reconciled'
  );


SELECT
  IS (
    ops.allocate_receipt (
      current_setting('billing.p1')::uuid,
      jsonb_build_array(
        jsonb_build_object(
          'receivableId',
          '00000000-0000-4000-8000-0000000007e1',
          'amount',
          9000
        )
      ),
      '超过收款额'
    ) ->> 'status',
    'receipt_exceeded',
    'A2 allocating more than the receipt holds is refused'
  );


SELECT
  IS (
    ops.allocate_receipt (
      current_setting('billing.p1')::uuid,
      jsonb_build_array(
        jsonb_build_object(
          'receivableId',
          '00000000-0000-4000-8000-0000000007e3',
          'amount',
          1000
        )
      ),
      '核销到别家的应收'
    ) ->> 'status',
    'customer_mismatch',
    'A3 a receivable that belongs to another customer is refused'
  );


SELECT
  IS (
    ops.allocate_receipt (
      current_setting('billing.p1')::uuid,
      jsonb_build_array(
        jsonb_build_object(
          'receivableId',
          '00000000-0000-4000-8000-0000000007e4',
          'amount',
          1000
        )
      ),
      '核销到美元应收'
    ) ->> 'status',
    'currency_mismatch',
    'A4 a receivable in another currency is refused'
  );


SELECT
  IS (
    ops.allocate_receipt (
      current_setting('billing.p1')::uuid,
      jsonb_build_array(
        jsonb_build_object(
          'receivableId',
          '00000000-0000-4000-8000-0000000007e2',
          'amount',
          5000
        )
      ),
      '超过该期余额'
    ) ->> 'status',
    'receivable_exceeded',
    'A5 allocating more than one period still owes is refused'
  );


SELECT
  IS (
    ops.allocate_receipt (
      current_setting('billing.p1')::uuid,
      jsonb_build_array(
        jsonb_build_object(
          'receivableId',
          '00000000-0000-4000-8000-0000000007e1',
          'amount',
          400
        ),
        jsonb_build_object(
          'receivableId',
          '00000000-0000-4000-8000-0000000007e1',
          'amount',
          400
        )
      ),
      '同一期写了两遍'
    ) ->> 'status',
    'duplicate_receivable',
    'A6 the same period listed twice cannot each pass the balance check'
  );


SELECT
  IS (
    ops.allocate_receipt (
      current_setting('billing.p1')::uuid,
      jsonb_build_array(
        jsonb_build_object(
          'receivableId',
          '00000000-0000-4000-8000-0000000007ef',
          'amount',
          400
        )
      ),
      '不存在的应收'
    ) ->> 'status',
    'receivable_not_found',
    'A7 an unknown receivable is reported instead of dying on a foreign key'
  );


SELECT
  IS (
    ops.allocate_receipt (
      current_setting('billing.p1')::uuid,
      '[]'::jsonb,
      '空核销'
    ) ->> 'status',
    'allocations_required',
    'A8 an empty allocation list is refused'
  );


SELECT
  IS (
    (
      ops.allocate_receipt (
        current_setting('billing.p1')::uuid,
        jsonb_build_array(
          jsonb_build_object(
            'receivableId',
            '00000000-0000-4000-8000-0000000007e1',
            'amount',
            8000
          )
        ),
        '首期全额核销'
      ) ->> 'receipt'
    )::jsonb ->> 'status',
    'reconciled',
    'A9 a successful allocation moves the receipt to reconciled'
  );


SELECT
  IS (
    (
      ops.get_receivable ('00000000-0000-4000-8000-0000000007e1') -> 'receivable' ->> 'allocated_amount'
    )::numeric,
    8000.00::numeric,
    'A10 the period balance is raised in the same transaction'
  );


SELECT
  IS (
    (
      ops.get_receipt (current_setting('billing.p1')::uuid) -> 'receipt' ->> 'allocated_amount'
    )::numeric,
    8000.00::numeric,
    'A11 the receipt reports its reconciled net amount'
  );


-- ── V：撤销核销 ──────────────────────────────────────────────────────────────
SELECT
  IS (
    ops.reverse_allocation (
      (
        (
          ops.get_receipt (current_setting('billing.p1')::uuid) -> 'allocations'
        ) -> 0 ->> 'id'
      )::uuid,
      3000.00,
      '客户少付了一部分，先撤回来'
    ) ->> 'status',
    'ok',
    'V1 a partial reversal is accepted'
  );


SELECT
  IS (
    (
      ops.get_receivable ('00000000-0000-4000-8000-0000000007e1') -> 'receivable' ->> 'reversed_amount'
    )::numeric,
    3000.00::numeric,
    'V2 the reversal is accumulated, not subtracted from the allocation'
  );


SELECT
  IS (
    (
      ops.get_receivable ('00000000-0000-4000-8000-0000000007e1') -> 'receivable' ->> 'allocated_amount'
    )::numeric,
    8000.00::numeric,
    'V3 the gross allocation column keeps its high-water mark'
  );


SELECT
  IS (
    ops.reverse_allocation (
      (
        (
          ops.get_receipt (current_setting('billing.p1')::uuid) -> 'allocations'
        ) -> 0 ->> 'id'
      )::uuid,
      6000.00,
      '撤超过剩余可撤额'
    ) ->> 'status',
    'reversal_exceeded',
    'V4 a reversal beyond what is left is refused'
  );


-- 撤销之后重新核销同一期：这正是旧约束 `allocated BETWEEN 0 AND amount` 会
-- 卡死的那条路（毛额 8000 已经顶满，再加 3000 就超过 8000）。
SELECT
  IS (
    ops.allocate_receipt (
      current_setting('billing.p1')::uuid,
      jsonb_build_array(
        jsonb_build_object(
          'receivableId',
          '00000000-0000-4000-8000-0000000007e1',
          'amount',
          3000
        )
      ),
      '撤销之后重新核销'
    ) ->> 'status',
    'ok',
    'V5 re-allocating after a reversal is allowed'
  );


SELECT
  IS (
    (
      ops.get_receivable ('00000000-0000-4000-8000-0000000007e1') -> 'receivable' ->> 'allocated_amount'
    )::numeric,
    11000.00::numeric,
    'V6 the gross column may exceed the period amount once a reversal exists'
  );


SELECT
  IS (
    (
      ops.get_receipt (current_setting('billing.p1')::uuid) -> 'receipt' ->> 'allocated_amount'
    )::numeric,
    8000.00::numeric,
    'V7 the net amount is back to the receipt total'
  );


-- ── S：冲正收款 ──────────────────────────────────────────────────────────────
SELECT
  IS (
    ops.reverse_receipt (
      current_setting('billing.p1')::uuid,
      '客户退款走别的渠道',
      NULL
    ) ->> 'status',
    'has_allocations',
    'S1 a receipt with live allocations cannot be reversed'
  );


SELECT
  IS (
    ops.reverse_receipt (current_setting('billing.p3')::uuid, '   ', NULL) ->> 'status',
    'reason_required',
    'S2 reversing without a reason is refused'
  );


SELECT
  IS (
    (
      ops.reverse_receipt (
        current_setting('billing.p3')::uuid,
        '现金收错了客户',
        NULL
      ) ->> 'receipt'
    )::jsonb ->> 'status',
    'reversed',
    'S3 a receipt without allocations is reversed'
  );


SELECT
  IS (
    ops.reverse_receipt (
      current_setting('billing.p3')::uuid,
      'again',
      NULL
    ) ->> 'status',
    'invalid_transition',
    'S4 reversing twice is refused'
  );


-- ── F：退款 ──────────────────────────────────────────────────────────────────
SELECT
  IS (
    ops.record_refund (
      current_setting('billing.p2')::uuid,
      100.00,
      DATE '2026-01-20',
      '未审核的收款想退款'
    ) ->> 'status',
    'refund_exceeded',
    'F1 an unapproved receipt has nothing refundable'
  );


SELECT
  IS (
    (
      ops.record_refund (
        current_setting('billing.p1')::uuid,
        9000.00,
        DATE '2026-01-20',
        '退超过已核销额'
      ) ->> 'refundable'
    )::numeric,
    8000.00,
    'F2 the refusal reports how much is actually refundable'
  );


SELECT
  IS (
    (
      ops.record_refund (
        current_setting('billing.p1')::uuid,
        3000.00,
        DATE '2026-01-21',
        '部分退款',
        'OUT-0001'
      ) ->> 'refund'
    )::jsonb ->> 'status',
    'recorded',
    'F3 a refund is recorded as a fact'
  );


SELECT
  IS (
    (
      ops.record_refund (
        current_setting('billing.p1')::uuid,
        1000.00,
        DATE '2026-01-22',
        '登记后又不想退了'
      ) ->> 'refund'
    )::jsonb ->> 'refund_no' LIKE 'RT-%',
    TRUE,
    'F4 the refund number is minted with the RT- prefix'
  );


-- 两笔退款（一笔待审、一笔待取消）也要存 id，理由同上。
RESET ROLE;


SELECT
  set_config(
    'billing.r1',
    (
      SELECT
        id::text
      FROM
        ops.refunds
      WHERE
        amount = 3000.00
        AND refund_date = DATE '2026-01-21'
    ),
    FALSE
  ),
  set_config(
    'billing.r2',
    (
      SELECT
        id::text
      FROM
        ops.refunds
      WHERE
        amount = 1000.00
        AND refund_date = DATE '2026-01-22'
    ),
    FALSE
  );


SET
  local role authenticated;


SELECT
  IS (
    (
      ops.transition_refund (
        current_setting('billing.r2')::uuid,
        'cancel',
        '客户改主意，这笔不退了'
      ) ->> 'refund'
    )::jsonb ->> 'status',
    'cancelled',
    'F5 a recorded refund can be cancelled'
  );


SELECT
  IS (
    (
      ops.get_receipt (current_setting('billing.p1')::uuid) -> 'receipt' ->> 'status'
    ),
    'reconciled',
    'F6 cancelling a refund does not touch the receipt'
  );


SELECT
  IS (
    (
      ops.transition_refund (
        current_setting('billing.r1')::uuid,
        'approve',
        '审核通过'
      ) ->> 'refund'
    )::jsonb ->> 'status',
    'approved',
    'F7 approving a refund moves it out of recorded'
  );


SELECT
  IS (
    (
      SELECT
        (entry ->> 'approved_by') IS NOT NULL
      FROM
        jsonb_array_elements(
          (
            ops.get_receipt (current_setting('billing.p1')::uuid) ->> 'refunds'
          )::jsonb
        ) AS entry
      WHERE
        (entry ->> 'amount')::numeric = 3000.00
    ),
    TRUE,
    'F8 the approver is stored on the refund'
  );


SELECT
  IS (
    (
      ops.get_receipt (current_setting('billing.p1')::uuid) -> 'receipt' ->> 'status'
    ),
    'reconciled',
    'F9 an approved partial refund still leaves the receipt reconciled'
  );


SELECT
  IS (
    ops.transition_refund (
      current_setting('billing.r1')::uuid,
      'approve',
      '重复审核'
    ) ->> 'status',
    'invalid_transition',
    'F10 a refund can only be decided once'
  );


-- 第二笔退款：登记与审核分两步，顺便把 id 从响应里存下来（不直读表）。
WITH
  created AS (
    SELECT
      ops.record_refund (
        current_setting('billing.p1')::uuid,
        5000.00,
        DATE '2026-01-23',
        '退满剩下的五千'
      ) AS payload
  )
SELECT
  IS (
    payload -> 'refund' ->> 'status',
    'recorded',
    'F11 a second refund is recorded against the same receipt'
  ),
  set_config('billing.r3', payload -> 'refund' ->> 'id', FALSE)
FROM
  created;


SELECT
  IS (
    (
      ops.transition_refund (
        current_setting('billing.r3')::uuid,
        'approve',
        '退满剩下的五千'
      ) -> 'receipt' ->> 'status'
    ),
    'refunded',
    'F12 approving the last refund moves the receipt to refunded'
  );


SELECT
  IS (
    ops.record_refund (
      current_setting('billing.p1')::uuid,
      100.00,
      DATE '2026-01-24',
      '退满之后再退'
    ) ->> 'status',
    'refund_exceeded',
    'F13 nothing is refundable once the receipt is fully refunded'
  );


-- ── G：详情与列表 ────────────────────────────────────────────────────────────
SELECT
  IS (
    jsonb_array_length(
      (
        ops.get_receipt (current_setting('billing.p1')::uuid) ->> 'allocations'
      )::jsonb
    ),
    2,
    'G1 the receipt detail lists both allocation rows'
  );


SELECT
  IS (
    jsonb_array_length(
      (
        ops.get_receipt (current_setting('billing.p1')::uuid) ->> 'refunds'
      )::jsonb
    ),
    3,
    'G2 the receipt detail lists its refunds, cancelled ones included'
  );


SELECT
  IS (
    jsonb_array_length(
      (
        ops.get_receipt (current_setting('billing.p1')::uuid) ->> 'reversals'
      )::jsonb
    ),
    1,
    'G3 the receipt detail lists the reversal against it'
  );


SELECT
  IS (
    ops.get_receipt ('00000000-0000-4000-8000-0000000007ff') ->> 'status',
    'receipt_not_found',
    'G4 an unknown receipt is reported as such'
  );


SELECT
  IS (
    ops.list_refunds (
      p_customer_id => '00000000-0000-4000-8000-0000000007c1'
    ) ->> 'total',
    -- F1 / F2 / F12 被挡下、没有落库；已取消的那笔仍在列表里（它是一段事实）。
    '3',
    'G5 the refund list counts only the refunds that were actually recorded'
  );


SELECT
  IS (
    ops.list_receipts (
      p_customer_id => '00000000-0000-4000-8000-0000000007c1',
      p_statuses => ARRAY['refunded']
    ) ->> 'total',
    '1',
    'G6 the status filter accepts several values'
  );


SELECT
  IS (
    ops.list_receipts (
      p_customer_id => '00000000-0000-4000-8000-0000000007c2'
    ) ->> 'total',
    '0',
    'G7 customer isolation holds in the list'
  );


SELECT
  IS (
    ops.list_receipts (p_date_from => DATE '2026-02-01') ->> 'total',
    '0',
    'G8 the date window is applied'
  );


SELECT
  IS (
    ops.list_receipts (
      p_customer_id => '00000000-0000-4000-8000-0000000007c1',
      p_method_code => 'cash'
    ) ->> 'total',
    '1',
    'G9 the method filter narrows to the cash receipt'
  );


-- 审计断言必须切回超级用户：`ops.audit_events` 同样不给 authenticated 读权限。
RESET ROLE;


-- ── U：审计 ──────────────────────────────────────────────────────────────────
SELECT
  IS (
    (
      SELECT
        count(*)
      FROM
        ops.audit_events
      WHERE
        action = 'receipt.approved'
    )::int,
    1,
    'U1 approval is audited once'
  );


SELECT
  IS (
    (
      SELECT
        count(*)
      FROM
        ops.audit_events
      WHERE
        action = 'receipt.reconciled'
    )::int,
    2,
    'U2 every reconciliation round leaves one audit event'
  );


SELECT
  IS (
    (
      SELECT
        count(*)
      FROM
        ops.audit_events
      WHERE
        action = 'receipt.reversed'
    )::int,
    1,
    'U3 a reversal is audited'
  );


SELECT
  IS (
    (
      SELECT
        count(*)
      FROM
        ops.audit_events
      WHERE
        action = 'refund.approved'
    )::int,
    2,
    'U4 both approved refunds are audited'
  );


SELECT
  IS (
    (
      SELECT
        reason
      FROM
        ops.audit_events
      WHERE
        action = 'receipt.rejected'
    ),
    '凭证看不清，退回去重填',
    'U5 the rejection reason is kept verbatim on the audit event'
  );


SELECT
  IS (
    (
      SELECT
        entity_type
      FROM
        ops.audit_events
      WHERE
        action = 'receipt.allocation_reversed'
    ),
    'receipt_allocation',
    'U6 the reversal is attached to the allocation, not to the receipt'
  );


RESET ROLE;


-- ── N：表约束（以超级用户直写，绕过 RPC）────────────────────────────────────
SELECT
  throws_ok (
    $$
      insert into ops.receipts (
        customer_id, transaction_date, amount, currency, method_code,
        recorded_by, approved_by, approved_at, recorded_reason, status
      ) values (
        '00000000-0000-4000-8000-0000000007c1', DATE '2026-01-25', 100, 'CNY', 'cash',
        '00000000-0000-4000-8000-0000000007a1',
        '00000000-0000-4000-8000-0000000007a1', now(),
        '自审', 'recorded'
      )
    $$,
    '23514',
    NULL,
    'N1 the database refuses self-approval even when the RPC is bypassed'
  );


SELECT
  throws_ok (
    $$
      insert into ops.receipt_allocations (
        receipt_id, receivable_id, amount, customer_id, currency, allocated_by
      ) values (
        (select id from ops.receipts where amount = 600.00 limit 1),
        '00000000-0000-4000-8000-0000000007e1',
        100,
        -- 故意写错客户：复合外键必须挡住
        '00000000-0000-4000-8000-0000000007c2',
        'CNY',
        '00000000-0000-4000-8000-0000000007a1'
      )
    $$,
    '23503',
    NULL,
    'N2 a cross-customer allocation is impossible at the database level'
  );


SELECT
  throws_ok (
    $$
      insert into ops.receipt_allocations (
        receipt_id, receivable_id, amount, customer_id, currency, allocated_by
      ) values (
        (select id from ops.receipts where amount = 600.00 limit 1),
        '00000000-0000-4000-8000-0000000007e4',
        100,
        '00000000-0000-4000-8000-0000000007c1',
        'CNY',
        '00000000-0000-4000-8000-0000000007a1'
      )
    $$,
    '23503',
    NULL,
    'N3 a cross-currency allocation is impossible at the database level'
  );


SELECT
  throws_ok (
    $$
      update ops.receivables
      set allocated_amount = 12000
      where id = '00000000-0000-4000-8000-0000000007e2'
    $$,
    '23514',
    NULL,
    'N4 the period balance still cannot exceed its amount without a reversal'
  );


SELECT
  throws_ok (
    $$
      update ops.receivables
      set reversed_amount = 100
      where id = '00000000-0000-4000-8000-0000000007e2'
    $$,
    '23514',
    NULL,
    'N5 a reversal larger than the allocation is refused by the check'
  );


SELECT
  throws_ok (
    $$
      insert into ops.refunds (
        receipt_id, customer_id, amount, currency, refund_date, reason, handled_by
      ) values (
        (select id from ops.receipts where amount = 5000.00 limit 1),
        '00000000-0000-4000-8000-0000000007c1', 0, 'CNY', DATE '2026-01-26', '零元退款',
        '00000000-0000-4000-8000-0000000007a1'
      )
    $$,
    '23514',
    NULL,
    'N6 a zero refund is refused by the table'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000007b3","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


-- ── X：权限 ──────────────────────────────────────────────────────────────────
SELECT
  throws_ok (
    $$select ops.record_receipt ('00000000-0000-4000-8000-0000000007c1', NULL, DATE '2026-01-27', 100, 'CNY', 'cash', NULL, NULL, '只读想登记')$$,
    '42501',
    NULL,
    'X1 a viewer cannot record a receipt'
  );


SELECT
  throws_ok (
    $$select ops.allocate_receipt ('00000000-0000-4000-8000-0000000007ff', '[]'::jsonb, NULL)$$,
    '42501',
    NULL,
    'X2 a viewer cannot reconcile'
  );


SELECT
  IS (
    jsonb_typeof(ops.list_receipts ()),
    'object',
    'X3 the viewer may still read the list'
  );


RESET ROLE;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000007b4","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  throws_ok (
    $$select ops.list_refunds ()$$,
    '42501',
    NULL,
    'X4 an operator with no role cannot even read refunds'
  );


RESET ROLE;


SELECT
  finish ();


ROLLBACK;