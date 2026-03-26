import fs from 'node:fs';
import path from 'node:path';

import * as babel from '@babel/core';
import {defineConfig} from 'vite';
import symfonyPlugin from "vite-plugin-symfony";
// @todo flow plugin only required for "vite:dev", but not yet fully working
import { flowPlugin, esbuildFlowPlugin } from '@bunchtogether/vite-plugin-flow';

const projectRootPath = path.resolve('.');
const babelConfigFile = path.resolve(projectRootPath, 'babel.config.json');

const nodeModulesRegex = /[/\\]node_modules[/\\]/;
const allowedNodeModulesRegex = /[/\\]node_modules[/\\](sulu-(.*)-bundle|@ckeditor|ckeditor5|array-move|lodash-es|vanilla-colorful)[/\\]/;
const fosJsRoutingRegex = /[/\\]friendsofsymfony[/\\]jsrouting-bundle[/\\]/;
const ckeditorIconRegex = /ckeditor5-[^/\\]+[/\\]theme[/\\]icons[/\\][^/\\]+\.svg$/;
const ckeditorThemeIconImportRegex = /theme[/\\]icons[/\\][^/\\]+\.svg$/;
const rawLoaderPrefix = '!!raw-loader!';
const scssProxySuffix = '.vite.module.scss';

// Removes Vite query/hash suffixes so plugin checks can match real filesystem paths.
const cleanId = (id) => id.split('?')[0].split('#')[0];

// Keeps the synthetic Sass module suffix stable even if Vite resolves the same proxy request more than once.
const normalizeScssProxyId = (id) => {
    let normalizedId = cleanId(id);

    while (normalizedId.endsWith(scssProxySuffix)) {
        normalizedId = normalizedId.slice(0, -scssProxySuffix.length);
    }

    return normalizedId;
};

// Recreates webpack's injected Sulu build version constant from composer.lock.
const getSuluVersion = () => {
    const composerLockPath = path.resolve(projectRootPath, 'composer.lock');

    if (!fs.existsSync(composerLockPath)) {
        return '_._._';
    }

    const composerLock = JSON.parse(fs.readFileSync(composerLockPath, 'utf8'));
    const suluPackage = composerLock.packages.find((packageItem) => packageItem.name === 'sulu/sulu');

    return suluPackage ? suluPackage.version : '_._._';
};

// Limits Babel transpilation to the same app files and selected dependencies that webpack handled.
const shouldTransformJs = (id) => {
    if (!id.endsWith('.js')) {
        return false;
    }

    if (fosJsRoutingRegex.test(id)) {
        return false;
    }

    if (!nodeModulesRegex.test(id)) {
        return true;
    }

    return allowedNodeModulesRegex.test(id);
};

// Rewrites webpack-only import patterns into Vite-compatible raw SVG and Sass module requests.
const rewriteCompatibilityImport = (source) => {
    if (source.startsWith(rawLoaderPrefix)) {
        return `${source.slice(rawLoaderPrefix.length)}?raw`;
    }

    // CKEditor expects icon imports to resolve to SVG source strings, not asset URLs.
    if (source.endsWith('.svg') && ckeditorThemeIconImportRegex.test(source)) {
        return `${source}?raw`;
    }

    if (source.endsWith('.scss')) {
        return `${source}${scssProxySuffix}`;
    }

    return source;
};

// Fixes import specifiers during Babel transform so legacy webpack import syntax still resolves in Vite.
const viteCompatibilityImportsBabelPlugin = () => {
    return {
        visitor: {
            CallExpression(path) {
                const firstArgument = path.node.arguments[0];

                if (
                    path.node.callee.type !== 'Import' ||
                    !firstArgument ||
                    firstArgument.type !== 'StringLiteral'
                ) {
                    return;
                }

                firstArgument.value = rewriteCompatibilityImport(firstArgument.value);
            },
            ExportAllDeclaration(path) {
                if (path.node.source) {
                    path.node.source.value = rewriteCompatibilityImport(path.node.source.value);
                }
            },
            ExportNamedDeclaration(path) {
                if (path.node.source) {
                    path.node.source.value = rewriteCompatibilityImport(path.node.source.value);
                }
            },
            ImportDeclaration(path) {
                if (path.node.source.value === 'leaflet/dist/leaflet.css') {
                    path.node.specifiers = [];
                }

                path.node.source.value = rewriteCompatibilityImport(path.node.source.value);
            },
        },
    };
};

