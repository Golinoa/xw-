import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ReleaseError,
  assertVersionMatch,
  bumpVersion,
  formatTag,
  parseTag,
} from "./lib.mjs";

const manifest = {
  components: {
    udone: {
      displayName: "OMS",
      path: "udone",
      tagPrefix: "udone-v",
      version: "0.1.0",
    },
    admin: {
      displayName: "运营后台",
      path: "admin",
      tagPrefix: "admin-v",
      version: "2.3.4",
    },
  },
};

describe("parseTag", () => {
  it("从组件前缀解析出版本", () => {
    assert.deepEqual(parseTag("udone-v1.2.3", manifest.components), {
      component: "udone",
      version: "1.2.3",
      tagPrefix: "udone-v",
    });
  });

  it("同一仓库内两个组件不会互相误判", () => {
    assert.equal(
      parseTag("admin-v2.3.4", manifest.components).component,
      "admin",
    );
    assert.equal(
      parseTag("udone-v2.3.4", manifest.components).component,
      "udone",
    );
  });

  it("拒绝裸 v1.0.0，因为单仓无法靠它区分组件", () => {
    assert.throws(
      () => parseTag("v1.0.0", manifest.components),
      (error) => {
        assert.ok(error instanceof ReleaseError);
        assert.match(error.message, /缺少组件前缀/);
        assert.match(error.message, /udone-v/);
        assert.match(error.message, /admin-v/);
        return true;
      },
    );
  });

  it("拒绝未知组件前缀", () => {
    assert.throws(() => parseTag("hotel-v1.0.0", manifest.components), {
      name: "ReleaseError",
      message: /未知的组件前缀/,
    });
  });

  it("拒绝非语义化版本", () => {
    assert.throws(() => parseTag("udone-v1.2", manifest.components), {
      name: "ReleaseError",
      message: /版本号不合法/,
    });
    assert.throws(() => parseTag("udone-v1.2.3.4", manifest.components), {
      name: "ReleaseError",
    });
    assert.throws(() => parseTag("udone-vx.y.z", manifest.components), {
      name: "ReleaseError",
    });
  });

  it("允许预发布后缀，但版本主体必须完整", () => {
    assert.equal(
      parseTag("udone-v1.2.3-rc.1", manifest.components).version,
      "1.2.3-rc.1",
    );
  });

  it("前缀重叠时取最长匹配，避免 udone-v 吃掉 udone-v2", () => {
    const overlapping = {
      udone: {
        displayName: "A",
        path: "udone",
        tagPrefix: "udone-v",
        version: "1.0.0",
      },
      udoneV2: {
        displayName: "B",
        path: "udone2",
        tagPrefix: "udone-v2",
        version: "1.0.0",
      },
    };
    // 两种切法都能解析成合法版本：短前缀 udone-v → 21.0.0，长前缀 udone-v2 → 1.0.0。
    // 只有最长优先才会得到后者，否则版本号会被静默放大。
    assert.deepEqual(parseTag("udone-v21.0.0", overlapping), {
      component: "udoneV2",
      version: "1.0.0",
      tagPrefix: "udone-v2",
    });
    assert.equal(parseTag("udone-v1.0.0", overlapping).component, "udone");
  });
});

describe("assertVersionMatch", () => {
  it("tag 与清单一致时返回组件与版本", () => {
    assert.deepEqual(assertVersionMatch("admin-v2.3.4", manifest), {
      component: "admin",
      displayName: "运营后台",
      version: "2.3.4",
      path: "admin",
    });
  });

  it("不一致时拒绝并给出可执行的修复顺序", () => {
    assert.throws(
      () => assertVersionMatch("udone-v1.0.0", manifest),
      (error) => {
        assert.equal(error.name, "ReleaseError");
        assert.match(error.message, /清单版本是 0\.1\.0/);
        assert.match(error.message, /bump\.mjs udone/);
        return true;
      },
    );
  });
});

describe("bumpVersion", () => {
  it("按 patch / minor / major 递增", () => {
    assert.equal(bumpVersion("0.1.0", "patch"), "0.1.1");
    assert.equal(bumpVersion("0.1.0", "minor"), "0.2.0");
    assert.equal(bumpVersion("0.1.0", "major"), "1.0.0");
    assert.equal(bumpVersion("1.9.9", "minor"), "1.10.0");
  });

  it("递增时丢弃预发布后缀，避免 tag 排序倒挂", () => {
    assert.equal(bumpVersion("1.2.3-rc.1", "patch"), "1.2.4");
  });

  it("拒绝未知的递增类型", () => {
    assert.throws(() => bumpVersion("0.1.0", "huge"), { name: "ReleaseError" });
  });

  it("拒绝非法起始版本", () => {
    assert.throws(() => bumpVersion("1.0", "patch"), { name: "ReleaseError" });
  });
});

describe("formatTag", () => {
  it("拼出与 parseTag 互逆的 tag", () => {
    const tag = formatTag("udone-v", "1.2.3");
    assert.equal(tag, "udone-v1.2.3");
    assert.equal(parseTag(tag, manifest.components).version, "1.2.3");
  });
});
