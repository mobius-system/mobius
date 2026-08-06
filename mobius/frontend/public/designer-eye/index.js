import { DesignerEyeRuntime } from './runtime.js?v=20260805-shift-parent'

if (!window.__MOBIUS_DESIGNER_EYE__) {
  const runtime = new DesignerEyeRuntime()
  window.__MOBIUS_DESIGNER_EYE__ = runtime
  runtime.install()
}
