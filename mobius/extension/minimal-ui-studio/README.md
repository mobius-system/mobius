# Minimal UI Studio

Independent, build-free Mobius extension for a frontend-only layout prototype.

Open `/extension/minimal-ui-studio/`. The default view follows the supplied 2048 × 1090 reference: 282 px navigation, 404 px tools panel, 752 px composer, neutral white/gray surfaces.

- Click the brand or bottom-left help icon, or press Ctrl/Cmd+Shift+E, to adjust the design.
- Drag either column divider (or use its arrow keys) to resize it.
- Enable direct copy editing in the adjustment dialog; click outlined text, then Escape to finish.
- Adjust colors, font size, corner radius, content width, and module visibility. Export the configuration as JSON or restore defaults.
- Cards, local messages, recent conversation search, project selection, attachments, and tool panels demonstrate interactions. No model, shell, browser navigation, microphone, or business API is connected.
- Preferences and demo titles are stored only in the namespaced localStorage key `minimal-ui-studio-v1`. Attachments remain local and are never uploaded.

The backend handler is a registry-required placeholder with no operations. Frontend code does not invoke it. Existing extensions and core UI are not dependencies.
