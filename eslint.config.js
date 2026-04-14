import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist', 'node_modules'] },
    {
        extends: [js.configs.recommended, ...tseslint.configs.recommended],
        files: ['**/*.{ts,tsx,js}'],
        languageOptions: {
            ecmaVersion: 2022,
            globals: { ...globals.node, ...globals.browser },
        },
        rules: {
            '@typescript-eslint/no-unused-vars': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-require-imports': 'off',
            '@typescript-eslint/ban-ts-comment': 'off',
            'no-empty': 'off',
            'no-useless-escape': 'off',
            'no-control-regex': 'off',
            'no-constant-condition': 'off',
            'prefer-const': 'off',
        },
    },
);
