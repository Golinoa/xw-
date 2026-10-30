/**
 * 治理与审计四页的「真的渲染了」验证（契约桩）。
 *
 * 为什么要有这一层：单测覆盖的是纯逻辑与桩的不变量，**不覆盖**「页面挂上去是否白屏、
 * 表格是否真的有行」。占位页换成真实页面时，最容易出现的就是「编译通过、页面空白」。
 *
 * 断言只用两类锚点：
 * 1. 页面上独有的业务文案（区块标题、虚构邮箱、导出任务号）；
 * 2. 桩数据里的确定性取值（夹具固定，不随时间变化）。
 * 不使用 CSS 层级，也不等待动画。
 */
import { expect, test } from '@playwright/test';

import { loginAsStub, stubBanner } from '../support/auth';

test.describe('治理与审计（契约桩）', () => {
  test('账号与角色：成员表格有行，角色表标出系统角色', async ({ page }) => {
    await loginAsStub(page);
    await expect(stubBanner(page)).toBeVisible();

    await page.goto('/governance/operators');

    await expect(page.getByText('运营成员', { exact: true })).toBeVisible();
    // 夹具固定成员（虚构保留域名）
    await expect(page.getByText('admin.chen@example.invalid')).toBeVisible();
    // 成员表格确实渲染出了行（占位页换真实页时最常见的故障是「编译通过但表格空/白屏」）
    await expect(page.locator('tbody tr.ant-table-row').first()).toBeVisible();
    // 角色表里必须有「系统角色」标记（预置 6 个角色）
    await expect(page.getByText('系统角色').first()).toBeVisible();
    // 「平台管理员」同时出现在成员行的角色标签与角色表名称里，取第一个即可
    await expect(
      page.getByText('平台管理员', { exact: true }).first(),
    ).toBeVisible();
  });

  test('系统设置：三项设置与字典都渲染，且有范围说明', async ({ page }) => {
    await loginAsStub(page);
    await page.goto('/governance/settings');

    await expect(page.getByText('临期权益窗口')).toBeVisible();
    await expect(page.getByText('工单内部时限')).toBeVisible();
    await expect(page.getByText('导出产物保留')).toBeVisible();
    // 契约未给上限这件事必须写在界面上，否则运营会以为前端漏了校验
    await expect(page.getByText(/导出保留天数契约未定义上限/)).toBeVisible();

    // 字典：收款方式 + 工单问题类型
    await expect(page.getByText('收款方式')).toBeVisible();
    await expect(page.getByText('bank_transfer')).toBeVisible();
    await expect(page.getByText('工单问题类型')).toBeVisible();
  });

  test('审计日志：时间倒序列表、未登记动作原样显示', async ({ page }) => {
    await loginAsStub(page);
    await page.goto('/audit/events');

    await expect(
      page.getByText('只读事实 · 仅追加 · 固定按时间倒序'),
    ).toBeVisible();
    await expect(page.getByText('发起数据导出')).toBeVisible();
    // 夹具刻意留了一个未登记动作：不得渲染成空白，必须原样显示动作码
    await expect(
      page.getByText('tenant.command.replayed').first(),
    ).toBeVisible();
    await expect(page.getByText('未登记动作').first()).toBeVisible();
  });

  test('导出任务：列表有任务号与状态标签，排队/生成态的提示存在', async ({
    page,
  }) => {
    await loginAsStub(page);
    await page.goto('/audit/exports');

    await expect(page.getByText('EX-2026-000012')).toBeVisible();
    await expect(page.getByText('已完成').first()).toBeVisible();
    // 夹具里有 running / queued 任务，页面应给出「进行中」提示条
    await expect(page.getByText(/个任务正在排队或生成中/)).toBeVisible();
    // 下载链接有效期的说明必须在页面上，避免运营误以为链接长期可用
    await expect(page.getByText('下载链接 5 分钟内有效')).toBeVisible();
  });
});
