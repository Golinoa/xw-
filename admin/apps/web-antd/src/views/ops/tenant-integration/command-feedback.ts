/**
 * 命令受理结果的**展示文案**（视图层）。
 *
 * 为什么单独抽出来：202 的语义是「已受理」，不是「成功」。这句话必须
 * 在每个出口完全一致（映射详情、命令详情、重试），否则运营会把
 * 「命令已入队」误读成「租户已开通」。抽成纯函数后可被单测直接断言。
 */
import type { TenantCommandAccepted } from '#/api/ops/tenant/types';

import { commandStatusView } from '#/api/ops/tenant/format';

/** 受理提示的统一前缀（单测断言用，不要改成分散字符串）。 */
export const ACCEPTED_PREFIX = '已受理，结果待确认';

/**
 * 生成受理提示。
 *
 * 注意：即使服务端返回 `status='succeeded'`（幂等重放既有成功命令），
 * 文案也只说「已受理 + 当前状态」，由状态标签表达结果，不用「成功」字样
 * 掩盖「本次没有真正执行」。
 */
export function describeAcceptedCommand(result: TenantCommandAccepted): string {
  const statusLabel = commandStatusView(result.status).label;
  const identity = result.commandNo ?? result.commandId;
  const replay = result.replayed
    ? '命中幂等重放，本次没有新建命令。'
    : '命令已进入待执行队列，最终结果以命令状态与尝试记录为准。';
  return `${ACCEPTED_PREFIX}：命令 ${identity} 当前状态「${statusLabel}」。${replay}`;
}

/** 重试受理提示（202）。 */
export function describeRetryAccepted(commandNo: string): string {
  return `${ACCEPTED_PREFIX}：命令 ${commandNo} 的重试已受理。请稍后刷新查看最新尝试记录，重试结果可能仍失败。`;
}
