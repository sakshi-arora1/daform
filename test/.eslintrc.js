module.exports = {
  env: { node: true, es2022: true },
  rules: {
    // Tests import a second copy of a module with a query string.
    'import/no-unresolved': ['error', { ignore: ['\\?'] }],
  },
};
