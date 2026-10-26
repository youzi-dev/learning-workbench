# Third party notices

The original Learning Workbench application code is licensed under the root [MIT license](Learning-Workbench-LICENSE.txt). Each component below keeps its own license. The MIT license does not relicense model weights, third party icons, external tutorial pages or operating system components.

## Locked JavaScript runtime dependencies

These notices cover the production dependency graph in the current lockfile, including dependencies used by the bundled main process and frontend. License texts are copied unchanged from the installed npm distributions. [licenses/npm-license-manifest.json](npm-license-manifest.json) records each version, original npm source and the copied text SHA-256. The Boolbase distribution declares ISC and omits its text; the manifest identifies the upstream revision supplying the full text.

| Component | License | Included text |
| --- | --- | --- |
| `@vscode/codicons@0.0.46-24` | CC-BY-4.0 | [vscode-codicons-0.0.46-24-LICENSE](vscode-codicons-0.0.46-24-LICENSE), [vscode-codicons-0.0.46-24-LICENSE-CODE](vscode-codicons-0.0.46-24-LICENSE-CODE) |
| `diff@9.0.0` | BSD-3-Clause | [diff-9.0.0-LICENSE](diff-9.0.0-LICENSE) |
| `react@19.3.0` | MIT | [react-19.3.0-LICENSE](react-19.3.0-LICENSE) |
| `@jitl/quickjs-wasmfile-release-sync@0.32.0` | MIT | [jitl-quickjs-wasmfile-release-sync-0.32.0-LICENSE](jitl-quickjs-wasmfile-release-sync-0.32.0-LICENSE) |
| `@jitl/quickjs-ffi-types@0.32.0` | MIT | [jitl-quickjs-ffi-types-0.32.0-LICENSE](jitl-quickjs-ffi-types-0.32.0-LICENSE) |
| `quickjs-emscripten-core@0.32.0` | MIT | [quickjs-emscripten-core-0.32.0-LICENSE](quickjs-emscripten-core-0.32.0-LICENSE) |
| `react-dom@19.3.0` | MIT | [react-dom-19.3.0-LICENSE](react-dom-19.3.0-LICENSE) |
| `scheduler@0.28.0` | MIT | [scheduler-0.28.0-LICENSE](scheduler-0.28.0-LICENSE) |
| `monaco-editor@0.56.0` | MIT | [monaco-editor-0.56.0-LICENSE](monaco-editor-0.56.0-LICENSE) |
| `marked@14.0.0` | MIT | [marked-14.0.0-LICENSE.md](marked-14.0.0-LICENSE.md) |
| `dompurify@3.4.8` | (MPL-2.0 OR Apache-2.0) | [dompurify-3.4.8-LICENSE](dompurify-3.4.8-LICENSE), [dompurify-3.4.8-LICENSE-MPL](dompurify-3.4.8-LICENSE-MPL) |
| `@types/trusted-types@2.0.7` | MIT | [types-trusted-types-2.0.7-LICENSE](types-trusted-types-2.0.7-LICENSE) |
| `node-html-parser@9.0.4` | MIT | [node-html-parser-9.0.4-LICENSE](node-html-parser-9.0.4-LICENSE) |
| `entities@8.1.0` | BSD-2-Clause | [entities-8.1.0-LICENSE](entities-8.1.0-LICENSE) |
| `css-select@5.2.2` | BSD-2-Clause | [css-select-5.2.2-LICENSE](css-select-5.2.2-LICENSE) |
| `css-what@6.2.2` | BSD-2-Clause | [css-what-6.2.2-LICENSE](css-what-6.2.2-LICENSE) |
| `domhandler@5.0.3` | BSD-2-Clause | [domhandler-5.0.3-LICENSE](domhandler-5.0.3-LICENSE) |
| `domelementtype@2.3.0` | BSD-2-Clause | [domelementtype-2.3.0-LICENSE](domelementtype-2.3.0-LICENSE) |
| `nth-check@2.1.1` | BSD-2-Clause | [nth-check-2.1.1-LICENSE](nth-check-2.1.1-LICENSE) |
| `domutils@3.2.2` | BSD-2-Clause | [domutils-3.2.2-LICENSE](domutils-3.2.2-LICENSE) |
| `dom-serializer@2.0.0` | MIT | [dom-serializer-2.0.0-LICENSE](dom-serializer-2.0.0-LICENSE) |
| `entities@4.5.0` | BSD-2-Clause | [entities-4.5.0-LICENSE](entities-4.5.0-LICENSE) |
| `boolbase@1.0.0` | ISC | [boolbase-1.0.0-LICENSE](boolbase-1.0.0-LICENSE) |
| `@noble/hashes@2.4.0` | MIT | [noble-hashes-2.4.0-LICENSE](noble-hashes-2.4.0-LICENSE) |
| `pdfjs-dist@6.4.299` | Apache-2.0 | [pdfjs-dist-6.4.299-LICENSE](pdfjs-dist-6.4.299-LICENSE) |
| `@capacitor/core@8.5.3` | MIT | [Capacitor-core-8.5.3-LICENSE.txt](Capacitor-core-8.5.3-LICENSE.txt) |
| `@capacitor/android@8.5.3` | MIT | [Capacitor-android-8.5.3-LICENSE.txt](Capacitor-android-8.5.3-LICENSE.txt) |

PDF.js is by the Mozilla Foundation (2024 attribution retained in its bundled library and worker). Capacitor is by Ionic; its original MIT texts are retained.

