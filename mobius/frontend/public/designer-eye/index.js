import { DesignerEyeRuntime } from './runtime.js?v=20261016-admin-only'

if (!window.__MOBIUS_DESIGNER_EYE__) {
  const runtime = new DesignerEyeRuntime()
  window.__MOBIUS_DESIGNER_EYE__ = runtime
  runtime.install()
}
