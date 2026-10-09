// The viewer's embedded assets (12-visualizer §3.13 "Build", plan 8a R-V36): the page bundle, its stylesheet
// and the bundled demo log, as text. The `viz-asset:*` modules exist only inside the build
// (tools/build/build.mjs serves them), so this is the only module that imports them and only
// src/entry/viz.ts imports this one (L-VIZ-IMPORT); every other module takes a VizAssets value, so tests run
// them under tsx with injected assets.
// A tsconfig `include` glob drops a .d.ts that sits next to a .ts of the same name, so the ambient
// declaration of the virtual modules is referenced explicitly.
/// <reference path="./assets.d.ts" />
import appJs from 'viz-asset:app.js';
import appCss from 'viz-asset:app.css';
import bundledDemo from 'viz-asset:demo.jsonl';

export interface VizAssets { appJs: string; appCss: string; bundledDemo: string; }

export const VIZ_ASSETS: VizAssets = Object.freeze({ appJs, appCss, bundledDemo });
