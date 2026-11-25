import type { Linter } from 'eslint';

import { interopDefault } from '../util';

export async function vue(): Promise<Linter.Config[]> {
  const [pluginVue, parserVue, parserTs] = await Promise.all([
    interopDefault(import('eslint-plugin-vue')),
    interopDefault(import('vue-eslint-parser')),
    interopDefault(import('@typescript-eslint/parser')),
  ] as const);

  const flatEssential = pluginVue.configs?.['flat/essential'] || [];
  const flatStronglyRecommended =
    pluginVue.configs?.['flat/strongly-recommended'] || [];
  const flatRecommended = pluginVue.configs?.['flat/recommended'] || [];

  return [
    ...flatEssential,
    ...flatStronglyRecommended,
    ...flatRecommended,
    {
      files: ['**/*.vue'],
      languageOptions: {
        // globals: {
        //   computed: 'readonly',
        //   defineEmits: 'readonly',
        //   defineExpose: 'readonly',
        //   defineProps: 'readonly',
        //   onMounted: 'readonly',
        //   onUnmounted: 'readonly',
        //   reactive: 'readonly',
        //   ref: 'readonly',
        //   shallowReactive: 'readonly',
        //   shallowRef: 'readonly',
        //   toRef: 'readonly',
        //   toRefs: 'readonly',
        //   watch: 'readonly',
        //   watchEffect: 'readonly',
        // },
        parser: parserVue,
        parserOptions: {
          ecmaFeatures: {
            jsx: true,
          },
          extraFileExtensions: ['.vue'],
          parser: parserTs,
          sourceType: 'module',
        },
      },
      plugins: {
        vue: pluginVue,
      },
      processor: pluginVue.processors?.['.vue'],
      rules: {
        ...pluginVue.configs?.base?.rules,

        'vue/attribute-hyphenation': [
          'error',
          'always',
          {
            ignore: [],
          },
        ],
        'vue/attributes-order': 'off',
        'vue/block-order': [
          'error',
          {
            order: ['script', 'template', 'style'],
          },
        ],
        'vue/component-name-in-template-casing': ['error', 'PascalCase'],
        'vue/component-options-name-casing': ['error', 'PascalCase'],
        'vue/custom-event-name-casing': ['error', 'camelCase'],
        'vue/define-macros-order': [
          'error',
          {
            order: [
              'defineOptions',
              'defineProps',
              'defineEmits',
              'defineSlots',
            ],
          },
        ],
        'vue/dot-location': ['error', 'property'],
        'vue/dot-notation': ['error', { allowKeywords: true }],
        'vue/eqeqeq': ['error', 'smart'],
        // 关闭：与 oxfmt 不可调和，非风格偏好问题。
        // 该规则的判定是「最后一个属性与标签起始同行 → 视为单行 → 要求 `>` 不换行」；
        // 而 oxfmt 只要标签折行就把 `>` 断到下一行。两者对同一段代码给出相反结论，
        // `eslint --fix` 与 `oxfmt` 会无限互相覆盖（已实测 3 个文件 6 处）。
        // 格式的唯一裁决者是 `format:check`（oxfmt），因此这里关闭该重复规则。
        'vue/html-closing-bracket-newline': 'off',
        'vue/html-indent': 'off',
        // 'vue/html-indent': ['error', 2],
        'vue/html-quotes': ['error', 'double'],
        'vue/html-self-closing': [
          'error',
          {
            html: {
              component: 'always',
              normal: 'never',
              void: 'always',
            },
            math: 'always',
            svg: 'always',
          },
        ],
        'vue/max-attributes-per-line': 'off',
        'vue/multi-word-component-names': 'off',
        'vue/multiline-html-element-content-newline': 'error',
        'vue/no-empty-pattern': 'error',
        'vue/no-extra-parens': ['error', 'functions'],
        'vue/no-irregular-whitespace': 'error',
        'vue/no-loss-of-precision': 'error',
        'vue/no-reserved-component-names': 'off',
        'vue/no-restricted-syntax': [
          'error',
          'DebuggerStatement',
          'LabeledStatement',
          'WithStatement',
        ],
        'vue/no-restricted-v-bind': ['error', '/^v-/'],
        'vue/no-sparse-arrays': 'error',
        'vue/no-unused-refs': 'error',
        'vue/no-useless-v-bind': 'error',
        'vue/object-shorthand': [
          'error',
          'always',
          {
            avoidQuotes: true,
            ignoreConstructors: false,
          },
        ],
        'vue/one-component-per-file': 'error',
        'vue/prefer-separate-static-class': 'error',
        'vue/prefer-template': 'error',
        'vue/prop-name-casing': ['error', 'camelCase'],
        'vue/require-default-prop': 'error',
        'vue/require-explicit-emits': 'error',
        'vue/require-prop-types': 'off',
        'vue/singleline-html-element-content-newline': 'off',
        'vue/space-infix-ops': 'error',
        'vue/space-unary-ops': ['error', { nonwords: false, words: true }],
        'vue/v-on-event-hyphenation': [
          'error',
          'always',
          {
            autofix: true,
            ignore: [],
          },
        ],
      },
    },
  ];
}
