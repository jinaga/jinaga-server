var path = require('path');
var nodeExternals = require('webpack-node-externals');

module.exports = [
    {
        mode: 'production',
        target: 'node',
        entry: './src/index.ts',
        devtool: 'source-map',
        module: {
            rules: [{
                test: /\.ts$/,
                use: 'ts-loader'
            }]
        },
        resolve: {
            extensions: [ '.ts' ]
        },
        output: {
            libraryTarget: 'commonjs',
            path: path.resolve(__dirname, './dist'),
            filename: 'index.js'
        },
        externals: [
            nodeExternals()
        ]
    }
]