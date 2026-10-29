/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/*.gen.jest.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      diagnostics: false,
      tsconfig: { module: 'commonjs', target: 'es2022', esModuleInterop: true, jsx: 'react-jsx', isolatedModules: true },
    }],
  },
};
