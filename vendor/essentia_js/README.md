# Essentia.js 0.1.3 — unmodified upstream distribution

Source: https://github.com/MTG/essentia.js
Package: https://registry.npmjs.org/essentia.js/-/essentia.js-0.1.3.tgz
Essentia algorithm: https://essentia.upf.edu/reference/std_PredominantPitchMelodia.html
License: GNU Affero General Public License v3 or later; see LICENSE.
Included: essentia-wasm.umd.js, essentia.js-core.umd.js, LICENSE.
These upstream files are unmodified. The project's separate melodia_engine.js
uses the official PredominantPitchMelodia API when bias=0, and the same official
salience/contours/melody components with explicit pitch salience weighting for
bias>0. This weighting is an experimental application extension, not an
upstream Melodia parameter. No neural network weights are needed.
