import { LEAD_STAGES, type LeadStage } from '@erp/contracts';

/** 机器值 → i18n 文案键。漏斗与表格共用同一份，避免两处口径分叉。 */
export const LEAD_STAGE_LABEL_KEYS: Record<LeadStage, string> = {
  contacting: 'shell.leads.stageContacting',
  lost: 'shell.leads.stageLost',
  new: 'shell.leads.stageNew',
  proposal: 'shell.leads.stageProposal',
  quoting: 'shell.leads.stageQuoting',
  won: 'shell.leads.stageWon',
};

export const LEAD_STAGES_ORDER: readonly LeadStage[] = LEAD_STAGES;

export function stageLabelKey(value: unknown): string {
  if (typeof value !== 'string') return '';
  return (LEAD_STAGE_LABEL_KEYS as Record<string, string>)[value] ?? value;
}

/** 只有 won 阶段的线索能转客户/转订单；未成单就开单等于绕过漏斗。 */
export function canConvert(stage: LeadStage): boolean {
  return stage === 'won';
}
