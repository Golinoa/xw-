import { z } from 'zod';

/**
 * 审批流配置（R-APPROVAL-01）。
 *
 * 数据库侧早就有 `organization_approval_flows` 与 `set_approval_flow()`，
 * 缺的一直是 HTTP 与界面：改审批级次只能进数据库，属于运维事故隐患。
 *
 * 步骤权限只允许这三个：它们是「能对财务申请做决定」的真实权限码。
 * 放开成任意字符串，配置错一次就是审批链没人能推。
 */
export const APPROVAL_STEP_PERMISSIONS = [
  'finance.approve',
  'settings.manage',
  'finance.write',
] as const;

export const approvalStepPermissionSchema = z.enum(APPROVAL_STEP_PERMISSIONS);
export type ApprovalStepPermission = z.infer<typeof approvalStepPermissionSchema>;

export const approvalStepSchema = z.object({
  step: z.number().int().min(1).max(3),
  permission: approvalStepPermissionSchema,
});
export type ApprovalStep = z.infer<typeof approvalStepSchema>;

/** 级次从 1 连续编号且不重复：`decide_finance_application` 按 current_step 顺序推进。 */
export const approvalFlowSchema = z
  .object({
    steps: z.array(approvalStepSchema).min(1).max(3),
    allowSelfApproval: z.boolean(),
    allowWithdraw: z.boolean(),
  })
  .superRefine((flow, ctx) => {
    const numbers = flow.steps.map((item) => item.step).sort((left, right) => left - right);
    if (numbers.some((value, index) => value !== index + 1)) {
      ctx.addIssue({
        code: 'custom',
        message: '审批级次必须从 1 开始连续编号',
        path: ['steps'],
      });
    }
  });

export type ApprovalFlow = z.infer<typeof approvalFlowSchema>;
