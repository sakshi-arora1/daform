// Copied from ew-extensions (tools/block-editor), which lints with these relaxations.
module.exports = {
  rules: {
    'no-underscore-dangle': 'off',
    indent: 'off',
    'object-curly-newline': 'off',
    'class-methods-use-this': 'off',
    'import/prefer-default-export': 'off',
    // da-lit and https://da.live imports resolve through the page's importmap / at runtime.
    'import/no-unresolved': 'off',
    'no-use-before-define': ['error', { functions: false, classes: true, variables: true }],
    'max-len': ['warn', {
      code: 120, ignoreUrls: true, ignoreStrings: true, ignoreTemplateLiterals: true,
    }],
  },
};
