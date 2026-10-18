import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { defineConfig } = require('eslint/config')
const js = require('@eslint/js')
const tsPlugin = require('@typescript-eslint/eslint-plugin')
export default defineConfig(
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx,mts,cts}'],
    extends: [js.configs.recommended]
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [tsPlugin.configs['flat/recommended']]
  }
)
