import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { antdComponents } from './antd-registration';

const srcDir = fileURLToPath(new URL('../', import.meta.url));

function vueFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return vueFiles(path);
    return path.endsWith('.vue') ? [path] : [];
  });
}

/** `AFormItem` → `a-form-item`：antd 的 install 注册名就是模板里要写的标签。 */
function tagOf(componentName: string): string {
  const withoutPrefix = componentName.replace(/^A/, '');
  return `a-${withoutPrefix.replace(/(?<!^)([A-Z])/g, '-$1').toLowerCase()}`;
}

/** 收集全局注册实际生效的标签名（含 install 顺带注册的子组件）。 */
function registeredTags(): Set<string> {
  const tags = new Set<string>();
  for (const component of antdComponents) {
    const fake = {
      component: (name: string) => tags.add(name),
      use: () => undefined,
    };
    (component as { install: (app: unknown) => void }).install(fake);
  }
  return new Set([...tags].map(tagOf));
}

/** 模板里出现的 `<a-xxx>` 标签。 */
function usedTags(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of vueFiles(srcDir)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/<(a-[a-z0-9-]+)[\s/>]/g)) {
      const tag = match[1];
      found.set(tag, [...(found.get(tag) ?? []), file.slice(srcDir.length)]);
    }
  }
  return found;
}

describe('antd 按需注册', () => {
  it('模板里用到的每个 antd 标签都已注册', () => {
    const registered = registeredTags();
    const missing = [...usedTags()]
      .filter(([tag]) => !registered.has(tag))
      .map(([tag, files]) => `${tag}（${files.join(', ')}）`);

    expect(missing, `这些标签没注册，会渲染成空白：${missing.join('; ')}`).toEqual([]);
  });

  it('注册表里没有多余组件', () => {
    const used = [...usedTags().keys()];
    // 父组件常只作为子组件的载体出现（模板只写 `<a-typography-title>`，
    // 不写 `<a-typography>`），所以「有任一子标签被用到」也算用到。
    const isUsed = (tag: string) =>
      used.some((candidate) => candidate === tag || candidate.startsWith(`${tag}-`));
    const unused = [...registeredTags()].filter((tag) => {
      const explicit = antdComponents.some(
        (component) => tagOf((component as { name: string }).name) === tag,
      );
      return explicit && !isUsed(tag);
    });

    expect(unused, `这些组件已注册但没有任何模板使用：${unused.join(', ')}`).toEqual([]);
  });
});
