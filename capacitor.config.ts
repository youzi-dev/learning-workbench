import type {CapacitorConfig} from '@capacitor/cli';
const config: CapacitorConfig = {
  appId: 'dev.growthworkbench.app',
  appName: '日常工作台',
  webDir: 'dist-android',
  loggingBehavior: 'none',
  server: {androidScheme: 'https'},
  android: {allowMixedContent: false},
};
export default config;
