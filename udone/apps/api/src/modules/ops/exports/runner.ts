import type { Context } from 'hono';
import type { ApiEnvironment } from '../../../middleware/auth';
import {
  putStorageObject,
  createSignedUpload,
  STORAGE_BUCKETS,
  StorageSignError,
} from '../storage/sign';
import {
  exportAbortEnvelopeSchema,
  exportClaimEnvelopeSchema,
  exportFinishEnvelopeSchema,
  exportRowsEnvelopeSchema,
} from './protocol';
import { callOpsExportRpc } from './rpc';

/**
 * 导出执行器（懒执行）。
 *
 * 为什么没有后台 worker：本地栈与刚部署的线上都没有队列，一个「已经排队但
 * 永远没人跑」的任务比一个明确失败的任务更难查。所以执行挂在**读请求**上：
 * `GET /exports` 与 `GET /exports/{id}` 各自先认领并跑掉最早的一条，再返回。
 * 代价是一次列表请求可能多花几百毫秒；换来的是「没有幽灵 queued」。
 *
 * 三条硬约束：
 *
 * 1. **取数据的权限按发起人判，不按触发者。** 见迁移里的注释；这里只保证
 *    调用 `export_fetch_rows` 时不把触发者的身份塞进去。
 * 2. **失败必须落成 `failed`，不能只打日志。** 一个停在 `running` 的任务
 *    会让前端永远转圈，而「任务失败」这件事本身是用户需要知道的。
 * 3. **执行失败不能把读请求打成 5xx。** 列表页要能看到「这条失败了」，而不是
 *    一个错误页——导出坏了不该连带导出列表打不开。
 */

/** 一次请求最多推进几条。1 条是刻意的：没人等的批次跑得越少，读请求越稳。 */
const MAX_RUNS_PER_REQUEST = 1;

/**
 * JSON 行 → CSV。
 *
 * 三件必须做对的小事，每一件都有一个具体的坏结果：
 *
 * - **表头按「首次出现的顺序」收集全部行的键**，不是取第一行。列表 DTO 里
 *   `note`、`reversal` 这类字段是可选的，取第一行会让整列消失，而消失的
 *   方式是不报错。
 * - **值里的逗号、引号、换行要按 RFC 4180 转义**。漏了 `"` 不会报错，
 *   它会让 Excel 把后面几列读串。
 * - **UTF-8 BOM**：没有它，Excel 在中文 Windows 上按 GBK 打开，金额列里
 *   夹的中文全变乱码。这一点在自动化测试里看不出来，只有人打开文件才知道。
 *
 * 嵌套对象（`customer`、`assignee`）序列化成 JSON 字符串而不是展开成
 * `customer.name` 这样的多列：展开要维护一张「哪些字段展开」的清单，而
 * 那张清单一定会落后于 DTO。
 */
export function toCsv(rows: Array<Record<string, unknown>>): string {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }

  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text =
      typeof value === 'object'
        ? JSON.stringify(value)
        : String(value as string | number | boolean);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const lines: string[] = [columns.map(escape).join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => escape(row[column])).join(','));
  }

  // CRLF + BOM：Excel 对两者都有期待，缺 CRLF 的纯 \n 在某些版本里会把一行
  // 拆成多行。
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/**
 * 认领并执行最早的一条待办。
 *
 * 返回 `processed`（跑完的条数，含失败的）与 `failed`。调用方不看返回值——
 * 它是给测试用的。整个函数不抛：任何异常都在这里被翻成一次 `abort_export`。
 */
export async function runPendingExports(
  context: Context<ApiEnvironment>,
  maxRuns: number = MAX_RUNS_PER_REQUEST,
): Promise<{ processed: number; failed: number }> {
  let processed = 0;
  let failed = 0;

  for (let attempt = 0; attempt < maxRuns; attempt += 1) {
    let claimed: Awaited<ReturnType<typeof claimOne>>;
    try {
      claimed = await claimOne(context);
    } catch {
      // 认领失败（库不可用）不该让列表 503：列表本身还能读，只是这次没推进。
      break;
    }
    if (claimed === null) break;

    processed += 1;
    try {
      await executeOne(context, claimed);
    } catch (cause) {
      failed += 1;
      await abortSafely(context, claimed.id, classifyFailure(cause));
    }
  }

  return { processed, failed };
}

