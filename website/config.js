/** Public destinations only. Root enables each asset after upload and readback. */
export const siteConfig = Object.freeze({
  version: '0.11.1',
  repositoryUrl: 'https://github.com/youzi-dev/learning-workbench',
  buildsUrl: null,
  documentationUrl: null,
  licenseUrl: null,
  noticesUrl: null,
  releaseUrl: null,
  // The existing /learn/ is a legacy learning experience, not a deployed workbench cloud.
  browserUrl: null,
  downloads: Object.freeze({
    android: null,
    windowsX64: null,
    macArm64: null,
    macX64: null,
  }),
});
