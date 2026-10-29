/**
 * 全局错误提示出口。
 *
 * 做成可替换的出口，是为了让单测在不加载 UI 组件库的前提下断言"是否提示"，
 * 同时保持生产态单点提示，避免各业务模块各自弹 toast 造成重复告警。
 */
import type { OpsApiError } from './errors';

export type OpsErrorNotifier = (error: OpsApiError) => void;

let customNotifier: OpsErrorNotifier | undefined;

const antdNotifier: OpsErrorNotifier = (error) => {
  void import('ant-design-vue')
    .then((module) => {
      module.message.error(error.userMessage);
    })
    .catch((error_: unknown) => {
      // 提示通道故障不能影响请求链路，只降级到控制台

      console.warn('ops error notifier unavailable', error_);
    });
};

export function setOpsErrorNotifier(
  notifier: OpsErrorNotifier | undefined,
): void {
  customNotifier = notifier;
}

export function notifyOpsError(error: OpsApiError): void {
  (customNotifier ?? antdNotifier)(error);
}