type Claimed = {
  id: string;
  exportNo: string;
  exportType: 'receivables' | 'receipts' | 'contracts' | 'customers' | 'tickets';
  filters: Record<string, unknown>;
};

async function claimOne(context: Context<ApiEnvironment>): Promise<Claimed | null> {
  const result = await callOpsExportRpc(context, 'claim_export', {}, exportClaimEnvelopeSchema);
  if (result.status !== 'ok') return null;
  return {
    id: result.export.id,
    exportNo: result.export.export_no,
    exportType: result.export.export_type,
    filters: result.export.filters,
  };
}

async function executeOne(context: Context<ApiEnvironment>, claimed: Claimed): Promise<void> {
  const fetched = await callOpsExportRpc(
    context,
    'export_fetch_rows',
    { p_export_id: claimed.id },
    exportRowsEnvelopeSchema,
  );

  if (fetched.status === 'forbidden') {
    throw new ExportRunError('REQUESTER_LOST_PERMISSION');
  }
  if (fetched.status === 'too_many_rows') {
    throw new ExportRunError('ROW_LIMIT_EXCEEDED');
  }
  if (fetched.status === 'not_running') {
    // 别人先跑完了，或租约把它放回了队列。两种都不该覆盖对方的结果。
    return;
  }
  if (fetched.status === 'not_found') {
    throw new ExportRunError('INTERNAL_ERROR');
  }

  const csv = toCsv(fetched.rows);
  const key = `exports/${claimed.exportNo}.csv`;

  // 空文件也要落盘：一份「0 行」的 CSV 是一个有用的答案（说明这个筛选下确实
  // 没有数据），而一个 failed 的任务会让人以为是筛选写错了。
  const { uploadUrl } = await createSignedUpload(context.env, key, STORAGE_BUCKETS.exports);
  // 直接传字符串而不是 `TextEncoder().encode()`：Workers 的 `BodyInit` 不接受
  // `Uint8Array`（它的联合类型里没有 ArrayBufferView），而字符串 body 会按
  // UTF-8 编码——CSV 里那个 BOM 也已经在字符串开头了。
  await putStorageObject(uploadUrl, csv, 'text/csv; charset=utf-8', {
    bucket: STORAGE_BUCKETS.exports,
    key,
  });

  const finished = await callOpsExportRpc(
    context,
    'finish_export',
    {
      p_export_id: claimed.id,
      p_row_count: fetched.row_count,
      p_storage_path: key,
      p_request_id: context.get('requestId'),
    },
    exportFinishEnvelopeSchema,
  );

  if (finished.status !== 'ok') {
    // 走到这里说明这一行已经不是 running 了（被租约放回队列后别人接手）。
    // 产物已经写进存储，但状态不归这次执行——不覆盖，也不删文件：删掉可能
    // 删的是别人正要完成的那一份。
    return;
  }
}

/** 执行期失败分类。字符串会进审计的 `reason`，所以是稳定值而不是一句话。 */
class ExportRunError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'ExportRunError';
  }
}

function classifyFailure(cause: unknown): string {
  if (cause instanceof ExportRunError) return cause.reason;
  if (cause instanceof StorageSignError) return 'STORAGE_UNAVAILABLE';
  return 'INTERNAL_ERROR';
}

async function abortSafely(
  context: Context<ApiEnvironment>,
  exportId: string,
  reason: string,
): Promise<void> {
  try {
    await callOpsExportRpc(
      context,
      'abort_export',
      { p_export_id: exportId, p_reason: reason, p_request_id: context.get('requestId') },
      exportAbortEnvelopeSchema,
    );
  } catch (cause) {
    // 连「标记失败」都失败了：日志是唯一的记录处。不能抛——调用方是读请求。
    console.error(
      JSON.stringify({
        event: 'ops_export_abort_failed',
        exportId,
        reason,
        requestId: context.get('requestId'),
        message: (cause as Error).message,
      }),
    );
  }
}
