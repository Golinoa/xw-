/**
 * 发布版本解析核心（纯函数，无 IO）。
 *
 * 设计前提：本仓库是单仓多组件，git tag 在仓库内全局唯一，
 * 所以「组件」这一维度只能编码进 tag 名前缀，不能靠目录或分支区分。
 * 任何偏离（例如直接推 v1.0.0）都无法判断该发布哪个组件，必须报错。
 */

export class ReleaseError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseError";
  }
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const BUMP_KINDS = ["major", "minor", "patch"];

function assertSemver(version, hint) {
  if (typeof version !== "string" || !SEMVER.test(version)) {
    throw new ReleaseError(
      `${hint}：「${version}」不是合法语义化版本（应形如 1.2.3）。`,
    );
  }
}

/**
 * 把 tag 解析成 { component, version, tagPrefix }。
 * 前缀按长度降序匹配，避免 udone-v 抢先吃掉 udone-v2 这类重叠前缀。
 */
export function parseTag(tag, components) {
  const candidate = typeof tag === "string" ? tag.trim() : "";
  if (!candidate) throw new ReleaseError("tag 名称为空，无法解析。");

  const prefixes = Object.entries(components ?? {})
    .filter(
      ([, config]) => typeof config?.tagPrefix === "string" && config.tagPrefix,
    )
    .map(([name, config]) => ({ name, prefix: config.tagPrefix }))
    .sort((left, right) => right.prefix.length - left.prefix.length);

  if (prefixes.length === 0) {
    throw new ReleaseError(
      ".release/manifest.json 里没有任何 tagPrefix，无法解析 tag。",
    );
  }

  const matched = prefixes.find(({ prefix }) => candidate.startsWith(prefix));
  if (!matched) {
    const available = prefixes.map(({ prefix }) => `${prefix}*`).join(" / ");
    // 裸 v1.0.0 是最容易犯的错，单独给一句解释，省得看的人以为是拼写问题。
    if (/^v\d/.test(candidate)) {
      throw new ReleaseError(
        `tag「${candidate}」缺少组件前缀。单仓内 git tag 全局唯一，` +
          `纯 v 版本号无法区分是前端还是运营后台。请改用：${available}`,
      );
    }
    throw new ReleaseError(
      `未知的组件前缀：「${candidate}」。当前可用前缀：${available}`,
    );
  }

  const version = candidate.slice(matched.prefix.length);
  assertSemver(version, `tag「${candidate}」的版本号不合法`);

  return { component: matched.name, version, tagPrefix: matched.prefix };
}

/**
 * 校验 tag 版本与清单版本一致。
 * 不一致直接拒绝发布：否则构建出的产物版本与 tag 漂移，事后无法回溯。
 */
export function assertVersionMatch(tag, manifest) {
  const parsed = parseTag(tag, manifest?.components);
  const target = manifest.components[parsed.component];

  if (target.version !== parsed.version) {
    throw new ReleaseError(
      `tag ${tag} 的版本 ${parsed.version} 与清单版本是 ${target.version} 不一致。` +
        `\n先提升清单版本，再打 tag：` +
        `\n  node scripts/release/bump.mjs ${parsed.component} <patch|minor|major>` +
        `\n  git add .release/manifest.json && git commit -m "chore(release): ${parsed.component} ${parsed.version}"` +
        `\n  git tag ${tag}` +
        `\n  git push origin HEAD:main && git push origin ${tag}`,
    );
  }

  return {
    component: parsed.component,
    displayName: target.displayName ?? parsed.component,
    version: parsed.version,
    path: target.path,
  };
}

export function bumpVersion(version, kind) {
  if (!BUMP_KINDS.includes(kind)) {
    throw new ReleaseError(
      `未知的递增类型「${kind}」，只支持 ${BUMP_KINDS.join(" / ")}。`,
    );
  }
  assertSemver(version, "起始版本不合法");

  const [, major, minor, patch] = SEMVER.exec(version);
  const next = {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
  };

  // 预发布版本不参与递增，直接落到正式版，避免 1.2.3-rc.1 递增成 1.2.3-rc.2
  // 造成 tag 排序与实际发布时间倒挂。
  if (kind === "major") return `${next.major + 1}.0.0`;
  if (kind === "minor") return `${next.major}.${next.minor + 1}.0`;
  return `${next.major}.${next.minor}.${next.patch + 1}`;
}

export function formatTag(tagPrefix, version) {
  if (typeof tagPrefix !== "string" || !tagPrefix) {
    throw new ReleaseError("tagPrefix 为空，无法生成 tag。");
  }
  assertSemver(version, "生成 tag 时版本号不合法");
  return `${tagPrefix}${version}`;
}
