const { defineConfig, globalIgnores } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const globals = require('globals');

module.exports = defineConfig([
  globalIgnores(['.expo/**', 'android/**', 'coverage/**', 'expo-env.d.ts', 'ios/**', 'node_modules/**']),
  expoConfig,
  {
    files: ['app.config.ts', 'eslint.config.js', 'plugins/**/*.cjs'],
    languageOptions: { globals: globals.node }
  }
]);
