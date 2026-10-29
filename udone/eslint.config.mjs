import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import vue from 'eslint-plugin-vue';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/test-results/**',
      '.wrangler/**',
      '**/.wrangler/**',
      '.worktrees/**',
      '**/.worktrees/**',
      'supabase/.temp/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.{js,cjs,mjs,ts,tsx,vue}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
  },
  {
    // 契约只能从包入口导入；禁止绕过 exports 直接摸源码文件。
    files: ['apps/**/*.{ts,vue}', 'packages/**/*.ts', 'tests/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/packages/contracts/src', '**/packages/contracts/src/*'],
              message: "从 '@erp/contracts' 导入，禁止深路径引用契约源码。",
            },
          ],
        },
      ],
    },
  },
  {
    // 路由与领域模块一律用 respond() 返回，禁止裸 json，否则出站契约校验会被绕过。
    files: ['apps/api/src/routes/**/*.ts', 'apps/api/src/modules/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name=/^(c|context)$/][callee.property.name='json']",
          message: '请使用 lib/contract 的 respond() 返回，禁止直接 context.json()。',
        },
      ],
    },
  },
  prettier,
);
