const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = (env = {}) => {
  const browser = env.browser || 'firefox';

  return {
    entry: {
      'background/worker': './src/background/worker.js',
      'content/content': './src/content/content.js',
      'popup/popup': './src/popup/popup.js'
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].js',
      clean: true
    },
    resolve: {
      extensions: ['.js']
    },
    plugins: [
      new CopyPlugin({
        patterns: [
          {
            from: `manifest.${browser}.json`,
            to: 'manifest.json'
          },
          { from: 'src/popup/popup.html', to: 'popup/popup.html' },
          { from: 'src/popup/popup.css', to: 'popup/popup.css' },
          { from: 'icons', to: 'icons', noErrorOnMissing: true }
        ]
      })
    ],
    devtool: 'cheap-source-map',
    optimization: {
      minimize: false
    }
  };
};
