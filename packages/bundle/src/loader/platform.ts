// The platform providers moved to the browser-safe runtime (stage 8): the
// desktopMain runner registers the same providers.
export {
  type BundleStates,
  type CatalogCompositionProvider,
  type CatalogDistributionProvider,
  catalogSnapshot,
  type LogSink,
  providePlatformServices,
  statesOf,
} from '../runtime/platform-providers.js';