QuickJS/WASM license files include the underlying QuickJS copyright and MIT permission. Monaco includes its own notices; DOMPurify offers Apache-2.0 or MPL-2.0 and both texts are retained. Codicons icons use CC-BY-4.0; their code uses MIT. Attribution: Microsoft, [vscode-codicons](https://github.com/microsoft/vscode-codicons). The icons are used in the application interface.

## Electron runtime

Electron is MIT licensed; its text is [licenses/electron-LICENSE.txt](electron-LICENSE.txt). Electron's distributed runtime also contains Chromium and other components. Keep the unmodified Electron distribution's LICENSE.electron.txt and LICENSES.chromium.html in every desktop artifact. Those distribution files contain the runtime-specific complete notices and cannot be replaced with this application license. The CI package check requires both files.

## Offline speech recognition (desktop only)

SenseVoice Small is by FunAudioLLM / FunASR, Alibaba Group. Original model: [FunAudioLLM/SenseVoiceSmall](https://huggingface.co/FunAudioLLM/SenseVoiceSmall). The unchanged INT8 ONNX conversion is distributed by [sherpa-onnx](https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html), model release `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17`. We preserve the model name, source and attribution. Weights follow the [FunASR Model Open Source License Agreement v1.1](SenseVoice-MODEL-LICENSE.txt), including attribution and its other conditions.

The CLI is selected from official [sherpa-onnx v1.13.8 releases](https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.13.8): macOS arm64 static no TTS, macOS x64 static no TTS, or Windows x64 static MT no TTS. Only the offline recognition executable is extracted. [scripts/speech-platforms.mjs](../scripts/speech-platforms.mjs) pins each archive and executable SHA-256; [scripts/prepare-speech.mjs](../scripts/prepare-speech.mjs) pins unchanged model, tokens and official sample SHA-256. Generated target manifests record the original download sources. The official sample is a build validation input and is not packaged as a user recording.

The [v1.13.8 build definitions](https://github.com/k2-fsa/sherpa-onnx/tree/v1.13.8/cmake) and statically linked core identify the following components. Copies include upstream copyright and redistribution notices:

| Component and source | License and included text |
| --- | --- |
| [sherpa-onnx v1.13.8](https://github.com/k2-fsa/sherpa-onnx/tree/v1.13.8) | [Apache-2.0](sherpa-onnx-LICENSE.txt) |
| [ONNX Runtime v1.28.2](https://github.com/microsoft/onnxruntime/tree/v1.28.2) | [MIT](onnxruntime-LICENSE.txt), [upstream complete third party notices](onnxruntime-ThirdPartyNotices.txt) |
| [kaldi-native-fbank v1.22.3](https://github.com/csukuangfj/kaldi-native-fbank/tree/v1.22.3) | [Apache-2.0](kaldi-native-fbank-LICENSE.txt) |
| [kaldi-decoder v0.3.0](https://github.com/k2-fsa/kaldi-decoder/tree/v0.3.0) | [Apache-2.0](kaldi-decoder-LICENSE.txt) |
| [kaldifst v1.8.0](https://github.com/k2-fsa/kaldifst/tree/v1.8.0) | [Apache-2.0 with legal notices](kaldifst-LICENSE.txt) |
| [OpenFst v1.8.5-2026-07-09](https://github.com/csukuangfj/openfst/tree/v1.8.5-2026-07-09) | [upstream copyright and Apache notice](openfst-LICENSE.txt), [authors](openfst-AUTHORS.txt); full Apache-2.0 text is included in sherpa-onnx-LICENSE.txt |
| [simple-sentencepiece v0.7](https://github.com/pkufool/simple-sentencepiece/tree/v0.7) | [Apache-2.0](simple-sentencepiece-LICENSE.txt); its [ThreadPool attribution and zlib terms](ThreadPool-LICENSE.txt) are retained |
| [KISS FFT revision febd4ca](https://github.com/mborgerding/kissfft/tree/febd4caeed32e33ad8b2e0bb5ea77542c40f18ec) | [copyright notice](kissfft-COPYING.txt) and [BSD-3-Clause](kissfft-BSD-3-Clause.txt) |
| [nlohmann/json v3.12.0](https://github.com/nlohmann/json/tree/v3.12.0) | [MIT](nlohmann-json-LICENSE.txt) |
| [Eigen 5.0.1](https://gitlab.com/libeigen/eigen/-/tree/5.0.1) | [MPL-2.0](eigen-COPYING-MPL2.txt); unmodified upstream header source is available at the linked revision |
| [hclust-cpp 2026-02-25](https://github.com/csukuangfj/hclust-cpp/tree/2026-02-25) | [BSD-2-Clause](hclust-cpp-LICENSE.txt) |

This list is based on the pinned upstream build and supplied notices. A changed runtime, feature flag or rebuilt engine needs another dependency/license check. A successful build does not establish legal permission for unrelated cached tutorial content or user materials.

macOS speech synthesis uses the operating system's say program; no TTS voices or weights are redistributed. Windows speech synthesis is currently unavailable and does not bundle a voice engine. System libraries remain supplied by the target OS.

## Android native runtime

See [android-native/NOTICE.md](android-native/NOTICE.md) for exact runtime coordinates, resolution metadata, full Apache-2.0 terms, and Cordova NOTICE. SQLCipher/LibTomCrypt/SQLite native license and source records remain in Android assets.

## External learning sources and private data

Tutorial catalog metadata links to external sources. Cached page bodies, site images and user learning records are not granted an application MIT license and are excluded from source/release publication. Obtain the original rights holder's authorization before redistributing any third party teaching material. Original practice examples in this repository are covered by the application license.
