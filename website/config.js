/** Public destinations only. Root enables each asset after upload and readback. */
export const siteConfig = Object.freeze({
  version: '0.11.1',
  repositoryUrl: 'https://github.com/youzi-dev/learning-workbench',
  buildsUrl: null,
  documentationUrl: null,
  licenseUrl: null,
  noticesUrl: null,
  releaseUrl: 'https://github.com/youzi-dev/learning-workbench/releases/tag/v0.11.1',
  // The existing /learn/ is a legacy learning experience, not a deployed workbench cloud.
  browserUrl: null,
  downloads: Object.freeze({
    android: 'https://github.com/youzi-dev/learning-workbench/releases/download/v0.11.1/learning-workbench-android-private-0.11.1.apk',
    windowsX64: 'https://github.com/youzi-dev/learning-workbench/releases/download/v0.11.1/learning-workbench-win-x64-unsigned-development-0.11.1-setup.exe',
    macArm64: 'https://github.com/youzi-dev/learning-workbench/releases/download/v0.11.1/learning-workbench-mac-arm64-private-0.11.1.zip',
    macX64: 'https://github.com/youzi-dev/learning-workbench/releases/download/v0.11.1/learning-workbench-mac-x64-private-0.11.1.zip',
  }),
});