// Restores webpack's Babel pipeline for Flow, decorators, class fields, and JSX in .js files.
const babelCompatibilityPlugin = () => {
    return {
        name: 'sulu-babel-compat',
        enforce: 'pre',
        async transform(code, id) {
            const fileId = cleanId(id);

            if (!shouldTransformJs(fileId)) {
                return null;
            }

            const result = await babel.transformAsync(code, {
                babelrc: false,
                caller: {
                    name: 'vite',
                    supportsDynamicImport: true,
                    supportsStaticESM: true,
                },
                configFile: babelConfigFile,
                filename: fileId,
                plugins: [viteCompatibilityImportsBabelPlugin],
                sourceFileName: fileId,
                sourceMaps: true,
            });

            if (!result?.code) {
                return null;
            }

            return {
                code: result.code,
                map: result.map,
            };
        },
    };
};

// Maps raw-loader SVG imports and CKEditor icon SVGs to Vite's ?raw handling.
const rawSvgCompatibilityPlugin = () => {
    return {
        name: 'sulu-raw-svg-compat',
        async resolveId(source, importer, options) {
            if (source.startsWith(rawLoaderPrefix)) {
                const resolved = await this.resolve(source.slice(rawLoaderPrefix.length), importer, {
                    ...options,
                    skipSelf: true,
                });

                return resolved ? `${cleanId(resolved.id)}?raw` : null;
            }

            if (!source.endsWith('.svg')) {
                return null;
            }

            const resolved = await this.resolve(source, importer, {
                ...options,
                skipSelf: true,
            });

            if (!resolved) {
                return null;
            }

            const resolvedId = cleanId(resolved.id);

            if (!ckeditorIconRegex.test(resolvedId)) {
                return null;
            }

            return `${resolvedId}?raw`;
        },
    };
};

// Preserves webpack's legacy behavior where many files import `./foo.scss` as a CSS module object even though Vite
// only treats `*.module.scss` as CSS modules by default. This plugin rewrites those imports to a synthetic module
// request so the existing `import styles from './foo.scss'` pattern keeps working while Sass is compiled normally.
// The custom plugin can be removed once the codebase is migrated to Vite's native convention, e.g. by renaming all
// module-style stylesheets to `*.module.scss` and updating the corresponding JS imports to reference those files.
const scssModulesCompatibilityPlugin = () => {
    return {
        name: 'sulu-scss-modules-compat',
        enforce: 'pre',
        async resolveId(source, importer, options) {
            if (!source.endsWith(scssProxySuffix)) {
                return null;
            }

            const resolved = await this.resolve(normalizeScssProxyId(source), importer, {
                ...options,
                skipSelf: true,
            });

            return resolved ? `${normalizeScssProxyId(resolved.id)}${scssProxySuffix}` : null;
        },
        load(id) {
            if (!id.endsWith(scssProxySuffix)) {
                return null;
            }

            const originalId = normalizeScssProxyId(id);
            return fs.readFileSync(originalId, 'utf8');
        },
    };
};

export default defineConfig({
    optimizeDeps: {
        esbuildOptions: {
          plugins: [esbuildFlowPlugin()]
        }
      },
    plugins: [
        rawSvgCompatibilityPlugin(),
        scssModulesCompatibilityPlugin(),
        babelCompatibilityPlugin(),
        symfonyPlugin()
    ],
    publicDir: false,
    server: {
        cors: {
            origin: 'http://localhost:8000',
        },
    },
    resolve: {
        alias: {
            'fos-jsrouting': path.resolve(
                projectRootPath,
                'vendor/friendsofsymfony/jsrouting-bundle/Resources/public/js'
            ),
        },
        preserveSymlinks: false,
    },
    define: {
        SULU_ADMIN_BUILD_VERSION: JSON.stringify(getSuluVersion()),
    },
    build: {
        // @todo see what's already applied via https://symfony-vite.pentatrion.com/guide/configuration.html
        manifest: true,
        minify: false, // @todo: necessary, but throwing ckeditor-related errors 
        rollupOptions: {
            input: {
                app: path.resolve(projectRootPath, 'index.js'),
            }
        },
    },
    css: {
        modules: {
            generateScopedName: '[local]--[hash:base64:10]',
            localsConvention: 'camelCase',
        },
        postcss: path.resolve(projectRootPath, 'postcss.config.js'),
    },
});
