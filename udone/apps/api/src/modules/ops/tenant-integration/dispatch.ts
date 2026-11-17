import type { ApiEnvironment } from '../../../middleware/auth';
import { createServiceRestClient } from '../../../lib/rest-client';

/**
 * 租户命令派发。
 *
 * 这里只做「认领 → 下发 → 回写」这条链的编排，三件事各自可替换：
 * - claim/complete 走 PostgREST 调 RPC，只有 service_role 能调；
 * - deliver 才是真正碰网络的一步，所以超时、幂等键、错误分类都在这一层定；
 * - 顺序不能倒：先认领（写库提交）再发 HTTP。把两者塞进一个事务，
 *   就会出现「请求已经发出去、事务回滚了」的对不上账。
 *
 * 为什么单列一个纯函数而不是直接写在 scheduled 里：scheduled 一跑就得有真环境，
 * 而这条链的每个分支（成功、非 2xx、超时、回写被拒）都要能本地验。
 */

export interface DispatchCommand {
  id: string;
  commandNo: string;
  commandType: string;
  mappingId: string | null;
  attemptCount: number;
  expectedSyncVersion: number | null;
  payload: unknown;
}

export interface DeliveryResult {
  outcome: 'succeeded' | 'failed';
  httpStatus?: number | null;
  errorCategory?: 'transient' | 'permanent' | 'auth' | 'conflict' | 'unknown' | null;
  errorCode?: string | null;
  responseSummary?: unknown;
}

export interface CompletionResult {
  status: string;
}

export interface DispatchPorts {
  claim(worker: string, limit: number): Promise<DispatchCommand[]>;
  deliver(command: DispatchCommand, signal: AbortSignal): Promise<DeliveryResult>;
  complete(
    command: DispatchCommand,
    result: DeliveryResult,
    worker: string,
  ): Promise<CompletionResult>;
}

export interface DispatchSummary {
  claimed: number;
  succeeded: number;
  failed: number;
  /** 结果没能写回去：租约被回收、持有人不符、没有映射。留着等下一轮，不重试。 */
  skipped: number;
}

export interface DispatchOptions {
  limit?: number;
  timeoutMs?: number;
}

const DEFAULT_LIMIT = 10;
const DEFAULT_TIMEOUT_MS = 15_000;

export async function dispatchOnce(
  worker: string,
  ports: DispatchPorts,
  options: DispatchOptions = {},
): Promise<DispatchSummary> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const commands = await ports.claim(worker, limit);
  const summary: DispatchSummary = {
    claimed: commands.length,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };

  for (const command of commands) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let result: DeliveryResult;
    try {
      result = await ports.deliver(command, controller.signal);
    } catch (error) {
      // 超时与「对面报错」要分开：前者是 transient，值得再试一次；
      // 后者交给 deliver 自己分类，走到这里说明连分类都没来得及做。
      const aborted = controller.signal.aborted;
      result = {
        outcome: 'failed',
        errorCategory: aborted ? 'transient' : 'unknown',
        errorCode: aborted ? 'TENANT_API_TIMEOUT' : 'TENANT_API_ERROR',
        responseSummary: {
          message: error instanceof Error ? error.message : String(error),
        },
      };
    } finally {
      clearTimeout(timer);
    }

    const completion = await ports.complete(command, result, worker);
    if (completion.status !== 'ok') {
      summary.skipped += 1;
      continue;
    }

    if (result.outcome === 'succeeded') {
      summary.succeeded += 1;
    } else {
      summary.failed += 1;
    }
  }

  return summary;
}

/**
 * 把 `dispatchOnce` 接到真实环境上。
 *
 * `TENANT_API_BASE_URL` 没配时**不**静默跳过：让 deliver 直接抛，
 * 命令落 failed/unknown 并留一条可查的记录——比「看起来在跑其实什么都没发」好。
 */
export function createDispatchPorts(
  env: ApiEnvironment['Bindings'],
  options: { fetchImpl?: typeof fetch } = {},
): DispatchPorts {
  const client = createServiceRestClient(env);
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async claim(worker, limit) {
      const response = await client.rest<{ commands?: DispatchCommand[] }>(
        'rpc/claim_tenant_commands',
        {
          method: 'POST',
          profile: 'ops',
          body: {
            p_worker: worker,
            p_limit: limit,
            p_lease: '5 minutes',
          },
        },
      );
      return response?.commands ?? [];
    },

    async deliver(command, signal) {
      const baseUrl = env.TENANT_API_BASE_URL;
      if (!baseUrl) {
        throw new Error('TENANT_API_BASE_URL is not configured');
      }

      const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/${command.commandType}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // 远端按这把键去重：重放同一件事必须得到同一个结果，而不是建第二个租户。
          'idempotency-key': command.commandNo,
        },
        body: JSON.stringify(command.payload ?? {}),
        signal,
      });

      const payload = await safeJson(response);

      if (response.ok) {
        return { outcome: 'succeeded', httpStatus: response.status, responseSummary: payload };
      }

      return {
        outcome: 'failed',
        httpStatus: response.status,
        errorCategory: categorize(response.status),
        errorCode: `TENANT_API_${response.status}`,
        responseSummary: payload,
      };
    },

    async complete(command, result, worker) {
      return client.rest<CompletionResult>('rpc/complete_tenant_command', {
        method: 'POST',
        profile: 'ops',
        body: {
          p_command_id: command.id,
          p_worker: worker,
          p_outcome: result.outcome,
          p_http_status: result.httpStatus ?? null,
          p_error_category: result.errorCategory ?? null,
          p_error_code: result.errorCode ?? null,
          p_response_summary: result.responseSummary ?? null,
        },
      });
    },
  };
}

/** 4xx 里只有 401/403 与 409 值得区别对待，其余 4xx 重试也是同样的结果。 */
function categorize(status: number): DeliveryResult['errorCategory'] {
  if (status === 401 || status === 403) return 'auth';
  if (status === 409) return 'conflict';
  if (status >= 500) return 'transient';
  return 'permanent';
}

/**
 * 定时入口的实体：认领一批、下发、回写。
 *
 * `workerId` 用固定前缀 + 日期而不是随机值：租约冲突时能从 `claimed_by` 看出
 * 是哪个部署环境、哪一天的在跑，随机 ID 在故障复盘里等于没有信息。
 */
export async function runScheduledDispatch(
  env: ApiEnvironment['Bindings'],
  options: DispatchOptions & { workerId?: string; now?: Date } = {},
): Promise<DispatchSummary> {
  const day = (options.now ?? new Date()).toISOString().slice(0, 10);
  const worker = options.workerId ?? `scheduled@${day}`;
  return dispatchOnce(worker, createDispatchPorts(env), options);
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
